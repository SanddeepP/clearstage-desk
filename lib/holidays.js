// QA-005 (CTO 16 Nov): the closure clock skips public holidays. Seed list = Telangana's 27 general holidays for 2026
// (state GO, as reported by Siasat, 2026 list) plus the national holidays of 2027. Telangana's 2027 list isn't
// published yet; add it when it is. Each company can edit its list later (CORE-2); the database has a `holiday` table.
// Dates marked * depend on the moon and can shift by a day.
export const HOLIDAYS = [
  ["2026-01-14", "Bhogi"], ["2026-01-15", "Sankranti / Pongal"], ["2026-01-26", "Republic Day"], ["2026-02-15", "Maha Shivaratri"],
  ["2026-03-03", "Holi"], ["2026-03-19", "Ugadi"], ["2026-03-21", "Eid-ul-Fitr*"], ["2026-03-22", "Day after Eid-ul-Fitr*"],
  ["2026-03-27", "Sri Rama Navami"], ["2026-04-03", "Good Friday"], ["2026-04-05", "Babu Jagjivan Ram's birthday"],
  ["2026-04-14", "Dr B.R. Ambedkar's birthday"], ["2026-05-27", "Eid-ul-Adha*"], ["2026-06-26", "Muharram*"], ["2026-08-10", "Bonalu"],
  ["2026-08-15", "Independence Day"], ["2026-08-26", "Milad-un-Nabi*"], ["2026-09-04", "Sri Krishna Ashtami"], ["2026-09-14", "Vinayaka Chavithi"],
  ["2026-10-02", "Gandhi Jayanti"], ["2026-10-18", "Saddula Bathukamma"], ["2026-10-20", "Vijaya Dasami"], ["2026-10-21", "Day after Vijaya Dasami"],
  ["2026-11-08", "Deepavali"], ["2026-11-24", "Kartika Purnima / Guru Nanak Jayanti"], ["2026-12-25", "Christmas"], ["2026-12-26", "Boxing Day"],
  ["2027-01-26", "Republic Day"], ["2027-08-15", "Independence Day"], ["2027-10-02", "Gandhi Jayanti"],
];
export const HOLIDAY_SET = new Set(HOLIDAYS.map(h => h[0]));
