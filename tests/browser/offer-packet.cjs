// Item 4 (CTO approval-packet rulings 21 Nov): an offer is approved from its packet — letter + Annexure A from the
// calculator (sample template, "rules review pending"), checks, CV, history — only after reading to Annexure A, one exact
// version with its content hash. Fake Supabase; fictional data only.
// Run: serve the repo root (python3 -m http.server 8795), then node tests/browser/offer-packet.cjs.
const BASE = process.env.BASE_URL || 'http://localhost:8795/';
const { chromium } = require('playwright');
const { opener } = require('./fake.cjs');

(async () => {
  const b = await chromium.launch(); let failed = 0; const ok = (c, m) => { if (!c) failed++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
  const open = opener(b, BASE);
  const uid = 'u-1', own = { id: 'co-own', name: 'cccc', is_sample: false };
  const mem = { user_id: uid, company_id: own.id, full_name: 'Sanddeep Pittla', phone: null, app_role: 'owner', company: { id: own.id, name: own.name, city: 'Hyderabad', team_setup: 'solo', desk_enabled: true } };
  const DEF = { hire: 'live', onboard: 'preview', probation: 'preview', compliance: 'soon', exit: 'soon', time: 'soon', payroll: 'soon', performance: 'soon', policies: 'soon' };
  const hash = 'a'.repeat(12) + '4041a64c43cfa8bd9981284f9b2521bac5c515aa9127abc2a6deda67';
  const content = { template: { id: 'clearstage-offer-in', version: 1, name: 'Clearstage sample offer letter (India)', status: 'rules review pending' },
    fields: { candidate_name: 'Kavya Fictional', role_title: 'Data Analyst', company: 'cccc' },
    clauses: [{ id: 'opening', text: 'Dear Kavya,' }, { id: 'offer', text: 'We are pleased to offer you the position of Data Analyst at cccc, based in Hyderabad.' },
      ...Array.from({ length: 8 }, (_, i) => ({ id: 'c' + i, text: 'A clause of the sample template, long enough to need scrolling in the panel. '.repeat(3) })), { id: 'signature', text: 'For cccc' }],
    annexure: { title: 'Annexure A: salary structure', currency: 'INR', ctc: 1200000, wages_percent: 51.2, passes: true, note: 'PF: 12% × min(PF wages, ₹25,000) — Code on Social Security, 2020; EPF Scheme; S.O. 5109(E), 17 Sep 2026. Awaiting legal review.',
      lines: [{ name: 'Basic + DA', annual: 600000, monthly: 50000 }, { name: 'HRA', annual: 240000, monthly: 20000 }, { name: 'Special allowance', annual: 295154, monthly: 24596 }, { name: 'Employer PF', annual: 36000, monthly: 3000 }, { name: 'Gratuity', annual: 28846, monthly: 2404 }] } };
  const packet = (extra = {}) => ({ offer_id: 'off-1', status: 'draft', can_approve: true, version: { id: 'ver-3', no: 3, hash, content, created_at: '2026-11-26T10:35:00Z', reviewed_by_me: false },
    approved_version: null, versions: [{ no: 3, hash, created_at: '2026-11-26T10:35:00Z', by: 'Sanddeep' }, { no: 2, hash: 'b'.repeat(64), created_at: '2026-11-26T10:30:00Z', by: 'Sanddeep' }],
    checks: { wages_percent: 51.2, passes: true, rule: 'Code on Wages: wages at least 50% of pay', in_budget: true, budget: { min: 1000000, max: 1400000 }, template_status: 'rules review pending' },
    cv: { file_name: 'kavya-cv.pdf', readable: true, storage_path: 'co-own/x.pdf' }, history: [{ action: 'offer_drafted', at: '2026-11-26T10:20:00Z', by: 'Sanddeep' }], ...extra });
  const card = { reply: 'The offer is ready for approval.', conversation_id: 'c1', cards: [{ type: 'approval', title: 'Offer: Kavya, ₹12 L', preview: 'Goes to the candidate by email once approved.', subject_type: 'offer', subject_id: 'off-1',
    actions: [{ label: 'Approve & send', action: 'approve', params: { subject_type: 'offer', subject_id: 'off-1' } }, { label: 'Reject', action: 'discard', params: { subject_type: 'offer', subject_id: 'off-1' } }] }] };
  const base = extra => ({ session: true, uid, email: 'founder@example.com', signedInAt: Date.now() - 600e3, workspaces: [own], members: [mem], myRoles: { roles: ['super_admin'] }, ...extra,
    rpcData: { my_modules: DEF, ...(extra?.rpcData || {}) } });
  const start = async t => { await t.p.evaluate(() => { location.hash = 'desk'; }); await t.p.waitForTimeout(300); await t.p.fill('#q', "Send Kavya's offer"); await t.p.press('#q', 'Enter'); await t.p.waitForTimeout(800); };

  let t = await open(base({ rpcData: { offer_packet: packet(), mark_offer_reviewed: { version_id: 'ver-3', version_no: 3 } }, deskReplies: { chat: card, approve: { reply: 'Approved by Sanddeep Pittla. It\'s on the way.', approved_by: 'Sanddeep Pittla', cards: [] } },
    emailReply: { status: 'done', sent: 1, failed: 0, results: [] } }));
  await start(t);
  ok(!(await t.p.$('text=Approve & send')) && !!(await t.p.$('[data-packet="off-1"]')), '1. an offer card opens the packet; no bare Approve');
  await t.p.click('[data-packet="off-1"]'); await t.p.waitForTimeout(700);
  let txt = await t.p.$eval('[data-offerpacket]', e => e.innerText);
  ok(txt.includes('Dear Kavya,') && txt.includes('Annexure A: salary structure') && txt.includes('₹50,000') && txt.includes('₹12,00,000'), '2. letter and Annexure A (monthly and yearly)');
  ok(txt.includes('Sample template · rules review pending') && txt.includes('content hash ' + hash), '2. labelled "rules review pending", with version and content hash');
  ok(txt.includes('Wages 51.2% of pay') && txt.includes("inside the role's approved range") && txt.includes('FA-005'), '3. checks section');
  ok(txt.includes('kavya-cv.pdf') && !!(await t.p.$('[data-cvopen]')) && txt.includes('Version 3') && txt.includes('offer drafted'), '4. CV and history sections');
  ok(await t.p.$eval('[data-offer-approve]', e => e.disabled), '5. Approve is off until the letter is read');
  let c = await t.calls();
  ok(!c.some(x => x.rpc === 'mark_offer_reviewed'), '5. not marked read on opening');
  await t.p.$eval('.letter', e => { e.scrollTop = e.scrollHeight; }); await t.p.$eval('[data-annexure-end]', e => e.scrollIntoView({ block: 'center' })); await t.p.waitForTimeout(700);
  c = await t.calls();
  ok(c.some(x => x.rpc === 'mark_offer_reviewed' && x.args.p_version === 'ver-3'), '6. reaching the end of Annexure A records the review of that version');
  ok(!(await t.p.$eval('[data-offer-approve]', e => e.disabled)), '6. Approve turns on');
  await t.p.click('[data-offer-approve]'); await t.p.waitForTimeout(900);
  ok(t.deskCalls.some(r => r && r.action === 'approve' && r.params.subject_type === 'offer' && r.params.subject_id === 'off-1'), '7. approves the offer through Desk');
  ok((await t.p.$eval('[data-approve-row]', e => e.innerText)).includes('Approved · v3 · aaaaaaaaaaaa'), '7. shows the approved version and hash');
  ok(t.deskCalls.some(r => r && r.email), '7. the email goes out after approval');
  ok(!t.errs.length, 'no page errors ' + t.errs.join(' | '));
  await t.ctx.close();

  // a non-approver sees the packet but can't approve
  t = await open(base({ rpcData: { offer_packet: packet({ can_approve: false, cv: { file_name: 'kavya-cv.pdf', readable: true, storage_path: null } }) }, deskReplies: { chat: card } }));
  await start(t); await t.p.click('[data-packet="off-1"]'); await t.p.waitForTimeout(700);
  txt = await t.p.$eval('[data-offerpacket]', e => e.innerText);
  ok(txt.includes('Your drafts go to your lead for approval.') && !(await t.p.$('[data-offer-approve]')) && txt.includes('Only approvers can open the CV.'), '8. non-approver: no Approve, no CV link');
  await t.ctx.close();

  await b.close();
  console.log(failed ? `${failed} FAILED` : 'OFFER PACKET (ITEM 4) BROWSER CHECKS PASSED'); process.exit(failed ? 1 : 0);
})();
