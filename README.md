# Clearstage Desk prototype

Chat-first HR teammate for Indian companies with 20–200 people: **Hire → Join → Confirm**.
Live at **https://desk.crovantapartner.com** (GitHub Pages).

## What works now (Week 1, brief rev 2)
- Sign-in with a 6-digit code sent to your email, then first-time setup (name, company, WhatsApp number, team setup).
  - **Demo mode** (no Supabase keys in `config.js`): the code is shown on screen and data stays in your browser.
  - **Live mode**: Supabase Auth emails the code; your company and profile are saved in Postgres (Mumbai).
- Pinned status strip (tiles link to their Check view) and a "Preview: sample data, nothing is sent" notice in the chat.
- Left navigation (founder direction, 12 Nov: bring back the Recruiter Desk dashboards, chat box at the bottom):
  - **Overview** (landing): stats, what needs you with Desk suggestions, coming-up interviews, pipeline, Desk insight, recent approvals.
  - **Ask Desk**: the chat. A Desk chat box sits at the bottom of every screen; typing anywhere switches to Desk.
  - **Work**: Today (tasks with Late / Today / This week / Done filters), Jobs (role cards with stage bars, tap for the board), Candidates (everyone in one searchable table; click anyone for their profile), Interviews (schedule and feedback status), Joiners & probation, Approvals (waiting queue and approval log).
  - **Insights & admin**: Insights (sample metrics), Integrations (connection status), Settings (team setup, response targets, how Desk may act).
  - Screens only read. Every button ("Do it with Desk", "Build Kiran's offer in Desk", "Review in Desk") switches to the chat and runs the action there, through approval cards and the audit log.
- One data source: chat actions update the Check views and the strip immediately.
- All 7 card types from the brief. Solo and Lead + juniors; in Lead + juniors, approvals wait in Today and on WhatsApp.
- Free text is read by `lib/intent.js` (tested). Hiring requests like "Ek data analyst chahiye Bangalore mein, 8-10L" become the right role; Desk asks for anything missing. Anything it doesn't understand gets an honest "I can't do that yet in this preview", never a wrong action.
- Guardrails: drafts until approved, approvals logged, 10-minute undo, fixed rejection reasons, protected-trait text blocked, "Arjun Mehta or Arjun Rao?".
- `lib/ctc.js`: the 50% wages check and auto-fix in plain code. `npm test` runs 17 tests (CTC and request reading), also on every push via GitHub Actions.
- `supabase/migrations/001_schema.sql`, `002_scheduler.sql` and `supabase/seed.sql`: every table from the brief, row-level security, sign-up function, the task scheduler (reminders, then escalation, every 5 minutes via pg_cron), the `today_tasks` view, and Acme Fintech demo data.

Desk's replies are still scripted. The AI agent with tools comes in Week 2 and real WhatsApp in Week 4.

## Supabase (live since 12 Nov)
Project `clearstage`, Mumbai (ap-south-1), organization Clearstage (free plan). Schema, scheduler (pg_cron, every 5 min) and seed are loaded; all 14 tables have row-level security. Site URL: https://desk.crovantapartner.com.
Sign-in currently emails a **link** (Supabase's default template). To send 6-digit codes and lift the built-in email limit, connect an email sender (SMTP) and add `{{ .Token }}` to the "Magic link or OTP" template.

## Setting up Supabase from scratch (reference)
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
