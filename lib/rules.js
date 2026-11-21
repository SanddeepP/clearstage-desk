// Dated statutory rules (CTO ruling 21 Nov, §3). The JS mirror of the `statutory_rule` table seeded by migration 008;
// a test checks both carry the same rows. The calculator uses the value in force on the date of joining
// (or the offer date). A statutory change is a data update, not a code release. Every row: awaiting legal review.
export const RULE_STATUS = "awaiting legal review";

export const STATUTORY_RULES = [
  { code: "pf_wage_ceiling", value: 15000, from: "2014-09-01", to: "2026-09-16",
    citation: "EPF Scheme, 1952; ₹15,000 ceiling from 1 Sep 2014" },
  { code: "pf_wage_ceiling", value: 25000, from: "2026-09-17", to: null,
    citation: "Code on Social Security, 2020 / EPF Scheme; S.O. 5109(E) dated 17 Sep 2026" },
  { code: "esi_wage_limit", value: { general: 21000, disability: 25000 }, from: "2017-01-01", to: null,
    citation: "ESI (Central) Rules, 1950, r.50; Code on Social Security, 2020" },
  { code: "bonus_wage_limit", value: 21000, from: "2015-04-01", to: null,
    citation: "Payment of Bonus Act, 1965, s.2(13) as amended 2015; Code on Wages, 2019, s.26" },
  { code: "bonus_calc_floor", value: 7000, from: "2015-04-01", to: null,
    citation: "Payment of Bonus Act, 1965, s.12 as amended 2015; Code on Wages, 2019, s.26" },
  { code: "pt_slabs_tg", value: [{ upto: 15000, tax: 0 }, { upto: 20000, tax: 150 }, { upto: null, tax: 200 }], from: "2013-04-01", to: null,
    citation: "Telangana Tax on Professions, Trades, Callings and Employments Act, 1987, Schedule (monthly salary slabs)" },
];

/** The rule's value on a date (YYYY-MM-DD or Date). Throws if no row covers the date. */
export function ruleValue(code, on = new Date()) {
  const d = typeof on === "string" ? on : new Date(on).toISOString().slice(0, 10);
  const r = STATUTORY_RULES.find(x => x.code === code && x.from <= d && (x.to == null || d <= x.to));
  if (!r) throw new Error(`No ${code} rule in force on ${d}`);
  return r;
}
