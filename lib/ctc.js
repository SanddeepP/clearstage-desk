// Deterministic CTC checks. Plain code only: the AI model never does this maths.
// Rule source: Code on Wages, 2019, s.2(y) definition of "wages" (the 50% rule).
// Status: awaiting legal review. Not legal advice.

export const WAGES_RULE = {
  id: "code-on-wages-50",
  citation: "Code on Wages, 2019, section 2(y): excluded payments above one-half of total remuneration count as wages",
  status: "awaiting legal review",
  threshold: 0.5,
};

// Components that count as "wages" under the definition.
const WAGE_KINDS = new Set(["basic", "da", "retaining"]);
// Employer statutory contributions sit outside remuneration paid to the employee.
const EMPLOYER_KINDS = new Set(["employer_pf", "employer_esi", "gratuity"]);

function rupees(n) {
  if (!Number.isFinite(n) || n < 0) throw new Error("Amounts must be zero or more rupees");
  return Math.round(n);
}

/**
 * components: [{ name, kind, amount }] with yearly rupee amounts.
 * kind: basic | da | retaining | hra | special | conveyance | bonus | employer_pf | employer_esi | gratuity | other
 */
export function checkWagesRule(components) {
  if (!Array.isArray(components) || components.length === 0) throw new Error("Add at least one CTC component");
  let ctc = 0, wages = 0, employer = 0;
  for (const c of components) {
    const amt = rupees(c.amount);
    ctc += amt;
    if (WAGE_KINDS.has(c.kind)) wages += amt;
    else if (EMPLOYER_KINDS.has(c.kind)) employer += amt;
  }
  const remuneration = ctc - employer;
  if (remuneration <= 0) throw new Error("CTC has no pay to the employee");
  const excluded = remuneration - wages;
  const limit = Math.floor(remuneration * WAGES_RULE.threshold);
  const excess = Math.max(0, excluded - limit);
  const share = wages / remuneration;
  return {
    ctc, remuneration, wages, excluded, employer,
    wagesShare: share,
    wagesPercent: Math.round(share * 1000) / 10,
    passes: excess === 0,
    deemedExtraWages: excess, // amount that would count as wages for PF and gratuity
    rule: WAGES_RULE,
  };
}

/**
 * Re-balance a structure so wages reach the threshold without changing total CTC.
 * Moves money from special allowance first, then other excluded parts, into basic.
 */
export function fixStructure(components) {
  const res = checkWagesRule(components);
  if (res.passes) return components.map(c => ({ ...c }));
  const out = components.map(c => ({ ...c, amount: rupees(c.amount) }));
  // Wages needed: at least half of remuneration, rounded up to the next ₹1,000.
  const target = Math.ceil((res.remuneration * WAGES_RULE.threshold) / 1000) * 1000;
  let need = target - res.wages;
  let basic = out.find(c => c.kind === "basic");
  if (!basic) { basic = { name: "Basic", kind: "basic", amount: 0 }; out.unshift(basic); }
  const donors = ["special", "other", "conveyance", "hra", "bonus"];
  for (const kind of donors) {
    for (const c of out) {
      if (need <= 0) break;
      if (c.kind !== kind) continue;
      const take = Math.min(c.amount, need);
      c.amount -= take; basic.amount += take; need -= take;
    }
  }
  if (need > 0) throw new Error("Not enough allowances to move into basic pay");
  return out.filter(c => c.amount > 0 || c.kind === "basic");
}

export function formatINR(n) {
  return "₹" + Math.round(n).toLocaleString("en-IN");
}
