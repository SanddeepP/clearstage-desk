-- Checks for 006 (C2 allow-list, C5 database check). Run after desk_tools.sql on the same database.
\set ON_ERROR_STOP on
reset role;
set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000001';
select 'new company starts off', desk_live_enabled() = false;
-- an owner can't switch the live agent on for themselves
do $$ begin update company set desk_enabled = true where id = (current_member()).company_id; raise exception 'SHOULD HAVE FAILED';
exception when others then if sqlerrm like 'SHOULD%' then raise; end if; raise notice 'blocked as expected: %', sqlerrm; end $$;
-- a direct insert can't sneak it in either
reset role;
insert into auth.users values ('cccccccc-0000-4000-8000-000000000001','new@test.in');
set role authenticated;
set request.jwt.claim.sub = 'cccccccc-0000-4000-8000-000000000001';
select 'sign-up via setup', create_company_for_me('Sneaky Co','Pune','Ravi',null,'solo') is not null;
select 'sign-up still off', desk_live_enabled() = false;
-- Clearstage (service role / SQL editor) switches it on
reset role;
update company set desk_enabled = true where name = 'Rycruit';
set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000001';
select 'allow-listed company on', desk_live_enabled() = true;
-- other companies still off
set request.jwt.claim.sub = 'bbbbbbbb-0000-4000-8000-000000000001';
select 'other company still off', desk_live_enabled() = false;
-- C5: the client's verdict is ignored and the database's check comes back
set request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000001';
select 'c5 returns db check', (r->'check'->>'computed_by') = 'database' and (r->'check'->>'passes')::boolean = false and (r->'check'->>'wages_percent')::numeric = 36.8
from (select desk_save_offer((select a.id from application a join person p on p.id = a.person_id where p.full_name = 'Kiran S.' and a.company_id = (current_member()).company_id),
  '[{"name":"Basic + DA","kind":"basic","amount":420000},{"name":"HRA","kind":"hra","amount":210000},{"name":"Special allowance","kind":"special","amount":510000},{"name":"Employer PF","kind":"employer_pf","amount":60000}]',
  1, '{"passes":true}') r) s;
select 'ALLOW-LIST AND C5 CHECKS PASSED';
