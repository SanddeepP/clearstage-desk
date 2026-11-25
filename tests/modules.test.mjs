// Module tabs (spec RD-PM-Spec-Module-Tabs.md, CTO 25 Nov): catalog, defaults, honest Desk reply, intent detection.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GROUPS, MODULES, DEFAULT_STATE, states, notLiveReply, moduleIntent, PREVIEW_BANNER } from "../lib/modules.js";

const sql = readFileSync(new URL("../supabase/migrations/016_modules.sql", import.meta.url), "utf8");

test("the rail: Hire to exit, then Manage, in path order", () => {
  assert.deepEqual(GROUPS.map(g => g.label), ["Hire to exit", "Manage"]);
  assert.deepEqual(GROUPS.flatMap(g => g.modules), ["hire", "onboard", "probation", "compliance", "exit", "time", "payroll", "performance", "policies"]);
});
test("browser catalog matches the database (module_keys, module_default)", () => {
  const keys = sql.match(/select array\[([^\]]+)\]/)[1].match(/'(\w+)'/g).map(x => x.slice(1, -1));
  assert.deepEqual(keys, Object.keys(DEFAULT_STATE));
  assert.deepEqual(DEFAULT_STATE, { hire: "live", onboard: "preview", probation: "preview", compliance: "soon", exit: "soon", time: "soon", payroll: "soon", performance: "soon", policies: "soon" });
  assert.match(sql, /when 'hire' then 'live' when 'onboard' then 'preview' when 'probation' then 'preview' else 'soon'/);
});
test("the Desk function uses an identical copy", () => {
  assert.equal(readFileSync(new URL("../supabase/functions/_shared/modules.js", import.meta.url), "utf8"), readFileSync(new URL("../lib/modules.js", import.meta.url), "utf8"));
});
test("every Coming-soon module has its page: a line, 4-5 bullets, a Desk example; no dates, no India law in the headline", () => {
  for (const k of ["compliance", "exit", "time", "payroll", "performance", "policies"]) {
    const m = MODULES[k];
    assert.ok(m.line && m.desk, k);
    assert.ok(m.does.length >= 4 && m.does.length <= 5, k + " bullets");
    const all = [m.name, m.line, ...m.does].join(" ");
    assert.doesNotMatch(all, /\b(January|February|March|April|May|June|July|August|September|October|November|December|Q[1-4]|20\d\d)\b/, k + " has a date");
    assert.doesNotMatch(m.line, /India|Indian|₹|PF|ESI|EPF/, k + " headline is India-only");
  }
  assert.equal(MODULES.compliance.line, "Every statutory date, with an owner and a reminder.");
  assert.equal(MODULES.exit.line, "Resignation to final settlement, with nothing missed.");
  assert.equal(PREVIEW_BANNER, "Preview: this module is being built. You're seeing sample data.");
});
test("states: database values win, unknown values fall back to the defaults", () => {
  assert.deepEqual(states(null), DEFAULT_STATE);
  assert.equal(states({ onboard: "live", exit: "banana" }).onboard, "live");
  assert.equal(states({ exit: "banana" }).exit, "soon");
});
test("Desk's honest reply (spec wording)", () => {
  assert.equal(notLiveReply("payroll", "soon"), "Payroll is coming soon in Clearstage. I've noted that you need it.");
  assert.equal(notLiveReply("exit", "soon"), "Exit is coming soon in Clearstage. I've noted that you need it.");
  assert.match(notLiveReply("onboard", "preview"), /^Onboard is in preview in Clearstage: .* I've noted that you need it\.$/);
});
test("intents: module requests are caught, Hire requests never are", () => {
  const want = {
    "start Ravi's exit": "exit", "Ravi resigned today": "exit", "Draft his relieving letter": "exit", "work out the full and final for Ravi": "exit",
    "run payroll for this month": "payroll", "send the payslips": "payroll", "PF return due this week?": "compliance", "what's on the compliance calendar": "compliance",
    "set up performance reviews": "performance", "share the leave policy": "policies", "Meera wants 3 days off": "time", "show attendance": "time",
    "Start Priya's probation review": "probation", "Draft Sneha's appointment letter": "onboard", "Kiran accepted the offer": "onboard",
  };
  const hire = ["Build Kiran's offer", "What is his notice period", "salary check for Kiran", "Screen CVs for Backend Developer", "Chase Arjun Mehta",
    "Need a QA engineer in Chennai, 6-8 LPA, 3 yrs", "What's on today?", "Draft the offer letter for Faisal", "confirm the requirements card",
    "Close candidates who failed the test", "show me 4 and 5 stars for Backend Developer", "Ek data analyst chahiye Bangalore mein, 8-10L", "Wrap up my day"];
  for (const [t, k] of Object.entries(want)) assert.equal(moduleIntent(t), k, t);
  for (const t of hire) assert.equal(moduleIntent(t), null, t);
});
