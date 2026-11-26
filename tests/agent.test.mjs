import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runTurn, handleAction } from "../supabase/functions/_shared/agent.js";
import { TOOL_DEFS, blockedText, TOOL_MODULE, CONFIRM_TOOLS, READ_ONLY_TOOLS, toolDefs } from "../supabase/functions/_shared/tools.js";
import { systemPrompt } from "../supabase/functions/_shared/agent.js";
import { isQuestion } from "../lib/modules.js";
import { ctcBreakup, fixBasic } from "../lib/ctc.js";

// A scripted model: returns the queued responses in order and records what it was asked.
function scriptedLLM(responses) {
  const calls = [];
  const llm = async (model, body) => { calls.push({ model, body }); const r = responses.shift(); if (!r) throw new Error("no more scripted responses"); return r; };
  return { llm, calls };
}
const toolUse = (name, input, id = "t" + Math.random().toString(36).slice(2, 7)) => ({ stop_reason: "tool_use", usage: { input_tokens: 500, output_tokens: 50 }, content: [{ type: "tool_use", id, name, input }] });
const say = text => ({ stop_reason: "end_turn", usage: { input_tokens: 600, output_tokens: 40 }, content: [{ type: "text", text }] });

function fakeEngine(overrides = {}) {
  const calls = [];
  const data = {
    desk_get_brief: { open: 3, late: 2, items: [{ task_id: "task-1", title: "Arjun Mehta hasn't given feedback", why: "26h overdue", bucket: "Late", owner: "Arjun Mehta" }] },
    desk_find_people: [{ kind: "member", id: "m1", name: "Arjun Mehta", detail: "Engineering Manager" }, { kind: "person", id: "p1", name: "Arjun Rao", detail: "Customer Success Associate · Screened" }],
    desk_create_role: { role_id: "role-9", approval: { task_id: "x", approver: "Sanddeep", self: true } },
    // like migration 005/006: the database ignores the client's flag and returns its own check
    desk_save_offer: args => {   // mirrors migration 008: inputs in, every line and the check out
      if (Object.keys(args.p_inputs).some(k => !["ctc", "basic_monthly", "hra_pct", "pf_rule", "variable", "joining_on"].includes(k))) throw new Error("Offer inputs can't include amounts");
      const i = args.p_inputs, inp = { ctc: i.ctc, basicMonthly: i.basic_monthly ?? Math.floor(i.ctc * 0.4 / 12 / 1000) * 1000, hraPct: i.hra_pct ?? 40, pfRule: i.pf_rule ?? "ceiling", variable: i.variable ?? 0, on: "2026-12-01" };
      const r = args.p_fix ? fixBasic(inp) : ctcBreakup(inp), c = r.check;
      return { offer_id: "offer-1", ctc: c.ctc, components: r.components, monthly: { take_home: r.monthly.takeHome }, warnings: r.warnings, inputs: { basic_monthly: r.inputs.basicMonthly },
        check: { passes: c.passes, wages_percent: c.wagesPercent, ctc: c.ctc, deemed_extra_wages: c.deemedExtraWages, computed_by: "database" } }; },
    desk_request_approval: { task_id: "y", approver: "Sanddeep", self: true },
    desk_chase_owner: { chased: "Arjun Mehta", escalates_to: "Vikram" },
    desk_month_tokens: 0,
    desk_approve: { approved: 1, by: "Sanddeep" },
    ...overrides,
  };
  const rpc = async (name, args = {}) => { calls.push({ name, args }); if (data[name] instanceof Error) throw data[name]; if (!(name in data)) throw new Error("unexpected rpc " + name); return typeof data[name] === "function" ? data[name](args) : data[name]; };
  return { rpc, calls };
}
const deps = (llm, rpc, extra = {}) => ({ llm, rpc, models: { route: "small-model", draft: "large-model" }, tokenCap: 1000000, monthTokens: () => rpc("desk_month_tokens"), logUsage: async () => {}, ...extra });

test("the model can't approve or discard: those tools don't exist for it", () => {
  const names = TOOL_DEFS.map(t => t.name);
  for (const forbidden of ["approve", "desk_approve", "discard", "send_message", "load_sample_data"]) assert.ok(!names.includes(forbidden), forbidden);
  for (const required of ["get_brief", "create_role", "chase_owner", "record_feedback", "calculate_ctc", "send_offer", "mark_offer_accepted", "start_probation_review", "bulk_reject", "show_pipeline", "show_joiners", "draft_document", "add_candidate", "move_candidate"]) assert.ok(names.includes(required), required);
});

