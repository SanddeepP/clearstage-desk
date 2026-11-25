-- SEC-1 (CTO 22 Nov), migrations 009 + 010: the database refuses a session that is older than 12 hours, unknown,
-- or missing, even when the browser timeout is bypassed. Uses the founder test user from desk_tools.sql.
\set ON_ERROR_STOP on
reset role;
-- a second, back-dated session for the same user (signed in 13 hours ago), and a session that belongs to someone else
insert into auth.sessions(id, user_id, created_at) values
  ('dddddddd-0000-4000-8000-000000000013', 'aaaaaaaa-0000-4000-8000-000000000001', now() - interval '13 hours'),
  ('dddddddd-0000-4000-8000-000000000011', 'aaaaaaaa-0000-4000-8000-000000000001', now() - interval '11 hours 50 minutes'),
  ('dddddddd-0000-4000-8000-0000000000bb', 'bbbbbbbb-0000-4000-8000-000000000001', now())
on conflict do nothing;
do $$ begin
  if (select count(*) from pg_policies where schemaname = 'public' and policyname = 'session_fresh' and permissive = 'RESTRICTIVE')
     < (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity)
  then raise exception 'FAILED: a table with RLS has no restrictive session_fresh policy'; end if;
end $$;

set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000001';

-- 1. a fresh session (signed in just now) works
set request.jwt.claim.session_id = 'aaaaaaaa-0000-4000-8000-000000000001';
do $$ begin
  if not session_fresh() then raise exception 'FAILED: fresh session refused'; end if;
  if (select count(*) from person) = 0 then raise exception 'FAILED: fresh session sees no rows'; end if;
  if (current_member()).id is null then raise exception 'FAILED: fresh session has no member'; end if;
  if not (session_status()->>'fresh')::boolean then raise exception 'FAILED: status not fresh'; end if;
end $$;

-- 2. eleven hours fifty minutes in: still allowed
set request.jwt.claim.session_id = 'dddddddd-0000-4000-8000-000000000011';
do $$ begin if not session_fresh() or (select count(*) from person) = 0 then raise exception 'FAILED: 11h50 session refused'; end if; end $$;

-- 3. thirteen hours old: every table reads empty, writes are refused, and Desk tools raise
set request.jwt.claim.session_id = 'dddddddd-0000-4000-8000-000000000013';
do $$ begin
  if session_fresh() then raise exception 'FAILED: 13-hour session counted as fresh'; end if;
  if (select count(*) from person) <> 0 or (select count(*) from offer) <> 0 or (select count(*) from member) <> 0
  then raise exception 'FAILED: stale session can still read rows'; end if;
  if (session_status()->>'age_minutes')::int < 779 then raise exception 'FAILED: status age'; end if;
end $$;
do $$ begin perform current_member(); raise exception 'SHOULD HAVE FAILED';
exception when others then if sqlerrm like 'SHOULD%' then raise; end if;
  if sqlerrm not like 'Your session has expired%' then raise exception 'FAILED: wrong message %', sqlerrm; end if; raise notice 'stale: current_member refused'; end $$;
do $$ begin perform desk_save_offer((select gen_random_uuid()), '{"ctc":1200000}'); raise exception 'SHOULD HAVE FAILED';
exception when others then if sqlerrm like 'SHOULD%' then raise; end if;
  if sqlerrm not like 'Your session has expired%' then raise exception 'FAILED: desk tool gave %', sqlerrm; end if; raise notice 'stale: desk tool refused'; end $$;
do $$ declare n int; begin
  update person set full_name = full_name where true; get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAILED: stale session updated % rows', n; end if; raise notice 'stale: update touched 0 rows';
end $$;
do $$ begin perform create_company_for_me('Stale Co', 'Hyderabad', 'Stale', null, 'solo', 'IN', 'IN-TG', 'Asia/Kolkata'); raise exception 'SHOULD HAVE FAILED';
exception when others then if sqlerrm like 'SHOULD%' then raise; end if;
  if sqlerrm not like 'Your session has expired%' then raise exception 'FAILED: create_company gave %', sqlerrm; end if; raise notice 'stale: create company refused'; end $$;

-- 4. a session id that belongs to someone else, a made-up one, or none at all: refused
set request.jwt.claim.session_id = 'dddddddd-0000-4000-8000-0000000000bb';
do $$ begin if session_fresh() or (select count(*) from person) <> 0 then raise exception 'FAILED: another user''s session accepted'; end if; end $$;
set request.jwt.claim.session_id = 'eeeeeeee-0000-4000-8000-000000000000';
do $$ begin if session_fresh() then raise exception 'FAILED: unknown session accepted'; end if; end $$;
set request.jwt.claim.session_id = 'not-a-uuid';
do $$ begin if session_fresh() then raise exception 'FAILED: malformed session id accepted'; end if; end $$;

-- 5. back to a fresh session: everything works again (nothing was damaged)
set request.jwt.claim.session_id = 'aaaaaaaa-0000-4000-8000-000000000001';
do $$ begin if (select count(*) from person) = 0 then raise exception 'FAILED: fresh session after stale'; end if; end $$;
reset role;
reset request.jwt.claim.session_id;
select 'SESSION TIMEOUT (SEC-1) CHECKS PASSED';
