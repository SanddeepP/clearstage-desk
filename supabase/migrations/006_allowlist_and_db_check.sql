-- 006_allowlist_and_db_check.sql — CTO review of the Desk agent (12 Nov), items C2 and C5. Run after 005. Re-runnable.
-- C2 The live Desk agent is allow-listed per company until pilots. Only the service role (or the SQL editor)
--    can switch it on; a signed-in user, even an owner, can't, and a new sign-up starts with it off.
-- C5 desk_save_offer returns the database's own wages check (005), so the salary card shows that result
--    instead of the one the Edge Function computed. One source.

-- ---------- C2: allow-list ----------
alter table company add column if not exists desk_enabled boolean not null default false;

create or replace function guard_desk_enabled() returns trigger language plpgsql as $$
begin
  if current_user in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then new.desk_enabled := false;
    elsif new.desk_enabled is distinct from old.desk_enabled then
      raise exception 'The live Desk agent is switched on by Clearstage during the beta';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists guard_desk_enabled on company;
create trigger guard_desk_enabled before insert or update on company for each row execute function guard_desk_enabled();

create or replace function desk_live_enabled() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select c.desk_enabled from company c where c.id = (current_member()).company_id), false)
$$;
revoke all on function desk_live_enabled() from public, anon;
grant execute on function desk_live_enabled() to authenticated;

-- ---------- C5: the salary card reads the database's check ----------
create or replace function desk_save_offer(p_application uuid, p_components jsonb, p_ctc int, p_check jsonb, p_joining date default null)
returns jsonb language plpgsql as $$
declare me member := current_member(); oid uuid; chk jsonb; total int;
begin
  select id into oid from offer where application_id = p_application and status in ('draft','in_review') limit 1;
  if oid is null then
    insert into offer(company_id, application_id, components, ctc, wages_check, joining_on) values (me.company_id, p_application, p_components, p_ctc, p_check, p_joining)
      returning id, wages_check, ctc into oid, chk, total;
  else
    update offer set components = p_components, ctc = p_ctc, wages_check = p_check, joining_on = coalesce(p_joining, joining_on) where id = oid
      returning wages_check, ctc into chk, total;
  end if;
  perform desk_log('offer_drafted', 'offer', oid, jsonb_build_object('passes', chk->'passes', 'computed_by', chk->'computed_by'));
  return jsonb_build_object('offer_id', oid, 'ctc', total, 'check', chk);   -- chk is what 005's trigger computed
end $$;
revoke all on function desk_save_offer(uuid, jsonb, int, jsonb, date) from public, anon;
grant execute on function desk_save_offer(uuid, jsonb, int, jsonb, date) to authenticated;
