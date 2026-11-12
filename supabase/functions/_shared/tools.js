// Desk tools: what the AI model may call, and how each call reaches the engine (database functions).
// Every executor returns { result, cards } — `result` goes back to the model, `cards` go to the app.
// The model can never approve or send: desk_approve / desk_discard are only reachable from a person's tap
// (see handleAction in agent.js). Money and law maths is plain code (ctc.js), never the model.
import { checkWagesRule, fixStructure, formatINR, WAGES_RULE } from "./ctc.js";

export const REJECT_REASONS = ["skills_gap", "assessment_below_bar", "experience_mismatch", "salary_mismatch",
  "location_mismatch", "notice_period", "role_filled", "no_show", "withdrew"];
const BLOCKED = /\b(age|aged|old|young|gender|female|male|woman|women|married|marital|unmarried|single|pregnan\w*|religio\w*|hindu|muslim|christian|sikh|caste|dalit|kids?|children|maternity)\b/i;
export const blockedText = s => BLOCKED.test(String(s || ""));

const str = (description) => ({ type: "string", description });
const int = (description) => ({ type: "integer", description });
const uuid = (description) => ({ type: "string", format: "uuid", description });

export const TOOL_DEFS = [
  { name: "get_brief", description: "Today's work: open tasks with Late / Today / This week buckets and task ids. Use for 'what's on today', 'kya hai aaj', morning brief.", input_schema: { type: "object", properties: {} } },
  { name: "find_people", description: "Find candidates, employees or team members by name. If more than one matches, ask the user which one before acting.", input_schema: { type: "object", properties: { name: str("Part of the name") }, required: ["name"] } },
  { name: "show_pipeline", description: "Stage-by-stage board for one open role, with candidate names, person_ids and application_ids.", input_schema: { type: "object", properties: { role: str("Role title or part of it; omit for the oldest open role") } } },
  { name: "show_joiners", description: "Recent and upcoming joiners with their onboarding checklist, plus probation reviews due soon.", input_schema: { type: "object", properties: {} } },
  { name: "create_role", description: "Draft a new role and send it for approval. Ask for anything missing first (city, budget). Openings default to 1 if not stated.", input_schema: { type: "object", properties: {
      title: str("Job title"), city: str("City or Remote"), openings: int("Number of openings, default 1"),
      budget_min_lakh: { type: "number", description: "Yearly CTC lower bound in lakh rupees" }, budget_max_lakh: { type: "number", description: "Yearly CTC upper bound in lakh rupees" },
      experience: str("e.g. '3+ years' or 'Freshers are fine'"), start_within_days: int("Days until they should join") }, required: ["title", "city"] } },
  { name: "add_candidate", description: "Add a candidate to a role (from a CV or the user's message). Only after the user confirms the candidate agreed to share their details.", input_schema: { type: "object", properties: {
      name: str("Full name"), role_id: uuid("Role id from show_pipeline"), email: str("Email"), phone: str("Phone with country code"), consent_confirmed: { type: "boolean" } }, required: ["name", "role_id", "consent_confirmed"] } },
  { name: "move_candidate", description: "Move an application to another stage. Can be undone for 10 minutes.", input_schema: { type: "object", properties: { application_id: uuid("Application id"), stage: str("Applied, Screened, Interview or Offer") }, required: ["application_id", "stage"] } },
  { name: "chase_owner", description: "Send the owner of an open task a WhatsApp reminder (e.g. an interviewer with late feedback). Internal message, no approval needed.", input_schema: { type: "object", properties: { task_id: uuid("Task id from get_brief") }, required: ["task_id"] } },
  { name: "record_feedback", description: "Save interview feedback (e.g. turned from a WhatsApp reply) as a scorecard.", input_schema: { type: "object", properties: {
      application_id: uuid("Application id"), scores: { type: "object", additionalProperties: { type: "integer", minimum: 1, maximum: 5 } },
      recommendation: { type: "string", enum: ["next_round", "hire", "reject", "hold"] }, raw_text: str("The interviewer's words") }, required: ["application_id", "scores", "recommendation"] } },
  { name: "calculate_ctc", description: "Check an offer's salary structure against the 50% wages rule with fixed code (never estimate it yourself), and save it as a draft offer. Set fix=true to rebalance into basic pay without changing CTC.", input_schema: { type: "object", properties: {
      application_id: uuid("Application id of the candidate"), fix: { type: "boolean" },
      components: { type: "array", items: { type: "object", properties: { name: { type: "string" }, kind: { type: "string", enum: ["basic", "da", "retaining", "hra", "special", "conveyance", "bonus", "other", "employer_pf", "employer_esi", "gratuity"] }, amount: { type: "integer", description: "Rupees per year" } }, required: ["name", "kind", "amount"] } },
      joining_on: str("YYYY-MM-DD if known") }, required: ["application_id", "components"] } },
  { name: "send_offer", description: "Ask for approval to send a saved offer. It goes out only when a person approves. Refused if the wages check fails.", input_schema: { type: "object", properties: { offer_id: uuid("Offer id from calculate_ctc"), summary: str("e.g. \"Kiran's offer, ₹12 L\"") }, required: ["offer_id", "summary"] } },
  { name: "draft_document", description: "Draft a letter (appointment, confirmation, extension, offer letter) for a person. Creates a draft and asks for approval; nothing is sent.", input_schema: { type: "object", properties: {
      person_id: uuid("Person id"), kind: { type: "string", enum: ["appointment_letter", "confirmation_letter", "probation_extension", "offer_letter"] }, details: str("Facts to include: role, dates, CTC, notice period") }, required: ["person_id", "kind", "details"] } },
  { name: "mark_offer_accepted", description: "When a candidate accepts a sent offer: creates the employee record, the joiner checklist and the probation review.", input_schema: { type: "object", properties: { offer_id: uuid("Offer id") }, required: ["offer_id"] } },
  { name: "start_probation_review", description: "Ask an employee's manager for their probation review on WhatsApp.", input_schema: { type: "object", properties: { person_id: uuid("Employee's person id") }, required: ["person_id"] } },
  { name: "bulk_reject", description: "Draft rejection notes for several candidates of one role with ONE job-relevant reason; they go out only after approval. Never use age, gender, marital status, religion, caste or pregnancy.", input_schema: { type: "object", properties: {
      role_id: uuid("Role id"), person_ids: { type: "array", items: { type: "string", format: "uuid" } }, reason: { type: "string", enum: REJECT_REASONS },
      note: str("Message to each candidate. Use {name} for their first name. Polite, specific to the job, no protected traits.") }, required: ["role_id", "person_ids", "reason", "note"] } },
];

