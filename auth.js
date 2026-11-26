// Sign-in with a 6-digit code sent to the user's email (founder decision 20 Nov: code only, no sign-in link).
// Live mode: Supabase Auth (email OTP). Demo mode: code shown on screen, profile kept in this browser.
import { SUPABASE_URL, SUPABASE_ANON_KEY, EMAIL_HAS_CODE } from "./config.js";
import { signedInAtFromToken } from "./lib/session.js";
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
  // One shared promise: calls made at the same moment on page load get the same client (never two clients and two sets of auth listeners)
  sb ??= loadScript("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.50.0/dist/umd/supabase.min.js").then(() =>
    window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "pkce" } }))
    .catch(e => { sb = null; throw e; });
  return sb;
}

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem("cs:" + k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem("cs:" + k, JSON.stringify(v)); } catch { /* storage blocked: demo still works for this visit */ } },
  del(k) { try { localStorage.removeItem("cs:" + k); } catch {} },
};
let memSession = null, memProfile = null, demoCode = null;
// QA-036: the send time survives a reload (sessionStorage), so "expired" vs "wrong" stays right; unknown → neutral wording.
const sentAt = {
  get() { try { return Number(sessionStorage.getItem("cs:codeSentAt")) || 0; } catch { return sentAt.mem || 0; } },
  set(v) { sentAt.mem = v; try { sessionStorage.setItem("cs:codeSentAt", String(v)); } catch { /* blocked */ } },
};
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
    sentAt.set(Date.now());
    return { demoCode: null };
  }
  demoCode = String(Math.floor(100000 + Math.random() * 900000));
  sentAt.set(Date.now());
  return { demoCode };
}

export async function verifyCode(email, code) {
  email = email.trim().toLowerCase(); code = code.replace(/\D/g, "");
  if (code.length !== 6) throw new Error("The code has 6 digits.");
  if (LIVE) {
    const c = await client();
    const { data, error } = await c.auth.verifyOtp({ email, token: code, type: "email" });
    if (error) throw new Error(codeError(error, sentAt.get()));
    return { email: data.user.email, id: data.user.id };
  }
  if (demoCode && sentAt.get() && Date.now() - sentAt.get() > CODE_TTL_MS) throw new Error(CODE_EXPIRED);
  if (code !== demoCode) throw new Error(CODE_WRONG);
  memSession = { email, id: "demo-" + email, signedInAt: Date.now() };
  store.set("session", memSession);
  return memSession;
}

/** Calls the Desk agent Edge Function as the signed-in user. Returns the parsed JSON (throws with a plain message on errors). */
/** The workspaces this user can open: their own company first, then the sample company if Clearstage granted it.
 *  Demo mode (signed-out public demo) is always the sample. */
