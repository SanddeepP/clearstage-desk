-- CTO ruling 23 Nov §2 + §3 tests 2–3: empty workspace by default; the sample company only on platform-admin approval.
-- Runs after isolation.sql. Sample company = the seed company (Acme Fintech, 012 marks it is_sample).
\set ON_ERROR_STOP on
reset role;
create temp table sa(k text primary key, v text); grant select on sa to authenticated;
insert into sa values ('S', (select id::text from company where is_sample)), ('B', (select id::text from company where name = 'Other Co')),
  ('A', (select id::text from company where name = 'Rycruit'));
do $$ begin
  if (select count(*) from company where is_sample) <> 1 then raise exception 'FAILED: expected exactly one sample company'; end if;
  if (select count(*) from person where company_id = (select v::uuid from sa where k = 'S')) = 0 then raise exception 'FAILED: sample company has no people to protect'; end if;
end $$;

-- counts every row a caller can see in a company, across all company tables
create or replace function pg_temp.visible_in(p_company uuid) returns bigint language plpgsql as $$
declare t record; n bigint; total bigint := 0; begin
  for t in select c.relname from pg_class c join pg_namespace s on s.oid = c.relnamespace where s.nspname = 'public' and c.relkind = 'r'
           and exists (select 1 from information_schema.columns k where k.table_schema = 'public' and k.table_name = c.relname and k.column_name = 'company_id') loop
    execute format('select count(*) from public.%I where company_id = $1', t.relname) into n using p_company; total := total + n;
  end loop;
  return total;
end $$;

set role authenticated;
-- 1. B without access sees nothing of the sample company
set request.jwt.claim.sub = 'bbbbbbbb-0000-4000-8000-000000000001';
do $$ begin
  if pg_temp.visible_in((select v::uuid from sa where k = 'S')) <> 0 then raise exception 'FAILED: B sees sample rows without access'; end if;
  if (select count(*) from jsonb_array_elements(my_workspaces()) w where (w->>'is_sample')::boolean) <> 0 then raise exception 'FAILED: sample in B''s switcher'; end if;
  if (select count(*) from company where is_sample) <> 0 then raise exception 'FAILED: B sees the sample company row'; end if;
