// QA-044 (S1) and QA-045 (S2), QA's own probes on the demo build (bug log 26 Nov), for every staff demo login.
// Recruiter: nothing outside Hire, however it's asked. Every role: a question never starts an action.
// Run: serve the repo root (python3 -m http.server 8795), then node tests/browser/qa-044-045.cjs. Fictional data only.
const BASE = process.env.BASE_URL || 'http://localhost:8795/';
const { chromium } = require('playwright');

(async () => {
  const b = await chromium.launch(); let failed = 0; const ok = (c, m) => { if (!c) failed++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
  const ctx = await b.newContext({ timezoneId: 'Asia/Kolkata' }); const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: 'export const SUPABASE_URL="", SUPABASE_ANON_KEY="", EMAIL_HAS_CODE=true;' }));
  const go = async h => { await p.evaluate(x => { location.hash = x; }, h); await p.waitForTimeout(300); };
  async function login(email) {
    if (await p.isVisible('#s-app')) { await p.click('#signOut'); await p.waitForSelector('#s-email:not([hidden])'); }
    await p.click(`[data-demo="${email}"]`); await p.waitForSelector('#s-code:not([hidden])');
    await p.fill('#code', (await p.textContent('#demoCode')).match(/\d{6}/)[0]); await p.waitForSelector('#s-app:not([hidden])'); await p.waitForTimeout(400);
  }
  // ask Desk one thing and return only Desk's new reply text
  async function ask(text) {
    await go('desk');
    const before = await p.evaluate(() => document.querySelector('#log').innerText.length);
    await p.fill('#q', text); await p.press('#q', 'Enter'); await p.waitForTimeout(1100);
    const out = await p.evaluate(n => document.querySelector('#log').innerText.slice(n), before);
    return out.replace(text, '');                       // Desk's reply only, not the echo of what was typed
  }
  const PAY = /₹\s?[\d,.]+\s?(L|lakh)?|CTC|compensation|salary/i;
  await p.goto(BASE); await p.waitForSelector('#s-email:not([hidden])');

  // ---------- QA-044: Recruiter ----------
  await login('recruiter@acme.demo');
  let r = await ask("show Sneha's appointment letter");
  ok(/Onboard isn't part of your access as Recruiter/.test(r) && !/Dear Sneha|Sneha Rao/.test(r), 'QA-044 1. "show Sneha\'s appointment letter" refused');
  r = await ask('tell me about Sneha');
  ok(!/Sneha Rao|appointment|Dear|Product Designer/i.test(r) && !PAY.test(r), 'QA-044 2. "tell me about Sneha": no letter, no pay, nothing about her · ' + r.trim().slice(0, 90));
  r = await ask('tell me about Priya Nair');
  ok(!/Priya Nair|\breview\b|Vikram|probation/i.test(r), 'QA-044 3. "tell me about Priya Nair": nothing about her · ' + r.trim().slice(0, 90));
  r = await ask("what is Priya's phone number?");
  ok(!/\breview\b|Vikram|probation|WhatsApp|\bsent\b/i.test(r), 'QA-044 4. "what is Priya\'s phone number?": no review started, nothing about her · ' + r.trim().slice(0, 90));
  ok(!(await p.evaluate(() => document.querySelector('#wa').innerText)).match(/Priya|probation/i), 'QA-044 4. no WhatsApp preview to Vikram');
  await go('people'); let v = await p.innerText('#view');
  ok(!/Sneha Rao|Priya Nair|Joiner|Employee ·|Probation ends/.test(v) && /Kiran S\./.test(v), 'QA-044 5. Candidates & people: candidates only, no joiner or employee');
  await go('today'); v = await p.innerText('#view');
  ok(!/Sneha|Priya|Laptop|probation/i.test(v), 'QA-044 Today: no Onboard or Probation work');
  r = await ask('Kiran accepted the offer');
  ok(/Onboard isn't part of your access as Recruiter/.test(r), 'QA-044 Recruiter can\'t create a joiner');
  r = await ask('remind Suresh about the laptop');
  ok(/Onboard isn't part of your access as Recruiter/.test(r), 'QA-044 Recruiter can\'t chase onboarding');
  r = await ask('can you do my taxes');
  ok(!/Sneha|Priya/.test(r), 'QA-044 the "what I can do" list names no joiner or employee');
  ok(!(await p.evaluate(() => { const c = document.body.cloneNode(true); c.querySelectorAll('.msg.me, .me').forEach(x => x.remove()); return c.innerText; })).match(/Sneha Rao|Priya Nair/), 'QA-044 Sneha and Priya appear nowhere on the page (apart from what was typed)');

  // ---------- QA-045: a question never starts an action (HR, Manager, Super admin) ----------
  for (const who of ['hr@acme.demo', 'manager@acme.demo', 'admin@acme.demo']) {
    await login(who);
    for (const q of ["what is Priya's phone number?", 'show me Priya', 'Priya ka phone number kya hai']) {
      const out = await ask(q);
      ok(/Priya Nair/.test(out) && !/WhatsApp|gets a 3-question review|already with Vikram|sent nothing/i.test(out), `QA-045 ${who.split('@')[0]}: "${q}" answers, starts nothing · ${out.trim().slice(0, 80)}`);
    }
    ok(!(await p.evaluate(() => document.querySelector('#wa').innerText)).match(/probation|Priya/i), `QA-045 ${who.split('@')[0]}: no message to Vikram`);
  }
  // a request still acts (as a draft or preview, as before)
  r = await ask("start Priya's probation review");
  ok(/Vikram/.test(r), 'QA-045 a request ("start Priya\'s probation review") still works for the Super admin');
  r = await ask('tell me about Sneha');
  ok(/Sneha Rao/.test(r) && !/Dear Sneha/.test(r), 'QA-045 "tell me about Sneha" (Super admin): a summary, not the letter');

  ok(!errs.length, 'no page errors ' + errs.join(' | '));
  await b.close();
  console.log(failed ? `${failed} FAILED` : 'QA-044/045 BROWSER CHECKS PASSED');
  process.exit(failed ? 1 : 0);
})();