export async function workspaces() {
  if (!LIVE) return [{ id: "sample", name: "Acme Fintech", is_sample: true }];
  const c = await client();
  const { data, error } = await c.rpc("my_workspaces");
  if (error) throw orExpired(error);
  return Array.isArray(data) ? data : [];
}
async function rpc(name, args) {
  const c = await client();
  const { data, error } = await c.rpc(name, args);
  if (error) throw new Error(friendly(error));
  return data;
}
/** Founder-only (platform admin): who may open the sample company. Never available in the public demo. */
export async function isPlatformAdmin() { if (!LIVE) return false; return (await rpc("is_platform_admin")) === true; }
export async function sampleAccessList() { return LIVE ? (await rpc("sample_access_list")) ?? [] : []; }
export async function grantSampleAccess(email) { return rpc("grant_sample_access", { p_email: email }); }
export async function revokeSampleAccess(email) { return rpc("revoke_sample_access", { p_email: email }); }
/* Module tabs (016). Demo mode (signed out): defaults, and "I need this" stays in this browser only. */
const demoInterest = () => { try { return JSON.parse(localStorage.getItem("cs:interest") || "{}"); } catch { return {}; } };
export async function myModules() { return LIVE ? rpc("my_modules") : null; }
export async function myModuleInterest() { return LIVE ? (await rpc("my_module_interest")) ?? {} : demoInterest(); }
export async function registerModuleInterest(module, note, source = "page") {
  if (LIVE) return rpc("register_module_interest", { p_module: module, p_note: note || null, p_source: source });
  const all = demoInterest(), had = all[module];
  all[module] = { created_at: had?.created_at ?? new Date().toISOString(), note: had?.note || (note || "").trim().slice(0, 200) || null, source: had?.source ?? source };
  try { localStorage.setItem("cs:interest", JSON.stringify(all)); } catch { /* blocked */ }
  return { module, ...all[module], new: !had, company: "Acme Fintech" };
}
export async function setModuleState(company, module, state) { return rpc("set_module_state", { p_company: company, p_module: module, p_state: state }); }
export async function platformCompanies() { return LIVE ? (await rpc("platform_companies")) ?? [] : []; }
export async function moduleInterestCounts() { return LIVE ? (await rpc("module_interest_counts")) ?? [] : []; }
/** G2 roles (017): the signed-in user's roles and flags, and Settings → People. Live workspaces only. */
export const ROLE_LABELS = { super_admin: "Super admin", hr: "HR", recruiter: "Recruiter", manager: "Manager" };
export async function myRoles() { return LIVE ? rpc("my_roles") : null; }
export async function companyPeople() { return LIVE ? (await rpc("company_people")) ?? [] : []; }
export async function setMemberRoles(memberId, roles, seePay, offerApprover) {
  return rpc("set_member_roles", { p_member: memberId, p_roles: roles, p_see_pay: !!seePay, p_offer_approver: !!offerApprover });
}
export async function inviteMember(name, email, roles, seePay, offerApprover) {
  return rpc("invite_member", { p_name: name, p_email: email, p_roles: roles, p_see_pay: !!seePay, p_offer_approver: !!offerApprover });
}
/* ---------- Public demo: one login per role (founder 26 Nov). Fictional people of the sample company; the code shows
   on screen as for any demo email. These logins exist only in the signed-out demo, never in the live database. ---------- */
