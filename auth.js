// Sign-in with a 6-digit code sent to the user's email (founder decision 20 Nov: code only, no sign-in link).
// Live mode: Supabase Auth (email OTP). Demo mode: code shown on screen, profile kept in this browser.
import { SUPABASE_URL, SUPABASE_ANON_KEY, EMAIL_HAS_CODE } from "./config.js";
export { EMAIL_HAS_CODE };

export const LIVE = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
let sb = null;

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = src; s.onload = res; s.onerror = () => rej(new Error("Couldn't load the sign-in service. Check your connection and try again."));
    document.head.append(s);
  });
}

async function client() {
  if (!LIVE) return null;
  if (!sb) {
    await loadScript("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.50.0/dist/umd/supabase.min.js");
    sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: true, detectSessionInUrl: true, flowType: "implicit" } });
  }
  return sb;
}

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem("cs:" + k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem("cs:" + k, JSON.stringify(v)); } catch { /* storage blocked: demo still works for this visit */ } },
  del(k) { try { localStorage.removeItem("cs:" + k); } catch {} },
};
let memSession = null, memProfile = null, demoCode = null, lastSentAt = 0;
/** Code lifetime: matches Supabase Auth → Email OTP expiration (600 s). */
export const CODE_TTL_MS = 10 * 60e3;
/** Seconds before "Resend code" appears (Supabase keeps its own per-user cooldown too). */
export const RESEND_AFTER_S = 60;

export function validEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e); }

export async function sendCode(email) {
  email = email.trim().toLowerCase();
  if (!validEmail(email)) throw new Error("Enter a full email address, like you@gmail.com.");
  if (LIVE) {
    const c = await client();
    const { error } = await c.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
    if (error) throw new Error(friendly(error));
    lastSentAt = Date.now();
    return { demoCode: null };
  }
  demoCode = String(Math.floor(100000 + Math.random() * 900000));
  lastSentAt = Date.now();
  return { demoCode };
}

export async function verifyCode(email, code) {
  email = email.trim().toLowerCase(); code = code.replace(/\D/g, "");
  if (code.length !== 6) throw new Error("The code has 6 digits.");
  if (LIVE) {
    const c = await client();
    const { data, error } = await c.auth.verifyOtp({ email, token: code, type: "email" });
    if (error) throw new Error(codeError(error, lastSentAt));
    return { email: data.user.email, id: data.user.id };
  }
  if (demoCode && lastSentAt && Date.now() - lastSentAt > CODE_TTL_MS) throw new Error(CODE_EXPIRED);
  if (code !== demoCode) throw new Error(CODE_WRONG);
  memSession = { email, id: "demo-" + email };
  store.set("session", memSession);
  return memSession;
}

/** Calls the Desk agent Edge Function as the signed-in user. Returns the parsed JSON (throws with a plain message on errors). */
export async function callDesk(body) {
  if (!LIVE) throw new Error("The live Desk agent needs a signed-in account.");
  const c = await client();
  const { data } = await c.auth.getSession();
  if (!data.session) throw new Error("Sign in again to use the live Desk agent.");
  const r = await fetch(`${SUPABASE_URL}/functions/v1/desk`, { method: "POST",
    headers: { Authorization: `Bearer ${data.session.access_token}`, apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({ error: "Desk sent an unreadable reply" }));
  if (!r.ok || j.error) throw new Error(j.error || `Desk error ${r.status}`);
  return j;
}

export async function currentUser() {
  if (LIVE) {
    const c = await client();
    const { data } = await c.auth.getSession();
    return data.session ? { email: data.session.user.email, id: data.session.user.id } : null;
  }
  return store.get("session") || memSession;
}

export async function getProfile(user) {
  if (LIVE) {
    const c = await client();
    const { data, error } = await c.from("member").select("full_name, phone, app_role, company:company_id(name, city, team_setup, desk_enabled)").eq("user_id", user.id).maybeSingle();
    if (error) throw new Error(friendly(error));
    if (!data) return null;
    return { name: data.full_name, phone: data.phone, company: data.company.name, city: data.company.city, setup: data.company.team_setup, deskEnabled: data.company.desk_enabled === true };
  }
  return store.get("profile:" + user.email) || (memProfile && memProfile.email === user.email ? memProfile : null);
}

export async function saveProfile(user, p) {
  if (LIVE) {
    const c = await client();
    const { error } = await c.rpc("create_company_for_me", { p_company: p.company, p_city: p.city, p_full_name: p.name, p_phone: p.phone || null, p_setup: p.setup });
    if (error) throw new Error(friendly(error));
    return p;
  }
  memProfile = { ...p, email: user.email };
  store.set("profile:" + user.email, memProfile);
  return memProfile;
}

/** Calls fn(user) when a sign-in completes elsewhere (e.g. a one-time admin link, or another tab). */
export async function onSignedIn(fn) {
  if (!LIVE) return;
  const c = await client();
  c.auth.onAuthStateChange((event, session) => { if (event === "SIGNED_IN" && session) fn({ email: session.user.email, id: session.user.id }); });
}

export async function signOut() {
  if (LIVE) { const c = await client(); await c.auth.signOut(); }
  memSession = null; store.del("session");
}

export const CODE_WRONG = "That code is wrong. Check the newest email from Clearstage and try again.";
export const CODE_EXPIRED = "That code has expired. Send a new one.";
/** Supabase returns one message ("Token has expired or is invalid") for both cases, so we tell them apart by the
 *  time since the code was sent: over 10 minutes means expired, otherwise the code was mistyped or replaced. */
export function codeError(err, sentAt, now = Date.now()) {
  const m = (err && err.message) || "", c = (err && err.code) || "";
  if (/rate limit|too many/i.test(m) || c === "over_request_rate_limit") return friendly(err);
  if (/expired|invalid/i.test(m) || c === "otp_expired") return sentAt && now - sentAt > CODE_TTL_MS ? CODE_EXPIRED : CODE_WRONG;
  return friendly(err);
}

function friendly(err) {
  const m = (err && err.message) || "";
  if (/rate limit|too many/i.test(m)) return "Too many codes requested. Wait a minute, then try again.";
  if (/expired|invalid/i.test(m)) return CODE_EXPIRED;
  if (/signups? not allowed|disabled/i.test(m)) return "New sign-ups are switched off for this workspace. Ask the admin to invite you.";
  if (/network|fetch/i.test(m)) return "Couldn't reach the sign-in service. Check your connection and try again.";
  return m || "Something went wrong. Try again.";
}
