-- 019_hire_scope.sql — QA-044 (S1), CTO ruling 26 Nov §1: a Recruiter is limited to Hire, in the database.
-- A member whose only role in a company is Recruiter (no Super admin, HR or Manager role alongside) gets, through a
-- RESTRICTIVE row-level security policy on every affected table:
--   * people: candidates only. Joiners and employees (status <> 'candidate') are not visible, so they are not listed,
--     can't be opened, and Desk (which reads as the asking user) can't load them as context;
--   * everything hanging off a joiner or employee: their applications, offers, interviews, feedback, screening rows,
--     letters, tasks, messages and audit entries;
--   * Onboard and Probation work wherever it sits: onboarding and probation tasks, appointment, confirmation and
--     probation letters;
--   * employee logins and change requests: nothing.
-- Roles combine: anyone who is also Super admin, HR or Manager keeps their access. The sample company (fictional data,
-- used for demos) is exempt. Writes are held to the same rule (WITH CHECK), so a Recruiter can't create or move
-- anything into Onboard or Probation either.
-- my_access_modules() tells Desk which modules the asking user may use; each Desk tool declares its module.
-- Re-runnable. All people in tests are fictional.

/** True when the signed-in user's only role in this (real) company is Recruiter. */
create or replace function hire_only(p_company uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from member m join company c on c.id = m.company_id
    where m.company_id = p_company and m.user_id = auth.uid() and not c.is_sample
      and exists (select 1 from member_role r where r.member_id = m.id and r.role = 'recruiter')
      and not exists (select 1 from member_role r where r.member_id = m.id and r.role in ('super_admin', 'hr', 'manager')))
$$;
revoke all on function hire_only(uuid) from public, anon; grant execute on function hire_only(uuid) to authenticated;

-- What counts as Hire. These read the tables directly (definer), so the policies below never recurse. Each only
-- answers for the caller's own companies: another company's id is never "Hire" (no cross-company oracle).
create or replace function hs_person(p uuid) returns boolean language sql stable security definer set search_path = public as $$
  select p is null or exists (select 1 from person x where x.id = p and x.status = 'candidate' and x.company_id in (select my_company_ids())) $$;
create or replace function hs_application(a uuid) returns boolean language sql stable security definer set search_path = public as $$
  select a is null or exists (select 1 from application x join person p on p.id = x.person_id where x.id = a and p.status = 'candidate' and x.company_id in (select my_company_ids())) $$;
create or replace function hs_offer(o uuid) returns boolean language sql stable security definer set search_path = public as $$
  select o is null or exists (select 1 from offer x where x.id = o and x.company_id in (select my_company_ids()) and hs_application(x.application_id)) $$;
create or replace function hs_interview(i uuid) returns boolean language sql stable security definer set search_path = public as $$
  select i is null or exists (select 1 from interview x where x.id = i and x.company_id in (select my_company_ids()) and hs_application(x.application_id)) $$;
create or replace function hs_cv_file(f uuid) returns boolean language sql stable security definer set search_path = public as $$
  select f is null or exists (select 1 from cv_file x where x.id = f and x.company_id in (select my_company_ids()) and hs_application(x.application_id)) $$;
/** Letters that belong to Onboard or Probation, whoever they are about. */
create or replace function hs_doc_kind(k text) returns boolean language sql immutable as $$
  select coalesce(k, '') !~ '^(appointment|confirmation|probation|extension|relieving|experience|joining)' $$;
create or replace function hs_document(d uuid) returns boolean language sql stable security definer set search_path = public as $$
  select d is null or exists (select 1 from document x where x.id = d and x.company_id in (select my_company_ids()) and hs_doc_kind(x.kind) and hs_person(x.person_id)) $$;
/** Onboarding and probation task kinds. */
create or replace function hs_task_kind(k text) returns boolean language sql immutable as $$
  select coalesce(k, '') not in ('it_setup', 'day1_plan', 'appointment_letter', 'joining_documents', 'documents', 'buddy',
    'probation_review', 'confirmation_letter', 'probation_extension') $$;
