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
select 'sign-up via setup', create_company_for_me('Sneaky Co','Pune','Ravi',null,'solo','IN','IN-MH','Asia/Kolkata') is not null;
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
-- C5: the database's own check comes back. Since 008 Desk sends inputs only, so there is no client verdict to ignore.
-- Kiran's draft (CTO 21 Nov): Basic 4,20,000 · HRA 1,68,000 · Special 5,55,808 · Employer PF 36,000 · Gratuity 20,192 = 35.6%, a fail
set request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000001';
do $$ declare r jsonb; begin
  r := desk_save_offer((select a.id from application a join person p on p.id = a.person_id where p.full_name = 'Kiran S.' and a.company_id = (current_member()).company_id),
    '{"ctc":1200000,"basic_monthly":35000,"hra_pct":40,"pf_rule":"ceiling"}');
  if not ((r->'check'->>'computed_by') = 'database' and (r->'check'->>'passes')::boolean = false and (r->'check'->>'wages_percent')::numeric = 35.6
          and (select (c->>'amount')::int from jsonb_array_elements(r->'components') c where c->>'kind' = 'employer_pf') = 36000)
  then raise exception 'FAILED: c5 returns db check %', r; end if;
end $$;
select 'ALLOW-LIST AND C5 CHECKS PASSED';
