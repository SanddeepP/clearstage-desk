import { test } from "node:test";
import assert from "node:assert/strict";
import { senderName, fromHeader, resendPayload, classifyResend, sendQueued, EMAIL_MESSAGES, DEFAULT_FROM } from "../supabase/functions/_shared/email.js";

const msg = (o = {}) => ({ id: "m1", to: "tara.fictional@example.com", to_name: "Tara Fictional", subject: "Your offer from Rycruit", body: "Hi Tara, your offer is ready.", company: "Rycruit", reply_to: "ritu@example.com", ...o });

test("sender is '<Company> via Clearstage' from the verified domain, safe in a header", () => {
  assert.equal(fromHeader("Rycruit"), `"Rycruit via Clearstage" <${DEFAULT_FROM}>`);
  assert.equal(senderName('Evil"Co\r\nBcc: x@y.com <a>'), "Evil Co Bcc: x@y.com  a  via Clearstage".replace(/\s+/g, " "));
  assert.ok(!/[\r\n"<>]/.test(senderName('A"B<C>\nD')));
  assert.equal(senderName(""), "Your employer via Clearstage");
});

test("the approved text goes out as approved, plain text, reply to the approver", () => {
  const p = resendPayload(msg());
  assert.deepEqual(p.to, ["tara.fictional@example.com"]);
  assert.ok(p.text.startsWith("Hi Tara, your offer is ready."));
  assert.ok(p.text.includes("Sent by Rycruit through Clearstage."));
  assert.equal(p.reply_to, "ritu@example.com");
  assert.equal(p.html, undefined);
  assert.ok(!/\n/.test(resendPayload(msg({ subject: "a\nBcc: x@y.com" })).subject));
  assert.throws(() => resendPayload(msg({ to: "not an address" })));
  assert.equal(resendPayload(msg({ reply_to: "bad" })).reply_to, undefined);
});

test("Resend errors become plain states", () => {
  assert.equal(classifyResend(200).code, "ok");
  assert.equal(classifyResend(401).code, "setup");
  assert.equal(classifyResend(422).code, "refused");
  assert.equal(classifyResend(429).retry, true);
  assert.equal(classifyResend(503).code, "busy");
});

test("no key: nothing is claimed, messages stay queued", async () => {
  let claimed = false;
  const r = await sendQueued({ key: "", claim: async () => { claimed = true; return { messages: [msg()] }; }, result: async () => ({}), fetch: async () => { throw new Error("no"); } });
  assert.equal(r.status, "not_connected"); assert.equal(claimed, false); assert.equal(r.message, EMAIL_MESSAGES.not_connected);
});

test("paused: nothing is sent", async () => {
  let fetched = false;
  const r = await sendQueued({ key: "k", claim: async () => ({ paused: true, messages: [] }), result: async () => ({}), fetch: async () => { fetched = true; } });
  assert.equal(r.status, "paused"); assert.equal(fetched, false);
});

test("each message gets its own result; a bad key alerts once; the key travels in a header", async () => {
  const seen = [], results = [], alerts = [];
  const statuses = { m1: 200, m2: 422, m3: 401, m4: 401 };
  const r = await sendQueued({ key: "secret-key", claim: async () => ({ messages: ["m1", "m2", "m3", "m4"].map(id => msg({ id })) }),
    fetch: async (url, init) => { const b = JSON.parse(init.body); seen.push({ url, auth: init.headers.Authorization, to: b.to[0] }); const id = ["m1", "m2", "m3", "m4"][seen.length - 1];
      return { status: statuses[id], json: async () => (statuses[id] === 200 ? { id: "re_123" } : { message: "x" }) }; },
    result: async (id, ok, providerId, error) => { results.push({ id, ok, providerId, error }); return { status: ok ? "sent" : "queued" }; },
    alert: async (k) => alerts.push(k) });
  assert.equal(r.sent, 1); assert.equal(r.failed, 3);
  assert.deepEqual(results[0], { id: "m1", ok: true, providerId: "re_123", error: null });
  assert.equal(results[1].error, EMAIL_MESSAGES.refused);
  assert.equal(results[2].error, EMAIL_MESSAGES.setup);
  assert.deepEqual(alerts, ["email_setup"]);
  assert.ok(seen.every(s => s.url === "https://api.resend.com/emails" && s.auth === "Bearer secret-key" && !s.url.includes("secret")));
});

test("a network error is recorded, never thrown", async () => {
  const results = [];
  const r = await sendQueued({ key: "k", claim: async () => ({ messages: [msg()] }), fetch: async () => { throw new Error("network down"); },
    result: async (id, ok, p, e) => { results.push(e); return { status: "queued" }; } });
  assert.equal(r.failed, 1); assert.equal(results[0], "network down");
});
