-- FA-014: live CV screening for real companies. Switched on per company by Clearstage only (one real company until
-- FA-015), files only in the company's own folder, every CV deletable from the app (file first, then the record).
-- All people and files here are fictional.
\set ON_ERROR_STOP on
reset role;
create temp table cv(k text primary key, v text); grant select, insert on cv to authenticated;
insert into cv values ('A', (select id::text from company where name = 'Rycruit')), ('B', (select id::text from company where name = 'Other Co')),
  ('S', (select id::text from company where is_sample limit 1));
insert into auth.users values ('dddddddd-0000-4000-8000-0000000000ad', 'cv.platform@test.in') on conflict do nothing;
insert into platform_admin(user_id) values ('dddddddd-0000-4000-8000-0000000000ad') on conflict do nothing;
update company set cv_live = false where not is_sample;

-- ---------- 1. off by default: nothing can be uploaded or queued ----------
set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000001';
reset request.jwt.claim.session_id;
do $$ declare a text := (select v from cv where k = 'A'); r jsonb; rid uuid; req uuid; begin
  if cv_screening_enabled() then raise exception 'FAILED: screening on before Clearstage switched it on'; end if;
  begin insert into storage.objects(bucket_id, name, owner) values ('cvs', a || '/early.pdf', auth.uid()); raise exception 'FAILED: CV stored while switched off';
  exception when others then if sqlerrm like 'FAILED%' then raise; end if; end;
  begin update company set cv_live = true where id = a::uuid; raise exception 'FAILED: a client switched CV screening on';
  exception when others then if sqlerrm like 'FAILED%' then raise; end if; end;
  begin perform set_cv_live(a::uuid, true); raise exception 'FAILED: a client used set_cv_live';
  exception when others then if sqlerrm <> 'Only Clearstage can switch live CV screening' then raise exception 'FAILED: set_cv_live as client: %', sqlerrm; end if; end;
  -- a role with confirmed requirements, and a fictional candidate added with consent
  insert into role(company_id, title, city, status, approved_by) values (a::uuid, 'Support Engineer (cv_live test)', 'Pune', 'open', (current_member()).id) returning id into rid;
  req := (desk_draft_requirements(rid, '[{"id":"m1","label":"Customer support","terms":["support","helpdesk"]},{"id":"m2","label":"SQL","terms":["SQL"]},{"id":"m3","label":"Ticketing tools","terms":["Zendesk","Freshdesk","Jira"]}]'::jsonb,
          '[]'::jsonb, '[]'::jsonb, 1, 4)->>'requirement_id')::uuid;
  perform desk_confirm_requirements(req);
  if not exists (select 1 from jsonb_array_elements(cv_upload_roles()) x where x->>'role_id' = rid::text and x->>'requirement_id' = req::text) then
    raise exception 'FAILED: cv_upload_roles misses the confirmed role: %', cv_upload_roles(); end if;
  r := desk_add_candidate('Tara Fictional', rid, null, null, true);
  insert into cv values ('role', rid::text), ('req', req::text), ('app', r->>'application_id');
  begin perform desk_enqueue_cv((r->>'application_id')::uuid, req, a || '/t1.pdf', 't1.pdf', repeat('b', 64)); raise exception 'FAILED: queued while switched off';
  exception when others then if sqlerrm <> 'Live CV screening isn''t switched on for your company yet' then raise exception 'FAILED: enqueue off: %', sqlerrm; end if; end;
end $$;

-- ---------- 2. the platform admin switches it on for one real company only ----------
set request.jwt.claim.sub = 'dddddddd-0000-4000-8000-0000000000ad';
do $$ declare a uuid := (select v::uuid from cv where k = 'A'); b uuid := (select v::uuid from cv where k = 'B'); s uuid := (select v::uuid from cv where k = 'S'); begin
  if not is_platform_admin() then raise exception 'FAILED: test platform admin not set up'; end if;
  perform set_cv_live(a, true);
  if not (select (c->>'cv_live')::boolean from jsonb_array_elements(platform_companies()) c where c->>'id' = a::text) then raise exception 'FAILED: platform_companies misses cv_live'; end if;
  begin perform set_cv_live(b, true); raise exception 'FAILED: a second real company switched on before FA-015';
  exception when others then if sqlerrm not like 'Live CV screening is already on for Rycruit.%' then raise exception 'FAILED: cap message: %', sqlerrm; end if; end;
  if s is not null then
    begin perform set_cv_live(s, true); raise exception 'FAILED: sample company switched to real CVs';
    exception when others then if sqlerrm <> 'The sample company only uses the fictional CVs' then raise exception 'FAILED: sample: %', sqlerrm; end if; end;
  end if;
end $$;
reset role;
do $$ begin
  if not exists (select 1 from audit_event where action = 'cv_live_set' and company_id = (select v::uuid from cv where k = 'A') and (detail->>'to')::boolean) then raise exception 'FAILED: switch not audited'; end if;
  if (select cv_live from company where name = 'Other Co') then raise exception 'FAILED: Other Co switched on'; end if;
end $$;

