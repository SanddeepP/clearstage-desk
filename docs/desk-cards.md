# Desk API and card contract

One endpoint serves the web app, the phone app and (later) the WhatsApp webhook.

`POST https://yqqzhtxuriqzajzlwryq.supabase.co/functions/v1/desk`
Headers: `Authorization: Bearer <user's Supabase access token>`, `apikey: <publishable key>`, `Content-Type: application/json`.

## Requests
| Body | What happens |
|---|---|
| `{"action":"chat","text":"Ek data analyst chahiye Bangalore mein, 8-10L","conversation_id":"…"}` | One turn through the agent. Omit `conversation_id` to start a new conversation. |
| `{"action":"approve","params":{"subject_type":"role\|offer\|document\|batch","subject_id":"…"}}` | A person's Approve tap. Never called by the model. |
| `{"action":"discard","params":{…same…}}` | A person's Reject tap. |
| `{"action":"undo","params":{"event":123}}` | Undo a candidate move within 10 minutes. |
| `{"action":"load_sample_data"}` | Owner only, empty workspace only: loads the Acme-style demo data. |

## Response
`{ "conversation_id": "…", "reply": "short text from Desk", "cards": [ … ], "blocked": null | "cost_cap" }`
Errors: `{ "error": "plain sentence" }` with 400/401/403/503. 503 means the AI key isn't set.

## Cards
Render every card from its fields; never from the reply text. Unknown `type` → ignore. Every card may carry
`actions: [{ "label", "action", "params" }]`; send `{ action, params }` back to the endpoint when tapped.

| type | Fields |
|---|---|
| `brief` | `open`, `late`, `items[{title, why, bucket: Late/Today/This week, pill: late/warn/info, owner, task_id}]` |
| `approval` | `title`, `preview` (text or letter body), `subject_type`, `subject_id`, `approver`, `waiting_for_other` (true → show "Waiting for {approver}", no buttons) |
| `pipeline` | `role`, `city`, `days_open`, `role_id`, `columns[{stage, count, people[names], more}]` |
| `offer` | `offer_id`, `components[{name, amount, display}]`, `ctc`, `ctc_display`, `passes`, `wages_percent`, `note`, `citation`, `status`, `legal` |
| `scorecard` | `scores{criterion: 1–5}`, `recommendation`, `raw_text`, `application_id` |
| `joiner_checklist` | `name`, `joined_on`, `probation_ends_on`, `tasks[{title, owner, due, status}]` |
| `bulk_preview` | `count`, `reason`, `note` (with `{name}`), `batch_id`, `approver`, `waiting_for_other` |
| `choice` | `question`, `options[{label, value}]` → send `value` as the next chat text |
| `info` | `text` |

## Guarantees (enforced in the database, not just the app)
- The model has no approve tool. Approvals are stamped with the signed-in person by the database (migration 003).
- Offers that fail the 50% wages check can't be sent for approval. The check is `ctc.js`, plain code with tests.
- Rejection reasons come from a fixed list; protected traits in the text are refused.
- Every Desk action is in `audit_event`; token use per model call is in `ai_usage` with the tools chosen.

## Screening (migration 007, function `screen-cv`)
One CV per call: `POST /functions/v1/screen-cv {"job_id": 123}`, after `desk_enqueue_cv` stored the file in the private `cvs` bucket.
Numbers on these cards come from the database (`score`), never from the model.

| type | Fields |
|---|---|
| `requirements` | `requirement_id`, `version`, `must[{id,label,terms}]`, `nice[...]`, `conditions[...]`, `experience{min,max}`, `weights`, `confirmed`; action `confirm_requirements` |
| `shortlist` | `role_id`, `stars_filter`, `rows[{application_id, name, fit, stars, years, pinned, version}]` (top 10, pinned first, ties by applied first) |
| `why_shortlisted` | `application_id`, `score{…}`, `evidence[{item, quote, section, confidence}]`, `gaps[]`, `requirements{…}`, `note` |
| `bulk_preview` (screening) | `preview_only: true`, `batch_id`, `count`, `people[{name, must_met, must_total, missing[]}]`, `note`, `oldest_application`, `clock`; action `approve_reject_batch_preview` (sends nothing) |

Person-only actions (never model tools): `confirm_requirements`, `override_stars {application_id, stars, reason}` (reason from the fixed chip list), `pin`, `mark_contacted`.
