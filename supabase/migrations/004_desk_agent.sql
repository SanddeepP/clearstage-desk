-- 004_desk_agent.sql — the engine behind the Desk agent (Dev Brief §4).
-- Every state change Desk makes goes through one of these functions. They run as the signed-in user
-- (security invoker), so row-level security and the 003 guards apply to everything the agent does.
-- The AI model can call the desk_* tool functions; it can never call desk_approve / desk_discard:
-- the Edge Function only calls those when a person taps Approve or Reject.
-- Re-runnable.

-- ---------- extra columns ----------
alter table role     add column if not exists experience text;
alter table role     add column if not exists start_within_days int;
alter table role     add column if not exists description text;
alter table document add column if not exists batch_id uuid;
alter table document add column if not exists summary text;

-- ---------- conversations and AI usage ----------
create table if not exists desk_conversation (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references company(id) on delete cascade,
  member_id uuid not null references member(id) on delete cascade,
  channel text not null default 'app' check (channel in ('app','whatsapp','phone')),
  created_at timestamptz not null default now()
);
create table if not exists desk_message (
  id bigint generated always as identity primary key,
  conversation_id uuid not null references desk_conversation(id) on delete cascade,
  company_id uuid not null references company(id) on delete cascade,
  role text not null check (role in ('user','assistant')),
  content jsonb not null,                 -- Anthropic-style content blocks (text, tool_use, tool_result)
  created_at timestamptz not null default now()
);
create index if not exists desk_message_conv on desk_message (conversation_id, id);
create table if not exists ai_usage (
  id bigint generated always as identity primary key,
  company_id uuid not null references company(id) on delete cascade,
  conversation_id uuid references desk_conversation(id) on delete set null,
  model text not null,
  purpose text not null,                  -- 'route' (tool choice) or 'draft'
  tools text[] not null default '{}',     -- tools called from this model response
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists ai_usage_company_month on ai_usage (company_id, created_at);

-- ---------- helpers ----------
create or replace function current_member() returns member
language sql stable security definer set search_path = public as $$
  select * from member where user_id = auth.uid() limit 1
$$;

-- Audit writes go through here (003 made audit_event insert-only for the database).
create or replace function desk_log(p_action text, p_subject_type text, p_subject_id uuid, p_detail jsonb default null, p_undo_minutes int default null)
returns bigint language plpgsql security definer set search_path = public as $$
declare me member := current_member(); eid bigint;
begin
  if me.id is null then raise exception 'Sign in first'; end if;
  insert into audit_event(company_id, actor_member, actor_kind, action, subject_type, subject_id, detail, undo_until)
    values (me.company_id, me.id, 'desk', p_action, p_subject_type, p_subject_id, p_detail,
            case when p_undo_minutes is null then null else now() + make_interval(mins => p_undo_minutes) end)
    returning id into eid;
  return eid;
end $$;

-- Protected traits never go into rejection text (Dev Brief §5.4).
create or replace function desk_blocked_text(p text) returns boolean language sql immutable as $$
  select coalesce(p, '') ~* '\m(age|aged|old|young|gender|female|male|woman|women|married|marital|unmarried|single|pregnan\w*|religio\w*|hindu|muslim|christian|sikh|caste|dalit|kids?|children|maternity)\M'
$$;

-- RLS for the new tables
alter table desk_conversation enable row level security;
alter table desk_message enable row level security;
alter table ai_usage enable row level security;
drop policy if exists desk_conv_own on desk_conversation;
create policy desk_conv_own on desk_conversation for all
  using (member_id = (current_member()).id) with check (member_id = (current_member()).id and company_id = (current_member()).company_id);
drop policy if exists desk_msg_own on desk_message;
create policy desk_msg_own on desk_message for all
  using (conversation_id in (select id from desk_conversation where member_id = (current_member()).id))
  with check (conversation_id in (select id from desk_conversation where member_id = (current_member()).id));
drop policy if exists ai_usage_read on ai_usage;
drop policy if exists ai_usage_insert on ai_usage;
create policy ai_usage_read on ai_usage for select using (company_id in (select my_company_ids()));
create policy ai_usage_insert on ai_usage for insert with check (company_id = (current_member()).company_id);
revoke update, delete on ai_usage from anon, authenticated;

create or replace function desk_month_tokens() returns bigint language sql stable as $$
  select coalesce(sum(input_tokens + output_tokens), 0) from ai_usage
  where company_id = (current_member()).company_id and created_at >= date_trunc('month', now())
$$;

-- ---------- read tools ----------
create or replace function desk_get_brief() returns jsonb language sql stable as $$
  select jsonb_build_object(
    'open', count(*) filter (where t.bucket <> 'Done'),
    'late', count(*) filter (where t.bucket = 'Late'),
    'items', coalesce(jsonb_agg(jsonb_build_object('task_id', t.id, 'title', t.title, 'why', t.why, 'bucket', t.bucket, 'kind', t.kind,
                 'owner', m.full_name, 'subject_type', t.subject_type, 'subject_id', t.subject_id)
               order by case t.bucket when 'Late' then 0 when 'Today' then 1 else 2 end, t.due_at) filter (where t.bucket <> 'Done'), '[]'::jsonb))
  from today_tasks t left join member m on m.id = t.owner_id
  where t.company_id = (current_member()).company_id
$$;

create or replace function desk_find_people(p_query text) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(x), '[]'::jsonb) from (
    select jsonb_build_object('kind', 'person', 'id', p.id, 'name', p.full_name, 'status', p.status,
             'detail', coalesce((select r.title || ' · ' || a.stage from application a join role r on r.id = a.role_id
                                 where a.person_id = p.id order by a.created_at desc limit 1), p.status)) x
    from person p where p.company_id = (current_member()).company_id and p.full_name ilike '%' || p_query || '%'
    union all
    select jsonb_build_object('kind', 'member', 'id', m.id, 'name', m.full_name, 'detail', coalesce(m.title, m.app_role))
    from member m where m.company_id = (current_member()).company_id and m.full_name ilike '%' || p_query || '%'
    limit 10) s
