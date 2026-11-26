// Founder order 26 Nov: item 3 (approved emails go out through Resend from "<Company> via Clearstage", with plain
// failure states and Retry) and item 6 (Clearstage's safety switches and the pilot cap). Fake Supabase; fictional data.
// Run: serve the repo root (python3 -m http.server 8795), then node tests/browser/email-switches.cjs.
const BASE = process.env.BASE_URL || 'http://localhost:8795/';
const { chromium } = require('playwright');
const { opener } = require('./fake.cjs');

(async () => {
  const b = await chromium.launch(); let failed = 0; const ok = (c, m) => { if (!c) failed++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
  const open = opener(b, BASE);
  const uid = 'u-1', own = { id: 'co-own', name: 'cccc', is_sample: false };
  const mem = { user_id: uid, company_id: own.id, full_name: 'Sanddeep Pittla', phone: null, app_role: 'owner', company: { id: own.id, name: own.name, city: 'Hyderabad', team_setup: 'solo', desk_enabled: true } };
  const DEF = { hire: 'live', onboard: 'preview', probation: 'preview', compliance: 'soon', exit: 'soon', time: 'soon', payroll: 'soon', performance: 'soon', policies: 'soon' };
  const base = extra => ({ session: true, uid, email: 'founder@example.com', signedInAt: Date.now() - 600e3, workspaces: [own], members: [mem], myRoles: { roles: ['super_admin'] }, ...extra,
    rpcData: { my_modules: DEF, ...(extra?.rpcData || {}) } });
  const body = p => p.evaluate(() => document.body.innerText);
  const letter = { reply: 'Drafted the offer letter. It needs your approval.', conversation_id: 'c1', cards: [{ type: 'approval', title: 'Offer letter: Nila Fictional', preview: 'Dear Nila, please find your offer letter.',
    subject_type: 'document', subject_id: 'doc-1', actions: [{ label: 'Approve & send', action: 'approve', params: { subject_type: 'document', subject_id: 'doc-1' } }, { label: 'Reject', action: 'discard', params: { subject_type: 'document', subject_id: 'doc-1' } }] }] };
  const approveFlow = async t => {
    await t.p.evaluate(() => { location.hash = 'desk'; }); await t.p.waitForTimeout(300);
    await t.p.fill('#q', 'Draft the offer letter for Nila'); await t.p.press('#q', 'Enter'); await t.p.waitForTimeout(800);
    await t.p.click('text=Approve & send'); await t.p.waitForTimeout(1000);
  };

  // ---------- 1. approve → the email goes out at once ----------
  let t = await open(base({ deskReplies: { chat: letter, approve: { reply: 'Approved and queued.', approved_by: 'Sanddeep Pittla', cards: [] } },
    emailReply: { status: 'done', sent: 1, failed: 0, results: [{ id: 'm1', status: 'sent', error: null }] } }));
  await approveFlow(t);
  let txt = await body(t.p);
  ok(t.deskCalls.some(x => x && x.email), '1. approving calls send-email straight away');
  ok(txt.includes('Sent the email from “cccc via Clearstage”') && txt.includes('Replies go to the approver'), '1. plain confirmation with the sender name');
  ok(!t.errs.length, '1. no page errors ' + t.errs.join(' | '));
  await t.ctx.close();

  // ---------- 2. failure states ----------
  t = await open(base({ deskReplies: { chat: letter, approve: { reply: 'Approved and queued.', approved_by: 'S', cards: [] } } }));
  await approveFlow(t);
  ok((await body(t.p)).includes("Email isn't connected yet, so messages stay queued."), '2. no key: "isn\'t connected yet", stays queued');
  await t.ctx.close();
  t = await open(base({ deskReplies: { chat: letter, approve: { reply: 'Approved.', approved_by: 'S', cards: [] } }, emailReply: { status: 'paused', message: 'Sending is paused by Clearstage right now, so messages stay queued.' } }));
  await approveFlow(t);
  ok((await body(t.p)).includes('Sending is paused by Clearstage right now'), '2. paused: plain message');
  await t.ctx.close();
  t = await open(base({ deskReplies: { chat: letter, approve: { reply: 'Approved.', approved_by: 'S', cards: [] } },
    emailReply: { status: 'done', sent: 0, failed: 1, results: [{ id: 'm1', status: 'queued', error: 'The email address was refused. Check it and retry.' }] } }));
  await approveFlow(t);
  ok((await body(t.p)).includes("One email couldn't be sent yet: The email address was refused. Check it and retry. See Settings → Email."), '2. refused: reason and where to look');
  await t.ctx.close();

  // ---------- 3. Settings → Email: outbox and Retry ----------
  const outbox = [{ id: 'm2', to: 'Nila Fictional', subject: 'Your offer letter from cccc', kind: 'offer_letter', status: 'failed', error: 'The email address was refused. Check it and retry.', attempts: 3, created_at: '2026-11-26T10:00:00Z' },
    { id: 'm3', to: 'Noaddr Fictional', subject: 'Your application to cccc', kind: 'rejection_note', status: 'no_address', error: 'No email address on file', attempts: 0, created_at: '2026-11-26T09:00:00Z' },
    { id: 'm1', to: 'Arun Fictional', subject: 'Your offer from cccc', kind: 'offer', status: 'sent', error: null, attempts: 1, created_at: '2026-11-26T08:00:00Z', sent_at: '2026-11-26T08:00:05Z' }];
  t = await open(base({ rpcData: { company_outbox: outbox, email_retry: { id: 'm2', status: 'queued' } }, emailReply: { status: 'done', sent: 1, failed: 0, results: [] } }));
  await t.p.evaluate(() => { location.hash = 'settings'; }); await t.p.waitForTimeout(800);
  txt = await t.p.$eval('#outboxCard', e => e.innerText);
  ok(txt.includes('From “cccc via Clearstage”') && txt.includes('Not sent') && txt.includes('No email address') && txt.includes('Sent'), '3. outbox shows plain states · ' + txt.replace(/\s+/g, ' ').slice(0, 120));
  ok((await t.p.$$('[data-retry]')).length === 2, '3. Retry only on emails that weren\'t sent');
  await t.p.click('[data-retry="m2"]'); await t.p.waitForTimeout(800);
  const c = await t.calls();
  ok(c.some(x => x.rpc === 'email_retry' && x.args.p_id === 'm2') && t.deskCalls.some(x => x && x.email), '3. Retry re-queues and sends');
  ok(!(await t.p.$('#safetyCard')), '3. a client sees no safety switches');
  await t.ctx.close();

  // ---------- 4. Clearstage: safety switches and pilot cap ----------
  t = await open(base({ admin: true, rpcData: { platform_companies: [], sample_access_list: [], module_interest_counts: [], company_outbox: [],
    platform_status: { desk_off: false, sending_paused: false, pilot_cap: 1, cv_live_companies: 1, emails_queued: 2, emails_failed: 1 } } }));
  await t.p.evaluate(() => { location.hash = 'settings'; }); await t.p.waitForTimeout(800);
  txt = await t.p.$eval('#safetyCard', e => e.innerText);
  ok(txt.includes('Desk AI, every company') && txt.includes('Queued now: 2. Not sent: 1.') && txt.includes('FA-015'), '4. safety card for the platform admin');
  await t.p.click('[data-switch="sending_paused"][data-on="1"]'); await t.p.waitForTimeout(600);
  await t.p.click('[data-switch="desk_off"][data-on="1"]'); await t.p.waitForTimeout(600);
  await t.p.selectOption('[data-pilotcap]', '3'); await t.p.waitForTimeout(600);
  const c4 = await t.calls();
  ok(c4.some(x => x.rpc === 'set_platform_switch' && x.args.p_key === 'sending_paused' && x.args.p_on === true), '4. pause all sending');
  ok(c4.some(x => x.rpc === 'set_platform_switch' && x.args.p_key === 'desk_off' && x.args.p_on === true), '4. Desk off');
  ok(c4.some(x => x.rpc === 'set_pilot_cap' && x.args.p_n === 3), '4. pilot cap');
  ok(!t.errs.length, '4. no page errors ' + t.errs.join(' | '));
  await t.ctx.close();

  await b.close();
  console.log(failed ? `${failed} FAILED` : 'EMAIL AND SAFETY SWITCH BROWSER CHECKS PASSED'); process.exit(failed ? 1 : 0);
})();
