// Screening maths: plain code only. The AI never writes a score, a star or a coverage number.
// CTO rule 1 (15 Nov): fit = coverage × 60 + (experience in range ? 20 : 0) + nice-to-have fraction × 15
//                          + conditions-met fraction × 5, rounded to a whole number.
// Only high or medium confidence evidence counts; low confidence counts as missing.
// The same file is copied to supabase/functions/_shared/screening.js (a test checks they match).

export const DEFAULT_WEIGHTS = Object.freeze({ must: 60, experience: 20, nice: 15, conditions: 5 });
export const STAR_BANDS = Object.freeze([[85, 5], [70, 4], [55, 3], [40, 2], [0, 1]]);
export const COUNTS = new Set(["high", "medium"]);
export const HUMAN_LOOK = "needs a human look";

/** Which requirement ids have evidence that counts (high or medium confidence). */
export function evidencedIds(evidence = []) {
  return new Set(evidence.filter(e => COUNTS.has(e.confidence)).map(e => e.requirement_id));
}

const frac = (met, total) => (total ? met / total : 1);   // nothing listed = nothing missing

/** QA-002 (CTO 16 Nov): each weight is a whole number from 0 to 100, and they add up to 100. */
export const WEIGHT_KEYS = ["must", "experience", "nice", "conditions"];
const WEIGHT_NAMES = { must: "Must-haves", experience: "Experience", nice: "Nice-to-haves", conditions: "Job conditions" };
export function checkWeights(w) {
  for (const k of WEIGHT_KEYS) {
    const v = w?.[k];
    if (!Number.isInteger(v) || v < 0 || v > 100) throw new Error(`${WEIGHT_NAMES[k]} weight must be a whole number from 0 to 100`);
  }
  const sum = WEIGHT_KEYS.reduce((a, k) => a + w[k], 0);
  if (sum !== 100) throw new Error(`Weights must add up to 100 (now ${sum})`);
  return w;
}

/**
 * Score one candidate against one confirmed requirements version.
 * @param req  { version, must:[{id}], nice:[{id}], conditions:[{id}], experience:{min,max}, weights? }
 * @param cv   { evidence:[{requirement_id, confidence}], unverified?:[requirement_id], years:number|null, readable:boolean, referred?, manual? }
 *   evidence   = quotes that passed the word-for-word check (any confidence; only high/medium count)
 *   unverified = requirement ids the AI claimed with a quote that failed the check
 * QA-001 safeguard (Decisions Log 15 Nov evening, item 2; CTO 16 Nov): if verified coverage is below 50% but
 * counting low-confidence and unverified quotes would bring it to 50% or more, the candidate goes to
 * "needs a human look" and never into the closure batch.
 */
export function scoreCandidate(req, cv) {
  if (!req || !req.confirmed) throw new Error("Confirm the requirements card before screening");
  if (!cv.readable) return { version: req.version, label: HUMAN_LOOK, fit: null, stars: null, coverage: null, under50: false, ruleApplies: false };
  const w = checkWeights({ ...DEFAULT_WEIGHTS, ...(req.weights || {}) });
  const has = evidencedIds(cv.evidence);
  const count = list => list.filter(r => has.has(r.id)).length;
  const mustMet = count(req.must), niceMet = count(req.nice || []), condMet = count(req.conditions || []);
  const coverage = frac(mustMet, req.must.length);
  const expInRange = cv.years != null && cv.years >= req.experience.min && cv.years <= req.experience.max;
  const fit = Math.round(coverage * w.must + (expInRange ? w.experience : 0)
    + frac(niceMet, (req.nice || []).length) * w.nice + frac(condMet, (req.conditions || []).length) * w.conditions);
  // The under-50% rule does not fire for coarse roles, unreadable CVs, referrals or people added by hand.
  const ruleApplies = req.must.length >= 3 && !cv.referred && !cv.manual;
  const loose = new Set([...(cv.evidence || []).map(e => e.requirement_id), ...(cv.unverified || [])]);
  const looseCoverage = frac(req.must.filter(r => loose.has(r.id)).length, req.must.length);
  const safeguard = ruleApplies && coverage < 0.5 && looseCoverage >= 0.5;
  const under50 = ruleApplies && coverage < 0.5 && !safeguard;
  const stars = under50 ? 1 : STAR_BANDS.find(([min]) => fit >= min)[1];
  return { version: req.version, fit, stars, coverage, coveragePct: Math.round(coverage * 100),
    looseCoverage, looseCoveragePct: Math.round(looseCoverage * 100), safeguard,
    mustMet, mustTotal: req.must.length, niceMet, niceTotal: (req.nice || []).length,
    condMet, condTotal: (req.conditions || []).length, expInRange, years: cv.years, under50, ruleApplies, label: safeguard ? HUMAN_LOOK : null };
}