$$;

create or replace function desk_show_pipeline(p_role text default null) returns jsonb language plpgsql stable as $$
declare r role; n int;
begin
  select count(*) into n from role where company_id = (current_member()).company_id and status in ('open','awaiting_approval')
    and (p_role is null or title ilike '%' || p_role || '%');
  if n = 0 then return jsonb_build_object('error', 'No open role matches that name'); end if;
  if n > 1 and p_role is not null then
    return jsonb_build_object('ambiguous', (select jsonb_agg(jsonb_build_object('id', id, 'title', title, 'city', city))
      from role where company_id = (current_member()).company_id and status in ('open','awaiting_approval') and title ilike '%' || p_role || '%'));
  end if;
  select * into r from role where company_id = (current_member()).company_id and status in ('open','awaiting_approval')
    and (p_role is null or title ilike '%' || p_role || '%') order by created_at limit 1;
  return jsonb_build_object('role_id', r.id, 'title', r.title, 'city', r.city, 'status', r.status,
    'days_open', (current_date - r.created_at::date),
    'stages', (select jsonb_agg(jsonb_build_object('stage', s, 'count',
                  (select count(*) from application a where a.role_id = r.id and a.stage = s and a.outcome is null),
                  'people', (select coalesce(jsonb_agg(jsonb_build_object('person_id', p.id, 'application_id', a.id, 'name', p.full_name) order by a.created_at), '[]'::jsonb)
                             from application a join person p on p.id = a.person_id where a.role_id = r.id and a.stage = s and a.outcome is null)))
               from unnest(r.stages) s));
end $$;

