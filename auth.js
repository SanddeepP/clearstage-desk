// Sign-in with a one-time code sent to the user's email.
// Live mode: Supabase Auth (email OTP). Demo mode: code shown on screen, profile kept in this browser.
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

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
let memSession = null, memProfile = null, demoCode = null;

export function validEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e); }

export async function sendCode(email) {
  email = email.trim().toLowerCase();
  if (!validEmail(email)) throw new Error("Enter a full email address, like you@gmail.com.");
  if (LIVE) {
    const c = await client();
    const { error } = await c.auth.signInWithOtp({ email, options: { shouldCreateUser: true, emailRedirectTo: location.origin + "/" } });
    if (error) throw new Error(friendly(error));
    return { demoCode: null };
  }
  demoCode = String(Math.floor(100000 + Math.random() * 900000));
  return { demoCode };
}

export async function verifyCode(email, code) {
  email = email.trim().toLowerCase(); code = code.replace(/\D/g, "");
  if (code.length !== 6) throw new Error("The code has 6 digits.");
  if (LIVE) {
    const c = await client();
    const { data, error } = await c.auth.verifyOtp({ email, token: code, type: "email" });
    if (error) throw new Error(friendly(error));
    return { email: data.user.email, id: data.user.id };
  }
  if (code !== demoCode) throw new Error("That code doesn't match. Check it and try again, or send a new one.");
  memSession = { email, id: "demo-" + email };
  store.set("session", memSession);
  return memSession;
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
    const { data, error } = await c.from("member").select("full_name, phone, app_role, company:company_id(name, city, team_setup)").eq("user_id", user.id).maybeSingle();
    if (error) throw new Error(friendly(error));
    if (!data) return null;
    return { name: data.full_name, phone: data.phone, company: data.company.name, city: data.company.city, setup: data.company.team_setup };
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

/** Calls fn(user) when a sign-in completes elsewhere, e.g. the emailed link opened in another tab. */
export async function onSignedIn(fn) {
  if (!LIVE) return;
  const c = await client();
  c.auth.onAuthStateChange((event, session) => { if (event === "SIGNED_IN" && session) fn({ email: session.user.email, id: session.user.id }); });
}

export async function signOut() {
  if (LIVE) { const c = await client(); await c.auth.signOut(); }
  memSession = null; store.del("session");
}

function friendly(err) {
  const m = (err && err.message) || "";
  if (/rate limit|too many/i.test(m)) return "Too many codes requested. Wait a minute, then try again.";
  if (/expired|invalid/i.test(m)) return "That code is wrong or has expired. Send a new one.";
  if (/signups? not allowed|disabled/i.test(m)) return "New sign-ups are switched off for this workspace. Ask the admin to invite you.";
  if (/network|fetch/i.test(m)) return "Couldn't reach the sign-in service. Check your connection and try again.";
  return m || "Something went wrong. Try again.";
}
