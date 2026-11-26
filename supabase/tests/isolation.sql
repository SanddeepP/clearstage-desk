-- G1 hard gate (CTO go-live sizing 23 Nov, item 1): cross-company isolation, K1/K3.
-- Company B ("Other Co") attacks company A ("Rycruit") through every table, every function a signed-in user can call,
-- and the "cvs" storage bucket. Passes only if:
--   * B sees none of A's rows, and can't update, delete, insert into or move rows into A (every company table);
--   * B can't change the shared rule tables;
--   * B can't read, add or change files in A's storage folder;
--   * no function returns anything of A's when called by B with A's ids;
--   * a fingerprint of ALL of A's data (every table + A's storage objects) is identical before and after;
--   * every company table and every callable function is covered: a new one fails this test until it's added here.
-- Runs last, on the database the other tests have filled. Needs company "Rycruit" (desk_tools.sql) and "Other Co".
\set ON_ERROR_STOP on
reset role;
create temp table iso(k text primary key, v text);
create temp table a_secret(v text);
create temp table iso_result(name text, outcome text, detail text);
grant select on iso, a_secret to authenticated; grant insert, select on iso_result to authenticated;

insert into iso values ('A', (select id::text from company where name = 'Rycruit')), ('B', (select id::text from company where name = 'Other Co'));
do $$ begin if (select count(*) from iso where v is not null) <> 2 then raise exception 'FAILED: companies A and B not found'; end if; end $$;

-- Give A a row in the tables the other tests leave empty, and one stored CV, so every table is really tested.
do $$ declare a uuid := (select v::uuid from iso where k = 'A'); mid uuid; cid uuid; begin
  select id into mid from member where company_id = a order by created_at limit 1;
  insert into desk_conversation(company_id, member_id) values (a, mid) returning id into cid;
  insert into desk_message(conversation_id, company_id, role, content) values (cid, a, 'user', '{"text":"ISO-SECRET-A question"}');
  insert into evidence_cache(company_id, cache_key, evidence, roles, model, prompt_version) values (a, 'ISO-SECRET-A-key', '[]', '[]', 'iso', 'iso') on conflict do nothing;
  insert into template(company_id, kind, name, body) values (a, 'offer', 'ISO-SECRET-A template', 'ISO-SECRET-A body');
  insert into storage.objects(bucket_id, name) values ('cvs', a::text || '/ISO-SECRET-A.pdf') on conflict do nothing;
  insert into desk_replay(company_id, prompt_key, reply) values (a, 'iso-secret-a', 'ISO-SECRET-A replay') on conflict do nothing;
  insert into company_module(company_id, module, state) values (a, 'onboard', 'live') on conflict do nothing;
  insert into module_interest(company_id, user_id, module, note) select a, user_id, 'exit', 'ISO-SECRET-A interest' from member where company_id = a limit 1 on conflict do nothing;
  insert into platform_alert(kind, company_id, detail) values ('ai_error', a, '{"note":"ISO-SECRET-A alert"}');
  -- 018: an Employee login (not yet claimed) and a change request in A
  insert into employee_account(company_id, person_id, email) select a, id, 'iso-secret-a-employee@test.in' from person where company_id = a order by created_at desc limit 1 on conflict do nothing;
  insert into employee_change_request(company_id, person_id, field, old_value, new_value, reason)
    select a, person_id, 'address', null, 'ISO-SECRET-A address', 'ISO-SECRET-A reason' from employee_account where company_id = a limit 1;
end $$;
insert into a_secret values ('ISO-SECRET-A');

-- Every company table must hold at least one row of A's
do $$ declare t record; n bigint; a uuid := (select v::uuid from iso where k = 'A'); begin
  for t in select c.relname from pg_class c join pg_namespace s on s.oid = c.relnamespace
           where s.nspname = 'public' and c.relkind = 'r' and exists (select 1 from information_schema.columns k where k.table_schema = 'public' and k.table_name = c.relname and k.column_name = 'company_id') loop
    execute format('select count(*) from public.%I where company_id = $1', t.relname) into n using a;
    if n = 0 then raise exception 'FAILED: coverage: company A has no row in %, so its isolation is untested', t.relname; end if;
  end loop;
end $$;

