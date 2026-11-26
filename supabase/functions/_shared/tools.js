// Desk tools: what the AI model may call, and how each call reaches the engine (database functions).
// Every executor returns { result, cards } — `result` goes back to the model, `cards` go to the app.
// The model can never approve or send: desk_approve / desk_discard are only reachable from a person's tap
// (see handleAction in agent.js). Money and law maths is plain code (ctc.js), never the model.
import { formatINR, WAGES_RULE, PF_CITATION } from "./ctc.js";

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
  { name: "add_candidate", description: "Propose adding a candidate to a role (from a CV or the user's message). Only after the user confirms the candidate agreed to share their details; the user taps Approve first.", input_schema: { type: "object", properties: {
      name: str("Full name"), role_id: uuid("Role id from show_pipeline"), email: str("Email"), phone: str("Phone with country code"), consent_confirmed: { type: "boolean" } }, required: ["name", "role_id", "consent_confirmed"] } },
  { name: "move_candidate", description: "Propose moving an application to another stage. The user taps Approve before it moves; it can be undone for 10 minutes.", input_schema: { type: "object", properties: { application_id: uuid("Application id"), stage: str("Applied, Screened, Interview or Offer") }, required: ["application_id", "stage"] } },
  { name: "chase_owner", description: "Propose a WhatsApp reminder to the owner of an open task (e.g. an interviewer with late feedback). The user taps Approve before it's sent.", input_schema: { type: "object", properties: { task_id: uuid("Task id from get_brief") }, required: ["task_id"] } },
  { name: "record_feedback", description: "Propose saving interview feedback (e.g. turned from a WhatsApp reply) as a scorecard. The user taps Approve first.", input_schema: { type: "object", properties: {
      application_id: uuid("Application id"), scores: { type: "object", additionalProperties: { type: "integer", minimum: 1, maximum: 5 } },
      recommendation: { type: "string", enum: ["next_round", "hire", "reject", "hold"] }, raw_text: str("The interviewer's words") }, required: ["application_id", "scores", "recommendation"] } },
  { name: "calculate_ctc", description: "Build and check an offer's salary structure from INPUTS ONLY, and save it as a draft offer. Never send rupee amounts for components: the database builds every line (Basic, HRA, Special, PF, ESI, gratuity) with fixed rules and checks the 50% wages rule. Set fix=true to raise Basic until wages reach 51%, keeping CTC the same.", input_schema: { type: "object", additionalProperties: false, properties: {
      application_id: uuid("Application id of the candidate"),
      ctc: { type: "integer", minimum: 1, description: "Total CTC in rupees per year, as the user said it (e.g. 1200000 for ₹12 L)" },
      basic_monthly: { type: "integer", minimum: 1, description: "Basic pay per month in rupees, only if the user gave it. Leave out to use the company default (40% of CTC)." },
      hra_pct: { type: "integer", minimum: 0, maximum: 100, description: "HRA as a % of Basic. Default 40." },
      pf_rule: { type: "string", enum: ["ceiling", "full"], description: "ceiling = 12% of Basic up to the PF wage ceiling (default); full = 12% of full Basic" },
      variable: { type: "integer", minimum: 0, description: "Variable pay at target, rupees per year. Default 0." },
      joining_on: str("YYYY-MM-DD if known (the rules in force on that date apply)"),
      fix: { type: "boolean", description: "true to fix a failing structure" } }, required: ["application_id", "ctc"] } },
  { name: "offer_letter_lines", description: "Write the only two lines of an offer letter that Desk may write: a one-or-two sentence role summary and a short welcome line. Everything else in the letter (and Annexure A) comes from the company's template and the salary calculator. Use after calculate_ctc, then send_offer.", input_schema: { type: "object", additionalProperties: false, properties: {
      offer_id: uuid("Offer id from calculate_ctc"), role_summary: str("What the role is about, at most 400 characters"), welcome_line: str("A short welcome, at most 200 characters") }, required: ["offer_id"] } },
  { name: "send_offer", description: "Ask for approval to send a saved offer. It goes out only when a person approves. Refused if the wages check fails.", input_schema: { type: "object", properties: { offer_id: uuid("Offer id from calculate_ctc"), summary: str("e.g. \"Kiran's offer, ₹12 L\"") }, required: ["offer_id", "summary"] } },
  { name: "draft_document", description: "Draft a letter (appointment, confirmation, extension, offer letter) for a person. Creates a draft and asks for approval; nothing is sent.", input_schema: { type: "object", properties: {
      person_id: uuid("Person id"), kind: { type: "string", enum: ["appointment_letter", "confirmation_letter", "probation_extension"] }, details: str("Facts to include: role, dates, CTC, notice period") }, required: ["person_id", "kind", "details"] } },
  { name: "mark_offer_accepted", description: "When a candidate accepts a sent offer: proposes creating the employee record, the joiner checklist and the probation review. The user taps Approve first.", input_schema: { type: "object", properties: { offer_id: uuid("Offer id") }, required: ["offer_id"] } },
  { name: "start_probation_review", description: "Propose asking an employee's manager for their probation review on WhatsApp. The user taps Approve first.", input_schema: { type: "object", properties: { person_id: uuid("Employee's person id") }, required: ["person_id"] } },
  { name: "bulk_reject", description: "Draft rejection notes for several candidates of one role with ONE job-relevant reason; they go out only after approval. Never use age, gender, marital status, religion, caste or pregnancy.", input_schema: { type: "object", properties: {
      role_id: uuid("Role id"), person_ids: { type: "array", items: { type: "string", format: "uuid" } }, reason: { type: "string", enum: REJECT_REASONS },
      note: str("Message to each candidate. Use {name} for their first name. Polite, specific to the job, no protected traits.") }, required: ["role_id", "person_ids", "reason", "note"] } },
  // ---- Screening (PM brief 15 Nov; CTO Tech Decisions §1.3). The model never sees or writes a score, star, coverage or rank:
  // these tools return what the database computed. Confirming requirements and overriding stars are a person's taps, not tools.
  { name: "set_requirements", description: "Draft the requirements card for a role from its job description: 3-8 must-have skills, nice-to-haves, an experience range and job conditions (location, notice period, shift). Job-relevant only: never age, gender, college, religion, caste or marital status. Creates a draft the recruiter must confirm; screening can't start before that.", input_schema: { type: "object", properties: {
      role_id: uuid("Role id from show_pipeline"),
      must: { type: "array", items: { type: "object", properties: { label: str("Skill or requirement"), terms: { type: "array", items: { type: "string" }, description: "Synonyms that count" } }, required: ["label"] }, minItems: 1, maxItems: 8 },
      nice: { type: "array", items: { type: "object", properties: { label: str("Nice-to-have"), terms: { type: "array", items: { type: "string" } } }, required: ["label"] } },
      conditions: { type: "array", items: { type: "object", properties: { label: str("Job condition"), terms: { type: "array", items: { type: "string" } } }, required: ["label"] } },
      exp_min: { type: "number" }, exp_max: { type: "number" } }, required: ["role_id", "must", "exp_min", "exp_max"] } },
  { name: "get_shortlist", description: "The live top 10 to call for a role (ranked by the database's fit score; pinned people first). Optional star filter, e.g. [4,5].", input_schema: { type: "object", properties: {
      role_id: uuid("Role id"), stars: { type: "array", items: { type: "integer", minimum: 1, maximum: 5 } } }, required: ["role_id"] } },
  { name: "explain_fit", description: "Why a candidate was shortlisted: the stored score breakdown, CV quotes for each matched must-have, gaps, and the requirements version. Use for 'why is X in the top 10'.", input_schema: { type: "object", properties: { application_id: uuid("Application id") }, required: ["application_id"] } },
  { name: "prepare_reject_batch", description: "Preview the rejection batch for a role: candidates below 50% of must-haves (referrals, people added by hand and unreadable CVs are never included), with the missing skills and one draft note. Preview only: nothing is sent or queued; a person approves the batch.", input_schema: { type: "object", properties: { role_id: uuid("Role id") }, required: ["role_id"] } },
];

