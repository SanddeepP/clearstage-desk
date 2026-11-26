# Clearstage runbook

Operational notes for the founder. The full on-call runbook (CTO deliverable E3, due 11 Dec) extends this file.

## Access
- `platform_admin` is set by hand in the SQL editor; the founder is its only member.

## Roles (017, G2)
- Roles live in `member_role` (super_admin, hr, recruiter, manager) with the `see_pay` and `offer_approver` flags on `member`. They change only through Settings → People (`set_member_roles`, `invite_member`): Super admin only, never your own, every change in the company's audit log (`roles_changed`, `member_invited`, `invite_accepted`).
- `member.app_role` is a read-only mirror of the roles for one release, so today's rules keep working. Don't edit it in the SQL editor; if you must, the roles are re-mapped from it automatically. It is removed in the release after go-live, with the role permissions.

## Employee logins (018)
- Employees are never members. Their login is a row in `employee_account` (company, person, email, user), given by HR or a Super admin in Settings → Employee logins and change requests (`invite_employee`). They sign in with that email and see only their own record (`my_employee`).
- An email with a staff login can't also be an Employee login, and an Employee login can't create a workspace.
- Changes employees ask for (`request_profile_change`) apply only when HR or a Super admin approves them (`decide_profile_change`); every step is in the audit log.
- The public demo has five role logins (`admin@`, `hr@`, `recruiter@`, `manager@`, `employee@acme.demo`). They exist only in the signed-out demo, never in the database.

## Live CV screening (FA-014, 26 Nov)
- Clearstage switches it on per real company: Settings → Modules → choose the company → **Live CV screening: On**. Logged in that company's audit (`cv_live_set`). Until the founder approves more pilots (FA-015) only one real company can be on at a time; the database refuses a second (`cv_live_cap()` = 1).
- In that company, Upload in Ask Desk takes one PDF or DOCX (≤ 5 MB): pick the role (only roles with a confirmed requirements card), type the candidate's name, tick that they agreed to share their CV, Screen. The file goes to the private `cvs` bucket at `<company id>/<random id>.pdf|docx`, is queued (`desk_enqueue_cv`) and screened by `screen-cv` on `GEMINI_API_KEY_PAID` only.
- Before the AI sees it, the text is masked: name, emails, phones, links, addresses (city kept), dates of birth, protected words, and college names (keyword rule + 3,500 AISHE institution names, `lib/aishe.js`, MIT-licensed source; regenerate with `scripts/aishe-names.py`).
- **Delete CV** on the result card removes the stored file first, then `desk_delete_cv` removes the file record, screening job, masked text, quotes, score and cached AI answer. The candidate stays on the role (deleting a person is the DPDP delete, item 8). The database refuses to delete the record while the file is still stored.
- Switching off: same switch → Off. Stored CVs stay until deleted or the retention job removes them.

## Email through Resend (item 3, 26 Nov)
- Approving an offer, letter or Closure Note (or a chase) queues an email; the app then calls the `send-email` function, which sends the company's queued, approved emails from **"<Company> via Clearstage" <notify@mail.crovantapartner.com>**, replies to the approver. Plain text, exactly as approved; a queued message can't be edited, only cancelled.
- States (Settings → Email): Queued · Sending · Sent · Not sent (after 3 tries) · No email address. Retry puts a failed one back in the queue. Sent and final failures are audited (`email_sent`, `email_failed`, message id only).
- **Needs the secret `RESEND_API_KEY`** in Supabase → Edge Functions → Secrets (set by the founder; never in the repo or chat). Until then everything stays queued and the app says "Email isn't connected yet". Optional `EMAIL_FROM` to change the sending address (must be on the verified domain).
- A 401/403 from Resend raises a platform alert (`email_setup`).
- WhatsApp stays a preview: an outbound WhatsApp message is sent by email.
- Messages queued by the scheduler (reminders) go out the next time anyone in that company approves something or taps **Send queued now**. A timed sender comes with the backup workflow.

## Safety switches (item 6, 26 Nov)
- Settings → **Safety switches** (platform admin only): **Desk AI, every company** (Running / Paused), **Sending, every company** (Sending / Paused), **Pilot cap** (1–5).
- Paused Desk: Desk and CV screening stop answering; approvals, screens and email still work. Paused sending: nothing goes out; emails stay queued.
- Pilot cap: how many real companies may have live CV screening. It's 1; raise it to 3 only once the founder's register says FA-015 is Approved.
- Every change is in `platform_audit` (read in the SQL editor).