-- Every id of A's (uuid "id" columns), for the leak check
do $$ declare t record; a uuid := (select v::uuid from iso where k = 'A'); begin
  for t in select k.table_name from information_schema.columns k where k.table_schema = 'public' and k.column_name = 'id' and k.data_type = 'uuid'
           and exists (select 1 from information_schema.columns c where c.table_schema = 'public' and c.table_name = k.table_name and c.column_name = 'company_id') loop
    execute format('insert into a_secret select id::text from public.%I where company_id = $1', t.table_name) using a;
  end loop;
  insert into a_secret values (a::text);
end $$;

-- Handy A ids for calling functions
insert into iso
select 'role', (select id::text from role where company_id = a.v::uuid order by created_at limit 1) from iso a where a.k = 'A' union all
select 'app', (select sp.application_id::text from shortlist_pin sp where sp.company_id = a.v::uuid limit 1) from iso a where a.k = 'A' union all
select 'person', (select id::text from person where company_id = a.v::uuid limit 1) from iso a where a.k = 'A' union all
select 'task', (select id::text from task where company_id = a.v::uuid limit 1) from iso a where a.k = 'A' union all
select 'offer', (select id::text from offer where company_id = a.v::uuid limit 1) from iso a where a.k = 'A' union all
select 'doc', (select id::text from document where company_id = a.v::uuid limit 1) from iso a where a.k = 'A' union all
select 'req', (select id::text from requirement where company_id = a.v::uuid limit 1) from iso a where a.k = 'A' union all
select 'job', (select id::text from cv_job where company_id = a.v::uuid limit 1) from iso a where a.k = 'A' union all
select 'event', (select id::text from audit_event where company_id = a.v::uuid order by id limit 1) from iso a where a.k = 'A' union all
select 'member', (select id::text from member where company_id = a.v::uuid order by created_at desc limit 1) from iso a where a.k = 'A' union all
select 'ecr', (select id::text from employee_change_request where company_id = a.v::uuid limit 1) from iso a where a.k = 'A' union all
select 'interview', (select id::text from interview where company_id = a.v::uuid limit 1) from iso a where a.k = 'A' union all
select 'cv_file', (select id::text from cv_file where company_id = a.v::uuid limit 1) from iso a where a.k = 'A';
do $$ begin if exists (select 1 from iso where v is null) then raise exception 'FAILED: missing A id: %', (select string_agg(k, ',') from iso where v is null); end if; end $$;

