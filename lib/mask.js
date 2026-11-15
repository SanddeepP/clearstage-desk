// Hide personal details in code before any AI call (CTO rule 2, 15 Nov).
// Removed: name (CV header and candidate record), email, phone, photos, date of birth or age, gender,
// marital status, religion, caste, address beyond city, college names. Also links (they often carry a name)
// and parent or spouse names. The AI gets only the cleaned text and the confirmed requirements.

export const CITIES = ["Hyderabad", "Secunderabad", "Bengaluru", "Bangalore", "Chennai", "Pune", "Mumbai", "Navi Mumbai", "Delhi", "New Delhi",
  "Gurugram", "Gurgaon", "Noida", "Kolkata", "Ahmedabad", "Jaipur", "Kochi", "Coimbatore", "Visakhapatnam", "Vijayawada", "Warangal",
  "Indore", "Lucknow", "Chandigarh", "Mysuru", "Nagpur", "Bhubaneswar", "Thiruvananthapuram", "Remote"];

const PERSONAL_LABELS = /^\s*(?:date\s+of\s+birth|d\.?\s?o\.?\s?b\.?|born(?:\s+on)?|birth\s*date|age|gender|sex|marital\s+status|religion|caste|category|community|nationality|father'?s?\s+name|mother'?s?\s+name|spouse'?s?\s+name|husband'?s?\s+name|wife'?s?\s+name|photo(?:graph)?|languages?\s+known|passport(?:\s+no\.?)?|aadhaa?r(?:\s+no\.?)?|pan(?:\s+no\.?)?)\s*[:\-–]/i;
const ADDRESS_LABEL = /^\s*(?:(?:permanent|current|present|residential|postal)\s+)?address\s*[:\-–]\s*(.*)$/i;
const INSTITUTION = /\b(?:university|universit[yi]|college|institute|institution|iit|iiit|nit|bits|vit|srm|school|vidyalaya|vidyapeeth|academy|polytechnic|mahavidyalaya|campus)\b/i;
const EDUCATION_HEAD = /^\s*(?:education|academic(?:s| qualifications?| background)?|qualifications?)\s*:?\s*$/i;
const SECTION_HEAD = /^\s*[A-Z][A-Za-z &/]{2,40}:?\s*$/;
const RELIGION = /\b(?:hindu(?:ism)?|muslim|islam(?:ic)?|christian(?:ity)?|sikh(?:ism)?|jain(?:ism)?|buddhis[tm]|parsi|zoroastrian|jewish)\b/gi;
const CASTE = /\b(?:brahmin|kshatriya|vaishya|shudra|dalit|reddy|kamma|kapu|velama|yadav|jat|maratha|nair|iyer|iyengar|OBC|SC\/ST|scheduled\s+(?:caste|tribe)|general\s+category)\b/gi;
const GENDER_WORDS = /\b(?:male|female|transgender|non-binary)\b/gi;
const TITLES = /\b(?:Mr|Mrs|Ms|Miss|Smt|Shri|Sri)\.?(?=\s+[A-Z\[])/g;   // case-sensitive: "900 ms to" is not a title
const MARITAL = /\b(?:married|unmarried|divorced|widowed)\b/gi;
const AGE = /\b(?:aged?\s*[:\-]?\s*\d{2}|\d{2}\s*(?:years?|yrs?)\s*(?:old|of\s+age))\b/gi;
const DATE_LIKE = /\b\d{1,2}[\/.\-](?:\d{1,2}|[A-Za-z]{3,9})[\/.\-](?:19|20)\d\d\b/g;
const EMAIL = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;
const PHONE = /(?:\+?\d[\d\s\-().]{8,}\d)/g;
const URL = /\b(?:https?:\/\/|www\.)\S+|\b(?:linkedin\.com|github\.com|gitlab\.com|behance\.net)\/\S+/gi;
const PHOTO = /\[(?:photo|image|picture|img)[^\]]*\]|<img[^>]*>|!\[[^\]]*\]\([^)]*\)/gi;