test("morning brief: tool result becomes a brief card; reply comes from the small model", async () => {
  const { llm, calls } = scriptedLLM([toolUse("get_brief", {}), say("2 things are late. Start with Arjun's feedback.")]);
  const eng = fakeEngine();
  const out = await runTurn({ text: "Aaj kya hai?", deps: deps(llm, eng.rpc) });
  assert.equal(out.cards[0].type, "brief");
  assert.equal(out.cards[0].items[0].pill, "late");
  assert.match(out.reply, /late/);
  assert.ok(calls.every(c => c.model === "small-model"));
});

test("COO example: Hinglish role request creates a draft role waiting for approval, budget converted from lakh", async () => {
  const { llm } = scriptedLLM([toolUse("create_role", { title: "Data Analyst", city: "Bengaluru", openings: 1, budget_min_lakh: 8, budget_max_lakh: 10 }), say("Drafted. Approve it to open the role.")]);
  const eng = fakeEngine();
  const out = await runTurn({ text: "Ek data analyst chahiye Bangalore mein, 8-10L", deps: deps(llm, eng.rpc) });
  const call = eng.calls.find(c => c.name === "desk_create_role");
  assert.equal(call.args.p_budget_min, 800000); assert.equal(call.args.p_budget_max, 1000000); assert.equal(call.args.p_openings, 1);
  const card = out.cards[0];
  assert.equal(card.type, "approval"); assert.equal(card.subject_type, "role");
  assert.deepEqual(card.actions.map(a => a.action), ["approve", "discard"]);
  assert.ok(!eng.calls.some(c => c.name === "desk_approve"), "nothing approved by the agent");
});

test("ask, don't guess: two Arjuns produce a choice card", async () => {
  const { llm } = scriptedLLM([toolUse("find_people", { name: "Arjun" }), say("Arjun Mehta or Arjun Rao?")]);
  const out = await runTurn({ text: "Chase Arjun", deps: deps(llm, fakeEngine().rpc) });
  assert.equal(out.cards[0].type, "choice");
  assert.equal(out.cards[0].options.length, 2);
});

test("CTC is computed by the database from inputs only: Kiran's ₹12 L fails at 35.6%, Fix passes at 51.2%", async () => {
  const { llm } = scriptedLLM([toolUse("calculate_ctc", { application_id: "a1", ctc: 1200000, basic_monthly: 35000 }), say("It fails the 50% rule. Want me to fix it?"),
                               toolUse("calculate_ctc", { application_id: "a1", ctc: 1200000, basic_monthly: 35000, fix: true }), say("Fixed.")]);
  const eng = fakeEngine();
  const first = await runTurn({ text: "Build Kiran's offer", deps: deps(llm, eng.rpc) });
  assert.equal(first.cards[0].passes, false); assert.equal(first.cards[0].wages_percent, 35.6);
  assert.equal(first.cards[0].components.find(c => c.name === "Employer PF").amount, 36000);
  const second = await runTurn({ text: "Fix it", deps: deps(llm, eng.rpc) });
  assert.equal(second.cards[0].passes, true); assert.equal(second.cards[0].ctc, 1200000); assert.equal(second.cards[0].wages_percent, 51.2);
  assert.equal(second.cards[0].take_home_monthly, 91396);
  const saved = eng.calls.filter(c => c.name === "desk_save_offer");
  assert.equal(saved[1].args.p_fix, true);
  assert.ok(saved.every(c => !("p_components" in c.args) && !("p_check" in c.args)), "the model sends no amounts and no verdict");
  assert.equal(second.cards[0].computed_by, "database");
  assert.match(second.cards[0].pf_citation, /S\.O\. 5109\(E\)/);
});

test("amounts the model slips in are dropped before reaching the database", async () => {
  const { llm } = scriptedLLM([toolUse("calculate_ctc", { application_id: "a1", ctc: 1200000, components: [{ name: "Basic", kind: "basic", amount: 1200000 }], basic: 100000 }), say("Saved.")]);
  const eng = fakeEngine();
  await runTurn({ text: "offer", deps: deps(llm, eng.rpc) });
  const call = eng.calls.find(c => c.name === "desk_save_offer");
  assert.deepEqual(Object.keys(call.args.p_inputs), ["ctc"]);
});