create or replace function hs_subject(st text, sid uuid) returns boolean language sql stable security definer set search_path = public as $$
  select case when st is null or sid is null then true else case st
    when 'person' then hs_person(sid)
    when 'application' then hs_application(sid)
    when 'offer' then hs_offer(sid)
    when 'document' then hs_document(sid)
    when 'interview' then hs_interview(sid)
    when 'task' then exists (select 1 from task t where t.id = sid and t.company_id in (select my_company_ids()) and hs_task_kind(t.kind) and hs_subject(t.subject_type, t.subject_id))
    when 'role' then true when 'requirement' then true when 'batch' then true when 'message' then true
    else false end end $$;
do $$ declare f text; begin
  foreach f in array array['hs_person(uuid)', 'hs_application(uuid)', 'hs_offer(uuid)', 'hs_interview(uuid)', 'hs_cv_file(uuid)', 'hs_doc_kind(text)',
                          'hs_document(uuid)', 'hs_task_kind(text)', 'hs_subject(text, uuid)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

-- The restrictive policy, one per table
do $$ declare t record; begin
  for t in select * from (values
    ('person',                  'status = ''candidate'''),
    ('application',             'hs_person(person_id)'),
    ('offer',                   'hs_application(application_id)'),
    ('interview',               'hs_application(application_id)'),
    ('feedback',                'hs_interview(interview_id)'),
    ('evidence',                'hs_application(application_id)'),
    ('score',                   'hs_application(application_id)'),
    ('shortlist_pin',           'hs_application(application_id)'),
    ('cv_file',                 'hs_application(application_id)'),
    ('cv_job',                  'hs_cv_file(cv_file_id)'),
    ('document',                'hs_doc_kind(kind) and hs_person(person_id)'),
    ('task',                    'hs_task_kind(kind) and hs_subject(subject_type, subject_id)'),
    ('message',                 'hs_person(to_person)'),
    ('audit_event',             'hs_subject(subject_type, subject_id)'),
    ('employee_account',        'false'),
    ('employee_change_request', 'false')) x(tbl, pred) loop
    execute format('drop policy if exists hire_scope on public.%I', t.tbl);
    execute format('create policy hire_scope on public.%I as restrictive for all to authenticated using (not hire_only(company_id) or (%s)) with check (not hire_only(company_id) or (%s))', t.tbl, t.pred, t.pred);
  end loop;
end $$;

/** Which modules the signed-in user may use in their current company (Desk checks each tool against this). */
create or replace function my_access_modules() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare me member := current_member(); rs text[]; sample boolean; mods text[] := '{}';
begin
  if me.id is null then return jsonb_build_object('roles', '[]'::jsonb, 'modules', '[]'::jsonb); end if;
  select is_sample into sample from company where id = me.company_id;
  select coalesce(array_agg(role), '{}') into rs from member_role where member_id = me.id;
  if sample or rs && array['super_admin', 'hr'] then
    mods := array['hire', 'onboard', 'probation', 'compliance', 'exit', 'time', 'payroll', 'performance', 'policies'];
  else
    if 'manager' = any(rs) then mods := mods || array['hire', 'onboard', 'probation', 'exit', 'time', 'payroll', 'performance', 'policies']; end if;
    if 'recruiter' = any(rs) then mods := mods || array['hire', 'policies']; end if;
  end if;
  return jsonb_build_object('roles', to_jsonb(rs), 'sample', coalesce(sample, false),
    'modules', (select coalesce(jsonb_agg(distinct m), '[]') from unnest(mods) m));
end $$;
revoke all on function my_access_modules() from public, anon; grant execute on function my_access_modules() to authenticated;

-- SEC-1: every table with row-level security also carries the restrictive fresh-session policy (as in 010)
do $$ declare t record; begin
  for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity loop
    execute format('drop policy if exists session_fresh on public.%I', t.relname);
    execute format('create policy session_fresh on public.%I as restrictive for all to authenticated using ((select public.session_fresh())) with check ((select public.session_fresh()))', t.relname);
  end loop;
end $$;
