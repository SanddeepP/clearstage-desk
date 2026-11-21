// Deterministic salary maths. Plain code only: the AI model never writes a number (CTO ruling 21 Nov, §4.1).
// The database (migration 008: ctc_breakup, ctc_fix, wages_check) is the source of truth; this file is its JS mirror,
// and a test checks both against the CTO's reference table. Status: awaiting legal review. Not legal advice.
import { ruleValue, RULE_STATUS } from "./rules.js";

export const WAGES_RULE = {
  id: "code-on-wages-50",
  citation: "Code on Wages, 2019, s.2(y): payments outside wages above one-half of total remuneration count as wages. Employer PF counts in total remuneration; gratuity and employer ESI are left out",
  status: RULE_STATUS,
  threshold: 0.5,
  fixTarget: 0.51,          // "Fix the structure" stops at 51%, a 1-point margin (CTO §4.1.3)
};
export const PF_CITATION = "PF: 12% × min(PF wages, ₹25,000) — Code on Social Security, 2020; EPF Scheme; S.O. 5109(E), 17 Sep 2026. Awaiting legal review.";

const WAGE_KINDS = new Set(["basic", "da", "retaining"]);
// Left out of total remuneration: gratuity (paid on exit) and employer ESI (open question for the legal reviewer).
const OUTSIDE_KINDS = new Set(["gratuity", "employer_esi"]);
export const PF_RULES = ["ceiling", "full"];     // 12% × min(basic, ceiling), or 12% of full basic
const EMPLOYER_PF = 0.12, EMPLOYEE_PF = 0.12, ESI_EMPLOYER = 0.0325, ESI_EMPLOYEE = 0.0075;

function rupees(n) {
  if (!Number.isFinite(n) || n < 0) throw new Error("Amounts must be zero or more rupees");
  return Math.round(n);
}
const day = on => (on ? (typeof on === "string" ? on : new Date(on).toISOString().slice(0, 10)) : new Date().toISOString().slice(0, 10));

/** The 50% check on a list of yearly components [{ name, kind, amount }]. */
export function checkWagesRule(components) {
  if (!Array.isArray(components) || components.length === 0) throw new Error("Add at least one CTC component");
  let ctc = 0, wages = 0, outside = 0;
  for (const c of components) {
    const amt = rupees(c.amount);
    ctc += amt;
    if (WAGE_KINDS.has(c.kind)) wages += amt;
    else if (OUTSIDE_KINDS.has(c.kind)) outside += amt;
  }
  const remuneration = ctc - outside;
  if (remuneration <= 0) throw new Error("CTC has no pay to the employee");
  const excluded = remuneration - wages;
  const limit = Math.floor(remuneration * WAGES_RULE.threshold);
  const excess = Math.max(0, excluded - limit);
  const share = wages / remuneration;
  return {
    ctc, remuneration, wages, excluded,
    wagesShare: share,
    wagesPercent: Math.round(share * 1000) / 10,
    passes: excess === 0,
    deemedExtraWages: excess,   // amount that would count as wages for PF and gratuity
    rule: WAGES_RULE,
  };
}

/** Telangana professional tax for a monthly gross. */
export function professionalTax(monthlyGross, on) {
  for (const s of ruleValue("pt_slabs_tg", day(on)).value) if (s.upto == null || monthlyGross <= s.upto) return s.tax;
  return 0;
}

/**
 * Build every line of an offer from inputs only (CTO §4.1.2). Desk never sends amounts.
 * inputs: { ctc, basicMonthly, hraPct = 40, pfRule = "ceiling", variable = 0, on (date of joining or offer date), disability = false }
 */