create or replace function desk_show_joiners() returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('person_id', p.id, 'name', p.full_name, 'joined_on', p.joined_on, 'probation_ends_on', p.probation_ends_on,
           'tasks', (select coalesce(jsonb_agg(jsonb_build_object('task_id', t.id, 'title', t.title, 'kind', t.kind, 'status', t.status,
                       'due_at', t.due_at, 'owner', m.full_name) order by t.due_at), '[]'::jsonb)
                     from task t left join member m on m.id = t.owner_id where t.subject_type = 'person' and t.subject_id = p.id))
         order by p.joined_on), '[]'::jsonb)
  from person p
  where p.company_id = (current_member()).company_id and p.status = 'employee'
    and (p.joined_on >= current_date - 14 or p.probation_ends_on between current_date and current_date + 45)
$$;

-- ---------- approvals (people only, never the model) ----------
create or replace function desk_request_approval(p_subject_type text, p_subject_id uuid, p_summary text)
returns jsonb language plpgsql as $$
declare me member := current_member(); co company; approver member; tid uuid;
begin
  if me.id is null then raise exception 'Sign in first'; end if;
  select * into co from company where id = me.company_id;
  if p_subject_type = 'offer' and not exists (select 1 from offer where id = p_subject_id and (wages_check->>'passes')::boolean) then
    raise exception 'This offer fails the wages check. Fix the structure before asking for approval';
  end if;
  -- Solo: the person who drafted it approves (if allowed). Lead + juniors: the lead/owner approves.
  if co.team_setup = 'solo' and me.app_role in ('owner','lead','approver') then approver := me;
  else select * into approver from member where company_id = me.company_id and app_role in ('lead','owner') and id <> me.id
       order by case app_role when 'lead' then 0 else 1 end limit 1;
       if approver.id is null then approver := me; end if;
  end if;
  insert into task(company_id, title, kind, owner_id, subject_type, subject_id, due_at, why)
    values (me.company_id, 'Approve ' || p_summary, 'approval', approver.id, p_subject_type, p_subject_id, now() + interval '1 day',
            'Drafted by ' || me.full_name || '. Nothing goes out until it is approved.')
    returning id into tid;
  if approver.id <> me.id and approver.phone is not null then
    insert into message(company_id, channel, to_member, body, status)
      values (me.company_id, 'whatsapp', approver.id, me.full_name || ' drafted ' || p_summary || '. Reply YES to approve.', 'queued');
  end if;
  perform desk_log('approval_requested', p_subject_type, p_subject_id, jsonb_build_object('approver', approver.id, 'task', tid));
  return jsonb_build_object('task_id', tid, 'approver_id', approver.id, 'approver', approver.full_name, 'self', approver.id = me.id);
end $$;

create or replace function desk_approve(p_subject_type text, p_subject_id uuid)
returns jsonb language plpgsql as $$
declare me member := current_member(); o offer; d document; n int := 0; pid uuid;
begin
  if me.id is null then raise exception 'Sign in first'; end if;
  if p_subject_type = 'role' then
    update role set status = 'open', approved_by = me.id where id = p_subject_id and status in ('draft','awaiting_approval');
    get diagnostics n = row_count;
  elsif p_subject_type = 'offer' then
    update offer set status = 'sent', approved_by = me.id, valid_until = current_date + 3
      where id = p_subject_id and status in ('draft','in_review') and (wages_check->>'passes')::boolean returning * into o;
    get diagnostics n = row_count;
    if n = 1 then
      select a.person_id into pid from application a where a.id = o.application_id;
      insert into message(company_id, channel, to_person, body, approved_by, status)
        values (me.company_id, 'email', pid, 'Your offer from ' || (select name from company where id = me.company_id) || ' is ready to review.', me.id, 'queued');
    end if;
  elsif p_subject_type in ('document', 'batch') then
    for d in select * from document where company_id = me.company_id and approved_by is null
               and (case when p_subject_type = 'batch' then batch_id = p_subject_id else id = p_subject_id end) loop
      update document set approved_by = me.id where id = d.id;
      insert into message(company_id, channel, to_person, body, approved_by, status)
        values (me.company_id, 'email', d.person_id, d.body, me.id, 'queued');
      if d.kind = 'rejection_note' then
        update application set outcome = 'rejected', stage = 'Rejected', reject_reason = coalesce(d.summary, reject_reason)
          where person_id = d.person_id and outcome is null;
      end if;
      n := n + 1;
    end loop;
  else raise exception 'Unknown approval type %', p_subject_type;
  end if;
  if n = 0 then return jsonb_build_object('approved', 0, 'note', 'Nothing to approve: it may already be approved or not allowed'); end if;
  update task set status = 'done', done_at = now() where kind = 'approval' and subject_id = p_subject_id and status = 'open';
  return jsonb_build_object('approved', n, 'by', me.full_name);