const L = 100000; // rupees in a lakh
const bucketPill = b => b === "Late" ? "late" : b === "Today" ? "warn" : "info";

export function makeExecutors({ rpc, draft }) {
  const approvalCard = (subjectType, subjectId, title, preview, ap) => ({
    type: "approval", title, preview, subject_type: subjectType, subject_id: subjectId,
    approver: ap?.approver, waiting_for_other: ap ? !ap.self : false,
    actions: ap && !ap.self ? [] : [{ label: "Approve & send", action: "approve", params: { subject_type: subjectType, subject_id: subjectId } },
                                    { label: "Reject", action: "discard", params: { subject_type: subjectType, subject_id: subjectId } }],
  });

  return {
    async get_brief() {
      const b = await rpc("desk_get_brief");
      return { result: b, cards: [{ type: "brief", open: b.open, late: b.late,
        items: b.items.map(i => ({ title: i.title, why: i.why, pill: bucketPill(i.bucket), bucket: i.bucket, owner: i.owner, task_id: i.task_id })) }] };
    },
    async find_people({ name }) {
      const r = await rpc("desk_find_people", { p_query: name });
      const cards = r.length > 1 ? [{ type: "choice", question: `Which ${name}?`, options: r.map(p => ({ label: `${p.name} (${p.detail})`, value: p.name })) }] : [];
      return { result: r.length > 1 ? { ambiguous: true, matches: r, instruction: "Ask the user which one. Do not act yet." } : r, cards };
    },
    async show_pipeline({ role } = {}) {
      const r = await rpc("desk_show_pipeline", { p_role: role ?? null });
      if (r.error || r.ambiguous) return { result: r, cards: [] };
      return { result: r, cards: [{ type: "pipeline", role: r.title, city: r.city, days_open: r.days_open, role_id: r.role_id,
        columns: r.stages.map(s => ({ stage: s.stage, count: s.count, people: s.people.slice(0, 5).map(p => p.name), more: Math.max(0, s.people.length - 5) })) }] };
    },
    async show_joiners() {
      const r = await rpc("desk_show_joiners");
      return { result: r, cards: r.map(j => ({ type: "joiner_checklist", name: j.name, joined_on: j.joined_on, probation_ends_on: j.probation_ends_on,
        tasks: j.tasks.map(t => ({ title: t.title, owner: t.owner, due: t.due_at, status: t.status })) })) };
    },
    async create_role(a) {
      const r = await rpc("desk_create_role", { p_title: a.title, p_city: a.city, p_openings: a.openings ?? 1,
        p_budget_min: a.budget_min_lakh != null ? Math.round(a.budget_min_lakh * L) : null, p_budget_max: a.budget_max_lakh != null ? Math.round(a.budget_max_lakh * L) : null,
        p_experience: a.experience ?? null, p_start_days: a.start_within_days ?? null });
      const budget = a.budget_min_lakh != null ? `₹${a.budget_min_lakh}${a.budget_max_lakh && a.budget_max_lakh !== a.budget_min_lakh ? "–" + a.budget_max_lakh : ""} L` : "Budget not set";
      const preview = [`${a.openings ?? 1} × ${a.title}, ${a.city}`, budget, a.experience, a.start_within_days != null ? `Start within ${a.start_within_days} days` : null].filter(Boolean).join(" · ");
      return { result: { ...r, note: r.approval.self ? "Waiting for the user's own approval tap" : `Sent to ${r.approval.approver} for approval` },
        cards: [approvalCard("role", r.role_id, `New role: ${a.title}`, preview, r.approval)] };
    },
    async add_candidate(a) {
      if (!a.consent_confirmed) return { result: { error: "Ask the user to confirm the candidate agreed to share their details" }, cards: [] };
      const r = await rpc("desk_add_candidate", { p_name: a.name, p_role_id: a.role_id, p_email: a.email ?? null, p_phone: a.phone ?? null, p_consent: true });
      return { result: r, cards: [{ type: "info", text: `${a.name} added as Applied. Consent recorded.` }] };
    },
    async move_candidate(a) {
      const r = await rpc("desk_move_candidate", { p_application: a.application_id, p_stage: a.stage });
      return { result: r, cards: [{ type: "info", text: `Moved from ${r.from} to ${r.to}.`, actions: [{ label: "Undo (10 min)", action: "undo", params: { event: r.undo_event } }] }] };
    },
    async chase_owner({ task_id }) {
      const r = await rpc("desk_chase_owner", { p_task: task_id });
      return { result: r, cards: [] };
    },
    async record_feedback(a) {
      const r = await rpc("desk_record_feedback", { p_application: a.application_id, p_scores: a.scores, p_recommendation: a.recommendation, p_raw: a.raw_text ?? null });
      return { result: r, cards: [{ type: "scorecard", scores: a.scores, recommendation: a.recommendation, raw_text: a.raw_text ?? null, application_id: a.application_id }] };
    },
    async calculate_ctc(a) {
      const comps = a.fix ? fixStructure(a.components) : a.components;
      const check = checkWagesRule(comps);          // plain code, unit-tested
      const saved = await rpc("desk_save_offer", { p_application: a.application_id, p_components: comps, p_ctc: check.ctc,
        p_check: { passes: check.passes, wages_percent: check.wagesPercent, deemed_extra_wages: check.deemedExtraWages, rule: WAGES_RULE.id }, p_joining: a.joining_on ?? null });
      return { result: { offer_id: saved.offer_id, passes: check.passes, wages_percent: check.wagesPercent, ctc: check.ctc, deemed_extra_wages: check.deemedExtraWages,
          instruction: check.passes ? "Offer saved as a draft. Use send_offer to ask for approval." : "Fails the 50% wages rule. Offer to fix it (calculate_ctc with fix=true)." },
        cards: [{ type: "offer", offer_id: saved.offer_id, components: comps.map(c => ({ name: c.name, amount: c.amount, display: formatINR(c.amount) })),
          ctc: check.ctc, ctc_display: formatINR(check.ctc), passes: check.passes, wages_percent: check.wagesPercent,
          note: check.passes ? "Meets the 50% wages rule." : `${formatINR(check.deemedExtraWages)} would count as wages for PF and gratuity.`,
          citation: WAGES_RULE.citation, status: WAGES_RULE.status, legal: "Calculated by fixed rules, not AI. Not legal advice." }] };
    },
    async send_offer({ offer_id, summary }) {
      const ap = await rpc("desk_request_approval", { p_subject_type: "offer", p_subject_id: offer_id, p_summary: summary });
      return { result: ap, cards: [approvalCard("offer", offer_id, `Offer: ${summary}`, "Goes to the candidate by email once approved. Valid for 3 days.", ap)] };
    },
    async draft_document({ person_id, kind, details }) {
      const body = await draft(kind, details);       // larger model writes the text; it is only a draft
      const doc = await rpc("desk_save_document", { p_person: person_id, p_kind: kind, p_body: body, p_summary: details.slice(0, 200), p_batch: null });
      const ap = await rpc("desk_request_approval", { p_subject_type: "document", p_subject_id: doc.document_id, p_summary: kind.replace(/_/g, " ") });
      return { result: { document_id: doc.document_id, approval: ap }, cards: [approvalCard("document", doc.document_id, kind.replace(/_/g, " ").replace(/^\w/, c => c.toUpperCase()), body, ap)] };
    },
    async mark_offer_accepted({ offer_id }) {
      const r = await rpc("desk_mark_offer_accepted", { p_offer: offer_id });
      const j = await rpc("desk_show_joiners");
      const me = j.find(x => x.person_id === r.person_id);
      return { result: r, cards: me ? [{ type: "joiner_checklist", name: me.name, joined_on: me.joined_on, probation_ends_on: me.probation_ends_on,
        tasks: me.tasks.map(t => ({ title: t.title, owner: t.owner, due: t.due_at, status: t.status })) }] : [] };
    },
    async start_probation_review({ person_id }) {
      const r = await rpc("desk_start_probation_review", { p_person: person_id });
      return { result: r, cards: [] };
    },
    async bulk_reject(a) {
      if (!REJECT_REASONS.includes(a.reason)) return { result: { error: "Use a job-relevant reason from the list" }, cards: [] };
      if (blockedText(a.note)) return { result: { error: "The note mentions a protected trait. Rewrite it about the job only." }, cards: [] };
      const r = await rpc("desk_bulk_reject", { p_role: a.role_id, p_person_ids: a.person_ids, p_reason: a.reason, p_note: a.note });
      return { result: r, cards: [{ type: "bulk_preview", count: r.drafts, reason: a.reason, note: a.note, batch_id: r.batch_id,
        approver: r.approval.approver, waiting_for_other: !r.approval.self,
        actions: r.approval.self ? [{ label: `Send all ${r.drafts}`, action: "approve", params: { subject_type: "batch", subject_id: r.batch_id } },
                                    { label: "Discard", action: "discard", params: { subject_type: "batch", subject_id: r.batch_id } }] : [] }] };
    },
  };
}