/* ---- QA-044 (CTO 26 Nov): every tool declares its module, and the check runs before the tool, by the asking user's
   access (my_access_modules). "today" is everyone's. A letter's module follows its kind. ---- */
export const TOOL_MODULE = {
  get_brief: "today", chase_owner: "today", find_people: "hire", show_pipeline: "hire", create_role: "hire", add_candidate: "hire",
  move_candidate: "hire", record_feedback: "hire", calculate_ctc: "hire", offer_letter_lines: "hire", send_offer: "hire", bulk_reject: "hire", set_requirements: "hire",
  get_shortlist: "hire", explain_fit: "hire", prepare_reject_batch: "hire", draft_document: "hire",
  show_joiners: "onboard", mark_offer_accepted: "onboard", start_probation_review: "probation",
};
const DOC_MODULE = { offer_letter: "hire", appointment_letter: "onboard", confirmation_letter: "probation", probation_extension: "probation" };
/** The module one call belongs to (draft_document depends on the letter). */
export const toolModule = (name, input = {}) => name === "draft_document" ? (DOC_MODULE[input.kind] || "onboard") : TOOL_MODULE[name];
/* ---- QA-045 (CTO 26 Nov): a question never runs an action tool. These only read (or preview, sending nothing). ---- */
export const READ_ONLY_TOOLS = ["get_brief", "find_people", "show_pipeline", "show_joiners", "get_shortlist", "explain_fit", "prepare_reject_batch"];
/* Tools that would change something straight away. They now return a draft card; a person's tap runs them (handleAction "run"). */
export const CONFIRM_TOOLS = ["add_candidate", "move_candidate", "chase_owner", "record_feedback", "mark_offer_accepted", "start_probation_review"];
/** The tool list for one turn: only tools of modules the user can use, read-only ones for a question, and no WhatsApp wording
 *  while the company has no WhatsApp channel (QA-041). */
