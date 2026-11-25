-- 017_roles.sql — roles foundation for G2 (CTO ruling "Roles and views", 25 Nov, §2–3; PM spec RD-PM-Spec-Roles-and-Views.md).
-- * member_role: a person can hold several roles per company: super_admin, hr, recruiter, manager.
--   Employees are never members (Employee-login ruling), so there is no employee role here.
-- * Two flags on member: see_pay and offer_approver (offer approval is company-wide, "all roles", until hiring managers
--   are assigned per role after go-live).
-- * Mapping from today's app_role: owner → super_admin · lead → hr + see_pay + offer_approver · junior → recruiter ·
--   approver → manager + offer_approver · member → recruiter.
--   Plus: every company keeps at least one Super admin. A company created in "lead + juniors" setup has its creator
--   stored as 'lead', not 'owner' (create_company_for_me), so where a company has no owner, its first signed-in lead
--   (the person who created it) is also Super admin.
-- * app_role stays for one release as a READ-ONLY MIRROR worked out from the roles, so every existing rule
--   (is_admin, can_approve, Desk tools) behaves exactly as before go-live. Clients can't write it, the flags or member_role.
-- * Roles change only through set_member_roles / invite_member: Super admin only, audited, never your own.
-- * Invites: invite_member adds a person by email; they join the inviting company the first time they sign in
--   (claim_my_invite). No email is sent.
-- Re-runnable. All people in tests are fictional.

alter table member add column if not exists see_pay boolean not null default false;
alter table member add column if not exists offer_approver boolean not null default false;
alter table member add column if not exists invited_at timestamptz;
alter table member add column if not exists invited_by uuid references auth.users(id) on delete set null;

create table if not exists member_role (
  member_id uuid not null references member(id) on delete cascade,
  company_id uuid not null references company(id) on delete cascade,
  role text not null check (role in ('super_admin', 'hr', 'recruiter', 'manager')),
  granted_by uuid references auth.users(id) on delete set null,
  granted_at timestamptz not null default now(),
  primary key (member_id, role));
create index if not exists member_role_company on member_role(company_id);
alter table member_role enable row level security;
drop policy if exists member_role_read on member_role;
create policy member_role_read on member_role for select to authenticated using (company_id in (select my_company_ids()));
revoke insert, update, delete, truncate on member_role from anon, authenticated;

-- ---------- the mapping, both ways (plain functions, not callable by clients) ----------
create or replace function role_keys() returns text[] language sql immutable as $$ select array['super_admin', 'hr', 'recruiter', 'manager'] $$;

-- today's app_role → (roles, see_pay, offer_approver)
create or replace function roles_from_app_role(p text) returns jsonb language sql immutable as $$
  select case p
    when 'owner'    then '{"roles":["super_admin"],"see_pay":false,"offer_approver":false}'
    when 'lead'     then '{"roles":["hr"],"see_pay":true,"offer_approver":true}'
    when 'junior'   then '{"roles":["recruiter"],"see_pay":false,"offer_approver":false}'
    when 'approver' then '{"roles":["manager"],"see_pay":false,"offer_approver":true}'
    else                 '{"roles":["recruiter"],"see_pay":false,"offer_approver":false}' end::jsonb
$$;

-- roles + flags → the app_role mirror that today's rules read (owner and lead are admins; owner, lead, approver approve)
create or replace function app_role_mirror(p_roles text[], p_offer_approver boolean) returns text language sql immutable as $$
  select case
    when 'super_admin' = any(p_roles) then 'owner'
    when 'hr' = any(p_roles) and p_offer_approver then 'lead'
    when p_offer_approver then 'approver'
    when 'hr' = any(p_roles) or 'recruiter' = any(p_roles) then 'junior'
    else 'member' end
$$;
revoke all on function role_keys() from public, anon, authenticated;
revoke all on function roles_from_app_role(text) from public, anon, authenticated;
revoke all on function app_role_mirror(text[], boolean) from public, anon, authenticated;

