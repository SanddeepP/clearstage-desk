// AI provider layer (founder 23 Nov: AI live ASAP; CTO rulings 18 Nov + 23 Nov). Runtime-neutral (Deno and Node tests).
// * Gemini (gemini-3.5-flash-lite by default) behind the Anthropic-shaped interface the agent already uses:
//   llm(model, { system, messages, tools, max_tokens }) -> { content: [text | tool_use], stop_reason, usage }.
// * The key is picked by company: the sample company uses the free key (QA accounts the QA key); every real company
//   uses GEMINI_API_KEY_PAID and NEVER falls back to a free key. No paid key -> "AI is off for your workspace".
// * Errors become one of three codes the functions turn into plain messages: off, busy (429/5xx), credit (paid quota
//   or billing exhausted: the founder is alerted).
export const DEFAULT_MODEL = "gemini-3.5-flash-lite";
export const AI_MESSAGES = {
  off: "AI is off for your workspace.",
  busy: "Desk is busy, try again in a minute.",
  credit: "AI credit for your workspace is used up for now. Clearstage has been alerted.",
};
export class AiError extends Error {
  constructor(code, detail = "") { super(AI_MESSAGES[code] ?? code); this.code = code; this.detail = detail; }
}

/** { isSample, isQa, env } -> { key, tier }. Throws AiError("off") when the right key is missing. */
export function pickKey({ isSample, isQa = false, env }) {
  const get = k => (typeof env === "function" ? env(k) : env?.[k]) || "";
  if (isSample) {
    if (isQa && get("GEMINI_API_KEY_QA")) return { key: get("GEMINI_API_KEY_QA"), tier: "free_qa" };
    if (get("GEMINI_API_KEY")) return { key: get("GEMINI_API_KEY"), tier: "free" };
    throw new AiError("off", "no free key");
  }
  if (get("GEMINI_API_KEY_PAID")) return { key: get("GEMINI_API_KEY_PAID"), tier: "paid" };
  throw new AiError("off", "no paid key");                 // a real company never uses a free key
}

// ---------- request / response translation ----------
const KEEP = new Set(["type", "description", "enum", "properties", "required", "items", "minimum", "maximum", "minItems", "maxItems", "nullable", "format"]);
const FORMATS = new Set(["enum", "date-time"]);
/** JSON Schema -> the OpenAPI subset Gemini function declarations accept. */
export function toGeminiSchema(s) {
  if (Array.isArray(s)) return s.map(toGeminiSchema);
  if (!s || typeof s !== "object") return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (!KEEP.has(k)) continue;
    if (k === "format" && !FORMATS.has(v)) continue;
    if (k === "properties") out.properties = Object.fromEntries(Object.entries(v).map(([p, ps]) => [p, toGeminiSchema(ps)]));
    else if (k === "items") out.items = toGeminiSchema(v);
    else out[k] = v;
  }
  if (Array.isArray(out.type)) { out.nullable = out.type.includes("null"); out.type = out.type.find(t => t !== "null"); }
  if (out.type) out.type = String(out.type).toUpperCase();
  return out;
}

const blocks = c => (typeof c === "string" ? [{ type: "text", text: c }] : Array.isArray(c) ? c : []);

