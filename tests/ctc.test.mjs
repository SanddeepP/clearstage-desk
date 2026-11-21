import { test } from "node:test";
import assert from "node:assert/strict";
import { checkWagesRule, ctcBreakup, fixBasic, PF_CITATION, professionalTax } from "../lib/ctc.js";
import { ruleValue, STATUTORY_RULES } from "../lib/rules.js";
import { readFileSync } from "node:fs";

const amt = (r, kind) => r.components.find(c => c.kind === kind)?.amount ?? 0;
const ON = "2026-12-01";

// CTO ruling 21 Nov, §5: PF ceiling rule, HRA 40%, Telangana, no variable. Start at Basic = 40% of CTC, then Fix to ≥ 51%.
// [CTC, Basic/month, Gross, Employer PF, Employer ESI, Gratuity, Special, Wages %, Take-home/month]
export const CTO_TABLE = [
  [180000, 8000, 158707, 11520, 5158, 4615, 24307, 56.4, 12167],
  [240000, 10000, 212911, 14400, 6920, 5769, 44911, 52.8, 16260],
  [300000, 13000, 273780, 18720, 0, 7500, 55380, 53.3, 21055],
  [360000, 15000, 329746, 21600, 0, 8654, 77746, 51.2, 25479],
  [450000, 19000, 411678, 27360, 0, 10962, 92478, 51.9, 31827],
  [600000, 25000, 549577, 36000, 0, 14423, 129577, 51.2, 42598],
  [840000, 35000, 783808, 36000, 0, 20192, 195808, 51.2, 62117],
  [1500000, 63000, 1427654, 36000, 0, 36346, 369254, 51.7, 115771],
  [2500000, 104000, 2404000, 36000, 0, 60000, 656800, 51.1, 197133],
  [4000000, 166000, 3868231, 36000, 0, 95769, 1079431, 51.0, 319153],
];

test("every row of the CTO's reference table, to the rupee", () => {
  for (const [ctc, b, gross, pf, esi, grat, special, pct, th] of CTO_TABLE) {
    const r = fixBasic({ ctc, basicMonthly: Math.round(ctc * 0.4 / 12), on: ON });
    const got = [ctc, r.inputs.basicMonthly, r.gross, amt(r, "employer_pf"), amt(r, "employer_esi"), amt(r, "gratuity"), amt(r, "special"), r.check.wagesPercent, r.monthly.takeHome];
    assert.deepEqual(got, [ctc, b, gross, pf, esi, grat, special, pct, th], `CTC ${ctc}`);
    assert.equal(r.components.reduce((s, c) => s + c.amount, 0), ctc, `CTC ${ctc} adds up exactly`);
  }
});

test("Kiran: Desk's first draft fails at 35.6% (new PF ceiling)", () => {
  const r = ctcBreakup({ ctc: 1200000, basicMonthly: 35000, on: ON });
  assert.deepEqual(r.components.map(c => [c.kind, c.amount]),
    [["basic", 420000], ["hra", 168000], ["special", 555808], ["employer_pf", 36000], ["gratuity", 20192]]);
  assert.equal(r.check.ctc, 1200000);
  assert.equal(r.check.wagesPercent, 35.6);
  assert.equal(r.check.passes, false);
});

test("Kiran after Fix = the PM's worked example (Basic ₹50,000, 51.2%)", () => {
  const r = fixBasic({ ctc: 1200000, basicMonthly: 35000, on: ON });
  assert.deepEqual(r.components.map(c => [c.kind, c.amount]),
    [["basic", 600000], ["hra", 240000], ["special", 295154], ["employer_pf", 36000], ["gratuity", 28846]]);
  assert.equal(r.check.wagesPercent, 51.2);
  assert.equal(r.check.passes, true);
  assert.equal(r.gross, 1135154);
  assert.equal(r.monthly.takeHome, 91396);
});

test("Faisal: 12% of full basic (₹22,500 is under the new ceiling), 51.2%", () => {
  const r = ctcBreakup({ ctc: 540000, basicMonthly: 22500, on: ON });
  assert.deepEqual(r.components.map(c => [c.kind, c.amount]),
    [["basic", 270000], ["hra", 108000], ["special", 116619], ["employer_pf", 32400], ["gratuity", 12981]]);
  assert.equal(r.check.wagesPercent, 51.2);
  assert.equal(r.check.passes, true);
});

