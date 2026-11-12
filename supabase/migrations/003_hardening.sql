-- 003_hardening.sql — CTO review, 12 Nov 2026.
-- Fixes found by testing 001/002 against a local Postgres as a signed-in junior:
--   S1 any member could change roles (junior -> owner) and edit or remove other members
--   S2 any member could switch the company's team setup (turns off the lead's review queue)
--   S3 any member could write any approved_by (forge the lead's or founder's approval)
--   S4 any member could edit or delete the audit log
--   S5 task.escalation_chain / owner_id were not checked to be in the same company
--   B1 scheduler walked the whole escalation chain in 10 minutes instead of one step per cycle
--   B2 one user could create unlimited companies (sign-in then breaks: getProfile expects one)
-- Server code (service role, pg_cron) has no auth.uid() and is trusted; checks apply to signed-in users.

-- ---------- helpers ----------
create or replace function my_member(p_company uuid) returns member
language sql stable security definer set search_path = public as $$
  select * from member where company_id = p_company and user_id = auth.uid() limit 1
$$;

create or replace function is_admin(p_company uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select app_role in ('owner','lead') from member
                   where company_id = p_company and user_id = auth.uid() limit 1), false)
$$;

create or replace function can_approve(p_company uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select m.app_role in ('owner','lead','approver')
                   from member m where m.company_id = p_company and m.user_id = auth.uid() limit 1), false)
$$;

-- ---------- S1: members ----------
drop policy if exists member_company on member;
drop policy if exists member_read on member;
drop policy if exists member_admin on member;
create policy member_read  on member for select using (company_id in (select my_company_ids()));
create policy member_admin on member for all    using (is_admin(company_id)) with check (is_admin(company_id));

-- Even admins can't give themselves a different role or move their own login.
create or replace function guard_member() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;
  if old.user_id = auth.uid() and (new.app_role is distinct from old.app_role or new.user_id is distinct from old.user_id) then
    raise exception 'You can''t change your own role';
  end if;
  return new;
end $$;
drop trigger if exists guard_member on member;
create trigger guard_member before update on member for each row execute function guard_member();

-- ---------- S2: company settings ----------
drop policy if exists company_update on company;
create policy company_update on company for update using (is_admin(id)) with check (is_admin(id));

-- ---------- S3: approvals are stamped by the database, never typed by the client ----------
create or replace function stamp_approval() returns trigger
language plpgsql security definer set search_path = public as $$
declare me member;
begin
  if auth.uid() is null then return new; end if;                       -- server / WhatsApp webhook path
  if tg_op = 'UPDATE' and new.approved_by is not distinct from old.approved_by then
    new.approved_at := old.approved_at; return new;                    -- approval untouched
  end if;
  if new.approved_by is null then new.approved_at := null; return new; end if;
  me := my_member(new.company_id);
  if me.id is null or new.approved_by <> me.id then
    raise exception 'Approvals are recorded as the signed-in person only';
  end if;
  if not can_approve(new.company_id) then
    raise exception 'Your drafts go to your lead for approval';
  end if;
  new.approved_at := now();
  insert into audit_event(company_id, actor_member, actor_kind, action, subject_type, subject_id)
    values (new.company_id, me.id, 'human', 'approved', tg_table_name, new.id);
  return new;
end $$;

alter table message add column if not exists approved_at timestamptz;
do $$ declare t text; begin
  foreach t in array array['message','offer','role','document'] loop
    execute format('drop trigger if exists stamp_approval on %I', t);
    execute format('create trigger stamp_approval before insert or update on %I for each row execute function stamp_approval()', t);
  end loop;
end $$;

-- A role can't open, and an offer or document can't go out, without a recorded approval.
alter table role     drop constraint if exists role_open_needs_approval;
alter table role     add  constraint role_open_needs_approval     check (status in ('draft','awaiting_approval') or approved_by is not null);
alter table offer    drop constraint if exists offer_sent_needs_approval;
alter table offer    add  constraint offer_sent_needs_approval    check (status in ('draft','in_review') or approved_by is not null);

-- ---------- S4: audit log is append-only and written by the database ----------
drop policy if exists audit_event_company on audit_event;
drop policy if exists audit_read on audit_event;
create policy audit_read on audit_event for select using (company_id in (select my_company_ids()));
revoke insert, update, delete, truncate on audit_event from anon, authenticated;

