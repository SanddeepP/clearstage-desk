// Bugs of 25 Nov: an expired session read as "no company"; own company + sample access gave "multiple rows".
import test from "node:test";
import assert from "node:assert/strict";
import { profileFromClient, isSessionExpired, SessionExpiredError, SESSION_EXPIRED } from "../auth.js";

const own = { id: "co-own", name: "cccc", is_sample: false }, sample = { id: "co-s", name: "Acme Fintech", is_sample: true };
const row = co => ({ user_id: "u1", company_id: co.id, full_name: "Founder", phone: null, app_role: "owner",
  company: { id: co.id, name: co.name, city: "Hyderabad", team_setup: "solo", desk_enabled: true } });
function fake({ fresh = true, workspaces = [], members = [], rpcError = null, employee = null }) {
  const log = [];
  return { log,
    rpc: async name => { log.push(name); if (rpcError) return { data: null, error: rpcError };
      return { data: name === "session_fresh" ? fresh : name === "my_workspaces" ? (fresh ? workspaces : []) : name === "my_employee" ? employee : null, error: null }; },
    from: table => { const f = {}; const api = { select: () => api, eq: (k, v) => { f[k] = v; return api; },
      maybeSingle: async () => { log.push({ table, f: { ...f } });
        const rows = fresh ? members.filter(r => Object.entries(f).every(([k, v]) => r[k] === v)) : [];
        return rows.length > 1 ? { data: null, error: { message: "JSON object requested, multiple (or no) rows returned" } } : { data: rows[0] ?? null, error: null }; } };
      return api; } };
}
const user = { id: "u1", email: "founder@example.com" };

test("an expired session throws SessionExpiredError, never 'no company'", async () => {
  const c = fake({ fresh: false, workspaces: [own], members: [row(own)] });
  await assert.rejects(profileFromClient(c, user), e => e instanceof SessionExpiredError && e.message === SESSION_EXPIRED);
  assert.ok(!c.log.some(x => x.table), "no member read once the database says stale");
});
test("the database's 28000 error becomes SessionExpiredError", async () => {
  await assert.rejects(profileFromClient(fake({ rpcError: { message: "Your session has expired. Sign in again.", code: "28000" } }), user), e => e instanceof SessionExpiredError);
});
test("own company + sample access opens the own company (no 'multiple rows')", async () => {
  const c = fake({ workspaces: [own, sample], members: [row(own), row(sample)] });
  const p = await profileFromClient(c, user);
  assert.equal(p.company, "cccc"); assert.equal(p.companyId, "co-own"); assert.equal(p.deskEnabled, true);
  assert.deepEqual(c.log.find(x => x.table).f, { user_id: "u1", company_id: "co-own" });
});
test("sample access only, or nothing yet → null (setup creates their own company)", async () => {
  assert.equal(await profileFromClient(fake({ workspaces: [sample], members: [row(sample)] }), user), null);
  assert.equal(await profileFromClient(fake({ workspaces: [] }), user), null);
});
test("listed but hidden a moment later → expired, not setup", async () => {
  await assert.rejects(profileFromClient(fake({ workspaces: [own], members: [] }), user), e => e instanceof SessionExpiredError);
});
test("isSessionExpired recognises every shape; the code-expired wording is separate", () => {
  assert.ok(isSessionExpired(new SessionExpiredError()));
  assert.ok(isSessionExpired({ code: "28000", message: "x" }));
  assert.ok(isSessionExpired("Your session has expired. Sign in again."));
  assert.ok(!isSessionExpired(new Error("That code has expired. Send a new one.")));
  assert.ok(!isSessionExpired(null));
});

test("018: an Employee login (no workspace) opens the Employee view, never setup", async () => {
  const emp = { company: "cccc", profile: { name: "Kavya Menon" }, letters: [], tasks: [], requests: [] };
  const c = fake({ workspaces: [], employee: emp });
  const p = await profileFromClient(c, user);
  assert.equal(p.name, "Kavya Menon"); assert.deepEqual(p.employee, emp);
  assert.ok(c.log.indexOf("claim_my_invite") < c.log.indexOf("my_workspaces"), "the invite is claimed first");
  assert.ok(!c.log.some(x => x.table), "an employee never reads the member table");
});
