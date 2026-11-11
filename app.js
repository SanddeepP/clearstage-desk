import * as auth from "./auth.js";
import { checkWagesRule, fixStructure, formatINR } from "./lib/ctc.js";

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
const screens = ["s-email", "s-code", "s-setup", "s-app"];
function show(id) { screens.forEach(s => { $("#" + s).hidden = s !== id; }); }
function err(el, msg) { const e = $(el); e.textContent = msg || ""; e.hidden = !msg; }
function busy(btn, on, label) { btn.disabled = on; if (label) btn.textContent = label; }

/* =================== SIGN IN =================== */
let pendingEmail = "", user = null, profile = null, resendTimer = null;

$("#modeNote").textContent = auth.LIVE
  ? "Codes are sent by email. Check spam if it doesn't arrive in a minute."
  : "Demo mode: email sending isn't connected yet, so your code appears on the next screen.";

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
    show("s-code"); $("#code").focus(); startResend();
  } catch (x) { err("#emailErr", x.message); }
  finally { busy(btn, false, "Send code"); }
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
$("#code").addEventListener("input", e => { e.target.value = e.target.value.replace(/\D/g, "").slice(0, 6); if (e.target.value.length === 6) $("#codeForm").requestSubmit(); });

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
  const name = $("#fullName").value.trim(), company = $("#company").value.trim();
  const phone = $("#phone").value.replace(/[\s-]/g, "");
  if (!name || !company) return err("#setupErr", "Add your name and company name.");
  if (phone && !/^\+?\d{10,13}$/.test(phone)) return err("#setupErr", "Enter the WhatsApp number with country code, like +91 98765 43210.");
  const p = { name, company, city: $("#city").value.trim(), phone: phone ? (phone.startsWith("+") ? phone : "+91" + phone.slice(-10)) : "", setup: document.querySelector("input[name=setup]:checked").value };
  const btn = $("#setupBtn"); busy(btn, true, "Setting up…");
  try { profile = await auth.saveProfile(user, p); openApp(); }
  catch (x) { err("#setupErr", x.message); }
  finally { busy(btn, false, "Open Desk"); }
});

$("#signOut").addEventListener("click", async () => { await auth.signOut(); user = null; profile = null; $("#email").value = ""; show("s-email"); });

/* =================== DESK =================== */
const inner = $("#inner"), log = $("#log"), ph = $("#ph"), chipsEl = $("#chips");
let S;
const first = () => (profile?.name || "there").split(/\s+/)[0];
const phoneLabel = () => profile?.phone ? `you · ${profile.phone}` : "you";

function openApp() {
  $("#coLine").textContent = `${profile.company} · Desk is using Acme Fintech sample data for this test`;
  S = null; init(profile.setup === "lead_juniors" ? "lead" : "solo");
  show("s-app"); $("#q").focus();
}

