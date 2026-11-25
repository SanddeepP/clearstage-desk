// G2 roles foundation (CTO ruling "Roles and views" 25 Nov §3): Settings → People with the role picker and invites,
// against a fake Supabase client. The database rules themselves are tested in supabase/tests/roles.sql. Exits 1 on any FAIL.
// Run: serve the repo root (python3 -m http.server 8795), then node tests/browser/roles.cjs. All people are fictional.
const BASE = process.env.BASE_URL || 'http://localhost:8795/';
const { chromium } = require('playwright');
const { opener } = require('./fake.cjs');

(async () => {
  const b = await chromium.launch(); let failed = 0; const ok = (c, m) => { if (!c) failed++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
  const open = opener(b, BASE);
  const text = (p, sel) => p.evaluate(s => document.querySelector(s)?.innerText || '', sel);
  const go = async (p, h) => { await p.evaluate(x => { location.hash = x; }, h); await p.waitForTimeout(400); };
  const uid = 'u-1', own = { id: 'co-own', name: 'Rycruit (fictional)', is_sample: false };
  const mem = { user_id: uid, company_id: own.id, full_name: 'Sanddeep Pittla', phone: null, app_role: 'lead', company: { id: own.id, name: own.name, city: 'Hyderabad', team_setup: 'lead_juniors', desk_enabled: false } };
  const DEF = { hire: 'live', onboard: 'preview', probation: 'preview', compliance: 'soon', exit: 'soon', time: 'soon', payroll: 'soon', performance: 'soon', policies: 'soon' };
  const people = () => [
    { id: 'm-me', name: 'Sanddeep Pittla', email: 'founder@example.com', roles: ['super_admin', 'hr'], see_pay: true, offer_approver: true, is_me: true, login: 'yes' },
    { id: 'm-ritu', name: 'Ritu Sharma', email: 'ritu@example.com', roles: ['recruiter'], see_pay: false, offer_approver: false, is_me: false, login: 'yes' },
    { id: 'm-vik', name: 'Vikram Nair', email: null, roles: ['manager'], see_pay: false, offer_approver: true, is_me: false, login: 'no' }];
  const base = extra => ({ session: true, uid, email: 'founder@example.com', signedInAt: Date.now() - 3600e3, workspaces: [own], members: [mem], rpcData: { my_modules: DEF }, people: people(), ...extra });
  const lastCall = async (t, name) => (await t.calls()).filter(c => c.rpc === name).pop();

  // ---------- A. Super admin ----------
  let t = await open(base({ myRoles: { roles: ['super_admin', 'hr'], see_pay: true, offer_approver: true } }));
  let p = t.p;
  const order = (await t.calls()).map(c => c.rpc).filter(Boolean);
  ok(order.indexOf('claim_my_invite') > -1 && order.indexOf('claim_my_invite') < order.indexOf('my_workspaces'), 'A0. an invite is claimed at sign-in, before the workspace is opened');
  await go(p, 'settings'); await p.waitForTimeout(300);
  let v = await text(p, '#peopleRoles');
  ok(v.includes('People and roles') && v.includes('Ritu Sharma') && v.includes('Vikram Nair'), 'A1. Settings → People and roles lists the team');
  ok(v.includes('Super admin') && v.includes('Recruiter') && v.includes('Manager') && v.includes('Offer approver · all roles') && v.includes('See pay'), 'A1. role and access tags shown');
  ok(v.includes('No login · WhatsApp nudges only') && v.includes('Signed in'), 'A1. login status shown');
  const meRow = await text(p, '[data-person="m-me"]');
  ok(meRow.includes("You can't change your own role") && !(await p.$('[data-person="m-me"] [data-v="roleEdit"]')), 'A2. no role change on your own row');
  ok(!!(await p.$('[data-person="m-ritu"] [data-v="roleEdit"]')), 'A2. "Change roles" on other people');
  ok(v.includes('Pilot limitation') && v.includes('a Manager can approve offers for all roles and sees offer salaries, and HR sees pay'), 'A3. pilot limitation stated to the Super admin');
  // change Ritu: Recruiter → HR with see pay
  await p.click('[data-person="m-ritu"] [data-v="roleEdit"]'); await p.waitForTimeout(200);
  await p.uncheck('#roleForm input[value="recruiter"]'); await p.click('#roleForm button[type="submit"]'); await p.waitForTimeout(300);
  ok((await text(p, '#peopleRoles')).includes('Pick at least one role.') && !(await lastCall(t, 'set_member_roles')), 'A4. no roles picked: refused before saving');
  await p.check('#roleForm input[value="hr"]'); await p.check('#roleForm input[name="epay"]'); await p.click('#roleForm button[type="submit"]'); await p.waitForTimeout(600);
  let c = await lastCall(t, 'set_member_roles');
  ok(c && c.args.p_member === 'm-ritu' && c.args.p_roles.join() === 'hr' && c.args.p_see_pay === true && c.args.p_offer_approver === false, 'A5. set_member_roles(Ritu, [hr], see pay, not approver)');
  v = await text(p, '#peopleRoles');
  ok(v.includes('Roles saved for Ritu Sharma') && v.includes('audit log'), 'A5. confirmation mentions the audit log');
  ok((await text(p, '[data-person="m-ritu"]')).includes('HR'), 'A5. Ritu now shows HR');
  // invite
  await p.fill('#invName', 'XXXX'); await p.fill('#invEmail', 'priya@example.com'); await p.click('#inviteForm button[type="submit"]'); await p.waitForTimeout(300);
  ok((await text(p, '#peopleRoles')).includes('Enter their name as people know them') && !(await lastCall(t, 'invite_member')), 'A6. placeholder name refused');
  ok((await p.inputValue('#invEmail')) === 'priya@example.com', 'A6. what was typed is kept after a refusal');
  await p.fill('#invName', 'Priya Shah'); await p.fill('#invEmail', 'not-an-email'); await p.click('#inviteForm button[type="submit"]'); await p.waitForTimeout(300);
  ok((await text(p, '#peopleRoles')).includes('Enter a valid email address.'), 'A6. bad email refused');
  await p.fill('#invName', 'Priya Shah'); await p.fill('#invEmail', 'Priya@Example.com');
  await p.uncheck('#inviteForm input[value="recruiter"]'); await p.check('#inviteForm input[value="manager"]'); await p.check('#inviteForm input[name="iappr"]');
  await p.click('#inviteForm button[type="submit"]'); await p.waitForTimeout(600);
  c = await lastCall(t, 'invite_member');
  ok(c && c.args.p_name === 'Priya Shah' && c.args.p_email === 'priya@example.com' && c.args.p_roles.join() === 'manager' && c.args.p_offer_approver === true && c.args.p_see_pay === false, 'A7. invite_member(Priya, manager, offer approver)');
  v = await text(p, '#peopleRoles');
  ok(v.includes('Priya Shah is invited. They join when they first sign in with priya@example.com.') && v.includes('Invited · joins when they first sign in'), 'A7. invited, shown as pending');
  ok(v.includes('No email is sent'), 'A7. says no email is sent');
  ok(!t.errs.length, 'A. no page errors ' + t.errs.join(' | '));
  await t.ctx.close();

  // ---------- B. The database's refusal is shown as it is ----------
  t = await open(base({ myRoles: { roles: ['super_admin'] }, rolesError: 'Your workspace needs at least one Super admin' })); p = t.p;
  await go(p, 'settings'); await p.waitForTimeout(300);
  await p.click('[data-person="m-ritu"] [data-v="roleEdit"]'); await p.waitForTimeout(200); await p.click('#roleForm button[type="submit"]'); await p.waitForTimeout(500);
  ok((await text(p, '#peopleRoles')).includes('Your workspace needs at least one Super admin'), 'B1. server refusal shown');
  await t.ctx.close();

  // ---------- C. Not a Super admin (HR): view only ----------
  t = await open(base({ myRoles: { roles: ['hr'], see_pay: true, offer_approver: true }, people: people().map(x => ({ ...x, is_me: x.id === 'm-ritu' })) })); p = t.p;
  await go(p, 'settings'); await p.waitForTimeout(300);
  v = await text(p, '#peopleRoles');
  ok(v.includes('View only') && v.includes('Only a Super admin can change roles or invite people.'), 'C1. HR sees the team, view only');
  ok(!(await p.$('#peopleRoles [data-v="roleEdit"]')) && !(await p.$('#inviteForm')), 'C1. no role picker and no invite form');
  ok(!v.includes('Pilot limitation'), 'C1. pilot note only for the Super admin');
  await t.ctx.close();

  // ---------- D. 360 px ----------
  t = await open(base({ myRoles: { roles: ['super_admin'] } }), { size: { width: 360, height: 740 } }); p = t.p;
  await go(p, 'settings'); await p.waitForTimeout(300);
  await p.click('[data-person="m-ritu"] [data-v="roleEdit"]'); await p.waitForTimeout(200);
  ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'D1. 360 px: no sideways scroll with the role picker open');
  await t.ctx.close();

  // ---------- E. Public demo: no People card ----------
  {
    const ctx = await b.newContext({ timezoneId: 'Asia/Kolkata' }); const q = await ctx.newPage();
    await q.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: 'export const SUPABASE_URL="", SUPABASE_ANON_KEY="", EMAIL_HAS_CODE=true;' }));
    await q.goto(BASE); await q.fill('#email', 'demo@example.com'); await q.click('#sendBtn');
    await q.waitForSelector('#s-code:not([hidden])'); await q.fill('#code', (await q.textContent('#demoCode')).match(/\d{6}/)[0]);
    await q.waitForSelector('#s-setup:not([hidden]), #s-app:not([hidden])');
    if (await q.isVisible('#s-setup')) { await q.fill('#fullName', 'Ritu Sharma'); await q.fill('#company', 'Demo Co'); await q.selectOption('#country', 'IN'); await q.click('#setupBtn'); }
    await q.waitForSelector('#s-app:not([hidden])'); await go(q, 'settings');
    ok(!(await q.$('#peopleRoles')), 'E1. public demo: no People and roles card');
    await ctx.close();
  }

  await b.close();
  console.log(failed ? `${failed} FAILED` : 'ALL ROLE BROWSER CHECKS PASSED');
  process.exit(failed ? 1 : 0);
})();
