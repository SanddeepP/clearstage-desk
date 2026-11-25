// Module tabs (PM spec RD-PM-Spec-Module-Tabs.md, CTO ruling RD-CTO-Rulings-Module-Tabs-25Nov.md).
// One catalog for the rail, the Coming-soon pages and Desk's honest reply. The database (016) holds each company's
// state; DEFAULT_STATE matches module_default() there. No dates anywhere: "Coming soon", never a month.
// The same file is copied to supabase/functions/_shared/modules.js for the Desk function (a test checks they match).

export const GROUPS = [
  { id: "lifecycle", label: "Hire to exit", modules: ["hire", "onboard", "probation", "compliance", "exit"] },
  { id: "manage", label: "Manage", modules: ["time", "payroll", "performance", "policies"] },
];

export const DEFAULT_STATE = { hire: "live", onboard: "preview", probation: "preview", compliance: "soon", exit: "soon", time: "soon", payroll: "soon", performance: "soon", policies: "soon" };

export const MODULES = {
  hire: { name: "Hire", line: "Jobs, candidates, interviews, screening and offers." },
  onboard: { name: "Onboard", line: "From offer accepted to a ready Day 1." },
  probation: { name: "Probation", line: "Every probation review on time, with a clear outcome." },
  compliance: {
    name: "Compliance", line: "Every statutory date, with an owner and a reminder.",
    does: [
      "Set up your company once: where you operate, your headcount and your registrations.",
      "A rules library for your country, every rule with its source and a review date.",
      "A compliance calendar where every return and renewal is a task with an owner and a clock.",
      "Headcount thresholds tracked, so you know when a new rule starts to apply.",
      "Proof of each filing uploaded and kept in one place. Clearstage doesn't file for you.",
    ],
    desk: "PF return due Fri 15th, owner Ritu. Remind her Wednesday?",
  },
  exit: {
    name: "Exit", line: "Resignation to final settlement, with nothing missed.",
    does: [
      "Start an exit when someone resigns, and work out their notice period.",
      "One exit checklist, with an owner for every item: laptop, access, handover, final pay.",
      "Work out the final settlement with fixed rules, not AI, and show every figure.",
      "Put the final-settlement deadline on a clock, with reminders before it's late.",
      "Draft relieving and experience letters for a named person to approve.",
    ],
    desk: "Ravi's last working day is in 30 days. I've started his exit checklist: laptop with Suresh, final pay with you. Shall I draft his relieving letter?",
  },
  time: {
    name: "Time & attendance", line: "Leave, attendance and holidays in one place.",
    does: [
      "Leave requests and approvals, with balances that always add up.",
      "Your company's holiday calendar and working week, already set up.",
      "Attendance from a simple check-in, or imported from your device.",
      "A monthly attendance summary, ready for payroll.",
    ],
    desk: "Meera asked for 3 days off next week. She has 8 days left and nobody else in Design is away. Approve?",
  },
  payroll: {
    name: "Payroll", line: "Monthly pay worked out by fixed rules, checked by a person.",
    does: [
      "Salary structures carried over from the approved offer.",
      "Monthly pay worked out with fixed rules, not AI, with every figure shown.",
      "Attendance and leave flow in, so nothing is typed twice.",
      "Payslips drafted for a named person to approve before anything is paid.",
      "Statutory deductions for your country, each with its source.",
    ],
    desk: "This month's payroll is ready for review: 41 people, 2 changes since last month. Open the check?",
  },
  performance: {
    name: "Performance", line: "Goals, check-ins and reviews that actually happen.",
    does: [
      "Goals for each person, agreed with their manager.",
      "Regular check-ins, with a reminder when one is overdue.",
      "Review cycles with an owner and a clock, so none slip.",
      "Review summaries drafted by Desk for the manager to edit and approve.",
    ],
    desk: "Vikram has 3 check-ins overdue for his team. Shall I send him the list?",
  },
  policies: {
    name: "Policies", line: "Your policies, published once and acknowledged by everyone.",
    does: [
      "Publish policies such as leave, travel or code of conduct, with versions.",
      "Employees sign in to read them and acknowledge, and a record is kept.",
      "See who hasn't acknowledged yet, and remind them.",
      "Desk answers employees' policy questions by quoting the published text.",
    ],
    desk: "The new travel policy is published. 12 people haven't acknowledged it yet. Remind them today?",
  },
};

export const PREVIEW_BANNER = "Preview: this module is being built. You're seeing sample data.";

/** The state of every module: the company's states from the database, else the defaults. */
export function states(fromDb) {
  const s = { ...DEFAULT_STATE };
  if (fromDb && typeof fromDb === "object") for (const k of Object.keys(s)) if (["live", "preview", "soon"].includes(fromDb[k])) s[k] = fromDb[k];
  return s;
}

/** Desk's honest reply for a module that isn't live (spec §2). */
export function notLiveReply(key, state) {
  const n = MODULES[key]?.name ?? key;
  return state === "preview"
    ? `${n} is in preview in Clearstage: you can look around on sample data, but it can't do this for real yet. I've noted that you need it.`
    : `${n} is coming soon in Clearstage. I've noted that you need it.`;
}

// What a request is about. Checked in this order; Hire words (offer letter, notice period of a candidate, salary check) never match.
const INTENTS = [
  ["exit", /\b(resign(s|ed|ing|ation)?|exit (interview|checklist|process)|start\b.{0,30}\bexit|exit for\b|offboard(ing)?|last working day|relieving letter|experience letter|full and final|f\s?&\s?f\b|final settlement)\b/i],
  ["payroll", /\b(payroll|payslips?|pay slips?|salary slips?|salary (run|processing)|run (the )?salar(y|ies)|pay run|monthly salaries)\b/i],
  ["compliance", /\b(compliance|statutory (return|filing|calendar|dates?)|(pf|esi|epf|tds) (return|challan|filing)|challan|labou?r codes?|professional tax return|returns? (is |are )?due|filing (is )?due)\b/i],
  ["performance", /\b(performance (review|cycle|rating)s?|appraisals?|okrs?|kpis?|one[- ]on[- ]ones?|1:1s?|team check-?ins?)\b/i],
  ["policies", /\b(polic(y|ies)|handbook|code of conduct)\b/i],
  ["time", /\b(leave (request|balance|application|policy)s?|apply for leave|attendance|timesheets?|days? off|holiday (list|calendar)|sick leave|casual leave|annual leave)\b/i],
  ["probation", /\b(probation|confirmation letter|confirm (his|her|their) (job|employment|role)|extend (his |her |their )?probation)\b/i],
  ["onboard", /\b(onboard(ing)?|new joiners?|joiner checklist|day[ -]?1 (plan|checklist)|appointment letter|pre-?boarding|(mark|marked)\b.{0,40}\b(offer )?accepted|accepted (the|his|her|their) offer)\b/i],
];
/** The module a request is about, or null. */
export function moduleIntent(text) {
  const t = String(text || "");
  for (const [k, re] of INTENTS) if (re.test(t)) return k;
  return null;
}