function init(mode) {
  S = { mode: mode || S?.mode || "solo", roles: 3, late: 2, join: 1, prob: 1, queue: 0, done: {} };
  inner.innerHTML = ""; ph.innerHTML = '<div class="empty">Messages Desk sends appear here.</div>';
  paint(); brief();
}
function paint() {
  set("#t-roles", S.roles); set("#t-late", S.late); set("#t-join", S.join); set("#t-prob", S.prob); set("#t-queue", S.queue);
  $("#t-late").classList.toggle("late", S.late > 0);
  $("#t-queue").hidden = S.mode !== "lead";
  $("#who").textContent = S.mode === "solo" ? `You: ${first()} (HR & hiring)` : `Acting as Ritu (junior) · ${first()} approves`;
  $("#m-solo").setAttribute("aria-pressed", S.mode === "solo"); $("#m-lead").setAttribute("aria-pressed", S.mode === "lead");
}
function set(sel, v) { const el = $(sel), b = el.querySelector("b"); if (b.textContent !== String(v)) { b.textContent = v; el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash"); } }
const scroll = () => { log.scrollTop = log.scrollHeight; };
function me(t) { const d = document.createElement("div"); d.className = "msg me"; d.innerHTML = `<div class="bubble">${esc(t)}</div>`; inner.append(d); scroll(); }
function desk(html) { const d = document.createElement("div"); d.className = "msg"; d.innerHTML = `<div class="av" aria-hidden="true">D</div><div class="mbody">${html}</div>`; inner.append(d); bind(d); scroll(); return d; }
const later = (fn, ms = 500) => setTimeout(fn, ms);
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
}
function reply(t) { const d = document.createElement("div"); d.className = "wam out"; d.textContent = t; ph.append(d); ph.scrollTop = ph.scrollHeight; }

function defaults() {
  chips([["Chase Arjun", chase], ["Draft Sneha's letter", letter], ["Show my pipeline", pipeline], ["Hire 2 sales execs in Pune", hire],
    ["Reject candidates who failed the test", bulk], ["Start Priya's probation review", probation], ["Wrap up my day", wrap]]);
}

// Pencil & Ink: AI output is a draft until a named person approves it. Every approval is logged.
const audit = [];
function logApproval(what, by) { audit.push({ what, by, at: new Date() }); }
function approve(btn, what, after) {
  btn.closest(".card").querySelectorAll("button").forEach(x => x.disabled = true);
  if (S.mode === "solo") { logApproval(what, first()); after(); return; }
  S.queue++; paint();
  say(`Sent <b>${esc(what)}</b> to ${esc(first())} for approval on WhatsApp. It goes out once approved.`);
  wa(phoneLabel(), `Ritu drafted <b>${esc(what)}</b>. Approve it?`, [
    ["Approve", () => { S.queue--; paint(); logApproval(what, first()); say(`<span class="pill p-ok">Approved by ${esc(first())}</span>`); after(); }],
    ["Send back with a comment", () => { S.queue--; paint(); say(`${esc(first())} sent it back: <i>"Add the joining bonus clause."</i> I've reopened the draft.`); }]]);
}

function brief() {
  const h = new Date().getHours(), hi = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  desk(`<div class="bubble">${hi}, ${esc(first())}. Here's your HR for today. About 15 minutes of work.</div>
  <div class="card"><h4><span class="kind">Brief</span><span class="pill p-late">2 late</span><span class="pill p-warn">1 due soon</span></h4>
   <div class="item"><span class="pill p-late">Late</span><div class="t">Arjun hasn't given feedback on 2 candidates<small>Backend Developer · 26 hours overdue · escalates to Vikram at 4 pm</small></div><button class="btn primary" type="button" data-a="chase" data-once>Chase him</button></div>
   <div class="item"><span class="pill p-late">Late</span><div class="t">Sneha joins Monday with no appointment letter<small>Every joiner needs one before Day 1</small></div><button class="btn primary" type="button" data-a="letter" data-once>Draft it</button></div>
   <div class="item"><span class="pill p-warn">Due soon</span><div class="t">Priya's probation ends on 23 Nov<small>Manager review is due before the end date</small></div><button class="btn primary" type="button" data-a="probation" data-once>Start review</button></div>
  </div>`);
  defaults();
}
ACT.chase = () => { me("Chase Arjun"); chase(); };
ACT.letter = () => { me("Draft Sneha's letter"); letter(); };
ACT.probation = () => { me("Start Priya's probation review"); probation(); };
ACT.noop = () => say("In the full product this opens the draft for editing.");

function chase() {
  if (S.done.chase) return say("Already chased. I'll escalate to Vikram at 4 pm if Arjun stays silent.");
  S.done.chase = 1;
  later(() => {
    say(`Done. I sent Arjun a WhatsApp nudge with one-tap scoring. If he doesn't reply, I'll escalate to Vikram (Head of Engineering) at 4 pm.<div class="why" style="margin-top:6px">Why it matters: candidates who wait more than 3 days for an update often take another offer.</div>`);
    wa("Arjun (interviewer)", "Feedback pending for <b>Ankit Verma</b>, Backend Developer, interviewed yesterday. Reply with a score, or tap:",
      [["Ankit: 4/5, strong APIs, weak SQL. Next round.", feedback], ["Ankit: 2/5, not a fit", feedbackNo]]);
    chips([["Show my pipeline", pipeline], ["Draft Sneha's letter", letter]]);
  });
}
function feedback() {
  S.late = Math.max(0, S.late - 1); paint();
  desk(`<div class="bubble">Arjun replied on WhatsApp. I turned it into a scorecard:</div>
  <div class="card"><h4><span class="kind">Scorecard</span>Ankit Verma · Backend Developer <span class="pill p-ok">Feedback in</span></h4><div class="c">
  <table><tr><th>Criterion</th><th>Score</th></tr><tr><td>API design</td><td>4 / 5</td></tr><tr><td>SQL</td><td>2 / 5</td></tr><tr><td>Overall</td><td>4 / 5</td></tr></table>
  <div class="row"><span class="note">Arjun recommends: next round</span><span class="spacer"></span><button class="btn" type="button" data-a="rejectOne">Reject with reason</button><button class="btn primary" type="button" data-a="advance" data-once>Move to Round 2</button></div></div></div>`);
}
function feedbackNo() { S.late = Math.max(0, S.late - 1); paint(); say("Arjun scored Ankit 2/5, not a fit. Want me to draft a rejection with a job-relevant reason?"); chips([["Yes, draft it", bulk]]); }
ACT.advance = b => {
  const d = say(`Moved Ankit to Round 2 and drafted his update: <i>"Round 2 with the Head of Engineering. You'll hear from us by Thu 19 Nov."</i> <span class="undo">· <button class="link" type="button">Undo</button> (10 min)</span>`);
  const u = d.querySelector(".undo button"); const t = setTimeout(() => d.querySelector(".undo")?.remove(), 10 * 60 * 1000);
  u.onclick = () => { clearTimeout(t); d.querySelector(".undo").remove(); b.disabled = false; say("Undone. Ankit is back in Round 1 and no update was sent."); };
};
ACT.rejectOne = () => reasonPicker("Ankit Verma");

const REASONS = [["skills_gap", "Skills don't match the role's must-haves"], ["assessment_below_bar", "Assessment score below the bar"], ["experience_mismatch", "Experience level doesn't match"],
  ["salary_mismatch", "Salary expectation outside the budget"], ["location_mismatch", "Location or work mode doesn't fit"], ["notice_period", "Notice period too long"], ["role_filled", "Role has been filled"]];
function reasonPicker(name) {
  desk(`<div class="card"><h4><span class="kind">Rejection</span>${esc(name)}</h4><div class="c">
   <label class="field" for="rr">Reason (job-relevant only)<select id="rr">${REASONS.map(r => `<option value="${r[0]}">${r[1]}</option>`).join("")}</select></label>
   <div class="why">Reasons come from a fixed list. Text about age, gender, marital status, religion, caste or pregnancy is blocked.</div>
   <div class="row"><button class="btn primary" type="button" data-a="sendReject">Approve &amp; send</button></div></div></div>`);
}
ACT.sendReject = b => { const r = b.closest(".card").querySelector("select"); const label = r.options[r.selectedIndex].text; approve(b, `a rejection note to Ankit (${label.toLowerCase()})`, () => say("Sent. Ankit's status page is closed with that reason.")); };

function letter() {
  if (S.done.letter) return say("Sneha's letter is already handled.");
  S.done.letter = 1;
  later(() => desk(`<div class="bubble">Here's Sneha's appointment letter, filled from her accepted offer.</div>
  <div class="card draft"><h4><span class="kind">Approval</span>Appointment letter · Sneha Rao <span class="pill p-acc">Draft</span></h4><div class="c">
  <div class="doc">Dear Sneha,
We are pleased to appoint you as Product Designer at Acme Fintech Pvt Ltd, effective Mon 16 Nov 2026.
CTC: ₹9,60,000 per year (breakdown in Annexure A). Probation: 6 months.
Notice period: 30 days after confirmation …</div>
  <div class="why">Filled from the offer approved on 2 Nov. Template from the Clearstage playbook. Not legal advice.</div>
  <div class="row"><button class="btn primary" type="button" data-a="sendLetter">Approve &amp; send</button><button class="btn" type="button" data-a="noop">Edit</button><button class="btn" type="button" data-a="rejectDraft">Reject</button></div></div></div>`));
}
ACT.rejectDraft = b => { b.closest(".card").querySelectorAll("button").forEach(x => x.disabled = true); say("Draft discarded. Nothing was sent."); };
ACT.sendLetter = b => approve(b, "Sneha's appointment letter", () => { S.late = Math.max(0, S.late - 1); paint(); say("Sent to Sneha for e-acknowledgement. Her joiner checklist is on track for Monday."); });

function hire() { later(() => { say("Got it: 2 Sales Executives in Pune, ₹4–5 L. Two quick questions so I set this up right. How much experience?"); chips([["1–3 years", hire2], ["Freshers are fine", hire2]]); }); }
function hire2() { later(() => { say("When do you need them to start?"); chips([["Within 30 days", hire3], ["Within 60 days", hire3]]); }); }
function hire3() {
  later(() => {
    desk(`<div class="bubble">Here's the role. I used the Sales Executive preset.</div>
  <div class="card draft"><h4><span class="kind">Approval</span>Sales Executive · Pune · 2 openings <span class="pill p-acc">Needs approval</span></h4><div class="c">
  <table><tr><td>Budget</td><td>₹4–5 L CTC each</td></tr><tr><td>Stages</td><td>Screen call → Role-play → Manager → Offer</td></tr><tr><td>Job description</td><td>Drafted (B2B fintech sales, field + inside)</td></tr><tr><td>Target fill date</td><td>Thu 10 Dec 2026</td></tr></table>
  <div class="row"><button class="btn primary" type="button" data-a="sendRole" data-once>Send for approval on WhatsApp</button><button class="btn" type="button" data-a="noop">Edit JD</button></div></div></div>`);
    defaults();
  });
}
ACT.sendRole = () => {
  say(`Sent to ${esc(phoneLabel())} on WhatsApp. One word approves it.`);
  wa(phoneLabel(), "New role to approve: <b>2 × Sales Executive, Pune</b>, ₹4–5 L each, start within 30 days. Reply YES to approve.", [
    ["YES", () => { S.roles++; paint(); logApproval("Sales Executive role", first()); say(`<span class="pill p-ok">Approved by ${esc(first())}</span> The role is live. I'll acknowledge every applicant within 24 hours.`); }],
    ["Make it 1 opening", () => { S.roles++; paint(); say("Approved with 1 opening instead of 2. I've updated the role and it's live."); }]]);
};

function pipeline() {
  later(() => {
    desk(`<div class="bubble">Backend Developer pipeline. Tap a candidate.</div>
  <div class="card"><h4><span class="kind">Pipeline</span>Backend Developer · 21 days open <span class="pill p-warn">1 offer pending</span></h4><div class="c"><div class="board">
  <div class="col"><h5>Applied · 12</h5><button class="cand" type="button" data-a="noop">Farah K.</button><button class="cand" type="button" data-a="noop">Dev P.</button><span class="note">+10 more</span></div>
  <div class="col"><h5>Screened · 5</h5><button class="cand" type="button" data-a="noop">Neha J.</button><button class="cand" type="button" data-a="noop">Rohan M.</button><span class="note">+3 more</span></div>
  <div class="col"><h5>Interview · 3</h5><button class="cand" type="button" data-a="noop">Ankit V.</button><button class="cand" type="button" data-a="noop">Lakshmi R.</button><button class="cand" type="button" data-a="noop">Sameer T.</button></div>
  <div class="col"><h5>Offer · 1</h5><button class="cand hot" type="button" data-a="offer">Kiran S. → build offer</button></div>
  </div></div></div>`);
    chips([["Build Kiran's offer", offer], ["Reject candidates who failed the test", bulk]]);
  });
}
ACT.offer = () => { me("Build Kiran's offer"); offer(); };

// Kiran's offer: ₹12 L, deliberately failing the 50% wages check (seed data)
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
  later(() => desk(`<div class="bubble">Kiran's offer at ₹12 L. I checked the structure before anything goes out.</div>
  <div class="card draft"><h4><span class="kind">Offer · CTC</span>Kiran S. · Backend Developer <span class="pill p-late">Check failed</span></h4><div class="c">${ctcBlock(KIRAN)}
  <div class="row"><button class="btn primary" type="button" data-a="fixCtc" data-once>Fix the structure for me</button><button class="btn" type="button" data-a="noop">Edit</button></div></div></div>`));
}
ACT.fixCtc = b => {
  const card = b.closest(".card"), c = b.closest(".c"); const fixed = fixStructure(KIRAN);
  c.innerHTML = ctcBlock(fixed) + `<div class="row"><button class="btn primary" type="button" data-a="sendOffer">Approve &amp; send offer</button></div>`;
  bind(c); card.querySelector("h4 .pill").outerHTML = '<span class="pill p-ok">Check passed</span>';
};
ACT.sendOffer = b => approve(b, "Kiran's offer letter", () => { say("Offer sent to Kiran, valid for 3 days. I'll remind him on day 2."); chips([["Kiran accepted the offer", accepted], ["Show my pipeline", pipeline]]); });

