// screen-cv — one queued CV per call (CTO Tech Decisions §1.1). Never a whole ZIP in one call.
// POST { "job_id": 123 } with the user's session. Runs as the signed-in user: row-level security applies.
// Steps: claim the job → download the file (private bucket "cvs") → extract text (unpdf / mammoth; no OCR) →
// unreadable? save as "needs a human look" (no AI, no rejection) → mask personal details → cache by file hash +
// requirements version → small model returns quotes only → quotes verified word for word → the database checks the
// quotes again and computes the score. 3 tries, then "needs a human look". Tokens are logged per CV in ai_usage.
import { createClient } from "npm:@supabase/supabase-js@2.50.0";
import * as unpdf from "npm:unpdf@0.12.1";
import mammoth from "npm:mammoth@1.8.0";
import { cvText } from "../_shared/screening/cvtext.js";
import { maskCv } from "../_shared/screening/mask.js";
import { buildPrompt, verifyEvidence, cacheKey, PROMPT_VERSION } from "../_shared/screening/evidence.js";

const MODEL = Deno.env.get("SCREEN_MODEL") ?? "claude-haiku-5-5";
const ALLOWED = (Deno.env.get("DESK_ALLOWED_ORIGINS") ?? "https://desk.crovantapartner.com,http://localhost:8000,http://localhost:8765").split(",");
const cors = (req: Request) => ({ "Access-Control-Allow-Origin": ALLOWED.includes(req.headers.get("origin") ?? "") ? req.headers.get("origin")! : ALLOWED[0],
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS", "Vary": "Origin" });
const json = (req: Request, body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": "application/json" } });
function publicKey(): string {
  const k = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY"); if (k) return k;
  try { const all = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") ?? "{}"); return all.default ?? Object.values(all)[0] as string; } catch { return ""; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return json(req, { error: "Use POST" }, 405);
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, publicKey(), { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
  const { data: u } = await sb.auth.getUser(); if (!u?.user) return json(req, { error: "Sign in first" }, 401);
  const { data: allowed } = await sb.rpc("desk_live_enabled");
  if (allowed !== true) return json(req, { error: "AI screening isn't switched on for your company yet. It's in a closed beta." }, 403);
  const rpc = async (name: string, args: Record<string, unknown> = {}) => { const { data, error } = await sb.rpc(name, args); if (error) throw new Error(error.message); return data; };
  const body = await req.json().catch(() => ({}));
  const job = await rpc("desk_claim_cv_job", { p_job: body.job_id ?? null });
  if (!job) return json(req, { status: "idle" });
  try {
    const { data: file, error } = await sb.storage.from("cvs").download(job.storage_path);
    if (error || !file) throw new Error("Couldn't download the CV");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const t = await cvText(bytes, job.file_name, { unpdf, mammoth, node: false });
    if (!t.readable) return json(req, await rpc("desk_save_screening", { p_job: job.job_id, p_readable: false, p_masked_text: null, p_evidence: [] }));
    const { data: app } = await sb.from("application").select("person:person_id(full_name)").eq("id", job.application_id).single();
    const person = (app as any)?.person; const masked = maskCv(t.text, [Array.isArray(person) ? person[0]?.full_name : person?.full_name].filter(Boolean)).text;
    const req0 = job.requirement;
    const key = cacheKey(job.sha256, req0);
    let cached = await rpc("desk_cached_evidence", { p_key: key });
    if (!cached) {
      const prompt = buildPrompt(masked, req0);
      const apiKey = Deno.env.get("ANTHROPIC_API_KEY"); if (!apiKey) throw new Error("NOT_CONFIGURED");
      const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: MODEL, max_tokens: 1500, system: [{ type: "text", text: prompt.system, cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: prompt.user }] }) });
      if (!r.ok) throw new Error(`AI model error ${r.status}`);
      const out = await r.json();
      const { data: me } = await sb.rpc("current_member");
      await sb.from("ai_usage").insert({ company_id: me.company_id, model: MODEL, purpose: "screen", tools: [PROMPT_VERSION, job.sha256.slice(0, 12)],
        input_tokens: out.usage?.input_tokens ?? 0, output_tokens: out.usage?.output_tokens ?? 0 });
      const v = verifyEvidence(out.content?.[0]?.text ?? "", masked, req0);
      if (!v.ok) throw new Error("The AI reply wasn't in the required format");
      cached = { evidence: v.evidence, roles: v.roles };
      return json(req, await rpc("desk_save_screening", { p_job: job.job_id, p_readable: true, p_masked_text: masked, p_evidence: [...v.evidence, ...v.roles], p_cache_key: key, p_model: MODEL, p_prompt_version: PROMPT_VERSION }));
    }
    return json(req, await rpc("desk_save_screening", { p_job: job.job_id, p_readable: true, p_masked_text: masked, p_evidence: [...cached.evidence, ...cached.roles] }));
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    const r = await rpc("desk_fail_cv_job", { p_job: job.job_id, p_error: msg });
    return json(req, { status: r.status, error: msg === "NOT_CONFIGURED" ? "AI isn't connected yet." : msg }, msg === "NOT_CONFIGURED" ? 503 : 200);
  }
});
