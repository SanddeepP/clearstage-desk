// One CV in, one result out. Used by the browser demo (seed cache) and by the queue worker (one Edge Function
// call per CV). Order: hash → cache → extract → (unreadable? stop: "needs a human look", no AI, no rejection)
// → mask → AI evidence (small model) → verify quotes → experience from verified role quotes → score in code.
import { cvText } from "./cvtext.js";
import { maskCv } from "./mask.js";
import { buildPrompt, verifyEvidence, sha256Hex, cacheKey, PROMPT_VERSION } from "./evidence.js";
import { scoreCandidate, yearsFromRanges, HUMAN_LOOK } from "./screening.js";

/**
 * @param o.bytes, o.name   the CV file
 * @param o.req             confirmed requirements card
 * @param o.candidate       { names:[...], referred, manual }
 * @param o.cache           { get(key) → {evidence, roles} | null, set(key, value) }
 * @param o.extractor       libs for cvText
 * @param o.llm             async ({system, user}) → { text, usage:{input_tokens, output_tokens}, model } — only called on a cache miss
 * @param o.logUsage        async ({cv_sha, model, prompt_version, usage}) — tokens per CV
 */
export async function screenOne(o) {
  if (!o.req?.confirmed) throw new Error("Confirm the requirements card before screening");
  const sha = await sha256Hex(o.bytes);
  const key = cacheKey(sha, o.req);
  const cand = o.candidate || {};
  let cached = await o.cache.get(key);
  let masked = null, readable = true, reason = null, aiCalled = false, dropped = [];
  if (!cached) {
    const t = await cvText(o.bytes, o.name, o.extractor);
    if (!t.readable) return { sha, key, status: "needs_human", label: HUMAN_LOOK, reason: t.reason, score: scoreCandidate(o.req, { readable: false }), aiCalled };
    masked = maskCv(t.text, cand.names || []).text;
    const prompt = buildPrompt(masked, o.req);
    const r = await o.llm(prompt);
    aiCalled = true;
    await o.logUsage?.({ cv_sha: sha, model: r.model, prompt_version: PROMPT_VERSION, usage: r.usage });
    const v = verifyEvidence(r.text, masked, o.req);
    if (!v.ok) { const e = new Error("The AI reply wasn't in the required format"); e.retryable = true; throw e; }
    dropped = v.dropped;
    cached = { evidence: v.evidence, roles: v.roles };
    await o.cache.set(key, cached);
  }
  const years = yearsFromRanges(cached.roles.map(r => r.quote).join("\n"), o.asOf ?? new Date());
  const score = scoreCandidate(o.req, { readable, evidence: cached.evidence, years, referred: !!cand.referred, manual: !!cand.manual });
  return { sha, key, status: "scored", evidence: cached.evidence, roles: cached.roles, years, experienceUnclear: years == null,
    score, aiCalled, cacheHit: !aiCalled, dropped };
}