test("the calculate_ctc schema has no amount fields", () => {
  const t = TOOL_DEFS.find(x => x.name === "calculate_ctc");
  assert.equal(t.input_schema.additionalProperties, false);
  assert.ok(!("components" in t.input_schema.properties));
  assert.deepEqual(t.input_schema.required, ["application_id", "ctc"]);
});

test("bulk reject: protected trait in the note is refused before reaching the engine", async () => {
  const { llm } = scriptedLLM([toolUse("bulk_reject", { role_id: "r2", person_ids: ["p1"], reason: "assessment_below_bar", note: "Hi {name}, we can't hire you as you are pregnant" }), say("I can't send that.")]);
  const eng = fakeEngine({ desk_bulk_reject: new Error("should not be called") });
  const out = await runTurn({ text: "reject Megha", deps: deps(llm, eng.rpc) });
  assert.equal(out.cards.length, 0);
  assert.ok(!eng.calls.some(c => c.name === "desk_bulk_reject"));
  assert.ok(blockedText("she is married"));
  assert.ok(!blockedText("Your Excel score was below the 60% we need"));
});

test("engine errors go back to the model as tool errors, not crashes", async () => {
  const { llm, calls } = scriptedLLM([toolUse("show_pipeline", { role: "Ghost" }), say("That role is already closed.")]);
  const eng = fakeEngine({ desk_show_pipeline: new Error("ERROR:  That role is not open") });
  const out = await runTurn({ text: "pipeline for Ghost", deps: deps(llm, eng.rpc) });
  const toolResult = calls[1].body.messages[2].content[0];
  assert.equal(toolResult.is_error, true); assert.equal(toolResult.content, "That role is not open");
  assert.match(out.reply, /closed/);
});

test("monthly AI cap stops the agent before any model call", async () => {
  const { llm, calls } = scriptedLLM([]);
  const out = await runTurn({ text: "hi", deps: deps(llm, fakeEngine({ desk_month_tokens: 5_000_000 }).rpc) });
  assert.equal(out.blocked, "cost_cap"); assert.equal(calls.length, 0);
});

test("token usage is logged per model call with the tools it chose", async () => {
  const logged = [];
  const { llm } = scriptedLLM([toolUse("get_brief", {}), say("Done.")]);
  await runTurn({ text: "brief", deps: deps(llm, fakeEngine().rpc, { logUsage: async r => logged.push(r) }) });
  assert.deepEqual(logged.map(l => [l.purpose, l.tools]), [["route", ["get_brief"]], ["route", []]]);
  assert.equal(logged[0].usage.input_tokens, 500);
});

test("drafting uses the larger model and only creates a draft awaiting approval", async () => {
  const { llm, calls } = scriptedLLM([toolUse("draft_document", { person_id: "p5", kind: "appointment_letter", details: "Sneha Rao, Product Designer, joins 16 Nov, ₹9.6 L" }),
    { stop_reason: "end_turn", usage: { input_tokens: 300, output_tokens: 400 }, content: [{ type: "text", text: "Dear Sneha, ..." }] }, say("Here's the draft.")]);
  const eng = fakeEngine({ desk_save_document: { document_id: "d1", version: 1 } });
  const out = await runTurn({ text: "Draft Sneha's letter", deps: deps(llm, eng.rpc) });
  assert.equal(calls[1].model, "large-model");
  assert.equal(out.cards[0].type, "approval"); assert.equal(out.cards[0].subject_type, "document");
  assert.ok(!eng.calls.some(c => c.name === "desk_approve"));
});

test("approve only happens through a person's action", async () => {
  const eng = fakeEngine();
  const r = await handleAction({ action: "approve", params: { subject_type: "role", subject_id: "role-9" }, rpc: eng.rpc });
  assert.match(r.reply, /Approved by Sanddeep/);
  await assert.rejects(handleAction({ action: "delete_everything", rpc: eng.rpc }));
});

test("the Edge Function's CTC module is identical to the web app's", () => {
  assert.equal(readFileSync(new URL("../supabase/functions/_shared/ctc.js", import.meta.url), "utf8"), readFileSync(new URL("../lib/ctc.js", import.meta.url), "utf8"));
  assert.equal(readFileSync(new URL("../supabase/functions/_shared/rules.js", import.meta.url), "utf8"), readFileSync(new URL("../lib/rules.js", import.meta.url), "utf8"));
});

