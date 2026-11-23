-- 010_session_enforce.sql — SEC-1 (CTO ruling 22 Nov), step 2 of 2: the database refuses sessions older than 12 hours,
-- or without a session, even if the browser's timeout is bypassed with a copied token.
--   1. A RESTRICTIVE policy on every public table with row-level security: authenticated callers need session_fresh().
--      (Restrictive policies are ANDed with the existing ones, so nothing becomes more permissive.)
--   2. current_member(), which every Desk tool calls first, raises "Your session has expired" for a stale session.
--   3. create_company_for_me(), the one security-definer entry point that doesn't use current_member(), checks it too.
-- The scheduler (pg_cron, as the owner) and service-role jobs are not affected: they don't run as "authenticated".
do $$ declare t record; begin
  for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity loop
    execute format('drop policy if exists session_fresh on public.%I', t.relname);
    execute format('create policy session_fresh on public.%I as restrictive for all to authenticated using ((select public.session_fresh())) with check ((select public.session_fresh()))', t.relname);
  end loop;
  for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity loop
    raise warning 'Table public.% has no row-level security, so the session check does not cover it', t.relname;
  end loop;
end $$;

create or replace function current_member() returns member
language plpgsql stable security definer set search_path = public as $$
declare m member;
begin
  if auth.uid() is not null and not session_fresh() then
    raise exception 'Your session has expired. Sign in again.' using errcode = '28000';
  end if;
  select * into m from member where user_id = auth.uid() limit 1;
  return m;
end $$;

create or replace function create_company_for_me(p_company text, p_city text, p_full_name text, p_phone text, p_setup text)
returns uuid language plpgsql security definer set search_path = public as $$
declare cid uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  if not session_fresh() then raise exception 'Your session has expired. Sign in again.' using errcode = '28000'; end if;
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