export function toolDefs({ modules = null, question = false, channels = ["app", "email"] } = {}) {
  const wa = channels.includes("whatsapp");
  return TOOL_DEFS
    .filter(t => !question || READ_ONLY_TOOLS.includes(t.name))
    .filter(t => !modules || t.name === "draft_document" || TOOL_MODULE[t.name] === "today" || modules.includes(TOOL_MODULE[t.name]))
    .map(t => wa ? t : { ...t, description: t.description.replace(/ on WhatsApp/g, "").replace(/a WhatsApp reminder/g, "a reminder").replace(/ \(e\.g\. turned from a WhatsApp reply\)/g, "") });
}

const L = 100000; // rupees in a lakh
const bucketPill = b => b === "Late" ? "late" : b === "Today" ? "warn" : "info";

/** The real actions behind CONFIRM_TOOLS. Only reached from a person's tap (handleAction "run"), never by the model. */
export function makeActors({ rpc }) {
  return {
    async add_candidate(a) {
      const r = await rpc("desk_add_candidate", { p_name: a.name, p_role_id: a.role_id, p_email: a.email ?? null, p_phone: a.phone ?? null, p_consent: true });
      return { reply: `${a.name} added as Applied. Consent recorded.`, result: r };
    },
    async move_candidate(a) {
      const r = await rpc("desk_move_candidate", { p_application: a.application_id, p_stage: a.stage });
      return { reply: `Moved from ${r.from} to ${r.to}.`, result: r, cards: [{ type: "info", text: `Moved from ${r.from} to ${r.to}.`, actions: [{ label: "Undo (10 min)", action: "undo", params: { event: r.undo_event } }] }] };
    },
    async chase_owner({ task_id }) { const r = await rpc("desk_chase_owner", { p_task: task_id }); return { reply: r?.chased ? `Reminder sent to ${r.chased}.` : "Reminder sent.", result: r }; },
    async record_feedback(a) {
      const r = await rpc("desk_record_feedback", { p_application: a.application_id, p_scores: a.scores, p_recommendation: a.recommendation, p_raw: a.raw_text ?? null });
      return { reply: "Feedback saved.", result: r, cards: [{ type: "scorecard", scores: a.scores, recommendation: a.recommendation, raw_text: a.raw_text ?? null, application_id: a.application_id }] };
    },
    async mark_offer_accepted({ offer_id }) { const r = await rpc("desk_mark_offer_accepted", { p_offer: offer_id }); return { reply: "Marked as accepted. The joiner checklist and probation review are set up.", result: r }; },
    async start_probation_review({ person_id }) { const r = await rpc("desk_start_probation_review", { p_person: person_id }); return { reply: "Probation review requested from their manager.", result: r }; },
  };
}
const CONFIRM_TITLE = {
  add_candidate: a => [`Add ${a.name} as a candidate`, `Adds ${a.name} to the role as Applied, with their consent recorded.`],
  move_candidate: a => ["Move a candidate", `Moves the application to ${a.stage}. You can undo it for 10 minutes.`],
  chase_owner: () => ["Send a reminder", "Sends the task's owner a reminder."],
  record_feedback: a => ["Save interview feedback", `Recommendation: ${String(a.recommendation || "").replace("_", " ")}.`],
  mark_offer_accepted: () => ["Mark the offer as accepted", "Creates the employee record, the joiner checklist and the probation review."],
  start_probation_review: () => ["Start a probation review", "Asks the employee's manager for their probation review."],
};
const confirmCard = (tool, input) => {
  const [title, preview] = CONFIRM_TITLE[tool](input);
  return { type: "approval", title, preview, proposed: true,
    actions: [{ label: "Approve", action: "run", params: { tool, input } }, { label: "Cancel", action: "cancel", params: { tool } }] };
};