export const DEMO_ACCOUNTS = {
  "admin@acme.demo": { name: "Rahul Kapoor", label: "Super admin", roles: ["super_admin"], see_pay: true, offer_approver: true },
  "hr@acme.demo": { name: "Meena Iyer", label: "HR", roles: ["hr"], see_pay: true, offer_approver: true },
  "recruiter@acme.demo": { name: "Ritu Sharma", label: "Recruiter", roles: ["recruiter"] },
  "manager@acme.demo": { name: "Vikram Nair", label: "Manager", roles: ["manager"], offer_approver: true },
  "employee@acme.demo": { name: "Priya Nair", label: "Employee", employee: true },
};
const PROFILE_FIELDS = { phone: "Phone", email: "Personal email", address: "Address", emergency_contact: "Emergency contact" };
const isoDay = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
function demoEmployee() {
  const base = { name: "Priya Nair", email: "priya.personal@example.com", phone: "+91 90000 33333", address: "Flat 4B, Sunrise Apartments, Madhapur, Hyderabad",
    emergency_contact: "Ravi Nair (brother), +91 90000 44444", status: "employee", title: "Customer Success Associate", manager: "Vikram Nair",
    joined_on: isoDay(-168), probation_ends_on: isoDay(12), login_email: "employee@acme.demo" };
  const reqs = store.get("demoreq") || [];
  const profile = { ...base, ...(store.get("demoprofile") || {}) };
  return { company: "Acme Fintech", profile,
    letters: [{ kind: "appointment_letter", approved_at: isoDay(-170) + "T10:30:00Z",
      body: `Dear Priya Nair,\nWe are pleased to appoint you as Customer Success Associate at Acme Fintech Pvt Ltd, Hyderabad.\nProbation: 6 months from your joining date. Your manager reviews your work before it ends, and confirmation is given in writing.\nNotice period: 15 days during probation and 30 days after confirmation.\nFor Acme Fintech Pvt Ltd,\nRahul Kapoor` }],
    tasks: [{ title: "Probation review with Vikram Nair", kind: "probation_review", status: "open", due_at: isoDay(10) + "T09:00:00Z" },
      { title: "Joining documents", kind: "joining_documents", status: "done", due_at: isoDay(-168) + "T09:00:00Z" },
      { title: "Laptop and email", kind: "it_setup", status: "done", due_at: isoDay(-168) + "T09:00:00Z" }],
    requests: reqs.map(r => ({ ...r })).reverse() };
}
function demoRequest(field, value, reason) {
  const v = String(value || "").trim(), label = PROFILE_FIELDS[field];
  if (!label) throw new Error("You can ask to change your phone, personal email, address or emergency contact");
  if (!v) throw new Error("Enter the new value");
  if (v.length > 300 || String(reason || "").length > 300) throw new Error("Keep it under 300 characters");
  if (field === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new Error("Enter a valid email address");
  if (field === "phone" && !/^\+?[0-9 ()-]{7,20}$/.test(v)) throw new Error("Enter the phone number with its country code, like +91 98480 12345");
  const cur = demoEmployee().profile[field], reqs = store.get("demoreq") || [];
  if (cur === v) throw new Error(`That's already your ${label.toLowerCase()}`);
  if (reqs.some(r => r.field === field && r.status === "pending")) throw new Error(`You already have a request for your ${label.toLowerCase()} waiting for HR`);
  const r = { id: "dr-" + Date.now(), person: "Priya Nair", field, label, old_value: cur, new_value: v, reason: String(reason || "").trim() || null, status: "pending", requested_at: new Date().toISOString() };
  store.set("demoreq", [...reqs, r]);
  return r;
}
/** 018: the Employee view (own record only) and HR's side of change requests and Employee logins. */
export async function myEmployee() { return LIVE ? rpc("my_employee") : demoEmployee(); }
export async function requestProfileChange(field, value, reason) {
  return LIVE ? rpc("request_profile_change", { p_field: field, p_new_value: value, p_reason: reason || null }) : demoRequest(field, value, reason);
}
export async function companyChangeRequests() {
  if (LIVE) return (await rpc("company_change_requests")) ?? [];
  return (store.get("demoreq") || []).slice().sort((a, b) => (a.status === "pending" ? 0 : 1) - (b.status === "pending" ? 0 : 1) || String(b.requested_at).localeCompare(a.requested_at));
}
export async function decideProfileChange(id, approve, note, byName) {
  if (LIVE) return rpc("decide_profile_change", { p_request: id, p_approve: !!approve, p_note: note || null });
  const reqs = store.get("demoreq") || [], r = reqs.find(x => x.id === id);
  if (!r) throw new Error("That request isn't in your workspace");
  if (r.status !== "pending") throw new Error(`That request was already ${r.status}`);
  if (!approve && !String(note || "").trim()) throw new Error("Add a note saying why, so they know what to do");
  Object.assign(r, { status: approve ? "approved" : "rejected", decided_at: new Date().toISOString(), note: String(note || "").trim() || null, decided_by: byName || null });
  if (approve) store.set("demoprofile", { ...(store.get("demoprofile") || {}), [r.field]: r.new_value });
  store.set("demoreq", reqs);
  return { id, status: r.status };
}
export async function companyEmployees() { return LIVE ? (await rpc("company_employees")) ?? [] : []; }
export async function inviteEmployee(personId, email) { return rpc("invite_employee", { p_person: personId, p_email: email }); }
/** QA-011: people can correct their own name. */
export async function updateMyName(user, name) {
  if (LIVE) return rpc("update_my_name", { p_name: name });
  const p = store.get("profile:" + user.email) || memProfile; if (p) { p.name = name; store.set("profile:" + user.email, p); }
  return { full_name: name };
}
export async function callDesk(body) {
  if (!LIVE) throw new Error("The live Desk agent needs a signed-in account.");
  const c = await client();
  const { data } = await c.auth.getSession();
  if (!data.session) throw new Error("Sign in again to use the live Desk agent.");
  const r = await fetch(`${SUPABASE_URL}/functions/v1/desk`, { method: "POST",
    headers: { Authorization: `Bearer ${data.session.access_token}`, apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({ error: "Desk sent an unreadable reply" }));
  if (!r.ok || j.error) { if (isSessionExpired(j.error)) throw new SessionExpiredError(); throw new Error(plainError(j.error || `Desk error ${r.status}`)); }
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

/** The signed-in user's own company (never the sample one), or null when they have none yet (setup).
 *  An expired session throws SessionExpiredError: row-level security hides every row then, and that must never
 *  read as "no company" (bug 25 Nov). A user with their own company plus sample access has two member rows,
 *  so the own company is picked through my_workspaces(), not .maybeSingle() over all memberships. */
export async function getProfile(user) {
  if (LIVE) return profileFromClient(await client(), user);
  const d = DEMO_ACCOUNTS[user.email];                   // the public demo's role logins (fictional people of Acme Fintech)
  if (d) return d.employee ? { name: d.name, employee: demoEmployee(), demoLogin: d.label }
    : { name: d.name, company: "Acme Fintech", city: "Hyderabad", setup: "solo", roles: d.roles, see_pay: !!d.see_pay, offer_approver: !!d.offer_approver, demoLogin: d.label };
  return store.get("profile:" + user.email) || (memProfile && memProfile.email === user.email ? memProfile : null);
}
/** getProfile's live half, with the Supabase client passed in (unit-tested with a fake client). */
export async function profileFromClient(c, user) {
  {
    const fresh = await c.rpc("session_fresh");
    if (fresh.error) throw orExpired(fresh.error);
    if (fresh.data !== true) throw new SessionExpiredError();
    // G2 roles: someone invited by a Super admin joins that company the first time they sign in (no-op otherwise)
    const claim = await c.rpc("claim_my_invite");
    if (claim.error) throw orExpired(claim.error);
    const ws = await c.rpc("my_workspaces");
    if (ws.error) throw orExpired(ws.error);
    const own = (Array.isArray(ws.data) ? ws.data : []).find(w => !w.is_sample);
    if (!own) {
      // 018: an Employee login is never a member; it opens the Employee view with the person's own record only
      const emp = await c.rpc("my_employee");
      if (emp.error) throw orExpired(emp.error);
      return emp.data ? { name: emp.data.profile?.name, employee: emp.data } : null;
    }
    const { data, error } = await c.from("member").select("full_name, phone, app_role, company:company_id(id, name, city, team_setup, desk_enabled)")
      .eq("user_id", user.id).eq("company_id", own.id).maybeSingle();
    if (error) throw orExpired(error);
    if (!data) throw new SessionExpiredError();             // listed a moment ago, hidden now: the session just went stale
    return { name: data.full_name, phone: data.phone, company: data.company.name, companyId: data.company.id, city: data.company.city,
      setup: data.company.team_setup, deskEnabled: data.company.desk_enabled === true };
  }
}

export async function saveProfile(user, p) {
  if (LIVE) {
    const c = await client();
    const { error } = await c.rpc("create_company_for_me", { p_company: p.company, p_city: p.city, p_full_name: p.name, p_phone: p.phone || null, p_setup: p.setup,
      p_country: p.country, p_region: p.region || null, p_timezone: p.timezone });
    if (error) throw orExpired(error);
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

/** SEC-1: scope "local" ends this browser's session; "global" ends every session for this user (Settings). */
export async function signOut(scope = "local") {
  try { if (LIVE) { const c = await client(); await c.auth.signOut({ scope }); } }
  finally { memSession = null; store.del("session"); }
}
/** When this session started (ms): the token's sign-in time in live mode, the stored time in demo mode. */
export async function sessionSignedInAt() {
  if (LIVE) { const c = await client(); const { data } = await c.auth.getSession(); return data?.session ? signedInAtFromToken(data.session.access_token) : null; }
  return (memSession ?? store.get("session"))?.signedInAt ?? null;
}
/** Calls fn() when Supabase reports a sign-out (it also hears other tabs). */
export async function onSignedOut(fn) {
  if (!LIVE) return;
  const c = await client();
  c.auth.onAuthStateChange(event => { if (event === "SIGNED_OUT") fn(); });
}

/** The database refuses sessions over 12 hours (009/010): "Your session has expired. Sign in again." (SQLSTATE 28000). */
export const SESSION_EXPIRED = "Your session has expired. Sign in again.";
export class SessionExpiredError extends Error { constructor() { super(SESSION_EXPIRED); this.name = "SessionExpiredError"; } }
export const isSessionExpired = e => e instanceof SessionExpiredError || e?.code === "28000" || /session has expired/i.test(String(e?.message ?? e ?? ""));
const orExpired = e => (isSessionExpired(e) ? new SessionExpiredError() : new Error(friendly(e)));
export const CODE_WRONG = "That code is wrong. Check the newest email from Clearstage and try again.";
export const CODE_EXPIRED = "That code has expired. Send a new one.";
export const CODE_UNKNOWN = "That code is wrong or has expired. Send a new one.";
/** Supabase returns one message ("Token has expired or is invalid") for both cases, so we tell them apart by the
 *  time since the code was sent: over 10 minutes means expired, otherwise the code was mistyped or replaced. */
export function codeError(err, sentAt, now = Date.now()) {
  const m = (err && err.message) || "", c = (err && err.code) || "";
  if (/rate limit|too many/i.test(m) || c === "over_request_rate_limit") return friendly(err);
  if (/expired|invalid/i.test(m) || c === "otp_expired") return !sentAt ? CODE_UNKNOWN : now - sentAt > CODE_TTL_MS ? CODE_EXPIRED : CODE_WRONG;
  return friendly(err);
}

/** QA-040: database internals never reach the screen; our own plain refusals pass through. */
export function plainError(m) {
  m = String(m || "").replace(/^.*?ERROR:\s*/, "").trim();
  if (/row-level security|permission denied|insufficient privilege/i.test(m)) return "You don't have access to that. Nothing was changed.";
  if (/violates (check|foreign key|not-null|unique) constraint|duplicate key|new row for relation|invalid input syntax|syntax error|relation .* does not exist|function .* does not exist|null value in column|value too long|out of range/i.test(m))
    return "That couldn't be saved. Nothing was changed. Try again, or ask your Super admin if it keeps happening.";
  return m || "Something went wrong. Nothing was changed.";
}
function friendly(err) {
  const m = (err && err.message) || "";
  if (isSessionExpired(err)) return SESSION_EXPIRED;          // before the code-expired wording below
  const wait = m.match(/only request this after (\d+) seconds?/i);   // Supabase's 60-second resend cooldown
  if (wait) return `We just sent you a code. Use that one, or ask for a new code in ${wait[1]} seconds.`;
  // QA-040: no raw database text on screen
  if (/row-level security|permission denied|insufficient privilege/i.test(m)) return "You don't have access to that. Nothing was changed.";
  if (/violates (check|foreign key|not-null|unique) constraint|duplicate key|new row for relation|invalid input syntax|syntax error|relation .* does not exist|function .* does not exist|null value in column|value too long|out of range/i.test(m))
    return "That couldn't be saved. Nothing was changed. Try again, or ask your Super admin if it keeps happening.";
  if (/rate limit|too many/i.test(m)) return "Too many codes requested. Wait a minute, then try again.";
  if (/expired|invalid/i.test(m)) return CODE_EXPIRED;
  if (/signups? not allowed|disabled/i.test(m)) return "New sign-ups are switched off for this workspace. Ask the admin to invite you.";
  if (/network|fetch/i.test(m)) return "Couldn't reach the sign-in service. Check your connection and try again.";
  return m || "Something went wrong. Try again.";
}