test("the PF ceiling is dated: ₹15,000 up to 16 Sep 2026, ₹25,000 from 17 Sep 2026", () => {
  assert.equal(ruleValue("pf_wage_ceiling", "2026-09-16").value, 15000);
  assert.equal(ruleValue("pf_wage_ceiling", "2026-09-17").value, 25000);
  assert.equal(amt(ctcBreakup({ ctc: 1200000, basicMonthly: 35000, on: "2026-09-01" }), "employer_pf"), 21600);
  assert.equal(amt(ctcBreakup({ ctc: 1200000, basicMonthly: 35000, on: "2026-10-01" }), "employer_pf"), 36000);
  assert.equal(amt(ctcBreakup({ ctc: 1200000, basicMonthly: 35000, pfRule: "full", on: ON }), "employer_pf"), 50400);
  assert.throws(() => ruleValue("pf_wage_ceiling", "2010-01-01"), /No pf_wage_ceiling rule/);
});

test("every statutory rule is awaiting legal review; ESI limit is still ₹21,000", () => {
  assert.equal(ruleValue("esi_wage_limit", ON).value.general, 21000);
  assert.equal(ruleValue("esi_wage_limit", ON).value.disability, 25000);
  assert.ok(STATUTORY_RULES.length >= 6);
  assert.equal(PF_CITATION, "PF: 12% × min(PF wages, ₹25,000) — Code on Social Security, 2020; EPF Scheme; S.O. 5109(E), 17 Sep 2026. Awaiting legal review.");
});

test("employer PF counts in total remuneration; gratuity and employer ESI are left out", () => {
  const r = checkWagesRule([
    { kind: "basic", amount: 500000 }, { kind: "special", amount: 400000 },
    { kind: "employer_pf", amount: 100000 }, { kind: "gratuity", amount: 24000 }, { kind: "employer_esi", amount: 6000 }]);
  assert.equal(r.remuneration, 1000000);
  assert.equal(r.passes, true);
  assert.equal(r.wagesPercent, 50);
});

test("exactly 50% passes, one rupee under fails", () => {
  assert.equal(checkWagesRule([{ kind: "basic", amount: 500000 }, { kind: "special", amount: 500000 }]).passes, true);
  assert.equal(checkWagesRule([{ kind: "basic", amount: 499999 }, { kind: "special", amount: 500001 }]).passes, false);
});

test("ESI cases (CTO rows 1-2) carry a statutory-bonus warning", () => {
  const r = fixBasic({ ctc: 180000, basicMonthly: 6000, on: ON });
  assert.ok(amt(r, "employer_esi") > 0);
  assert.match(r.warnings[0], /Statutory bonus applies/);
  assert.equal(fixBasic({ ctc: 1200000, basicMonthly: 35000, on: ON }).warnings.length, 0);
});

test("Telangana professional tax slabs", () => {
  assert.deepEqual([15000, 15001, 20000, 20001].map(g => professionalTax(g, ON)), [0, 150, 150, 200]);
});

test("bad inputs are refused, and amounts can't be passed in", () => {
  assert.throws(() => ctcBreakup({ ctc: 1200000, basicMonthly: 35000.5 }), /whole number/);
  assert.throws(() => ctcBreakup({ ctc: 1200000, basicMonthly: 120000 }), /more than the gross pay/);
  assert.throws(() => ctcBreakup({ ctc: 1200000, basicMonthly: 35000, pfRule: "half" }), /PF rule/);
  assert.throws(() => ctcBreakup({ ctc: 1200000, basicMonthly: 35000, hraPct: 120 }), /HRA/);
  assert.throws(() => checkWagesRule([]));
  assert.throws(() => checkWagesRule([{ kind: "gratuity", amount: 1000 }]), /no pay/);
});

test("lib/rules.js carries exactly the rows migration 008 seeds (dates, values, citations)", () => {
  const sql = readFileSync(new URL("../supabase/migrations/008_statutory_rules.sql", import.meta.url), "utf8");
  const seed = sql.slice(sql.indexOf("insert into statutory_rule"), sql.indexOf("on conflict (code, effective_from)"));
  const rows = [...seed.matchAll(/\('(\w+)', '([^']+)', '([\d-]+)', (null|'[\d-]+'),\s*'([^']+)'\)/g)]
    .map(m => ({ code: m[1], value: JSON.parse(m[2]), from: m[3], to: m[4] === "null" ? null : m[4].slice(1, -1), citation: m[5] }));
  assert.equal(rows.length, STATUTORY_RULES.length);
  assert.deepEqual(rows, STATUTORY_RULES.map(({ code, value, from, to, citation }) => ({ code, value, from, to, citation })));
});

test("the database test is generated from the same CTO table as this file", () => {
  const fx = JSON.parse(readFileSync(new URL("./fixtures/cto-ctc-table-21nov.json", import.meta.url), "utf8"));
  assert.deepEqual(fx.rows, CTO_TABLE);
  const sql = readFileSync(new URL("../supabase/tests/statutory_rules.sql", import.meta.url), "utf8");
  for (const [ctc] of CTO_TABLE) assert.ok(sql.includes(`CTO table row CTC ${ctc}`), `row ${ctc} in the DB test`);
});
