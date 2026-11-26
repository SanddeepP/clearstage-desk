// FA-014 live CV screening for real companies: switched on per company by Clearstage, one PDF/DOCX at a time, the
// person's OK required, result card in the company's own Desk, and a Delete CV button (file first, then the record).
// Fake Supabase client; every person and file here is fictional.
// Run: serve the repo root (python3 -m http.server 8795), then node tests/browser/cv-live.cjs.
const BASE = process.env.BASE_URL || 'http://localhost:8795/';
const { chromium } = require('playwright');
const { opener } = require('./fake.cjs');

(async () => {
  const b = await chromium.launch(); let failed = 0; const ok = (c, m) => { if (!c) failed++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
  const open = opener(b, BASE);
  const uid = 'u-1', own = { id: 'co-own', name: 'cccc', is_sample: false }, sample = { id: 'co-s', name: 'Acme Fintech', is_sample: true };
  const mem = co => ({ user_id: uid, company_id: co.id, full_name: 'Sanddeep Pittla', phone: null, app_role: 'owner', company: { id: co.id, name: co.name, city: 'Hyderabad', team_setup: 'solo', desk_enabled: true } });
  const DEF = { hire: 'live', onboard: 'preview', probation: 'preview', compliance: 'soon', exit: 'soon', time: 'soon', payroll: 'soon', performance: 'soon', policies: 'soon' };
  const roles = [{ role_id: 'role-1', title: 'Support Engineer', city: 'Pune', requirement_id: 'req-1', version: 2 }];
  const result = { cv_file_id: 'cvf-1', application_id: 'app-1', file_name: 'tara-cv.pdf', readable: true, status: 'done', name: 'Tara Fictional', role: 'Support Engineer',
    score: { fit: 78, stars: 4, must_met: 2, must_total: 3, years: 3.5, under50: false, safeguard: false, label: null, version: 2 },
    evidence: [{ item: 'm1', quote: 'Handled 60 support tickets a day on Freshdesk', section: 'Experience' }, { item: 'm2', quote: 'Wrote SQL reports for the support team', section: 'Experience' }],
    requirements: { must: [{ id: 'm1', label: 'Customer support' }, { id: 'm2', label: 'SQL' }, { id: 'm3', label: 'Ticketing tools' }] } };
  const base = extra => ({ session: true, uid, email: 'founder@example.com', signedInAt: Date.now() - 600e3, workspaces: [own, sample], members: [mem(own), mem(sample)],
    myRoles: { roles: ['super_admin'] }, ...extra, rpcData: { my_modules: DEF, ...(extra?.rpcData || {}) } });
  const pdf = (name = 'tara-cv.pdf', size = 2048) => ({ name, mimeType: 'application/pdf', buffer: Buffer.alloc(size, 37) });
  const deskText = p => p.evaluate(() => document.body.innerText);
  const upload = async (p, files) => { await p.evaluate(() => { location.hash = 'desk'; }); await p.waitForTimeout(300); await p.setInputFiles('#file', files); await p.waitForTimeout(900); };

  // ---------- 1. switched off: nothing read, nothing stored ----------
  let t = await open(base({ rpcData: { cv_screening_enabled: false } }));
  await upload(t.p, [pdf()]);
  let c = await t.calls(), txt = await deskText(t.p);
  ok(txt.includes("Live CV screening isn't switched on for your company yet") && txt.includes("didn't read or keep"), '1. off: plain message, file not kept');
  ok(!c.some(x => x.storage) && !c.some(x => x.rpc === 'desk_add_candidate'), '1. off: no upload, no candidate');
  ok(!t.errs.length, '1. no page errors ' + t.errs.join(' | '));
  await t.ctx.close();

  // ---------- 2. on: the sheet, consent, upload, screening, result card ----------
  t = await open(base({ rpcData: { cv_screening_enabled: true, cv_upload_roles: roles, desk_add_candidate: { person_id: 'p-1', application_id: 'app-1' } }, cvResult: result,
    deskReply: { status: 'done', fit: 78, stars: 4 } }));
  await upload(t.p, [pdf('bundle.zip', 900)]);
  txt = await deskText(t.p);
  ok(txt.includes('one PDF or DOCX at a time'), '2. a ZIP is refused for live screening');
  await upload(t.p, [pdf('big.pdf', 5 * 1024 * 1024 + 10)]);
  ok((await deskText(t.p)).includes('over 5 MB'), '2. a file over 5 MB is refused');
  await upload(t.p, [pdf()]);
  ok(!!(await t.p.$('[data-cvsheet]')), '2. the Screen a CV sheet opens with the role list');
  ok((await t.p.$eval('[data-cvsheet] select', s => s.innerText)).includes('Support Engineer · Pune (requirements v2)'), '2. role shows title, city and requirements version');
  await t.p.fill('[data-cv="name"]', 'Tara Fictional');
  await t.p.click('[data-cvsheet] button[type="submit"]'); await t.p.waitForTimeout(300);
  ok((await t.p.$eval('[data-cv="msg"]', e => e.textContent)).includes('agreed to share'), '2. no consent tick: refused with a plain message');
  c = await t.calls();
  ok(!c.some(x => x.storage), '2. nothing stored before the consent tick');
  await t.p.check('[data-cv="consent"]');
  await t.p.click('[data-cvsheet] button[type="submit"]'); await t.p.waitForTimeout(1200);
  c = await t.calls();
  const iAdd = c.findIndex(x => x.rpc === 'desk_add_candidate'), iUp = c.findIndex(x => x.storage === 'upload'), iQ = c.findIndex(x => x.rpc === 'desk_enqueue_cv');
  ok(iAdd >= 0 && c[iAdd].args.p_consent === true && c[iAdd].args.p_name === 'Tara Fictional' && c[iAdd].args.p_role_id === 'role-1', '2. candidate added with consent recorded');
  const up = c[iUp] || {};
  ok(up.bucket === 'cvs' && /^co-own\/[0-9a-f-]{36}\.pdf$/.test(up.path || '') && up.type === 'application/pdf', '2. file stored in the company\'s own folder under a random name · ' + up.path);
  ok(iQ > iUp && iUp > iAdd && /^[0-9a-f]{64}$/.test(c[iQ].args.p_sha) && c[iQ].args.p_requirement === 'req-1', '2. queued after upload, with the file hash and confirmed requirements');
  ok(t.deskCalls.some(r => r && r.job_id === 41), '2. screen-cv called with the job id');
  txt = await deskText(t.p);
  ok(txt.includes('CV screened') && txt.includes('Tara Fictional') && txt.includes('Fit 78') && txt.includes('Must-haves met: 2 of 3'), '2. result card: name, fit, must-haves');
  ok(txt.includes('Handled 60 support tickets a day on Freshdesk') && (await t.p.$$eval('[data-cvresult] .item .pill', e => e.map(x => x.textContent))).join(',') === 'Met,Met,Gap', '2. result card: quotes per requirement and the gap');
  ok(!txt.includes('tara@') && !(await t.p.$('[data-cvsheet]')), '2. the sheet closes after screening');

  // ---------- 3. Delete CV: confirm in the card, file first, then the record ----------
  await t.p.click('[data-cvdel]'); await t.p.waitForTimeout(200);
  ok((await deskText(t.p)).includes('Delete this CV for good?'), '3. Delete asks in the card (no browser dialog)');
  await t.p.click('[data-cvdelyes]'); await t.p.waitForTimeout(700);
  c = await t.calls();
  const iRm = c.findIndex(x => x.storage === 'remove'), iDel = c.findIndex(x => x.rpc === 'desk_delete_cv');
  ok(iRm >= 0 && iDel > iRm && c[iRm].paths[0] === up.path && c[iDel].args.p_cv_file === 'cvf-1', '3. the stored file is removed first, then the record');
  txt = await deskText(t.p);
  ok(txt.includes('Deleted the CV') && txt.includes('Tara Fictional is still on Support Engineer') && !(await t.p.$('[data-cvresult]')), '3. deleted: plain confirmation, candidate kept');
  ok(!t.errs.length, '2–3. no page errors ' + t.errs.join(' | '));
  await t.ctx.close();

  // ---------- 4. a failed queue removes the stored file again ----------
  t = await open(base({ rpcData: { cv_screening_enabled: true, cv_upload_roles: roles, desk_add_candidate: { person_id: 'p-1', application_id: 'app-1' } }, enqueueError: 'Confirm the requirements card before screening' }));
  await upload(t.p, [pdf()]);
  await t.p.fill('[data-cv="name"]', 'Tara Fictional'); await t.p.check('[data-cv="consent"]');
  await t.p.click('[data-cvsheet] button[type="submit"]'); await t.p.waitForTimeout(900);
  c = await t.calls();
  ok(c.some(x => x.storage === 'remove'), '4. queue refused: the stored file is removed');
  ok((await t.p.$eval('[data-cv="msg"]', e => e.textContent)).includes('Confirm the requirements card'), '4. the reason shows in the sheet');
  await t.ctx.close();

  // ---------- 5. Clearstage switches it on per real company (Settings → Modules) ----------
  const companies = [{ id: 'co-own', name: 'cccc', is_sample: false, country: 'IN', cv_live: false, modules: { ...DEF } }, { id: 'co-s', name: 'Acme Fintech', is_sample: true, country: 'IN', cv_live: false, modules: { ...DEF } }];
  t = await open(base({ admin: true, workspaces: [own], members: [mem(own)], rpcData: { platform_companies: companies, sample_access_list: [], module_interest_counts: [] } }));
  await t.p.evaluate(() => { location.hash = 'settings'; }); await t.p.waitForTimeout(700);
  ok(!!(await t.p.$('[data-cvlive]')), '5. Live CV screening switch shows for a real company');
  await t.p.selectOption('[data-cvlive]', 'on'); await t.p.waitForTimeout(800);
  c = await t.calls();
  ok(c.some(x => x.rpc === 'set_cv_live' && x.args.p_company === 'co-own' && x.args.p_on === true), '5. switching calls set_cv_live');
  ok((await deskText(t.p)).includes('Live CV screening is now on for cccc'), '5. confirmation shown');
  await t.p.selectOption('#modCompany', 'co-s'); await t.p.waitForTimeout(400);
  ok(!(await t.p.$('[data-cvlive]')), '5. no switch for the sample company');
  ok(!t.errs.length, '5. no page errors ' + t.errs.join(' | '));
  await t.ctx.close();

  await b.close();
  console.log(failed ? `${failed} FAILED` : 'LIVE CV SCREENING (FA-014) BROWSER CHECKS PASSED'); process.exit(failed ? 1 : 0);
})();