-- ---------- guards on member ----------
-- Clients (signed-in users writing directly) can't set roles, flags or invites. Only the functions below can.
revoke insert on member from anon, authenticated;
create or replace function guard_member_roles() returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    if current_user = 'authenticated' and exists (select 1 from member_role r where r.member_id = old.id and r.role = 'super_admin') then
      if not has_role(old.company_id, 'super_admin') then raise exception 'Only a Super admin can remove a Super admin'; end if;
      if not exists (select 1 from member_role r where r.company_id = old.company_id and r.role = 'super_admin' and r.member_id <> old.id) then
        raise exception 'Your workspace needs at least one Super admin'; end if;
    end if;
    return old;
  end if;
  if current_user = 'authenticated' and (new.app_role is distinct from old.app_role or new.see_pay is distinct from old.see_pay
     or new.offer_approver is distinct from old.offer_approver or new.invited_at is distinct from old.invited_at or new.invited_by is distinct from old.invited_by) then
    raise exception 'Roles are set by a Super admin in Settings → People';
  end if;
  return new;
end $$;
drop trigger if exists guard_member_roles on member;
create trigger guard_member_roles before update or delete on member for each row execute function guard_member_roles();

-- A member created anywhere else (sign-up, sample access, seed, SQL editor) gets the roles mapped from its app_role.
-- invite_member sets clearstage.role_sync and writes its roles itself.
create or replace function map_member_roles() returns trigger language plpgsql security definer set search_path = public as $$
declare m jsonb;
begin
  if coalesce(current_setting('clearstage.role_sync', true), '') = 'on' then return null; end if;
  if tg_op = 'UPDATE' and new.app_role is not distinct from old.app_role then return null; end if;
  m := roles_from_app_role(new.app_role);
  delete from member_role where member_id = new.id;
  insert into member_role(member_id, company_id, role) select new.id, new.company_id, r from jsonb_array_elements_text(m->'roles') r;
  -- the company's creator: a signed-in lead in a company with no Super admin yet
  if tg_op = 'INSERT' and new.app_role = 'lead' and new.user_id is not null
     and not exists (select 1 from member_role x where x.company_id = new.company_id and x.role = 'super_admin') then
    insert into member_role(member_id, company_id, role) values (new.id, new.company_id, 'super_admin');
  end if;
  perform set_config('clearstage.role_sync', 'on', true);
  update member set see_pay = (m->>'see_pay')::boolean, offer_approver = (m->>'offer_approver')::boolean where id = new.id;
  perform set_config('clearstage.role_sync', '', true);
  return null;
end $$;
drop trigger if exists map_member_roles on member;
create trigger map_member_roles after insert or update of app_role on member for each row execute function map_member_roles();

-- member_role rows must belong to the member's own company
create or replace function member_role_company() returns trigger language plpgsql set search_path = public as $$
begin
  if not exists (select 1 from member m where m.id = new.member_id and m.company_id = new.company_id) then
    raise exception 'A role must be in the person''s own company'; end if;
  return new;
end $$;
drop trigger if exists member_role_company on member_role;
create trigger member_role_company before insert or update on member_role for each row execute function member_role_company();

-- ---------- the mapping migration: every existing member gets roles from today's app_role ----------
do $$ declare m record; j jsonb; begin
  perform set_config('clearstage.role_sync', 'on', true);
  for m in select * from member mm where not exists (select 1 from member_role r where r.member_id = mm.id) loop
    j := roles_from_app_role(m.app_role);
    insert into member_role(member_id, company_id, role) select m.id, m.company_id, r from jsonb_array_elements_text(j->'roles') r;
    update member set see_pay = (j->>'see_pay')::boolean, offer_approver = (j->>'offer_approver')::boolean where id = m.id;
  end loop;
  -- every company keeps a Super admin: where there is no owner, the first signed-in lead (its creator)
  insert into member_role(member_id, company_id, role)
  select distinct on (mm.company_id) mm.id, mm.company_id, 'super_admin' from member mm
  where mm.app_role = 'lead' and mm.user_id is not null
    and not exists (select 1 from member_role x where x.company_id = mm.company_id and x.role = 'super_admin')
  order by mm.company_id, mm.created_at
  on conflict do nothing;
  perform set_config('clearstage.role_sync', '', true);
end $$;

-- ---------- helpers ----------
/** Does the signed-in user hold this role in this company? */
create or replace function has_role(p_company uuid, p_role text) returns boolean
language sql stable security definer set search_path = public as $$
  select session_fresh() and exists (select 1 from member m join member_role r on r.member_id = m.id
    where m.company_id = p_company and m.user_id = auth.uid() and r.role = p_role)
