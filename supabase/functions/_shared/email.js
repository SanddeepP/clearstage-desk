// Email through Resend (founder order 26 Nov, item 3). Runtime-neutral (Deno and Node tests).
// Sender: "<Company> via Clearstage" <notify@mail.crovantapartner.com> (the verified Resend domain). Replies go to the
// person who approved the message. Plain text only; the approved text is sent exactly as approved.
export const DEFAULT_FROM = "notify@mail.crovantapartner.com";
export const EMAIL_MESSAGES = {
  not_connected: "Email isn't connected yet, so messages stay queued.",
  paused: "Sending is paused by Clearstage right now, so messages stay queued.",
  refused: "The email address was refused. Check it and retry.",
  busy: "The email service is busy. It will try again.",
  setup: "Email isn't set up correctly. Clearstage has been alerted.",
};

/** A company name that's safe inside a From header: no quotes, angle brackets or line breaks; at most 60 characters. */
export function senderName(company) {
  const n = String(company ?? "").replace(/[\r\n"<>\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  return `${n || "Your employer"} via Clearstage`;
}
export function fromHeader(company, addr = DEFAULT_FROM) { return `"${senderName(company)}" <${addr}>`; }

const ADDR = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]{2,}$/;
/** The Resend request body for one claimed message (from email_claim). */
export function resendPayload(m, from = DEFAULT_FROM) {
  if (!ADDR.test(String(m?.to ?? ""))) throw new Error("No valid email address");
  const body = { from: fromHeader(m.company, from), to: [m.to], subject: String(m.subject || `A message from ${m.company}`).replace(/[\r\n]+/g, " ").slice(0, 200),
    text: `${m.body}\n\n—\nSent by ${m.company} through Clearstage.` };
  if (m.reply_to && ADDR.test(m.reply_to)) body.reply_to = m.reply_to;
  return body;
}

/** Resend HTTP status → { code, retry, message }. 401/403: the key is wrong or missing rights (founder alerted). */
export function classifyResend(status) {
  if (status >= 200 && status < 300) return { code: "ok", retry: false, message: "" };
  if (status === 401 || status === 403) return { code: "setup", retry: false, message: EMAIL_MESSAGES.setup };
  if (status === 422 || status === 400) return { code: "refused", retry: false, message: EMAIL_MESSAGES.refused };
  return { code: "busy", retry: true, message: EMAIL_MESSAGES.busy };
}

/** Send every claimed message. deps: { claim(), result(id, ok, providerId, error), fetch, key, from, alert(kind, detail) }.
 *  Returns { status, sent, failed, results }. Never throws for one bad message: each gets its own result. */
export async function sendQueued(deps) {
  if (!deps.key) return { status: "not_connected", sent: 0, failed: 0, results: [], message: EMAIL_MESSAGES.not_connected };
  const c = await deps.claim();
  if (c?.paused) return { status: "paused", sent: 0, failed: 0, results: [], message: EMAIL_MESSAGES.paused };
  const results = []; let sent = 0, failed = 0, alerted = false;
  for (const m of c?.messages ?? []) {
    let ok = false, providerId = null, error = null;
    try {
      const r = await deps.fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${deps.key}`, "Content-Type": "application/json" },
        body: JSON.stringify(resendPayload(m, deps.from || DEFAULT_FROM)) });
      const j = await r.json().catch(() => ({}));
      const k = classifyResend(r.status);
      ok = k.code === "ok"; providerId = j?.id ?? null; error = ok ? null : k.message;
      if (k.code === "setup" && !alerted && deps.alert) { alerted = true; await deps.alert("email_setup", { status: r.status }); }
    } catch (e) { error = String(e?.message || e).slice(0, 200); }
    const res = await deps.result(m.id, ok, providerId, error);
    results.push({ id: m.id, status: res?.status ?? (ok ? "sent" : "queued"), error });
    if (ok) sent++; else failed++;
  }
  return { status: "done", sent, failed, results };
}
