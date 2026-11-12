// Desk agent — Supabase Edge Function.
// POST /functions/v1/desk with the user's Supabase session token.
//   { "action": "chat", "text": "Ek data analyst chahiye Bangalore mein, 8-10L", "conversation_id": "…" }
//   { "action": "approve" | "discard", "params": { "subject_type": "role|offer|document|batch", "subject_id": "…" } }
//   { "action": "undo", "params": { "event": 123 } }      { "action": "load_sample_data" }
// Response: { conversation_id, reply, cards: [...] } — cards follow docs/desk-cards.md so web, phone and WhatsApp can render them.
// Secrets (set in Supabase → Edge Functions → Secrets, never in the repo): ANTHROPIC_API_KEY.
// Optional: DESK_MODEL_ROUTE, DESK_MODEL_DRAFT, DESK_MONTHLY_TOKEN_CAP, DESK_ALLOWED_ORIGINS.
import { createClient } from "npm:@supabase/supabase-js@2.50.0";
import { runTurn, handleAction, friendly } from "../_shared/agent.js";

const MODELS = {
  route: Deno.env.get("DESK_MODEL_ROUTE") ?? "claude-haiku-5-5",
  draft: Deno.env.get("DESK_MODEL_DRAFT") ?? "claude-sonnet-5-5",
};
const TOKEN_CAP = Number(Deno.env.get("DESK_MONTHLY_TOKEN_CAP") ?? 2_000_000);
const ALLOWED = (Deno.env.get("DESK_ALLOWED_ORIGINS") ?? "https://desk.crovantapartner.com,http://localhost:8000,http://localhost:8765").split(",");

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

async function anthropic(model: string, body: Record<string, unknown>) {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) throw new Error("NOT_CONFIGURED");
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, ...body }),
    });
    if (r.ok) return await r.json();
    if (r.status === 429 || r.status >= 500) { await new Promise(res => setTimeout(res, 800 * (attempt + 1))); continue; }
    throw new Error(`AI model error ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  throw new Error("The AI model is busy. Try again in a minute.");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return json(req, { error: "Use POST" }, 405);

  const auth = req.headers.get("Authorization") ?? "";
  // Runs as the signed-in user: row-level security and the 003/004 guards apply to every tool call.
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
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

    const out = await runTurn({ text, history, deps: {
      llm: anthropic, rpc, models: MODELS, tokenCap: TOKEN_CAP,
      monthTokens: () => rpc("desk_month_tokens"),
      logUsage: async ({ model, purpose, tools, usage }: { model: string; purpose: string; tools: string[]; usage?: { input_tokens?: number; output_tokens?: number } }) => {
        await sb.from("ai_usage").insert({ company_id: me.company_id, conversation_id: convId, model, purpose, tools,
          input_tokens: usage?.input_tokens ?? 0, output_tokens: usage?.output_tokens ?? 0 });
      },
    } });
    if (out.newMessages?.length) {
      await sb.from("desk_message").insert(out.newMessages.map((m: { role: string; content: unknown }) => ({ conversation_id: convId, company_id: me.company_id, role: m.role, content: m.content })));
    }
    return json(req, { conversation_id: convId, reply: out.reply, cards: out.cards, blocked: out.blocked ?? null });
  } catch (e) {
    if (String((e as Error)?.message) === "NOT_CONFIGURED") return json(req, { error: "Desk's AI isn't connected yet. Add ANTHROPIC_API_KEY in Supabase secrets." }, 503);
    return json(req, { error: friendly(e) }, 400);
  }
});

// History must start with a plain user message and never split a tool_use from its tool_result.
function trimHistory(msgs: { role: string; content: Array<{ type: string }> }[]) {
  let i = 0;
  while (i < msgs.length && !(msgs[i].role === "user" && msgs[i].content.every(b => b.type === "text"))) i++;
  return msgs.slice(i);
}
