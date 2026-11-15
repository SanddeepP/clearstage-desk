// Rejection-batch clock (CTO Tech Decisions §1.3, change 1 — PM to confirm): 12 WORKING hours, not clock hours.
// Working hours are 09:00–19:00 IST, Monday to Saturday; the clock pauses outside them. The batch is offered at the
// next 11:00 or 17:00 slot; the recruiter is nudged at 10 working hours and it escalates at 11.
const IST = 5.5 * 3600e3, H = 3600e3, OPEN = 9, CLOSE = 19, SLOTS = [11, 17];
const istParts = t => { const d = new Date(t + IST); return { day: d.getUTCDay(), hour: d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600, midnight: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - IST }; };
const working = day => day !== 0;   // Sunday off

/** Add working hours to an instant (ms). */
export function addWorkingHours(t, hours) {
  let left = hours * H, cur = t;
  for (let guard = 0; guard < 60 && left > 0; guard++) {
    const p = istParts(cur);
    const open = p.midnight + OPEN * H, close = p.midnight + CLOSE * H;
    if (!working(p.day) || cur >= close) { cur = p.midnight + 24 * H + OPEN * H; continue; }
    if (cur < open) cur = open;
    const room = close - cur;
    if (left <= room) return cur + left;
    left -= room; cur = p.midnight + 24 * H + OPEN * H;
  }
  return cur;
}
/** Working hours between two instants. */
export function workingHoursBetween(a, b) {
  let lo = 0, hi = 200;
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (addWorkingHours(a, mid) <= b) lo = mid; else hi = mid; }
  return Math.round(lo * 100) / 100;
}
export function nextSlot(t) {
  for (let d = 0; d < 9; d++) {
    const p = istParts(t + d * 24 * H);
    if (!working(p.day)) continue;
    for (const s of SLOTS) { const at = p.midnight + s * H; if (at >= t) return at; }
  }
  return null;
}
/** Everything the rejection card shows, for the oldest application in the batch. */
export function rejectionClock(appliedAt, now = Date.now()) {
  const a = +appliedAt;
  const used = workingHoursBetween(a, now);
  return { offeredAt: nextSlot(a), nudgeAt: addWorkingHours(a, 10), escalateAt: addWorkingHours(a, 11), dueAt: addWorkingHours(a, 12),
    usedHours: used, leftHours: Math.max(0, Math.round((12 - used) * 10) / 10), fraction: Math.min(1, used / 12),
    state: used >= 12 ? "late" : used >= 11 ? "escalated" : used >= 10 ? "nudged" : used >= 9 ? "due_soon" : "on_track" };
}
export const fmtIST = t => new Date(t).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).replace(/\s?([ap])\.?m\.?/i, " $1m");
