// The Desk agent loop. Runtime-neutral (Deno Edge Function and Node tests share it).
// A small model picks tools; a larger model only writes drafts. Every state change is a tool call into the engine.
import { TOOL_DEFS, makeExecutors } from "./tools.js";

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

/**
 * runTurn — one user message through the agent.
 * deps: { llm(model, body) -> Anthropic-style response, rpc(name, args), logUsage(row), models: {route, draft}, monthTokens(), tokenCap }
 */
export async function runTurn({ text, history = [], deps }) {
  const { llm, rpc, logUsage, models, tokenCap } = deps;
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
    const res = await llm(models.route, { max_tokens: 700, system: SYSTEM_PROMPT, tools: TOOL_DEFS, messages });
    const calls = res.content.filter(b => b.type === "tool_use");
    await logUsage({ model: models.route, purpose: "route", tools: calls.map(c => c.name), usage: res.usage });
    const assistant = { role: "assistant", content: res.content };
    messages.push(assistant); newMessages.push(assistant);
    if (res.stop_reason !== "tool_use" || !calls.length) {
      return { reply: res.content.filter(b => b.type === "text").map(b => b.text).join("\n").trim(), cards, newMessages };
    }
    const results = [];
    for (const c of calls) {
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
export async function handleAction({ action, params = {}, rpc }) {
  if (action === "approve") {
    const r = await rpc("desk_approve", { p_subject_type: params.subject_type, p_subject_id: params.subject_id });
    return { reply: r.approved ? `Approved by ${r.by}. ${r.approved > 1 ? r.approved + " items are" : "It's"} on the way.` : r.note, cards: [] };
  }
  if (action === "discard") { await rpc("desk_discard", { p_subject_type: params.subject_type, p_subject_id: params.subject_id }); return { reply: "Draft discarded. Nothing was sent.", cards: [] }; }
  if (action === "undo") { const r = await rpc("desk_undo", { p_event: params.event }); return { reply: `Undone. Back to ${r.stage}.`, cards: [] }; }
  if (action === "load_sample_data") { await rpc("desk_load_sample_data"); return { reply: "Sample data loaded: 3 roles, 26 candidates, a joiner and a probation review.", cards: [] }; }
  throw new Error("Unknown action");
}

export function friendly(e) {
  const m = String(e?.message || e || "");
  return m.replace(/^.*?ERROR:\s*/, "").slice(0, 300) || "Something went wrong";
}
