// The Desk agent loop. Runtime-neutral (Deno Edge Function and Node tests share it).
// A small model picks tools; a larger model only writes drafts. Every state change is a tool call into the engine.
import { TOOL_DEFS, toolDefs, toolModule, makeExecutors, makeActors, CONFIRM_TOOLS } from "./tools.js";
import { isQuestion, MODULES } from "./modules.js";

export const SYSTEM_PROMPT = `You are Desk, the HR teammate inside Clearstage, for Indian companies with 20–200 people.
The user is the founder or the one HR person. They may write in English or Hinglish; reply in the same style, short and plain.
Rules you never break:
- You only act through tools. Never claim something was sent, approved or saved unless a tool result says so.
- Anything that reaches a candidate or employee is a draft until a person taps Approve in the app or on WhatsApp. You cannot approve.
- Never calculate salary, wages percentages, notice periods or other money/law figures yourself. Use calculate_ctc.
- If a name could mean more than one person (find_people returns several), ask which one. Don't guess.
- Rejections use one job-relevant reason. Never mention age, gender, marital status, religion, caste or pregnancy.
- If you can't do something with your tools, say so in one sentence and suggest what you can do.
- The app shows cards from tool results, so don't repeat their contents. Reply in 1–3 sentences.`;

const MAX_STEPS = 6;
const ROLE_LABELS = { super_admin: "Super admin", hr: "HR", recruiter: "Recruiter", manager: "Manager" };
/** The words Desk uses for a module outside the user's role (founder's register FA-010 line 4: unchanged). */
export const outsideRoleReply = (module, roles = []) =>
  `${MODULES[module]?.name ?? module} isn't part of your access as ${roles.map(r => ROLE_LABELS[r] || r).join(" + ") || "your role"}. Ask HR or your Super admin if you need it.`;
/** The system prompt for this company's channels (QA-041: no WhatsApp promises while it's off) and this kind of message. */
export function systemPrompt({ channels = ["app", "email"], question = false } = {}) {
  let p = SYSTEM_PROMPT;
  if (!channels.includes("whatsapp")) p = p.replace(" in the app or on WhatsApp", " in the app") +
    "\n- WhatsApp isn't switched on for this company. Never mention WhatsApp or promise a WhatsApp message.";
  p += "\n- Anything that changes something or sends something comes back as a card the user approves. Never say it's done; say it's ready for their approval.";
  if (question) p += "\n- The user asked a question. Answer it with what you can look up. Don't start, change or send anything.";
  return p;
}
const allowedModule = (access, m) => !access || m === "today" || (access.modules || []).includes(m);

/**
 * runTurn — one user message through the agent.
 * deps: { llm(model, body) -> Anthropic-style response, rpc(name, args), logUsage(row), models: {route, draft}, monthTokens(), tokenCap }
 */
export async function runTurn({ text, history = [], deps }) {
  const { llm, rpc, logUsage, models, tokenCap } = deps;
  const access = deps.access || null, channels = deps.channels || ["app", "email"];
  const question = isQuestion(text);
  const tools = toolDefs({ modules: access?.modules ?? null, question, channels });
  const system = systemPrompt({ channels, question });
  if (tokenCap && (await deps.monthTokens()) >= tokenCap) {
    return { reply: "Your workspace has used this month's AI allowance. Desk will be back on the 1st, or ask your admin to raise the limit.", cards: [], blocked: "cost_cap" };
  }
  const draft = async (kind, details) => {
    const res = await llm(models.draft, { max_tokens: 900, system: "You write short, clear HR letters for Indian companies. Plain English. Use only the facts given; leave [placeholders] for anything missing. No legal advice. Output only the letter text.",
      messages: [{ role: "user", content: `Write a ${kind.replace(/_/g, " ")}. Facts: ${details}` }] });
    await logUsage({ model: models.draft, purpose: "draft", tools: ["draft_document"], usage: res.usage });
    return res.content.filter(b => b.type === "text").map(b => b.text).join("\n").trim();
  };
  const exec = makeExecutors({ rpc, draft });
  const messages = [...history, { role: "user", content: [{ type: "text", text }] }];
  const cards = [], newMessages = [messages[messages.length - 1]];

  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await llm(models.route, { max_tokens: 700, system, tools, messages });
    const calls = res.content.filter(b => b.type === "tool_use");
    await logUsage({ model: models.route, purpose: "route", tools: calls.map(c => c.name), usage: res.usage });
    const assistant = { role: "assistant", content: res.content };
    messages.push(assistant); newMessages.push(assistant);
    if (res.stop_reason !== "tool_use" || !calls.length) {
      return { reply: res.content.filter(b => b.type === "text").map(b => b.text).join("\n").trim(), cards, newMessages };
    }
    const results = [];
    for (const c of calls) {
      // QA-044: the role check runs before the tool, by module. Outside the role, Desk says so and stops: nothing is read.
      const mod = toolModule(c.name, c.input || {});
      if (mod && !allowedModule(access, mod)) return { reply: outsideRoleReply(mod, access?.roles), cards, newMessages, blocked: `role_${mod}` };
      // QA-045: a question never runs a tool that changes something, whatever the model picks.
      if (question && !tools.some(t => t.name === c.name)) return { reply: "That's a question, so I haven't changed anything. Ask me to do it if you'd like me to.", cards, newMessages, blocked: "question" };
      let out;
      try {
        if (!exec[c.name]) throw new Error(`Unknown tool ${c.name}`);
        out = await exec[c.name](c.input || {});
        cards.push(...out.cards);
        results.push({ type: "tool_result", tool_use_id: c.id, content: JSON.stringify(out.result).slice(0, 6000) });
      } catch (e) {
        results.push({ type: "tool_result", tool_use_id: c.id, is_error: true, content: friendly(e) });
      }
    }
    const user = { role: "user", content: results };
    messages.push(user); newMessages.push(user);
  }
  return { reply: "That took more steps than I'm allowed in one go. Could you break it into smaller requests?", cards, newMessages };
}

