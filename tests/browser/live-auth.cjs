// Live sign-in path with a fake Supabase client (bugs of 25 Nov): expired session on load, two workspaces, setup sign-out.
// Run: serve the repo root (python3 -m http.server 8795), then node tests/browser/live-auth.cjs. Exits 1 on any FAIL.
const BASE = process.env.BASE_URL || 'http://localhost:8795/';
const { chromium } = require('playwright');
const FAKE = `(() => {
  const F = window.__fake; F.calls ||= []; F.loads = (F.loads || 0) + 1;
  const b64 = o => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\\+/g, '-').replace(/\\//g, '_');
  const token = () => 'h.' + b64({ sub: F.uid, session_id: 's1', amr: [{ method: 'otp', timestamp: Math.floor(F.signedInAt / 1000) }] }) + '.s';
  let session = F.session ? { access_token: token(), user: { id: F.uid, email: F.email } } : null;
  const listeners = [];
  const res = (data, error = null) => Promise.resolve({ data, error });
  function query(table) {
    const q = { table, filters: {} };
    const run = mode => {
      F.calls.push({ table, filters: { ...q.filters }, mode });
      if (table !== 'member') return res(mode === 'many' ? [] : null);
      const rows = (F.members || []).filter(r => Object.entries(q.filters).every(([k, v]) => r[k] === v));
      if (F.rlsStale) return res(mode === 'many' ? [] : null);
      if (mode === 'maybeSingle' && rows.length > 1) return res(null, { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' });
      return res(mode === 'many' ? rows : rows[0] ?? null);
    };
    const api = { select: () => api, eq: (k, v) => { q.filters[k] = v; return api; }, order: () => api, limit: () => api, in: () => api,
      maybeSingle: () => run('maybeSingle'), single: () => run('maybeSingle'), then: (a, b) => run('many').then(a, b) };
    return api;
  }
  window.supabase = { createClient: () => ({
    auth: {
      getSession: () => res({ session }),
      onAuthStateChange: fn => { listeners.push(fn); return { data: { subscription: { unsubscribe() {} } } }; },
      signOut: () => { F.calls.push({ signOut: true }); session = null; listeners.forEach(l => l('SIGNED_OUT', null)); return res({}); },
      signInWithOtp: () => res({}), verifyOtp: () => res({ user: { id: F.uid, email: F.email }, session }),
    },
    rpc: (name, args) => {
      F.calls.push({ rpc: name, args });
      if (name === 'session_fresh') return res(!F.rlsStale);
      if (name === 'my_workspaces') return res(F.rlsStale ? [] : (F.workspaces || []));
      if (name === 'is_platform_admin') return res(false);
      if (name === 'create_company_for_me') return F.createError ? res(null, F.createError) : res('new-co');
      if (name === 'my_company_region') return res(null);
      return res(null);
    },
    from: query,
    functions: { invoke: () => res({}) },
  }) };
})();`;
(async () => {
  const b = await chromium.launch(); let failed = 0; const ok = (c, m) => { if (!c) failed++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
  async function open(fake, { storage = {} } = {}) {
    const ctx = await b.newContext({ timezoneId: 'Asia/Kolkata', viewport: { width: 1280, height: 900 } }); const p = await ctx.newPage();
    const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.addInitScript(([f, st]) => { window.__fake = f; try { for (const [k, v] of Object.entries(st)) localStorage.setItem(k, v); } catch {} }, [fake, storage]);
    await p.route('**/supabase.min.js', r => r.fulfill({ contentType: 'text/javascript', body: FAKE }));
    await p.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: 'export const SUPABASE_URL="https://fake.supabase.test", SUPABASE_ANON_KEY="sb_publishable_test", EMAIL_HAS_CODE=true;' }));
    await p.route('https://fake.supabase.test/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fake.deskReply || { error: 'unexpected' }) }));
    await p.goto(BASE); await p.waitForTimeout(1500);
    const vis = async id => !(await p.isHidden('#' + id));
    const calls = () => p.evaluate(() => window.__fake.calls);
    return { p, ctx, errs, vis, calls };
  }
  const H = 3600e3, now = Date.now(), uid = 'u-founder';
  const own = { id: 'co-own', name: 'cccc', is_sample: false }, sample = { id: 'co-sample', name: 'Acme Fintech', is_sample: true };
  const mem = co => ({ user_id: uid, company_id: co.id, full_name: 'Founder', phone: null, app_role: 'owner',
    company: { id: co.id, name: co.name, city: 'Hyderabad', team_setup: 'solo', desk_enabled: !co.is_sample } });

  // 1a. Signed in 13 hours ago: refused on load, before any data is loaded
  let t = await open({ session: true, uid, email: 'founder@example.com', signedInAt: now - 13 * H, workspaces: [own], members: [mem(own)] });
  ok(await t.vis('s-email') && !(await t.vis('s-setup')) && !(await t.vis('s-app')), '1a. session over 12 h on load → sign-in screen, not setup');
  ok(/12 hours/.test(await t.p.textContent('#signedOutNote')), '1a. message: ' + (await t.p.textContent('#signedOutNote')).trim());
  let c = await t.calls(); ok(c.some(x => x.signOut) && !c.some(x => x.table === 'member' || x.rpc === 'my_workspaces'), '1a. signed out before loading anything');
  ok(!t.errs.length, '   no page errors ' + t.errs.join(' | ')); await t.ctx.close();

  // 1b. Idle for 40 minutes (last activity in storage): refused on load
  t = await open({ session: true, uid, email: 'founder@example.com', signedInAt: now - 2 * H, workspaces: [own], members: [mem(own)] }, { storage: { 'cs:act': String(now - 40 * 60e3), 'cs:signin': String(now - 2 * H) } });
  ok(await t.vis('s-email') && /30 minutes/.test(await t.p.textContent('#signedOutNote')), '1b. idle 40 min on load → sign-in screen with the idle message');
  await t.ctx.close();

  // 1c. Token looks fresh but the database says the session is stale (RLS hides every row)
  t = await open({ session: true, uid, email: 'founder@example.com', signedInAt: now - 1 * H, rlsStale: true, workspaces: [own], members: [mem(own)] });
  ok(await t.vis('s-email') && !(await t.vis('s-setup')), '1c. database says expired → sign-in screen, never "Set up your workspace"');
  ok((await t.p.textContent('#signedOutNote')).includes('Your session has expired. Sign in again.'), '1c. message from the database shown');
  ok((await t.calls()).some(x => x.signOut), '1c. signed out');
  await t.ctx.close();

  // 3. Own company + sample access: two member rows; opens the own company, switcher shows both
  t = await open({ session: true, uid, email: 'founder@example.com', signedInAt: now - 1 * H, workspaces: [own, sample], members: [mem(own), mem(sample)] });
  ok(await t.vis('s-app'), '3. two workspaces → app opens (no "multiple rows")');
  ok(/cccc/.test(await t.p.textContent('#coLine')) && await t.p.isHidden('#sampleBan'), '3. own company first, no sample banner: ' + (await t.p.textContent('#coLine')));
  ok((await t.p.evaluate(() => window.__fake.loads)) === 1, '3. one Supabase client per page');
  ok(!(await t.p.isHidden('#wsSwitch')) && (await t.p.$$eval('#wsSwitch option', o => o.map(x => x.textContent))).join('|') === 'Your company|Sample company (demo data)', '3. switcher: Your company | Sample company');
  c = await t.calls(); ok(c.some(x => x.table === 'member' && x.filters.company_id === 'co-own'), '3. profile read from the own company row only');
  await t.p.selectOption('#wsSwitch', 'co-sample'); await t.p.waitForTimeout(500);
  ok(!(await t.p.isHidden('#sampleBan')), '3. switching to the sample company shows the grey banner');
  ok(!t.errs.length, '   no page errors ' + t.errs.join(' | ')); await t.ctx.close();

  // 3b. Only sample access, no own company → setup (to create their own)
  t = await open({ session: true, uid, email: 'pilot@example.com', signedInAt: now - 1 * H, workspaces: [sample], members: [mem(sample)] });
  ok(await t.vis('s-setup'), '3b. sample access only → setup for their own company');
  // 2. Setup has "Use a different email"
  ok((await t.p.textContent('#setupEmail')) === 'pilot@example.com', '2. setup shows who is signed in');
  await t.p.click('#setupSignOut'); await t.p.waitForTimeout(600);
  ok(await t.vis('s-email') && (await t.calls()).some(x => x.signOut), '2. "Use a different email" signs out to the sign-in screen');
  await t.ctx.close();

  // 1d. Setup submit refused by the database as expired → sign-in screen with the message
  t = await open({ session: true, uid, email: 'new@example.com', signedInAt: now - 1 * H, workspaces: [], members: [],
    createError: { message: 'Your session has expired. Sign in again.', code: '28000' } });
  await t.p.fill('#fullName', 'Sam'); await t.p.fill('#company', 'New Co'); await t.p.selectOption('#country', 'IN');
  await t.p.click('#setupBtn'); await t.p.waitForTimeout(800);
  ok(await t.vis('s-email') && (await t.p.textContent('#signedOutNote')).includes('Your session has expired'), '1d. expired at setup submit → sign-in screen, not "That code has expired"');
  await t.ctx.close();

  // 1e. Desk call refused as expired → sign-in screen, typed text kept
  t = await open({ session: true, uid, email: 'founder@example.com', signedInAt: now - 1 * H, workspaces: [own], members: [mem(own)],
    deskReply: { error: 'Your session has expired. Sign in again.' } });
  await t.p.evaluate(() => location.hash = 'desk'); await t.p.waitForTimeout(400);
  await t.p.fill('#q', 'Who is late on feedback?'); await t.p.keyboard.press('Enter'); await t.p.waitForTimeout(1200);
  ok(await t.vis('s-email') && (await t.p.textContent('#signedOutNote')).includes('Your session has expired'), '1e. expired on a Desk call → sign-in screen with the message');
  ok((await t.p.evaluate(() => sessionStorage.getItem('cs:draft'))) === 'Who is late on feedback?', '1e. the typed question is kept for after sign-in');
  ok(!t.errs.length, '   no page errors ' + t.errs.join(' | ')); await t.ctx.close();
  await b.close();
  console.log(failed ? `${failed} FAILED` : 'LIVE SIGN-IN CHECKS PASSED'); process.exit(failed ? 1 : 0);
})();
