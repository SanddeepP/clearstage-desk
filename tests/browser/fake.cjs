// Fake Supabase client for browser tests: served in place of supabase-js. Behaviour comes from window.__fake (set per test).
module.exports.FAKE = `(() => {
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
      if (name === 'is_platform_admin') return res(!!F.admin);
      if (name === 'create_company_for_me') return F.createError ? res(null, F.createError) : res('new-co');
      if (name === 'my_company_region') return res(null);
      if (name === 'register_module_interest') {
        F.interest ||= {}; const had = F.interest[args.p_module];
        F.interest[args.p_module] = { created_at: had?.created_at || new Date().toISOString(), note: had?.note || args.p_note || null, source: had?.source || args.p_source };
        return res({ module: args.p_module, ...F.interest[args.p_module], new: !had, by: 'Founder', company: (F.workspaces || [])[0]?.name });
      }
      if (name === 'my_module_interest') return res(F.interest || {});
      if (name === 'set_module_state') {
        if (F.setError) return res(null, { message: F.setError });
        const co = (F.rpcData.platform_companies || []).find(c => c.id === args.p_company); if (co) co.modules[args.p_module] = args.p_state;
        if (co && co.id === (F.workspaces || [])[0]?.id) F.rpcData.my_modules = { ...co.modules };
        return res({ module: args.p_module, state: args.p_state });
      }
      if (name === 'update_my_name') { (F.members || []).forEach(m => { m.full_name = args.p_name; }); return res({ full_name: args.p_name }); }
      if (F.rpcData && name in F.rpcData) return res(F.rpcData[name]);
      return res(null);
    },
    from: query,
    functions: { invoke: () => res({}) },
  }) };
})();`;
/** Opens the app with the fake client. fake: { session, uid, email, signedInAt, workspaces, members, admin, rpcData, deskReply, … } */
module.exports.opener = (b, BASE, { width = 1280, height = 900 } = {}) => async function open(fake, { storage = {}, size } = {}) {
  const ctx = await b.newContext({ timezoneId: 'Asia/Kolkata', viewport: size || { width, height } }); const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.addInitScript(([f, st]) => { window.__fake = f; try { for (const [k, v] of Object.entries(st)) localStorage.setItem(k, v); } catch {} }, [fake, storage]);
  await p.route('**/supabase.min.js', r => r.fulfill({ contentType: 'text/javascript', body: module.exports.FAKE }));
  await p.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: 'export const SUPABASE_URL="https://fake.supabase.test", SUPABASE_ANON_KEY="sb_publishable_test", EMAIL_HAS_CODE=true;' }));
  await p.route('https://fake.supabase.test/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fake.deskReply || { error: 'unexpected' }) }));
  await p.goto(BASE); await p.waitForTimeout(1500);
  const vis = async id => !(await p.isHidden('#' + id));
  const calls = () => p.evaluate(() => window.__fake.calls);
  return { p, ctx, errs, vis, calls };
};