/** Human taps (Approve, Reject, Undo, Load sample data). Never reachable by the model. */
export async function handleAction({ action, params = {}, rpc, access = null }) {
  // QA-045: a proposed action runs only when a person taps Approve on its card, after the same role check.
  if (action === "run") {
    const tool = params.tool, input = params.input || {};
    if (!CONFIRM_TOOLS.includes(tool)) throw new Error("That action can't be run from a card");
    const mod = toolModule(tool, input);
    if (!allowedModule(access, mod)) return { reply: outsideRoleReply(mod, access?.roles), cards: [] };
    const out = await makeActors({ rpc })[tool](input);
    return { reply: out.reply, cards: out.cards || [] };
  }
  if (action === "cancel") return { reply: "Cancelled. Nothing was changed or sent.", cards: [] };
  if (action === "approve") {
    const r = await rpc("desk_approve", { p_subject_type: params.subject_type, p_subject_id: params.subject_id });
    return { reply: r.approved ? `Approved by ${r.by}. ${r.approved > 1 ? r.approved + " items are" : "It's"} on the way.` : r.note, cards: [],
      approved_by: r.approved ? r.by : null, approved_at: r.approved_at ?? null };
  }
  // QA-040: Reject discards the draft through the discard path, with a reason from the fixed list (logged).
  if (action === "discard") {
    if (!DRAFT_REJECT_REASONS[params.reason]) return { reply: "Pick a reason for sending it back.", cards: [], needs_reason: true };
    await rpc("desk_discard", { p_subject_type: params.subject_type, p_subject_id: params.subject_id, p_reason: params.reason });
    return { reply: `Sent back with the reason "${DRAFT_REJECT_REASONS[params.reason]}" and logged. Nothing was sent.`, cards: [] };
  }
  if (action === "undo") { const r = await rpc("desk_undo", { p_event: params.event }); return { reply: `Undone. Back to ${r.stage}.`, cards: [] }; }
  // Screening: a person's taps, never model tools (the AI never writes a score or a star).
  if (action === "confirm_requirements") { const r = await rpc("desk_confirm_requirements", { p_requirement: params.requirement_id }); return { reply: `Requirements v${r.version} confirmed by ${r.confirmed_by}. Screening can start.`, cards: [], approved_by: r.confirmed_by, approved_at: r.confirmed_at }; }
  if (action === "override_stars") { const r = await rpc("desk_override_stars", { p_application: params.application_id, p_stars: params.stars, p_reason: params.reason }); return { reply: `Stars changed from ${r.from} to ${r.to}. Both are kept in the log.`, cards: [] }; }
  if (action === "pin") { const r = await rpc("desk_pin", { p_role: params.role_id, p_application: params.application_id, p_pin: params.pin !== false }); return { reply: r.pinned ? "Pinned to the top 10." : "Unpinned.", cards: [] }; }
  if (action === "mark_contacted") { await rpc("desk_mark_contacted", { p_application: params.application_id, p_status: params.status || "contacted" }); return { reply: "Marked as contacted. The next best person moves into the top 10.", cards: [] }; }
  if (action === "approve_reject_batch_preview") return { reply: "Approved. This is a preview: nothing was sent and no message was queued.", cards: [] };
  if (action === "load_sample_data") return { reply: "Sample data lives only in the sample company now. Ask Clearstage for demo access.", cards: [] };
  throw new Error("Unknown action");
}

/** The fixed list for sending a draft back (same labels as the app's Send back chips). */
export const DRAFT_REJECT_REASONS = { wrong_details: "Wrong details (date, amount or name)", wrong_tone: "Wrong tone or wording",
  not_needed: "Not needed any more", needs_check: "Needs a policy or legal check", duplicate: "Duplicate of another draft" };

/** QA-040: no raw database text ever reaches the screen. Our own refusals are plain sentences and pass through;
 *  anything from the database's internals becomes a plain message. */
export function friendly(e) {
  const m = String(e?.message || e || "").replace(/^.*?ERROR:\s*/, "").trim();
  if (!m) return "Something went wrong. Nothing was changed.";
  if (/row-level security|permission denied|insufficient privilege/i.test(m)) return "You don't have access to that. Nothing was changed.";
  if (/violates (check|foreign key|not-null|unique) constraint|duplicate key|new row for relation|invalid input syntax|syntax error|relation .* does not exist|function .* does not exist|null value in column|value too long|out of range|deadlock|could not serialize/i.test(m))
    return "That couldn't be saved. Nothing was changed. Try again, or ask your Super admin if it keeps happening.";
  return m.slice(0, 300);
}
