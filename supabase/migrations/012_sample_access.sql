-- 012_sample_access.sql — CTO ruling 23 Nov §2: an empty workspace by default; the sample company only on approval.
-- * company.is_sample marks the sample company (Acme Fintech, the seed company).
-- * platform_admin holds the founder's user id. It's filled by hand (no email in this public repo) and is invisible
--   to every client: RLS on, no policies.
-- * grant_sample_access(email) / revoke_sample_access(email): platform admin only, audited. Granting adds the user as
--   a member of the sample company, so the existing row-level security shows them exactly that company and nothing else.
-- * current_member() prefers the user's own company over the sample one; create_company_for_me ignores the sample membership.
-- * desk_load_sample_data() is no longer available to clients (sample data comes only from the sample company).
-- Re-runnable.
alter table company add column if not exists is_sample boolean not null default false;
update company set is_sample = true where id = '00000000-0000-4000-8000-000000000001' and not is_sample;

create table if not exists platform_admin (user_id uuid primary key references auth.users(id) on delete cascade, added_at timestamptz not null default now());
alter table platform_admin enable row level security;
revoke all on platform_admin from anon, authenticated;

create table if not exists sample_access (
  user_id uuid primary key references auth.users(id) on delete cascade,
  granted_by uuid references auth.users(id), granted_at timestamptz not null default now());
alter table sample_access enable row level security;
drop policy if exists sample_access_self on sample_access;
create policy sample_access_self on sample_access for select to authenticated using (user_id = auth.uid() and public.session_fresh());
revoke insert, update, delete, truncate on sample_access from anon, authenticated;

create or replace function is_platform_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from platform_admin where user_id = auth.uid()) and session_fresh()
$$;
revoke all on function is_platform_admin() from public, anon; grant execute on function is_platform_admin() to authenticated;

create or replace function sample_company_id() returns uuid language sql stable security definer set search_path = public as $$
  select id from company where is_sample order by created_at limit 1 $$;
revoke all on function sample_company_id() from public, anon, authenticated;

create or replace function grant_sample_access(p_email text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid; sc uuid := sample_company_id(); nm text;
begin
  if not is_platform_admin() then raise exception 'Only Clearstage can grant sample access'; end if;
  if sc is null then raise exception 'There is no sample company'; end if;
  select id into uid from auth.users where lower(email) = lower(trim(p_email));
  if uid is null then raise exception 'No account with that email yet. Ask them to sign in once first.'; end if;
  select full_name into nm from member where user_id = uid order by created_at limit 1;
  insert into sample_access(user_id, granted_by) values (uid, auth.uid()) on conflict (user_id) do update set granted_by = excluded.granted_by, granted_at = now();
  if not exists (select 1 from member where company_id = sc and user_id = uid) then
    insert into member(company_id, user_id, full_name, email, app_role) values (sc, uid, coalesce(nm, split_part(p_email, '@', 1)), lower(trim(p_email)), 'member');
  end if;
  insert into audit_event(company_id, actor_kind, action, detail) values (sc, 'human', 'sample_access_granted', jsonb_build_object('email', lower(trim(p_email)), 'by', auth.uid()));
  return jsonb_build_object('granted', true, 'email', lower(trim(p_email)));
end $$;
revoke all on function grant_sample_access(text) from public, anon; grant execute on function grant_sample_access(text) to authenticated;

create or replace function revoke_sample_access(p_email text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid; sc uuid := sample_company_id(); n int;
begin
  if not is_platform_admin() then raise exception 'Only Clearstage can revoke sample access'; end if;
  select id into uid from auth.users where lower(email) = lower(trim(p_email));
  if uid is null then raise exception 'No account with that email'; end if;
  delete from sample_access where user_id = uid;
  delete from member where company_id = sc and user_id = uid; get diagnostics n = row_count;
  insert into audit_event(company_id, actor_kind, action, detail) values (sc, 'human', 'sample_access_revoked', jsonb_build_object('email', lower(trim(p_email)), 'by', auth.uid()));
  return jsonb_build_object('revoked', n > 0, 'email', lower(trim(p_email)));
end $$;
revoke all on function revoke_sample_access(text) from public, anon; grant execute on function revoke_sample_access(text) to authenticated;

-- The company switcher: your own company first, then the sample company if you've been granted it
create or replace function my_workspaces() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'city', c.city, 'is_sample', c.is_sample) order by c.is_sample, c.created_at), '[]')
  from company c join member m on m.company_id = c.id
  where m.user_id = auth.uid() and session_fresh() and (not c.is_sample or exists (select 1 from sample_access s where s.user_id = auth.uid()))
$$;
revoke all on function my_workspaces() from public, anon; grant execute on function my_workspaces() to authenticated;

-- Own company first: Desk tools act in the user's own workspace, never the sample one by accident
create or replace function current_member() returns member
language plpgsql stable security definer set search_path = public as $$
declare m member;
begin
  if auth.uid() is not null and not session_fresh() then
    raise exception 'Your session has expired. Sign in again.' using errcode = '28000';
  end if;
  select mm.* into m from member mm join company c on c.id = mm.company_id where mm.user_id = auth.uid() order by c.is_sample, mm.created_at limit 1;
  return m;
end $$;

-- A user who was granted sample access before signing up can still create their own company
create or replace function create_company_for_me(p_company text, p_city text, p_full_name text, p_phone text, p_setup text)
returns uuid language plpgsql security definer set search_path = public as $$
declare cid uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  if not session_fresh() then raise exception 'Your session has expired. Sign in again.' using errcode = '28000'; end if;
  if exists (select 1 from member m join company c on c.id = m.company_id where m.user_id = auth.uid() and not c.is_sample) then raise exception 'You already have a workspace'; end if;
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

-- Sample rows come only from the sample company now
revoke execute on function desk_load_sample_data() from public, anon, authenticated;

-- SEC-1: every table with row-level security also carries the restrictive fresh-session policy (as in 010)
do $$ declare t record; begin
  for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity loop
    execute format('drop policy if exists session_fresh on public.%I', t.relname);
    execute format('create policy session_fresh on public.%I as restrictive for all to authenticated using ((select public.session_fresh())) with check ((select public.session_fresh()))', t.relname);
  end loop;
end $$;
