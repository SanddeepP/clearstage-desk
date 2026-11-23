-- 013_ai_live.sql — AI live (founder 23 Nov): Gemini provider, key by company, replay fallback, founder alerts.
-- * ai_usage.key_tier records which key paid for each call (free / free_qa / paid), so QA can prove no real company
--   ever used a free key.
-- * desk_replay stores the sample company's successful Desk answers; when Gemini is busy (429), the sample company gets
--   the stored answer with a "replayed" note. Real companies never get replays.
-- * platform_alert: "AI credit used up" and similar, for the founder. No client can read it.
-- Re-runnable.
alter table ai_usage add column if not exists key_tier text check (key_tier is null or key_tier in ('free','free_qa','paid'));

create table if not exists desk_replay (
  company_id uuid not null references company(id) on delete cascade,
  prompt_key text not null check (length(prompt_key) between 1 and 300),
  reply text not null, cards jsonb not null default '[]',
  created_at timestamptz not null default now(),
  primary key (company_id, prompt_key));
alter table desk_replay enable row level security;
drop policy if exists desk_replay_read on desk_replay;
create policy desk_replay_read on desk_replay for select using (company_id in (select my_company_ids()));
revoke insert, update, delete, truncate on desk_replay from anon, authenticated;

create or replace function desk_replay_save(p_key text, p_reply text, p_cards jsonb default '[]') returns boolean
language plpgsql security definer set search_path = public as $$
declare me member := current_member();
begin
  if not exists (select 1 from company where id = me.company_id and is_sample) then return false; end if;   -- sample company only
  insert into desk_replay(company_id, prompt_key, reply, cards) values (me.company_id, left(p_key, 300), left(p_reply, 4000), coalesce(p_cards, '[]'))
    on conflict (company_id, prompt_key) do update set reply = excluded.reply, cards = excluded.cards, created_at = now();
  return true;
end $$;
create or replace function desk_replay_get(p_key text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('reply', r.reply, 'cards', r.cards) from desk_replay r join company c on c.id = r.company_id
  where r.company_id = (current_member()).company_id and c.is_sample and r.prompt_key = left(p_key, 300)
$$;
revoke all on function desk_replay_save(text, text, jsonb) from public, anon; grant execute on function desk_replay_save(text, text, jsonb) to authenticated;
revoke all on function desk_replay_get(text) from public, anon; grant execute on function desk_replay_get(text) to authenticated;

create table if not exists platform_alert (
  id bigint generated always as identity primary key,
  kind text not null, company_id uuid references company(id) on delete cascade,
  detail jsonb not null default '{}', created_at timestamptz not null default now());
alter table platform_alert enable row level security;
revoke all on platform_alert from anon, authenticated;

-- Raised by the AI functions as the signed-in user; at most one per kind per company per hour.
create or replace function raise_platform_alert(p_kind text, p_detail jsonb default '{}') returns boolean
language plpgsql security definer set search_path = public as $$
declare me member := current_member();
begin
  if p_kind not in ('ai_credit_exhausted', 'ai_key_missing', 'ai_error') then raise exception 'Unknown alert'; end if;
  if exists (select 1 from platform_alert where kind = p_kind and company_id = me.company_id and created_at > now() - interval '1 hour') then return false; end if;
  insert into platform_alert(kind, company_id, detail) values (p_kind, me.company_id, coalesce(p_detail, '{}') || jsonb_build_object('member', me.id));
  return true;
end $$;
revoke all on function raise_platform_alert(text, jsonb) from public, anon; grant execute on function raise_platform_alert(text, jsonb) to authenticated;

-- The founder's view of alerts (platform admin only)
create or replace function platform_alerts(p_limit int default 50) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_platform_admin() then raise exception 'Only Clearstage can read platform alerts'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('kind', a.kind, 'company', c.name, 'at', a.created_at, 'detail', a.detail) order by a.created_at desc)
    from (select * from platform_alert order by created_at desc limit least(greatest(p_limit, 1), 200)) a left join company c on c.id = a.company_id), '[]');
end $$;
revoke all on function platform_alerts(int) from public, anon; grant execute on function platform_alerts(int) to authenticated;

-- What the AI functions need to pick a key: is this the sample company, and is the live agent on?
create or replace function desk_ai_context() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('company_id', c.id, 'is_sample', c.is_sample, 'desk_enabled', c.desk_enabled)
  from company c where c.id = (current_member()).company_id
$$;
revoke all on function desk_ai_context() from public, anon; grant execute on function desk_ai_context() to authenticated;

-- SEC-1 on the new tables
do $$ declare t record; begin
  for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity loop
    execute format('drop policy if exists session_fresh on public.%I', t.relname);
    execute format('create policy session_fresh on public.%I as restrictive for all to authenticated using ((select public.session_fresh())) with check ((select public.session_fresh()))', t.relname);
  end loop;
end $$;
