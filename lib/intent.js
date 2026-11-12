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

const NUMW = "(\\d+(?:\\.\\d+)?)";
/** Experience: "3 yrs", "2-4 years", "5+ saal", "fresher". Returns a label or null. */
export function parseExperience(text) {
  const t = text.toLowerCase();
  if (/\bfreshers?\b/.test(t)) return "Freshers are fine";
  let m = t.match(/(\d+)\s*(?:-|–|to)\s*(\d+)\s*(?:yrs?|years?|saal|sal)\b/);
  if (m) return `${m[1]}–${m[2]} years`;
  m = t.match(/(\d+)\s*\+?\s*(?:yrs?|years?|saal|sal)\b/);
  if (m) return `${m[1]}+ years`;
  return null;
}
/** Joining timeline: "joining in 45 days", "within 2 months", "start in 3 weeks", "immediate". Returns days or null. */
export function parseStart(text) {
  const t = text.toLowerCase();
  if (/\b(immediate(?:ly)?|asap|turant|right away)\b/.test(t)) return 0;
  const m = t.match(/\b(?:joining|join|start(?:ing)?|within|in|by|next)\s*(?:in|within)?\s*(\d+)\s*(days?|din|weeks?|hafte|months?|mahine|mahina)\b/);
  const m2 = m || t.match(/\b(\d+)\s*(days?|din|weeks?|hafte|months?|mahine|mahina)\s*(?:mein|me|main)?\s*(?:join|joining)\b/);
  if (!m2) return null;
  const n = +m2[1], u = m2[2];
  return /week|hafte/.test(u) ? n * 7 : /month|mahin/.test(u) ? n * 30 : n;
}

/** Returns {intent:"hire", count, countStated, title, city, budget, exp, start} or null when it isn't a hiring request. */
export function parseHire(text) {
  let raw = ` ${text.toLowerCase().replace(/[,.!?]/g, " ").replace(/\s+/g, " ")} `;
  if (!HIRE_WORDS.test(raw)) return null;
  const budget = parseBudget(raw), exp = parseExperience(raw), start = parseStart(raw);
  // Remove numbers that belong to budget, experience and timeline before looking for a head count
  const stripped = raw
    .replace(/\d+(?:\.\d+)?\s*(?:l|lakh|lakhs|lac|lpa)?\s*(?:-|–|to|se)\s*\d+(?:\.\d+)?\s*(?:l|lakh|lakhs|lac|lpa)\b/g, " ")
    .replace(/\d+(?:\.\d+)?\s*(?:l|lakh|lakhs|lac|lpa)\b/g, " ")
    .replace(/\d+\s*(?:-|–|to)?\s*\d*\s*\+?\s*(?:yrs?|years?|saal|sal)\b(?:\s*(?:of\s*)?(?:exp(?:erience)?|anubhav))?/g, " ")
    .replace(/\b(?:joining|join|start(?:ing)?|within|in|by|next)\s*(?:in|within)?\s*\d+\s*(?:days?|din|weeks?|hafte|months?|mahine|mahina)\b/g, " ")
    .replace(/\b\d+\s*(?:days?|din|weeks?|hafte|months?|mahine|mahina)\s*(?:mein|me|main)?\s*(?:join|joining)\b/g, " ");
  let count = null;
  const d = stripped.match(/\b(\d{1,2})\b/);
  if (d && +d[1] > 0) count = +d[1];
  if (count === null) for (const [w, n] of Object.entries(NUM)) { if (!["a", "an", "do", "ek"].includes(w) && new RegExp(`\\b${w}\\b`).test(stripped)) { count = n; break; } }
  if (count === null && /\bdo\b\s+\w+/.test(stripped) && !/\bdo you\b/.test(stripped)) count = 2;
  if (count === null && /\bek\b/.test(stripped)) count = 1;
  const countStated = count !== null;
  if (count === null) count = 1; // default: one opening unless stated
  let city = null;
  for (const [k, v] of Object.entries(CITIES)) if (new RegExp(`\\b${k}\\b`).test(raw)) { city = v; break; }
  let title = null;
  for (const [re, t] of ROLE_ALIASES) if (re.test(raw)) { title = t; break; }
  if (!title) {
    const words = stripped.trim().split(" ")
      .filter(w => w && !FILLER.has(w) && !(w in NUM) && !(w in CITIES) && !/^\d/.test(w) && !/^(exp|experience|anubhav|joining|join|days?|din|weeks?|months?)$/.test(w));
    if (words.length && words.length <= 3) title = titleCase(words.map(singular).join(" "));
  }
  if (!title) return null;
  return { intent: "hire", count, countStated, title, city, budget, exp, start };
}

export function fmtBudget(b) {
  if (!b) return "";
  const f = n => (Number.isInteger(n) ? n : n.toFixed(1)) ;
  return b.min === b.max ? `₹${f(b.min)} L` : `₹${f(b.min)}–${f(b.max)} L`;
}
