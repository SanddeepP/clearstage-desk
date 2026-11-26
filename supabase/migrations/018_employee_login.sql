-- 018_employee_login.sql — the Employee login, before go-live (founder decision 26 Nov), on the CTO's design
-- (RD-CTO-Rulings-Module-Tabs-25Nov.md §3; roles spec §1–3):
-- 1. Employees are NOT members. They get their own table, employee_account (company, person, user). Every rule that
--    grants access to members stays closed to them, so they can't read candidates, salaries, offers or other people.
-- 2. Allow-list: an employee reads only their own record, through my_employee(): own profile, own approved letters,
--    own joining tasks, own change requests. Nothing else, and no Desk.
-- 3. Changes to their own details (phone, personal email, address, emergency contact) are REQUESTS. HR or the Super admin
--    approves or rejects them; nothing changes until approved. Every step is audited.
-- 4. HR or a Super admin gives an employee their login (invite_employee). They sign in with that email (claim_my_invite).
-- Re-runnable. All people in tests are fictional.

alter table person add column if not exists address text;
alter table person add column if not exists emergency_contact text;

create table if not exists employee_account (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references company(id) on delete cascade,
  person_id uuid not null unique references person(id) on delete cascade,
  email text not null,
  user_id uuid unique references auth.users(id) on delete set null,
  invited_by uuid references auth.users(id) on delete set null,
  invited_at timestamptz not null default now());
create unique index if not exists employee_account_email on employee_account(company_id, lower(email));
alter table employee_account enable row level security;
drop policy if exists employee_account_read on employee_account;
-- HR sees who has a login in their company; an employee sees only their own row
create policy employee_account_read on employee_account for select to authenticated
  using (company_id in (select my_company_ids()) or user_id = auth.uid());
revoke insert, update, delete, truncate on employee_account from anon, authenticated;

create table if not exists employee_change_request (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references company(id) on delete cascade,
  person_id uuid not null references person(id) on delete cascade,
  field text not null check (field in ('phone', 'email', 'address', 'emergency_contact')),
  old_value text, new_value text not null check (length(new_value) between 1 and 300),
  reason text check (reason is null or length(reason) <= 300),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  requested_by uuid references auth.users(id) on delete set null,
  requested_at timestamptz not null default now(),
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz, note text check (note is null or length(note) <= 300));
create index if not exists ecr_company on employee_change_request(company_id, status);
alter table employee_change_request enable row level security;
drop policy if exists ecr_read on employee_change_request;
create policy ecr_read on employee_change_request for select to authenticated using (company_id in (select my_company_ids()));
revoke insert, update, delete, truncate on employee_change_request from anon, authenticated;

create or replace function profile_field_label(p text) returns text language sql immutable as $$
  select case p when 'phone' then 'Phone' when 'email' then 'Personal email' when 'address' then 'Address' when 'emergency_contact' then 'Emergency contact' else p end
$$;
revoke all on function profile_field_label(text) from public, anon, authenticated;

-- The signed-in employee's account, if any (fresh session only)
create or replace function current_employee() returns employee_account
language sql stable security definer set search_path = public as $$
  select e.* from employee_account e where e.user_id = auth.uid() and session_fresh() limit 1
$$;
revoke all on function current_employee() from public, anon, authenticated;