end $$;
-- 2. Neither B nor a client admin (A's owner) can grant; nobody can load sample data into their own company
do $$ begin perform grant_sample_access('other@test.in'); raise exception 'SHOULD HAVE FAILED';
exception when others then if sqlerrm like 'SHOULD%' then raise; end if; raise notice 'B grant refused: %', sqlerrm; end $$;
set request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000001';
do $$ begin perform grant_sample_access('other@test.in'); raise exception 'SHOULD HAVE FAILED';
exception when others then if sqlerrm like 'SHOULD%' then raise; end if; raise notice 'client admin grant refused: %', sqlerrm; end $$;
do $$ begin perform desk_load_sample_data(); raise exception 'SHOULD HAVE FAILED';
exception when insufficient_privilege then raise notice 'client sample load refused'; end $$;
do $$ begin if is_platform_admin() then raise exception 'FAILED: client admin is a platform admin'; end if; end $$;
-- the platform_admin table can't be read or written by clients
do $$ begin perform 1 from platform_admin; raise exception 'SHOULD HAVE FAILED';
exception when insufficient_privilege then raise notice 'platform_admin hidden'; end $$;
do $$ begin insert into platform_admin values ('aaaaaaaa-0000-4000-8000-000000000001'); raise exception 'SHOULD HAVE FAILED';
exception when insufficient_privilege then raise notice 'platform_admin write refused'; end $$;

-- 3. The platform admin (filled by hand, here by the owner) grants B
reset role;
insert into auth.users values ('cccccccc-0000-4000-8000-0000000000ad', 'clearstage-admin@test.in') on conflict do nothing;
insert into platform_admin values ('cccccccc-0000-4000-8000-0000000000ad') on conflict do nothing;
set role authenticated;
set request.jwt.claim.sub = 'cccccccc-0000-4000-8000-0000000000ad';
do $$ begin if not is_platform_admin() then raise exception 'FAILED: platform admin not recognised'; end if;
  if not (grant_sample_access('Other@Test.in')->>'granted')::boolean then raise exception 'FAILED: grant'; end if; end $$;
do $$ begin perform grant_sample_access('nobody@test.in'); raise exception 'SHOULD HAVE FAILED';
exception when others then if sqlerrm like 'SHOULD%' then raise; end if; raise notice 'unknown email refused: %', sqlerrm; end $$;

-- 4. B now sees its own company and the sample company, and still nothing of A's
set request.jwt.claim.sub = 'bbbbbbbb-0000-4000-8000-000000000001';
do $$ declare ws jsonb := my_workspaces(); begin
  if pg_temp.visible_in((select v::uuid from sa where k = 'S')) = 0 then raise exception 'FAILED: granted B sees no sample rows'; end if;
  if pg_temp.visible_in((select v::uuid from sa where k = 'A')) <> 0 then raise exception 'FAILED: sample access exposed company A'; end if;
  if jsonb_array_length(ws) <> 2 or not (ws->1->>'is_sample')::boolean or (ws->0->>'is_sample')::boolean then raise exception 'FAILED: switcher should be [own, sample]: %', ws; end if;
  if (current_member()).company_id::text <> (select v from sa where k = 'B') then raise exception 'FAILED: Desk tools would act in the sample company'; end if;
  if (select count(*) from company) <> 2 then raise exception 'FAILED: B sees % companies', (select count(*) from company); end if;
end $$;
-- B can't see who has access
do $$ begin perform sample_access_list(); raise exception 'SHOULD HAVE FAILED';
exception when others then if sqlerrm like 'SHOULD%' then raise; end if; raise notice 'client can''t list sample access: %', sqlerrm; end $$;
-- The founder's list shows B, granted by the founder
set request.jwt.claim.sub = 'cccccccc-0000-4000-8000-0000000000ad';
do $$ declare l jsonb := sample_access_list(); begin
  if not exists (select 1 from jsonb_array_elements(l) e where e->>'email' = 'other@test.in' and e->>'granted_by' = 'clearstage-admin@test.in') then raise exception 'FAILED: access list: %', l; end if; end $$;
set request.jwt.claim.sub = 'bbbbbbbb-0000-4000-8000-000000000001';
-- B can't grant others, even with sample access
do $$ begin perform grant_sample_access('junior@test.in'); raise exception 'SHOULD HAVE FAILED';
exception when others then if sqlerrm like 'SHOULD%' then raise; end if; raise notice 'granted user can''t grant: %', sqlerrm; end $$;

-- 5. Revoke: gone at the next load
set request.jwt.claim.sub = 'cccccccc-0000-4000-8000-0000000000ad';
do $$ begin if not (revoke_sample_access('other@test.in')->>'revoked')::boolean then raise exception 'FAILED: revoke'; end if; end $$;
set request.jwt.claim.sub = 'bbbbbbbb-0000-4000-8000-000000000001';
do $$ begin
  if pg_temp.visible_in((select v::uuid from sa where k = 'S')) <> 0 then raise exception 'FAILED: B still sees sample rows after revoke'; end if;
  if jsonb_array_length(my_workspaces()) <> 1 then raise exception 'FAILED: switcher after revoke'; end if;
end $$;
set request.jwt.claim.sub = 'cccccccc-0000-4000-8000-0000000000ad';
do $$ begin
  if exists (select 1 from jsonb_array_elements(sample_access_list()) e where e->>'email' = 'other@test.in') then raise exception 'FAILED: revoked user still listed'; end if;
end $$;
reset role;
do $$ begin if (select count(*) from audit_event where action in ('sample_access_granted', 'sample_access_revoked')) < 2 then raise exception 'FAILED: grant/revoke not audited'; end if; end $$;

-- 6. AI live (013): key context, replay only for the sample company, alerts only for Clearstage
set role authenticated;
set request.jwt.claim.sub = 'bbbbbbbb-0000-4000-8000-000000000001';
do $$ declare c jsonb := desk_ai_context(); begin
  if (c->>'is_sample')::boolean or c->>'company_id' <> (select v from sa where k = 'B') then raise exception 'FAILED: AI context for B: %', c; end if;
  if desk_replay_save('who is shortlisted', 'real company answer') then raise exception 'FAILED: a real company stored a replay'; end if;
  if desk_replay_get('who is shortlisted') is not null then raise exception 'FAILED: a real company got a replay'; end if;
  if not raise_platform_alert('ai_credit_exhausted', '{"function":"desk"}') then raise exception 'FAILED: alert not raised'; end if;
  if raise_platform_alert('ai_credit_exhausted', '{"function":"desk"}') then raise exception 'FAILED: alert not deduped'; end if;
end $$;
do $$ begin perform platform_alerts(5); raise exception 'SHOULD HAVE FAILED';
exception when others then if sqlerrm like 'SHOULD%' then raise; end if; raise notice 'client can''t read alerts: %', sqlerrm; end $$;
do $$ begin perform raise_platform_alert('anything', '{}'); raise exception 'SHOULD HAVE FAILED';
exception when others then if sqlerrm like 'SHOULD%' then raise; end if; raise notice 'unknown alert refused'; end $$;
set request.jwt.claim.sub = 'cccccccc-0000-4000-8000-0000000000ad';
do $$ declare a jsonb := platform_alerts(5); begin
  if not exists (select 1 from jsonb_array_elements(a) e where e->>'kind' = 'ai_credit_exhausted' and e->>'company' = 'Other Co') then raise exception 'FAILED: founder can''t see the credit alert: %', a; end if;
end $$;

-- 7. Founder QA (23 Nov): the platform admin with their own company grants themselves access → switcher shows both
reset role;
insert into company(id, name, city, country, state_region, timezone) values ('cccccccc-0000-4000-8000-00000000c0c0', 'Founder Co (fictional)', 'Hyderabad', 'IN', 'IN-TG', 'Asia/Kolkata') on conflict do nothing;
insert into member(company_id, user_id, full_name, email, app_role) select 'cccccccc-0000-4000-8000-00000000c0c0', 'cccccccc-0000-4000-8000-0000000000ad', 'Founder', 'clearstage-admin@test.in', 'owner'
  where not exists (select 1 from member where user_id = 'cccccccc-0000-4000-8000-0000000000ad' and company_id = 'cccccccc-0000-4000-8000-00000000c0c0');
set role authenticated;
set request.jwt.claim.sub = 'cccccccc-0000-4000-8000-0000000000ad';
do $$ declare ws jsonb; begin
  if jsonb_array_length(my_workspaces()) <> 1 then raise exception 'FAILED: founder before grant: %', my_workspaces(); end if;
  perform grant_sample_access('clearstage-admin@test.in');
  ws := my_workspaces();
  if jsonb_array_length(ws) <> 2 or (ws->0->>'is_sample')::boolean or not (ws->1->>'is_sample')::boolean then raise exception 'FAILED: founder switcher should be [own, sample]: %', ws; end if;
  if (current_member()).company_id <> 'cccccccc-0000-4000-8000-00000000c0c0' then raise exception 'FAILED: founder Desk tools would act in the sample company'; end if;
  if (select count(*) from person where company_id = (select v::uuid from sa where k = 'S')) = 0 then raise exception 'FAILED: founder sees no sample people after grant'; end if;
end $$;
-- A client never granted access (company A, "Rycruit") sees only its own company
reset role;
select set_config('request.jwt.claim.sub', (select user_id::text from member where company_id = (select id from company where name = 'Rycruit') order by created_at limit 1), false);
set role authenticated;
do $$ declare ws jsonb := my_workspaces(); begin
  if jsonb_array_length(ws) <> 1 or (ws->0->>'is_sample')::boolean then raise exception 'FAILED: client without access: %', ws; end if;
  if exists (select 1 from company where is_sample) then raise exception 'FAILED: client without access can see the sample company'; end if;
  if exists (select 1 from person where company_id = (select v::uuid from sa where k = 'S')) then raise exception 'FAILED: client without access sees sample people'; end if;
end $$;
reset role;
select 'SAMPLE ACCESS + AI LIVE CHECKS PASSED';