create or replace function block_audit_change() returns trigger language plpgsql as $$
begin raise exception 'The audit log can''t be changed'; end $$;
drop trigger if exists audit_append_only on audit_event;
create trigger audit_append_only before update on audit_event for each row execute function block_audit_change();
-- Deletes stay possible for the service role only (DPDP erasure / retention jobs), never from the app.

-- ---------- S5: task people must belong to the task's company ----------
create or replace function guard_task_people() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.owner_id is not null and not exists (select 1 from member where id = new.owner_id and company_id = new.company_id) then
    raise exception 'Task owner is not in this company';
  end if;
  if exists (select 1 from unnest(coalesce(new.escalation_chain,'{}')) e
             where not exists (select 1 from member where id = e and company_id = new.company_id)) then
    raise exception 'Escalation chain has someone outside this company';
  end if;
  return new;
end $$;
drop trigger if exists guard_task_people on task;
create trigger guard_task_people before insert or update on task for each row execute function guard_task_people();

-- ---------- B1: scheduler — remind the owner first, then one escalation step per cycle ----------
create or replace function run_task_scheduler(p_now timestamptz default now())
returns table (task_id uuid, action text, to_member uuid)
language plpgsql security definer set search_path = public as $$
declare t record; cycle interval; nxt uuid;
begin
  for t in
    select * from task where status = 'open' and due_at is not null and due_at < p_now
    for update skip locked
  loop
    cycle := make_interval(secs => coalesce((t.reminder_rule->>'every_hours')::numeric, 24) * 3600);
    continue when t.last_reminded_at is not null and p_now - t.last_reminded_at < cycle;   -- one step per cycle

    if (t.last_reminded_at is not null or t.owner_id is null)
       and t.escalated_level < coalesce(array_length(t.escalation_chain, 1), 0) then
      nxt := t.escalation_chain[t.escalated_level + 1];
      update task set escalated_level = escalated_level + 1, last_reminded_at = p_now where id = t.id;
      insert into message(company_id, channel, to_member, body, status)
        values (t.company_id, 'whatsapp', nxt, 'Escalation: ' || t.title, 'queued');
      insert into audit_event(company_id, actor_kind, action, subject_type, subject_id, detail)
        values (t.company_id, 'system', 'task_escalated', 'task', t.id, jsonb_build_object('to', nxt, 'level', t.escalated_level + 1));
      task_id := t.id; action := 'escalated'; to_member := nxt; return next;
    elsif t.owner_id is not null then
      update task set last_reminded_at = p_now where id = t.id;
      insert into message(company_id, channel, to_member, body, status)
        values (t.company_id, 'whatsapp', t.owner_id, 'Reminder: ' || t.title, 'queued');
      insert into audit_event(company_id, actor_kind, action, subject_type, subject_id)
        values (t.company_id, 'system', 'task_reminded', 'task', t.id);
      task_id := t.id; action := 'reminded'; to_member := t.owner_id; return next;
    end if;
  end loop;
end $$;
revoke all on function run_task_scheduler(timestamptz) from public, anon, authenticated;

-- ---------- B2: one company per sign-up, bounded inputs ----------
create or replace function create_company_for_me(p_company text, p_city text, p_full_name text, p_phone text, p_setup text)
returns uuid language plpgsql security definer set search_path = public as $$
declare cid uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  if exists (select 1 from member where user_id = auth.uid()) then raise exception 'You already have a workspace'; end if;
  if length(coalesce(trim(p_company),'')) not between 2 and 120 or length(coalesce(trim(p_full_name),'')) not between 1 and 80
     or length(coalesce(p_city,'')) > 80 then raise exception 'Check the company and name fields'; end if;
  if p_phone is not null and p_phone !~ '^\+[1-9][0-9]{7,14}$' then raise exception 'Phone must look like +919876543210'; end if;
  insert into company(name, city, team_setup) values (trim(p_company), p_city, coalesce(p_setup,'solo')) returning id into cid;
  insert into member(company_id, user_id, full_name, email, phone, app_role, whatsapp_opt_in)
    values (cid, auth.uid(), trim(p_full_name), (select email from auth.users where id = auth.uid()), p_phone,
            case when p_setup = 'lead_juniors' then 'lead' else 'owner' end, p_phone is not null);
  insert into audit_event(company_id, actor_kind, action, detail) values (cid, 'human', 'company_created', jsonb_build_object('setup', p_setup));
  return cid;
end $$;
revoke all on function create_company_for_me(text,text,text,text,text) from public, anon;
grant execute on function create_company_for_me(text,text,text,text,text) to authenticated;