end $$;

create or replace function desk_discard(p_subject_type text, p_subject_id uuid) returns jsonb language plpgsql as $$
declare me member := current_member(); n int;
begin
  if p_subject_type = 'role' then update role set status = 'closed' where id = p_subject_id and status in ('draft','awaiting_approval');
  elsif p_subject_type = 'offer' then delete from offer where id = p_subject_id and status in ('draft','in_review');
  elsif p_subject_type = 'document' then delete from document where id = p_subject_id and approved_by is null;
  elsif p_subject_type = 'batch' then delete from document where batch_id = p_subject_id and approved_by is null;
  end if;
  get diagnostics n = row_count;
  update task set status = 'cancelled', done_at = now() where kind = 'approval' and subject_id = p_subject_id and status = 'open';
  perform desk_log('draft_discarded', p_subject_type, p_subject_id);
  return jsonb_build_object('discarded', n);
end $$;

-- ---------- write tools (drafts and internal actions only) ----------
create or replace function desk_create_role(p_title text, p_city text, p_openings int, p_budget_min int, p_budget_max int,
  p_experience text default null, p_start_days int default null, p_description text default null)
returns jsonb language plpgsql as $$
declare me member := current_member(); rid uuid; ap jsonb;
begin
  if me.id is null then raise exception 'Sign in first'; end if;
  if length(coalesce(trim(p_title), '')) not between 2 and 80 then raise exception 'Give the role a title'; end if;
  if p_budget_min is not null and p_budget_max is not null and p_budget_min > p_budget_max then raise exception 'The budget range is the wrong way round'; end if;
  insert into role(company_id, title, city, openings, budget_min, budget_max, status, owner_id, experience, start_within_days, description, target_fill_on)
    values (me.company_id, trim(p_title), p_city, greatest(coalesce(p_openings, 1), 1), p_budget_min, p_budget_max, 'awaiting_approval', me.id,
            p_experience, p_start_days, p_description, case when p_start_days is null then null else current_date + p_start_days end)
    returning id into rid;
  perform desk_log('role_drafted', 'role', rid, jsonb_build_object('title', p_title));
  ap := desk_request_approval('role', rid, coalesce(p_openings, 1) || ' × ' || p_title || coalesce(', ' || p_city, ''));
  return jsonb_build_object('role_id', rid, 'approval', ap);
end $$;

create or replace function desk_add_candidate(p_name text, p_role_id uuid, p_email text default null, p_phone text default null, p_consent boolean default false)
returns jsonb language plpgsql as $$
declare me member := current_member(); pid uuid; aid uuid;
begin
  if not p_consent then raise exception 'Record the candidate''s consent before adding their details'; end if;
  if not exists (select 1 from role where id = p_role_id and company_id = me.company_id) then raise exception 'That role isn''t in your workspace'; end if;
  insert into person(company_id, full_name, email, phone, consent_at) values (me.company_id, trim(p_name), p_email, p_phone, now()) returning id into pid;
  insert into application(company_id, role_id, person_id, stage) values (me.company_id, p_role_id, pid, 'Applied') returning id into aid;
  perform desk_log('candidate_added', 'person', pid, jsonb_build_object('role', p_role_id));
  return jsonb_build_object('person_id', pid, 'application_id', aid);
end $$;

