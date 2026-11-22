// SEC-1 session timeout (CTO ruling 22 Nov). Free-plan build: the browser enforces idle and maximum length;
// the database (migration 009, session_fresh) refuses any session older than 12 hours even if this code is bypassed.
// Idle 30 min (warning at 25), maximum 12 h from sign-in. Activity in any tab counts; signing out in one tab signs out all.
export const IDLE_MS = 30 * 60e3, WARN_MS = 25 * 60e3, MAX_MS = 12 * 3600e3, CHECK_MS = 30e3, ACTIVITY_WRITE_MS = 15e3;
export const MSG = {
  idle: "You were signed out after 30 minutes without activity.",
  max: "For security, sessions end after 12 hours. Sign in again with a new code.",
  elsewhere: "You were signed out in another tab.",
  warn: "You'll be signed out in 5 minutes for security.",
};
const K = { act: "cs:act", start: "cs:signin", out: "cs:signout" };

/** Pure rule: "ok" | "warn" | "idle" | "max". */
export function sessionState({ now, lastActivity, signedInAt }) {
  if (signedInAt && now - signedInAt >= MAX_MS) return "max";
  if (lastActivity && now - lastActivity >= IDLE_MS) return "idle";
  if (lastActivity && now - lastActivity >= WARN_MS) return "warn";
  return "ok";
}

/** Sign-in time from a Supabase access token: the "amr" entry's timestamp (seconds), else null. */
export function signedInAtFromToken(accessToken) {
  try {
    const p = JSON.parse(atob(accessToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    const ts = Math.min(...(p.amr || []).map(a => a.timestamp).filter(Number.isFinite));
    return Number.isFinite(ts) ? ts * 1000 : null;
  } catch { return null; }
}

/**
 * Watches activity and time. env lets tests drive it: { storage, now, setInterval, clearInterval, on(target, type, fn) }.
 * Every storage read/write is inside try/catch: with storage blocked, the timeout still runs for this tab.
 */
export function createSessionGuard({ onWarn, onClearWarn, onTimeout, env = {} }) {
  const storage = env.storage ?? (() => { try { return window.localStorage; } catch { return null; } })();
  const now = env.now ?? (() => Date.now());
  const every = env.setInterval ?? ((f, ms) => setInterval(f, ms)), stop = env.clearInterval ?? (id => clearInterval(id));
  const on = env.on ?? ((t, type, fn) => t.addEventListener(type, fn, { passive: true }));
  const mem = {};
  const get = k => { try { const v = storage?.getItem(k); if (v != null) return Number(v); } catch { /* blocked */ } return mem[k] ?? null; };
  const set = (k, v) => { mem[k] = v; try { storage?.setItem(k, String(v)); } catch { /* blocked: this tab only */ } };
  let timer = null, warned = false, lastWrite = 0, active = false;

  function check() {
    if (!active) return;
    const st = sessionState({ now: now(), lastActivity: get(K.act), signedInAt: get(K.start) });
    if (st === "idle" || st === "max") return end(st, true);
    if (st === "warn" && !warned) { warned = true; onWarn?.(); }
    if (st === "ok" && warned) { warned = false; onClearWarn?.(); }
  }
  function touch(force = false) {
    if (!active) return;
    const t = now();
    if (force || t - lastWrite >= ACTIVITY_WRITE_MS) { lastWrite = t; set(K.act, t); }
    if (warned && force) { warned = false; onClearWarn?.(); }
  }
  function end(reason, broadcast) {
    if (!active) return;
    active = false; if (timer != null) { stop(timer); timer = null; }
    if (broadcast) set(K.out, now());
    onTimeout?.(reason);
  }
  const g = {
    /** Start watching after sign-in. signedInAt: from the token, or now for a fresh sign-in. */
    start(signedInAt, { fresh = false } = {}) {
      active = true; warned = false;
      const known = get(K.start), prevAct = get(K.act);
      set(K.start, signedInAt ?? (!fresh && known ? known : now()));
      // A restored session (page reload, reopened laptop) is judged on its last real activity first.
      if (!fresh) { const st = sessionState({ now: now(), lastActivity: prevAct, signedInAt: get(K.start) }); if (st === "idle" || st === "max") return end(st, true); }
      touch(true);
      if (timer == null) timer = every(check, env.checkMs ?? CHECK_MS);
      check();
    },
    /** "Stay signed in" on the warning. */
    stay() { touch(true); },
    /** Sign out from this tab: tells the other tabs too. */
    signedOut() { end("elsewhere-origin", true); },
    stop() { active = false; if (timer != null) { stop(timer); timer = null; } },
    check, touch,
    get active() { return active; },
  };
  const target = env.target ?? (typeof window !== "undefined" ? window : null);
  if (target && !env.noListeners) {
    for (const type of ["pointerdown", "keydown", "scroll", "touchstart", "wheel"]) on(target, type, () => g.touch());
    on(target, "storage", e => {   // another tab signed out
      if (e.key === K.out && e.newValue && active) end("elsewhere", false);
    });
  }
  return g;
}
export const SESSION_KEYS = K;
