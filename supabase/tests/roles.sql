-- Roles foundation (017) and the role probes for go-live (CTO ruling "Roles and views", 25 Nov, §2–4).
-- Probes P-SA, P-HR (mapped from lead, with pay), P-R and P-M (mapped from approver) sign in as that role in company A
-- ("Rycruit") and check the GO-LIVE permissions, which are today's rules read through the app_role mirror. Each probe also
-- checks that company B ("Other Co") gives zero rows in every company table and that nobody can change their own role.
-- P-PA (Clearstage platform admin) can manage modules and module interest, but gets nothing of A's candidates,
-- employees or offers. Runs last. All people here are fictional.
\set ON_ERROR_STOP on
reset role;
create temp table rp(k text primary key, v text); grant select, insert on rp to authenticated;
insert into rp values ('A', (select id::text from company where name = 'Rycruit')), ('B', (select id::text from company where name = 'Other Co'));
do $$ begin if (select count(*) from rp where v is not null) <> 2 then raise exception 'FAILED: companies A and B not found'; end if; end $$;

-- Fixture: an HR lead and an approver in A, created with today's app_role exactly as before 017 (server insert)
insert into auth.users values ('aaaaaaaa-0000-4000-8000-000000000003', 'hr.lead@test.in'), ('aaaaaaaa-0000-4000-8000-000000000004', 'approver@test.in'),
  ('aaaaaaaa-0000-4000-8000-000000000006', 'existing.user@test.in') on conflict do nothing;
insert into member(company_id, user_id, full_name, email, app_role)
select (select v::uuid from rp where k = 'A'), u, n, e, r from (values
  ('aaaaaaaa-0000-4000-8000-000000000003'::uuid, 'Meena Rao', 'hr.lead@test.in', 'lead'),
  ('aaaaaaaa-0000-4000-8000-000000000004'::uuid, 'Vikram Nair', 'approver@test.in', 'approver')) x(u, n, e, r)
on conflict do nothing;
insert into rp select 'm_' || split_part(email, '@', 1), id::text from member where company_id = (select v::uuid from rp where k = 'A') and user_id is not null and email is not null;
insert into rp select 'ritu', id::text from member where user_id = 'aaaaaaaa-0000-4000-8000-000000000002';
insert into rp select 'offer', id::text from offer where company_id = (select v::uuid from rp where k = 'A') limit 1;

-- 1. The mapping: every member has roles, and the mirror gives today's rights back
do $$ declare r record; a uuid := (select v::uuid from rp where k = 'A'); begin
  if exists (select 1 from member m where not exists (select 1 from member_role x where x.member_id = m.id)) then raise exception 'FAILED: a member has no role'; end if;
  for r in select m.app_role, m.see_pay, m.offer_approver, array_agg(x.role order by x.role) roles from member m join member_role x on x.member_id = m.id group by m.id loop
    if r.app_role = 'owner' and r.roles <> array['super_admin'] then raise exception 'FAILED: owner → %', r.roles; end if;
    if r.app_role = 'lead' and not ((r.roles = array['hr'] or r.roles = array['hr', 'super_admin']) and r.see_pay and r.offer_approver) then raise exception 'FAILED: lead → % pay % approver %', r.roles, r.see_pay, r.offer_approver; end if;
    if r.app_role = 'junior' and r.roles <> array['recruiter'] then raise exception 'FAILED: junior → %', r.roles; end if;
    if r.app_role = 'approver' and not (r.roles = array['manager'] and r.offer_approver and not r.see_pay) then raise exception 'FAILED: approver → %', r.roles; end if;
    if r.app_role = 'member' and r.roles <> array['recruiter'] then raise exception 'FAILED: member → %', r.roles; end if;
    -- the mirror: same admin and approval rights as today (junior and member have the same rights)
    if (app_role_mirror(r.roles, r.offer_approver) in ('owner', 'lead')) <> (r.app_role in ('owner', 'lead'))
       or (app_role_mirror(r.roles, r.offer_approver) in ('owner', 'lead', 'approver')) <> (r.app_role in ('owner', 'lead', 'approver')) then
      raise exception 'FAILED: mirror % ≠ app_role %', app_role_mirror(r.roles, r.offer_approver), r.app_role; end if;
  end loop;
  if (select count(*) from member_role x join member m on m.id = x.member_id where x.company_id <> m.company_id) > 0 then raise exception 'FAILED: a role in another company'; end if;
  -- every company with a signed-in admin has a Super admin; a lead is Super admin only as its company's creator (no owner)
  if exists (select 1 from company c where exists (select 1 from member m where m.company_id = c.id and m.user_id is not null and m.app_role in ('owner', 'lead'))
             and not exists (select 1 from member_role x where x.company_id = c.id and x.role = 'super_admin')) then raise exception 'FAILED: a company has no Super admin'; end if;
  if exists (select 1 from member m join member_role x on x.member_id = m.id and x.role = 'super_admin' where m.app_role = 'lead'
             and (exists (select 1 from member o where o.company_id = m.company_id and o.app_role = 'owner')
               or exists (select 1 from member o where o.company_id = m.company_id and o.app_role = 'lead' and o.user_id is not null and o.created_at < m.created_at))) then
    raise exception 'FAILED: a lead other than the company''s creator became Super admin'; end if;
  -- Rycruit was created in lead + juniors setup: its creator (lead) is Super admin and keeps HR, pay and offer approval
  if (select array_agg(x.role order by x.role) from member m join member_role x on x.member_id = m.id where m.user_id = 'aaaaaaaa-0000-4000-8000-000000000001' and m.company_id = a) <> array['hr', 'super_admin'] then
    raise exception 'FAILED: Rycruit''s creator isn''t Super admin'; end if;