/** The Employee view: the signed-in employee's own record only. */
create or replace function my_employee() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare e employee_account := current_employee(); p person; c company;
begin
  if e.id is null then return null; end if;
  select * into p from person where id = e.person_id;
  select * into c from company where id = e.company_id;
  return jsonb_build_object(
    'company', c.name, 'company_id', c.id,
    'profile', jsonb_build_object('name', p.full_name, 'email', p.email, 'phone', p.phone, 'address', p.address, 'emergency_contact', p.emergency_contact,
      'status', p.status, 'joined_on', p.joined_on, 'probation_ends_on', p.probation_ends_on,
      'title', (select r.title from application a join role r on r.id = a.role_id where a.person_id = p.id order by (a.outcome = 'hired') desc nulls last, a.created_at desc limit 1),
      'manager', (select m.full_name from member m where m.id = p.manager_id),
      'login_email', e.email),
    'letters', coalesce((select jsonb_agg(jsonb_build_object('kind', d.kind, 'approved_at', d.approved_at, 'body', d.body) order by d.approved_at desc)
      from document d where d.person_id = p.id and d.approved_at is not null), '[]'),
    'tasks', coalesce((select jsonb_agg(jsonb_build_object('title', t.title, 'kind', t.kind, 'status', t.status, 'due_at', t.due_at) order by t.due_at nulls last)
      from task t where t.subject_type = 'person' and t.subject_id = p.id and t.status <> 'cancelled'
        and t.kind in ('appointment_letter', 'it_setup', 'documents', 'day1_plan', 'buddy', 'joining_documents', 'probation_review', 'confirmation_letter')), '[]'),
    'requests', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'field', r.field, 'label', profile_field_label(r.field), 'old_value', r.old_value, 'new_value', r.new_value,
        'reason', r.reason, 'status', r.status, 'requested_at', r.requested_at, 'decided_at', r.decided_at, 'note', r.note) order by r.requested_at desc)
      from employee_change_request r where r.person_id = p.id), '[]'));
end $$;
revoke all on function my_employee() from public, anon; grant execute on function my_employee() to authenticated;

/** An employee asks for a change to their own details. Saved as a request; nothing changes until HR approves. */
create or replace function request_profile_change(p_field text, p_new_value text, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare e employee_account := current_employee(); p person; v text := btrim(coalesce(p_new_value, '')); old text; rid uuid;
begin
  if e.id is null then raise exception 'Only an employee can ask for a change to their own details'; end if;
  if p_field not in ('phone', 'email', 'address', 'emergency_contact') then raise exception 'You can ask to change your phone, personal email, address or emergency contact'; end if;
  if v = '' then raise exception 'Enter the new value'; end if;
  if length(v) > 300 or length(coalesce(p_reason, '')) > 300 then raise exception 'Keep it under 300 characters'; end if;
  if p_field = 'email' and v !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then raise exception 'Enter a valid email address'; end if;
  if p_field = 'phone' and v !~ '^\+?[0-9 ()-]{7,20}$' then raise exception 'Enter the phone number with its country code, like +91 98480 12345'; end if;
  select * into p from person where id = e.person_id;
  old := case p_field when 'phone' then p.phone when 'email' then p.email when 'address' then p.address else p.emergency_contact end;
  if old is not distinct from v then raise exception 'That''s already your %', lower(profile_field_label(p_field)); end if;
  if exists (select 1 from employee_change_request where person_id = p.id and field = p_field and status = 'pending') then
    raise exception 'You already have a request for your % waiting for HR', lower(profile_field_label(p_field)); end if;
  insert into employee_change_request(company_id, person_id, field, old_value, new_value, reason, requested_by)
    values (e.company_id, p.id, p_field, old, v, nullif(btrim(coalesce(p_reason, '')), ''), auth.uid()) returning id into rid;
  insert into audit_event(company_id, actor_kind, action, detail)
    values (e.company_id, 'human', 'profile_change_requested', jsonb_build_object('request', rid, 'person', p.id, 'field', p_field, 'from', old, 'to', v));
  return jsonb_build_object('id', rid, 'field', p_field, 'label', profile_field_label(p_field), 'old_value', old, 'new_value', v, 'status', 'pending');
end $$;
revoke all on function request_profile_change(text, text, text) from public, anon; grant execute on function request_profile_change(text, text, text) to authenticated;

/** HR or a Super admin: change requests in their own company, pending first. */
create or replace function company_change_requests() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare me member := current_member();
begin
  if me.id is null or not (has_role(me.company_id, 'hr') or has_role(me.company_id, 'super_admin')) then return '[]'::jsonb; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'person', p.full_name, 'field', r.field, 'label', profile_field_label(r.field),
      'old_value', r.old_value, 'new_value', r.new_value, 'reason', r.reason, 'status', r.status, 'requested_at', r.requested_at,
      'decided_at', r.decided_at, 'note', r.note, 'decided_by', (select m.full_name from member m where m.user_id = r.decided_by and m.company_id = r.company_id limit 1))
    order by (r.status = 'pending') desc, r.requested_at desc)
    from employee_change_request r join person p on p.id = r.person_id where r.company_id = me.company_id), '[]'::jsonb);
