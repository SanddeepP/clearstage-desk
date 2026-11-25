// Module tabs (spec RD-PM-Spec-Module-Tabs.md, CTO 25 Nov) and QA-011 names, in the browser.
// Demo mode (signed out) and a signed-in real workspace with a fake Supabase client. Exits 1 on any FAIL.
// Run: serve the repo root (python3 -m http.server 8795), then node tests/browser/modules.cjs.
const BASE = process.env.BASE_URL || 'http://localhost:8795/';
const { chromium } = require('playwright');
const { opener } = require('./fake.cjs');

(async () => {
  const b = await chromium.launch(); let failed = 0; const ok = (c, m) => { if (!c) failed++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
  const open = opener(b, BASE);
  const text = (p, sel) => p.evaluate(s => document.querySelector(s)?.innerText || '', sel);
  const go = async (p, h) => { await p.evaluate(x => { location.hash = x; }, h); await p.waitForTimeout(350); };
  const ask = async (p, q) => { await go(p, 'desk'); await p.fill('#q', q); await p.keyboard.press('Enter'); await p.waitForTimeout(1100); return text(p, '#inner'); };
  const RAIL = ['Hire', 'Onboard', 'Probation', 'Compliance', 'Exit', 'Time & attendance', 'Payroll', 'Performance', 'Policies'];

  // ---------- A. Demo (signed out): the sample company ----------
  {
    const ctx = await b.newContext({ timezoneId: 'Asia/Kolkata', viewport: { width: 1280, height: 900 } }); const p = await ctx.newPage();
    const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: 'export const SUPABASE_URL="", SUPABASE_ANON_KEY="", EMAIL_HAS_CODE=true;' }));
    await p.goto(BASE); await p.fill('#email', 'demo@example.com'); await p.click('#sendBtn');
    await p.waitForSelector('#s-code:not([hidden])'); await p.fill('#code', (await p.textContent('#demoCode')).match(/\d{6}/)[0]);
    await p.waitForSelector('#s-setup:not([hidden]), #s-app:not([hidden])');
    if (await p.isVisible('#s-setup')) {
      await p.fill('#fullName', 'XXXX'); await p.fill('#company', 'Demo Co'); await p.selectOption('#country', 'IN'); await p.click('#setupBtn'); await p.waitForTimeout(300);
      ok(/Enter your name as people know you/.test(await p.textContent('#setupErr')), 'A0. setup refuses the name "XXXX" (QA-011)');
      await p.fill('#fullName', 'Ritu'); await p.click('#setupBtn');
    }
    await p.waitForSelector('#s-app:not([hidden])');
    const rail = await p.$$eval('.sidenav a[data-mod]', as => as.map(a => ({ name: a.childNodes[1]?.textContent?.trim() || a.textContent.trim(), tag: a.querySelector('.mtag')?.textContent || '' })));
    ok(rail.map(r => r.name).join('|') === RAIL.join('|'), 'A1. rail order: ' + rail.map(r => r.name).join(' → '));
    ok(rail.map(r => r.tag).join('|') === '|Preview|Preview|Soon|Soon|Soon|Soon|Soon|Soon', 'A1. tags: ' + rail.map(r => r.tag || '—').join(' '));
    ok((await p.$$eval('.sidenav .grp', g => g.map(x => x.textContent))).join('|').includes('Hire to exit|Manage'), 'A1. groups "Hire to exit" and "Manage"');
    ok((await p.$eval('[data-mtag="onboard"]', e => getComputedStyle(e).color)) !== 'rgb(197, 94, 0)', 'A1. tags are grey, not orange');
    await go(p, 'joiners');
    ok((await p.evaluate(() => location.hash)) === '#onboard', 'A2. old #joiners link opens Onboard');
    let t = await text(p, '#view');
    ok(t.includes("Preview: this module is being built. You're seeing sample data.") && t.includes('Sneha Rao'), 'A2. Onboard: Preview banner + sample joiners');
    ok(!!(await p.$('#view [data-v="task"]')), 'A2. sample company keeps the demo flow (Fix with Desk)');
    await go(p, 'probation'); t = await text(p, '#view');
    ok(t.includes('Preview: this module') && t.includes('Priya Nair'), 'A3. Probation: banner + Priya Nair');
    await go(p, 'exit'); t = await text(p, '#view');
    ok(t.includes('Exit') && t.includes('Coming soon') && t.includes('Resignation to final settlement, with nothing missed.') && t.includes('What it will do') && t.includes('How it works with Desk'), 'A4. Exit Coming-soon page');
    ok(!/\b(January|February|March|April|May|June|July|August|September|October|November|December|2027)\b/.test(t), 'A4. no dates on the page');
    ok(!/Sneha|Kiran|Priya/.test(t), 'A4. no fake data on a Coming-soon page');
    await p.fill('#needNote', 'we have 3 exits a month'); await p.click('.needform button'); await p.waitForTimeout(400);
    t = await text(p, '#view');
    ok(t.includes("Thanks, you'll hear from us first") && t.includes('we have 3 exits a month') && t.includes('Acme Fintech'), 'A5. "I need this" → thanks, with the note');
    await p.reload(); await p.waitForSelector('#s-app:not([hidden])'); await go(p, 'exit');
    ok((await text(p, '#view')).includes("Thanks, you'll hear from us first"), 'A5. still recorded after a reload (once per module)');
    for (const k of ['compliance', 'time', 'payroll', 'performance', 'policies']) { await go(p, k); ok(/Coming soon/.test(await text(p, '#view')) && !!(await p.$('.needform')), `A6. ${k} has its Coming-soon page`); }
    let r = await ask(p, "start Ravi's exit");
    ok(r.includes("Exit is coming soon in Clearstage. I've noted that you need it."), 'A7. Desk: "start Ravi\'s exit" → honest reply');
    r = await ask(p, 'run payroll for this month');
    ok(r.includes("Payroll is coming soon in Clearstage. I've noted that you need it."), 'A7. Desk: payroll → honest reply');
    await go(p, 'payroll');
    ok((await text(p, '#view')).includes("Thanks, you'll hear from us first"), 'A7. the Desk request counts as interest');
    r = await ask(p, "Draft Sneha's appointment letter");
    ok(!/in preview in Clearstage/.test(r.split('Payroll is coming soon').pop()), 'A8. sample company: Onboard preview still shows the demo flow');
    await go(p, 'settings');
    ok(!(await p.$('#nameCard')) && !(await p.$('#modulesAdmin')), 'A9. public demo: no name card, no Modules admin');
    ok(!errs.length, 'A. no page errors ' + errs.join(' | '));
    await ctx.close();
  }

  // ---------- B. Real company, signed in (fake client), Onboard/Probation in preview ----------
  const uid = 'u-1', own = { id: 'co-own', name: 'cccc', is_sample: false };
  const mem = co => ({ user_id: uid, company_id: co.id, full_name: 'XXXX', phone: null, app_role: 'owner', company: { id: co.id, name: co.name, city: 'Hyderabad', team_setup: 'solo', desk_enabled: false } });
  const DEF = { hire: 'live', onboard: 'preview', probation: 'preview', compliance: 'soon', exit: 'soon', time: 'soon', payroll: 'soon', performance: 'soon', policies: 'soon' };
  let t2 = await open({ session: true, uid, email: 'founder@example.com', signedInAt: Date.now() - 3600e3, workspaces: [own], members: [mem(own)], rpcData: { my_modules: DEF } });
  let p = t2.p;
  await go(p, 'onboard'); let t = await text(p, '#view');
  ok(t.includes("Preview: this module is being built.") && t.includes('Sample data') && t.includes('Sneha Rao'), 'B1. real company: Onboard preview shows labelled sample rows');
  ok(!(await p.$('#view [data-v="task"]')), 'B1. no Desk actions on preview sample rows');
  ok(await p.$eval('#view button[disabled]', b => b.textContent.includes('when Onboard is live')), 'B1. "Add a joiner · when Onboard is live" is disabled');
  ok(t.includes('Preview: nothing here is saved or sent.'), 'B1. footer: nothing saved or sent');
  let r = await ask(p, "Draft Sneha's appointment letter");
  ok(r.includes('Onboard is in preview in Clearstage') && r.includes("I've noted that you need it."), 'B2. Desk in a real company: preview module → honest reply');
  let c = await t2.calls();
  ok(c.some(x => x.rpc === 'register_module_interest' && x.args.p_module === 'onboard' && x.args.p_source === 'desk'), 'B2. interest recorded from Desk');
  await go(p, 'compliance'); await p.fill('#needNote', 'we file PF monthly'); await p.click('.needform button'); await p.waitForTimeout(500);
  c = await t2.calls();
  ok(c.some(x => x.rpc === 'register_module_interest' && x.args.p_module === 'compliance' && x.args.p_note === 'we file PF monthly' && x.args.p_source === 'page'), 'B3. "I need this" sends module, note and source');
  ok((await text(p, '#view')).includes('Recorded for cccc'), 'B3. thanks names the company');
  // QA-011: the name card
  await go(p, 'settings');
  ok(!!(await p.$('#nameCard')) && (await p.inputValue('#myName')) === 'XXXX', 'B4. Settings shows "Your name" with the stored name');
  await p.fill('#myName', 'cccc'); await p.click('#nameForm button'); await p.waitForTimeout(300);
  ok((await text(p, '#nameCard')).includes('Enter your name as people know you'), 'B4. a placeholder name is refused');
  await p.fill('#myName', 'Sanddeep Pittla'); await p.click('#nameForm button'); await p.waitForTimeout(500);
  c = await t2.calls();
  ok(c.some(x => x.rpc === 'update_my_name' && x.args.p_name === 'Sanddeep Pittla') && (await p.textContent('#who')).includes('Sanddeep'), 'B4. name saved and shown: ' + (await p.textContent('#who')));
  ok(!(await p.$('#modulesAdmin')), 'B5. a client sees no Modules admin card');
  await go(p, 'insights'); ok(!(await p.$('#moduleInterest')), 'B5. a client sees no Module interest');
  ok(!t2.errs.length, 'B. no page errors ' + t2.errs.join(' | '));
  await t2.ctx.close();

  // ---------- C. Platform admin: Settings → Modules, Insights → Module interest; Onboard switched live ----------
  const companies = [{ id: 'co-own', name: 'cccc', is_sample: false, country: 'IN', modules: { ...DEF } }, { id: 'co-s', name: 'Acme Fintech', is_sample: true, country: 'IN', modules: { ...DEF } }];
  t2 = await open({ session: true, uid, email: 'founder@example.com', signedInAt: Date.now() - 3600e3, admin: true, workspaces: [own], members: [{ ...mem(own), full_name: 'Sanddeep Pittla' }],
    rpcData: { my_modules: { ...DEF }, platform_companies: companies, sample_access_list: [],
      module_interest_counts: [{ module: 'exit', people: 3, companies: 2, from_desk: 1, latest_at: new Date().toISOString(), notes: [{ company: 'Brit Hire Ltd', note: 'we have 3 exits a month', at: new Date().toISOString() }] }] } });
  p = t2.p;
  await go(p, 'settings'); await p.waitForTimeout(500);
  ok(!!(await p.$('#modulesAdmin')), 'C1. admin sees Settings → Modules');
  ok((await p.$eval('[data-modstate="compliance"]', s => s.disabled)) && (await p.$eval('[data-modstate="hire"]', s => s.disabled)), 'C1. modules without screens can\'t be switched');
  await p.selectOption('[data-modstate="onboard"]', 'live'); await p.waitForTimeout(700);
  c = await t2.calls();
  ok(c.some(x => x.rpc === 'set_module_state' && x.args.p_company === 'co-own' && x.args.p_module === 'onboard' && x.args.p_state === 'live'), 'C2. switching calls set_module_state for the chosen company');
  ok((await p.$eval('[data-mtag="onboard"]', e => e.textContent)) === '', 'C2. own company: Onboard tag disappears once live');
  await go(p, 'onboard'); t = await text(p, '#view');
  ok(!t.includes('Preview: this module') && t.includes('No joiners yet'), 'C3. Onboard live: no banner, real (empty) data');
  await go(p, 'insights'); await p.waitForTimeout(500); t = await text(p, '#view');
  ok(t.includes('Module interest') && t.includes('Exit') && t.includes('we have 3 exits a month'), 'C4. Insights → Module interest for the platform admin');
  ok(!t2.errs.length, 'C. no page errors ' + t2.errs.join(' | '));
  await t2.ctx.close();

  // ---------- D. 360 px: the rail scrolls, tags stay readable ----------
  t2 = await open({ session: true, uid, email: 'founder@example.com', signedInAt: Date.now() - 3600e3, workspaces: [own], members: [mem(own)], rpcData: { my_modules: DEF } }, { size: { width: 360, height: 740 } });
  p = t2.p;
  const nav = await p.$eval('.sidenav', n => ({ sw: n.scrollWidth, cw: n.clientWidth, ox: getComputedStyle(n).overflowX }));
  ok(nav.sw > nav.cw && /auto|scroll/.test(nav.ox), '360px: the rail scrolls sideways');
  const tag = await p.$eval('[data-mtag="exit"]', e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return { h: r.height, fs: parseFloat(s.fontSize), w: r.width }; });
  ok(tag.fs >= 11 && tag.h >= 16 && tag.w > 20, '360px: tags readable ' + JSON.stringify(tag));
  ok((await p.evaluate(() => document.documentElement.scrollWidth)) <= 360, '360px: the page itself doesn\'t scroll sideways');
  await p.screenshot({ path: (process.env.SHOTS || '/tmp') + '/modules-360.png' });
  await t2.ctx.close();

  await b.close();
  console.log(failed ? `${failed} FAILED` : 'MODULE TAB CHECKS PASSED'); process.exit(failed ? 1 : 0);
})();