-- ---------- 3. upload, queue, result card, delete ----------
set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000001';
do $$ declare a text := (select v from cv where k = 'A'); b text := (select v from cv where k = 'B'); app uuid := (select v::uuid from cv where k = 'app');
  req uuid := (select v::uuid from cv where k = 'req'); r jsonb; fid uuid; n int; res jsonb; begin
  if not cv_screening_enabled() or not (desk_ai_context()->>'cv_live')::boolean then raise exception 'FAILED: screening not on after the switch'; end if;
  insert into storage.objects(bucket_id, name, owner) values ('cvs', a || '/t1.pdf', auth.uid());
  begin insert into storage.objects(bucket_id, name, owner) values ('cvs', b || '/t1.pdf', auth.uid()); raise exception 'FAILED: stored in another company''s folder';
  exception when others then if sqlerrm like 'FAILED%' then raise; end if; end;
  begin perform desk_enqueue_cv(app, req, b || '/t1.pdf', 't1.pdf', repeat('b', 64)); raise exception 'FAILED: queued a path in another folder';
  exception when others then if sqlerrm <> 'CV files must be in your company''s folder' then raise exception 'FAILED: path: %', sqlerrm; end if; end;
  r := desk_enqueue_cv(app, req, a || '/t1.pdf', 't1.pdf', repeat('b', 64));
  fid := (r->>'cv_file_id')::uuid; insert into cv values ('fid', fid::text);
  if (r->>'job_id') is null then raise exception 'FAILED: no job: %', r; end if;
  res := desk_cv_result(fid);
  if res->>'name' <> 'Tara Fictional' or res->>'status' <> 'queued' or res->'requirements'->'must' is null then raise exception 'FAILED: result card: %', res; end if;
  if not exists (select 1 from jsonb_array_elements(company_cvs()) x where x->>'cv_file_id' = fid::text) then raise exception 'FAILED: company_cvs misses it'; end if;
  -- delete: refused while the file is still stored; works once the file is gone
  begin perform desk_delete_cv(fid); raise exception 'FAILED: record deleted while the file is kept';
  exception when others then if sqlerrm <> 'Remove the file first, then delete the record' then raise exception 'FAILED: delete order: %', sqlerrm; end if; end;
  delete from storage.objects where bucket_id = 'cvs' and name = a || '/t1.pdf'; get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAILED: the uploader can''t remove the CV file'; end if;
  r := desk_delete_cv(fid);
  if not (r->>'deleted')::boolean or exists (select 1 from cv_file where id = fid) or exists (select 1 from cv_job where cv_file_id = fid) then raise exception 'FAILED: CV rows left: %', r; end if;
  if not exists (select 1 from person p join application x on x.person_id = p.id where x.id = app) then raise exception 'FAILED: deleting a CV removed the candidate'; end if;
  -- an orphan upload (no record) can be removed by its uploader
  insert into storage.objects(bucket_id, name, owner) values ('cvs', a || '/orphan.pdf', auth.uid());
  delete from storage.objects where bucket_id = 'cvs' and name = a || '/orphan.pdf'; get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAILED: orphan upload can''t be removed'; end if;
end $$;
reset role;
do $$ begin
  if not exists (select 1 from audit_event where action = 'cv_deleted' and subject_id = (select v::uuid from cv where k = 'app')) then raise exception 'FAILED: CV delete not audited'; end if;
  if exists (select 1 from audit_event where action = 'cv_deleted' and detail::text like '%Tara%') then raise exception 'FAILED: audit holds a name'; end if;
end $$;

-- ---------- 4. a Recruiter can't delete a CV of a joiner or employee (019) ----------
do $$ declare a uuid := (select v::uuid from cv where k = 'A'); pid uuid; aid uuid; fid uuid; begin
  insert into person(company_id, full_name, status) values (a, 'Joiner Fictional', 'employee') returning id into pid;
  insert into application(company_id, role_id, person_id) values (a, (select v::uuid from cv where k = 'role'), pid) returning id into aid;
  insert into cv_file(company_id, application_id, storage_path, file_name, sha256) values (a, aid, a::text || '/joiner.pdf', 'joiner.pdf', repeat('c', 64)) returning id into fid;
  insert into cv values ('joiner_cv', fid::text);
end $$;
insert into auth.users values ('dddddddd-0000-4000-8000-000000000002', 'cv.recruiter@test.in') on conflict do nothing;
insert into member(company_id, user_id, full_name, email) values ((select v::uuid from cv where k = 'A'), 'dddddddd-0000-4000-8000-000000000002', 'Rekha Fictional', 'cv.recruiter@test.in') on conflict do nothing;
delete from member_role where member_id = (select id from member where user_id = 'dddddddd-0000-4000-8000-000000000002');
insert into member_role(member_id, company_id, role) select id, company_id, 'recruiter' from member where user_id = 'dddddddd-0000-4000-8000-000000000002';
insert into cv values ('recruiter_user', 'dddddddd-0000-4000-8000-000000000002');
select set_config('request.jwt.claim.sub', coalesce((select v from cv where k = 'recruiter_user'), ''), false);
set role authenticated;
do $$ begin
  if not hire_only((select v::uuid from cv where k = 'A')) then raise exception 'FAILED: fixture is not a Recruiter-only member'; end if;
  begin perform desk_delete_cv((select v::uuid from cv where k = 'joiner_cv')); raise exception 'FAILED: Recruiter deleted an employee''s CV';
  exception when others then if sqlerrm <> 'That CV isn''t in your workspace' then raise exception 'FAILED: recruiter delete: %', sqlerrm; end if; end;
end $$;
reset role;
delete from member_role where member_id = (select id from member where user_id = 'dddddddd-0000-4000-8000-000000000002');
delete from member where user_id = 'dddddddd-0000-4000-8000-000000000002';
update company set cv_live = false where not is_sample;
select 'LIVE CV SCREENING (FA-014) CHECKS PASSED';
