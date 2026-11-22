-- 009_session_fresh.sql — SEC-1 (CTO ruling 22 Nov), step 1 of 2: the check itself, no enforcement yet.
-- session_fresh() is true only when the caller's token carries a session_id that exists in auth.sessions for that user
-- and was created less than 12 hours ago. 010 enforces it (restrictive RLS on every table, and in current_member(),
-- which every Desk tool calls first). Split in two so the live check can be confirmed before anything is refused.
do $$ begin
  if not has_table_privilege('auth.sessions', 'select') then
    raise exception 'The migration role cannot read auth.sessions, so session_fresh() would refuse everyone. Stopping.';
  end if;
end $$;

create or replace function session_fresh() returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare sid uuid; uid uuid := auth.uid(); ok boolean;
begin
  if uid is null then return false; end if;
  begin sid := nullif(auth.jwt()->>'session_id', '')::uuid; exception when others then return false; end;
  if sid is null then return false; end if;
  select s.created_at > now() - interval '12 hours' into ok from auth.sessions s where s.id = sid and s.user_id = uid;
  return coalesce(ok, false);
end $$;
revoke all on function session_fresh() from public, anon;
grant execute on function session_fresh() to authenticated;

-- For checking from a signed-in browser before 010 is applied, and for support later. Shows no other user's data.
create or replace function session_status() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare sid uuid; created timestamptz;
begin
  begin sid := nullif(auth.jwt()->>'session_id', '')::uuid; exception when others then sid := null; end;
  select s.created_at into created from auth.sessions s where s.id = sid and s.user_id = auth.uid();
  return jsonb_build_object('signed_in', auth.uid() is not null, 'has_session_id', sid is not null, 'session_found', created is not null,
    'age_minutes', case when created is null then null else round(extract(epoch from now() - created) / 60) end,
    'fresh', public.session_fresh(), 'max_hours', 12);
end $$;
revoke all on function session_status() from public, anon;
grant execute on function session_status() to authenticated;
