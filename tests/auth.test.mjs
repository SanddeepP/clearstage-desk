// Code-only sign-in (founder decision 20 Nov): clear "wrong code" vs "expired" messages.
import test from "node:test";
import assert from "node:assert/strict";
import { codeError, CODE_WRONG, CODE_EXPIRED, CODE_TTL_MS, RESEND_AFTER_S } from "../auth.js";
import { readFileSync } from "node:fs";

const supa = { message: "Token has expired or is invalid", code: "otp_expired" };
test("a bad code within 10 minutes says the code is wrong", () => {
  const now = Date.now();
  assert.equal(codeError(supa, now - 2 * 60e3, now), CODE_WRONG);
});
test("a code older than 10 minutes says it expired and to send a new one", () => {
  const now = Date.now();
  assert.equal(codeError(supa, now - CODE_TTL_MS - 1000, now), CODE_EXPIRED);
  assert.match(CODE_EXPIRED, /expired.*send a new one/i);
});
test("rate limits keep their own message", () => {
  assert.match(codeError({ message: "Email rate limit exceeded" }, Date.now()), /too many codes/i);
});
test("resend appears after 60 seconds", () => assert.equal(RESEND_AFTER_S, 60));
test("no sign-in link wording is left on the sign-in screens", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const signin = html.slice(html.indexOf('id="s-email"'), html.indexOf('id="s-setup"'));
  const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const appSignin = app.slice(app.indexOf("SIGN IN"), app.indexOf("async function afterSignIn"));
  for (const t of [signin, appSignin]) assert.doesNotMatch(t, /sign-in link|click the link|magic link/i);
  assert.match(signin, /Verify and sign in/);
  assert.match(signin, /replaces the old one/);
});