function accepted() {
  S.join++; paint();
  later(() => {
    desk(`<div class="bubble">Kiran accepted. I created his employee record and started onboarding. Joining Mon 30 Nov.</div>
  <div class="card"><h4><span class="kind">Joiner checklist</span>Kiran S. · Day 1 on Mon 30 Nov <span class="pill p-acc">On track</span></h4>
   <div class="item"><span class="pill p-ok">Done</span><div class="t">Document upload link sent to Kiran<small>PAN, Aadhaar (masked), education, last payslip · consent recorded</small></div></div>
   <div class="item"><span class="pill p-warn">Due 25 Nov</span><div class="t">Appointment letter<small>Owner: you</small></div><button class="btn" type="button" data-a="noop">Draft now</button></div>
   <div class="item"><span class="pill p-warn">Due 27 Nov</span><div class="t">Laptop and email account<small>Owner: Suresh (IT) · reminder set on WhatsApp</small></div></div>
   <div class="item"><span class="pill p-acc">Planned</span><div class="t">Day 1 plan and buddy (Arjun)<small>30-60-90 plan from the playbook</small></div></div>
   <div class="item"><span class="pill p-acc">Scheduled</span><div class="t">Probation review with Arjun, due 14 May 2027<small>15 days before the 6-month end date</small></div></div>
  </div><div class="why">From offer accepted to Day 1 to confirmation: one record, nothing re-entered.</div>`);
    wa("Suresh (IT)", "New joiner <b>Kiran S.</b> on Mon 30 Nov. Laptop and email needed by Fri 27 Nov.", [["Will do", () => say("Suresh confirmed the laptop and email for Kiran.")]]);
    defaults();
  });
}