end $$;
revoke all on function company_change_requests() from public, anon; grant execute on function company_change_requests() to authenticated;

/** HR or a Super admin approves (applies it) or rejects (with a note). Nobody decides a request about themselves. */
create or replace function decide_profile_change(p_request uuid, p_approve boolean, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me member := current_member(); r employee_change_request;
begin
  if me.id is null then raise exception 'No workspace'; end if;
  select * into r from employee_change_request where id = p_request and company_id = me.company_id;
  if r.id is null then raise exception 'That request isn''t in your workspace'; end if;
  if not (has_role(me.company_id, 'hr') or has_role(me.company_id, 'super_admin')) then raise exception 'Only HR or a Super admin can approve changes to employee records'; end if;
  if r.requested_by = auth.uid() then raise exception 'You can''t approve your own request'; end if;
  if r.status <> 'pending' then raise exception 'That request was already %', r.status; end if;
  if not p_approve and btrim(coalesce(p_note, '')) = '' then raise exception 'Add a note saying why, so they know what to do'; end if;
  if length(coalesce(p_note, '')) > 300 then raise exception 'Keep the note under 300 characters'; end if;
  if p_approve then
    execute format('update person set %I = $1 where id = $2', r.field) using r.new_value, r.person_id;
  end if;
  update employee_change_request set status = case when p_approve then 'approved' else 'rejected' end, decided_by = auth.uid(), decided_at = now(),
    note = nullif(btrim(coalesce(p_note, '')), '') where id = r.id;
  insert into audit_event(company_id, actor_kind, action, detail)
    values (r.company_id, 'human', case when p_approve then 'profile_change_approved' else 'profile_change_rejected' end,
      jsonb_build_object('request', r.id, 'person', r.person_id, 'field', r.field, 'from', r.old_value, 'to', r.new_value, 'by', auth.uid(), 'note', p_note));
  return jsonb_build_object('id', r.id, 'status', case when p_approve then 'approved' else 'rejected' end);
end $$;
revoke all on function decide_profile_change(uuid, boolean, text) from public, anon; grant execute on function decide_profile_change(uuid, boolean, text) to authenticated;

/** HR or a Super admin: the company's employees and whether each has an Employee login. */
create or replace function company_employees() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare me member := current_member();
begin
  if me.id is null or not (has_role(me.company_id, 'hr') or has_role(me.company_id, 'super_admin')) then return '[]'::jsonb; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.full_name, 'email', p.email,
      'login', case when e.user_id is not null then 'yes' when e.id is not null then 'invited' else 'no' end, 'login_email', e.email) order by p.full_name)
    from person p left join employee_account e on e.person_id = p.id where p.company_id = me.company_id and p.status = 'employee'), '[]'::jsonb);
end $$;
revoke all on function company_employees() from public, anon; grant execute on function company_employees() to authenticated;