$$;
revoke all on function has_role(uuid, text) from public, anon; grant execute on function has_role(uuid, text) to authenticated;

/** The signed-in user's roles and flags in their own company (the switcher's company is checked separately). */
create or replace function my_roles() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare me member := current_member();
begin
  if me.id is null then return null; end if;
  return jsonb_build_object('member_id', me.id, 'company_id', me.company_id,
    'roles', coalesce((select jsonb_agg(r.role order by array_position(role_keys(), r.role)) from member_role r where r.member_id = me.id), '[]'),
    'see_pay', me.see_pay, 'offer_approver', me.offer_approver);
end $$;
revoke all on function my_roles() from public, anon; grant execute on function my_roles() to authenticated;

/** Settings → People: everyone in the signed-in user's own company, with roles and flags. */
create or replace function company_people() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare me member := current_member();
begin
  if me.id is null then return '[]'::jsonb; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.full_name, 'email', m.email, 'title', m.title,
      'roles', coalesce((select jsonb_agg(r.role order by array_position(role_keys(), r.role)) from member_role r where r.member_id = m.id), '[]'),
      'see_pay', m.see_pay, 'offer_approver', m.offer_approver, 'is_me', m.id = me.id,
      'login', case when m.user_id is not null then 'yes' when m.invited_at is not null then 'invited' else 'no' end)
    order by (m.id <> me.id), m.full_name) from member m where m.company_id = me.company_id), '[]'::jsonb);
end $$;
revoke all on function company_people() from public, anon; grant execute on function company_people() to authenticated;