-- Fingerprint of all of A's data
create or replace function pg_temp.a_fingerprint() returns text language plpgsql as $$
declare t record; h text := ''; x text; a uuid := (select v::uuid from iso where k = 'A'); begin
  for t in select c.relname from pg_class c join pg_namespace s on s.oid = c.relnamespace
           where s.nspname = 'public' and c.relkind = 'r' and exists (select 1 from information_schema.columns k where k.table_schema = 'public' and k.table_name = c.relname and k.column_name = 'company_id') order by 1 loop
    execute format('select md5(coalesce(string_agg(to_jsonb(x)::text, ''|'' order by to_jsonb(x)::text), '''')) from public.%I x where company_id = $1', t.relname) into x using a;
    h := h || t.relname || ':' || x || ';';
  end loop;
  select h || 'company:' || md5(to_jsonb(c)::text) into h from company c where id = a;
  select h || 'storage:' || md5(coalesce(string_agg(name, '|' order by name), '')) into h from storage.objects where bucket_id = 'cvs' and name like a::text || '/%';
  return md5(h);
end $$;
insert into iso values ('fp_before', pg_temp.a_fingerprint());

-- One copy of an A row per table, for the "insert into A" attempt
create temp table a_row(t text primary key, j jsonb);
grant select on a_row to authenticated;
do $$ declare t record; j jsonb; a uuid := (select v::uuid from iso where k = 'A'); begin
  for t in select c.relname from pg_class c join pg_namespace s on s.oid = c.relnamespace
           where s.nspname = 'public' and c.relkind = 'r' and exists (select 1 from information_schema.columns k where k.table_schema = 'public' and k.table_name = c.relname and k.column_name = 'company_id') loop
    execute format('select to_jsonb(x) from public.%I x where company_id = $1 limit 1', t.relname) into j using a;
    insert into a_row values (t.relname, j);
  end loop;
end $$;

-- ===================== as company B =====================
set role authenticated;
set request.jwt.claim.sub = 'bbbbbbbb-0000-4000-8000-000000000001';
reset request.jwt.claim.session_id;
do $$ begin if (current_member()).company_id::text <> (select v from iso where k = 'B') then raise exception 'FAILED: not acting as company B'; end if; end $$;
-- B gets its own data, so its tools have something to work on
reset role; select 'B sample data (fixture)', desk_load_sample_data() is not null;
update company set cv_live = true where id = (select v::uuid from iso where k = 'B');   -- B may store CVs in its own folder (021)
set role authenticated;

-- 1. Tables: read, update, delete, insert, and moving B's own rows into A
do $$ declare t record; n bigint; a uuid := (select v::uuid from iso where k = 'A'); b uuid := (select v::uuid from iso where k = 'B');
  cols text; j jsonb; state text; begin
  for t in select c.relname from pg_class c join pg_namespace s on s.oid = c.relnamespace
           where s.nspname = 'public' and c.relkind = 'r' and exists (select 1 from information_schema.columns k where k.table_schema = 'public' and k.table_name = c.relname and k.column_name = 'company_id') order by 1 loop
    execute format('select count(*) from public.%I where company_id = $1', t.relname) into n using a;
    if n <> 0 then raise exception 'FAILED: B can read % row(s) of A in %', n, t.relname; end if;
    execute format('select count(*) from public.%I where company_id is distinct from $1 and company_id is not null', t.relname) into n using b;
    if n <> 0 then raise exception 'FAILED: B can read % row(s) of another company in %', n, t.relname; end if;
    begin execute format('update public.%I set company_id = company_id where company_id = $1', t.relname) using a; get diagnostics n = row_count;
      if n <> 0 then raise exception 'FAILED: B updated % row(s) of A in %', n, t.relname; end if;
    exception when insufficient_privilege then null; end;
    begin execute format('delete from public.%I where company_id = $1', t.relname) using a; get diagnostics n = row_count;
      if n <> 0 then raise exception 'FAILED: B deleted % row(s) of A in %', n, t.relname; end if;
    exception when insufficient_privilege then null; end;
    -- insert a copy of A's row (A's company_id, new key): must be refused by privilege or row-level security
    select j2.j into j from a_row j2 where j2.t = t.relname;
    -- drop approval stamps, so the approval guard doesn't refuse it first and the security rule itself is what's tested
    select coalesce(jsonb_object_agg(e.key, e.value), '{}') into j from jsonb_each(j) e where e.key not like 'approved%';
    select string_agg(quote_ident(column_name), ',') into cols from information_schema.columns
      where table_schema = 'public' and table_name = t.relname and column_default is null and column_name <> 'id' and is_generated = 'NEVER';
    begin
      execute format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I, $1)', t.relname, cols, cols, t.relname) using j;
      raise exception 'FAILED: B inserted a row into A''s % ', t.relname;
    exception when insufficient_privilege then insert into iso_result values ('insert ' || t.relname, 'refused (42501)', sqlerrm);
      when others then if sqlerrm like 'FAILED%' then raise; end if;
        get stacked diagnostics state = returned_sqlstate;
        insert into iso_result values ('insert ' || t.relname, 'refused (' || state || ')', sqlerrm);
    end;
    -- move B's own rows into A
    begin execute format('update public.%I set company_id = $1 where company_id = $2', t.relname) using a, b; get diagnostics n = row_count;
      if n <> 0 then raise exception 'FAILED: B moved % of its own row(s) into A in %', n, t.relname; end if;
    exception when insufficient_privilege then null;
      when others then if sqlerrm like 'FAILED%' then raise; end if; end;
  end loop;
end $$;
-- inserts must be refused by security, not by luck (a missing column or a constraint)
do $$ begin if exists (select 1 from iso_result where name like 'insert %' and outcome not like '%42501%') then
  raise exception 'FAILED: an insert into A was refused for a reason other than security: %', (select string_agg(name || ' → ' || detail, '; ') from iso_result where name like 'insert %' and outcome not like '%42501%'); end if; end $$;

-- 2. company, rule, statutory_rule (no company_id column)
do $$ declare n bigint; a uuid := (select v::uuid from iso where k = 'A'); begin
  select count(*) into n from company where id <> (select v::uuid from iso where k = 'B'); if n <> 0 then raise exception 'FAILED: B sees % other companies', n; end if;
  begin update company set name = name where id = a; get diagnostics n = row_count; if n <> 0 then raise exception 'FAILED: B updated company A'; end if;
  exception when insufficient_privilege then null; end;
  begin delete from company where id = a; get diagnostics n = row_count; if n <> 0 then raise exception 'FAILED: B deleted company A'; end if;
  exception when insufficient_privilege then null; end;
  begin update rule set citation = citation; get diagnostics n = row_count; if n <> 0 then raise exception 'FAILED: B changed the rule table'; end if;
  exception when insufficient_privilege then null; end;
  begin insert into rule(id, citation) values ('iso-rule', 'x'); raise exception 'FAILED: B added a rule';
  exception when insufficient_privilege then null; when others then if sqlerrm like 'FAILED%' then raise; end if; end;
  begin update statutory_rule set value = value; get diagnostics n = row_count; if n <> 0 then raise exception 'FAILED: B changed statutory rules'; end if;
  exception when insufficient_privilege then null; end;
  -- 015: the country and holiday reference tables are read-only; A's region fields can't be changed by B
  begin update country set currency = currency; get diagnostics n = row_count; if n <> 0 then raise exception 'FAILED: B changed the country table'; end if;
  exception when insufficient_privilege then null; end;
  begin insert into holiday(calendar, day, name) values ('IN-TG', '2026-12-31', 'planted'); raise exception 'FAILED: B added a holiday';
  exception when insufficient_privilege then null; when others then if sqlerrm like 'FAILED%' then raise; end if; end;
  begin update company set timezone = 'Europe/London' where id = a; get diagnostics n = row_count; if n <> 0 then raise exception 'FAILED: B changed A''s time zone'; end if;
  exception when insufficient_privilege then null; end;
  begin update company set data_region = 'eu-west-2' where id = (select v::uuid from iso where k = 'B'); raise exception 'FAILED: a client changed its data region';
  exception when others then if sqlerrm like 'FAILED%' then raise; end if; end;
end $$;

-- 3. Storage: A's folder is invisible and read-only to B; B's own folder works
do $$ declare n bigint; a text := (select v from iso where k = 'A'); b text := (select v from iso where k = 'B'); begin
  select count(*) into n from storage.objects where bucket_id = 'cvs' and name like a || '/%'; if n <> 0 then raise exception 'FAILED: B can list % of A''s files', n; end if;
  begin insert into storage.objects(bucket_id, name) values ('cvs', a || '/planted-by-b.pdf'); raise exception 'FAILED: B wrote into A''s folder';
  exception when insufficient_privilege then null; when others then if sqlerrm like 'FAILED%' then raise; end if; end;
  begin insert into storage.objects(bucket_id, name) values ('cvs', b || '/../' || a || '/escape.pdf'); raise exception 'FAILED: B escaped its folder with ..';
  exception when insufficient_privilege then null; when others then if sqlerrm like 'FAILED%' then raise; end if; end;
  begin update storage.objects set name = name where bucket_id = 'cvs' and name like a || '/%'; get diagnostics n = row_count; if n <> 0 then raise exception 'FAILED: B changed A''s files'; end if;
  exception when insufficient_privilege then null; end;
  begin delete from storage.objects where bucket_id = 'cvs' and name like a || '/%'; get diagnostics n = row_count; if n <> 0 then raise exception 'FAILED: B deleted A''s files'; end if;
  exception when insufficient_privilege then null; end;
  insert into storage.objects(bucket_id, name, owner) values ('cvs', b || '/own-file.pdf', auth.uid());
  select count(*) into n from storage.objects where bucket_id = 'cvs' and name = b || '/own-file.pdf'; if n <> 1 then raise exception 'FAILED: B can''t use its own folder'; end if;
end $$;

-- 4. Every function a signed-in user can call, with A's ids
create temp table calls(name text, call text);
insert into calls values
  ('desk_add_candidate',            $c$desk_add_candidate('Iso Probe', '{role}', null, null, true)$c$),
  ('desk_approve',                  $c$desk_approve('offer', '{offer}')$c$),
  ('desk_approve',                  $c$desk_approve('document', '{doc}')$c$),
  ('desk_bulk_reject',              $c$desk_bulk_reject('{role}', array['{person}']::uuid[], 'Skills not a match for this role', null)$c$),
  ('desk_cached_evidence',          $c$desk_cached_evidence('ISO-SECRET-A-key')$c$),
  ('desk_chase_owner',              $c$desk_chase_owner('{task}')$c$),
  ('desk_claim_cv_job',             $c$desk_claim_cv_job({job})$c$),
  ('desk_claim_cv_job',             $c$desk_claim_cv_job(null)$c$),
  ('desk_confirm_requirements',     $c$desk_confirm_requirements('{req}')$c$),
  ('desk_create_role',              $c$desk_create_role('Iso Role', 'Pune', 1, null, null, null, null, null)$c$),
  ('desk_discard',                  $c$desk_discard('offer', '{offer}', 'not_needed')$c$),
  ('draft_reject_reasons',          $c$draft_reject_reasons()$c$),
  ('desk_draft_requirements',       $c$desk_draft_requirements('{role}', '[]', '[]', '[]', 1, 3, null)$c$),
  ('desk_enqueue_cv',               $c$desk_enqueue_cv('{app}', '{req}', '{A}/ISO-SECRET-A.pdf', 'x.pdf', repeat('a', 64))$c$),
  ('desk_explain_fit',              $c$desk_explain_fit('{app}')$c$),
  ('desk_fail_cv_job',              $c$desk_fail_cv_job({job}, 'iso')$c$),
  ('desk_find_people',              $c$desk_find_people('a')$c$),
  ('desk_get_brief',                $c$desk_get_brief()$c$),
  ('desk_get_shortlist',            $c$desk_get_shortlist('{role}', null, 50)$c$),
  ('desk_live_enabled',             $c$desk_live_enabled()$c$),
  ('desk_log',                      $c$desk_log('iso_probe', 'offer', '{offer}', '{}', null)$c$),
  ('desk_mark_contacted',           $c$desk_mark_contacted('{app}', 'contacted')$c$),
  ('desk_mark_offer_accepted',      $c$desk_mark_offer_accepted('{offer}')$c$),
  ('desk_month_tokens',             $c$desk_month_tokens()$c$),
  ('desk_move_candidate',           $c$desk_move_candidate('{app}', 'Screened')$c$),
  ('desk_override_stars',           $c$desk_override_stars('{app}', 5, 'Strong in interview or call')$c$),
  ('desk_pin',                      $c$desk_pin('{role}', '{app}', true)$c$),
  ('desk_prepare_reject_batch',     $c$desk_prepare_reject_batch('{role}')$c$),
  ('desk_record_feedback',          $c$desk_record_feedback('{app}', '{}', 'hire', 'iso')$c$),
  ('desk_request_approval',         $c$desk_request_approval('offer', '{offer}', 'iso')$c$),
  ('desk_save_document',            $c$desk_save_document('{person}', 'appointment_letter', 'iso', 'iso', null)$c$),
  ('desk_save_offer',               $c$desk_save_offer('{app}', '{"ctc":1200000}', false)$c$),
  ('desk_save_screening',           $c$desk_save_screening({job}, true, 'iso', '[]', 'iso', 'iso', 'iso')$c$),
  ('desk_show_joiners',             $c$desk_show_joiners()$c$),
  ('desk_show_pipeline',            $c$desk_show_pipeline('Backend Developer')$c$),
  ('desk_start_probation_review',   $c$desk_start_probation_review('{person}')$c$),
  ('desk_undo',                     $c$desk_undo({event})$c$),
  ('can_approve',                   $c$can_approve('{A}')$c$),
  ('is_admin',                      $c$is_admin('{A}')$c$),
  ('my_member',                     $c$my_member('{A}')$c$),
  ('my_company_ids',                $c$(select array_agg(c) from my_company_ids() c)$c$),
  ('current_member',                $c$current_member()$c$),
  ('create_company_for_me',         $c$create_company_for_me('Iso Second Co', 'Pune', 'Iso', null, 'solo', 'IN', 'IN-MH', 'Asia/Kolkata')$c$),
  ('session_fresh',                 $c$session_fresh()$c$),
  ('session_status',                $c$session_status()$c$),
  ('grant_sample_access',           $c$grant_sample_access('founder@test.in')$c$),
  ('revoke_sample_access',          $c$revoke_sample_access('founder@test.in')$c$),
  ('is_platform_admin',             $c$is_platform_admin()$c$),
  ('my_workspaces',                 $c$my_workspaces()$c$),
  ('desk_replay_save',              $c$desk_replay_save('probe', 'probe reply')$c$),
  ('desk_replay_get',               $c$desk_replay_get('probe')$c$),
  ('raise_platform_alert',          $c$raise_platform_alert('ai_error', '{"probe":true}')$c$),
  ('platform_alerts',               $c$platform_alerts(5)$c$),
  ('desk_ai_context',               $c$desk_ai_context()$c$),
  ('sample_access_list',            $c$sample_access_list()$c$),
  ('save_manual_offer',             $c$save_manual_offer('{app}', '[{"name":"Base salary","amount":45000}]', 45000)$c$),
  ('my_company_region',             $c$my_company_region()$c$),
  ('my_modules',                    $c$my_modules()$c$),
  ('set_module_state',              $c$set_module_state('{A}', 'onboard', 'soon')$c$),
  ('platform_companies',            $c$platform_companies()$c$),
  ('register_module_interest',      $c$register_module_interest('payroll', 'probe', 'page')$c$),
  ('my_module_interest',            $c$my_module_interest()$c$),
  ('module_interest_counts',        $c$module_interest_counts()$c$),
  ('update_my_name',                $c$update_my_name('Iso Probe')$c$),
  ('has_role',                      $c$has_role('{A}', 'super_admin')$c$),
  ('my_roles',                      $c$my_roles()$c$),
  ('company_people',                $c$company_people()$c$),
  ('set_member_roles',              $c$set_member_roles('{member}', array['super_admin'], true, true)$c$),
  ('invite_member',                 $c$invite_member('Iso Probe', 'iso-probe@test.in', array['recruiter'], false, false)$c$),
  ('claim_my_invite',               $c$claim_my_invite()$c$),
  ('my_employee',                   $c$my_employee()$c$),
  ('request_profile_change',        $c$request_profile_change('address', 'Probe street', null)$c$),
  ('company_change_requests',       $c$company_change_requests()$c$),
  ('decide_profile_change',         $c$decide_profile_change('{ecr}', true, null)$c$),
  ('company_employees',             $c$company_employees()$c$),
  ('invite_employee',               $c$invite_employee('{person}', 'iso-probe-employee@test.in')$c$),
  ('hire_only',                     $c$hire_only('{A}')$c$),
  ('my_access_modules',             $c$my_access_modules()$c$),
  ('hs_person',                     $c$hs_person('{person}')$c$),
  ('hs_application',                $c$hs_application('{app}')$c$),
  ('hs_offer',                      $c$hs_offer('{offer}')$c$),
  ('hs_interview',                  $c$hs_interview('{interview}')$c$),
  ('hs_cv_file',                    $c$hs_cv_file('{cv_file}')$c$),
  ('hs_doc_kind',                   $c$hs_doc_kind('appointment_letter')$c$),
  ('hs_document',                   $c$hs_document('{doc}')$c$),
  ('hs_task_kind',                  $c$hs_task_kind('it_setup')$c$),
  ('hs_subject',                    $c$hs_subject('person', '{person}')$c$),
  ('set_cv_live',                   $c$set_cv_live('{A}', false)$c$),
  ('cv_screening_enabled',          $c$cv_screening_enabled()$c$),
  ('cv_folder_open',                $c$cv_folder_open('{A}')$c$),
  ('cv_file_paths',                 $c$(select string_agg(p, ',') from cv_file_paths() p)$c$),
  ('cv_upload_roles',               $c$cv_upload_roles()$c$),
  ('desk_cv_result',                $c$desk_cv_result('{cv_file}')$c$),
  ('company_cvs',                   $c$company_cvs(200)$c$),
  ('desk_delete_cv',                $c$desk_delete_cv('{cv_file}')$c$);
grant select on calls to authenticated;
-- Pure functions: no table access, nothing of a company's to leak
create temp table pure(name text primary key);
insert into pure values ('ctc_breakup'), ('ctc_fix'), ('ctc_inputs'), ('wages_check'), ('rule_row'), ('rule_value'), ('has_statutory_pack'), ('module_keys'), ('module_default'), ('module_states_allowed'), ('looks_like_name'), ('desk_blocked_text'),
  ('cv_live_cap'), ('scr_item_exists'), ('scr_norm'), ('scr_quote_names_term'), ('scr_weights_ok'), ('scr_years');
grant select on pure to authenticated;

do $$ declare c record; sql text; res text; k record; state text; begin
  for c in select * from calls loop
    sql := c.call;
    for k in select * from iso loop sql := replace(sql, '{' || k.k || '}', coalesce(k.v, 'null')); end loop;
    begin
      execute 'select (' || sql || ')::text' into res;
      if exists (select 1 from a_secret s where position(s.v in coalesce(res, '')) > 0) then
        raise exception 'FAILED: % returned A''s data to B: %', c.name, left(res, 300);
      end if;
      insert into iso_result values (c.name, 'returned nothing of A''s', left(coalesce(res, 'null'), 120));
    exception when others then
      if sqlerrm like 'FAILED%' then raise; end if;
      get stacked diagnostics state = returned_sqlstate;
      insert into iso_result values (c.name, 'refused', sqlerrm);
    end;
  end loop;
end $$;
-- B must not be able to approve or own anything in A
do $$ begin
  if (select r.detail from iso_result r where r.name = 'can_approve') not in ('false', 'null') then raise exception 'FAILED: can_approve(A) is true for B'; end if;
  if (select r.detail from iso_result r where r.name = 'is_admin') not in ('false', 'null') then raise exception 'FAILED: is_admin(A) is true for B'; end if;
  if (select r.detail from iso_result r where r.name = 'has_role') not in ('false', 'null') then raise exception 'FAILED: has_role(A, super_admin) is true for B'; end if;
  if (select r.detail from iso_result r where r.name = 'cv_folder_open') <> 'false' then raise exception 'FAILED: cv_folder_open(A) is true for B'; end if;
  if (select r.detail from iso_result r where r.name = 'desk_cv_result') <> 'null' then raise exception 'FAILED: desk_cv_result(A''s CV) returned something to B'; end if;
end $$;
reset role;

-- 5. Coverage: every function a signed-in user can execute is either called above or known to be pure
do $$ declare missing text; begin
  select string_agg(distinct p.proname, ', ') into missing
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prokind = 'f' and p.prorettype <> 'trigger'::regtype
    and has_function_privilege('authenticated', p.oid, 'execute')
    and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')          -- extension functions (pgcrypto)
    and p.proname not in (select name from calls) and p.proname not in (select name from pure);
  if missing is not null then raise exception 'FAILED: coverage: functions not in the isolation test: %', missing; end if;
end $$;

-- 6. No row of B's points at a row of A's through any foreign key (a cross-company link is a leak waiting to happen)
do $$ declare f record; n bigint; a uuid := (select v::uuid from iso where k = 'A'); b uuid := (select v::uuid from iso where k = 'B'); begin
  for f in select cl.relname as src, att.attname as col, rcl.relname as dst, ratt.attname as dcol
           from pg_constraint con join pg_class cl on cl.oid = con.conrelid join pg_class rcl on rcl.oid = con.confrelid
           join pg_namespace ns on ns.oid = cl.relnamespace
           join pg_attribute att on att.attrelid = con.conrelid and att.attnum = con.conkey[1]
           join pg_attribute ratt on ratt.attrelid = con.confrelid and ratt.attnum = con.confkey[1]
           where con.contype = 'f' and ns.nspname = 'public' and array_length(con.conkey, 1) = 1
             and exists (select 1 from information_schema.columns k where k.table_schema = 'public' and k.table_name = cl.relname and k.column_name = 'company_id')
             and exists (select 1 from information_schema.columns k where k.table_schema = 'public' and k.table_name = rcl.relname and k.column_name = 'company_id') loop
    execute format('select count(*) from public.%I s join public.%I d on d.%I = s.%I where s.company_id = $1 and d.company_id = $2', f.src, f.dst, f.dcol, f.col) into n using b, a;
    if n <> 0 then raise exception 'FAILED: % row(s) of B''s %.% point at A''s %', n, f.src, f.col, f.dst; end if;
  end loop;
end $$;

-- 7. Nothing of A's changed
do $$ begin if pg_temp.a_fingerprint() <> (select v from iso where k = 'fp_before') then
  raise exception 'FAILED: company A''s data changed while B was probing it'; end if; end $$;

select name, outcome, left(detail, 110) from iso_result where name not like 'insert %' order by name;
select 'inserts into A refused', count(*) from iso_result where name like 'insert %';
select 'ISOLATION CHECKS PASSED (' || (select count(*) from iso_result) || ' probes)';
