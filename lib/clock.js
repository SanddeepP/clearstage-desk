// Closure-batch clock (CTO Tech Decisions §1.3, change 1; Decisions Log 15 Nov): 12 WORKING hours, not clock hours.
// Working hours are 09:00–19:00 IST, Monday to Saturday, excluding public holidays (QA-005); the clock pauses outside them. The batch is offered at the
// next 11:00 or 17:00 slot; the recruiter is nudged at 10 working hours and it escalates at 11.
const IST = 5.5 * 3600e3, H = 3600e3, OPEN = 9, CLOSE = 19, SLOTS = [11, 17];
import { HOLIDAY_SET } from "./holidays.js";
const istParts = t => { const d = new Date(t + IST); return { day: d.getUTCDay(), hour: d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600,
  date: d.toISOString().slice(0, 10), midnight: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - IST }; };
let holidays = HOLIDAY_SET;
/** Each company's own list (CORE-2) can replace the seed list. */
export const setHolidays = dates => { holidays = new Set(dates); };
const isWorking = p => p.day !== 0 && !holidays.has(p.date);   // Sundays and public holidays off

/** Add working hours to an instant (ms). */
export function addWorkingHours(t, hours) {
  let left = hours * H, cur = t;
  for (let guard = 0; guard < 60 && left > 0; guard++) {
    const p = istParts(cur);
    const open = p.midnight + OPEN * H, close = p.midnight + CLOSE * H;
    if (!isWorking(p) || cur >= close) { cur = p.midnight + 24 * H + OPEN * H; continue; }
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
    if (!isWorking(p)) continue;
    for (const s of SLOTS) { const at = p.midnight + s * H; if (at >= t) return at; }
  }
  return null;
}
/** Everything the closure card shows, computed from the application time (QA-003, CTO 16 Nov):
 *  due = 12 working hours, nudge = 10, escalation = 11. "Review by" is the next batch slot only if it comes before
 *  the due time; otherwise it's the due time. State: On time, Due soon (from the nudge) or Late (past due). */
export function rejectionClock(appliedAt, now = Date.now()) {
  const a = +appliedAt;
  const used = workingHoursBetween(a, now);
  const dueAt = addWorkingHours(a, 12), slot = nextSlot(Math.max(a, now));   // the next batch slot from now
  const reviewBy = slot != null && slot < dueAt ? slot : dueAt;
  const state = now > dueAt ? "late" : used >= 10 ? "due_soon" : "on_time";
  return { offeredAt: nextSlot(a), nextSlot: slot, reviewBy, nudgeAt: addWorkingHours(a, 10), escalateAt: addWorkingHours(a, 11), dueAt,
    usedHours: used, leftHours: Math.max(0, Math.round((12 - used) * 10) / 10), fraction: Math.min(1, used / 12),
    state, stateLabel: { on_time: "On time", due_soon: "Due soon", late: "Late" }[state] };
}
export const closureClock = rejectionClock;
export const fmtIST = t => new Date(t).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).replace(/\s?([ap])\.?m\.?/i, " $1m");
