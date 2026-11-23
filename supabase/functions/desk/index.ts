// Desk agent — Supabase Edge Function.
// POST /functions/v1/desk with the user's Supabase session token.
//   { "action": "chat", "text": "Ek data analyst chahiye Bangalore mein, 8-10L", "conversation_id": "…" }
//   { "action": "approve" | "discard", "params": { "subject_type": "role|offer|document|batch", "subject_id": "…" } }
//   { "action": "undo", "params": { "event": 123 } }      { "action": "load_sample_data" }
// Response: { conversation_id, reply, cards: [...] } — cards follow docs/desk-cards.md so web, phone and WhatsApp can render them.
// Secrets (Supabase → Edge Functions → Secrets, never in the repo): GEMINI_API_KEY_PAID (real companies),
// GEMINI_API_KEY (sample company), GEMINI_API_KEY_QA (sample company, QA accounts listed in QA_EMAILS).
// Optional: DESK_MODEL_ROUTE, DESK_MODEL_DRAFT (default gemini-3.5-flash-lite), DESK_MONTHLY_TOKEN_CAP, DESK_ALLOWED_ORIGINS, QA_EMAILS.
import { createClient } from "npm:@supabase/supabase-js@2.50.0";
import { runTurn, handleAction, friendly } from "../_shared/agent.js";
import { AiError, AI_MESSAGES, DEFAULT_MODEL, geminiLLM, pickKey, replayKey } from "../_shared/ai.js";

const MODELS = {
  route: Deno.env.get("DESK_MODEL_ROUTE") ?? DEFAULT_MODEL,
  draft: Deno.env.get("DESK_MODEL_DRAFT") ?? DEFAULT_MODEL,
};
const TOKEN_CAP = Number(Deno.env.get("DESK_MONTHLY_TOKEN_CAP") ?? 2_000_000);
const ALLOWED = (Deno.env.get("DESK_ALLOWED_ORIGINS") ?? "https://desk.crovantapartner.com,http://localhost:8000,http://localhost:8765").split(",");