-- Writes one person's roles and flags, keeps the mirror in step and logs it. Callers have checked who may do this.
create or replace function apply_member_roles(p_member uuid, p_roles text[], p_see_pay boolean, p_offer_approver boolean, p_action text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare m member; before jsonb; after jsonb; rs text[];
begin
  select * into m from member where id = p_member;
  select array_agg(distinct r order by r) into rs from unnest(coalesce(p_roles, '{}')) r;
  if rs is null or cardinality(rs) = 0 then raise exception 'Pick at least one role'; end if;
  if exists (select 1 from unnest(rs) r where not r = any(role_keys())) then raise exception 'Unknown role: %', (select string_agg(r, ', ') from unnest(rs) r where not r = any(role_keys())); end if;
  before := jsonb_build_object('roles', coalesce((select jsonb_agg(r.role order by r.role) from member_role r where r.member_id = m.id), '[]'), 'see_pay', m.see_pay, 'offer_approver', m.offer_approver, 'app_role', m.app_role);
  if 'super_admin' <> all(rs) and 'super_admin' = any(array(select role from member_role where member_id = m.id))
     and not exists (select 1 from member_role r where r.company_id = m.company_id and r.role = 'super_admin' and r.member_id <> m.id) then
    raise exception 'Your workspace needs at least one Super admin';
  end if;
  perform set_config('clearstage.role_sync', 'on', true);
  delete from member_role where member_id = m.id and role <> all(rs);
  insert into member_role(member_id, company_id, role, granted_by) select m.id, m.company_id, r, auth.uid() from unnest(rs) r on conflict do nothing;
  update member set see_pay = coalesce(p_see_pay, false), offer_approver = coalesce(p_offer_approver, false),
    app_role = app_role_mirror(rs, coalesce(p_offer_approver, false)) where id = m.id;
  perform set_config('clearstage.role_sync', '', true);
  after := jsonb_build_object('roles', to_jsonb(rs), 'see_pay', coalesce(p_see_pay, false), 'offer_approver', coalesce(p_offer_approver, false),
    'app_role', app_role_mirror(rs, coalesce(p_offer_approver, false)));
  insert into audit_event(company_id, actor_kind, action, detail)
    values (m.company_id, 'human', p_action, jsonb_build_object('member', m.id, 'name', m.full_name, 'by', auth.uid(), 'from', before, 'to', after));
  return jsonb_build_object('member_id', m.id) || after;
end $$;
revoke all on function apply_member_roles(uuid, text[], boolean, boolean, text) from public, anon, authenticated;

/** Super admin only, own company only, never your own roles. Audited as roles_changed. */
create or replace function set_member_roles(p_member uuid, p_roles text[], p_see_pay boolean default false, p_offer_approver boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me member := current_member(); m member;
begin
  if me.id is null then raise exception 'No workspace'; end if;
  select * into m from member where id = p_member and company_id = me.company_id;
  if m.id is null then raise exception 'That person isn''t in your workspace'; end if;
  if not has_role(me.company_id, 'super_admin') then raise exception 'Only a Super admin can change roles'; end if;
  if m.id = me.id or m.user_id = auth.uid() then raise exception 'You can''t change your own role'; end if;
  return apply_member_roles(m.id, p_roles, p_see_pay, p_offer_approver, 'roles_changed');
end $$;
revoke all on function set_member_roles(uuid, text[], boolean, boolean) from public, anon; grant execute on function set_member_roles(uuid, text[], boolean, boolean) to authenticated;

/** Super admin only: adds a person to the own company with roles. They join when they first sign in with that email. */
create or replace function invite_member(p_name text, p_email text, p_roles text[], p_see_pay boolean default false, p_offer_approver boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me member := current_member(); e text := lower(trim(coalesce(p_email, ''))); n text := regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g');
  uid uuid; mid uuid; r jsonb; sample boolean;
begin
  if me.id is null then raise exception 'No workspace'; end if;
  select is_sample into sample from company where id = me.company_id;
  if sample then raise exception 'You can''t invite people to the sample company'; end if;
  if not has_role(me.company_id, 'super_admin') then raise exception 'Only a Super admin can invite people'; end if;
  if e !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then raise exception 'Enter a valid email address'; end if;
  if not looks_like_name(n) then raise exception 'Enter their name as people know them, like "Ritu Sharma"'; end if;
  if exists (select 1 from member where company_id = me.company_id and lower(email) = e) then raise exception '% is already in your workspace', e; end if;
  select id into uid from auth.users where lower(email) = e;
  if uid is not null and exists (select 1 from member m join company c on c.id = m.company_id where m.user_id = uid and not c.is_sample) then
    raise exception '% already has their own Clearstage workspace', e;
  end if;
  perform set_config('clearstage.role_sync', 'on', true);
  insert into member(company_id, user_id, full_name, email, app_role, invited_at, invited_by)
    values (me.company_id, uid, n, e, 'member', now(), auth.uid()) returning id into mid;
  perform set_config('clearstage.role_sync', '', true);
  r := apply_member_roles(mid, p_roles, p_see_pay, p_offer_approver, 'member_invited');
  return r || jsonb_build_object('email', e, 'pending', uid is null);
end $$;
revoke all on function invite_member(text, text, text[], boolean, boolean) from public, anon; grant execute on function invite_member(text, text, text[], boolean, boolean) to authenticated;

/** At sign-in: someone with no workspace of their own joins the company that invited them (latest invite). */
create or replace function claim_my_invite() returns uuid
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); e text; m member;
begin
  if uid is null or not session_fresh() then return null; end if;
  if exists (select 1 from member mm join company c on c.id = mm.company_id where mm.user_id = uid and not c.is_sample) then return null; end if;
  select lower(email) into e from auth.users where id = uid;
  if e is null then return null; end if;
  select mm.* into m from member mm join company c on c.id = mm.company_id
    where lower(mm.email) = e and mm.user_id is null and mm.invited_at is not null and not c.is_sample order by mm.invited_at desc limit 1;
  if m.id is null then return null; end if;
  update member set user_id = uid where id = m.id;
  insert into audit_event(company_id, actor_kind, action, detail) values (m.company_id, 'human', 'invite_accepted', jsonb_build_object('member', m.id, 'email', e));
  return m.company_id;
end $$;
revoke all on function claim_my_invite() from public, anon; grant execute on function claim_my_invite() to authenticated;

-- SEC-1: every table with row-level security also carries the restrictive fresh-session policy (as in 010)
do $$ declare t record; begin
  for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity loop
    execute format('drop policy if exists session_fresh on public.%I', t.relname);
    execute format('create policy session_fresh on public.%I as restrictive for all to authenticated using ((select public.session_fresh())) with check ((select public.session_fresh()))', t.relname);
  end loop;
end $$;