export function ctcBreakup(inputs) {
  const { ctc, basicMonthly, hraPct = 40, pfRule = "ceiling", variable = 0, on, disability = false } = inputs || {};
  for (const [k, v] of Object.entries({ ctc, basicMonthly, hraPct, variable }))
    if (!Number.isInteger(v) || v < 0) throw new Error(`${k} must be a whole number of rupees, zero or more`);
  if (ctc <= 0 || basicMonthly <= 0) throw new Error("CTC and Basic must be more than zero");
  if (hraPct > 100) throw new Error("HRA is a percentage of Basic, from 0 to 100");
  if (!PF_RULES.includes(pfRule)) throw new Error(`PF rule must be one of: ${PF_RULES.join(", ")}`);
  const d = day(on);
  const pfCeiling = ruleValue("pf_wage_ceiling", d), esiLimit = ruleValue("esi_wage_limit", d);
  const pfWages = pfRule === "ceiling" ? Math.min(basicMonthly, pfCeiling.value) : basicMonthly;
  const basic = basicMonthly * 12;
  const hra = Math.round(basic * hraPct / 100);
  const employerPf = Math.round(EMPLOYER_PF * pfWages * 12);
  const gratuity = Math.round(basic * 15 / 312);                 // 15 days' basic per year of 26 working days, per month of service
  // ESI depends on gross and gross on ESI: solve directly (CTO §4.1.4)
  const x = ctc - employerPf - gratuity - variable;
  const limit = disability ? esiLimit.value.disability : esiLimit.value.general;
  let gross = x, employerEsi = 0;
  if (x / (1 + ESI_EMPLOYER) / 12 <= limit) { gross = Math.round(x / (1 + ESI_EMPLOYER)); employerEsi = x - gross; }
  const special = gross - basic - hra;
  if (special < 0) throw new Error("Basic and HRA come to more than the gross pay. Lower Basic or HRA.");
  const components = [
    { name: "Basic + DA", kind: "basic", amount: basic },
    { name: "HRA", kind: "hra", amount: hra },
    { name: "Special allowance", kind: "special", amount: special },
    ...(variable ? [{ name: "Variable pay (at target)", kind: "variable", amount: variable }] : []),
    { name: "Employer PF", kind: "employer_pf", amount: employerPf },
    ...(employerEsi ? [{ name: "Employer ESI", kind: "employer_esi", amount: employerEsi }] : []),
    { name: "Gratuity", kind: "gratuity", amount: gratuity },
  ];
  const check = checkWagesRule(components);
  if (check.ctc !== ctc) throw new Error("Internal error: the lines don't add up to the CTC");
  const gm = Math.round(gross / 12);
  const employeePf = Math.round(EMPLOYEE_PF * pfWages), employeeEsi = employerEsi ? Math.round(gm * ESI_EMPLOYEE) : 0;
  const pt = professionalTax(gm, d);
  const warnings = [];
  if (basicMonthly <= ruleValue("bonus_wage_limit", d).value)
    warnings.push("Statutory bonus applies (wages of ₹21,000 a month or less): part C must carry at least 8.33%. Not added yet, awaiting legal review.");
  return {
    inputs: { ctc, basicMonthly, hraPct, pfRule, variable, on: d, disability },
    components, check, gross,
    monthly: { gross: gm, employeePf, employeeEsi, professionalTax: pt, takeHome: gm - employeePf - employeeEsi - pt },
    pfCitation: PF_CITATION, warnings,
    rules: [pfCeiling, esiLimit].map(r => ({ code: r.code, value: r.value, citation: r.citation, status: RULE_STATUS })),
  };
}

/** "Fix the structure" (CTO §4.1.3): raise Basic in ₹1,000 steps, keep HRA's %, stop at the first structure with wages ≥ 51%. */
export function fixBasic(inputs) {
  let b = Math.floor(inputs.basicMonthly / 1000) * 1000;
  for (let i = 0; i < 2000; i++) {
    let r;
    try { r = ctcBreakup({ ...inputs, basicMonthly: b }); } catch { break; }
    if (r.check.wagesShare >= WAGES_RULE.fixTarget) return { ...r, fixedFrom: inputs.basicMonthly };
    b += 1000;
  }
  throw new Error("This CTC can't reach 51% wages with these inputs. Lower HRA or variable pay.");
}

export function formatINR(n) {
  return "₹" + Math.round(n).toLocaleString("en-IN");
}
