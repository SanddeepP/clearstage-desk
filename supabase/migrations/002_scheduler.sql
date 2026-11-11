-- Task scheduler: one job every 5 minutes runs reminders and escalations for every company.
-- Task is the shared spine, so this one function covers feedback chases, letters, IT setup and probation reviews.

create or replace function run_task_scheduler(p_now timestamptz default now())
returns table (task_id uuid, action text, to_member uuid)
language plpgsql security definer set search_path = public as $$
declare t record; every_h numeric; nxt uuid;
begin
  for t in
    select * from task
    where status = 'open' and due_at is not null and due_at < p_now
    for update skip locked
  loop
    every_h := coalesce((t.reminder_rule->>'every_hours')::numeric, 24);

    -- Escalate: overdue by a full reminder cycle and someone is next in the chain
    if p_now - t.due_at >= make_interval(secs => every_h * 3600)
       and t.escalated_level < coalesce(array_length(t.escalation_chain, 1), 0) then
      nxt := t.escalation_chain[t.escalated_level + 1];
      update task set escalated_level = escalated_level + 1, last_reminded_at = p_now where id = t.id;
      insert into message(company_id, channel, to_member, body, status)
        values (t.company_id, 'whatsapp', nxt, 'Escalation: ' || t.title, 'queued');
      insert into audit_event(company_id, actor_kind, action, subject_type, subject_id, detail)
        values (t.company_id, 'system', 'task_escalated', 'task', t.id, jsonb_build_object('to', nxt, 'level', t.escalated_level + 1));
      task_id := t.id; action := 'escalated'; to_member := nxt; return next;

    -- Remind the owner: overdue and not reminded within the last cycle
    elsif t.owner_id is not null
       and (t.last_reminded_at is null or p_now - t.last_reminded_at >= make_interval(secs => every_h * 3600)) then
      update task set last_reminded_at = p_now where id = t.id;
      insert into message(company_id, channel, to_member, body, status)
        values (t.company_id, 'whatsapp', t.owner_id, 'Reminder: ' || t.title, 'queued');
      insert into audit_event(company_id, actor_kind, action, subject_type, subject_id)
        values (t.company_id, 'system', 'task_reminded', 'task', t.id);
      task_id := t.id; action := 'reminded'; to_member := t.owner_id; return next;
    end if;
  end loop;
end $$;

-- Only the scheduler (service role) may run it
revoke all on function run_task_scheduler(timestamptz) from public, anon, authenticated;

-- Supabase: enable pg_cron under Database → Extensions, then this schedules the job every 5 minutes.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('clearstage-task-scheduler', '*/5 * * * *', 'select run_task_scheduler()');
  else
    raise notice 'pg_cron is not available here; schedule run_task_scheduler() externally every 5 minutes.';
  end if;
end $$;

-- The Today view is a query on tasks: open tasks bucketed by due date (IST).
create or replace view today_tasks with (security_invoker = true) as
select t.*,
  case
    when t.status = 'done' then 'Done'
    when t.due_at < now() then 'Late'
    when (t.due_at at time zone 'Asia/Kolkata')::date = (now() at time zone 'Asia/Kolkata')::date then 'Today'
    else 'This week'
  end as bucket
from task t
where t.status in ('open','done') and (t.due_at is null or t.due_at < now() + interval '7 days');