// New Supabase projects expose publishable keys; older ones SUPABASE_ANON_KEY. Either works for a user-scoped client.
function publicKey(): string {
  const legacy = Deno.env.get("SUPABASE_ANON_KEY");
  if (legacy) return legacy;
  const single = Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  if (single) return single;
  try { const all = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") ?? "{}"); return all.default ?? Object.values(all)[0] as string; } catch { return ""; }
}

function cors(req: Request) {
  const origin = req.headers.get("origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ALLOWED.includes(origin) ? origin : ALLOWED[0],
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
const json = (req: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": "application/json" } });

const QA_EMAILS = (Deno.env.get("QA_EMAILS") ?? "").toLowerCase().split(",").map(e => e.trim()).filter(Boolean);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return json(req, { error: "Use POST" }, 405);

  const auth = req.headers.get("Authorization") ?? "";
  // Runs as the signed-in user: row-level security and the 003/004 guards apply to every tool call.
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, publicKey(), { global: { headers: { Authorization: auth } } });
  const { data: u } = await sb.auth.getUser();
  if (!u?.user) return json(req, { error: "Sign in first" }, 401);
  const { data: me } = await sb.rpc("current_member");
  if (!me?.id) return json(req, { error: "Set up your workspace first" }, 403);

  const rpc = async (name: string, args: Record<string, unknown> = {}) => {
    const { data, error } = await sb.rpc(name, args);
    if (error) throw new Error(error.message);
    return data;
  };

  let body: { action?: string; text?: string; conversation_id?: string; params?: Record<string, unknown> };
  try { body = await req.json(); } catch { return json(req, { error: "Send JSON" }, 400); }
  const action = body.action ?? "chat";

  try {
    if (action !== "chat") return json(req, await handleAction({ action, params: body.params, rpc }));

    // C2: the live agent is allow-listed per company until pilots (switched on by Clearstage, not by users).
    const ctx = await rpc("desk_ai_context");
    if (ctx?.desk_enabled !== true) return json(req, { error: "The live Desk agent isn't switched on for your company yet. It's in a closed beta." }, 403);
    // Key by company: the sample company uses the free key, every real company the paid key, never a free one.
    let pick: { key: string; tier: string };
    try { pick = pickKey({ isSample: ctx.is_sample === true, isQa: QA_EMAILS.includes(String(u.user.email ?? "").toLowerCase()), env: (k: string) => Deno.env.get(k) }); }
    catch (e) {
      if (!ctx.is_sample) await sb.rpc("raise_platform_alert", { p_kind: "ai_key_missing", p_detail: { function: "desk" } });
      return json(req, { reply: AI_MESSAGES.off, cards: [], blocked: "ai_off" });
    }
    const llm = geminiLLM({ key: pick.key, tier: pick.tier });

    const text = String(body.text ?? "").trim().slice(0, 4000);
    if (!text) return json(req, { error: "Say something to Desk" }, 400);

    // Conversation: reuse the member's own conversation or start one
    let convId = body.conversation_id;
    if (convId) { const { data } = await sb.from("desk_conversation").select("id").eq("id", convId).maybeSingle(); if (!data) convId = undefined; }
    if (!convId) {
      const { data, error } = await sb.from("desk_conversation").insert({ company_id: me.company_id, member_id: me.id }).select("id").single();
      if (error) throw error; convId = data.id;
    }
    const { data: past } = await sb.from("desk_message").select("role, content").eq("conversation_id", convId).order("id", { ascending: false }).limit(20);
    const history = trimHistory((past ?? []).reverse());

    let out;
    try {
    out = await runTurn({ text, history, deps: {
      llm, rpc, models: MODELS, tokenCap: TOKEN_CAP,
      monthTokens: () => rpc("desk_month_tokens"),
      logUsage: async ({ model, purpose, tools, usage }: { model: string; purpose: string; tools: string[]; usage?: { input_tokens?: number; output_tokens?: number } }) => {
        await sb.from("ai_usage").insert({ company_id: me.company_id, conversation_id: convId, model, purpose, tools, key_tier: pick.tier,
          input_tokens: usage?.input_tokens ?? 0, output_tokens: usage?.output_tokens ?? 0 });
      },
    } });
    } catch (e) {
      if (!(e instanceof AiError)) throw e;
      if (e.code === "credit") {
        await sb.rpc("raise_platform_alert", { p_kind: "ai_credit_exhausted", p_detail: { function: "desk", tier: pick.tier, detail: e.detail.slice(0, 200) } });
        return json(req, { conversation_id: convId, reply: AI_MESSAGES.credit, cards: [], blocked: "ai_credit" });
      }
      if (e.code === "busy" && ctx.is_sample) {           // demo replay: the sample company's stored answer, marked as replayed
        const r = await rpc("desk_replay_get", { p_key: replayKey(text) });
        if (r?.reply) return json(req, { conversation_id: convId, reply: `${r.reply} (replayed: Desk is busy right now)`, cards: r.cards ?? [], replayed: true });
      }
      return json(req, { conversation_id: convId, reply: e.code === "off" ? AI_MESSAGES.off : AI_MESSAGES.busy, cards: [], blocked: `ai_${e.code}` });
    }
    if (ctx.is_sample && out.reply && !out.blocked) await sb.rpc("desk_replay_save", { p_key: replayKey(text), p_reply: out.reply, p_cards: out.cards ?? [] });
    if (out.newMessages?.length) {
      await sb.from("desk_message").insert(out.newMessages.map((m: { role: string; content: unknown }) => ({ conversation_id: convId, company_id: me.company_id, role: m.role, content: m.content })));
    }
    return json(req, { conversation_id: convId, reply: out.reply, cards: out.cards, blocked: out.blocked ?? null });
  } catch (e) {
    return json(req, { error: friendly(e) }, 400);
  }
});

// History must start with a plain user message and never split a tool_use from its tool_result.
function trimHistory(msgs: { role: string; content: Array<{ type: string }> }[]) {
  let i = 0;
  while (i < msgs.length && !(msgs[i].role === "user" && msgs[i].content.every(b => b.type === "text"))) i++;
  return msgs.slice(i);
}