/** Anthropic-shaped body -> Gemini generateContent body. Keeps Gemini's thought signatures on the way back in. */
export function toGemini(body) {
  const names = {}, gids = {};                             // tool_use_id -> tool name / Gemini call id, for functionResponse
  const contents = [];
  for (const m of body.messages ?? []) {
    const parts = [];
    for (const b of blocks(m.content)) {
      if (b.type === "text" && b.text) parts.push({ text: b.text, ...(b._gsig ? { thoughtSignature: b._gsig } : {}) });
      else if (b.type === "tool_use") {
        names[b.id] = b.name; if (b._gid) gids[b.id] = b._gid;
        parts.push({ functionCall: { name: b.name, args: b.input ?? {}, ...(b._gid ? { id: b._gid } : {}) }, ...(b._gsig ? { thoughtSignature: b._gsig } : {}) });
      } else if (b.type === "tool_result") {
        let resp; try { resp = JSON.parse(typeof b.content === "string" ? b.content : JSON.stringify(b.content)); } catch { resp = b.content; }
        const response = b.is_error ? { error: String(b.content) } : (resp && typeof resp === "object" && !Array.isArray(resp) ? resp : { result: resp });
        parts.push({ functionResponse: { name: names[b.tool_use_id] ?? "tool", response, ...(gids[b.tool_use_id] ? { id: gids[b.tool_use_id] } : {}) } });
      }
    }
    if (!parts.length) continue;
    const role = m.role === "assistant" ? "model" : "user";
    const last = contents.at(-1);
    if (last && last.role === role) last.parts.push(...parts); else contents.push({ role, parts });
  }
  const system = Array.isArray(body.system) ? body.system.map(b => b.text).join("\n\n") : body.system;
  const out = { contents, generationConfig: { maxOutputTokens: body.max_tokens ?? 1024, temperature: body.temperature ?? 0.2 } };
  if (system) out.systemInstruction = { parts: [{ text: system }] };
  if (body.tools?.length) {
    out.tools = [{ functionDeclarations: body.tools.map(t => ({ name: t.name, description: t.description, parameters: toGeminiSchema(t.input_schema) })) }];
    out.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
  }
  return out;
}

let seq = 0;
/** Gemini response -> Anthropic-shaped { content, stop_reason, usage }. */
export function fromGemini(json) {
  const cand = json?.candidates?.[0];
  const content = [];
  for (const p of cand?.content?.parts ?? []) {
    if (p.thought) continue;                               // thinking summaries are not shown
    if (p.functionCall) content.push({ type: "tool_use", id: `gc_${Date.now().toString(36)}_${seq++}`, name: p.functionCall.name, input: p.functionCall.args ?? {},
      ...(p.functionCall.id ? { _gid: p.functionCall.id } : {}), ...(p.thoughtSignature ? { _gsig: p.thoughtSignature } : {}) });
    else if (typeof p.text === "string" && p.text) content.push({ type: "text", text: p.text, ...(p.thoughtSignature ? { _gsig: p.thoughtSignature } : {}) });
  }
  const u = json?.usageMetadata ?? {};
  return {
    content,
    stop_reason: content.some(b => b.type === "tool_use") ? "tool_use" : (cand?.finishReason === "MAX_TOKENS" ? "max_tokens" : "end_turn"),
    usage: { input_tokens: u.promptTokenCount ?? 0, output_tokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) },
  };
}

/** Classifies an HTTP failure from Gemini. */
export function classify(status, text, tier) {
  const t = String(text || "").toLowerCase();
  const billing = /billing|quota|exhaust|credit|insufficient|prepay|balance/.test(t);
  if (status === 429) return tier === "paid" && billing && !/per minute|rate limit/.test(t) ? "credit" : "busy";
  if (status >= 500) return "busy";
  if (status === 403 || status === 402) return tier === "paid" && billing ? "credit" : "off";
  if (status === 400 && /api key|api_key_invalid|key not valid/.test(t)) return "off";
  return null;
}

/** An llm(model, body) for one key. fetchImpl and sleep are injectable for tests. */
export function geminiLLM({ key, tier, fetchImpl = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), base = "https://generativelanguage.googleapis.com/v1beta" }) {
  return async (model, body) => {
    const url = `${base}/models/${encodeURIComponent(model || DEFAULT_MODEL)}:generateContent`;
    let last = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": key }, body: JSON.stringify(toGemini(body)) });
      if (r.ok) return fromGemini(await r.json());
      last = await r.text();
      const code = classify(r.status, last, tier);
      if (code === "credit" || code === "off") throw new AiError(code, `${r.status} ${last.slice(0, 200)}`);
      if (code === "busy" && attempt < 2) { await sleep(700 * (attempt + 1)); continue; }
      if (code === "busy") throw new AiError("busy", `${r.status} ${last.slice(0, 200)}`);
      throw new Error(`AI model error ${r.status}: ${last.slice(0, 200)}`);
    }
    throw new AiError("busy", last.slice(0, 200));
  };
}

/** Normalised prompt key for the demo replay store. */
export const replayKey = text => String(text || "").toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 300);
