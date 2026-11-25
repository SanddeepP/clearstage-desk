// Company region at sign-up (CTO ruling 25 Nov, global-ready). Mirrors the database `country` table (migration 015):
// the database is the source of truth and re-checks everything; this file only fills the sign-up form.
// The form suggests a country and time zone from the browser's own time zone, and the user confirms.
export const COUNTRIES = [
  { code: "IN", name: "India", dial: "91", zones: ["Asia/Kolkata"],
    regions: [["IN-AP", "Andhra Pradesh"], ["IN-DL", "Delhi"], ["IN-GJ", "Gujarat"], ["IN-HR", "Haryana"], ["IN-KA", "Karnataka"], ["IN-KL", "Kerala"],
      ["IN-MH", "Maharashtra"], ["IN-TN", "Tamil Nadu"], ["IN-TG", "Telangana"], ["IN-UP", "Uttar Pradesh"], ["IN-WB", "West Bengal"]] },
  { code: "GB", name: "United Kingdom", dial: "44", zones: ["Europe/London"],
    regions: [["GB-ENG", "England"], ["GB-NIR", "Northern Ireland"], ["GB-SCT", "Scotland"], ["GB-WLS", "Wales"]] },
  { code: "IE", name: "Ireland", dial: "353", zones: ["Europe/Dublin"], regions: [] },
  { code: "US", name: "United States", dial: "1", zones: ["America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu"], regions: [] },
  { code: "CA", name: "Canada", dial: "1", zones: ["America/Toronto", "America/Winnipeg", "America/Edmonton", "America/Vancouver", "America/Halifax", "America/St_Johns"], regions: [] },
  { code: "AE", name: "United Arab Emirates", dial: "971", zones: ["Asia/Dubai"], regions: [] },
  { code: "SG", name: "Singapore", dial: "65", zones: ["Asia/Singapore"], regions: [] },
  { code: "MY", name: "Malaysia", dial: "60", zones: ["Asia/Kuala_Lumpur"], regions: [] },
  { code: "AU", name: "Australia", dial: "61", zones: ["Australia/Sydney", "Australia/Melbourne", "Australia/Brisbane", "Australia/Adelaide", "Australia/Perth", "Australia/Hobart", "Australia/Darwin"], regions: [] },
  { code: "NZ", name: "New Zealand", dial: "64", zones: ["Pacific/Auckland"], regions: [] },
  { code: "NL", name: "Netherlands", dial: "31", zones: ["Europe/Amsterdam"], regions: [] },
  { code: "DE", name: "Germany", dial: "49", zones: ["Europe/Berlin"], regions: [] },
  { code: "FI", name: "Finland", dial: "358", zones: ["Europe/Helsinki"], regions: [] },
];
const ALIASES = { "Asia/Calcutta": "Asia/Kolkata", "Europe/Belfast": "Europe/London", "US/Eastern": "America/New_York", "US/Central": "America/Chicago",
  "US/Mountain": "America/Denver", "US/Pacific": "America/Los_Angeles", "Australia/ACT": "Australia/Sydney", "Australia/Canberra": "Australia/Sydney" };

export const country = code => COUNTRIES.find(c => c.code === code) || null;

/** The browser's time zone, or "" when it can't be read. */
export function browserTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch { return ""; }
}

/** Suggestion from a time zone: { country, timezone } — country "" when we can't tell (the user must choose). */
export function suggest(tz) {
  const z = ALIASES[tz] || tz;
  const c = COUNTRIES.find(k => k.zones.includes(z));
  return c ? { country: c.code, timezone: z } : { country: "", timezone: "" };
}

/** Time zones offered for a country; the browser's own zone first when it belongs to that country. */
export function zonesFor(code, browserTz = "") {
  const c = country(code); if (!c) return [];
  const z = ALIASES[browserTz] || browserTz;
  return c.zones.includes(z) ? [z, ...c.zones.filter(x => x !== z)] : c.zones.slice();
}

/** Phone to international format (E.164). A number without "+" gets the country's dialling code. "" when it doesn't fit. */
export function toE164(raw, code) {
  const p = String(raw || "").replace(/[\s().-]/g, "");
  if (!p) return "";
  if (/^\+[1-9]\d{7,14}$/.test(p)) return p;
  const c = country(code); if (!c) return "";
  const local = p.replace(/^0+/, "");
  const full = "+" + c.dial + local;
  return /^\+[1-9]\d{7,14}$/.test(full) && /^\d+$/.test(local) ? full : "";
}
