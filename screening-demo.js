// Screening demo (PM brief 15 Nov; CTO Tech Decisions §1.1–1.3). Sample data only: nothing is sent and nothing
// is saved to Supabase. CVs go through the real pipeline in the browser — unzip (fflate), extract text (unpdf,
// mammoth), mask — and the evidence comes from the seed cache, keyed by file hash + requirements version, exactly
// where a cached AI result would come from. A CV that isn't in the sample set would need the live AI, which this
// demo doesn't call. Scores, stars, coverage and the top 10 are computed by plain code (lib/screening.js).
import { scoreCandidate, yearsFromRanges, newShortlist, offerToShortlist, leaveShortlist, pin, effectiveStars, overrideStars,
  reasonsFor, checkWeights, checkTerms, HUMAN_LOOK, TOP_N, MAX_PINS, evidencedIds } from "./lib/screening.js";
import { maskCv } from "./lib/mask.js";
import { cvText } from "./lib/cvtext.js";
import { sha256Hex, cacheKey } from "./lib/evidence.js";
import { closureClock, fmtIST as fmtWhen } from "./lib/clock.js";
import { REQUIREMENTS } from "./seed/screening/requirements.js";

// QA-017: application times and experience are measured from now, so every demo run looks fresh.
const STARS = n => n == null ? "" : `<span class="stars" aria-label="${n} of 5 stars">${"★".repeat(n)}<span class="off">${"★".repeat(5 - n)}</span></span>`;

