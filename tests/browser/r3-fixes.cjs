// R3 bug fixes (CTO QA rulings 26 Nov): QA-040 (Reject with a reason, no raw database text), QA-046 (own company after a
// fresh sign-in), QA-042 (Integrations shows the real sender). Fake Supabase client; fictional data only.
// Run: serve the repo root (python3 -m http.server 8795), then node tests/browser/r3-fixes.cjs.
const BASE = process.env.BASE_URL || 'http://localhost:8795/';
const { chromium } = require('playwright');
const { opener } = require('./fake.cjs');

(async () => {
  const b = await chromium.launch(); let failed = 0; const ok = (c, m) => { if (!c) failed++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
  const open = opener(b, BASE);
  const uid = 'u-1', own = { id: 'co-own', name: 'Rycruit (fictional)', is_sample: false }, sample = { id: 'co-s', name: 'Acme Fintech', is_sample: true };
  const mem = co => ({ user_id: uid, company_id: co.id, full_name: 'Sanddeep Pittla', phone: null, app_role: 'owner', company: { id: co.id, name: co.name, city: 'Hyderabad', team_setup: 'solo', desk_enabled: true } });
  const DEF = { hire: 'live', onboard: 'preview', probation: 'preview', compliance: 'soon', exit: 'soon', time: 'soon', payroll: 'soon', performance: 'soon', policies: 'soon' };
  const base = extra => ({ session: true, uid, email: 'founder@example.com', signedInAt: Date.now() - 600e3, workspaces: [own, sample], members: [mem(own), mem(sample)],
    myRoles: { roles: ['super_admin'] }, rpcData: { my_modules: DEF }, ...extra });
  const header = p => p.evaluate(() => document.querySelector('#coLine')?.innerText + ' | ' + (document.querySelector('#sampleBan')?.hidden ? '' : 'BANNER'));

  // ---------- QA-046 ----------
  let t = await open(base(), { storage: { 'cs:ws:u-1': 'co-s' } });       // the old build remembered the sample company for good
  let h = await header(t.p);
  ok(h.includes('Rycruit') && !h.includes('BANNER'), 'QA-046 1. a remembered sample company no longer wins: own company opens · ' + h);
  await t.p.selectOption('#wsSwitch', 'co-s'); await t.p.waitForTimeout(500);
  await t.p.reload(); await t.p.waitForTimeout(1500);
  h = await header(t.p);
  ok(h.includes('Acme') && h.includes('BANNER'), 'QA-046 2. within the same session, a reload keeps the sample company · ' + h);
  await t.p.click('#signOut'); await t.p.waitForSelector('#s-email:not([hidden])');
  await t.p.fill('#email', 'founder@example.com'); await t.p.click('#sendBtn');
  await t.p.waitForSelector('#s-code:not([hidden])'); await t.p.fill('#code', '123456'); if (await t.p.isVisible('#verifyBtn')) await t.p.click('#verifyBtn');
  await t.p.waitForSelector('#s-app:not([hidden])'); await t.p.waitForTimeout(800);
  h = await header(t.p);
  ok(h.includes('Rycruit') && !h.includes('BANNER'), 'QA-046 3. after a fresh sign-in: your own company, no grey banner · ' + h);
  ok(!t.errs.length, 'QA-046 no page errors ' + t.errs.join(' | '));
  await t.ctx.close();

  // ---------- QA-040 ----------
  const draft = { reply: 'Drafted the role. It needs your approval.', conversation_id: 'c1', cards: [{ type: 'approval', title: 'New role: QA Engineer', preview: '1 × QA Engineer, Chennai · ₹6–8 L',
    subject_type: 'role', subject_id: 'role-9', actions: [{ label: 'Approve & send', action: 'approve', params: { subject_type: 'role', subject_id: 'role-9' } }, { label: 'Reject', action: 'discard', params: { subject_type: 'role', subject_id: 'role-9' } }] }] };
  t = await open(base({ deskReplies: { chat: draft, discard: { reply: 'Sent back with the reason "Not needed any more" and logged. Nothing was sent.', cards: [] } } }));
  await t.p.evaluate(() => { location.hash = 'desk'; }); await t.p.waitForTimeout(300);
  await t.p.fill('#q', 'Need a QA engineer in Chennai, 6-8 LPA, 3 yrs, joining in 45 days'); await t.p.press('#q', 'Enter'); await t.p.waitForTimeout(800);
  await t.p.click('button:has-text("Reject")'); await t.p.waitForTimeout(300);
  const chips = await t.p.$$eval('[data-reason]', els => els.map(e => e.dataset.reason));
  ok(chips.join() === 'wrong_details,wrong_tone,not_needed,needs_check,duplicate', 'QA-040 1. Reject asks for a reason from the fixed list');
  ok(!t.deskCalls.some(c => c?.action === 'discard'), 'QA-040 1. nothing discarded before a reason is picked');
  await t.p.click('[data-reason="not_needed"]'); await t.p.waitForTimeout(600);
  const call = t.deskCalls.find(c => c?.action === 'discard');
  ok(call && call.params.reason === 'not_needed' && call.params.subject_id === 'role-9', 'QA-040 2. discard sent with the reason');
  ok((await t.p.innerText('#log')).includes('Sent back with the reason "Not needed any more"'), 'QA-040 2. confirmation shown');
  await t.ctx.close();
  // a raw database error from the server never reaches the screen
  t = await open(base({ deskReplies: { chat: draft, discard: { error: 'new row for relation "role" violates check constraint "role_open_needs_approval"' } } }));
  await t.p.evaluate(() => { location.hash = 'desk'; }); await t.p.waitForTimeout(300);
  await t.p.fill('#q', 'Need a QA engineer in Chennai'); await t.p.press('#q', 'Enter'); await t.p.waitForTimeout(800);
  await t.p.click('button:has-text("Reject")'); await t.p.click('[data-reason="duplicate"]'); await t.p.waitForTimeout(600);
  const log = await t.p.innerText('#log');
  ok(!/relation|constraint|role_open_needs_approval/.test(log) && /Nothing was changed/.test(log), 'QA-040 3. no raw database text on screen');

  // ---------- QA-042 ----------
  await t.p.evaluate(() => { location.hash = 'integrations'; }); await t.p.waitForTimeout(400);
  const integ = await t.p.innerText('#view');
  ok(/Resend sends the 6-digit code from login@mail\.crovantapartner\.com/.test(integ) && /Live/.test(integ) && !/Supabase sends/.test(integ), 'QA-042 Integrations shows the real sender and Live');
  ok(!t.errs.length, 'no page errors ' + t.errs.join(' | '));
  await t.ctx.close();

  await b.close();
  console.log(failed ? `${failed} FAILED` : 'R3 FIX CHECKS PASSED');
  process.exit(failed ? 1 : 0);
})();
