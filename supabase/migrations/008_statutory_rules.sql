-- 008_statutory_rules.sql — CTO rulings 21 Nov 2026 (RD-CTO-Rulings-Approval-Packet-21Nov.md §3, §4.1). Run after 007. Re-runnable.
-- 1. Dated statutory rules: the PF wage ceiling is ₹25,000 from 17 Sep 2026 (S.O. 5109(E)); ₹15,000 before. The calculator
--    takes the value in force on the date of joining (or the offer date), so the next statutory change is a data update.
--    Every row is "awaiting legal review". 005 is not edited (it is applied live); this migration replaces its functions.
-- 2. The 50% wages check now counts employer PF in total remuneration (s.2(y) clause (c)); gratuity and employer ESI stay out.
-- 3. ctc_breakup(inputs) builds every line of an offer from inputs only. Desk never sends amounts: desk_save_offer takes
--    CTC, Basic per month (or the default), HRA %, PF rule, variable pay at target and the date of joining.
-- 4. ctc_fix(inputs): "Fix the structure" raises Basic in ₹1,000 steps, keeps HRA's %, stops at wages ≥ 51%.
-- JS mirror: lib/rules.js + lib/ctc.js. Tests: tests/ctc.test.mjs (CTO reference table) and supabase/tests/statutory_rules.sql.

-- ---------- 1. statutory_rule ----------
create table if not exists statutory_rule (
  id bigserial primary key,
  code text not null,
  value jsonb not null,
  effective_from date not null,
  effective_to date,
  citation text not null,
  status text not null default 'awaiting legal review',
  created_at timestamptz not null default now(),
  constraint statutory_rule_dates check (effective_to is null or effective_to >= effective_from),
  constraint statutory_rule_once unique (code, effective_from)
);
alter table statutory_rule enable row level security;
drop policy if exists statutory_rule_read on statutory_rule;
create policy statutory_rule_read on statutory_rule for select to authenticated using (true);
-- No write policies: only Clearstage (CLI / service role) changes the rules.
revoke insert, update, delete, truncate on statutory_rule from authenticated, anon;

insert into statutory_rule(code, value, effective_from, effective_to, citation) values
  ('pf_wage_ceiling', '15000', '2014-09-01', '2026-09-16', 'EPF Scheme, 1952; ₹15,000 ceiling from 1 Sep 2014'),
  ('pf_wage_ceiling', '25000', '2026-09-17', null, 'Code on Social Security, 2020 / EPF Scheme; S.O. 5109(E) dated 17 Sep 2026'),
  ('esi_wage_limit', '{"general":21000,"disability":25000}', '2017-01-01', null, 'ESI (Central) Rules, 1950, r.50; Code on Social Security, 2020'),
  ('bonus_wage_limit', '21000', '2015-04-01', null, 'Payment of Bonus Act, 1965, s.2(13) as amended 2015; Code on Wages, 2019, s.26'),
  ('bonus_calc_floor', '7000', '2015-04-01', null, 'Payment of Bonus Act, 1965, s.12 as amended 2015; Code on Wages, 2019, s.26'),
  ('pt_slabs_tg', '[{"upto":15000,"tax":0},{"upto":20000,"tax":150},{"upto":null,"tax":200}]', '2013-04-01', null,
   'Telangana Tax on Professions, Trades, Callings and Employments Act, 1987, Schedule (monthly salary slabs)')
on conflict (code, effective_from) do update set value = excluded.value, effective_to = excluded.effective_to, citation = excluded.citation;

create or replace function rule_row(p_code text, p_on date) returns statutory_rule
language plpgsql stable set search_path = public as $$
declare r statutory_rule;
begin
  select * into r from statutory_rule where code = p_code and effective_from <= p_on and (effective_to is null or p_on <= effective_to)
    order by effective_from desc limit 1;
  if r.id is null then raise exception 'No % rule in force on %', p_code, p_on; end if;
  return r;
end $$;
create or replace function rule_value(p_code text, p_on date) returns jsonb
language sql stable set search_path = public as $$ select (rule_row(p_code, p_on)).value $$;

-- ---------- 2. the 50% check: employer PF inside total remuneration ----------
create or replace function wages_check(p_components jsonb) returns jsonb
language plpgsql immutable set search_path = public as $$
declare c jsonb; amt bigint; ctc bigint := 0; wages bigint := 0; outside bigint := 0;
        remuneration bigint; excluded bigint; lim bigint; excess bigint;
