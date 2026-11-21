// QA-017 (CTO 16 Nov): sample dates and times are relative to now, so every demo run looks fresh.
// "Restart demo" calls demoDates() again. All labels are in IST.
const IST = 5.5 * 3600e3, DAY = 864e5;
const parts = t => { const d = new Date(t + IST); return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), wd: d.getUTCDay(), h: d.getUTCHours(), min: d.getUTCMinutes() }; };
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], WDL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function demoDates(now = Date.now()) {
  const p0 = parts(now);
  const midnight = Date.UTC(p0.y, p0.m, p0.d) - IST;                 // today 00:00 IST
  // a working day `n` days from today (never a Sunday: moved to Monday)
  const dayAt = n => { let t = midnight + n * DAY; if (parts(t).wd === 0) t += DAY; return t; };
  const label = t => { const p = parts(t); return `${WD[p.wd]} ${p.d} ${MON[p.m]}`; };
  const at = (hoursFromNow, roundMin = 30) => { const t = now + hoursFromNow * 3600e3; return Math.ceil(t / (roundMin * 6e4)) * roundMin * 6e4; };
  const time = t => { const p = parts(t); const h = p.h % 12 || 12; return `${h}${p.min ? ":" + String(p.min).padStart(2, "0") : ""} ${p.h < 12 ? "am" : "pm"}`; };
  const clock = t => { const p = parts(t); const h = p.h % 12 || 12; return `${h}:${String(p.min).padStart(2, "0")} ${p.h < 12 ? "AM" : "PM"}`; };
  return {
    now, today: midnight,
    day: n => label(dayAt(n)),                                         // "Mon 23 Nov"
    dayYear: n => { const t = dayAt(n); const p = parts(t); return `${label(t)} ${p.y}`; },
    dayShort: n => { const p = parts(dayAt(n)); return `${p.d} ${MON[p.m]}`; },   // "23 Nov"
    weekday: n => WDL[parts(dayAt(n)).wd],                             // "Monday"
    at, time: t => time(t), clock: t => clock(t),                      // instants and their labels
    inHours: h => time(at(h)),                                         // "4:30 pm", a time later today
    ago: h => now - h * 3600e3,
  };
}
