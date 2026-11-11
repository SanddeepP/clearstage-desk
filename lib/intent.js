// Rule-based reading of chat requests for the preview, until the real Desk agent (LLM + tools) is in.
// Principle: only act when the request is clearly understood; otherwise say so honestly.

const NUM = { ek: 1, one: 1, a: 1, an: 1, do: 2, two: 2, teen: 3, three: 3, char: 4, chaar: 4, four: 4, paanch: 5, panch: 5, five: 5, chhe: 6, six: 6, saat: 7, seven: 7, aath: 8, eight: 8, nau: 9, nine: 9, das: 10, ten: 10 };
const CITIES = { bangalore: "Bengaluru", bengaluru: "Bengaluru", blr: "Bengaluru", hyderabad: "Hyderabad", hyd: "Hyderabad", pune: "Pune", mumbai: "Mumbai", bombay: "Mumbai",
  delhi: "Delhi", "new delhi": "Delhi", gurgaon: "Gurugram", gurugram: "Gurugram", noida: "Noida", chennai: "Chennai", kolkata: "Kolkata", ahmedabad: "Ahmedabad",
  jaipur: "Jaipur", kochi: "Kochi", indore: "Indore", chandigarh: "Chandigarh", coimbatore: "Coimbatore", remote: "Remote" };
const ROLE_ALIASES = [
  [/\bsales\s*exec(?:utive)?s?\b/, "Sales Executive"], [/\bdata\s*analysts?\b/, "Data Analyst"], [/\bbusiness\s*analysts?\b/, "Business Analyst"],
  [/\bbackend\s*(?:dev(?:eloper)?s?|engineers?)\b/, "Backend Developer"], [/\bfrontend\s*(?:dev(?:eloper)?s?|engineers?)\b/, "Frontend Developer"],
  [/\bfull\s*stack\s*(?:dev(?:eloper)?s?|engineers?)\b/, "Full Stack Developer"], [/\b(?:qa|test(?:ing)?)\s*(?:engineers?|leads?)\b/, "QA Engineer"],
  [/\bproduct\s*designers?\b/, "Product Designer"], [/\bproduct\s*managers?\b/, "Product Manager"], [/\bhr\s*(?:executives?|exec)\b/, "HR Executive"],
  [/\baccountants?\b/, "Accountant"], [/\boperations?\s*analysts?\b/, "Operations Analyst"], [/\bcustomer\s*success(?:\s*associates?|\s*managers?)?\b/, "Customer Success Associate"],
  [/\bsupport\s*(?:executives?|agents?)\b/, "Support Executive"], [/\bdevops\s*(?:engineers?)?\b/, "DevOps Engineer"], [/\bdesigners?\b/, "Designer"], [/\bdevelopers?\b/, "Developer"],
];
const HIRE_WORDS = /\b(hire|hiring|recruit|chahiye|chahie|chahiyen|need(?:s|ed)?|looking for|open (?:a |one )?(?:new )?role|new role|karna hai|lena hai|bharti)\b/;
const FILLER = new Set("i we want need needs to hire hiring recruit a an the for in at mein me ko chahiye chahie chahiyen hai karna lena please pls urgently urgent asap new role roles open opening openings looking people person candidates candidate budget ctc salary lpa lakh lakhs l k per annum year with and of on by bharti ke liye".split(" "));

function titleCase(s) { return s.replace(/\b[a-z]/g, c => c.toUpperCase()); }
function singular(w) { return /ss$/.test(w) || w.length <= 3 ? w : w.replace(/ies$/, "y").replace(/s$/, ""); }

export function parseBudget(text) {
  const t = text.toLowerCase().replace(/₹|rs\.?|inr/g, " ");
  let m = t.match(/(\d+(?:\.\d+)?)\s*(?:l|lakh|lakhs|lac|lpa)?\s*(?:-|–|to|se)\s*(\d+(?:\.\d+)?)\s*(?:l|lakh|lakhs|lac|lpa)\b/);
  if (m) return { min: +m[1], max: +m[2] };
  m = t.match(/(\d+(?:\.\d+)?)\s*(?:l|lakh|lakhs|lac|lpa)\b/);
  if (m) return { min: +m[1], max: +m[1] };
  return null;
}

/** Returns {intent:"hire", count, title, city, budget} or null when it isn't a hiring request. */
export function parseHire(text) {
  const raw = ` ${text.toLowerCase().replace(/[,.!?]/g, " ").replace(/\s+/g, " ")} `;
  if (!HIRE_WORDS.test(raw)) return null;
  let count = null;
  const d = raw.match(/\b(\d{1,2})\b(?!\s*(?:-|–|to)?\s*\d*\s*(?:l|lakh|lakhs|lac|lpa)\b)/);
  if (d && +d[1] > 0) count = +d[1];
  if (count === null) for (const [w, n] of Object.entries(NUM)) { if (new RegExp(`\\b${w}\\b`).test(raw) && !["a", "an", "do"].includes(w)) { count = n; break; } }
  if (count === null && /\b(do)\b\s+\w+/.test(raw) && !/\bdo you\b/.test(raw)) count = 2;
  let city = null;
  for (const [k, v] of Object.entries(CITIES)) if (new RegExp(`\\b${k}\\b`).test(raw)) { city = v; break; }
  const budget = parseBudget(raw);
  let title = null;
  for (const [re, t] of ROLE_ALIASES) if (re.test(raw)) { title = t; break; }
  if (!title) {
    const words = raw.replace(/\d+(?:\.\d+)?\s*(?:-|–|to|se)?\s*\d*(?:\.\d+)?\s*(?:l|lakh|lakhs|lac|lpa)?/g, " ").trim().split(" ")
      .filter(w => w && !FILLER.has(w) && !(w in NUM) && !(w in CITIES) && !/^\d/.test(w));
    if (words.length && words.length <= 3) title = titleCase(words.map(singular).join(" "));
  }
  if (!title) return null;
  return { intent: "hire", count, title, city, budget };
}

export function fmtBudget(b) {
  if (!b) return "";
  const f = n => (Number.isInteger(n) ? n : n.toFixed(1)) ;
  return b.min === b.max ? `₹${f(b.min)} L` : `₹${f(b.min)}–${f(b.max)} L`;
}