/** HR or a Super admin gives an employee their own login. No email is sent. */
create or replace function invite_employee(p_person uuid, p_email text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me member := current_member(); p person; e text := lower(btrim(coalesce(p_email, ''))); uid uuid; sample boolean;
begin
  if me.id is null then raise exception 'No workspace'; end if;
  select is_sample into sample from company where id = me.company_id;
  if sample then raise exception 'You can''t give logins in the sample company'; end if;
  if not (has_role(me.company_id, 'hr') or has_role(me.company_id, 'super_admin')) then raise exception 'Only HR or a Super admin can give employees a login'; end if;
  select * into p from person where id = p_person and company_id = me.company_id;
  if p.id is null then raise exception 'That person isn''t in your workspace'; end if;
  if p.status <> 'employee' then raise exception 'Only employees get an Employee login. % hasn''t joined yet', p.full_name; end if;
  if e !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then raise exception 'Enter a valid email address'; end if;
  if exists (select 1 from employee_account where person_id = p.id) then raise exception '% already has an Employee login', p.full_name; end if;
  if exists (select 1 from employee_account where lower(email) = e) then raise exception '% is already used for another Employee login', e; end if;
  select id into uid from auth.users where lower(email) = e;
  if uid is not null and exists (select 1 from member where user_id = uid) then
    raise exception '% already has a staff login. Use a different email for the Employee login', e; end if;
  insert into employee_account(company_id, person_id, email, user_id, invited_by) values (me.company_id, p.id, e, uid, auth.uid());
  insert into audit_event(company_id, actor_kind, action, detail) values (me.company_id, 'human', 'employee_login_given', jsonb_build_object('person', p.id, 'email', e, 'by', auth.uid()));
  return jsonb_build_object('person', p.id, 'name', p.full_name, 'email', e, 'pending', uid is null);
end $$;
revoke all on function invite_employee(uuid, text) from public, anon; grant execute on function invite_employee(uuid, text) to authenticated;

-- claim_my_invite (017) also links an Employee login on first sign-in. Staff invites come first; a staff member is never
-- also linked as an employee (they'd keep their staff view).
create or replace function claim_my_invite() returns uuid
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); e text; m member; ea employee_account;
begin
  if uid is null or not session_fresh() then return null; end if;
  if exists (select 1 from member mm join company c on c.id = mm.company_id where mm.user_id = uid and not c.is_sample) then return null; end if;
  if exists (select 1 from employee_account x where x.user_id = uid) then return null; end if;
  select lower(email) into e from auth.users where id = uid;
  if e is null then return null; end if;
  select mm.* into m from member mm join company c on c.id = mm.company_id
    where lower(mm.email) = e and mm.user_id is null and mm.invited_at is not null and not c.is_sample order by mm.invited_at desc limit 1;
  if m.id is not null then
    update member set user_id = uid where id = m.id;
    insert into audit_event(company_id, actor_kind, action, detail) values (m.company_id, 'human', 'invite_accepted', jsonb_build_object('member', m.id, 'email', e));
    return m.company_id;
  end if;
  if exists (select 1 from member where user_id = uid) then return null; end if;     -- sample access only: stays staff
  select * into ea from employee_account x where lower(x.email) = e and x.user_id is null order by invited_at desc limit 1;
  if ea.id is null then return null; end if;
  update employee_account set user_id = uid where id = ea.id;
  insert into audit_event(company_id, actor_kind, action, detail) values (ea.company_id, 'human', 'employee_login_accepted', jsonb_build_object('person', ea.person_id, 'email', e));
  return ea.company_id;
end $$;
revoke all on function claim_my_invite() from public, anon; grant execute on function claim_my_invite() to authenticated;

-- An employee can't turn themselves into staff by creating a workspace with the same login
create or replace function employee_no_member() returns trigger language plpgsql set search_path = public as $$
begin
  if new.user_id is not null and exists (select 1 from employee_account e where e.user_id = new.user_id) then
    raise exception 'This email has an Employee login, so it can''t also be a staff login. Use a different email.';
  end if;
  return new;
end $$;
drop trigger if exists employee_no_member on member;
create trigger employee_no_member before insert or update of user_id on member for each row execute function employee_no_member();

-- SEC-1: every table with row-level security also carries the restrictive fresh-session policy (as in 010)
do $$ declare t record; begin
  for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity loop
    execute format('drop policy if exists session_fresh on public.%I', t.relname);
    execute format('create policy session_fresh on public.%I as restrictive for all to authenticated using ((select public.session_fresh())) with check ((select public.session_fresh()))', t.relname);
  end loop;
end $$;