end $$;

-- Shared probe: zero rows of another company in every company table, and no write reaches it
create or replace function public.zz_probe_other_company(p_other uuid, p_label text) returns int language plpgsql as $$
declare t record; n bigint; c int := 0; begin
  for t in select cl.relname from pg_class cl join pg_namespace s on s.oid = cl.relnamespace
           where s.nspname = 'public' and cl.relkind = 'r' and exists (select 1 from information_schema.columns k where k.table_schema = 'public' and k.table_name = cl.relname and k.column_name = 'company_id') order by 1 loop
    execute format('select count(*) from public.%I where company_id = $1', t.relname) into n using p_other;
    if n <> 0 then raise exception 'FAILED: % reads % row(s) of the other company in %', p_label, n, t.relname; end if;
    begin execute format('update public.%I set company_id = company_id where company_id = $1', t.relname) using p_other; get diagnostics n = row_count;
      if n <> 0 then raise exception 'FAILED: % updated % row(s) of the other company in %', p_label, n, t.relname; end if;
    exception when insufficient_privilege then null; end;
    begin execute format('delete from public.%I where company_id = $1', t.relname) using p_other; get diagnostics n = row_count;
      if n <> 0 then raise exception 'FAILED: % deleted % row(s) of the other company in %', p_label, n, t.relname; end if;
    exception when insufficient_privilege then null; end;
    c := c + 1;
  end loop;
  foreach t.relname in array array['super_admin', 'hr', 'recruiter', 'manager'] loop
    if has_role(p_other, t.relname) then raise exception 'FAILED: % holds % in the other company', p_label, t.relname; end if;
  end loop;
  return c;
end $$;
-- Shared probe: nobody can change their own role, by any route
create or replace function public.zz_probe_own_role(p_label text) returns void language plpgsql as $$
declare me member := current_member(); n bigint; begin
  begin perform set_member_roles(me.id, array['super_admin'], true, true); raise exception 'SHOULD HAVE FAILED';
  exception when others then if sqlerrm not in ('You can''t change your own role', 'Only a Super admin can change roles') then raise exception 'FAILED: % changed own roles: %', p_label, sqlerrm; end if; end;
  begin update member set app_role = 'owner' where id = me.id; get diagnostics n = row_count; if n <> 0 then raise exception 'FAILED: % set own app_role', p_label; end if;
  exception when others then if sqlerrm like 'FAILED%' then raise; end if; end;
  begin update member set see_pay = not see_pay, offer_approver = not offer_approver where id = me.id; get diagnostics n = row_count; if n <> 0 then raise exception 'FAILED: % set own pay/approver flags', p_label; end if;
  exception when others then if sqlerrm like 'FAILED%' then raise; end if; end;
  begin insert into member_role(member_id, company_id, role) values (me.id, me.company_id, 'super_admin'); raise exception 'FAILED: % added a role directly', p_label;
  exception when insufficient_privilege then null; end;
  begin delete from member_role where member_id = me.id; raise exception 'FAILED: % removed a role directly', p_label;
  exception when insufficient_privilege then null; end;
  begin insert into member(company_id, user_id, full_name, app_role) values (me.company_id, gen_random_uuid(), 'Planted Owner', 'owner'); raise exception 'FAILED: % inserted a member directly', p_label;
  exception when insufficient_privilege then null; end;