create or replace function desk_move_candidate(p_application uuid, p_stage text) returns jsonb language plpgsql as $$
declare a application; r role; eid bigint;
begin
  select * into a from application where id = p_application;
  if a.id is null then raise exception 'Application not found'; end if;
  select * into r from role where id = a.role_id;
  if not (p_stage = any(r.stages)) then raise exception 'Stage must be one of: %', array_to_string(r.stages, ', '); end if;
  update application set stage = p_stage where id = a.id;
  eid := desk_log('candidate_moved', 'application', a.id, jsonb_build_object('from', a.stage, 'to', p_stage), 10);
  return jsonb_build_object('application_id', a.id, 'from', a.stage, 'to', p_stage, 'undo_event', eid);
end $$;

-- Undo within 10 minutes (Dev Brief §5.3). Only the person who did it.
create or replace function desk_undo(p_event bigint) returns jsonb language plpgsql as $$
declare e audit_event; me member := current_member();
begin
  select * into e from audit_event where id = p_event and company_id = me.company_id;
  if e.id is null or e.actor_member <> me.id then raise exception 'Nothing to undo'; end if;
  if e.undo_until is null or e.undo_until < now() then raise exception 'The 10-minute undo window has passed'; end if;
  if e.action = 'candidate_moved' then
    update application set stage = e.detail->>'from' where id = e.subject_id;
    perform desk_log('undone', 'application', e.subject_id, jsonb_build_object('event', p_event));
    return jsonb_build_object('undone', true, 'stage', e.detail->>'from');
  end if;
  raise exception 'That action can''t be undone';
end $$;

create or replace function desk_chase_owner(p_task uuid) returns jsonb language plpgsql as $$
declare t task; o member;
begin
  select * into t from task where id = p_task;
  if t.id is null or t.status <> 'open' then raise exception 'That task is not open'; end if;
  select * into o from member where id = t.owner_id;
  if o.id is null then raise exception 'That task has no owner to chase'; end if;
  insert into message(company_id, channel, to_member, body, status) values (t.company_id, 'whatsapp', o.id, 'Reminder: ' || t.title, 'queued');
  update task set last_reminded_at = now() where id = t.id;
  perform desk_log('owner_chased', 'task', t.id, jsonb_build_object('owner', o.id));
  return jsonb_build_object('chased', o.full_name, 'has_whatsapp', o.phone is not null,
    'escalates_to', (select full_name from member where id = t.escalation_chain[t.escalated_level + 1]));
end $$;

create or replace function desk_record_feedback(p_application uuid, p_scores jsonb, p_recommendation text, p_raw text default null)
returns jsonb language plpgsql as $$
declare i interview; fid uuid;
begin
  select * into i from interview where application_id = p_application order by scheduled_at desc nulls last limit 1;
  if i.id is null then raise exception 'No interview found for that candidate'; end if;
  insert into feedback(company_id, interview_id, scores, recommendation, raw_text) values (i.company_id, i.id, coalesce(p_scores, '{}'), p_recommendation, p_raw)
    returning id into fid;
  update task set status = 'done', done_at = now() where kind = 'feedback' and subject_id = i.id and status = 'open';
  perform desk_log('feedback_recorded', 'interview', i.id, jsonb_build_object('recommendation', p_recommendation));
  return jsonb_build_object('feedback_id', fid, 'interview_id', i.id);
end $$;

-- p_check is the result of calculate_ctc (plain code in the Edge Function); stored as evidence.
create or replace function desk_save_offer(p_application uuid, p_components jsonb, p_ctc int, p_check jsonb, p_joining date default null)
returns jsonb language plpgsql as $$
declare me member := current_member(); oid uuid;
begin
  select id into oid from offer where application_id = p_application and status in ('draft','in_review') limit 1;
  if oid is null then
    insert into offer(company_id, application_id, components, ctc, wages_check, joining_on) values (me.company_id, p_application, p_components, p_ctc, p_check, p_joining)
      returning id into oid;
  else
    update offer set components = p_components, ctc = p_ctc, wages_check = p_check, joining_on = coalesce(p_joining, joining_on) where id = oid;
  end if;
  perform desk_log('offer_drafted', 'offer', oid, jsonb_build_object('passes', p_check->'passes'));
  return jsonb_build_object('offer_id', oid);
end $$;