begin
  if p_components is null or jsonb_typeof(p_components) <> 'array' or jsonb_array_length(p_components) = 0 then
    raise exception 'Add at least one CTC component';
  end if;
  for c in select * from jsonb_array_elements(p_components) loop
    amt := round((c->>'amount')::numeric);
    if amt is null or amt < 0 then raise exception 'Amounts must be zero or more rupees'; end if;
    ctc := ctc + amt;
    if c->>'kind' in ('basic','da','retaining') then wages := wages + amt;
    elsif c->>'kind' in ('gratuity','employer_esi') then outside := outside + amt;   -- employer PF now counts (CTO §4.1.1)
    end if;
  end loop;
  remuneration := ctc - outside;
  if remuneration <= 0 then raise exception 'CTC has no pay to the employee'; end if;
  excluded := remuneration - wages;
  lim := floor(remuneration * 0.5);
  excess := greatest(0, excluded - lim);
  return jsonb_build_object(
    'ctc', ctc, 'remuneration', remuneration, 'wages', wages,
    'wages_percent', round(wages::numeric * 100 / remuneration, 1),
    'wages_share', wages::numeric / remuneration,
    'passes', excess = 0, 'deemed_extra_wages', excess,
    'rule', 'code-on-wages-50', 'rule_version', '2026-11-21', 'computed_by', 'database');
end $$;