test("C5: the salary card shows the database's check even if it disagrees with the Edge Function", async () => {
  const { llm } = scriptedLLM([toolUse("calculate_ctc", { application_id: "a1", ctc: 1200000, basic_monthly: 50000 }), say("Done.")]);
  const eng = fakeEngine({ desk_save_offer: { offer_id: "o9", ctc: 1200000, components: [{ name: "Basic + DA", kind: "basic", amount: 600000 }], check: { passes: false, wages_percent: 49.9, ctc: 1200000, deemed_extra_wages: 100, computed_by: "database" } } });
  const out = await runTurn({ text: "offer", deps: deps(llm, eng.rpc) });
  assert.equal(out.cards[0].passes, false); assert.equal(out.cards[0].wages_percent, 49.9);
});

test("C5: no database check, no card", async () => {
  const { llm } = scriptedLLM([toolUse("calculate_ctc", { application_id: "a1", ctc: 1200000 }), say("Couldn't save.")]);
  const out = await runTurn({ text: "offer", deps: deps(llm, fakeEngine({ desk_save_offer: { offer_id: "o9" } }).rpc) });
  assert.equal(out.cards.length, 0);
});

// ---------- QA-044 (S1): Desk checks the role by tool, before the tool runs ----------
const RECRUITER = { roles: ["recruiter"], modules: ["hire", "policies"] };
test("every Desk tool declares its module", () => {
  for (const t of TOOL_DEFS) assert.ok(TOOL_MODULE[t.name], `${t.name} has no module`);
});
test("a Recruiter isn't even offered Onboard or Probation tools", () => {
  const names = toolDefs({ modules: RECRUITER.modules }).map(t => t.name);
  for (const n of ["show_joiners", "mark_offer_accepted", "start_probation_review"]) assert.ok(!names.includes(n), n);
  for (const n of ["show_pipeline", "calculate_ctc", "get_brief", "find_people"]) assert.ok(names.includes(n), n);
});
for (const [tool, input, mod] of [["show_joiners", {}, "Onboard"], ["start_probation_review", { person_id: "p-priya" }, "Probation"],
  ["draft_document", { person_id: "p-sneha", kind: "appointment_letter", details: "Sneha" }, "Onboard"], ["mark_offer_accepted", { offer_id: "o1" }, "Onboard"]]) {
  test(`QA-044: a Recruiter's ${tool} is refused before anything is read`, async () => {
    const { llm } = scriptedLLM([toolUse(tool, input), say("should not get here")]);
    const eng = fakeEngine();
    const out = await runTurn({ text: "do it", deps: deps(llm, eng.rpc, { access: RECRUITER }) });
    assert.equal(out.reply, `${mod} isn't part of your access as Recruiter. Ask HR or your Super admin if you need it.`);
    assert.ok(!eng.calls.some(c => c.name !== "desk_month_tokens"), "no engine call: " + eng.calls.map(c => c.name));
  });
}
test("QA-044: an offer letter is Hire, so a Recruiter can draft one", async () => {
  const { llm } = scriptedLLM([toolUse("draft_document", { person_id: "p1", kind: "offer_letter", details: "Kiran" }),
    { stop_reason: "end_turn", usage: {}, content: [{ type: "text", text: "Dear Kiran" }] }, say("Drafted.")]);
  const eng = fakeEngine({ desk_save_document: { document_id: "d1" } });
  const out = await runTurn({ text: "Draft Kiran's offer letter", deps: deps(llm, eng.rpc, { access: RECRUITER }) });
  assert.equal(out.cards[0].subject_type, "document");
});
test("QA-044: a tapped card is checked again (a Recruiter can't run Onboard from a card)", async () => {
  const eng = fakeEngine();
  const r = await handleAction({ action: "run", params: { tool: "mark_offer_accepted", input: { offer_id: "o1" } }, rpc: eng.rpc, access: RECRUITER });
  assert.match(r.reply, /^Onboard isn't part of your access as Recruiter/); assert.equal(eng.calls.length, 0);
});

// ---------- QA-045 (S2): a question never runs an action; actions come back as cards ----------
const EVAL = JSON.parse(readFileSync(new URL("./fixtures/desk-eval.json", import.meta.url)));
for (const c of EVAL.questions) test(`QA-045 eval: "${c.text}" is a question`, () => assert.equal(isQuestion(c.text), true));
for (const c of EVAL.requests) test(`QA-045 eval: "${c.text}" is a request`, () => assert.equal(isQuestion(c.text), false));
for (const c of EVAL.questions) test(`QA-045: "${c.text}" offers only read-only tools, and an action the model picks anyway doesn't run`, async () => {
  const { llm, calls } = scriptedLLM([toolUse("start_probation_review", { person_id: "p-priya" }), say("should not get here")]);
  const eng = fakeEngine();
  const out = await runTurn({ text: c.text, deps: deps(llm, eng.rpc) });
  assert.deepEqual(calls[0].body.tools.map(t => t.name).sort(), [...READ_ONLY_TOOLS].sort());
  assert.match(calls[0].body.system, /asked a question/);
  assert.equal(out.blocked, "question"); assert.ok(!eng.calls.some(x => x.name === "desk_start_probation_review"));
});
for (const tool of CONFIRM_TOOLS) test(`QA-045: ${tool} returns a card to approve and changes nothing`, async () => {
  const input = { add_candidate: { name: "Asha Rao", role_id: "r1", consent_confirmed: true }, move_candidate: { application_id: "a1", stage: "Interview" },
    chase_owner: { task_id: "t1" }, record_feedback: { application_id: "a1", scores: { skills: 4 }, recommendation: "hire" },
    mark_offer_accepted: { offer_id: "o1" }, start_probation_review: { person_id: "p1" } }[tool];
  const { llm } = scriptedLLM([toolUse(tool, input), say("Ready for your approval.")]);
  const eng = fakeEngine();
  const out = await runTurn({ text: "go ahead", deps: deps(llm, eng.rpc) });
  assert.equal(out.cards[0].type, "approval"); assert.equal(out.cards[0].actions[0].action, "run");
  assert.ok(!eng.calls.some(x => x.name !== "desk_month_tokens"), "nothing ran: " + eng.calls.map(x => x.name));
});
test("QA-045: Approve on the card runs it; Cancel changes nothing", async () => {
  const eng = fakeEngine();
  const r = await handleAction({ action: "run", params: { tool: "chase_owner", input: { task_id: "task-1" } }, rpc: eng.rpc });
  assert.match(r.reply, /Reminder sent to Arjun Mehta/); assert.deepEqual(eng.calls.map(c => c.name), ["desk_chase_owner"]);
  const c = await handleAction({ action: "cancel", params: { tool: "chase_owner" }, rpc: eng.rpc });
  assert.match(c.reply, /Nothing was changed or sent/); assert.equal(eng.calls.length, 1);
  await assert.rejects(handleAction({ action: "run", params: { tool: "desk_approve", input: {} }, rpc: eng.rpc }));
});

// ---------- QA-041: no WhatsApp promises while it's off ----------
test("QA-041: with WhatsApp off, neither the prompt nor any tool mentions it", () => {
  assert.ok(!/WhatsApp(?! isn't switched on)/.test(systemPrompt({ channels: ["app", "email"] }).replace("Never mention WhatsApp or promise a WhatsApp message.", "")));
  for (const t of toolDefs({ channels: ["app", "email"] })) assert.ok(!/WhatsApp/.test(t.description), t.name);
  assert.ok(/on WhatsApp/.test(systemPrompt({ channels: ["app", "email", "whatsapp"] })));
});

// ---------- QA-040: Reject discards with a reason; no raw database text ----------
test("QA-040: Reject needs a reason from the fixed list and goes through the discard path", async () => {
  const eng = fakeEngine({ desk_discard: { discarded: 1 } });
  const none = await handleAction({ action: "discard", params: { subject_type: "role", subject_id: "role-9" }, rpc: eng.rpc });
  assert.equal(none.needs_reason, true); assert.equal(eng.calls.length, 0);
  const r = await handleAction({ action: "discard", params: { subject_type: "role", subject_id: "role-9", reason: "not_needed" }, rpc: eng.rpc });
  assert.match(r.reply, /Not needed any more/); assert.deepEqual(eng.calls[0].args, { p_subject_type: "role", p_subject_id: "role-9", p_reason: "not_needed" });
});
test("QA-040: database internals become a plain message; our own refusals pass through", async () => {
  const { friendly } = await import("../supabase/functions/_shared/agent.js");
  assert.doesNotMatch(friendly(new Error('ERROR:  new row for relation "role" violates check constraint "role_open_needs_approval"')), /relation|constraint|role_open/);
  assert.match(friendly(new Error("new row violates row-level security policy for table \"person\"")), /don't have access/);
  assert.equal(friendly(new Error("ERROR:  Pick a reason for sending it back")), "Pick a reason for sending it back");
});
