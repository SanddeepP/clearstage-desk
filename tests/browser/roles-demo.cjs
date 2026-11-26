// Public demo role logins (founder 26 Nov): menus by role, and the Employee view with a change request HR approves.
// Signed-out demo only (no Supabase); the database rules are tested in supabase/tests/roles.sql. Exits 1 on any FAIL.
// Run: serve the repo root (python3 -m http.server 8795), then node tests/browser/roles-demo.cjs. All people are fictional.
const BASE = process.env.BASE_URL || 'http://localhost:8795/';
const { chromium } = require('playwright');

(async () => {
  const b = await chromium.launch(); let failed = 0; const ok = (c, m) => { if (!c) failed++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
  const ctx = await b.newContext({ timezoneId: 'Asia/Kolkata' }); const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: 'export const SUPABASE_URL="", SUPABASE_ANON_KEY="", EMAIL_HAS_CODE=true;' }));
  const text = sel => p.evaluate(s => document.querySelector(s)?.innerText || '', sel);
  const go = async h => { await p.evaluate(x => { location.hash = x; }, h); await p.waitForTimeout(350); };
  const visibleTabs = () => p.evaluate(() => [...document.querySelectorAll('.sidenav a[data-tab]')].filter(a => !a.hidden && a.offsetParent).map(a => a.dataset.tab));
  async function login(email) {
    if (await p.isVisible('#s-app')) { await p.click('#signOut'); await p.waitForSelector('#s-email:not([hidden])'); }
    await p.click(`[data-demo="${email}"]`);
    await p.waitForSelector('#s-code:not([hidden])'); await p.fill('#code', (await p.textContent('#demoCode')).match(/\d{6}/)[0]);
    await p.waitForSelector('#s-app:not([hidden])'); await p.waitForTimeout(400);
  }
  await p.goto(BASE); await p.waitForSelector('#s-email:not([hidden])');
  const chips = await text('#demoLogins');
  ok(['Super admin', 'HR', 'Recruiter', 'Manager', 'Employee'].every(x => chips.includes(x)) && chips.includes('recruiter@acme.demo'), 'D1. five demo logins on the sign-in screen');

  // Recruiter: Hire only
  await login('recruiter@acme.demo');
  let tabs = await visibleTabs();
  ok(['hiring', 'people', 'interviews', 'approvals', 'desk', 'today', 'policies', 'settings'].every(t => tabs.includes(t)), 'D2. Recruiter sees Hire, its pages, Policies and Settings');
  ok(!['onboard', 'probation', 'compliance', 'exit', 'payroll', 'time', 'performance', 'overview', 'integrations'].some(t => tabs.includes(t)), 'D2. Recruiter sees nothing outside Hire: ' + tabs.join(','));
  ok((await text('#who')).includes('Ritu Sharma · Recruiter'), 'D2. header names the role');
  ok(!(await p.isVisible('#t-prob')) && !(await p.isVisible('#t-join')), 'D2. no joiner or probation tiles');
  await go('today'); const td = await text('#view');
  ok(td.includes("Build Kiran's offer") && !td.includes('probation review') && !td.includes('Laptop and email') && !td.includes('appointment letter'), 'D2. Today shows Hire items only');
  await go('probation');
  ok(await p.evaluate(() => location.hash !== '#probation' || document.querySelector('[data-tab="probation"]').getAttribute('aria-current') !== 'page'), 'D2. #probation link doesn\'t open it');
  await go('desk'); await p.fill('#q', "start Priya's probation review"); await p.press('#q', 'Enter'); await p.waitForTimeout(900);
  ok((await text('#log')).includes("Probation isn't part of your access as Recruiter"), 'D2. Desk says it is outside the role');
  await go('settings');
  let st = await text('#view');
  ok(st.includes('Your own settings') && st.includes('Security') && !st.includes('Desk AI') && !st.includes('Employee logins'), 'D2. Recruiter Settings: personal only');
  ok(st.includes('People and roles') && st.includes('Meena Iyer') && st.includes('Demo logins'), 'D2. demo team list shown');

  // Manager
  await login('manager@acme.demo');
  tabs = await visibleTabs();
  ok(['hiring', 'onboard', 'probation', 'exit', 'time', 'payroll', 'performance'].every(t => tabs.includes(t)) && !tabs.includes('compliance') && !tabs.includes('integrations'), 'D3. Manager menu: ' + tabs.join(','));

  // Employee asks for a change
  await login('employee@acme.demo');
  ok(!(await p.isVisible('.sidenav')) && !(await p.isVisible('#composer')), 'D4. Employee: no menu and no Desk');
  let v = await text('#view');
  ok(v.includes('Priya Nair') && v.includes('Customer Success Associate') && v.includes('Vikram Nair') && v.includes('only you can see this page'), 'D4. own profile');
  ok(v.includes('Appointment letter') && v.includes('Probation review with Vikram Nair') && v.includes('My payslips'), 'D4. letters, tasks and coming-soon');
  ok(!v.includes('Kiran') && !v.includes('Faisal') && !v.includes('₹'), 'D4. no candidates or salaries');
  await p.click('[data-v="empAsk"][data-field="phone"]'); await p.fill('#empNew', '+91 98480 12345'); await p.fill('#empWhy', 'New number'); await p.click('#empReqForm button[type="submit"]'); await p.waitForTimeout(400);
  v = await text('#view');
  ok(v.includes('Sent to HR') && v.includes('Waiting for HR') && v.includes('+91 90000 33333'), 'D5. request sent; phone unchanged until approved');
  ok(!(await p.$('[data-v="empAsk"][data-field="phone"]')), 'D5. no second request for the same field');
  await p.click('[data-v="empAsk"][data-field="email"]'); await p.fill('#empNew', 'not-an-email'); await p.click('#empReqForm button[type="submit"]'); await p.waitForTimeout(300);
  ok((await text('#view')).includes('Enter a valid email address'), 'D5. bad email refused');
  await p.click('[data-v="empCancel"]').catch(() => {});
  await p.click('[data-v="empAsk"][data-field="address"]'); await p.fill('#empNew', '22 Lake Road, Kondapur, Hyderabad'); await p.click('#empReqForm button[type="submit"]'); await p.waitForTimeout(300);

  // HR approves one, rejects the other with a note
  await login('hr@acme.demo');
  tabs = await visibleTabs();
  ok(['overview', 'compliance', 'integrations', 'onboard'].every(t => tabs.includes(t)), 'D6. HR sees the whole menu');
  await go('settings');
  st = await text('#empAdmin');
  ok(st.includes('2 waiting') && st.includes('Priya Nair · Phone') && st.includes('+91 90000 33333 → +91 98480 12345'), 'D6. HR sees the requests with old → new');
  const ids = await p.$$eval('#empAdmin [data-req]', els => els.map(e => e.dataset.req));
  const phoneId = await p.$eval('#empAdmin', el => [...el.querySelectorAll('[data-req]')].find(x => x.innerText.includes('Phone')).dataset.req);
  const addrId = ids.find(x => x !== phoneId);
  await p.click(`[data-v="creqReject"][data-id="${addrId}"]`); await p.click('#creqRejectForm button[type="submit"]'); await p.waitForTimeout(400);
  ok((await text('#empAdmin')).includes('Add a note saying why'), 'D6. not approving needs a note');
  await p.click(`[data-v="creqReject"][data-id="${addrId}"]`).catch(() => {});
  await p.fill('#creqNoteIn', 'Please add the PIN code'); await p.click('#creqRejectForm button[type="submit"]'); await p.waitForTimeout(400);
  await p.click(`[data-v="creqApprove"][data-id="${phoneId}"]`); await p.waitForTimeout(400);
  st = await text('#empAdmin');
  ok(st.includes("Approved: Priya Nair's phone is updated.") && st.includes('No change requests waiting'), 'D6. approved');

  // Employee sees the result
  await login('employee@acme.demo');
  v = await text('#view');
  ok(v.includes('+91 98480 12345') && v.includes('Approved') && v.includes("HR's note: Please add the PIN code") && v.includes('Not approved'), 'D7. employee sees the approved phone and the note');
  await p.setViewportSize({ width: 360, height: 740 }); await p.waitForTimeout(200);
  ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'D8. 360 px: Employee view fits');
  await p.setViewportSize({ width: 1280, height: 800 });

  // Super admin
  await login('admin@acme.demo');
  tabs = await visibleTabs();
  ok(tabs.length >= 18, 'D9. Super admin sees everything (' + tabs.length + ' tabs)');
  ok((await text('#who')).includes('Rahul Kapoor · Super admin'), 'D9. header');
  ok(!errs.length, 'D10. no page errors ' + errs.join(' | '));
  await b.close();
  console.log(failed ? `${failed} FAILED` : 'ALL DEMO ROLE CHECKS PASSED');
  process.exit(failed ? 1 : 0);
})();