export function createScreening(api) {
  const { esc } = api;
  let S;
  const reset = () => { S = { req: {}, cands: [], lists: {}, queue: null, seed: S?.seed || null, libs: S?.libs || null, filter: [], batchDone: {}, log: [], role: null }; };
  // Working marks (PM ruling 18 Nov): change only the recruiter's view, send nothing, move no stage, logged, undoable.
  const mark = what => { const a = { what: "Working mark: " + what, by: api.first(), at: new Date() }; api.D().audit.push(a); S.log.push(a); return a; };
  reset();

  /* ---------- data ---------- */
  async function seed() {
    if (!S.seed) S.seed = await fetch("seed/screening/seed-screening.json").then(r => r.json());
    return S.seed;
  }
  async function libs() {
    if (S.libs) return S.libs;
    const [unpdf, fflate] = await Promise.all([import("./vendor/unpdf/index.mjs"), import("./vendor/fflate.js")]);
    if (!window.mammoth) await new Promise((res, rej) => { const s = document.createElement("script"); s.src = "vendor/mammoth.browser.min.js"; s.onload = res; s.onerror = () => rej(new Error("Couldn't load the DOCX reader")); document.head.append(s); });
    return (S.libs = { unpdf, mammoth: window.mammoth, fflate });
  }
  const roleId = title => api.D().roles.find(r => r.title === title)?.id;
  const titleOf = rid => api.D().roles.find(r => r.id === rid)?.title;
  const reqOf = title => S.req[title];
  const candsFor = title => S.cands.filter(c => c.role === title);
  const list = title => (S.lists[title] ??= newShortlist());
  const roleTitleFromText = t => /\b(ops|operations)\b/i.test(t) ? "Operations Analyst" : "Backend Developer";

  /* ---------- SCR-1: requirements card (pencil until a named person confirms) ---------- */
  function draftReq(title) {
    if (!S.req[title]) { const base = REQUIREMENTS[title]; S.req[title] = JSON.parse(JSON.stringify({ ...base, confirmed: false, version: 1, edited: false })); }
    return S.req[title];
  }
  function reqCard(title) {
    const r = draftReq(title);
    // QA-018: the words that count for each requirement are shown, and the recruiter can edit them before confirming
    const items = (kind, arr) => arr.map(x => `<li><div><span>${esc(x.label)}</span>${r.confirmed ? `<small class="terms">Counts: ${esc((x.terms || []).join(", "))}</small>`
      : `<label class="terms">Counts:<input type="text" value="${esc((x.terms || []).join(", "))}" data-s="terms" data-role="${esc(title)}" data-kind="${kind}" data-id="${x.id}" aria-label="Words that count for ${esc(x.label)}"></label>`}</div>${r.confirmed ? "" : `<button class="link" type="button" data-s="rmreq" data-role="${esc(title)}" data-kind="${kind}" data-id="${x.id}" aria-label="Remove ${esc(x.label)}">Remove</button>`}</li>`).join("");
    const w = r.weights;
    const weights = r.confirmed ? `${w.must} / ${w.experience} / ${w.nice} / ${w.conditions}`
      : ["must", "experience", "nice", "conditions"].map(k => `<label class="wt">${{ must: "Must-haves", experience: "Experience", nice: "Nice-to-haves", conditions: "Conditions" }[k]}<input type="number" min="0" max="100" step="1" inputmode="numeric" value="${w[k]}" data-s="weight" data-role="${esc(title)}" data-k="${k}"></label>`).join("");
    return `<div class="card ${r.confirmed ? "inked" : "draft"} reqcard" data-reqcard="${esc(title)}"><h4><span class="kind">Requirements</span>${esc(title)} · v${r.version}${r.confirmed ? `<span class="inklabel">Confirmed by ${esc(r.confirmedBy)} · ${api.fmtIST(r.confirmedAt)}</span>` : ` <span class="pill p-warn">Confirm before screening</span>`}</h4><div class="c">
      <div class="why">${esc(r.drafted_from)}. Desk drafted this card; nothing is screened until you confirm it.</div>
      <div class="reqgrid"><div><h5>Must-haves · ${r.must.length}</h5><ul>${items("must", r.must)}</ul></div>
        <div><h5>Nice-to-haves · ${r.nice.length}</h5><ul>${items("nice", r.nice)}</ul></div>
        <div><h5>Experience</h5><ul><li>${r.experience.min}–${r.experience.max} years</li></ul><h5>Job conditions</h5><ul>${items("conditions", r.conditions)}</ul></div></div>
      <div class="weights"><b>Fit score weights</b> ${weights} <span class="note" data-wsum>${r.confirmed ? "" : "Whole numbers from 0 to 100, adding up to 100."}</span></div>
      <div class="note late-text" data-reqerr role="alert"></div>
      ${r.must.length < 3 ? '<div class="note">Fewer than 3 must-haves: the under-50% closure rule won\'t apply to this role.</div>' : ""}
      ${r.confirmed ? "" : `<div class="row"><button class="btn primary" type="button" data-s="confirm" data-role="${esc(title)}">Confirm requirements</button><span class="note">Stars and the top 10 are calculated by fixed rules from this card. The AI only finds quotes.</span></div>`}
    </div></div>`;
  }
  function confirmReq(title, card) {
    const r = draftReq(title);
    // QA-002: whole numbers 0–100 adding up to 100; QA-018: each requirement needs a specific word that counts
    const err = card.querySelector("[data-reqerr]");
    try { if (r.must.length < 1) throw new Error("Keep at least one must-have."); checkWeights(r.weights); checkTerms(r); }
    catch (e) { err.textContent = e.message + ". Nothing was confirmed."; return; }
    if (r.edited) r.version = 2;
    Object.assign(r, { confirmed: true, confirmedBy: api.first(), confirmedAt: new Date() });
    S.role = title;
    api.logApproval(`Requirements for ${title} (v${r.version})`, api.first());
    card.outerHTML = reqCard(title);
    api.say(`Confirmed. ${title} will be screened against v${r.version}. Upload the CVs (PDF, DOCX or a ZIP), or use the sample ZIP.`);
    uploadPrompt(title);
  }
  function uploadPrompt(title) {
    api.chips([[`Use the sample ZIP (${title === "Backend Developer" ? 30 : 10} CVs)`, () => sampleZip(title)], ["Upload CVs from my computer", () => pickFiles(title)]]);
  }

  /* ---------- JB-2: upload → one job per CV ---------- */
  function pickFiles(title) {
    const inp = document.createElement("input"); inp.type = "file"; inp.multiple = true; inp.accept = ".zip,.pdf,.docx";
    inp.onchange = () => inp.files.length && upload([...inp.files], title); inp.click();
  }
  async function sampleZip(title) {
    const name = title === "Backend Developer" ? "backend-developer-cvs.zip" : "operations-analyst-cvs.zip";
    api.me(`Upload ${name}`);
    const buf = new Uint8Array(await fetch("seed/screening/" + name).then(r => r.arrayBuffer()));
    return run([{ name, bytes: buf }], title);
  }
  /** QA-024: the role in the current context — the last confirmed requirements card, else the open role board. */
  const contextRole = () => S.role || S.boardRole || null;
  async function upload(files, title) {
    title ??= contextRole();
    if (!title) { api.say("Which role are these CVs for? Say \"Screen CVs for Backend Developer\" (or Operations Analyst) first, then upload."); return; }
    api.me(`Upload ${files.length === 1 ? files[0].name : files.length + " files"}`);
    return run(await Promise.all(files.map(async f => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }))), title);
  }
  async function run(inputs, title) {
    title ??= contextRole() || "Backend Developer";
    const r = reqOf(title);
    if (!r?.confirmed) { api.say(`First, confirm the requirements for ${esc(title)}. Nothing is screened before that.`); api.desk(reqCard(title)); return; }
    const L = await libs();
    // Expand ZIPs (fflate). Each CV becomes its own job in the queue, never the whole ZIP in one go.
    const jobs = [];
    for (const f of inputs) {
      if (/\.zip$/i.test(f.name)) {
        const files = L.fflate.unzipSync(f.bytes);
        for (const [n, b] of Object.entries(files)) if (!n.endsWith("/") && !n.startsWith("__MACOSX")) jobs.push({ name: n.split("/").pop(), bytes: b });
      } else jobs.push(f);
    }
    if (!jobs.length) return api.say("I couldn't find any CVs in that upload.");
    const card = api.desk(`<div class="card"><h4><span class="kind">Screening queue</span>${esc(title)} · ${jobs.length} CV${jobs.length > 1 ? "s" : ""}</h4><div class="c">
      <div class="qbar" role="progressbar" aria-label="CVs screened" aria-valuemin="0" aria-valuemax="${jobs.length}" aria-valuenow="0"><i style="width:0%"></i></div>
      <div class="note" data-q>Queued ${jobs.length} · one CV at a time</div>
      <div class="why">Each CV is read (PDF or DOCX), personal details are removed, then evidence is matched. Demo: evidence comes from the cache for the 40 sample CVs, so no AI call is made and nothing leaves this browser. CVs outside the sample set stay blocked ("needs the live AI") until the India route is live.</div></div></div>`);
    const t0 = performance.now(); const done = { scored: 0, human: 0, needsAi: 0, dup: 0 };
    const sd = await seed();
    for (let i = 0; i < jobs.length; i++) {
      const j = jobs[i];
      const out = await screenFile(j, title, r, sd, L);
      done[out]++;
      card.querySelector(".qbar i").style.width = `${((i + 1) / jobs.length) * 100}%`;
      card.querySelector(".qbar").setAttribute("aria-valuenow", i + 1);
      card.querySelector("[data-q]").textContent = `Screened ${i + 1} of ${jobs.length} · ${done.scored} scored · ${done.human} need a human look${done.needsAi ? ` · ${done.needsAi} need the live AI` : ""}${done.dup ? ` · ${done.dup} already screened` : ""}`;
      api.paint(); if (["hiring", "people", "overview"].includes(api.tab())) api.renderTab();
      await new Promise(res => setTimeout(res, 60));
    }
    const secs = Math.max(1, Math.round((performance.now() - t0) / 1000));
    card.querySelector("[data-q]").textContent = `Done in ${secs} s · ${done.scored} scored · ${done.human} need a human look${done.needsAi ? ` · ${done.needsAi} need the live AI` : ""}${done.dup ? ` · ${done.dup} already screened` : ""}`;
    refreshTasks(title);
    shortlistCard(title);
    const b = batch(title);
    const hl = humanLook(title).length;
    api.chips([...(b.length ? [[`Review the closure batch (${b.length} below 50%)`, () => batchCard(title)]] : []), ["Show 4 and 5 stars", () => filterCard(title, [4, 5])],
      ...(hl ? [[`${hl} need a human look`, () => humanCard(title)]] : [])]);
  }

  async function screenFile(j, title, r, sd, L) {
    const sha = await sha256Hex(j.bytes);
    if (S.cands.some(c => c.sha === sha && c.role === title)) return "dup";
    const hit = sd.cvs.find(c => c.sha256 === sha);
    // QA-017: applications spread over the last few hours before now; upload order = application order
    const appliedAt = new Date(Date.now() - Math.max(1, 60 - S.cands.length) * 4 * 60e3);
    const name = hit?.name || j.name.replace(/\.[^.]+$/, "").replace(/^\d+-/, "").replace(/[-_]+/g, " ").replace(/\b\w/g, c => c.toUpperCase());
    // Real extraction and masking in the browser, the same code the server runs.
    const t = await cvText(j.bytes, j.name, { unpdf: L.unpdf, mammoth: L.mammoth });
    const c = { id: "scr-" + sha.slice(0, 10), sha, file: j.name, name, role: title, appliedAt, status: "new", source: hit?.source || "Upload",
      referred: hit?.referred || null, version: r.version, scoredAt: new Date(), readable: t.readable, reason: t.reason || null };
    if (t.readable) c.maskedPreview = maskCv(t.text, [name]).text.slice(0, 600);
    let result;
    if (!t.readable) { c.score = scoreCandidate(r, { readable: false }); c.label = HUMAN_LOOK; result = "human"; }
    else if (!hit || hit.role !== title) { c.score = null; c.label = hit ? `CV is for ${hit.role}` : "needs the live AI"; result = "needsAi"; }
    else {
      // Cache: evidence from the sample set (requirements v1). An edited card keeps the evidence for unchanged requirements;
      // anything added after v1 has no cached evidence and counts as missing until the live AI reads it.
      c.cacheKey = cacheKey(sha, { ...r, version: 1 });
      const ids = new Set([...r.must, ...r.nice, ...r.conditions].map(x => x.id));
      c.evidence = hit.evidence.filter(e => ids.has(e.requirement_id));
      c.unverified = (hit.unverified || []).filter(id => ids.has(id));
      c.roles = hit.roles;
      c.years = yearsFromRanges(c.roles.map(x => x.quote).join("\n"), new Date());
      c.score = scoreCandidate(r, { readable: true, evidence: c.evidence, unverified: c.unverified, years: c.years, referred: !!c.referred });
      if (c.score.safeguard) c.label = HUMAN_LOOK;
      result = "scored";
    }
    S.cands.push(c);
    // The candidate appears in the pipeline (Applied) like any other.
    const D = api.D(), rid = roleId(title);
    D.people.push({ id: c.id, name: c.name, type: "Candidate", role: rid, stage: "Applied", owner: "hr", screen: c,
      where: whereText(c) });
    if (c.score?.fit != null) offerToShortlist(list(title), { ...c, applied_at: +c.appliedAt }, toLists(title), new Date());
    return result;
  }
  // QA-004: a null fit is an unreadable CV, never "Fit null"
  function whereText(c) {
    if (!c.score) return `Not scored · ${c.label}`;
    if (c.score.fit == null) return "CV unreadable · needs a human look";
    if (c.score.safeguard) return `${c.score.coveragePct}% verified (${c.score.looseCoveragePct}% with unverified quotes) · needs a human look`;
    if (c.score.under50) return `${c.score.coveragePct}% of must-haves · closure batch`;
    return `Fit ${c.score.fit} · ${effectiveStars(c.score)}★${c.score.override_stars ? " (override)" : ""}`;
  }
  const humanLook = title => candsFor(title).filter(c => c.label === HUMAN_LOOK && c.status === "new");
  const toLists = title => candsFor(title).filter(c => c.score).map(c => ({ ...c, applied_at: +c.appliedAt }));

  function refreshTasks(title) {
    const D = api.D();
    const b = batch(title), human = humanLook(title);
    const key = "scrBatch:" + title;
    D.tasks = D.tasks.filter(t => !(t.key === key || t.key === "scrHuman:" + title) || t.done);
    if (b.length && !S.batchDone[title]) {
      const clk = closureClock(Math.min(...b.map(c => +c.appliedAt)), Date.now());
      D.tasks.push({ id: api.id(), key, title: `Review the closure batch for ${title}`, ctx: `${b.length} below 50% of must-haves · ${clk.stateLabel} · review by ${fmtWhen(clk.reviewBy)} · due ${fmtWhen(clk.dueAt)}`, owner: "hr", when: clk.state === "late" ? "Late" : "Today", done: false });
    }
    if (human.length) D.tasks.push({ id: api.id(), key: "scrHuman:" + title, title: `${human.length} CV${human.length > 1 ? "s" : ""} for ${title} need a human look`, ctx: "Unreadable CVs, or below 50% only on unverified or low-confidence quotes: never closed automatically", owner: "hr", when: "This week", done: false });
    api.paint();
  }

  /* ---------- SCR-5: live top 10 ---------- */
  function top(title) { const st = list(title); return st.ids.map(id => S.cands.find(c => c.id === id)).filter(Boolean); }
  function reasonLine(c) {
    const r = reqOf(c.role), has = evidencedIds(c.evidence);
    const hits = r.must.filter(m => has.has(m.id)).map(m => m.label.split(" (")[0]);
    const gaps = r.must.filter(m => !has.has(m.id)).map(m => m.label.split(" (")[0]);
    // QA-009: every matched must-have and every gap
    return `${c.score.mustMet}/${c.score.mustTotal} must-haves${hits.length ? ": " + hits.join(", ") : ""}${gaps.length ? ` · gap${gaps.length > 1 ? "s" : ""}: ${gaps.join(", ")}` : ""}${c.years != null ? ` · ${c.years} yrs` : " · experience unclear"}`;
  }
  function rowHtml(c, i, opts = {}) {
    const st = list(c.role), pinned = st.pins.has(c.id);
    return `<div class="item scrrow"><span class="rank">${i + 1}</span><div class="t"><b style="font-weight:500">${esc(c.name)}</b> ${STARS(effectiveStars(c.score))} <span class="fig">${c.score.fit}</span>${c.score.override_stars ? ' <span class="pill p-mut">Override</span>' : ""}${pinned ? ' <span class="pill p-mut">Pinned</span>' : ""}${c.referred ? ' <span class="pill p-mut">Referral</span>' : ""}<small>${esc(reasonLine(c))}</small></div>
      <button class="btn" type="button" data-s="why" data-cid="${c.id}">Why</button>${opts.actions === false ? "" : `<button class="btn" type="button" data-s="pin" data-cid="${c.id}" aria-pressed="${pinned}">${pinned ? "Unpin" : "Pin"}</button><button class="btn" type="button" data-s="contacted" data-cid="${c.id}">Contacted</button>`}</div>`;
  }
  function shortlistHtml(title) {
    const t = top(title), all = candsFor(title);
    const notes = Object.entries(list(title).notes).map(([id, n]) => ({ c: S.cands.find(x => x.id === id), n })).filter(x => x.c && x.c.status === "new");
    return `<h4><span class="kind">Shortlist</span>Top ${TOP_N} to call · ${esc(title)} <span class="pill p-mut">${all.filter(c => c.score?.fit != null).length} scored</span></h4>
      ${t.map((c, i) => rowHtml(c, i)).join("") || '<div class="emptyv">No one scored yet.</div>'}
      <div class="c" data-pinmsg-wrap><div class="note late-text" data-pinmsg role="status">${esc(S.pinMsg?.[title] || "")}</div></div>
      ${notes.length ? `<div class="c"><div class="note">${notes.map(x => `${esc(x.c.name)}: ${esc(x.n)}`).join("<br>")}</div></div>` : ""}
      <div class="c"><div class="why">Ranked by fit score; ties go to whoever applied first. A newcomer replaces #10 only if 3 or more points higher. Pinned people stay (up to ${MAX_PINS}). Pin, Contacted and star changes are working marks: they send nothing and can be undone. Desk found the evidence; the score is calculated by fixed rules. A person makes every decision.</div></div>`;
  }
  function shortlistCard(title) {
    if (!candsFor(title).some(c => c.score)) return api.say(`No CVs screened for ${esc(title)} yet.`) || uploadPrompt(title);
    const d = api.desk(`<div class="card" data-shortlist="${esc(title)}">${shortlistHtml(title)}</div>`);
    return d;
  }
  function refreshShortlists() { document.querySelectorAll("[data-shortlist]").forEach(el => { el.innerHTML = shortlistHtml(el.dataset.shortlist); }); }

  /* ---------- SCR-7: star filter (role board, People, Desk) ---------- */
  function filterCard(title, stars) {
    // QA-008: same people as the Candidates filter; closed people are included and marked
    const hits = candsFor(title).filter(c => c.score?.stars != null && stars.includes(effectiveStars(c.score)))
      .sort((a, b) => (a.status === "new" ? 0 : 1) - (b.status === "new" ? 0 : 1) || b.score.fit - a.score.fit || a.appliedAt - b.appliedAt);
    const st = [...stars].sort((a, b) => b - a), lbl = st.length === 1 ? `${st[0]} star${st[0] === 1 ? "" : "s"}` : `${st.slice(0, -1).join(", ")} and ${st[st.length - 1]} stars`;
    const closed = hits.filter(c => c.status !== "new").length;
    api.desk(`<div class="card"><h4><span class="kind">Star filter</span>${lbl} · ${esc(title)} <span class="pill p-mut">${hits.length}</span></h4>
      ${hits.map((c, i) => rowHtml(c, i, { actions: false })).join("") || '<div class="emptyv">No one with those stars yet.</div>'}
      ${closed ? `<div class="c"><div class="note">${closed} of these ${closed === 1 ? "is" : "are"} closed or contacted (shown last), same as the Candidates filter.</div></div>` : ""}</div>`);
  }

  /* ---------- SCR-6: why shortlisted ---------- */
  function whyPanel(p) {
    const c = p?.screen; if (!c) return "";
    const r = reqOf(c.role);
    if (!c.score || c.score.fit == null) return `<div class="card"><h4><span class="kind">Screening</span>${esc(c.label || "")}</h4><div class="c"><div>${c.label === HUMAN_LOOK ? `${esc(c.reason || "No readable text.")} No AI was used, no stars were given and nobody was closed. Open the CV and decide.` : "This CV isn't in the sample set. Uploads outside the sample set stay blocked until the India AI route is live (fictional data only)."}</div></div></div>`;
    const s = c.score, has = new Map(c.evidence.filter(e => ["high", "medium"].includes(e.confidence)).map(e => [e.requirement_id, e]));
    const low = new Map(c.evidence.filter(e => e.confidence === "low").map(e => [e.requirement_id, e]));
    const unv = new Set(c.unverified || []);
    const ev = r.must.map(m => has.has(m.id)
      ? `<li><span class="pill p-ok">Has</span> <b>${esc(m.label)}</b><q>${esc(has.get(m.id).quote)}</q><small>${esc(has.get(m.id).section)} · ${esc(has.get(m.id).confidence)} confidence</small></li>`
      : `<li><span class="pill p-late">Gap</span> <b>${esc(m.label)}</b><small>${low.has(m.id) ? "Only listed under skills (low confidence): check on the call" : unv.has(m.id) ? "Claimed, but the quote doesn't use a word that counts or isn't in the CV word for word: check on the call" : "No evidence in the CV"} · ask: ${esc(askFor(m))}</small></li>`).join("");
    const nice = r.nice.map(n => `${has.has(n.id) ? "✓" : "–"} ${esc(n.label)}`).join(" · ");
    const cond = r.conditions.map(n => `${has.has(n.id) ? "✓" : "–"} ${esc(n.label)}`).join(" · ");
    const ov = s.override_stars ? `<div class="note">Override: ${s.original_stars}★ → ${s.override_stars}★ by ${esc(s.override_by)} · ${esc(s.override_reason)} · ${fmtWhen(s.override_at)} <button class="link" type="button" data-s="ovrUndo" data-cid="${c.id}">Undo</button></div>` : "";
    const roles = (c.roles || []).map(x => `<li>${esc(x.quote)}</li>`).join("");
    const guard = s.safeguard ? `<div class="banner">Needs a human look: ${s.coveragePct}% of must-haves verified, ${s.looseCoveragePct}% if unverified and low-confidence quotes counted. Never put in the closure batch automatically.</div>` : "";
    const contacted = c.status === "contacted" ? `<div class="note">Marked contacted <button class="link" type="button" data-s="uncontact" data-cid="${c.id}">Undo</button></div>` : "";
    return `<div class="card why-card" data-why="${c.id}"><h4><span class="kind">Why shortlisted</span>${STARS(effectiveStars(s))} <span class="fig">Fit ${s.fit}</span>${s.under50 ? ' <span class="pill p-late">Closure batch</span>' : s.safeguard ? ' <span class="pill p-warn">Human look</span>' : ""}</h4><div class="c">${guard}
      <table class="breakdown"><tr><td>Must-haves</td><td>${s.mustMet}/${s.mustTotal} (${s.coveragePct}%)</td><td>× ${r.weights.must}</td></tr>
        <tr><td>Experience</td><td>${c.years != null ? `${c.years} years (needed ${r.experience.min}–${r.experience.max}) ${s.expInRange ? "✓" : "✗"}` : "Experience unclear (scores 0, never closes anyone on its own)"}</td><td>× ${r.weights.experience}</td></tr>
        <tr><td>Nice-to-haves</td><td>${s.niceMet}/${s.niceTotal}</td><td>× ${r.weights.nice}</td></tr>
        <tr><td>Job conditions</td><td>${s.condMet}/${s.condTotal}</td><td>× ${r.weights.conditions}</td></tr>
        <tr class="total"><td>Fit score</td><td>${s.fit} → ${s.stars}★${s.under50 ? " (below 50% of must-haves)" : ""}</td><td></td></tr></table>
      <ul class="evidence">${ev}</ul>
      <div class="note"><b>Experience counted from:</b>${roles ? `<ul class="rolesused">${roles}</ul>` : " no dated roles found (experience unclear)"}</div>
      <div class="note">Nice-to-haves: ${nice}<br>Conditions: ${cond}</div>
      <div class="note">Scored on ${fmtWhen(c.scoredAt)} IST against requirements v${c.version}. Source: ${esc(c.source)}${c.referred ? ` · referred by ${esc(c.referred)} (never closed automatically)` : ""}. File: ${esc(c.file)}.</div>
      ${ov}${contacted}
      <div class="why">Desk found the evidence; the score is calculated by fixed rules. A person makes every decision. Personal details (name, contact, age, gender, college and so on) were removed before any matching.</div>
      <div class="row"><span class="note">Override stars:</span>${[1, 2, 3, 4, 5].map(n => `<button class="btn${effectiveStars(s) === n ? " primary" : ""}" type="button" data-s="ovr" data-cid="${c.id}" data-n="${n}" aria-label="${n} stars">${n}★</button>`).join("")}</div>
      <div class="row" data-reasons="${c.id}" hidden></div>
    </div></div>`;
  }
  const askFor = m => ({ m4: "message queues like Kafka or RabbitMQ", m5: "any payments or fintech work", m3: "SQL and database design", m2: "API design", m1: "the languages used day to day", o2: "how they query data", o1: "Excel lookups and pivots", o3: "reports they've built", o4: "operations processes they've run" })[m.id] || m.label.toLowerCase();

  /* ---------- SCR-4 (demo): rejection batch, preview only ---------- */
  // Membership comes only from computed coverage; an upward star override removes someone (logged); a downward one never adds.
  const batch = title => candsFor(title).filter(c => c.score?.under50 && c.status === "new" && !(c.score.override_stars > c.score.stars));
  function batchCard(title) {
    const b = batch(title), r = reqOf(title);
    if (!b.length) return api.say(S.batchDone[title] ? "That closure batch is already approved." : `No one below 50% for ${esc(title)}.`);
    const clk = closureClock(Math.min(...b.map(c => +c.appliedAt)), Date.now());
    const missing = c => { const has = evidencedIds(c.evidence); return r.must.filter(m => !has.has(m.id)).map(m => m.label.split(" (")[0]); };
    const exempt = candsFor(title).filter(c => c.score?.fit != null && !c.score.under50 && !c.score.safeguard && c.score.coverage < 0.5);
    const guarded = candsFor(title).filter(c => c.score?.safeguard);
    const human = candsFor(title).filter(c => c.label === HUMAN_LOOK && c.score?.fit == null);
    const pct = Math.round(clk.fraction * 100), pill = { on_time: "p-ok", due_soon: "p-warn", late: "p-late" }[clk.state];
    const company = api.company?.() || "Acme Fintech";
    const d = api.desk(`<div class="card draft"><h4><span class="kind">Bulk preview</span>Closure batch · ${esc(title)} · ${b.length} people <span class="pill ${pill}">${clk.stateLabel}</span></h4><div class="c">
      <div class="clockbar ${clk.state !== "on_time" ? "warn" : ""}"><i style="width:${Math.max(3, pct)}%"></i></div>
      <div class="note mono">Due ${fmtWhen(clk.dueAt)} (12 working hours from the first application) · review by ${fmtWhen(clk.reviewBy)} · nudge ${fmtWhen(clk.nudgeAt)} · escalates to the lead or founder ${fmtWhen(clk.escalateAt)}</div>
      <div class="tablewrap"><table><tr><th>Candidate</th><th>Must-haves</th><th>Missing</th></tr>${b.map(c => `<tr><td>${esc(c.name)}</td><td>${c.score.mustMet}/${c.score.mustTotal}</td><td style="text-align:left;font-family:var(--font-sans)">${esc(missing(c).join(", "))}</td></tr>`).join("")}</table></div>
      <div class="doc">Hi {name},
Thank you for applying for ${esc(title)} at ${esc(company)}. We've decided not to move forward because your profile doesn't yet show {missing}, which this role needs.
If you think we missed something, reply to this email and a person will look again.
<span data-sign>{approver's name, added when approved}</span>, ${esc(company)}</div>
      <div class="why">Each Closure Note uses a reason from the fixed job-relevant list: required skills not shown. ${exempt.length ? `Not in this batch: ${exempt.map(c => esc(c.name) + (c.referred ? " (referral)" : "")).join(", ")}. ` : ""}${guarded.length ? `Needs a human look instead (below 50% only on unverified or low-confidence quotes): ${guarded.map(c => esc(c.name)).join(", ")}. ` : ""}${human.length ? `${human.length} unreadable CV${human.length > 1 ? "s" : ""} need a human look and are never closed automatically.` : ""}</div>
      <div class="row"><button class="btn primary" type="button" data-s="approveBatch" data-role="${esc(title)}">Approve and send</button><button class="btn" type="button" data-s="noop">Edit note</button></div>
      <div class="note">Nothing is sent until you approve. Preview: nothing goes out even then.</div></div></div>`);
    return d;
  }
  function approveBatch(title, card) {
    const b = batch(title);
    const before = b.map(c => { const p = api.D().people.find(x => x.id === c.id); return [c, c.status, p, p && { stage: p.stage, where: p.where }]; });
    const a = api.logApproval(`Closure batch for ${title} (${b.length} people, preview only)`, api.first());
    for (const c of b) {
      c.status = "rejected";
      const p = api.D().people.find(x => x.id === c.id); if (p) { p.stage = "Rejected"; p.where = "Closure Note approved (preview)"; }
    }
    S.batchDone[title] = true;
    api.D().tasks.filter(t => t.key === "scrBatch:" + title).forEach(t => { t.done = true; t.when = "Done"; });
    card.querySelectorAll("[data-sign]").forEach(x => { x.textContent = a.by; });   // QA-010: the approver's name from the stamp
    api.ink(card, a.by, a.at);
    // QA-020: undo for 10 minutes, logged as its own event
    api.offerUndo?.(card, a, () => { for (const [c, st, p, pw] of before) { c.status = st; if (p) Object.assign(p, pw); }
      S.batchDone[title] = false; api.D().tasks.filter(t => t.key === "scrBatch:" + title).forEach(t => { t.done = false; t.when = "Today"; }); refreshTasks(title); });
    card.querySelector(".note:last-child").textContent = "In the live product this would go out now. This preview sent nothing.";
    api.say(`Approved by ${esc(a.by)}. In the live product ${b.length} Closure Notes would go out now, each with its reason. This preview sent nothing.`);
    api.paint();
  }

  /* ---------- clicks (event delegation) ---------- */
  document.addEventListener("click", e => {
    const b = e.target.closest("[data-s]"); if (!b) return;
    const k = b.dataset.s, c = S.cands.find(x => x.id === b.dataset.cid);
    if (k === "rmreq") { const r = draftReq(b.dataset.role); r[b.dataset.kind] = r[b.dataset.kind].filter(x => x.id !== b.dataset.id); r.edited = true; b.closest("[data-reqcard]").outerHTML = reqCard(b.dataset.role); }
    if (k === "confirm") confirmReq(b.dataset.role, b.closest("[data-reqcard]"));
    if (k === "approveBatch") { b.disabled = true; approveBatch(b.dataset.role, b.closest(".card")); }
    if (k === "noop") api.say("Editing the note isn't in this preview yet.");
    if (k === "pin" && c) doPin(c);
    if (k === "contacted" && c) doContacted(c);
    if (k === "uncontact" && c) undoContacted(c);
    if (k === "ovr" && c) { const box = b.closest(".c").querySelector(`[data-reasons="${c.id}"]`); const n = Number(b.dataset.n);
      if (n === c.score.stars && !c.score.override_stars) { box.hidden = false; box.innerHTML = '<span class="note">Those are the calculated stars already.</span>'; return; }
      if (n === c.score.stars) return undoOverride(c);
      box.hidden = false;   // QA-013: only reasons that fit the direction of the change
      box.innerHTML = `<span class="note">Why ${n}★?</span>` + reasonsFor(c.score.stars, n).map(r => `<button class="fchip" type="button" data-s="ovrReason" data-cid="${c.id}" data-n="${n}">${esc(r)}</button>`).join(""); }
    if (k === "ovrReason" && c) doOverride(c, Number(b.dataset.n), b.textContent);
    if (k === "ovrUndo" && c) undoOverride(c);
    if (k === "why" && c) api.openPerson(c.id);
  });
  document.addEventListener("input", e => {
    const t = e.target.closest('[data-s="terms"]');
    if (t) { const r = draftReq(t.dataset.role); const item = r[t.dataset.kind].find(x => x.id === t.dataset.id); item.terms = t.value.split(",").map(x => x.trim()).filter(Boolean); r.edited = true; return; }
    const i = e.target.closest('[data-s="weight"]'); if (!i) return;
    // QA-002: keep what was typed (no silent coercion to 0); checkWeights refuses it at Confirm with a clear message
    const r = draftReq(i.dataset.role); r.weights[i.dataset.k] = i.value === "" ? NaN : Number(i.value); r.edited = true;
    const vals = Object.values(r.weights), sum = vals.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
    const bad = vals.some(v => !Number.isInteger(v) || v < 0 || v > 100);
    const n = i.closest(".weights").querySelector("[data-wsum]");
    n.textContent = bad ? "Each weight must be a whole number from 0 to 100." : sum === 100 ? "Adds up to 100." : `Adds up to ${sum}; must be 100.`;
  });

  /* ---------- working marks (also reachable from Desk: parity rule) ---------- */
  function doPin(c) {
    const st = list(c.role); S.pinMsg ??= {}; S.pinMsg[c.role] = "";
    try { const was = st.pins.has(c.id); was ? st.pins.delete(c.id) : pin(st, c.id); mark(`${was ? "Unpinned" : "Pinned"} ${c.name} (${c.role})`); return was ? "Unpinned" : "Pinned"; }
    catch (err) { S.pinMsg[c.role] = err.message; return err.message; }   // QA-016: shown next to the list
    finally { refreshShortlists(); api.renderTab(); }
  }
  function doContacted(c) {
    c.status = "contacted"; mark(`Marked ${c.name} contacted · first-touch clock met`);
    const p = api.D().people.find(x => x.id === c.id); if (p) p.where = "Contacted · call to schedule";   // no stage move
    leaveShortlist(list(c.role), c.id, toLists(c.role)); refreshShortlists(); api.renderTab(); api.paint();
  }
  function undoContacted(c) {
    c.status = "new"; mark(`Undid contacted for ${c.name}`);
    const p = api.D().people.find(x => x.id === c.id); if (p) p.where = whereText(c);
    offerToShortlist(list(c.role), { ...c, applied_at: +c.appliedAt }, toLists(c.role)); refreshShortlists(); api.renderTab();
  }
  function doOverride(c, n, reason) {
    const wasBatched = batch(c.role).includes(c);
    c.score = overrideStars(c.score, n, reason, api.first());
    mark(`Stars for ${c.name}: ${c.score.original_stars}★ → ${c.score.override_stars}★ · ${c.score.override_reason}${wasBatched && !batch(c.role).includes(c) ? " · removed from the closure batch" : ""}`);
    const p = api.D().people.find(x => x.id === c.id); if (p) p.where = whereText(c);
    refreshTasks(c.role); api.renderTab(); refreshShortlists();
  }
  function undoOverride(c) {
    if (!c.score.override_stars) return;
    const { override_stars, override_reason, override_by, override_at, original_stars, ...rest } = c.score; c.score = rest;
    mark(`Reset ${c.name} to the calculated ${c.score.stars}★`);
    const p = api.D().people.find(x => x.id === c.id); if (p) p.where = whereText(c);
    refreshTasks(c.role); api.renderTab(); refreshShortlists();
  }
  function humanCard(title) {
    const h = humanLook(title);
    if (!h.length) return api.say(`No CVs for ${esc(title)} need a human look.`);
    api.desk(`<div class="card"><h4><span class="kind">Needs a human look</span>${esc(title)} <span class="pill p-mut">${h.length}</span></h4>
      ${h.map(c => `<div class="item"><span class="pill p-warn">Look</span><div class="t">${esc(c.name)}<small>${esc(c.score?.fit == null ? (c.reason || "CV unreadable") + ": no AI used" : `${c.score.coveragePct}% of must-haves verified, ${c.score.looseCoveragePct}% with unverified quotes`)}</small></div><button class="btn" type="button" data-s="why" data-cid="${c.id}">Open</button></div>`).join("")}
      <div class="c"><div class="why">These are never put in the closure batch automatically. Open each one and decide.</div></div></div>`);
  }

  /* ---------- Desk commands ---------- */
  const findCand = q => S.cands.filter(c => c.name.toLowerCase().split(" ").some(w => q.split(/\s+/).includes(w)) || q.includes(c.name.toLowerCase()));
  function route(t) {
    const s = t.toLowerCase();
    const title = /\b(ops|operations|backend)\b/.test(s) ? roleTitleFromText(s) : (contextRole() || roleTitleFromText(s));
    // QA-007 (a): sample ZIP before the card is confirmed
    if (/\bsample zip\b|\buse the sample\b/.test(s)) {
      api.later(() => { if (!reqOf(title)?.confirmed) { api.say(`Confirm the requirements card for ${esc(title)} first. Nothing is screened before that.`); api.desk(reqCard(title)); } else sampleZip(title); });
      return true;
    }
    // QA-007 (b): the needs-a-human-look list
    if (/\bhuman look\b|\bneeds? a human\b/.test(s)) { api.later(() => humanCard(title)); return true; }
    // Parity: every working mark can also be done in Desk
    let m;
    if ((m = s.match(/^\s*(un)?pin\s+(.+)$/))) { const c = findCand(m[2].trim()); if (c.length === 1) { api.later(() => api.say(esc(doPin(c[0])) + ` · ${esc(c[0].name)}`)); return true; } if (c.length > 1) { api.later(() => api.say(`Which one? ${c.map(x => esc(x.name)).join(" or ")}`)); return true; } }
    if ((m = s.match(/^\s*mark\s+(.+?)\s+(?:as\s+)?contacted\b/))) { const c = findCand(m[1].trim()); if (c.length === 1) { api.later(() => { doContacted(c[0]); api.say(`${esc(c[0].name)} marked contacted. The next best person moved into the top 10.`); }); return true; } }
    if ((m = s.match(/^\s*change\s+(.+?)\s+to\s+([1-5])\s*stars?\b(?:\s+because\s+(.+))?/))) {
      const c = findCand(m[1].trim());
      if (c.length === 1) { api.later(() => {
        const n = Number(m[2]), opts = reasonsFor(c[0].score.stars, n);
        const r = m[3] ? opts.find(o => o.toLowerCase().includes(m[3].trim().slice(0, 12)) || m[3].toLowerCase().includes(o.toLowerCase().split(" ")[0])) : null;
        if (!r) return api.say(`Pick a reason for ${n}★: ${opts.map(esc).join(" · ")}`) || api.chips(opts.map(o => [o, () => { doOverride(c[0], n, o); api.say(`${esc(c[0].name)} is now ${n}★ (${esc(o)}). Logged.`); }]));
        doOverride(c[0], n, r); api.say(`${esc(c[0].name)} is now ${n}★ (${esc(r)}). Logged.`);
      }); return true; }
    }
    if (/\b(screen|upload|bulk upload)\b.*\b(cv|cvs|resume|resumes)\b|\bscreen(ing)?\b.*\b(backend|operations|ops)\b|\brequirements card\b/.test(s)) {
      api.later(() => { const r = draftReq(title); if (!r.confirmed) { api.say(`Here's the requirements card I drafted for ${esc(title)} from its job description. Check it, then confirm. Nothing is screened before that.`); api.desk(reqCard(title)); } else { api.say(`${esc(title)} uses requirements v${r.version}, confirmed by ${esc(r.confirmedBy)}.`); uploadPrompt(title); } });
      return true;
    }
    const stars = [...s.matchAll(/\b([1-5])\s*(?:★|stars?|and|,|\s)/g)].map(m => Number(m[1]));
    if (/\bstars?\b|★/.test(s) && stars.length) { api.later(() => filterCard(title, [...new Set(stars)])); return true; }
    if (/\btop ?10\b|\bshortlist\b|\bwho should i call\b/.test(s)) { api.later(() => shortlistCard(title)); return true; }
    if (/\b(reject|rejection|closure)\b.*\b(50|batch|below)\b|\bbelow 50\b|\bclosure batch\b/.test(s)) { api.later(() => batchCard(title)); return true; }
    const why = s.match(/\bwhy (?:is |was )?(.+?) (?:shortlisted|ranked|in the top|scored)/);
    if (why) { const c = S.cands.find(x => x.name.toLowerCase().includes(why[1].trim())); if (c) { api.later(() => api.desk(whyPanel(api.D().people.find(p => p.id === c.id)))); return true; } }
    return false;
  }
  function runTask(key) {
    const [kind, title] = key.split(":");
    if (kind === "scrBatch") return batchCard(title), true;
    if (kind === "scrHuman") return humanCard(title), true;
    return false;
  }

  /* ---------- pieces for the frozen screens ---------- */
  function roleStrip(roleIdNum) {
    const title = titleOf(roleIdNum); if (!title) return "";
    const r = S.req[title];
    S.boardRole = title;
    if (!candsFor(title).length) return `<div class="card"><h4><span class="kind">Screening</span>${esc(title)}</h4><div class="c"><div class="row"><span class="note">${r?.confirmed ? `Requirements v${r.version} confirmed. Upload CVs to fill the top 10.` : "Confirm the requirements card, then upload CVs (PDF, DOCX or ZIP). Desk fills a live top 10 with stars."}</span><button class="btn primary" type="button" data-v="ask" data-text="Screen CVs for ${esc(title)}">Screen CVs in Desk</button></div></div></div>`;
    const b = batch(title);
    const clk = b.length ? closureClock(Math.min(...b.map(c => +c.appliedAt)), Date.now()) : null;
    return `${b.length ? `<div class="banner"><span>${b.length} below 50% of must-haves · ${clk.stateLabel} · review by ${fmtWhen(clk.reviewBy)} · due ${fmtWhen(clk.dueAt)}</span><button class="btn primary" type="button" data-v="ask" data-text="Show the closure batch below 50% for ${esc(title)}">Review batch in Desk</button></div>` : ""}
      <div class="card" data-shortlist="${esc(title)}">${shortlistHtml(title)}</div>`;
  }
  const starFilterHtml = () => `<div class="role" role="group" aria-label="Filter by stars"><span class="note">Stars</span>${[5, 4, 3, 2, 1].map(n => `<button class="fchip" type="button" data-sf="${n}" aria-pressed="${S.filter.includes(n)}">${n}★</button>`).join("")}</div>`;
  document.addEventListener("click", e => { const b = e.target.closest("[data-sf]"); if (!b) return; const n = Number(b.dataset.sf); S.filter = S.filter.includes(n) ? S.filter.filter(x => x !== n) : [...S.filter, n]; api.renderTab(); });
  const passesFilter = p => !S.filter.length || (p.screen?.score?.stars != null && S.filter.includes(effectiveStars(p.screen.score)));
  const starsCell = p => p.screen ? (p.screen.score?.stars != null ? STARS(effectiveStars(p.screen.score)) + (p.screen.score.safeguard ? ' <span class="note">Human look</span>' : "") : `<span class="note">${esc(p.screen.label === HUMAN_LOOK ? "Human look" : "–")}</span>`) : "";
  // QA-015: Candidates order — people to act on first (human look, then top 10, then the rest by fit), unscored after
  const sortKey = p => { const c = p.screen; if (!c) return [3, 0, 0]; if (c.label === HUMAN_LOOK && c.status === "new") return [0, 0, +c.appliedAt];
    if (c.score?.fit == null) return [2, 0, +c.appliedAt]; const inTop = list(c.role).ids.includes(c.id) ? 0 : 1; return [1, inTop * 1000 - c.score.fit, +c.appliedAt]; };

  return { reset, route, runTask, roleStrip, whyPanel, starFilterHtml, passesFilter, starsCell, sortKey, contextRole, hasData: () => S.cands.length > 0,
    upload: (files, title) => upload(files, title), shortlistCard, reqCard, state: () => S };
}