function bulk() {
  later(() => desk(`<div class="bubble">4 candidates scored below 60% on the Excel assessment for Operations Analyst. Here's the draft, with a job-relevant reason for each.</div>
  <div class="card draft"><h4><span class="kind">Bulk preview</span>Reject 4 · Operations Analyst <span class="pill p-acc">Preview</span></h4>
   <div class="item"><div class="t">Megha D. · 48%</div></div><div class="item"><div class="t">Imran S. · 52%</div></div><div class="item"><div class="t">Tarun B. · 41%</div></div><div class="item"><div class="t">Pooja N. · 55%</div></div>
   <div class="c"><div class="doc">Hi {name}, thank you for your time with Acme Fintech. We won't move forward with your application for Operations Analyst. The role needs advanced Excel modelling, and your assessment score ({score}) was below the 60% we need. We'd welcome an application for future roles.</div>
   <div class="why">Reason: assessment score below the bar. Reasons come from a fixed job-relevant list.</div>
   <div class="row"><button class="btn primary" type="button" data-a="sendBulk">Send all 4</button><button class="btn" type="button" data-a="noop">Review each</button></div></div></div>`));
}
ACT.sendBulk = b => approve(b, "4 rejection notes", () => say("Sent. All 4 status pages are closed with a reason. Candidates told within 7 days this week: 100%."));