const DEGREE = /^(?:\(?\s*)?(?:b\.?\s?tech|b\.?\s?e\.?|m\.?\s?tech|m\.?\s?e\.?|b\.?\s?sc|m\.?\s?sc|b\.?\s?com|m\.?\s?com|bca|mca|bba|mba|pgdm|b\.?\s?a\.?|m\.?\s?a\.?|ph\.?\s?d|diploma|bachelor|master|post\s*graduate|graduate|intermediate|class\s+(?:x|xii|10|12)|12th|10th|ssc|hsc|cbse|icse|board)\b/i;
const SUBJECT = /^(?:in\s+)?(?:computer science|computer applications|information technology|electronics|electrical|mechanical|civil|commerce|accounting|finance|economics|statistics|mathematics|physics|chemistry|business administration|management|data science|engineering)(?:\s+(?:and|&)\s+[a-z ]+)?$/i;
const KEEP_IN_EDU = p => (SUBJECT.test(p.trim()) && !INSTITUTION.test(p)) || DEGREE.test(p.trim()) || /^\(?\s*(?:19|20)\d\d(?:\s*-\s*(?:19|20)\d\d)?\s*\)?$/.test(p.trim()) || /\b(?:cgpa|gpa|percentage|grade|distinction|first class)\b|\d+(?:\.\d+)?\s*(?:%|\/\s*10)/i.test(p) || CITIES.some(c => c.toLowerCase() === p.trim().toLowerCase());
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * @param text   CV text as extracted from the file
 * @param names  names from the candidate record (full name; parts of 3+ letters are also removed)
 * @returns { text, removed: { [kind]: count } }
 */
export function maskCv(text, names = []) {
  const removed = {};
  const hit = (k, n = 1) => { removed[k] = (removed[k] || 0) + n; };
  let lines = String(text).replace(/\r\n?/g, "\n").split("\n");

  // 1. The CV header: everything before the first section heading is name and contact details.
  const firstHead = lines.findIndex((l, i) => i > 0 && SECTION_HEAD.test(l) && l.trim().length < 42);
  const headerEnd = firstHead > 0 && firstHead <= 6 ? firstHead : 1;
  const header = lines.slice(0, headerEnd).join(" ");
  const headerCity = CITIES.find(c => new RegExp(`\\b${escapeRe(c)}\\b`, "i").test(header));
  const headerName = (lines[0] || "").replace(/[|•·,].*$/, "").trim();
  if (headerName && /^[A-Za-z][A-Za-z .'-]{1,60}$/.test(headerName)) names = [...names, headerName];
  hit("header", headerEnd);
  lines = [`[candidate]${headerCity ? " · " + headerCity : ""}`, ...lines.slice(headerEnd)];

  // 2. Personal-detail lines and addresses (keep the city only).
  let inEdu = false;
  lines = lines.map(l => {
    if (EDUCATION_HEAD.test(l)) { inEdu = true; return l; }
    if (SECTION_HEAD.test(l) && l.trim().length < 42) inEdu = false;
    if (PERSONAL_LABELS.test(l)) { hit("personal_detail"); return "[personal detail removed]"; }
    const a = l.match(ADDRESS_LABEL);
    if (a) { hit("address"); const city = CITIES.find(c => new RegExp(`\\b${escapeRe(c)}\\b`, "i").test(a[1])); return `Location: ${city || "[removed]"}`; }
    // 3. College names. Inside Education, keep only the degree, year, grade and city; anything else is the
    //    institution (this also catches short forms like "JNTU" or "CBIT" that no keyword list knows).
    //    Outside Education, drop any part that names an institution.
    if (inEdu && l.trim()) {
      const parts = l.split(/\s*(?:,|\||–|—| - |;|·)\s*/).filter(Boolean);
      const kept = parts.map(p => (KEEP_IN_EDU(p) ? p : (hit("college"), "[college]")));
      return kept.join(", ").replace(/(?:\[college\], )+\[college\]/g, "[college]");
    }
    if (INSTITUTION.test(l)) {
      const parts = l.split(/\s*(?:,|\||–|—| - |;)\s*/);
      return parts.map(p => (INSTITUTION.test(p) ? (hit("college"), "[college]") : p)).join(", ");
    }
    return l;
  });
  let out = lines.join("\n");

  // 4. Names from the record and the header (full name, then each part of 3+ letters).
  const parts = new Set();
  for (const n of names.filter(Boolean)) {
    parts.add(n.trim());
    for (const p of n.split(/[\s.]+/)) if (p.length >= 3) parts.add(p);
  }
  for (const p of [...parts].sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`\\b${escapeRe(p)}\\b`, "gi");
    out = out.replace(re, () => (hit("name"), "[name]"));
  }

  // 5. Contact details, links, photos, dates of birth, and protected words anywhere in the text.
  const sweep = (re, k, repl) => { out = out.replace(re, () => (hit(k), repl)); };
  sweep(EMAIL, "email", "[email]");
  sweep(URL, "link", "[link]");
  sweep(PHOTO, "photo", "[photo removed]");
  out = out.replace(PHONE, m => {
    const digits = m.replace(/\D/g, "");
    if (digits.length < 10 || /^(?:19|20)\d\d(?:19|20)\d\d$/.test(digits)) return m;  // "2019 - 2022" is not a phone
    hit("phone"); return "[phone]";
  });
  sweep(DATE_LIKE, "date", "[date]");
  sweep(AGE, "age", "[age]");
  sweep(RELIGION, "religion", "[removed]");
  sweep(CASTE, "caste", "[removed]");
  sweep(MARITAL, "marital", "[removed]");
  sweep(GENDER_WORDS, "gender", "[removed]");
  sweep(TITLES, "gender", "");
  out = out.replace(/\n{3,}/g, "\n\n").trim();
  return { text: out, removed };
}

/** Values that must never reach the model, for tests: checks one CV's masked text against its known details. */
export function leaks(masked, truth) {
  const found = [];
  const has = v => v && new RegExp(`\\b${escapeRe(String(v))}\\b`, "i").test(masked);
  for (const [k, v] of Object.entries(truth)) for (const val of [].concat(v)) if (has(val)) found.push(`${k}: ${val}`);
  if (EMAIL.test(masked)) found.push("an email address");
  EMAIL.lastIndex = 0;
  return found;
}