end $$;
grant execute on function public.zz_probe_other_company(uuid, text), public.zz_probe_own_role(text) to authenticated;

-- ===================== P-SA: Super admin (Rycruit's creator, stored as lead) =====================
set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000001';
reset request.jwt.claim.session_id;
do $$ declare a uuid := (select v::uuid from rp where k = 'A'); b uuid := (select v::uuid from rp where k = 'B'); t text; n bigint; r jsonb; ritu uuid := (select v::uuid from rp where k = 'ritu'); begin
  perform zz_probe_other_company(b, 'P-SA'); perform zz_probe_own_role('P-SA');
  if not (has_role(a, 'super_admin') and is_admin(a) and can_approve(a)) then raise exception 'FAILED: P-SA rights in A'; end if;
  foreach t in array array['person', 'application', 'offer', 'role', 'task', 'document', 'member', 'member_role', 'audit_event'] loop
    execute format('select count(*) from %I where company_id = $1', t) into n using a;
    if n = 0 then raise exception 'FAILED: P-SA can''t read % in A', t; end if;
  end loop;
  update role set title = title where company_id = a; get diagnostics n = row_count; if n = 0 then raise exception 'FAILED: P-SA can''t write in A'; end if;
  -- change someone else's roles: the mirror follows, and each change is logged
  r := set_member_roles(ritu, array['hr'], true, true);
  if r->>'app_role' <> 'lead' or (select app_role from member where id = ritu) <> 'lead' then raise exception 'FAILED: HR + offer approver mirror: %', r; end if;
  r := set_member_roles(ritu, array['manager', 'recruiter'], false, false);
  if (select app_role from member where id = ritu) <> 'junior' then raise exception 'FAILED: manager + recruiter mirror'; end if;
  r := set_member_roles(ritu, array['recruiter']);
  if (select array_agg(role) from member_role where member_id = ritu) <> array['recruiter'] or (select see_pay or offer_approver from member where id = ritu) then raise exception 'FAILED: back to recruiter'; end if;
  if (select count(*) from audit_event where company_id = a and action = 'roles_changed' and detail->>'member' = ritu::text and detail ? 'from' and detail ? 'to') < 3 then raise exception 'FAILED: role changes not audited'; end if;
  begin update member set app_role = 'owner' where id = ritu; raise exception 'SHOULD HAVE FAILED';
  exception when others then if sqlerrm <> 'Roles are set by a Super admin in Settings → People' then raise exception 'FAILED: direct app_role write: %', sqlerrm; end if; end;
  begin perform set_member_roles(ritu, array[]::text[]); raise exception 'SHOULD HAVE FAILED';
  exception when others then if sqlerrm <> 'Pick at least one role' then raise exception 'FAILED: empty roles: %', sqlerrm; end if; end;
  begin perform set_member_roles(ritu, array['employee']); raise exception 'SHOULD HAVE FAILED';
  exception when others then if sqlerrm not like 'Unknown role%' then raise exception 'FAILED: employee role: %', sqlerrm; end if; end;
  begin perform set_member_roles((select id from member where company_id = b limit 1), array['recruiter']); raise exception 'SHOULD HAVE FAILED';
  exception when others then if sqlerrm <> 'That person isn''t in your workspace' then raise exception 'FAILED: P-SA changed B''s roles: %', sqlerrm; end if; end;
  -- the last Super admin can't leave
  begin delete from member where user_id = auth.uid() and company_id = a; raise exception 'SHOULD HAVE FAILED';
  exception when others then if sqlerrm <> 'Your workspace needs at least one Super admin' then raise exception 'FAILED: last Super admin removed: %', sqlerrm; end if; end;
  -- invites
  r := invite_member('Priya Shah', 'Priya.New@test.in', array['manager'], false, true);
  if not (r->>'pending')::boolean or r->>'app_role' <> 'approver' then raise exception 'FAILED: invite: %', r; end if;
  r := invite_member('Kabir Das', 'existing.user@test.in', array['recruiter']);
  if (r->>'pending')::boolean then raise exception 'FAILED: an existing account should join straight away: %', r; end if;
  begin perform invite_member('Priya Again', 'priya.new@test.in', array['hr']); raise exception 'SHOULD HAVE FAILED';
  exception when others then if sqlerrm not like '%is already in your workspace' then raise exception 'FAILED: duplicate invite: %', sqlerrm; end if; end;
  begin perform invite_member('Asha Other', 'other@test.in', array['hr']); raise exception 'SHOULD HAVE FAILED';
  exception when others then if sqlerrm not like '%already has their own Clearstage workspace' then raise exception 'FAILED: invite of another company''s owner: %', sqlerrm; end if; end;
  begin perform invite_member('XXXX', 'x@test.in', array['hr']); raise exception 'SHOULD HAVE FAILED';
  exception when others then if sqlerrm not like 'Enter their name%' then raise exception 'FAILED: placeholder invite name: %', sqlerrm; end if; end;
  if (select count(*) from audit_event where company_id = a and action = 'member_invited') < 2 then raise exception 'FAILED: invites not audited'; end if;
  r := company_people();
  if jsonb_array_length(r) <> (select count(*) from member where company_id = a) or not (r->0->>'is_me')::boolean
     or not exists (select 1 from jsonb_array_elements(r) p where p->>'email' = 'priya.new@test.in' and p->>'login' = 'invited') then raise exception 'FAILED: company_people: %', left(r::text, 300); end if;
end $$;

-- ===================== P-HR: HR mapped from lead (see pay, offer approver) =====================
reset role; set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000003';
do $$ declare a uuid := (select v::uuid from rp where k = 'A'); b uuid := (select v::uuid from rp where k = 'B'); r jsonb := my_roles(); n bigint; begin
  perform zz_probe_other_company(b, 'P-HR'); perform zz_probe_own_role('P-HR');
  if r->'roles' <> '["hr"]' or not (r->>'see_pay')::boolean or not (r->>'offer_approver')::boolean then raise exception 'FAILED: P-HR roles: %', r; end if;
  if not has_role(a, 'hr') or has_role(a, 'super_admin') then raise exception 'FAILED: P-HR has_role'; end if;
  -- go-live: today's lead rights (admin + approve), and pay is visible
  if not (is_admin(a) and can_approve(a)) then raise exception 'FAILED: P-HR lost today''s lead rights'; end if;
  select count(*) into n from offer where company_id = a and ctc > 0; if n = 0 then raise exception 'FAILED: P-HR with pay can''t see offer amounts'; end if;
  select count(*) into n from application where company_id = a; if n = 0 then raise exception 'FAILED: P-HR can''t read Hire'; end if;
  select count(*) into n from person where company_id = a and status = 'employee'; if n = 0 then raise exception 'FAILED: P-HR can''t read employee records'; end if;
  begin perform set_member_roles((select v::uuid from rp where k = 'ritu'), array['manager']); raise exception 'SHOULD HAVE FAILED';
  exception when others then if sqlerrm <> 'Only a Super admin can change roles' then raise exception 'FAILED: P-HR changed roles: %', sqlerrm; end if; end;
  begin perform invite_member('Neha Jain', 'neha@test.in', array['hr']); raise exception 'SHOULD HAVE FAILED';
  exception when others then if sqlerrm <> 'Only a Super admin can invite people' then raise exception 'FAILED: P-HR invited: %', sqlerrm; end if; end;
  begin delete from member where company_id = a and app_role = 'owner'; get diagnostics n = row_count; if n <> 0 then raise exception 'FAILED: P-HR removed the Super admin'; end if;
  exception when others then if sqlerrm like 'FAILED%' then raise; end if; if sqlerrm <> 'Only a Super admin can remove a Super admin' then raise exception 'FAILED: P-HR remove SA: %', sqlerrm; end if; end;
end $$;

-- ===================== P-R: Recruiter (mapped from junior) =====================
reset role; set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000002';
do $$ declare a uuid := (select v::uuid from rp where k = 'A'); b uuid := (select v::uuid from rp where k = 'B'); n bigint; begin
  perform zz_probe_other_company(b, 'P-R'); perform zz_probe_own_role('P-R');
  if (my_roles())->'roles' <> '["recruiter"]' or not has_role(a, 'recruiter') then raise exception 'FAILED: P-R roles: %', my_roles(); end if;
  if is_admin(a) or can_approve(a) then raise exception 'FAILED: P-R can administer or approve'; end if;
  select count(*) into n from application where company_id = a; if n = 0 then raise exception 'FAILED: P-R can''t read Hire'; end if;
  select count(*) into n from role where company_id = a; if n = 0 then raise exception 'FAILED: P-R can''t read roles'; end if;
  begin perform desk_approve('offer', (select v::uuid from rp where k = 'offer')); raise exception 'SHOULD HAVE FAILED';
  exception when others then if sqlerrm like 'SHOULD%' then raise exception 'FAILED: P-R approved an offer'; end if; end;
  begin perform set_member_roles((select v::uuid from rp where k = 'm_hr.lead'), array['recruiter']); raise exception 'SHOULD HAVE FAILED';
  exception when others then if sqlerrm <> 'Only a Super admin can change roles' then raise exception 'FAILED: P-R changed roles: %', sqlerrm; end if; end;
  begin update member set full_name = 'Renamed By Recruiter' where company_id = a and user_id <> auth.uid(); get diagnostics n = row_count; if n <> 0 then raise exception 'FAILED: P-R edited other members'; end if; end;
end $$;

-- ===================== P-M: Manager mapped from approver (offer approver, all roles) =====================
reset role; set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000004';
do $$ declare a uuid := (select v::uuid from rp where k = 'A'); b uuid := (select v::uuid from rp where k = 'B'); r jsonb := my_roles(); begin
  perform zz_probe_other_company(b, 'P-M'); perform zz_probe_own_role('P-M');
  if r->'roles' <> '["manager"]' or not (r->>'offer_approver')::boolean or (r->>'see_pay')::boolean then raise exception 'FAILED: P-M roles: %', r; end if;
  -- go-live: a mapped approver keeps company-wide offer approval ("all roles"), and is not an admin
  if not can_approve(a) or is_admin(a) then raise exception 'FAILED: P-M rights: approve % admin %', can_approve(a), is_admin(a); end if;
  begin perform set_member_roles((select v::uuid from rp where k = 'ritu'), array['manager']); raise exception 'SHOULD HAVE FAILED';
  exception when others then if sqlerrm <> 'Only a Super admin can change roles' then raise exception 'FAILED: P-M changed roles: %', sqlerrm; end if; end;
end $$;

-- ===================== invite accepted at first sign-in =====================
reset role;
insert into auth.users values ('aaaaaaaa-0000-4000-8000-000000000005', 'priya.new@test.in') on conflict do nothing;
set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000005';
do $$ declare a uuid := (select v::uuid from rp where k = 'A'); r jsonb; begin
  if current_member() is not null and (current_member()).id is not null then raise exception 'FAILED: joined before claiming'; end if;
  if claim_my_invite() is distinct from a then raise exception 'FAILED: claim_my_invite didn''t join A'; end if;
  r := my_roles();
  if r->'roles' <> '["manager"]' or not (r->>'offer_approver')::boolean or not has_role(a, 'manager') then raise exception 'FAILED: invited roles: %', r; end if;
  if claim_my_invite() is not null then raise exception 'FAILED: claimed twice'; end if;
end $$;

-- ===================== P-PA: Clearstage platform admin =====================
reset role;
create temp table pa_secret(v text); grant select on pa_secret to authenticated;
insert into pa_secret select id::text from person where company_id = (select v::uuid from rp where k = 'A')
  union all select full_name from person where company_id = (select v::uuid from rp where k = 'A') and length(full_name) > 3
  union all select id::text from application where company_id = (select v::uuid from rp where k = 'A')
  union all select id::text from offer where company_id = (select v::uuid from rp where k = 'A')
  union all select email from member where company_id = (select v::uuid from rp where k = 'A') and email is not null;
set role authenticated;
set request.jwt.claim.sub = 'cccccccc-0000-4000-8000-0000000000ad';
do $$ declare a uuid := (select v::uuid from rp where k = 'A'); out text; begin
  if not is_platform_admin() then raise exception 'FAILED: P-PA is not platform admin'; end if;
  perform zz_probe_other_company(a, 'P-PA');
  perform set_module_state(a, 'onboard', (select c->'modules'->>'onboard' from jsonb_array_elements(platform_companies()) c where c->>'id' = a::text));
  out := platform_companies()::text || module_interest_counts()::text || coalesce(company_people()::text, '') || coalesce(my_roles()::text, '');
  if exists (select 1 from pa_secret s where position(s.v in out) > 0) then
    raise exception 'FAILED: P-PA saw A''s candidates, employees, offers or people: %', (select string_agg(v, ', ') from pa_secret s where position(s.v in out) > 0); end if;
  begin perform set_member_roles((select id from member where company_id = a limit 1), array['super_admin']); raise exception 'SHOULD HAVE FAILED';
  exception when others then if sqlerrm like 'SHOULD%' then raise exception 'FAILED: P-PA changed a client''s roles'; end if; end;
end $$;

reset role;
drop function public.zz_probe_other_company(uuid, text);
drop function public.zz_probe_own_role(text);
select 'ROLE CHECKS PASSED (mapping, P-SA, P-HR, P-R, P-M, invite, P-PA)';