-- ---------- 3. ctc_breakup: every line from inputs ----------
-- inputs: {"ctc":int, "basic_monthly":int (optional: default 40% of CTC, to the ₹1,000 below), "hra_pct":int=40,
--          "pf_rule":"ceiling"|"full", "variable":int=0, "joining_on":date (optional), "disability":bool=false}
create or replace function ctc_inputs(p jsonb) returns jsonb
language plpgsql immutable set search_path = public as $$
declare k text; v jsonb; ctc bigint; basic_m bigint;
begin
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'Offer inputs are missing'; end if;
  for k in select jsonb_object_keys(p) loop
    if k not in ('ctc','basic_monthly','use_company_default','hra_pct','pf_rule','variable','joining_on','disability') then
      raise exception 'Offer inputs can''t include "%". Desk sends inputs only; the database builds every amount.', k;
    end if;
  end loop;
  foreach k in array array['ctc','basic_monthly','hra_pct','variable'] loop
    v := p->k;
    if v is not null and jsonb_typeof(v) <> 'null' and (jsonb_typeof(v) <> 'number' or (v#>>'{}')::numeric <> trunc((v#>>'{}')::numeric) or (v#>>'{}')::numeric < 0) then
      raise exception '% must be a whole number of rupees, zero or more', k;
    end if;
  end loop;
  ctc := (p->>'ctc')::bigint;
  if ctc is null or ctc <= 0 then raise exception 'CTC must be more than zero'; end if;
  basic_m := coalesce((p->>'basic_monthly')::bigint, floor(ctc * 0.4 / 12 / 1000) * 1000);
  if basic_m <= 0 then raise exception 'Basic must be more than zero'; end if;
  if coalesce((p->>'hra_pct')::int, 40) > 100 then raise exception 'HRA is a percentage of Basic, from 0 to 100'; end if;
  if coalesce(p->>'pf_rule', 'ceiling') not in ('ceiling','full') then raise exception 'PF rule must be one of: ceiling, full'; end if;
  return jsonb_build_object('ctc', ctc, 'basic_monthly', basic_m, 'hra_pct', coalesce((p->>'hra_pct')::int, 40),
    'pf_rule', coalesce(p->>'pf_rule', 'ceiling'), 'variable', coalesce((p->>'variable')::bigint, 0),
    'joining_on', p->>'joining_on', 'disability', coalesce((p->>'disability')::boolean, false));
end $$;

create or replace function ctc_breakup(p_inputs jsonb, p_offer_date date default current_date) returns jsonb
language plpgsql stable set search_path = public as $$
declare i jsonb := ctc_inputs(p_inputs);
        on_d date := coalesce((i->>'joining_on')::date, p_offer_date);
        ctc bigint := (i->>'ctc')::bigint; bm bigint := (i->>'basic_monthly')::bigint; variable bigint := (i->>'variable')::bigint;
        pf_ceiling statutory_rule := rule_row('pf_wage_ceiling', on_d); esi statutory_rule := rule_row('esi_wage_limit', on_d);
        pf_wages bigint; basic bigint; hra bigint; employer_pf bigint; gratuity bigint; x bigint; gross bigint; employer_esi bigint := 0;
        special bigint; comps jsonb; chk jsonb; gm bigint; e_pf bigint; e_esi bigint; pt int := 0; s jsonb; lim bigint; warnings jsonb := '[]';
begin
  pf_wages := case when i->>'pf_rule' = 'ceiling' then least(bm, (pf_ceiling.value#>>'{}')::bigint) else bm end;
  basic := bm * 12;
  hra := round(basic * (i->>'hra_pct')::numeric / 100);
  employer_pf := round(0.12 * pf_wages * 12);
  gratuity := round(basic * 15 / 312.0);
  x := ctc - employer_pf - gratuity - variable;
  lim := (esi.value->>(case when (i->>'disability')::boolean then 'disability' else 'general' end))::bigint;
  gross := x;
  if x / 1.0325 / 12 <= lim then gross := round(x / 1.0325); employer_esi := x - gross; end if;   -- CTO §4.1.4
  special := gross - basic - hra;
  if special < 0 then raise exception 'Basic and HRA come to more than the gross pay. Lower Basic or HRA.'; end if;
  comps := jsonb_build_array(
    jsonb_build_object('name','Basic + DA','kind','basic','amount',basic),
    jsonb_build_object('name','HRA','kind','hra','amount',hra),
    jsonb_build_object('name','Special allowance','kind','special','amount',special));
  if variable > 0 then comps := comps || jsonb_build_object('name','Variable pay (at target)','kind','variable','amount',variable); end if;
  comps := comps || jsonb_build_object('name','Employer PF','kind','employer_pf','amount',employer_pf);
  if employer_esi > 0 then comps := comps || jsonb_build_object('name','Employer ESI','kind','employer_esi','amount',employer_esi); end if;
  comps := comps || jsonb_build_object('name','Gratuity','kind','gratuity','amount',gratuity);
  chk := wages_check(comps);
  if (chk->>'ctc')::bigint <> ctc then raise exception 'Internal error: the lines don''t add up to the CTC'; end if;
  gm := round(gross / 12.0);
  e_pf := round(0.12 * pf_wages);
  e_esi := case when employer_esi > 0 then round(gm * 0.0075) else 0 end;
  for s in select * from jsonb_array_elements(rule_value('pt_slabs_tg', on_d)) loop
    if s->'upto' = 'null'::jsonb or gm <= (s->>'upto')::bigint then pt := (s->>'tax')::int; exit; end if;
  end loop;
  if bm <= (rule_value('bonus_wage_limit', on_d)#>>'{}')::bigint then
    warnings := warnings || to_jsonb('Statutory bonus applies (wages of ₹21,000 a month or less): part C must carry at least 8.33%. Not added yet, awaiting legal review.'::text);
  end if;
  return jsonb_build_object('inputs', i, 'rules_date', on_d, 'components', comps, 'check', chk, 'gross', gross,
    'monthly', jsonb_build_object('gross', gm, 'employee_pf', e_pf, 'employee_esi', e_esi, 'professional_tax', pt, 'take_home', gm - e_pf - e_esi - pt),
    'pf_citation', 'PF: 12% × min(PF wages, ₹25,000) — Code on Social Security, 2020; EPF Scheme; S.O. 5109(E), 17 Sep 2026. Awaiting legal review.',
    'rules', jsonb_build_array(
      jsonb_build_object('code', pf_ceiling.code, 'value', pf_ceiling.value, 'citation', pf_ceiling.citation, 'status', pf_ceiling.status),
      jsonb_build_object('code', esi.code, 'value', esi.value, 'citation', esi.citation, 'status', esi.status)),
    'warnings', warnings, 'computed_by', 'database');
end $$;

-- ---------- 4. Fix the structure ----------
create or replace function ctc_fix(p_inputs jsonb, p_offer_date date default current_date) returns jsonb
language plpgsql stable set search_path = public as $$
declare i jsonb := ctc_inputs(p_inputs); b bigint := floor((i->>'basic_monthly')::bigint / 1000.0) * 1000; r jsonb; n int := 0;
begin
  loop
    begin
      r := ctc_breakup(i || jsonb_build_object('basic_monthly', b), p_offer_date);
    exception when others then
      if sqlerrm like 'Basic and HRA%' then
        raise exception 'This CTC can''t reach 51%% wages with these inputs. Lower HRA or variable pay.';
      end if;
      raise;
    end;
    if (r->'check'->>'wages_share')::numeric >= 0.51 then
      return r || jsonb_build_object('fixed_from', (i->>'basic_monthly')::bigint);
    end if;
    b := b + 1000; n := n + 1;
    if n > 5000 then raise exception 'This CTC can''t reach 51%% wages with these inputs. Lower HRA or variable pay.'; end if;
  end loop;
end $$;

-- ---------- offers keep their inputs; the database builds the lines ----------
alter table offer add column if not exists inputs jsonb;
create or replace function offer_compute_check() returns trigger language plpgsql as $$
declare chk jsonb; b jsonb;
begin
  if new.inputs is not null then
    b := ctc_breakup(new.inputs, coalesce(new.created_at::date, current_date));
    new.inputs := b->'inputs';
    new.components := b->'components';       -- whatever amounts a client sent are ignored
  end if;
  chk := wages_check(new.components);
  new.wages_check := chk;
  new.ctc := (chk->>'ctc')::int;
  return new;
end $$;
drop trigger if exists offer_compute_check on offer;
create trigger offer_compute_check before insert or update of components, ctc, wages_check, inputs on offer
  for each row execute function offer_compute_check();

-- The demo's Kiran draft (seed) moves to inputs, so it shows the new figures (CTO §3 table).
update offer set inputs = '{"ctc":1200000,"basic_monthly":35000,"hra_pct":40,"pf_rule":"ceiling","variable":0}'
  where inputs is null and status in ('draft','in_review')
    and components = '[{"name":"Basic + DA","kind":"basic","amount":420000},{"name":"HRA","kind":"hra","amount":210000},{"name":"Special allowance","kind":"special","amount":510000},{"name":"Employer PF","kind":"employer_pf","amount":60000}]'::jsonb;
-- Recompute every other offer once under the new rule.
update offer set components = components where inputs is null;

-- ---------- Desk sends inputs only ----------
drop function if exists desk_save_offer(uuid, jsonb, int, jsonb, date);
create or replace function desk_save_offer(p_application uuid, p_inputs jsonb, p_fix boolean default false)
returns jsonb language plpgsql set search_path = public as $$
declare me member := current_member(); oid uuid; b jsonb; app application;
begin
  select * into app from application where id = p_application;
  if app.id is null or app.company_id <> me.company_id then raise exception 'That candidate isn''t in your workspace'; end if;
  b := case when p_fix then ctc_fix(p_inputs) else ctc_breakup(p_inputs) end;   -- raises on any amount or unknown key
  select id into oid from offer where application_id = p_application and status in ('draft','in_review') limit 1;
  if oid is null then
    insert into offer(company_id, application_id, inputs, components, ctc, joining_on)
      values (me.company_id, p_application, b->'inputs', b->'components', (b->'check'->>'ctc')::int, (b->'inputs'->>'joining_on')::date)
      returning id into oid;
  else
    update offer set inputs = b->'inputs', joining_on = coalesce((b->'inputs'->>'joining_on')::date, joining_on) where id = oid;
  end if;
  perform desk_log(case when p_fix then 'offer_fixed' else 'offer_drafted' end, 'offer', oid,
    jsonb_build_object('passes', b->'check'->'passes', 'wages_percent', b->'check'->'wages_percent', 'inputs', b->'inputs'));
  return jsonb_build_object('offer_id', oid, 'ctc', (b->'check'->>'ctc')::int, 'check', b->'check', 'components', b->'components',
    'monthly', b->'monthly', 'warnings', b->'warnings', 'pf_citation', b->'pf_citation', 'fixed_from', b->'fixed_from', 'inputs', b->'inputs');
end $$;
revoke all on function desk_save_offer(uuid, jsonb, boolean) from public, anon;
grant execute on function desk_save_offer(uuid, jsonb, boolean) to authenticated;
revoke all on function ctc_breakup(jsonb, date) from public, anon;
grant execute on function ctc_breakup(jsonb, date) to authenticated;
revoke all on function ctc_fix(jsonb, date) from public, anon;
grant execute on function ctc_fix(jsonb, date) to authenticated;
