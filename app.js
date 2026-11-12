import * as auth from "./auth.js";
import { checkWagesRule, fixStructure, formatINR } from "./lib/ctc.js";
import { parseHire, fmtBudget } from "./lib/intent.js";

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
const screens = ["s-email", "s-code", "s-setup", "s-app"];
function show(id) { screens.forEach(s => { $("#" + s).hidden = s !== id; }); }
function err(el, msg) { const e = $(el); e.textContent = msg || ""; e.hidden = !msg; }
function busy(btn, on, label) { btn.disabled = on; if (label) btn.textContent = label; }

/* =================== SIGN IN =================== */
let pendingEmail = "", user = null, profile = null, resendTimer = null;

$("#modeNote").textContent = auth.LIVE
  ? "Can't find the email? Check Spam or Gmail's Updates tab."
  : "Demo mode: email sending isn't connected yet, so your code appears on the next screen.";
if (auth.LIVE) {
  document.querySelector("#emailForm .lead").textContent = auth.EMAIL_HAS_CODE ? "We'll email you a sign-in link and a 6-digit code. No password needed." : "We'll email you a sign-in link. No password needed.";
  $("#sendBtn").textContent = auth.EMAIL_HAS_CODE ? "Email me a sign-in code" : "Email me a sign-in link";
  auth.onSignedIn(async u => { if (!$("#s-app").hidden || !$("#s-setup").hidden) return; user = u; await afterSignIn(); });
}

$("#emailForm").addEventListener("submit", async e => {
  e.preventDefault(); err("#emailErr");
  const btn = $("#sendBtn"); busy(btn, true, "Sending…");
  try {
    const r = await auth.sendCode($("#email").value);
    pendingEmail = $("#email").value.trim().toLowerCase();
    $("#sentTo").textContent = pendingEmail;
    const d = $("#demoCode");
    d.hidden = !r.demoCode;
    if (r.demoCode) d.innerHTML = `Demo mode: in the live version this code goes to your inbox. Your code is <b>${r.demoCode}</b>`;
    $("#code").value = ""; err("#codeErr");
    if (auth.LIVE) {
      const linkOnly = !auth.EMAIL_HAS_CODE;
      $("#s-code h1").textContent = linkOnly ? "Click the link in your email" : "Check your email";
      $("#s-code .lead").innerHTML = linkOnly
        ? `We sent a sign-in link to <b>${esc(pendingEmail)}</b>. Open it in this browser and Clearstage opens, signed in. You can leave this page open.`
        : `Enter the 6-digit code we sent to <b>${esc(pendingEmail)}</b>, or click the link in the same email.`;
      $("#codeField").hidden = linkOnly; $("#verifyBtn").hidden = linkOnly;
    }
    show("s-code"); $("#code").focus(); startResend();
  } catch (x) { err("#emailErr", x.message); }
  finally { busy(btn, false, auth.LIVE ? (auth.EMAIL_HAS_CODE ? "Email me a sign-in code" : "Email me a sign-in link") : "Send code"); }
});

function startResend() {
  const b = $("#resend"); let n = 30; b.disabled = true; b.textContent = `Resend code in ${n}s`;
  clearInterval(resendTimer);
  resendTimer = setInterval(() => { n--; if (n <= 0) { clearInterval(resendTimer); b.disabled = false; b.textContent = "Resend code"; } else b.textContent = `Resend code in ${n}s`; }, 1000);
}
$("#resend").addEventListener("click", async () => {
  try { const r = await auth.sendCode(pendingEmail); if (r.demoCode) $("#demoCode").innerHTML = `Demo mode: your new code is <b>${r.demoCode}</b>`; err("#codeErr"); startResend(); }
  catch (x) { err("#codeErr", x.message); }
});
$("#changeEmail").addEventListener("click", () => { show("s-email"); $("#email").focus(); });
// Code box: digits only, cursor always at the end (a cursor jumping mid-box scrambled codes in testing)
const codeEl = $("#code");
const caretEnd = () => { const n = codeEl.value.length; try { codeEl.setSelectionRange(n, n); } catch {} };
["click", "focus", "keyup", "select"].forEach(ev => codeEl.addEventListener(ev, () => requestAnimationFrame(caretEnd)));
codeEl.addEventListener("input", () => {
  const clean = codeEl.value.replace(/\D/g, "").slice(0, 6);
  if (clean !== codeEl.value) codeEl.value = clean;
  caretEnd();
  if (clean.length === 6 && !$("#verifyBtn").disabled) $("#codeForm").requestSubmit();
});

$("#codeForm").addEventListener("submit", async e => {
  e.preventDefault(); err("#codeErr");
  const btn = $("#verifyBtn"); busy(btn, true, "Checking…");
  try { user = await auth.verifyCode(pendingEmail, $("#code").value); await afterSignIn(); }
  catch (x) { err("#codeErr", x.message); }
  finally { busy(btn, false, "Verify and continue"); }
});

async function afterSignIn() {
  profile = await auth.getProfile(user);
  if (!profile) { show("s-setup"); $("#fullName").focus(); return; }
  openApp();
}

$("#setupForm").addEventListener("submit", async e => {
  e.preventDefault(); err("#setupErr");
  const name = $("#fullName").value.trim().split(/\s+/).map(cap).join(" "), company = $("#company").value.trim();
  const phone = $("#phone").value.replace(/[\s-]/g, "");
  if (!name || !company) return err("#setupErr", "Add your first name and company name.");
  if (phone && !/^\+?\d{10,13}$/.test(phone)) return err("#setupErr", "Enter the WhatsApp number with country code, like +91 98765 43210.");
  const p = { name, company, city: $("#city").value.trim(), phone: phone ? (phone.startsWith("+") ? phone : "+91" + phone.slice(-10)) : "", setup: document.querySelector("input[name=setup]:checked").value };
  const btn = $("#setupBtn"); busy(btn, true, "Setting up…");
  try { profile = await auth.saveProfile(user, p); openApp(); }
  catch (x) { err("#setupErr", x.message); }
  finally { busy(btn, false, "Open Desk"); }
});

$("#signOut").addEventListener("click", async () => { await auth.signOut(); user = null; profile = null; $("#email").value = ""; show("s-email"); });

/* =================== DATA (one source for chat, Check views and strip) =================== */
// Preview data mirrors supabase/seed.sql. Demo "today" is Wed 11 Nov 2026.

let D, uid = 100;
const id = () => ++uid;
function seed() {
  const roles = [
    { id: 1, title: "Backend Developer", city: "Hyderabad", openings: 1, days: 21, budget: "₹10–14 L", status: "Open" },
    { id: 2, title: "Operations Analyst", city: "Hyderabad", openings: 1, days: 14, budget: "₹5–7 L", status: "Open" },
    { id: 3, title: "Customer Success Associate", city: "Hyderabad", openings: 1, days: 9, budget: "₹4.5–6 L", status: "Open" },
  ];
  const people = [];
  const cand = (name, role, stage, where, extra = {}) => people.push({ id: id(), name, type: "Candidate", role, stage, where, owner: "hr", ...extra });
  ["Farah K.", "Dev P.", "Aditya N.", "Bhavna S.", "Chetan R.", "Divya M.", "Eshan G.", "Gauri T.", "Harsh V.", "Isha B.", "Jayant L.", "Kavita P."].forEach(n => cand(n, 1, "Applied", "New application"));
  ["Neha J.", "Rohan M.", "Sana Q.", "Tushar A.", "Uma D."].forEach(n => cand(n, 1, "Screened", "Screen call done"));
  cand("Ankit Verma", 1, "Interview", "Feedback late (Arjun Mehta)", { late: true });
  cand("Lakshmi R.", 1, "Interview", "Feedback late (Arjun Mehta)", { late: true });
  cand("Sameer T.", 1, "Interview", "Round 1 on Fri 13 Nov");
  cand("Kiran S.", 1, "Offer", "Offer to build (₹12 L)");
  [["Megha D.", 48], ["Imran S.", 52], ["Tarun B.", 41], ["Pooja N.", 55]].forEach(([n, s]) => cand(n, 2, "Screened", `Excel test ${s}% (below 60%)`, { score: s, failed: true }));
  ["Rhea K.", "Vivek J."].forEach(n => cand(n, 2, "Applied", "New application"));
  ["Nisha P.", "Omkar S.", "Prerna V."].forEach(n => cand(n, 3, "Applied", "New application"));
  cand("Arjun Rao", 3, "Screened", "Screen call done");
  people.push({ id: id(), name: "Sneha Rao", type: "Joiner", roleTitle: "Product Designer", where: "Joins Mon 16 Nov", owner: "hr", day1: "Mon 16 Nov",
    checklist: [{ t: "Documents uploaded", done: true }, { t: "Appointment letter", done: false }, { t: "Laptop and email", done: false }, { t: "Day 1 plan and buddy", done: true }] });
  people.push({ id: id(), name: "Priya Nair", type: "Employee", roleTitle: "Customer Success Associate", where: "Probation ends 23 Nov", owner: "hr",
    probation: { ends: "Mon 23 Nov", manager: "Vikram", status: "Review due" } });
  const tasks = [
    { id: id(), key: "chase", title: "Arjun Mehta hasn't given feedback on 2 candidates", ctx: "Backend Developer · 26 hours overdue · escalates to Vikram at 4 pm", owner: "Arjun Mehta", when: "Late", done: false },
    { id: id(), key: "letter", title: "Sneha joins Monday with no appointment letter", ctx: "Every joiner needs one before Day 1", owner: "hr", when: "Late", done: false },
    { id: id(), key: "offer", title: "Build Kiran's offer", ctx: "Backend Developer · ₹12 L · structure needs the 50% wages check", owner: "hr", when: "Today", done: false },
    { id: id(), key: "probation", title: "Start Priya's probation review", ctx: "Probation ends Mon 23 Nov · manager review is due before then", owner: "hr", when: "This week", done: false },
    { id: id(), key: "bulk", title: "Send rejection notes to 4 Operations Analyst candidates", ctx: "Below 60% on the Excel test · job-relevant reason drafted", owner: "hr", when: "This week", done: false },
    { id: id(), key: "laptop", title: "Laptop and email for Sneha", ctx: "Needed before Mon 16 Nov", owner: "Suresh (IT)", when: "This week", done: false },
  ];
  const interviews = [
    { id: id(), when: "Yesterday · 3:00 PM", cand: "Ankit Verma", role: 1, round: "Round 1", panel: "Arjun Mehta" },
    { id: id(), when: "Yesterday · 4:30 PM", cand: "Lakshmi R.", role: 1, round: "Round 1", panel: "Arjun Mehta" },
    { id: id(), when: "Today · 4:00 PM", cand: "Arjun Rao", role: 3, round: "Screen call", panel: "Ritu", confirmed: false },
    { id: id(), when: "Fri 13 Nov · 11:30 AM", cand: "Sameer T.", role: 1, round: "Round 1", panel: "Arjun Mehta, Vikram", confirmed: true },
  ];
  return { roles, people, tasks, interviews, pending: [], audit: [], done: {} };
}
const roleOf = rid => D.roles.find(r => r.id === rid);
const WHEN_ORDER = { Late: 0, Today: 1, "This week": 2, Done: 3 };
function counts() {
  const openTasks = D.tasks.filter(t => !t.done).sort((a, b) => WHEN_ORDER[a.when] - WHEN_ORDER[b.when]);
  const activeCands = D.people.filter(p => p.type === "Candidate" && p.stage !== "Rejected" && p.stage !== "Hired");
  return {
    openTasks, lateTasks: openTasks.filter(t => t.when === "Late"),
    activeCands, people: D.people.length,
    openRoles: D.roles.filter(r => r.status === "Open").length,
    joiners: D.people.filter(p => p.type === "Joiner"),
    probDue: D.people.filter(p => p.probation && !["Confirmed", "Extended"].includes(p.probation.status) && !/^Scheduled/.test(p.probation.status)),
  };
}
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const person = name => D.people.find(p => p.name === name);
const task = key => D.tasks.find(t => t.key === key);
function closeTask(key) { const t = task(key); if (t && !t.done) { t.done = true; t.when = "Done"; } }
function stageCounts(rid) { const c = { Applied: 0, Screened: 0, Interview: 0, Offer: 0 }; D.people.forEach(p => { if (p.role === rid && c[p.stage] !== undefined) c[p.stage]++; }); return c; }