/** QA-018 (CTO 16 Nov): evidence counts only if the quote contains one of the requirement's confirmed terms.
 *  Generic words can't be the only term, or almost any CV line would count. */
export const GENERIC_TERMS = new Set(["api", "apis", "backend", "back end", "software", "development", "developer", "engineer", "engineering",
  "system", "systems", "work", "experience", "skills", "tech", "technology", "it", "computer", "data", "team", "projects", "project"]);
export function checkTerms(req) {
  for (const r of [...req.must, ...(req.nice || []), ...(req.conditions || [])]) {
    const terms = (r.terms || []).map(t => t.trim()).filter(Boolean);
    if (!terms.length) throw new Error(`Add at least one word that counts for "${r.label}"`);
    if (terms.every(t => GENERIC_TERMS.has(t.toLowerCase()))) throw new Error(`"${r.label}" needs a specific word that counts, not only generic ones like "${terms[0]}"`);
  }
  return req;
}

/** Stars a recruiter sees: an override wins, but both are kept and logged. */
export const effectiveStars = s => s.override_stars ?? s.stars;

/** Years of experience from dated roles ("Mar 2019 – Jun 2022", "2021 - Present"), overlaps merged. Plain code. */
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
export function yearsFromRanges(text, today = new Date(Date.UTC(2026, 10, 11))) {
  const re = /(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+)?((?:19|20)\d\d)\s*(?:–|-|—|to)\s*(?:(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+)?((?:19|20)\d\d)|(present|now|current|till date))/gi;
  const spans = [];
  for (const m of text.matchAll(re)) {
    const start = Number(m[2]) * 12 + (m[1] ? MONTHS[m[1].toLowerCase()] : 0);
    const end = m[5] ? today.getUTCFullYear() * 12 + today.getUTCMonth() : Number(m[4]) * 12 + (m[3] ? MONTHS[m[3].toLowerCase()] : 11);
    if (end > start) spans.push([start, end]);
  }
  if (!spans.length) return null;
  spans.sort((a, b) => a[0] - b[0]);
  let months = 0, [cs, ce] = spans[0];
  for (const [s, e] of spans.slice(1)) { if (s <= ce) ce = Math.max(ce, e); else { months += ce - cs; [cs, ce] = [s, e]; } }
  months += ce - cs;
  return Math.round((months / 12) * 10) / 10;
}

/* ---------------- Live top 10 ----------------
 * Eligible: scored, readable, not contacted / rejected / withdrawn / moved forward, not in the rejection batch.
 * Ranked by fit; ties go to whoever applied first. A newcomer replaces #10 only if at least 3 points higher.
 * Pinned people stay. Anyone who drops out gets a note. */
export const TOP_N = 10, MARGIN = 3;
const LEAVES = new Set(["contacted", "rejected", "withdrawn", "moved_forward"]);
export const eligible = c => c.score && c.score.fit != null && !c.score.under50 && !c.score.safeguard && !LEAVES.has(c.status);
export const rankOrder = (a, b) => (b.score.fit - a.score.fit) || (a.applied_at - b.applied_at) || String(a.id).localeCompare(String(b.id));

