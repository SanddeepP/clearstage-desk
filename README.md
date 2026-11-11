# Clearstage Desk prototype

Chat-first HR teammate for Indian companies with 20–200 people: **Hire → Join → Confirm**.
Live at **https://desk.crovantapartner.com** (GitHub Pages).

## What works now (Week 1)
- Sign-in with a 6-digit code sent to your email, then first-time setup (name, company, WhatsApp number, team setup).
  - **Demo mode** (no Supabase keys in `config.js`): the code is shown on screen and data stays in your browser.
  - **Live mode**: Supabase Auth emails the code; your company and profile are saved in Postgres (Mumbai).
- One screen: status strip, Desk chat with quick replies, file upload, WhatsApp preview.
- Tabs for navigation (founder decision, 11 Nov, overriding the brief's "no tabs"): Desk, Roles, Pipeline, Joiners & probation, Approvals. Chat stays the home screen; tabs and chat share the same state, and status-strip tiles link to their tab.
- All 7 card types from the brief: brief, approval, pipeline, offer/CTC, scorecard, joiner checklist, bulk preview.
- Solo and Lead + juniors setups. Approvals go to your WhatsApp number (preview panel for now).
- Guardrails: drafts until approved, approvals logged, 10-minute undo, fixed rejection reasons, protected-trait text blocked, "ask, don't guess".
- `lib/ctc.js`: the 50% wages check and auto-fix in plain code, with tests (`npm test`).
- `supabase/migrations/001_schema.sql` and `supabase/seed.sql`: every table from the brief, row-level security, sign-up function, Acme Fintech demo data.

Desk's replies are still scripted. The AI model and real WhatsApp come in Weeks 2 and 4.

## Turn on real email codes (Supabase)
1. Create a project at supabase.com, region **Mumbai (ap-south-1)**.
2. SQL editor → run `supabase/migrations/001_schema.sql`, then `supabase/seed.sql`.
3. Authentication → URL configuration → Site URL: `https://desk.crovantapartner.com`.
4. Authentication → Email templates → **Magic Link**: put `{{ .Token }}` in the body so the email shows the 6-digit code, e.g.
   `Your Clearstage sign-in code is {{ .Token }}. It expires in 1 hour.`
5. Copy **Project URL** and **anon public** key into `config.js`. Never put the `service_role` key in this repo.
6. Supabase's built-in email sender allows only a few emails an hour. Before the 20 interviews, add your own SMTP
   (Authentication → SMTP settings), for example Resend or Brevo on a free plan.

## WhatsApp approvals to your phone (Week 4)
Twilio WhatsApp sandbox: create a Twilio account, join the sandbox from your phone by sending the join code,
then add the Twilio credentials as Supabase Edge Function secrets (not in this repo).

## Domain
`CNAME` holds `desk.crovantapartner.com`. In Hostinger DNS add: `CNAME  desk  →  sanddeepp.github.io`.

## Run locally
```
python3 -m http.server 8000   # then open http://localhost:8000
npm test                       # CTC rule tests
```
Not legal advice. Every rule shows its citation and the status "awaiting legal review".