/* =================== DESK =================== */
const inner = $("#inner"), log = $("#log"), ph = $("#ph"), chipsEl = $("#chips");
let mode = "solo", currentTab = "desk";
const TABS = ["overview", "desk", "today", "hiring", "people", "interviews", "joiners", "approvals", "insights", "integrations", "settings"];
const cap = w => w ? w.charAt(0).toUpperCase() + w.slice(1) : w;
const first = () => cap((profile?.name || "there").trim().split(/\s+/)[0]);
const phoneLabel = () => profile?.phone ? `you · ${profile.phone}` : "you";
const ownerName = o => o === "hr" ? (mode === "solo" ? "You" : "Ritu") : o === "lead" ? `${first()} (you)` : o;

function openApp() {
  $("#coLine").textContent = "Acme Fintech · 42 people · Hyderabad · sample data";
  init(profile.setup === "lead_juniors" ? "lead" : "solo");
  show("s-app"); showTab();
}
function init(m) {
  if (m) mode = m;
  D = seed();
  inner.innerHTML = ""; ph.innerHTML = '<div class="empty">Messages Desk sends appear here.</div>';
  paint(); brief();
}

function paint() {
  const c = counts();
  set("#t-roles", c.openRoles); set("#t-late", c.lateTasks.length); set("#t-join", c.joiners.length); set("#t-prob", c.probDue.length); set("#t-queue", D.pending.length);
  $("#t-late").classList.toggle("late", c.lateTasks.length > 0);
  $("#t-queue").hidden = mode !== "lead";
  $("#who").textContent = mode === "solo" ? `You: ${first()} (HR & hiring)` : `Acting as Ritu (junior) · ${first()} approves`;
  $("#m-solo").setAttribute("aria-pressed", mode === "solo"); $("#m-lead").setAttribute("aria-pressed", mode === "lead");
  const badge = (sel, n, label, hot) => { const el = $(sel); el.textContent = n || ""; el.title = n ? label : ""; el.setAttribute("aria-label", n ? label : ""); el.classList.toggle("hot", !!hot); };
  badge("#n-today", c.openTasks.length, plural(c.openTasks.length, "open task") + `, ${c.lateTasks.length} late`, c.lateTasks.length > 0);
  badge("#n-hiring", c.openRoles, plural(c.openRoles, "open role"));
  badge("#n-people", c.activeCands.length, plural(c.activeCands.length, "active candidate"));
  badge("#n-joiners", c.joiners.length + c.probDue.length, `${plural(c.joiners.length, "joiner")}, ${plural(c.probDue.length, "probation review")} due`);
  const ivLate = D.interviews.filter(i => person(i.cand)?.late).length;
  badge("#n-interviews", D.interviews.length, plural(D.interviews.length, "interview") + (ivLate ? `, ${ivLate} with late feedback` : ""), ivLate > 0);
  badge("#n-approvals", D.pending.length, plural(D.pending.length, "approval") + " waiting", D.pending.length > 0);
  if (currentTab !== "desk") renderTab();
}
function set(sel, v) { const el = $(sel), b = el.querySelector("b"); if (b.textContent !== String(v)) { b.textContent = v; el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash"); } }
const scroll = () => { log.scrollTop = log.scrollHeight; };
let chipTimer;
function me(t) { chipsEl.innerHTML = ""; clearTimeout(chipTimer); chipTimer = setTimeout(() => { if (!chipsEl.children.length) defaults(); }, 1500); const d = document.createElement("div"); d.className = "msg me"; d.innerHTML = `<div class="bubble">${esc(t)}</div>`; inner.append(d); scroll(); }
function desk(html) { const d = document.createElement("div"); d.className = "msg"; d.innerHTML = `<div class="av" aria-hidden="true">D</div><div class="mbody">${html}</div>`; inner.append(d); bind(d); scroll(); return d; }
const later = (fn, ms = 450) => setTimeout(fn, ms);
const say = t => desk(`<div class="bubble">${t}</div>`);
function chips(list) { chipsEl.innerHTML = ""; list.forEach(([label, fn]) => { const b = document.createElement("button"); b.type = "button"; b.className = "chip"; b.textContent = label; b.onclick = () => { me(label); fn(); }; chipsEl.append(b); }); }
const ACT = {};
function bind(root) { root.querySelectorAll("[data-a]").forEach(b => b.onclick = () => { if (b.dataset.once !== undefined) b.disabled = true; ACT[b.dataset.a](b); }); }

function wa(to, text, acts) {
  if (ph.querySelector(".empty")) ph.innerHTML = "";
  const d = document.createElement("div"); d.className = "wam";
  d.innerHTML = `<div class="to">To ${esc(to)}</div>${text}` + (acts ? `<div class="acts">${acts.map((a, i) => `<button type="button" data-i="${i}">${esc(a[0])}</button>`).join("")}</div>` : "");
  ph.append(d); ph.scrollTop = ph.scrollHeight;
  if (acts) d.querySelectorAll("button").forEach(b => b.onclick = () => { d.querySelectorAll("button").forEach(x => x.disabled = true); const a = acts[b.dataset.i]; reply(a[0]); a[1](); });
  if (matchMedia("(max-width:1000px)").matches) $("#waToggle").textContent = "WhatsApp •";
  return d;
}
function reply(t) { const d = document.createElement("div"); d.className = "wam out"; d.textContent = t; ph.append(d); ph.scrollTop = ph.scrollHeight; }

function defaults() {
  chips([["What's on today?", brief], ["Chase Arjun", () => route("Chase Arjun")], ["Draft Sneha's letter", letter], ["Show my pipeline", pipeline], ["Ek data analyst chahiye Bangalore mein, 8-10L", () => hireFrom("Ek data analyst chahiye Bangalore mein, 8-10L")],
    ["Reject candidates who failed the test", bulk], ["Start Priya's probation review", probation], ["Wrap up my day", wrap]]);
}

// Pencil & Ink: AI output is a draft until a named person approves it. Every approval is logged.
function logApproval(what, by) { D.audit.push({ what, by, at: new Date() }); }
function approve(btn, what, after) {
  btn.closest(".card")?.querySelectorAll("button").forEach(x => x.disabled = true);
  if (mode === "solo") { logApproval(what, first()); after(); paint(); return; }
  const item = { id: id(), what };
  const t = { id: item.id, key: "approval:" + item.id, title: `Approve ${what}`, ctx: "Drafted by Ritu · goes out once approved", owner: "lead", when: "Today", done: false };
  D.tasks.unshift(t);
  item.resolve = (ok, via) => {
    if (!D.pending.includes(item)) return;
    D.pending = D.pending.filter(x => x !== item); closeTask(t.key);
    item.waNode?.querySelectorAll("button").forEach(x => x.disabled = true);
    item.card?.querySelectorAll("button").forEach(x => x.disabled = true);
    if (ok) { logApproval(what, first()); say(`<span class="pill p-ok">Approved by ${esc(first())}${via ? " " + via : ""}</span>`); after(); }
    else say(`${esc(first())} sent it back: <i>"Add the joining bonus clause."</i> I've reopened the draft.`);
    paint();
  };
  D.pending.push(item); paint();
  say(`Sent <b>${esc(what)}</b> to ${esc(first())} for approval, in the app and on WhatsApp. It goes out once approved.`);
  item.waNode = wa(phoneLabel(), `Ritu drafted <b>${esc(what)}</b>. Approve it?`, [["Approve", () => item.resolve(true, "on WhatsApp")], ["Send back with a comment", () => item.resolve(false)]]);
}
function reviewPending(pid) {
  const item = D.pending.find(x => x.id === pid); if (!item) return say("That approval is already done.");
  const d = desk(`<div class="card draft"><h4><span class="kind">Approval</span>${esc(item.what)} <span class="pill p-warn">Waiting for you</span></h4><div class="c">
    <div class="why">Drafted by Ritu. Approving sends it and logs your name.</div>
    <div class="row"><button class="btn primary" type="button" data-pa="1">Approve &amp; send</button><button class="btn" type="button" data-pa="0">Send back</button></div></div></div>`);
  item.card = d;
  d.querySelectorAll("[data-pa]").forEach(b => b.onclick = () => item.resolve(b.dataset.pa === "1", "in the app"));
}

function brief() {
  const h = new Date().getHours(), hi = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  const c = counts(), open = c.openTasks;
  const pill = w => w === "Late" ? "p-late" : w === "Today" ? "p-warn" : "p-acc";
  desk(`<div class="bubble">${hi}, ${esc(first())}. Here's your HR for today. About 15 minutes of work.</div>
  <div class="card"><h4><span class="kind">Brief · ${plural(open.length, "open task")}</span>${c.lateTasks.length ? `<span class="pill p-late">${c.lateTasks.length} late</span>` : '<span class="pill p-ok">Nothing late</span>'}</h4>
   ${open.length ? open.map(t => `<div class="item"><span class="pill ${pill(t.when)}">${esc(t.when === "This week" ? "Due soon" : t.when)}</span><div class="t">${esc(t.title)}<small>${esc(t.ctx)}</small></div><button class="btn primary" type="button" data-a="doTask" data-key="${esc(t.key)}">Do it</button></div>`).join("") : '<div class="item"><div class="t">All clear for today.</div></div>'}
  </div>`);
  defaults();
}
ACT.doTask = b => runTask(b.dataset.key, true);
function runTask(key, echo) {
  const t = task(key); if (!t) return;
  if (t.done) return say(`"${esc(t.title)}" is already done.`);
  if (key.startsWith("approval:")) { if (echo) me(t.title); return mode === "lead" ? reviewPending(Number(key.split(":")[1])) : say("Approvals go straight out in Solo setup."); }
  const map = { chase: ["Chase Arjun Mehta", chase], letter: ["Draft Sneha's letter", letter], offer: ["Build Kiran's offer", offer], probation: ["Start Priya's probation review", probation], bulk: ["Reject candidates who failed the test", bulk],
    laptop: ["Remind Suresh about Sneha's laptop", remindIT], kiranLetter: ["Draft Kiran's appointment letter", kiranLetter], kiranLaptop: ["Remind Suresh about Kiran's laptop", remindIT] };
  const m = map[key]; if (!m) return say("I can't do that one yet in this preview.");
  if (echo) me(m[0]); m[1]();
}

function chase() {
  if (D.done.chase) return say("Already chased. I'll escalate to Vikram at 4 pm if Arjun stays silent.");
  D.done.chase = 1; task("chase").ctx = "Nudged on WhatsApp · escalates to Vikram at 4 pm"; paint();
  later(() => {
    say(`Done. I sent Arjun Mehta a WhatsApp nudge with one-tap scoring. If he doesn't reply, I'll escalate to Vikram (Head of Engineering) at 4 pm.<div class="why" style="margin-top:6px">Why it matters: candidates who wait more than 3 days for an update often take another offer.</div>`);
    wa("Arjun Mehta (interviewer)", "Feedback pending for <b>Ankit Verma</b> and <b>Lakshmi R.</b>, Backend Developer, interviewed yesterday. Reply with a score, or tap:",
      [["Ankit: 4/5, strong APIs, weak SQL. Next round.", feedback], ["Ankit: 2/5, not a fit", feedbackNo]]);
    chips([["Show my pipeline", pipeline], ["Draft Sneha's letter", letter]]);
  });
}
function feedbackIn() { closeTask("chase"); ["Ankit Verma", "Lakshmi R."].forEach(n => { const p = person(n); p.late = false; p.where = "Feedback in"; }); }
function feedback() {
  feedbackIn(); paint();
  desk(`<div class="bubble">Arjun replied on WhatsApp. I turned it into a scorecard:</div>
  <div class="card"><h4><span class="kind">Scorecard</span>Ankit Verma · Backend Developer <span class="pill p-ok">Feedback in</span></h4><div class="c">
  <table><tr><th>Criterion</th><th>Score</th></tr><tr><td>API design</td><td>4 / 5</td></tr><tr><td>SQL</td><td>2 / 5</td></tr><tr><td>Overall</td><td>4 / 5</td></tr></table>
  <div class="row"><span class="note">Arjun recommends: next round</span><span class="spacer"></span><button class="btn" type="button" data-a="rejectOne">Reject with reason</button><button class="btn primary" type="button" data-a="advance" data-once>Move to Round 2</button></div></div></div>`);
}
function feedbackNo() { feedbackIn(); person("Ankit Verma").where = "Scored 2/5"; paint(); say("Arjun scored Ankit 2/5, not a fit. Want me to draft a rejection with a job-relevant reason?"); chips([["Yes, draft it", () => reasonPicker("Ankit Verma")]]); }
ACT.advance = b => {
  const p = person("Ankit Verma"), prev = p.where; p.where = "Round 2 with Head of Engineering"; paint();
  const d = say(`Moved Ankit to Round 2 and drafted his update: <i>"Round 2 with the Head of Engineering. You'll hear from us by Thu 19 Nov."</i> <span class="undo">· <button class="link" type="button">Undo</button> (10 min)</span>`);
  const t = setTimeout(() => d.querySelector(".undo")?.remove(), 10 * 60 * 1000);
  d.querySelector(".undo button").onclick = () => { clearTimeout(t); d.querySelector(".undo").remove(); b.disabled = false; p.where = prev; paint(); say("Undone. Ankit is back where he was and no update was sent."); };
};
ACT.rejectOne = () => reasonPicker("Ankit Verma");

const REASONS = [["skills_gap", "Skills don't match the role's must-haves"], ["assessment_below_bar", "Assessment score below the bar"], ["experience_mismatch", "Experience level doesn't match"],
  ["salary_mismatch", "Salary expectation outside the budget"], ["location_mismatch", "Location or work mode doesn't fit"], ["notice_period", "Notice period too long"], ["role_filled", "Role has been filled"]];
function reasonPicker(name) {
  desk(`<div class="card draft" data-name="${esc(name)}"><h4><span class="kind">Rejection</span>${esc(name)}</h4><div class="c">
   <label class="field" for="rr${uid}">Reason (job-relevant only)<select id="rr${uid}">${REASONS.map(r => `<option value="${r[0]}">${r[1]}</option>`).join("")}</select></label>
   <div class="why">Reasons come from a fixed list. Text about age, gender, marital status, religion, caste or pregnancy is blocked.</div>
   <div class="row"><button class="btn primary" type="button" data-a="sendReject">Approve &amp; send</button><button class="btn" type="button" data-a="rejectDraft">Cancel</button></div></div></div>`);
}
ACT.sendReject = b => {
  const card = b.closest(".card"), r = card.querySelector("select"), label = r.options[r.selectedIndex].text, name = card.dataset.name;
  approve(b, `a rejection note to ${name} (${label.toLowerCase()})`, () => { const p = person(name); if (p) { p.stage = "Rejected"; p.where = `Rejected: ${label.toLowerCase()}`; } say(`Sent. ${esc(name)}'s status page is closed with that reason.`); });
};

function letter() {
  if (D.done.letter) return say("Sneha's letter is already handled.");
  D.done.letter = 1;
  later(() => desk(`<div class="bubble">Here's Sneha's appointment letter, filled from her accepted offer.</div>
  <div class="card draft"><h4><span class="kind">Approval</span>Appointment letter · Sneha Rao <span class="pill p-acc">Draft</span></h4><div class="c">
  <div class="doc">Dear Sneha,
We are pleased to appoint you as Product Designer at Acme Fintech Pvt Ltd, effective Mon 16 Nov 2026.
CTC: ₹9,60,000 per year (breakdown in Annexure A). Probation: 6 months.
Notice period: 30 days after confirmation …</div>
  <div class="why">Filled from the offer approved on 2 Nov. Template from the Clearstage playbook. Not legal advice.</div>
  <div class="row"><button class="btn primary" type="button" data-a="sendLetter">Approve &amp; send</button><button class="btn" type="button" data-a="noop">Edit</button><button class="btn" type="button" data-a="rejectDraft">Reject</button></div></div></div>`));
}
ACT.noop = () => say("Editing drafts isn't in this preview yet. In the full product this opens the draft for editing.");
ACT.rejectDraft = b => { b.closest(".card").querySelectorAll("button").forEach(x => x.disabled = true); say("Draft discarded. Nothing was sent."); };
ACT.sendLetter = b => approve(b, "Sneha's appointment letter", () => {
  closeTask("letter"); const s = person("Sneha Rao"); s.checklist[1].done = true;
  say("Sent to Sneha for e-acknowledgement. Her joiner checklist is on track for Monday.");
});
function remindIT() {
  const kiran = !task("laptop") || task("laptop").done ? true : false;
  const who = task("laptop") && !task("laptop").done ? "Sneha" : "Kiran";
  say(`I sent Suresh (IT) a WhatsApp reminder for ${who}'s laptop and email.`);
  wa("Suresh (IT)", `Reminder: laptop and email for <b>${who}</b> before Day 1.`, [["Done, ready", () => {
    closeTask(who === "Sneha" ? "laptop" : "kiranLaptop");
    const p = person(who === "Sneha" ? "Sneha Rao" : "Kiran S."); const c = p.checklist?.find(x => x.t === "Laptop and email"); if (c) c.done = true;
    paint(); say(`Suresh confirmed ${who}'s laptop and email are ready.`);
  }]]);
  void kiran;
}

/* ----- hiring: create a role from what the user actually said ----- */
let draftRole = null;
function hireFrom(text) {
  const r = parseHire(text);
  if (!r) return honest();
  draftRole = { title: r.title, count: r.count, countStated: r.countStated, city: r.city, budget: r.budget, exp: r.exp, start: r.start };
  later(askRoleGaps);
}
function askRoleGaps() {
  const d = draftRole;
  const parts = [`${d.count} × ${esc(d.title)}`, d.city ? esc(d.city) : null, d.budget ? fmtBudget(d.budget) : null, d.exp ? esc(d.exp) : null, d.start != null ? startLabel(d.start) : null].filter(Boolean).join(", ");
  if (!d.city) { say(`Got it: <b>${parts}</b>. Which city?`); return chips([["Hyderabad", () => fill("city", "Hyderabad")], ["Bengaluru", () => fill("city", "Bengaluru")], ["Pune", () => fill("city", "Pune")], ["Remote", () => fill("city", "Remote")]]); }
  if (!d.budget) { say(`Got it: <b>${parts}</b>. What's the CTC budget per person?`); return chips([["₹4–6 L", () => fill("budget", { min: 4, max: 6 })], ["₹6–10 L", () => fill("budget", { min: 6, max: 10 })], ["₹10–15 L", () => fill("budget", { min: 10, max: 15 })]]); }
  if (!d.exp) { say(`Got it: <b>${parts}</b>. How much experience?`); return chips([["Freshers are fine", () => fill("exp", "Freshers are fine")], ["1–3 years", () => fill("exp", "1–3 years")], ["3–6 years", () => fill("exp", "3–6 years")]]); }
  if (d.start == null) { say(`Got it: <b>${parts}</b>. When do you need them to start?`); return chips([["Within 30 days", () => fill("start", 30)], ["Within 60 days", () => fill("start", 60)]]); }
  roleCard();
}
const startLabel = n => n === 0 ? "Immediately" : `Within ${n} days`;
function fill(k, v) { draftRole[k] = v; later(askRoleGaps, 250); }
function roleCard() {
  const d = draftRole;
  desk(`<div class="bubble">Here's the role. Check it, then send it for approval.</div>
  <div class="card draft"><h4><span class="kind">Approval</span>${esc(d.title)} · ${esc(d.city)} · ${d.count} opening${d.count > 1 ? "s" : ""} <span class="pill p-acc">Needs approval</span></h4><div class="c">
  <table><tr><td>Budget</td><td>${fmtBudget(d.budget)} CTC each</td></tr><tr><td>Experience</td><td>${esc(d.exp)}</td></tr><tr><td>Stages</td><td>Applied → Screened → Interview → Offer</td></tr><tr><td>Openings</td><td>${d.count}${d.countStated ? "" : " (you didn't say how many, so I assumed 1)"}</td></tr><tr><td>Start</td><td>${startLabel(d.start)}</td></tr><tr><td>Job description</td><td>Draft ready to review</td></tr></table>
  <div class="row"><button class="btn primary" type="button" data-a="sendRole" data-once>Send for approval on WhatsApp</button><button class="btn" type="button" data-a="noop">Edit JD</button></div></div></div>`);
  defaults();
}
ACT.sendRole = () => {
  const d = { ...draftRole };
  say(`Sent to ${esc(phoneLabel())} on WhatsApp. One word approves it.`);
  wa(phoneLabel(), `New role to approve: <b>${d.count} × ${esc(d.title)}, ${esc(d.city)}</b>, ${fmtBudget(d.budget)} each, ${esc(d.exp)}, start ${startLabel(d.start).toLowerCase()}. Reply YES to approve.`, [
    ["YES", () => { addRole(d, d.count); logApproval(`${d.title} role`, first()); paint(); say(`<span class="pill p-ok">Approved by ${esc(first())}</span> ${esc(d.title)} is live. I'll acknowledge every applicant within 24 hours.`); }],
    ...(d.count > 1 ? [["Make it 1 opening", () => { addRole(d, 1); logApproval(`${d.title} role (1 opening)`, first()); paint(); say("Approved with 1 opening. I've updated the role and it's live."); }]] : [])]);
};
function addRole(d, n) { D.roles.push({ id: id(), title: d.title, city: d.city, openings: n, days: 0, budget: fmtBudget(d.budget), status: "Open" }); }

function pipeline(rid = 1) {
  const r = roleOf(rid), c = stageCounts(rid);
  const col = st => { const ps = D.people.filter(p => p.role === rid && p.stage === st); return `<div class="col"><h5>${st} · ${ps.length}</h5>${ps.slice(0, 3).map(p => `<button class="cand${p.name === "Kiran S." && st === "Offer" ? " hot" : ""}" type="button" data-cand="${esc(p.name)}">${esc(p.name)}</button>`).join("")}${ps.length > 3 ? `<span class="note">+${ps.length - 3} more</span>` : ""}</div>`; };
  later(() => {
    const d = desk(`<div class="bubble">${esc(r.title)} pipeline. Tap a candidate.</div>
    <div class="card"><h4><span class="kind">Pipeline</span>${esc(r.title)} · ${r.days} days open <span class="pill ${c.Offer ? "p-warn" : "p-acc"}">${c.Offer ? c.Offer + " offer pending" : r.status}</span></h4><div class="c"><div class="board">${["Applied", "Screened", "Interview", "Offer"].map(col).join("")}</div></div></div>`);
    d.querySelectorAll("[data-cand]").forEach(b => b.onclick = () => openCandidate(b.dataset.cand));
    chips([["Build Kiran's offer", offer], ["Reject candidates who failed the test", bulk]]);
  });
}
function openCandidate(name) {
  me(`Open ${name}`);
  if (name === "Kiran S." && !D.done.offerSent) return offer();
  if (["Ankit Verma", "Lakshmi R."].includes(name) && !task("chase").done) return chase();
  const p = person(name); say(`<b>${esc(name)}</b> · ${esc(roleOf(p.role)?.title || "")} · ${esc(p.stage)}: ${esc(p.where)}. Owner: ${esc(ownerName(p.owner))}.`);
}

const KIRAN = [
  { name: "Basic + DA", kind: "basic", amount: 420000 }, { name: "HRA", kind: "hra", amount: 210000 },
  { name: "Special allowance", kind: "special", amount: 510000 }, { name: "Employer PF", kind: "employer_pf", amount: 60000 }];
function ctcBlock(comps) {
  const r = checkWagesRule(comps);
  return `<div class="tablewrap"><table><tr><th>Component</th><th>₹ per year</th></tr>${comps.map(c => `<tr><td>${esc(c.name)}</td><td>${formatINR(c.amount).slice(1)}</td></tr>`).join("")}<tr class="total"><td>CTC</td><td>${formatINR(r.ctc).slice(1)}</td></tr></table></div>
  <div class="row"><span class="pill ${r.passes ? "p-ok" : "p-late"}">Wages ${r.wagesPercent}% of pay</span><span class="note">${r.passes ? "Meets the 50% wages rule." : `Allowances are above half of pay. ${formatINR(r.deemedExtraWages)} would count as wages for PF and gratuity.`}</span></div>
  <div class="why">Calculated by fixed rules, not AI. Rule: ${esc(r.rule.citation)}. Status: ${esc(r.rule.status)}. Not legal advice.</div>`;
}
function offer() {
  if (D.done.offerSent) return say("Kiran's offer has already gone out.");
  later(() => desk(`<div class="bubble">Kiran's offer at ₹12 L. I checked the structure before anything goes out.</div>
  <div class="card draft"><h4><span class="kind">Offer · CTC</span>Kiran S. · Backend Developer <span class="pill p-late">Check failed</span></h4><div class="c">${ctcBlock(KIRAN)}
  <div class="row"><button class="btn primary" type="button" data-a="fixCtc" data-once>Fix the structure for me</button><button class="btn" type="button" data-a="noop">Edit</button></div></div></div>`));
}
ACT.fixCtc = b => {
  const card = b.closest(".card"), c = b.closest(".c");
  c.innerHTML = ctcBlock(fixStructure(KIRAN)) + `<div class="row"><button class="btn primary" type="button" data-a="sendOffer">Approve &amp; send offer</button></div>`;
  bind(c); card.querySelector("h4 .pill").outerHTML = '<span class="pill p-ok">Check passed</span>';
};
ACT.sendOffer = b => approve(b, "Kiran's offer letter", () => {
  D.done.offerSent = 1; closeTask("offer"); person("Kiran S.").where = "Offer sent · valid 3 days";
  say("Offer sent to Kiran, valid for 3 days. I'll remind him on day 2."); chips([["Kiran accepted the offer", accepted], ["Show my pipeline", () => pipeline()]]);
});

function accepted() {
  if (!D.done.offerSent) return say("Kiran doesn't have an offer yet. Want me to build it?") && chips([["Build Kiran's offer", offer]]);
  if (D.done.accepted) return say("Kiran's onboarding has already started. See Joiners & probation.");
  D.done.accepted = 1;
  const k = person("Kiran S."); Object.assign(k, { type: "Joiner", stage: "Hired", roleTitle: "Backend Developer", where: "Joins Mon 30 Nov", day1: "Mon 30 Nov",
    checklist: [{ t: "Documents uploaded", done: true }, { t: "Appointment letter", done: false }, { t: "Laptop and email", done: false }, { t: "Day 1 plan and buddy", done: false }],
    probation: { ends: "Sun 30 May 2027", manager: "Arjun Mehta", status: "Scheduled 14 May 2027" } });
  const be = roleOf(1); be.status = "Filled";
  D.tasks.push({ id: id(), key: "kiranLetter", title: "Kiran's appointment letter", ctx: "Due Wed 25 Nov · joins Mon 30 Nov", owner: "hr", when: "This week", done: false },
    { id: id(), key: "kiranLaptop", title: "Laptop and email for Kiran", ctx: "Due Fri 27 Nov", owner: "Suresh (IT)", when: "This week", done: false });
  paint();
  later(() => {
    desk(`<div class="bubble">Kiran accepted. I created his employee record and started onboarding. Joining Mon 30 Nov.</div>
  <div class="card"><h4><span class="kind">Joiner checklist</span>Kiran S. · Day 1 on Mon 30 Nov <span class="pill p-acc">On track</span></h4>
   <div class="item"><span class="pill p-ok">Done</span><div class="t">Document upload link sent to Kiran<small>PAN, Aadhaar (masked), education, last payslip · consent recorded</small></div></div>
   <div class="item"><span class="pill p-warn">Due 25 Nov</span><div class="t">Appointment letter<small>Owner: ${esc(ownerName("hr"))}</small></div><button class="btn" type="button" data-a="kiranLetter">Draft now</button></div>
   <div class="item"><span class="pill p-warn">Due 27 Nov</span><div class="t">Laptop and email account<small>Owner: Suresh (IT) · reminder set on WhatsApp</small></div></div>
   <div class="item"><span class="pill p-acc">Planned</span><div class="t">Day 1 plan and buddy (Arjun Mehta)<small>30-60-90 plan from the playbook</small></div></div>
   <div class="item"><span class="pill p-acc">Scheduled</span><div class="t">Probation review with Arjun Mehta, due 14 May 2027<small>15 days before the 6-month end date</small></div></div>
  </div><div class="why">From offer accepted to Day 1 to confirmation: one record, nothing re-entered.</div>`);
    wa("Suresh (IT)", "New joiner <b>Kiran S.</b> on Mon 30 Nov. Laptop and email needed by Fri 27 Nov.", [["Will do", () => say("Suresh confirmed he'll have Kiran's laptop and email ready.")]]);
    defaults();
  });
}
ACT.kiranLetter = () => { me("Draft Kiran's appointment letter"); kiranLetter(); };
function kiranLetter() {
  if (D.done.kiranLetter) return say("Kiran's letter is already drafted.");
  D.done.kiranLetter = 1;
  later(() => desk(`<div class="card draft"><h4><span class="kind">Approval</span>Appointment letter · Kiran S. <span class="pill p-acc">Draft</span></h4><div class="c">
  <div class="doc">Dear Kiran,
We are pleased to appoint you as Backend Developer at Acme Fintech Pvt Ltd, effective Mon 30 Nov 2026.
CTC: ₹12,00,000 per year (breakdown in Annexure A). Probation: 6 months …</div>
  <div class="row"><button class="btn primary" type="button" data-a="sendKiranLetter">Approve &amp; send</button><button class="btn" type="button" data-a="noop">Edit</button></div></div></div>`));
}
ACT.sendKiranLetter = b => approve(b, "Kiran's appointment letter", () => { closeTask("kiranLetter"); person("Kiran S.").checklist[1].done = true; say("Sent to Kiran for e-acknowledgement."); });

function bulk() {
  if (D.done.bulk) return say("Those 4 rejection notes have already gone out.");
  later(() => desk(`<div class="bubble">4 candidates scored below 60% on the Excel assessment for Operations Analyst. Here's the draft, with a job-relevant reason for each.</div>
  <div class="card draft"><h4><span class="kind">Bulk preview</span>Reject 4 · Operations Analyst <span class="pill p-acc">Preview</span></h4>
   ${D.people.filter(p => p.failed).map(p => `<div class="item"><div class="t">${esc(p.name)} · ${p.score}%</div></div>`).join("")}
   <div class="c"><div class="doc">Hi {name}, thank you for your time with Acme Fintech. We won't move forward with your application for Operations Analyst. The role needs advanced Excel modelling, and your assessment score ({score}) was below the 60% we need. We'd welcome an application for future roles.</div>
   <div class="why">Reason: assessment score below the bar. Reasons come from a fixed job-relevant list.</div>
   <div class="row"><button class="btn primary" type="button" data-a="sendBulk">Send all 4</button><button class="btn" type="button" data-a="noop">Review each</button></div></div></div>`));
}
ACT.sendBulk = b => approve(b, "4 rejection notes", () => {
  D.done.bulk = 1; closeTask("bulk");
  D.people.filter(p => p.failed).forEach(p => { p.stage = "Rejected"; p.where = "Rejected: assessment below 60%"; });
  say("Sent. All 4 status pages are closed with a reason. Candidates told within 7 days this week: 100%.");
});

function probation() {
  if (D.done.prob) return say("Priya's review is already with Vikram.");
  D.done.prob = 1; const pr = person("Priya Nair"); pr.probation.status = "With Vikram"; pr.where = "Review with Vikram, due Sat 14 Nov";
  const t = task("probation"); t.title = "Vikram to review Priya's probation"; t.owner = "Vikram"; t.ctx = "3-question review sent on WhatsApp · due Sat 14 Nov"; paint();
  later(() => {
    say("I sent Vikram, Priya's manager, a 3-question review on WhatsApp, due in 3 days. I'll escalate if it slips.");
    wa("Vikram (manager)", "Priya Nair's probation ends on Mon 23 Nov. Your call:", [
      ["Confirm Priya", () => desk(`<div class="bubble">Vikram recommends confirming Priya. Here's the letter.</div>
       <div class="card draft"><h4><span class="kind">Approval</span>Confirmation letter · Priya Nair <span class="pill p-acc">Draft</span></h4><div class="c"><div class="doc">Dear Priya,
We are happy to confirm your employment as Customer Success Associate with effect from 23 Nov 2026 …</div>
       <div class="row"><button class="btn primary" type="button" data-a="sendConf">Approve &amp; send</button><button class="btn" type="button" data-a="noop">Edit</button></div></div></div>`)],
      ["Extend by 3 months", () => { pr.probation.status = "Extended"; pr.where = "Probation extended by 3 months"; closeTask("probation"); paint(); say("Vikram wants an extension. I'll draft the extension letter with his reasons and set a new review date."); }]]);
  });
}
ACT.sendConf = b => approve(b, "Priya's confirmation letter", () => { const pr = person("Priya Nair"); pr.probation.status = "Confirmed"; pr.where = "Confirmed from 23 Nov"; closeTask("probation"); say("Sent. Priya acknowledged it."); });

function wrap() {
  const open = D.tasks.filter(t => !t.done), late = open.filter(t => t.when === "Late").length;
  later(() => desk(`<div class="bubble">Here's your day.</div>
  <div class="card"><h4><span class="kind">End of day</span>${new Date().toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" })}</h4>
   <div class="item"><span class="pill p-ok">Approved</span><div class="t">${D.audit.length} item${D.audit.length === 1 ? "" : "s"} approved today<small>${D.audit.length ? D.audit.map(a => esc(a.what) + " by " + esc(a.by)).join(" · ") : "Nothing approved yet"}</small></div></div>
   <div class="item"><span class="pill ${late ? "p-late" : "p-ok"}">${late ? "Late" : "Clear"}</span><div class="t">${open.length} open task${open.length === 1 ? "" : "s"}, ${late} late<small>${late ? "I'll put the late ones first in tomorrow's brief." : "Nothing is late."}</small></div></div>
  </div>`));
}

/* ----- understanding the user: act only when clear, otherwise say so ----- */
function blocked(s) { return /\b(age|old|young|gender|female|male|woman|women|man|married|marital|single|pregnan\w*|religio\w*|hindu|muslim|christian|caste|kids?|children)\b/i.test(s); }
function honest() {
  later(() => {
    say(`I can't do that yet in this preview. Right now I can: show today's work, chase late feedback, create a new role, show a pipeline, build Kiran's offer, send rejection notes, draft Sneha's letter and start Priya's probation review. The full Desk agent will understand much more.`);
    defaults();
  });
}
/* ----- live Desk agent (Supabase Edge Function), behind a switch in Settings ----- */
const LS = { get(k) { try { return localStorage.getItem("cs:" + k); } catch { return null; } }, set(k, v) { try { localStorage.setItem("cs:" + k, v); } catch {} } };
let liveDesk = auth.LIVE && LS.get("liveDesk") === "1", liveConv = null;
const pillCls = { late: "p-late", warn: "p-warn", info: "p-acc", ok: "p-ok" };
function renderLiveCard(c) {
  const acts = (c.actions || []).map((a, i) => `<button class="btn${i === 0 ? " primary" : ""}" type="button" data-live='${esc(JSON.stringify({ action: a.action, params: a.params }))}'>${esc(a.label)}</button>`).join("");
  const wait = c.waiting_for_other ? `<span class="pill p-warn">Waiting for ${esc(c.approver || "approval")}</span>` : "";
  if (c.type === "brief") return `<div class="card"><h4><span class="kind">Brief · ${c.open} open</span>${c.late ? `<span class="pill p-late">${c.late} late</span>` : ""}</h4>${c.items.map(i => `<div class="item"><span class="pill ${pillCls[i.pill] || "p-mut"}">${esc(i.bucket)}</span><div class="t">${esc(i.title)}<small>${esc(i.why || "")}${i.owner ? " · Owner: " + esc(i.owner) : ""}</small></div></div>`).join("") || '<div class="item"><div class="t">All clear.</div></div>'}</div>`;
  if (c.type === "approval") return `<div class="card draft"><h4><span class="kind">Approval</span>${esc(c.title)} ${wait}</h4><div class="c"><div class="doc">${esc(c.preview)}</div>${acts ? `<div class="row">${acts}</div>` : ""}</div></div>`;
  if (c.type === "pipeline") return `<div class="card"><h4><span class="kind">Pipeline</span>${esc(c.role)} · ${c.days_open} days open</h4><div class="c"><div class="board">${c.columns.map(col => `<div class="col"><h5>${esc(col.stage)} · ${col.count}</h5>${col.people.map(n => `<span class="cand">${esc(n)}</span>`).join("")}${col.more ? `<span class="note">+${col.more} more</span>` : ""}</div>`).join("")}</div></div></div>`;
  if (c.type === "offer") return `<div class="card draft"><h4><span class="kind">Offer · CTC</span>${c.ctc_display} <span class="pill ${c.passes ? "p-ok" : "p-late"}">${c.passes ? "Check passed" : "Check failed"}</span></h4><div class="c"><div class="tablewrap"><table><tr><th>Component</th><th>₹ per year</th></tr>${c.components.map(x => `<tr><td>${esc(x.name)}</td><td>${esc(x.display.slice(1))}</td></tr>`).join("")}</table></div><div class="row"><span class="pill ${c.passes ? "p-ok" : "p-late"}">Wages ${c.wages_percent}% of pay</span><span class="note">${esc(c.note)}</span></div><div class="why">${esc(c.legal)} Rule: ${esc(c.citation)}. Status: ${esc(c.status)}.</div></div></div>`;
  if (c.type === "scorecard") return `<div class="card"><h4><span class="kind">Scorecard</span><span class="pill p-ok">${esc(c.recommendation.replace("_", " "))}</span></h4><div class="c"><table><tr><th>Criterion</th><th>Score</th></tr>${Object.entries(c.scores).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v} / 5</td></tr>`).join("")}</table></div></div>`;
  if (c.type === "joiner_checklist") return `<div class="card"><h4><span class="kind">Joiner checklist</span>${esc(c.name)} · Day 1 ${esc(c.joined_on)}</h4>${c.tasks.map(t => `<div class="item"><span class="pill ${t.status === "done" ? "p-ok" : "p-warn"}">${t.status === "done" ? "Done" : "Open"}</span><div class="t">${esc(t.title)}<small>Owner: ${esc(t.owner || "you")}${t.due ? " · due " + esc(String(t.due).slice(0, 10)) : ""}</small></div></div>`).join("")}</div>`;
  if (c.type === "bulk_preview") return `<div class="card draft"><h4><span class="kind">Bulk preview</span>${c.count} rejection notes ${wait}</h4><div class="c"><div class="doc">${esc(c.note)}</div><div class="why">Reason: ${esc(c.reason.replace(/_/g, " "))}. Job-relevant reasons only.</div>${acts ? `<div class="row">${acts}</div>` : ""}</div></div>`;
  if (c.type === "choice") return `<div class="card"><h4><span class="kind">Which one?</span>${esc(c.question)}</h4><div class="c"><div class="row">${c.options.map(o => `<button class="btn" type="button" data-say="${esc(o.value)}">${esc(o.label)}</button>`).join("")}</div></div></div>`;
  if (c.type === "info") return `<div class="card"><div class="c"><div>${esc(c.text)}</div>${acts ? `<div class="row">${acts}</div>` : ""}</div></div>`;
  return "";
}
function showLive(out) {
  const d = desk(`${out.reply ? `<div class="bubble">${esc(out.reply)}</div>` : ""}${(out.cards || []).map(renderLiveCard).join("")}`);
  d.querySelectorAll("[data-live]").forEach(b => b.onclick = async () => {
    const card = b.closest(".card"); card?.querySelectorAll("button").forEach(x => x.disabled = true);
    const req = JSON.parse(b.dataset.live);
    try { showLive(await auth.callDesk(req)); } catch (e) { say(esc(e.message)); card?.querySelectorAll("button").forEach(x => x.disabled = false); }
  });
  d.querySelectorAll("[data-say]").forEach(b => b.onclick = () => { me(b.dataset.say); liveTurn(b.dataset.say); });
}
async function liveTurn(t) {
  const wait = desk('<div class="bubble"><span class="note">Desk is working on it…</span></div>');
  try { const out = await auth.callDesk({ action: "chat", text: t, conversation_id: liveConv }); liveConv = out.conversation_id; wait.remove(); showLive(out); }
  catch (e) { wait.remove(); say(`${esc(e.message)} You can switch the live agent off in Settings to use the preview.`); }
}

function route(t) {
  if (liveDesk) return liveTurn(t);
  const s = t.toLowerCase();
  if (/\b(reject|nahi lena|drop)\b/.test(s) && blocked(s)) {
    say("I can't use that as a rejection reason. Reasons must be about the job, like skills, assessment score, experience, salary, location or notice period.");
    return chips([["Show job-relevant reasons", () => reasonPicker("this candidate")]]);
  }
  if (/\barjun\b/.test(s) && !/\b(rao|mehta)\b/.test(s)) {
    say("Do you mean Arjun Mehta (interviewer) or Arjun Rao (candidate, Customer Success Associate)?");
    return chips([["Arjun Mehta", chase], ["Arjun Rao", () => openCandidateNoEcho("Arjun Rao")]]);
  }
  const about = s.match(/^(?:tell me about|who is|show)\s+(.+)$/);
  if (about) { const p = D.people.find(x => x.name.toLowerCase() === about[1].trim().replace(/[?.]$/, "")); if (p) return openCandidateNoEcho(p.name); }
  if (/\bconfirm(ation)?\b/.test(s) && /\b(arjun rao|screen call)\b/.test(s)) return confirmScreen();
  if (/\baction plan\b/.test(s)) return later(() => { say(`Here's a plan to get feedback on time above 90%:<br>1. Nudge interviewers 4 hours after each interview, on WhatsApp.<br>2. Escalate to the hiring manager at 24 hours.<br>3. Add a second Engineering interviewer to share the load.<br>4. Review feedback times every Monday in the brief.`); chips([["Chase Arjun Mehta", chase], ["What's on today?", brief]]); });
  if (/\b(monthly|month)\b.*\b(summary|report)\b/.test(s)) { say("Monthly summaries come with the full Desk agent. Here's today's summary for now."); return wrap(); }
  const hire = parseHire(t);
  if (hire) { draftRole = { title: hire.title, count: hire.count, countStated: hire.countStated, city: hire.city, budget: hire.budget, exp: hire.exp, start: hire.start }; return later(askRoleGaps); }
  if (/\bchase\b|\bfeedback\b|\barjun mehta\b/.test(s)) return chase();
  if (/\bsneha\b|\bappointment letter\b/.test(s)) return letter();
  if (/\bpipeline\b|\bboard\b/.test(s)) return pipeline();
  if (/\breject\b.*\b(failed|test|assessment)\b|\bfailed the test\b/.test(s)) return bulk();
  if (/\bkiran\b.*\baccept/.test(s)) return accepted();
  if (/\bkiran\b|\boffer\b|\bctc\b/.test(s)) return offer();
  if (/\bprobation\b|\bpriya\b/.test(s)) return probation();
  if (/\bwrap\b|\bend of (the )?day\b|\baaj kya hua\b/.test(s)) return wrap();
  if (/\btoday\b|\bbrief\b|\bmorning\b|\bkya hai\b|\bwhat'?s on\b/.test(s)) return brief();
  if (/\b(laptop|suresh)\b/.test(s)) return remindIT();
  return honest();
}
function confirmScreen() {
  const iv = D.interviews.find(i => i.cand === "Arjun Rao");
  if (iv.confirmed) return say("Arjun Rao has already confirmed today's screen call.");
  later(() => desk(`<div class="card draft"><h4><span class="kind">Approval</span>Message to Arjun Rao <span class="pill p-acc">Draft</span></h4><div class="c">
    <div class="doc">Hi Arjun, this is a reminder of your screen call with Acme Fintech today at 4:00 PM for the Customer Success Associate role. Reply YES to confirm, or tap the link to pick another time.</div>
    <div class="row"><button class="btn primary" type="button" data-a="sendConfirm">Approve &amp; send</button><button class="btn" type="button" data-a="rejectDraft">Cancel</button></div></div></div>`));
}
ACT.sendConfirm = b => approve(b, "a confirmation message to Arjun Rao", () => {
  say("Sent to Arjun Rao on WhatsApp.");
  wa("Arjun Rao (candidate)", "Reminder: screen call with Acme Fintech today at 4:00 PM. Reply YES to confirm.", [["YES", () => { D.interviews.find(i => i.cand === "Arjun Rao").confirmed = true; person("Arjun Rao").where = "Screen call today 4 PM, confirmed"; paint(); say("Arjun Rao confirmed today's screen call."); }]]);
});
function openCandidateNoEcho(name) { const p = person(name); say(`<b>${esc(name)}</b> · ${esc(roleOf(p.role)?.title || "")} · ${esc(p.stage)}: ${esc(p.where)}. Owner: ${esc(ownerName(p.owner))}.`); }

$("#ask").addEventListener("submit", e => { e.preventDefault(); const v = $("#q").value.trim(); if (!v) return; if (currentTab !== "desk") location.hash = "desk"; me(v); $("#q").value = ""; route(v); });
$("#file").addEventListener("change", e => {
  const f = e.target.files[0]; if (!f) return; e.target.value = "";
  me(`Uploaded ${f.name}`);
  later(() => { desk(`<div class="bubble">Got <b>${esc(f.name)}</b>. Reading CVs isn't in this preview yet, so I'll add a placeholder record. Which role is it for?</div>`);
    chips(D.roles.filter(r => r.status === "Open").slice(0, 4).map(r => [r.title, () => { D.people.push({ id: id(), name: f.name.replace(/\.[^.]+$/, ""), type: "Candidate", role: r.id, stage: "Applied", where: "Uploaded CV, not yet read", owner: "hr" }); paint(); say(`Added to ${esc(r.title)} as Applied. Consent is recorded at upload.`); }])); });
});
$("#m-solo").onclick = () => { if (mode === "solo") return; mode = "solo"; paint(); say("Switched to <b>Solo</b>. You own everything, and what you approve goes out straight away."); };
$("#m-lead").onclick = () => { if (mode === "lead") return; mode = "lead"; paint(); say(`Switched to <b>Lead + juniors</b>. You're now acting as Ritu, a junior. Anything that reaches a candidate or employee goes to ${esc(first())} for one-tap approval, in the app or on WhatsApp.`); };
$("#restart").onclick = () => { init(); location.hash = "desk"; };
$("#waToggle").onclick = () => { $("#wa").classList.add("open"); $("#waToggle").setAttribute("aria-expanded", "true"); $("#waToggle").textContent = "WhatsApp"; };
$("#waClose").onclick = () => { $("#wa").classList.remove("open"); $("#waToggle").setAttribute("aria-expanded", "false"); };

/* =================== CHECK VIEWS: read only; every action runs in Desk =================== */
const V = { todayFilter: "All", hiringRole: null, q: "", type: "All", owner: "All", personId: null };
function showTab() {
  const t = location.hash.slice(1);
  currentTab = TABS.includes(t) ? t : "overview";
  document.querySelectorAll(".sidenav a").forEach(a => a.dataset.tab === currentTab ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current"));
  const onDesk = currentTab === "desk";
  $("#chatView").hidden = !onDesk; $("#view").hidden = onDesk; $("#composer").classList.toggle("compact", !onDesk);
  if (currentTab !== "people") V.personId = null;
  if (onDesk) { scroll(); $("#q").focus({ preventScroll: true }); } else renderTab();
}
window.addEventListener("hashchange", () => { if (!$("#s-app").hidden && D) showTab(); });
function withDesk(fn) { location.hash = "desk"; fn(); }

const whenPill = w => ({ Late: "p-late", Today: "p-warn", "This week": "p-acc", Done: "p-ok" }[w] || "p-mut");
const wherePill = p => p.stage === "Rejected" ? "p-mut" : p.late ? "p-late" : p.type === "Joiner" ? "p-acc" : p.type === "Employee" ? (p.probation?.status === "Review due" ? "p-warn" : "p-ok") : p.stage === "Offer" ? "p-warn" : "p-mut";
function ownerFilterHtml() {
  if (mode !== "lead") return "";
  return `<label class="sr" for="ownerF">Owner</label><select id="ownerF" data-vf="owner">${["All", "Ritu", `${first()} (you)`, "Others"].map(o => `<option${V.owner === o ? " selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
}
function ownerMatch(o) {
  if (mode !== "lead" || V.owner === "All") return true;
  const n = ownerName(o);
  return V.owner === "Others" ? !["Ritu", `${first()} (you)`].includes(n) : n === V.owner;
}

function renderTab() {
  const v = $("#view");
  const head = (h, p, act) => `<div class="vhead"><div><h2>${h}</h2><p>${p}</p></div>${act || ""}</div>`;
  let html = "";
  if (currentTab === "people" && V.personId) {
    html = personDetail(D.people.find(p => p.id === V.personId));
  } else if (currentTab === "today") {
    const list = D.tasks.filter(t => (V.todayFilter === "All" ? true : t.when === V.todayFilter) && ownerMatch(t.owner));
    const order = { Late: 0, Today: 1, "This week": 2, Done: 3 };
    list.sort((a, b) => order[a.when] - order[b.when]);
    html = head("Today", `${D.tasks.filter(t => !t.done).length} open tasks · ${D.tasks.filter(t => !t.done && t.when === "Late").length} late`) +
      `<div class="toolbar" role="group" aria-label="Filter tasks">${["All", "Late", "Today", "This week", "Done"].map(f => `<button class="fchip" type="button" data-vf="todayFilter" data-val="${f}" aria-pressed="${V.todayFilter === f}">${f}</button>`).join("")}${ownerFilterHtml()}</div>
      <div class="card">${list.length ? list.map(t => `<div class="item"><span class="pill ${whenPill(t.when)}">${esc(t.when)}</span><div class="t">${esc(t.title)}<small>${esc(t.ctx)} · Owner: ${esc(ownerName(t.owner))}</small></div>
        ${t.done ? "" : `<button class="btn${t.when === "Late" ? " primary" : ""}" type="button" data-v="task" data-key="${esc(t.key)}">Do it with Desk</button>`}</div>`).join("") : '<div class="emptyv">Nothing here.</div>'}</div>`;
  } else if (currentTab === "hiring") {
    const sel = V.hiringRole && roleOf(V.hiringRole);
    html = head("Jobs", `${D.roles.filter(r => r.status === "Open").length} open roles · tap a role for its board`, `<button class="btn primary" type="button" data-v="newRole">New role with Desk</button>`) +
      `<div class="rolegrid">${D.roles.map(r => {
        const c = stageCounts(r.id), tot = Object.values(c).reduce((a, b) => a + b, 0) || 1;
        return `<button class="rolecard" type="button" data-v="role" data-rid="${r.id}" aria-pressed="${V.hiringRole === r.id}"><div class="rt"><div><b>${esc(r.title)}</b><div class="note">${esc(r.city)} · ${r.openings} opening${r.openings > 1 ? "s" : ""} · ${esc(r.budget)} · ${r.days} days open</div></div><span class="pill ${r.status === "Open" ? "p-ok" : "p-acc"}">${esc(r.status)}</span></div>
          <div class="stagebar" aria-hidden="true">${["Applied", "Screened", "Interview", "Offer"].map(s => `<i style="width:${(c[s] / tot) * 100}%"></i>`).join("")}</div>
          <div class="counts">${["Applied", "Screened", "Interview", "Offer"].map(s => `<span><b>${c[s]}</b>${s}</span>`).join("")}</div></button>`; }).join("")}</div>` +
      (sel ? (() => {
        const actions = sel.id === 1 && !D.done.offerSent ? `<button class="btn primary" type="button" data-v="task" data-key="offer">Build Kiran's offer in Desk</button>` + (task("chase").done ? "" : `<button class="btn" type="button" data-v="task" data-key="chase">Chase late feedback in Desk</button>`)
          : sel.id === 2 && !D.done.bulk ? `<button class="btn primary" type="button" data-v="task" data-key="bulk">Send rejection notes with Desk</button>` : "";
        return `<div class="card"><h4><span class="kind">Board</span>${esc(sel.title)}</h4><div class="c"><div class="board">${["Applied", "Screened", "Interview", "Offer"].map(st => {
          const ps = D.people.filter(p => p.role === sel.id && p.stage === st);
          return `<div class="col"><h5>${st} · ${ps.length}</h5>${ps.map(p => `<button class="cand${p.late ? " hot" : ""}" type="button" data-v="person" data-pid="${p.id}">${esc(p.name)}<span class="note" style="display:block">${esc(p.where)}</span></button>`).join("") || '<span class="note">None</span>'}</div>`; }).join("")}</div>
          ${actions ? `<div class="row">${actions}</div>` : ""}</div></div>`; })() : "");
  } else if (currentTab === "people") {
    const q = V.q.trim().toLowerCase();
    const rank = p => p.late ? 0 : p.stage === "Offer" ? 1 : p.type === "Joiner" ? 2 : p.probation && p.probation.status === "Review due" ? 3 : p.failed && p.stage !== "Rejected" ? 4 : p.stage === "Interview" ? 5 : p.stage === "Rejected" ? 9 : 6;
    const list = D.people.filter(p => (V.type === "All" || p.type === V.type) && ownerMatch(p.owner) &&
      (!q || [p.name, p.roleTitle, roleOf(p.role)?.title, p.where].join(" ").toLowerCase().includes(q)))
      .map((p, i) => [p, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(x => x[0]);
    const cc = counts();
    html = head("Candidates & people", `${plural(cc.activeCands.length, "active candidate")} · ${cc.people} people in total · needs action first`) +
      `<div class="toolbar"><label class="sr" for="pq">Search people</label><input type="search" id="pq" data-vf="q" placeholder="Search by name, role or status" value="${esc(V.q)}">
       <label class="sr" for="ptype">Type</label><select id="ptype" data-vf="type">${["All", "Candidate", "Joiner", "Employee"].map(o => `<option${V.type === o ? " selected" : ""}>${o}</option>`).join("")}</select>${ownerFilterHtml()}</div>
      <div class="card"><div class="tablewrap"><table><tr><th>Name</th><th>Type</th><th>Role</th><th>Where they are</th><th>Owner</th></tr>
      ${list.map(p => `<tr class="click" data-v="person" data-pid="${p.id}" tabindex="0"><td style="font-weight:500">${esc(p.name)}</td><td>${esc(p.type)}</td><td>${esc(roleOf(p.role)?.title || p.roleTitle || "")}</td><td><span class="pill ${wherePill(p)}">${esc(p.stage && p.type === "Candidate" ? p.stage + " · " : "")}${esc(p.where)}</span></td><td style="text-align:left">${esc(ownerName(p.owner))}</td></tr>`).join("") || '<tr><td colspan="5" class="emptyv">No one matches that search.</td></tr>'}
      </table></div></div><p class="note">${list.length} of ${D.people.length} people · sample data</p>`;
  } else if (currentTab === "joiners") {
    const js = D.people.filter(p => p.type === "Joiner"), ps = D.people.filter(p => p.probation);
    html = head("Joiners & probation", "From offer accepted to confirmation") +
      `<div class="card"><h4><span class="kind">Joining soon</span></h4>${js.length ? js.map(j => {
        const done = j.checklist.filter(c => c.done).length, miss = j.checklist.filter(c => !c.done).map(c => c.t);
        const fixKey = j.name === "Sneha Rao" ? (!j.checklist[1].done ? "letter" : !j.checklist[2].done ? "laptop" : null) : (!j.checklist[1].done ? "kiranLetter" : !j.checklist[2].done ? "kiranLaptop" : null);
        return `<div class="item"><div class="t"><b style="font-weight:500">${esc(j.name)}</b> · ${esc(j.roleTitle)}<small>Day 1: ${esc(j.day1)}${miss.length ? " · Missing: " + esc(miss.join(", ")) : " · All set"}</small></div>
          <span class="prog"><i style="--p:${(done / j.checklist.length) * 100}%"></i>${done}/${j.checklist.length}</span>
          ${fixKey && !task(fixKey)?.done ? `<button class="btn primary" type="button" data-v="task" data-key="${fixKey}">Fix with Desk</button>` : ""}</div>`; }).join("") : '<div class="emptyv">No one joining soon.</div>'}</div>
      <div class="card"><h4><span class="kind">Probation reviews</span></h4>${ps.map(p => `<div class="item"><div class="t"><b style="font-weight:500">${esc(p.name)}</b> · ${esc(p.roleTitle)}<small>Ends ${esc(p.probation.ends)} · manager ${esc(p.probation.manager)}</small></div>
        <span class="pill ${p.probation.status === "Review due" ? "p-warn" : p.probation.status === "Confirmed" ? "p-ok" : "p-acc"}">${esc(p.probation.status)}</span>
        ${p.probation.status === "Review due" ? '<button class="btn primary" type="button" data-v="task" data-key="probation">Start with Desk</button>' : ""}</div>`).join("")}</div>`;
  }
  html = html || extraView(head);
  v.innerHTML = `<div class="inner">${html}</div>`;
  v.scrollTop = 0;
}
$("#view").addEventListener("click", e => {
  const b = e.target.closest("[data-v],[data-vf]"); if (!b) return;
  if (b.dataset.vf && b.dataset.val) { V[b.dataset.vf] = b.dataset.val; return renderTab(); }
  if (b.dataset.v === "task") return withDesk(() => runTask(b.dataset.key, true));
  if (b.dataset.v === "newRole") return withDesk(() => { me("I want to open a new role"); say("Sure. Tell me the role, city and budget, for example <i>\"Ek data analyst chahiye Bangalore mein, 8-10L\"</i>."); chips([["Ek data analyst chahiye Bangalore mein, 8-10L", () => hireFrom("Ek data analyst chahiye Bangalore mein, 8-10L")], ["Hire 2 sales execs in Pune", () => hireFrom("Hire 2 sales execs in Pune")]]); });
  if (b.dataset.v === "person") { V.personId = Number(b.dataset.pid); if (currentTab !== "people") location.hash = "people"; else renderTab(); return; }
  if (b.dataset.v === "back") { V.personId = null; return renderTab(); }
  if (b.dataset.v === "ask") return withDesk(() => { me(b.dataset.text); route(b.dataset.text); });
  if (b.dataset.v === "review") return withDesk(() => { me("Review " + b.dataset.what); reviewPending(Number(b.dataset.pid)); });
  if (b.dataset.v === "liveToggle") { if (b.getAttribute("aria-pressed") === "true") return; liveDesk = !liveDesk; LS.set("liveDesk", liveDesk ? "1" : "0"); liveConv = null; renderTab(); return; }
  if (b.dataset.v === "loadSample") { b.disabled = true; b.textContent = "Loading…"; auth.callDesk({ action: "load_sample_data" }).then(r => { b.textContent = "Loaded"; withDesk(() => say(esc(r.reply))); }).catch(e => { b.disabled = false; b.textContent = "Load sample data"; withDesk(() => say(esc(e.message))); }); return; }
  if (b.dataset.v === "mode") return $(b.dataset.mode === "lead" ? "#m-lead" : "#m-solo").click();
  if (b.dataset.v === "role") { V.hiringRole = V.hiringRole === Number(b.dataset.rid) ? null : Number(b.dataset.rid); renderTab(); }
});
$("#view").addEventListener("input", e => {
  const f = e.target.closest("[data-vf]"); if (!f || f.dataset.val) return;
  V[f.dataset.vf] = f.value;
  if (f.id === "pq") { const pos = f.selectionStart; renderTab(); const n = $("#pq"); n.focus(); n.setSelectionRange(pos, pos); } else renderTab();
});

$("#view").addEventListener("keydown", e => { const r = e.target.closest("tr.click"); if (r && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); r.click(); } });

/* ----- dashboards brought back from the Recruiter Desk design ----- */
const NEXT = { "Kiran S.": ["offer", "Build Kiran's offer in Desk"], "Ankit Verma": ["chase", "Chase feedback in Desk"], "Lakshmi R.": ["chase", "Chase feedback in Desk"],
  "Sneha Rao": ["letter", "Draft Sneha's letter in Desk"], "Priya Nair": ["probation", "Start Priya's review in Desk"] };
function personDetail(p) {
  if (!p) { V.personId = null; return ""; }
  const stages = ["Applied", "Screened", "Interview", "Offer"], at = stages.indexOf(p.stage);
  const role = roleOf(p.role)?.title || p.roleTitle || "";
  let next = NEXT[p.name]; if (p.failed && !D.done.bulk) next = ["bulk", "Send rejection notes with Desk"];
  if (next && task(next[0])?.done) next = null;
  const steps = p.type === "Candidate" && p.stage !== "Rejected" ? `<ol class="steps" aria-label="Hiring stage">${stages.map((s, i) => `<li class="${i <= at ? "done" : ""}${i === at ? " now" : ""}"><i></i><span>${s}</span></li>`).join("")}</ol>` : "";
  const extra = p.checklist ? `<div class="card"><h4><span class="kind">Joiner checklist</span>Day 1: ${esc(p.day1)}</h4>${p.checklist.map(c => `<div class="item"><span class="pill ${c.done ? "p-ok" : "p-warn"}">${c.done ? "Done" : "Pending"}</span><div class="t">${esc(c.t)}</div></div>`).join("")}</div>` : "";
  const prob = p.probation ? `<div class="card"><h4><span class="kind">Probation</span></h4><div class="item"><div class="t">Ends ${esc(p.probation.ends)}<small>Manager: ${esc(p.probation.manager)}</small></div><span class="pill p-acc">${esc(p.probation.status)}</span></div></div>` : "";
  return `<button class="back" type="button" data-v="back">← All people</button>
    <div class="card"><div class="c" style="gap:14px">
      <div class="row" style="justify-content:space-between"><div class="row"><div class="av" style="width:44px;height:44px;border-radius:50%;background:var(--hover);color:var(--text)">${esc(p.name.split(" ").map(w => w[0]).join("").slice(0, 2))}</div>
        <div><h2 style="font-size:20px;font-weight:600">${esc(p.name)}</h2><div class="note">${esc(p.type)} · ${esc(role)} · Owner: ${esc(ownerName(p.owner))}</div></div></div>
        ${next ? `<button class="btn primary" type="button" data-v="task" data-key="${next[0]}">${esc(next[1])}</button>` : `<button class="btn" type="button" data-v="ask" data-text="${esc("Tell me about " + p.name)}">Ask Desk about ${esc(p.name.split(" ")[0])}</button>`}</div>
      ${steps}
      <div><span class="pill ${wherePill(p)}">${esc(p.where)}</span></div>
      ${p.score ? `<div class="note">Excel assessment: ${p.score}% (bar is 60%)</div>` : ""}
    </div></div>${extra}${prob}
    <p class="note">This view only shows information. Changes happen in Desk, through approval.</p>`;
}

function extraView(head) {
  const open = D.tasks.filter(t => !t.done), late = open.filter(t => t.when === "Late");
  const cands = D.people.filter(p => p.type === "Candidate" && p.stage !== "Rejected");
  const stageTot = s => cands.filter(p => p.stage === s).length;
  const ask = (text, label, primary) => `<button class="btn${primary ? " primary" : ""}" type="button" data-v="ask" data-text="${esc(text)}">${esc(label || text)}</button>`;
  const ivStatus = i => { const p = person(i.cand); return p?.late ? ["p-late", "Feedback late"] : p && /Feedback in|Round 2|Scored/.test(p.where) ? ["p-ok", "Feedback in"] : i.confirmed ? ["p-ok", "Confirmed"] : i.confirmed === false ? ["p-warn", "Not confirmed"] : ["p-mut", "Done"]; };

  if (currentTab === "overview") {
    const h = new Date().getHours(), hi = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
    const top = counts().openTasks.slice(0, 4);
    const max = Math.max(1, ...["Applied", "Screened", "Interview", "Offer"].map(stageTot));
    return head(`${hi}, ${esc(first())}`, `${plural(open.length, "open task")} this week, ${late.length} late.`, ask("What's on today?", "Ask Desk for today's brief", true)) +
      `<div class="stats">
        <div class="stat"><div class="l">Active candidates</div><div class="v">${counts().activeCands.length}</div></div>
        <div class="stat"><div class="l">Open roles</div><div class="v">${D.roles.filter(r => r.status === "Open").length}</div></div>
        <div class="stat"><div class="l">Joining this week</div><div class="v">${D.people.filter(p => p.type === "Joiner").length}</div></div>
        <div class="stat"><div class="l">Late tasks</div><div class="v${late.length ? " bad" : ""}">${late.length}</div></div>
      </div>
      <div class="cols"><div class="mainc">
        <div class="card"><h4><span class="kind">Needs you</span><a href="#today" class="link" style="font-size:13px;font-weight:500">${top.length < open.length ? `Top ${top.length} of ${open.length} · see all` : "See all"}</a></h4>
        ${top.length ? top.map(t => `<div class="item"><span class="pill ${whenPill(t.when)}">${esc(t.when)}</span><div class="t">${esc(t.title)}<small>${esc(t.ctx)}</small>${t.key === "chase" ? '<div class="suggest"><b>Desk suggests:</b> nudge Arjun on WhatsApp now and escalate to Vikram at 4 pm.</div>' : t.key === "offer" ? '<div class="suggest"><b>Desk suggests:</b> fix the salary structure before sending; it fails the 50% wages check.</div>' : ""}</div><button class="btn${t.when === "Late" ? " primary" : ""}" type="button" data-v="task" data-key="${esc(t.key)}">Do it with Desk</button></div>`).join("") : '<div class="emptyv">All clear.</div>'}</div>
        <div class="card"><h4><span class="kind">Recent activity</span></h4>${D.audit.length ? D.audit.slice(-4).reverse().map(a => `<div class="item"><span class="pill p-ok">Approved</span><div class="t">${esc(a.what)}<small>by ${esc(a.by)} at ${a.at.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })}</small></div></div>`).join("") : '<div class="emptyv">Nothing approved yet today. Actions you take in Desk show up here.</div>'}</div>
      </div><div class="side">
        <div class="card"><h4><span class="kind">Coming up</span><a href="#interviews" class="link" style="font-size:13px;font-weight:500">Interviews</a></h4>${D.interviews.filter(i => i.confirmed !== undefined).map(i => `<div class="item"><div class="t">${esc(i.cand)}<small>${esc(i.when)} · ${esc(roleOf(i.role).title)}</small></div><span class="pill ${ivStatus(i)[0]}">${ivStatus(i)[1]}</span></div>`).join("")}</div>
        <div class="card"><h4><span class="kind">Pipeline</span><a href="#hiring" class="link" style="font-size:13px;font-weight:500">Jobs</a></h4><div class="bars">${["Applied", "Screened", "Interview", "Offer"].map(s => `<div><span>${s}</span><span class="b"><i style="width:${(stageTot(s) / max) * 100}%"></i></span><span>${stageTot(s)}</span></div>`).join("")}</div></div>
        <div class="card"><h4><span class="kind">Desk insight</span></h4><div class="c"><div class="suggest" style="margin:0">Engineering interview feedback is the main delay this week: 2 scorecards are past 24 hours. Chasing them clears the Backend Developer pipeline.</div>${ask("Chase Arjun Mehta", "Fix it with Desk")}</div></div>
      </div></div>`;
  }
  if (currentTab === "interviews") {
    return head("Interviews", "Feedback is due within 24 hours of each interview") +
      `<div class="card"><div class="tablewrap"><table><tr><th>When</th><th>Candidate</th><th>Role</th><th>Round</th><th>Panel</th><th>Status</th></tr>
      ${D.interviews.map(i => { const [pc, pl] = ivStatus(i), p = person(i.cand); return `<tr class="click" data-v="person" data-pid="${p.id}" tabindex="0"><td>${esc(i.when)}</td><td style="font-weight:500">${esc(i.cand)}</td><td>${esc(roleOf(i.role).title)}</td><td>${esc(i.round)}</td><td>${esc(i.panel)}</td><td><span class="pill ${pc}">${pl}</span></td></tr>`; }).join("")}
      </table></div></div>
      <div class="row">${task("chase").done ? "" : ask("Chase Arjun Mehta", "Chase late feedback with Desk", true)}${ask("Send Arjun Rao a confirmation for today's screen call", "Confirm Arjun Rao with Desk")}</div>`;
  }
  if (currentTab === "approvals") {
    const pend = D.pending.length ? D.pending.map(p => `<div class="item"><span class="pill p-warn">Waiting</span><div class="t">${esc(p.what)}<small>Drafted by Ritu · also sent to ${esc(phoneLabel())} on WhatsApp</small></div><button class="btn primary" type="button" data-v="review" data-pid="${p.id}" data-what="${esc(p.what)}">Review in Desk</button></div>`).join("")
      : `<div class="emptyv">${mode === "solo" ? 'Nothing waiting. In Solo setup, what you approve in Desk goes out straight away. <button class="link" type="button" data-v="mode" data-mode="lead">Switch to Lead + juniors</button> to use the review queue.' : "Nothing waiting for your approval."}</div>`;
    return head("Approvals", "Nothing reaches a candidate or employee without a named approval") +
      `<div class="card"><h4><span class="kind">Waiting for ${esc(first())}</span></h4>${pend}</div>
       <div class="card"><h4><span class="kind">Approval log</span></h4>${D.audit.length ? D.audit.map(a => `<div class="item"><span class="pill p-ok">Approved</span><div class="t">${esc(a.what)}<small>by ${esc(a.by)} at ${a.at.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })}</small></div></div>`).join("") : '<div class="emptyv">No approvals yet today.</div>'}</div>`;
  }
  if (currentTab === "insights") {
    const sent = D.people.filter(p => p.stage === "Rejected").length;
    return head("Insights", "How hiring is running this month · all figures are sample data", ask("Prepare a monthly recruitment summary for the founder", "Ask Desk for a summary")) +
      `<div class="stats">
        <div class="stat"><div class="l">First reply within 24h</div><div class="v">92% <small>target 95%</small></div></div>
        <div class="stat"><div class="l">Feedback within 24h</div><div class="v">${task("chase").done ? "90%" : "87%"} <small>target 90%</small></div></div>
        <div class="stat"><div class="l">Average days to hire</div><div class="v">34</div></div>
        <div class="stat"><div class="l">Candidates told the outcome, with a reason</div><div class="v">100% <small>within 7 days</small></div></div>
      </div>
      <div class="cols"><div class="mainc"><div class="card"><h4><span class="kind">Days spent in each stage</span>All roles, average</h4><div class="bars">
        <div><span>Applied</span><span class="b"><i style="width:30%"></i></span><span>4.2</span></div>
        <div><span>Screened</span><span class="b"><i style="width:36%"></i></span><span>5.0</span></div>
        <div><span>Interview</span><span class="b"><i class="warn" style="width:100%"></i></span><span>13.8</span></div>
        <div><span>Offer</span><span class="b"><i style="width:57%"></i></span><span>7.9</span></div></div></div></div>
      <div class="side"><div class="card"><h4><span class="kind">What stands out</span></h4><div class="c"><div class="suggest" style="margin:0">Interviews take longest, mostly waiting on panel feedback. Faster reminders matter more than more sourcing.</div>${ask("Create an action plan to get feedback on time above 90%", "Make an action plan")}</div></div></div></div>`;
  }
  if (currentTab === "integrations") {
    const row = (n, d, state, pill) => `<div class="setting"><div><b style="font-weight:500">${n}</b><small>${d}</small></div><span class="pill ${pill}">${state}</span></div>`;
    return head("Integrations", "Connect the tools your team already uses") +
      `<div class="card">${row("Email sign-in codes", "Supabase sends the 6-digit code to your inbox", "Setup needed", "p-warn")}
       ${row("WhatsApp", "Approvals to " + esc(profile?.phone || "your number") + ", nudges to managers and IT", "Sandbox not connected", "p-warn")}
       ${row("Gmail", "Send approved letters and offers from your address", "Not connected", "p-mut")}
       ${row("Google Calendar", "Panel availability and interview invites", "Not connected", "p-mut")}
       ${row("Existing ATS or HRMS", "Import roles and candidates", "Later", "p-mut")}</div>
       <p class="note">Live connections need your approval and a security review. Nothing is connected in this preview.</p>`;
  }
  if (currentTab === "settings") {
    return head("Settings", "Acme Fintech · Hyderabad · sample company for this preview") +
      `<div class="card"><h4><span class="kind">Team setup</span></h4>
        <div class="setting"><div><b style="font-weight:500">Who handles HR and hiring</b><small>${mode === "solo" ? "Just me: what I approve goes out straight away" : "Me and juniors: anything reaching a candidate or employee needs my approval"}</small></div>
        <div class="seg" role="group" aria-label="Team setup"><button type="button" data-v="mode" data-mode="solo" aria-pressed="${mode === "solo"}">Solo</button><button type="button" data-v="mode" data-mode="lead" aria-pressed="${mode === "lead"}">Lead + juniors</button></div></div>
        <div class="setting"><div><b style="font-weight:500">Separate recruiting and HR teams</b><small>Handoff at offer accepted</small></div><span class="pill p-mut">Coming later</span></div></div>
      <div class="card"><h4><span class="kind">Response targets</span><span class="pill p-mut">Automatic reminders: planned</span></h4>
        <div class="setting"><div><b style="font-weight:500">First reply to applicants</b><small>Escalates to the hiring lead when missed</small></div><span class="pill p-mut">24 hours</span></div>
        <div class="setting"><div><b style="font-weight:500">Interview feedback</b><small>Reminder at 4 hours, escalation at 24 hours</small></div><span class="pill p-mut">24 hours</span></div>
        <div class="setting"><div><b style="font-weight:500">Probation review</b><small>Manager review due 15 days before the end date</small></div><span class="pill p-mut">15 days</span></div></div>
      <div class="card"><h4><span class="kind">Live Desk agent (beta)</span><span class="pill ${liveDesk ? "p-ok" : "p-mut"}">${liveDesk ? "On" : "Off"}</span></h4>
        <div class="setting"><div><b style="font-weight:500">Use the live agent in Ask Desk</b><small>${auth.LIVE ? "Desk answers with the real AI model and saves to your workspace in Supabase. Approvals still need your tap." : "Sign in with your email to use it."}</small></div>
          ${auth.LIVE ? `<div class="seg" role="group" aria-label="Live Desk agent"><button type="button" data-v="liveToggle" aria-pressed="${!liveDesk}">Off</button><button type="button" data-v="liveToggle" aria-pressed="${liveDesk}">On</button></div>` : '<span class="pill p-mut">Needs sign-in</span>'}</div>
        <div class="setting"><div><b style="font-weight:500">Sample data in my workspace</b><small>Loads Acme-style roles, candidates, a joiner and a probation review into your own empty workspace, so the live agent has something to work on.</small></div>
          ${auth.LIVE ? '<button class="btn" type="button" data-v="loadSample">Load sample data</button>' : '<span class="pill p-mut">Needs sign-in</span>'}</div></div>
      <div class="card"><h4><span class="kind">How Desk may act</span></h4>
        <div class="setting"><div><b style="font-weight:500">Drafts only</b><small>Nothing reaches a candidate or employee without a named approval</small></div><span class="pill p-ok">Working in preview</span></div>
        <div class="setting"><div><b style="font-weight:500">Rejection reasons</b><small>Fixed job-relevant list; age, gender, marital status, religion, caste and pregnancy are blocked</small></div><span class="pill p-ok">Working in preview</span></div>
        <div class="setting"><div><b style="font-weight:500">Salary and law checks</b><small>Calculated by fixed rules, never by AI. Awaiting legal review.</small></div><span class="pill p-ok">Working in preview</span></div>
        <div class="setting"><div><b style="font-weight:500">Data stored in India (Mumbai)</b><small>This preview keeps sample data in your browser only</small></div><span class="pill p-mut">Planned</span></div>
        <div class="setting"><div><b style="font-weight:500">Aadhaar masked, consent recorded at upload</b><small>Built into the database design, not live yet</small></div><span class="pill p-mut">Planned</span></div>
        <div class="setting"><div><b style="font-weight:500">No training on customer data</b><small>Applies once the AI model is connected</small></div><span class="pill p-mut">Planned</span></div></div>`;
  }
  return "";
}

/* =================== START =================== */
(async () => {
  try { user = await auth.currentUser(); if (user) return afterSignIn(); } catch { /* fall through to sign-in */ }
  show("s-email");
})();