export const MAX_PINS = 5;   // pins count inside the 10; at most 5 so the list can still move
export function newShortlist() { return { ids: [], pins: new Set(), notes: {}, entered: {}, seq: 0, arrivals: [] }; }
export function pin(state, id) {
  if (!state.ids.includes(id)) throw new Error("Only people in the top 10 can be pinned");
  if (!state.pins.has(id) && state.pins.size >= MAX_PINS) throw new Error(`At most ${MAX_PINS} pins, so the list can still move`);
  state.pins.add(id); return state;
}

/** A newly scored candidate arrives. Mutates and returns the list state. */
export function offerToShortlist(state, cand, all, now = new Date()) {
  if (!eligible(cand) || state.ids.includes(cand.id)) return state;
  const byId = id => all.find(c => c.id === id);
  if (state.ids.length < TOP_N) { state.ids.push(cand.id); state.entered[cand.id] = ++state.seq; delete state.notes[cand.id]; return sortList(state, all); }
  const removable = state.ids.filter(id => !state.pins.has(id)).map(byId).sort(rankOrder);
  const lowest = removable[removable.length - 1];
  if (!lowest || cand.score.fit < lowest.score.fit + MARGIN) return state;
  state.ids = state.ids.filter(id => id !== lowest.id);
  state.ids.push(cand.id); state.entered[cand.id] = ++state.seq; delete state.notes[cand.id];
  state.arrivals.push({ id: cand.id, seq: state.seq, fit: cand.score.fit });
  // "stronger profiles arrived": newcomers that pushed in since this person entered and outscore them
  const stronger = state.arrivals.filter(a => a.seq > (state.entered[lowest.id] || 0) && a.fit > lowest.score.fit).map(a => a.fit).sort((x, y) => y - x);
  state.notes[lowest.id] = `Moved out on ${fmtDay(now)}: ${stronger.length} stronger profile${stronger.length === 1 ? "" : "s"} arrived (score${stronger.length === 1 ? "" : "s"} ${listAnd(stronger)})`;
  return sortList(state, all);
}

/** Someone was contacted, rejected, withdrew or moved forward: they leave and the next best fills the space. */
export function leaveShortlist(state, id, all) {
  state.ids = state.ids.filter(x => x !== id); state.pins.delete(id);
  const next = all.filter(c => eligible(c) && !state.ids.includes(c.id)).sort(rankOrder)[0];
  if (next) { state.ids.push(next.id); state.entered[next.id] = ++state.seq; delete state.notes[next.id]; }
  return sortList(state, all);
}

function sortList(state, all) { state.ids = state.ids.map(id => all.find(c => c.id === id)).sort(rankOrder).map(c => c.id); return state; }
const fmtDay = d => new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
const listAnd = a => a.length <= 1 ? String(a[0] ?? "") : a.slice(0, -1).join(", ") + " and " + a[a.length - 1];

/** Star filter: any combination of 1–5 (uses the override when there is one). */
export const starFilter = (cands, stars) => cands.filter(c => c.score?.stars != null && stars.includes(effectiveStars(c.score)));

/** Reason chips for a star override; an override needs one that fits its direction (QA-013). */
export const OVERRIDE_REASONS_UP = ["Strong in interview or call", "Relevant experience the CV doesn't show", "Referral vouched for skills", "Evidence was misread"];
export const OVERRIDE_REASONS_DOWN = ["Weaker than the CV suggests", "Weak in interview or call", "Evidence was misread"];
export const OVERRIDE_REASONS = [...new Set([...OVERRIDE_REASONS_UP, ...OVERRIDE_REASONS_DOWN])];
export const reasonsFor = (from, to) => (to > from ? OVERRIDE_REASONS_UP : OVERRIDE_REASONS_DOWN);
export function overrideStars(score, stars, reason, by, at = new Date()) {
  if (![1, 2, 3, 4, 5].includes(stars)) throw new Error("Pick 1 to 5 stars");
  if (stars === score.stars) throw new Error("That's the same as the calculated stars");
  if (!reasonsFor(score.stars, stars).includes(reason)) throw new Error("Pick a reason that fits the change");
  return { ...score, override_stars: stars, override_reason: reason, override_by: by, override_at: at, original_stars: score.stars };
}
