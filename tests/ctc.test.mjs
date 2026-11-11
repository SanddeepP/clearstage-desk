import { test } from "node:test";
import assert from "node:assert/strict";
import { checkWagesRule, fixStructure } from "../lib/ctc.js";

// Kiran's demo offer: ₹12 L CTC, basic too low (from the seed data)
const kiran = [
  { name: "Basic + DA", kind: "basic", amount: 420000 },
  { name: "HRA", kind: "hra", amount: 210000 },
  { name: "Special allowance", kind: "special", amount: 510000 },
  { name: "Employer PF", kind: "employer_pf", amount: 60000 },
];

test("Kiran's offer fails the 50% wages check", () => {
  const r = checkWagesRule(kiran);
  assert.equal(r.ctc, 1200000);
  assert.equal(r.remuneration, 1140000);
  assert.equal(r.passes, false);
  assert.equal(r.wagesPercent, 36.8);
  assert.equal(r.deemedExtraWages, 720000 - 570000);
});

test("fixStructure keeps CTC the same and passes", () => {
  const fixed = fixStructure(kiran);
  const r = checkWagesRule(fixed);
  assert.equal(r.ctc, 1200000);
  assert.equal(r.passes, true);
  assert.equal(fixed.find(c => c.kind === "basic").amount, 570000);
  assert.equal(fixed.find(c => c.kind === "hra").amount, 210000);
  assert.equal(fixed.find(c => c.kind === "special").amount, 360000);
});

test("exactly 50% passes", () => {
  const r = checkWagesRule([
    { kind: "basic", amount: 500000 },
    { kind: "special", amount: 500000 },
  ]);
  assert.equal(r.passes, true);
  assert.equal(r.deemedExtraWages, 0);
});

test("one rupee under 50% fails", () => {
  const r = checkWagesRule([
    { kind: "basic", amount: 499999 },
    { kind: "special", amount: 500001 },
  ]);
  assert.equal(r.passes, false);
});

test("DA counts as wages; employer PF is outside remuneration", () => {
  const r = checkWagesRule([
    { kind: "basic", amount: 300000 },
    { kind: "da", amount: 200000 },
    { kind: "hra", amount: 400000 },
    { kind: "employer_pf", amount: 100000 },
  ]);
  assert.equal(r.remuneration, 900000);
  assert.equal(r.wages, 500000);
  assert.equal(r.passes, true);
});

test("a passing structure is returned unchanged", () => {
  const ok = [{ kind: "basic", amount: 600000 }, { kind: "hra", amount: 240000 }];
  assert.deepEqual(fixStructure(ok), ok);
});

test("bad input is rejected", () => {
  assert.throws(() => checkWagesRule([]));
  assert.throws(() => checkWagesRule([{ kind: "basic", amount: -5 }]));
  assert.throws(() => checkWagesRule([{ kind: "employer_pf", amount: 1000 }]));
});
