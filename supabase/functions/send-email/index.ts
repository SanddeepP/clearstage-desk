// send-email — sends the caller's company's queued, approved emails through Resend (founder order 26 Nov, item 3).
// POST {} with the user's session. Runs as the signed-in user: email_claim only hands out that company's messages,
// only ones a person approved, and none while Clearstage has paused sending. Secrets: RESEND_API_KEY (set by the
// founder in Supabase → Edge Functions → Secrets; never in the repo), optional EMAIL_FROM.
import { createClient } from "npm:@supabase/supabase-js@2.50.0";
import { sendQueued } from "../_shared/email.js";

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
  const rpc = async (name: string, args: Record<string, unknown> = {}) => { const { data, error } = await sb.rpc(name, args); if (error) throw new Error(error.message); return data; };
  try {
    const out = await sendQueued({
      key: Deno.env.get("RESEND_API_KEY") ?? "", from: Deno.env.get("EMAIL_FROM") ?? undefined, fetch,
      claim: () => rpc("email_claim", { p_limit: 10 }),
      result: (id: string, ok: boolean, providerId: string | null, error: string | null) => rpc("email_result", { p_id: id, p_ok: ok, p_provider_id: providerId, p_error: error }),
      alert: (kind: string, detail: unknown) => sb.rpc("raise_platform_alert", { p_kind: kind, p_detail: detail }),
    });
    return json(req, out);
  } catch (e) {
    return json(req, { error: String((e as Error)?.message ?? e) }, 200);
  }
});