create or replace function desk_save_document(p_person uuid, p_kind text, p_body text, p_summary text default null, p_batch uuid default null)
returns jsonb language plpgsql as $$
declare me member := current_member(); did uuid; v int;
begin
  if p_kind = 'rejection_note' and desk_blocked_text(p_body) then
    raise exception 'Rejection text can''t mention age, gender, marital status, religion, caste or pregnancy';
  end if;
  select coalesce(max(version), 0) + 1 into v from document where person_id = p_person and kind = p_kind;
  insert into document(company_id, person_id, kind, version, body, summary, batch_id) values (me.company_id, p_person, p_kind, v, p_body, p_summary, p_batch)
    returning id into did;
  perform desk_log('document_drafted', 'document', did, jsonb_build_object('kind', p_kind));
  return jsonb_build_object('document_id', did, 'version', v);
end $$;

create or replace function desk_mark_offer_accepted(p_offer uuid) returns jsonb language plpgsql as $$
declare me member := current_member(); o offer; a application; p person; it member; mgr uuid; j date; pe date;
begin
  select * into o from offer where id = p_offer;
  if o.id is null or o.status <> 'sent' then raise exception 'Only a sent offer can be accepted'; end if;
  select * into a from application where id = o.application_id;
  select * into p from person where id = a.person_id;
  j := coalesce(o.joining_on, current_date + 14); pe := (j + interval '6 months')::date;
  update offer set status = 'accepted' where id = o.id;
  update application set outcome = 'hired', stage = 'Hired' where id = a.id;
  select owner_id into mgr from role where id = a.role_id;
  update person set status = 'employee', joined_on = j, probation_ends_on = pe, manager_id = coalesce(manager_id, mgr) where id = p.id;
  select * into it from member where company_id = me.company_id and (title ilike '%IT%' or title ilike '%admin%') limit 1;
  insert into task(company_id, title, kind, owner_id, subject_type, subject_id, due_at, why) values
    (me.company_id, 'Appointment letter for ' || p.full_name, 'appointment_letter', me.id, 'person', p.id, (j - 5)::timestamptz, 'Every joiner needs one before Day 1'),
    (me.company_id, 'Laptop and email for ' || p.full_name, 'it_setup', coalesce(it.id, me.id), 'person', p.id, (j - 3)::timestamptz, 'Ready before Day 1'),
    (me.company_id, 'Day 1 plan and buddy for ' || p.full_name, 'day1_plan', me.id, 'person', p.id, (j - 1)::timestamptz, '30-60-90 plan from the playbook'),
    (me.company_id, 'Probation review for ' || p.full_name, 'probation_review', coalesce(mgr, me.id), 'person', p.id, (pe - 15)::timestamptz, '15 days before the end of probation');
  perform desk_log('offer_accepted', 'offer', o.id, jsonb_build_object('person', p.id, 'joining', j));
  return jsonb_build_object('person_id', p.id, 'name', p.full_name, 'joined_on', j, 'probation_ends_on', pe);
end $$;

