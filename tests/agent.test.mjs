import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runTurn, handleAction } from "../supabase/functions/_shared/agent.js";
import { TOOL_DEFS, blockedText } from "../supabase/functions/_shared/tools.js";

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
    desk_save_offer: { offer_id: "offer-1" },
    desk_request_approval: { task_id: "y", approver: "Sanddeep", self: true },
    desk_chase_owner: { chased: "Arjun Mehta", escalates_to: "Vikram" },
    desk_month_tokens: 0,
    desk_approve: { approved: 1, by: "Sanddeep" },
    ...overrides,
  };
  const rpc = async (name, args = {}) => { calls.push({ name, args }); if (data[name] instanceof Error) throw data[name]; if (!(name in data)) throw new Error("unexpected rpc " + name); return data[name]; };
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

test("CTC is computed by code, not the model: Kiran's ₹12 L fails, fix passes", async () => {
  const comps = [{ name: "Basic + DA", kind: "basic", amount: 420000 }, { name: "HRA", kind: "hra", amount: 210000 }, { name: "Special allowance", kind: "special", amount: 510000 }, { name: "Employer PF", kind: "employer_pf", amount: 60000 }];
  const { llm } = scriptedLLM([toolUse("calculate_ctc", { application_id: "a1", components: comps }), say("It fails the 50% rule. Want me to fix it?"),
                               toolUse("calculate_ctc", { application_id: "a1", components: comps, fix: true }), say("Fixed.")]);
  const eng = fakeEngine();
  const first = await runTurn({ text: "Build Kiran's offer", deps: deps(llm, eng.rpc) });
  assert.equal(first.cards[0].passes, false); assert.equal(first.cards[0].wages_percent, 36.8);
  const second = await runTurn({ text: "Fix it", deps: deps(llm, eng.rpc) });
  assert.equal(second.cards[0].passes, true); assert.equal(second.cards[0].ctc, 1200000);
  const saved = eng.calls.filter(c => c.name === "desk_save_offer");
  assert.equal(saved[1].args.p_check.passes, true);
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
  const { llm, calls } = scriptedLLM([toolUse("chase_owner", { task_id: "t9" }), say("That task is already closed.")]);
  const eng = fakeEngine({ desk_chase_owner: new Error("ERROR:  That task is not open") });
  const out = await runTurn({ text: "chase", deps: deps(llm, eng.rpc) });
  const toolResult = calls[1].body.messages[2].content[0];
  assert.equal(toolResult.is_error, true); assert.equal(toolResult.content, "That task is not open");
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
});