function probation() {
  if (S.done.prob) return say("Priya's review is already with Vikram.");
  S.done.prob = 1;
  later(() => {
    say("I sent Vikram, Priya's manager, a 3-question review on WhatsApp, due in 3 days. I'll escalate if it slips.");
    wa("Vikram (manager)", "Priya Nair's probation ends on 23 Nov. Your call:", [
      ["Confirm Priya", () => desk(`<div class="bubble">Vikram recommends confirming Priya. Here's the letter.</div>
       <div class="card draft"><h4><span class="kind">Approval</span>Confirmation letter · Priya Nair <span class="pill p-acc">Draft</span></h4><div class="c"><div class="doc">Dear Priya,
We are happy to confirm your employment as Customer Success Associate with effect from 23 Nov 2026 …</div>
       <div class="row"><button class="btn primary" type="button" data-a="sendConf">Approve &amp; send</button><button class="btn" type="button" data-a="noop">Edit</button></div></div></div>`)],
      ["Extend by 3 months", () => say("Vikram wants an extension. I'll draft the extension letter with his reasons and set a new review date.")]]);
  });
}
ACT.sendConf = b => approve(b, "Priya's confirmation letter", () => { S.prob = Math.max(0, S.prob - 1); paint(); say("Sent. Priya acknowledged it."); });

