# Clearstage Desk prototype

Chat-first HR teammate for Indian companies with 20–200 people: **Hire → Join → Confirm**.
Live at **https://desk.crovantapartner.com** (GitHub Pages).

## What works now (Week 1, brief rev 2)
- Sign-in with a 6-digit code sent to your email, then first-time setup (name, company, WhatsApp number, team setup).
  - **Demo mode** (no Supabase keys in `config.js`): the code is shown on screen and data stays in your browser.
  - **Live mode**: Supabase Auth emails the code; your company and profile are saved in Postgres (Mumbai).
- Pinned status strip (tiles link to their Check view) and a "Preview: sample data, nothing is sent" notice in the chat.
- Left navigation: **Ask → Desk** (default) and **Check → Today · Hiring · People · Joiners & probation**, with count badges (Today turns red when something is late).
  - Check views only read. Every button ("Do it with Desk", "Build Kiran's offer in Desk", "Fix with Desk", "Start with Desk") switches to the chat and runs the action there, through approval cards and the audit log.
  - Today: all tasks with Late / Today / This week / Done filters. Hiring: role cards with stage bar and counts, tap for the board. People: everyone in one table with search and type filter. Lead + juniors adds an owner filter.
- One data source: chat actions update the Check views and the strip immediately.
- All 7 card types from the brief. Solo and Lead + juniors; in Lead + juniors, approvals wait in Today and on WhatsApp.
- Free text is read by `lib/intent.js` (tested). Hiring requests like "Ek data analyst chahiye Bangalore mein, 8-10L" become the right role; Desk asks for anything missing. Anything it doesn't understand gets an honest "I can't do that yet in this preview", never a wrong action.
- Guardrails: drafts until approved, approvals logged, 10-minute undo, fixed rejection reasons, protected-trait text blocked, "Arjun Mehta or Arjun Rao?".
- `lib/ctc.js`: the 50% wages check and auto-fix in plain code. `npm test` runs 14 tests (CTC and request reading).
- `supabase/migrations/001_schema.sql`, `002_scheduler.sql` and `supabase/seed.sql`: every table from the brief, row-level security, sign-up function, the task scheduler (reminders, then escalation, every 5 minutes via pg_cron), the `today_tasks` view, and Acme Fintech demo data.

Desk's replies are still scripted. The AI agent with tools comes in Week 2 and real WhatsApp in Week 4.

## Turn on real email codes (Supabase)
1. Create a project at supabase.com, region **Mumbai (ap-south-1)**.
2. Database → Extensions: enable `pg_cron`. Then SQL editor → run `supabase/migrations/001_schema.sql`, `002_scheduler.sql`, then `supabase/seed.sql`.
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
