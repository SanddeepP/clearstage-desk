-- 005_server_rules.sql — CTO review of the Desk agent, 12 Nov 2026. Run after 004. Re-runnable.
-- R1 The wages check was computed in the Edge Function and trusted by the database: desk_save_offer (or a direct
--    update of offer.wages_check) could store {"passes":true} for a failing structure, and that offer could then be
--    approved and sent. Now the database computes the check and CTC itself from the components, every time.
--    Same rule as lib/ctc.js checkWagesRule (Code on Wages 2019 s.2(y), awaiting legal review).
-- R2 desk_chase_owner had no cooldown (5 chases in a row were accepted) and reset the task's reminder clock,
--    so chasing every few hours would postpone escalation forever. Now: one chase per task every 4 hours,
--    and a manual chase no longer touches the scheduler's clock.

-- ---------- R1: wages check computed by the database ----------
create or replace function wages_check(p_components jsonb) returns jsonb
language plpgsql immutable set search_path = public as $$
declare c jsonb; amt bigint; ctc bigint := 0; wages bigint := 0; employer bigint := 0;
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
    elsif c->>'kind' in ('employer_pf','employer_esi','gratuity') then employer := employer + amt;
    end if;
  end loop;
  remuneration := ctc - employer;
  if remuneration <= 0 then raise exception 'CTC has no pay to the employee'; end if;
  excluded := remuneration - wages;
  lim := floor(remuneration * 0.5);
  excess := greatest(0, excluded - lim);
  return jsonb_build_object(
    'ctc', ctc, 'remuneration', remuneration, 'wages', wages,
    'wages_percent', round(wages::numeric * 100 / remuneration, 1),
    'passes', excess = 0, 'deemed_extra_wages', excess,
    'rule', 'code-on-wages-50', 'computed_by', 'database');
end $$;

create or replace function offer_compute_check() returns trigger language plpgsql as $$
declare chk jsonb;
begin
  chk := wages_check(new.components);
  new.wages_check := chk;                    -- whatever the client sent is ignored
  new.ctc := (chk->>'ctc')::int;
  return new;
end $$;
drop trigger if exists offer_compute_check on offer;
create trigger offer_compute_check before insert or update of components, ctc, wages_check on offer
  for each row execute function offer_compute_check();

-- Recompute every existing offer once so stored results are trustworthy.
update offer set components = components;

-- An offer can't be approved or sent unless the database's own check passed.
alter table offer drop constraint if exists offer_sent_needs_pass;
alter table offer add constraint offer_sent_needs_pass
  check (status in ('draft','in_review','declined','expired') or (wages_check->>'passes')::boolean) not valid;  -- existing rows aren't blocked; every new write is

-- ---------- R2: chase cooldown, escalation clock untouched ----------
create or replace function desk_chase_owner(p_task uuid) returns jsonb language plpgsql as $$
declare t task; o member; last_chase timestamptz;
begin
  select * into t from task where id = p_task;
  if t.id is null or t.status <> 'open' then raise exception 'That task is not open'; end if;
  select * into o from member where id = t.owner_id;
  if o.id is null then raise exception 'That task has no owner to chase'; end if;
  select max(created_at) into last_chase from audit_event
    where company_id = t.company_id and action = 'owner_chased' and subject_id = t.id;
  if last_chase is not null and last_chase > now() - interval '4 hours' then
    raise exception '% was already chased at % IST. You can chase again after %.', o.full_name,
      to_char(last_chase at time zone 'Asia/Kolkata', 'HH24:MI'),
      to_char((last_chase + interval '4 hours') at time zone 'Asia/Kolkata', 'HH24:MI');
  end if;
  insert into message(company_id, channel, to_member, body, status) values (t.company_id, 'whatsapp', o.id, 'Reminder: ' || t.title, 'queued');
  perform desk_log('owner_chased', 'task', t.id, jsonb_build_object('owner', o.id));
  return jsonb_build_object('chased', o.full_name, 'has_whatsapp', o.phone is not null,
    'next_chase_after', now() + interval '4 hours',
    'escalates_to', (select full_name from member where id = t.escalation_chain[t.escalated_level + 1]));
end $$;
revoke all on function desk_chase_owner(uuid) from public, anon;
grant execute on function desk_chase_owner(uuid) to authenticated;