function wrap() {
  later(() => desk(`<div class="bubble">Here's your day.</div>
  <div class="card"><h4><span class="kind">End of day</span>${new Date().toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" })}</h4>
   <div class="item"><span class="pill p-ok">Approved</span><div class="t">${audit.length} item${audit.length === 1 ? "" : "s"} approved today<small>${audit.length ? audit.map(a => esc(a.what) + " by " + esc(a.by)).join(" · ") : "Nothing approved yet"}</small></div></div>
   <div class="item"><span class="pill ${S.late ? "p-late" : "p-ok"}">${S.late ? "Late" : "Clear"}</span><div class="t">${S.late} late item${S.late === 1 ? "" : "s"} left<small>${S.late ? "I'll put them first in tomorrow's brief." : "Nothing is late."}</small></div></div>
  </div>`));
}

function blocked(s) { return /\b(age|old|young|gender|female|male|woman|women|man|married|marital|single|pregnan\w*|religio\w*|hindu|muslim|christian|caste|kids?|children)\b/i.test(s); }

function route(t) {
  const s = t.toLowerCase();
  if (/reject|nahi lena|drop/.test(s) && blocked(s)) {
    say("I can't use that as a rejection reason. Reasons must be about the job, like skills, assessment score, experience, salary, location or notice period. Want me to pick a job-relevant reason?");
    return chips([["Show job-relevant reasons", () => reasonPicker("this candidate")]]);
  }
  if (/\barjun\b/.test(s) && /\b(rao|mehta)\b/.test(s) === false && /reject|offer|move/.test(s)) {
    say("Do you mean Arjun Rao (candidate, Operations Analyst) or Arjun Mehta (interviewer)?");
    return chips([["Arjun Rao", () => say("Got it, Arjun Rao. What should I do with his application?")], ["Arjun Mehta", chase]]);
  }
  if (/chase|feedback|arjun/.test(s)) return chase();
  if (/sneha|appointment|letter/.test(s)) return letter();
  if (/hire|sales|role|opening|chahiye|karna hai/.test(s)) return hire();
  if (/pipeline|board|candidates?$/.test(s)) return pipeline();
  if (/reject|failed/.test(s)) return bulk();
  if (/kiran|offer|ctc|salary structure/.test(s)) return offer();
  if (/accept/.test(s)) return accepted();
  if (/probation|priya|confirm/.test(s)) return probation();
  if (/wrap|end of day|summary|aaj kya hua/.test(s)) return wrap();
  if (/today|brief|morning|kya hai|aaj/.test(s)) return brief();
  later(() => { say(`I didn't catch that one yet. Try a suggestion below, or something like <i>"Pune mein 2 sales execs hire karna hai"</i>.`); defaults(); });
}

$("#ask").addEventListener("submit", e => { e.preventDefault(); const v = $("#q").value.trim(); if (!v) return; me(v); $("#q").value = ""; route(v); });
$("#file").addEventListener("change", e => {
  const f = e.target.files[0]; if (!f) return; e.target.value = "";
  me(`Uploaded ${f.name}`);
  later(() => desk(`<div class="bubble">Got <b>${esc(f.name)}</b>. Which role is this CV for?</div>`) && chips([["Backend Developer", () => say("Added to Backend Developer as Applied. In the full product I read the CV and fill in the details; here it's a placeholder record.")], ["Operations Analyst", () => say("Added to Operations Analyst as Applied.")]]));
});
$("#m-solo").onclick = () => { S.mode = "solo"; paint(); say("Switched to <b>Solo</b>. You own everything, and what you approve goes out straight away."); };
$("#m-lead").onclick = () => { S.mode = "lead"; paint(); say(`Switched to <b>Lead + juniors</b>. You're now acting as Ritu, a junior. Anything that reaches a candidate or employee goes to ${esc(first())} for one-tap approval on WhatsApp.`); };
$("#restart").onclick = () => init();
$("#waToggle").onclick = () => { const w = $("#wa"); w.classList.add("open"); $("#waToggle").setAttribute("aria-expanded", "true"); $("#waToggle").textContent = "WhatsApp"; };
$("#waClose").onclick = () => { $("#wa").classList.remove("open"); $("#waToggle").setAttribute("aria-expanded", "false"); };

/* =================== START =================== */
(async () => {
  try { user = await auth.currentUser(); if (user) return afterSignIn(); } catch { /* fall through to sign-in */ }
  show("s-email");
})();