create or replace function desk_start_probation_review(p_person uuid) returns jsonb language plpgsql as $$
declare me member := current_member(); p person; m member; tid uuid;
begin
  select * into p from person where id = p_person and status = 'employee';
  if p.id is null then raise exception 'That person is not an employee'; end if;
  select * into m from member where id = p.manager_id;
  if m.id is null then raise exception 'Add a manager for % first', p.full_name; end if;
  update task set status = 'done', done_at = now() where subject_id = p.id and kind = 'probation_review' and owner_id = me.id and status = 'open';
  insert into task(company_id, title, kind, owner_id, subject_type, subject_id, due_at, why, escalation_chain)
    values (me.company_id, m.full_name || ' to review ' || p.full_name || '''s probation', 'probation_review', m.id, 'person', p.id, now() + interval '3 days',
            'Probation ends ' || to_char(p.probation_ends_on, 'Dy DD Mon'), array[me.id]) returning id into tid;
  insert into message(company_id, channel, to_member, body, status)
    values (me.company_id, 'whatsapp', m.id, p.full_name || '''s probation ends on ' || to_char(p.probation_ends_on, 'DD Mon') || '. Confirm, extend or discuss?', 'queued');
  perform desk_log('probation_review_started', 'person', p.id, jsonb_build_object('manager', m.id));
  return jsonb_build_object('task_id', tid, 'manager', m.full_name, 'ends', p.probation_ends_on);
end $$;

-- Drafts one rejection note per person (approved together later). Reason must be job-relevant.
create or replace function desk_bulk_reject(p_role uuid, p_person_ids uuid[], p_reason text, p_note text)
returns jsonb language plpgsql as $$
declare me member := current_member(); b uuid := gen_random_uuid(); pid uuid; nm text; n int := 0;
begin
  if p_reason not in ('skills_gap','assessment_below_bar','experience_mismatch','salary_mismatch','location_mismatch','notice_period','role_filled','no_show','withdrew') then
    raise exception 'Use a job-relevant reason from the list';
  end if;
  if desk_blocked_text(p_note) then raise exception 'Rejection text can''t mention age, gender, marital status, religion, caste or pregnancy'; end if;
  foreach pid in array p_person_ids loop
    select full_name into nm from person where id = pid and company_id = me.company_id;
    continue when nm is null;
    perform desk_save_document(pid, 'rejection_note', replace(p_note, '{name}', split_part(nm, ' ', 1)), p_reason, b);
    n := n + 1;
  end loop;
  return jsonb_build_object('batch_id', b, 'drafts', n, 'approval', desk_request_approval('batch', b, n || ' rejection notes'));
end $$;

-- ---------- sample data inside the caller's own workspace (for testers) ----------
create or replace function desk_load_sample_data() returns jsonb language plpgsql as $$
declare me member := current_member(); co uuid; rahul uuid; meera uuid; arjun uuid; vikram uuid; suresh uuid; rb uuid; ro uuid; rc uuid; p uuid; a uuid; i uuid; n int;
begin
  if me.id is null or me.app_role not in ('owner','lead') then raise exception 'Only the workspace owner can load sample data'; end if;
  co := me.company_id;
  if exists (select 1 from role where company_id = co) then raise exception 'Sample data can only be loaded into an empty workspace'; end if;
  insert into member(company_id, full_name, title, app_role) values (co, 'Rahul', 'Founder', 'approver') returning id into rahul;
  insert into member(company_id, full_name, title, app_role) values (co, 'Meera', 'HR Manager', 'member') returning id into meera;
  insert into member(company_id, full_name, title, app_role) values (co, 'Arjun Mehta', 'Engineering Manager', 'member') returning id into arjun;
  insert into member(company_id, full_name, title, app_role) values (co, 'Vikram', 'Head of Engineering', 'member') returning id into vikram;
  insert into member(company_id, full_name, title, app_role) values (co, 'Suresh', 'IT', 'member') returning id into suresh;
  insert into role(company_id, title, city, budget_min, budget_max, status, owner_id) values (co, 'Backend Developer', 'Hyderabad', 1000000, 1400000, 'draft', me.id) returning id into rb;
  insert into role(company_id, title, city, budget_min, budget_max, status, owner_id) values (co, 'Operations Analyst', 'Hyderabad', 500000, 700000, 'draft', me.id) returning id into ro;
  insert into role(company_id, title, city, budget_min, budget_max, status, owner_id) values (co, 'Customer Success Associate', 'Hyderabad', 450000, 600000, 'draft', me.id) returning id into rc;
  update role set status = 'open', approved_by = me.id where id in (rb, ro, rc);   -- stamped as the signed-in owner by 003
  for n in 1..12 loop insert into person(company_id, full_name, consent_at) values (co, 'Applicant ' || n, now()) returning id into p;
    insert into application(company_id, role_id, person_id, stage) values (co, rb, p, 'Applied'); end loop;
  for n in 1..5 loop insert into person(company_id, full_name, consent_at) values (co, 'Screened ' || n, now()) returning id into p;
    insert into application(company_id, role_id, person_id, stage) values (co, rb, p, 'Screened'); end loop;
  insert into person(company_id, full_name, consent_at) values (co, 'Ankit Verma', now()) returning id into p;
  insert into application(company_id, role_id, person_id, stage) values (co, rb, p, 'Interview') returning id into a;
  insert into interview(company_id, application_id, round, interviewer_id, scheduled_at) values (co, a, 'Round 1', arjun, now() - interval '26 hours') returning id into i;
  insert into task(company_id, title, kind, owner_id, subject_type, subject_id, due_at, escalation_chain, why)
    values (co, 'Arjun Mehta hasn''t given feedback on Ankit Verma', 'feedback', arjun, 'interview', i, now() - interval '2 hours', array[vikram], 'Backend Developer · escalates to Vikram');
  insert into person(company_id, full_name, consent_at) values (co, 'Lakshmi R.', now()) returning id into p;
  insert into application(company_id, role_id, person_id, stage) values (co, rb, p, 'Interview');
  insert into person(company_id, full_name, consent_at) values (co, 'Sameer T.', now()) returning id into p;
  insert into application(company_id, role_id, person_id, stage) values (co, rb, p, 'Interview');
  insert into person(company_id, full_name, consent_at) values (co, 'Kiran S.', now()) returning id into p;
  insert into application(company_id, role_id, person_id, stage) values (co, rb, p, 'Offer');
  for n in 1..4 loop
    insert into person(company_id, full_name, consent_at) values (co, (array['Megha D.','Imran S.','Tarun B.','Pooja N.'])[n], now()) returning id into p;
    insert into application(company_id, role_id, person_id, stage) values (co, ro, p, 'Screened');
  end loop;
  insert into person(company_id, full_name, consent_at) values (co, 'Arjun Rao', now()) returning id into p;
  insert into application(company_id, role_id, person_id, stage) values (co, rc, p, 'Screened');
  insert into person(company_id, full_name, status, joined_on, probation_ends_on, manager_id, consent_at)
    values (co, 'Sneha Rao', 'employee', current_date + 4, (current_date + 4 + interval '6 months')::date, vikram, now()) returning id into p;
  insert into task(company_id, title, kind, owner_id, subject_type, subject_id, due_at, why)
    values (co, 'Sneha joins soon with no appointment letter', 'appointment_letter', me.id, 'person', p, now() - interval '1 hour', 'Every joiner needs one before Day 1');
  insert into person(company_id, full_name, status, joined_on, probation_ends_on, manager_id, consent_at)
    values (co, 'Priya Nair', 'employee', (current_date + 11 - interval '6 months')::date, current_date + 11, vikram, now()) returning id into p;
  insert into task(company_id, title, kind, owner_id, subject_type, subject_id, due_at, why)
    values (co, 'Start Priya''s probation review', 'probation_review', me.id, 'person', p, now() + interval '3 days', 'Manager review is due before the end date');
  perform desk_log('sample_data_loaded', 'company', co);
  return jsonb_build_object('loaded', true);
end $$;

-- Signed-in users may call the tool functions; anonymous visitors may not.
do $$ declare f text; begin
  foreach f in array array['desk_get_brief()','desk_find_people(text)','desk_show_pipeline(text)','desk_show_joiners()',
    'desk_request_approval(text,uuid,text)','desk_approve(text,uuid)','desk_discard(text,uuid)',
    'desk_create_role(text,text,int,int,int,text,int,text)','desk_add_candidate(text,uuid,text,text,boolean)','desk_move_candidate(uuid,text)',
    'desk_undo(bigint)','desk_chase_owner(uuid)','desk_record_feedback(uuid,jsonb,text,text)','desk_save_offer(uuid,jsonb,int,jsonb,date)',
    'desk_save_document(uuid,text,text,text,uuid)','desk_mark_offer_accepted(uuid)','desk_start_probation_review(uuid)',
    'desk_bulk_reject(uuid,uuid[],text,text)','desk_load_sample_data()','desk_month_tokens()','desk_log(text,text,uuid,jsonb,int)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