export function makeExecutors({ rpc, draft }) {
  const approvalCard = (subjectType, subjectId, title, preview, ap) => ({
    type: "approval", title, preview, subject_type: subjectType, subject_id: subjectId,
    approver: ap?.approver, waiting_for_other: ap ? !ap.self : false,
    actions: ap && !ap.self ? [] : [{ label: "Approve & send", action: "approve", params: { subject_type: subjectType, subject_id: subjectId } },
                                    { label: "Reject", action: "discard", params: { subject_type: subjectType, subject_id: subjectId } }],
  });

  // QA-045: nothing changes until a person taps Approve on the card.
  const proposed = (tool, input) => ({ result: { proposed: true, instruction: "Nothing has happened yet. Tell the user in one sentence that it's ready for their approval." }, cards: [confirmCard(tool, input)] });
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
      return proposed("add_candidate", a);
    },
    async move_candidate(a) { return proposed("move_candidate", a); },
    async chase_owner({ task_id }) { return proposed("chase_owner", { task_id }); },
    async record_feedback(a) { return proposed("record_feedback", a); },
    async calculate_ctc(a) {
      // Inputs only (CTO ruling 21 Nov, §4.1.2): whatever else the model sends is dropped here, and the database refuses amounts too.
      const inputs = { ctc: a.ctc };
      for (const k of ["basic_monthly", "hra_pct", "pf_rule", "variable", "joining_on"]) if (a[k] != null) inputs[k] = a[k];
      const saved = await rpc("desk_save_offer", { p_application: a.application_id, p_inputs: inputs, p_fix: a.fix === true });
      // C5: the card shows the database's own lines and check, one source of truth.
      const db = saved.check;
      if (!db || db.computed_by !== "database" || !Array.isArray(saved.components)) throw new Error("The salary check didn't come back from the database. Nothing was changed.");
      const check = { passes: db.passes === true, wagesPercent: Number(db.wages_percent), ctc: Number(db.ctc), deemedExtraWages: Number(db.deemed_extra_wages) };
      return { result: { offer_id: saved.offer_id, passes: check.passes, wages_percent: check.wagesPercent, ctc: check.ctc, deemed_extra_wages: check.deemedExtraWages,
          basic_monthly: saved.inputs?.basic_monthly ?? null, warnings: saved.warnings ?? [],
          instruction: check.passes ? "Offer saved as a draft. Use send_offer to ask for approval." : "Fails the 50% wages rule. Offer to fix it (calculate_ctc with fix=true and the same inputs)." },
        cards: [{ type: "offer", offer_id: saved.offer_id, components: saved.components.map(c => ({ name: c.name, amount: c.amount, display: formatINR(c.amount) })),
          ctc: check.ctc, ctc_display: formatINR(check.ctc), passes: check.passes, wages_percent: check.wagesPercent, computed_by: "database",
          take_home_monthly: saved.monthly?.take_home ?? null, warnings: saved.warnings ?? [],
          note: check.passes ? "Meets the 50% wages rule." : `${formatINR(check.deemedExtraWages)} would count as wages for PF and gratuity.`,
          citation: WAGES_RULE.citation, pf_citation: saved.pf_citation ?? PF_CITATION, status: WAGES_RULE.status,
          legal: "Calculated by the database's fixed rules, not AI. Not legal advice." }] };
    },
    async offer_letter_lines({ offer_id, role_summary = null, welcome_line = null }) {
      const r = await rpc("set_offer_letter_text", { p_offer: offer_id, p_role_summary: role_summary ? String(role_summary).slice(0, 400) : null, p_welcome_line: welcome_line ? String(welcome_line).slice(0, 200) : null });
      return { result: { ...r, instruction: "Letter updated. Use send_offer to ask for approval; the approver reads the letter before approving." },
        cards: [{ type: "info", text: `Offer letter updated: version ${r.version}. The rest of the letter and Annexure A come from the template and the calculator.` }] };
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
    async mark_offer_accepted({ offer_id }) { return proposed("mark_offer_accepted", { offer_id }); },
    async start_probation_review({ person_id }) { return proposed("start_probation_review", { person_id }); },
    async set_requirements(a) {
      const lists = [a.must, a.nice || [], a.conditions || []].map(l => l.map(x => x.label)).flat().join(" ");
      const bad = blockedText(lists); if (bad) throw new Error(`Requirements must be job-relevant; "${bad}" can't be used`);
      const ids = (arr, p) => (arr || []).map((x, i) => ({ id: p + (i + 1), label: x.label, terms: x.terms || [] }));
      const card = { must: ids(a.must, "m"), nice: ids(a.nice, "n"), conditions: ids(a.conditions, "c") };
      const r = await rpc("desk_draft_requirements", { p_role: a.role_id, p_must: card.must, p_nice: card.nice, p_conditions: card.conditions, p_exp_min: a.exp_min, p_exp_max: a.exp_max });
      return { result: { requirement_id: r.requirement_id, version: r.version, status: "draft: waiting for the recruiter to confirm" },
        cards: [{ type: "requirements", requirement_id: r.requirement_id, version: r.version, ...card, experience: { min: a.exp_min, max: a.exp_max },
          weights: { must: 60, experience: 20, nice: 15, conditions: 5 }, confirmed: false,
          actions: [{ label: "Confirm requirements", action: "confirm_requirements", params: { requirement_id: r.requirement_id } }] }] };
    },
    async get_shortlist(a) {
      const rows = await rpc("desk_get_shortlist", { p_role: a.role_id, p_stars: a.stars?.length ? a.stars : null, p_limit: 10 });
      // the model gets names and order only; the numbers go straight to the card from the database
      return { result: { count: rows.length, names_in_order: rows.map(r => r.name) },
        cards: [{ type: "shortlist", role_id: a.role_id, stars_filter: a.stars || null, rows: rows.map(r => ({ application_id: r.application_id, name: r.name, fit: r.fit, stars: r.stars, years: r.years, pinned: r.pinned, version: r.version })) }] };
    },
    async explain_fit(a) {
      const x = await rpc("desk_explain_fit", { p_application: a.application_id });
      if (!x) throw new Error("No screening result for that application yet");
      const has = new Set(x.evidence.filter(e => e.confidence !== "low" && e.item !== "role").map(e => e.item));
      const gaps = x.requirements.must.filter(m => !has.has(m.id)).map(m => m.label);
      return { result: { matched: x.requirements.must.filter(m => has.has(m.id)).map(m => m.label), gaps, version: x.requirements.version },
        cards: [{ type: "why_shortlisted", application_id: a.application_id, score: x.score, evidence: x.evidence.filter(e => e.item !== "role"), gaps, requirements: x.requirements,
          note: "Desk found the evidence; the score is calculated by fixed rules. A person makes every decision." }] };
    },
    async prepare_reject_batch(a) {
      const b = await rpc("desk_prepare_reject_batch", { p_role: a.role_id });
      return { result: { count: b.people.length, preview_only: true },
        cards: [{ type: "bulk_preview", preview_only: true, batch_id: b.batch_id, count: b.people.length, reason: "skills_gap", note: b.note,
          people: b.people, oldest_application: b.oldest_application, clock: "12 working hours (09:00-19:00 IST, Mon-Sat)",
          actions: [{ label: "Approve and send", action: "approve_reject_batch_preview", params: { batch_id: b.batch_id, role_id: a.role_id } }] }] };
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
