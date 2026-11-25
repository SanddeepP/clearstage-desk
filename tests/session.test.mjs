// SEC-1 (CTO 22 Nov): idle 30 min with a warning at 25, 12 h maximum, all tabs together, storage may be blocked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionState, createSessionGuard, signedInAtFromToken, IDLE_MS, WARN_MS, MAX_MS, SESSION_KEYS } from "../lib/session.js";
import { restoredState } from "../lib/session.js";

const MIN = 60e3;
// A fake "browser": shared localStorage across tabs, a clock, timers and event targets that deliver storage events to other tabs.
function world() {
  const data = new Map(), tabs = []; let t = Date.UTC(2026, 10, 22, 4, 0);
  const storage = owner => ({
    getItem: k => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { data.set(k, String(v)); for (const tab of tabs) if (tab !== owner) tab.fire("storage", { key: k, newValue: String(v) }); },
  });
  return {
    now: () => t, advance(ms) { const end = t + ms; while (t < end) { t = Math.min(end, t + 30e3); for (const tab of tabs) tab.tick(); } },
    tab(name) {
      const listeners = {}, timers = [], events = [];
      const tab = { name, events, fire: (type, e) => (listeners[type] || []).forEach(f => f(e)), tick: () => timers.forEach(f => f()) };
      tabs.push(tab);
      tab.guard = createSessionGuard({
        onWarn: () => events.push("warn"), onClearWarn: () => events.push("clear"), onTimeout: r => events.push("out:" + r),
        env: { storage: storage(tab), now: () => t, setInterval: f => (timers.push(f), timers.length), clearInterval: () => { timers.length = 0; },
               target: {}, on: (_t, type, fn) => (listeners[type] ??= []).push(fn) } });
      tab.act = () => tab.fire("pointerdown", {});
      return tab;
    },
    blocked() { return { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } }; },
  };
}

test("the rule: warn at 25 min, out at 30 min idle, out at 12 h whatever the activity", () => {
  const now = 1e12;
  assert.equal(sessionState({ now, lastActivity: now - 24 * MIN, signedInAt: now - MIN }), "ok");
  assert.equal(sessionState({ now, lastActivity: now - WARN_MS, signedInAt: now - MIN }), "warn");
  assert.equal(sessionState({ now, lastActivity: now - IDLE_MS, signedInAt: now - MIN }), "idle");
  assert.equal(sessionState({ now, lastActivity: now, signedInAt: now - MAX_MS }), "max");
});

test("idle 30 minutes signs out, with a warning at 25", () => {
  const w = world(), a = w.tab("A"); a.guard.start(w.now(), { fresh: true });
  w.advance(25 * MIN + 30e3); assert.deepEqual(a.events, ["warn"]);
  w.advance(5 * MIN); assert.deepEqual(a.events, ["warn", "out:idle"]);
});

test("'Stay signed in' resets the clock", () => {
  const w = world(), a = w.tab("A"); a.guard.start(w.now(), { fresh: true });
  w.advance(26 * MIN); a.guard.stay();
  assert.deepEqual(a.events, ["warn", "clear"]);
  w.advance(20 * MIN); assert.ok(!a.events.includes("out:idle"));
  w.advance(11 * MIN); assert.equal(a.events.at(-1), "out:idle");
});

test("two tabs: activity in one keeps both alive", () => {
  const w = world(), a = w.tab("A"), b = w.tab("B");
  a.guard.start(w.now(), { fresh: true }); b.guard.start(undefined);
  for (let i = 0; i < 4; i++) { w.advance(20 * MIN); a.act(); }      // 80 minutes, activity only in A
  assert.ok(!b.events.some(e => e.startsWith("out")), "B stays signed in");
});

test("signing out in one tab signs out every tab", () => {
  const w = world(), a = w.tab("A"), b = w.tab("B");
  a.guard.start(w.now(), { fresh: true }); b.guard.start(undefined);
  a.guard.signedOut();
  assert.deepEqual(a.events, ["out:elsewhere-origin"]);
  assert.deepEqual(b.events, ["out:elsewhere"]);
});

test("12 hours ends the session even with constant activity", () => {
  const w = world(), a = w.tab("A"); a.guard.start(w.now(), { fresh: true });
  for (let i = 0; i < 24 * 2; i++) { w.advance(15 * MIN); a.act(); }
  assert.equal(a.events.at(-1), "out:max");
});

test("a restored session that went idle (laptop reopened) is signed out straight away", () => {
  const w = world(), a = w.tab("A"); a.guard.start(w.now(), { fresh: true }); a.act();
  a.guard.stop(); w.advance(2 * 3600e3);                                // page closed for 2 hours
  const a2 = w.tab("A2"); a2.guard.start(undefined);                  // reload restores the session
  assert.deepEqual(a2.events, ["out:idle"]);
  const a3 = w.tab("A3"); a3.guard.start(w.now(), { fresh: true });   // a fresh sign-in is not judged on old activity
  assert.deepEqual(a3.events, []);
});

test("storage blocked: the timeout still runs for this tab", () => {
  let t = 1e12; const events = [], timers = [];
  const g = createSessionGuard({ onWarn: () => events.push("warn"), onTimeout: r => events.push("out:" + r),
    env: { storage: world().blocked(), now: () => t, setInterval: f => timers.push(f), clearInterval: () => {}, noListeners: true } });
  g.start(t, { fresh: true });
  for (let i = 0; i < 61; i++) { t += 30e3; timers.forEach(f => f()); }
  assert.deepEqual(events, ["warn", "out:idle"]);
});

test("sign-in time comes from the token's amr timestamp", () => {
  const b64 = o => Buffer.from(JSON.stringify(o)).toString("base64url");
  const tok = `${b64({ alg: "HS256" })}.${b64({ sub: "u", amr: [{ method: "otp", timestamp: 1795000000 }] })}.sig`;
  assert.equal(signedInAtFromToken(tok), 1795000000 * 1000);
  assert.equal(signedInAtFromToken("garbage"), null);
  assert.ok(SESSION_KEYS.out);
});

test("restoredState: a restored session is judged before anything loads (bug 25 Nov)", () => {
  const H = 3600e3, now = Date.UTC(2026, 10, 25, 4, 0);
  const st = v => ({ getItem: k => (k === "cs:act" ? v : null) });
  assert.equal(restoredState(now - 13 * H, { storage: st(String(now - 60e3)), now }), "max");
  assert.equal(restoredState(now - 2 * H, { storage: st(String(now - 40 * 60e3)), now }), "idle");
  assert.equal(restoredState(now - 2 * H, { storage: st(String(now - 27 * 60e3)), now }), "ok");     // warn is for the running guard
  assert.equal(restoredState(now - 2 * H, { storage: st(null), now }), "ok");
  assert.equal(restoredState(null, { storage: { getItem() { throw new Error("blocked"); } }, now }), "ok");
});
