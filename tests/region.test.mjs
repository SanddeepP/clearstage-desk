import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { COUNTRIES, suggest, zonesFor, toE164, country } from "../lib/region.js";

test("suggests the country from the browser time zone; unknown zones make the user choose", () => {
  assert.deepEqual(suggest("Asia/Kolkata"), { country: "IN", timezone: "Asia/Kolkata" });
  assert.deepEqual(suggest("Asia/Calcutta"), { country: "IN", timezone: "Asia/Kolkata" });
  assert.deepEqual(suggest("Europe/London"), { country: "GB", timezone: "Europe/London" });
  assert.deepEqual(suggest("America/Chicago"), { country: "US", timezone: "America/Chicago" });
  assert.deepEqual(suggest("Antarctica/Troll"), { country: "", timezone: "" });
  assert.deepEqual(suggest(""), { country: "", timezone: "" });
});
test("zones for a country put the browser's zone first only when it belongs there", () => {
  assert.equal(zonesFor("US", "America/Los_Angeles")[0], "America/Los_Angeles");
  assert.equal(zonesFor("US", "Europe/London")[0], "America/New_York");
  assert.deepEqual(zonesFor("GB"), ["Europe/London"]);
  assert.deepEqual(zonesFor("XX"), []);
});
test("phones become E.164 with the company's dialling code; no fixed +91", () => {
  assert.equal(toE164("98765 43210", "IN"), "+919876543210");
  assert.equal(toE164("07700 900123", "GB"), "+447700900123");
  assert.equal(toE164("+44 7700 900123", "IN"), "+447700900123");
  assert.equal(toE164("abc", "GB"), "");
  assert.equal(toE164("", "GB"), "");
});
test("the browser list matches the database country table (015) code for code", () => {
  const sql = readFileSync(new URL("../supabase/migrations/015_company_region.sql", import.meta.url), "utf8");
  const db = [...sql.matchAll(/\('([A-Z]{2})', '([^']+)',\s+'([A-Z]{3})', '([a-z]{2}-[A-Z]{2})', '([A-Za-z_\/]+)'/g)].map(m => ({ code: m[1], name: m[2], tz: m[5] }));
  assert.equal(db.length, COUNTRIES.length);
  for (const d of db) { const c = country(d.code); assert.ok(c, d.code); assert.equal(c.name, d.name); assert.ok(c.zones.includes(d.tz), d.code + " default zone"); }
  for (const c of COUNTRIES) for (const [k] of c.regions) assert.ok(k.startsWith(c.code + "-"), k);
});
