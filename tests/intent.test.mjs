import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHire, parseBudget } from "../lib/intent.js";

test("COO example: Hinglish data analyst request is read correctly", () => {
  const r = parseHire("Ek data analyst chahiye Bangalore mein, 8-10L");
  assert.deepEqual(r, { intent: "hire", count: 1, title: "Data Analyst", city: "Bengaluru", budget: { min: 8, max: 10 } });
});

test("English sales request", () => {
  const r = parseHire("Hire 2 sales execs in Pune");
  assert.equal(r.count, 2); assert.equal(r.title, "Sales Executive"); assert.equal(r.city, "Pune"); assert.equal(r.budget, null);
});

test("Hinglish with 'do' as two", () => {
  const r = parseHire("Pune mein do sales executives hire karna hai, 4 to 5 lakh");
  assert.equal(r.count, 2); assert.equal(r.title, "Sales Executive"); assert.deepEqual(r.budget, { min: 4, max: 5 });
});

test("unknown role words become the title", () => {
  const r = parseHire("we need 3 warehouse supervisors in Chennai");
  assert.equal(r.title, "Warehouse Supervisor"); assert.equal(r.count, 3); assert.equal(r.city, "Chennai");
});

test("budget number isn't mistaken for the head count", () => {
  const r = parseHire("need a backend developer, 12L, Hyderabad");
  assert.equal(r.count, null); assert.equal(r.title, "Backend Developer"); assert.deepEqual(r.budget, { min: 12, max: 12 });
});

test("non-hiring text returns null", () => {
  assert.equal(parseHire("what's the weather like"), null);
  assert.equal(parseHire("show my pipeline"), null);
});

test("budget formats", () => {
  assert.deepEqual(parseBudget("₹6.5 - 8 LPA"), { min: 6.5, max: 8 });
  assert.deepEqual(parseBudget("10 lakh"), { min: 10, max: 10 });
  assert.equal(parseBudget("no budget yet"), null);
});
