-- CTO ruling 25 Nov "Global-ready company settings", G1 tests: a UK company (GB, GBP, Europe/London, en-GB).
-- No Indian rule applies; the scheduler and working-hours clock use London hours and bank holidays; the manual
-- Annexure carries its label; sign-up needs a country and a time zone. Runs after isolation.sql and sample_access.sql.
-- All people and companies here are fictional.
\set ON_ERROR_STOP on
reset role;
insert into auth.users values ('dddddddd-0000-4000-8000-000000000001', 'alex@brithire.test') on conflict do nothing;
create temp table g(k text primary key, v text); grant select, insert, update on g to authenticated;
insert into g values ('IN', (select id::text from company where name = 'Rycruit'));

set role authenticated;
set request.jwt.claim.sub = 'dddddddd-0000-4000-8000-000000000001';

-- 1. Sign-up needs a country and a time zone, and checks them
do $$ begin perform create_company_for_me('Brit Hire Ltd', 'London', 'Alex', null, 'solo', null, null, 'Europe/London'); raise exception 'SHOULD HAVE FAILED';
exception when others then if sqlerrm not like '%country%' then raise exception 'FAILED: no country: %', sqlerrm; end if; end $$;
do $$ begin perform create_company_for_me('Brit Hire Ltd', 'London', 'Alex', null, 'solo', 'GB', 'GB-ENG', null); raise exception 'SHOULD HAVE FAILED';
exception when others then if sqlerrm not like '%time zone%' then raise exception 'FAILED: no time zone: %', sqlerrm; end if; end $$;
do $$ begin perform create_company_for_me('Brit Hire Ltd', 'London', 'Alex', null, 'solo', 'GB', 'GB-ENG', 'Mars/Olympus'); raise exception 'SHOULD HAVE FAILED';
exception when others then if sqlerrm not like '%time zone name%' then raise exception 'FAILED: bad time zone: %', sqlerrm; end if; end $$;
do $$ begin perform create_company_for_me('Brit Hire Ltd', 'London', 'Alex', null, 'solo', 'GB', 'IN-TG', 'Europe/London'); raise exception 'SHOULD HAVE FAILED';
exception when others then if sqlerrm not like '%must be in United Kingdom%' then raise exception 'FAILED: region outside country: %', sqlerrm; end if; end $$;
do $$ begin perform create_company_for_me('Brit Hire Ltd', 'London', 'Alex', null, 'solo', 'ZZ', null, 'Europe/London'); raise exception 'SHOULD HAVE FAILED';
exception when others then if sqlerrm not like '%doesn''t support the country%' then raise exception 'FAILED: unknown country: %', sqlerrm; end if; end $$;

insert into g values ('GB', create_company_for_me('Brit Hire Ltd (fictional)', 'London', 'Alex', '+447700900123', 'solo', 'gb', 'gb-eng', 'Europe/London')::text);
do $$ declare r jsonb := my_company_region(); begin
  if r->>'country' <> 'GB' or r->>'currency' <> 'GBP' or r->>'locale' <> 'en-GB' or r->>'timezone' <> 'Europe/London'
     or r->>'state_region' <> 'GB-ENG' or r->>'holiday_calendar' <> 'GB-ENG' or r->>'data_region' <> 'ap-south-1'
     or (r->>'statutory_pack')::boolean or r->'working_week'->>'end' <> '17:30' or jsonb_array_length(r->'working_week'->'days') <> 5 then
    raise exception 'FAILED: UK company fields: %', r;
  end if;
end $$;

-- 2. Owner can't move the data region; bad edits are refused
do $$ begin update company set data_region = 'eu-west-2'; raise exception 'SHOULD HAVE FAILED';
exception when others then if sqlerrm not like '%data region%' then raise exception 'FAILED: data region: %', sqlerrm; end if; end $$;
do $$ begin update company set timezone = 'Nowhere/Town'; raise exception 'SHOULD HAVE FAILED';
exception when others then if sqlerrm not like '%time zone name%' then raise exception 'FAILED: bad tz edit: %', sqlerrm; end if; end $$;
do $$ begin update company set working_week = '{"days":[1,2,3,4,5],"start":"18:00","end":"09:00"}'; raise exception 'SHOULD HAVE FAILED';
exception when others then if sqlerrm not like 'Working week%' then raise exception 'FAILED: working week: %', sqlerrm; end if; end $$;

-- 3. No Indian rule applies: the calculator refuses; the manual Annexure works with its label; GBP is stored
select desk_create_role('Account Manager', 'London', 1, 40000, 50000) is not null;
insert into g values ('app', (desk_add_candidate('Jordan Example', (select id from role where title = 'Account Manager'), null, null, true)->>'application_id'));
do $$ begin perform desk_save_offer((select v::uuid from g where k = 'app'), '{"ctc":45000,"basic_monthly":3000}', false); raise exception 'SHOULD HAVE FAILED';
exception when others then if sqlerrm not like 'No statutory rules for United Kingdom yet%' then raise exception 'FAILED: Indian calculator ran for a UK company: %', sqlerrm; end if; end $$;
do $$ begin perform ctc_breakup('{"ctc":45000,"basic_monthly":3000}', '2026-12-01', 'GB', 'GB-ENG'); raise exception 'SHOULD HAVE FAILED';
exception when others then if sqlerrm not like 'No statutory rules for United Kingdom%' then raise exception 'FAILED: ctc_breakup GB: %', sqlerrm; end if; end $$;
do $$ begin perform save_manual_offer((select v::uuid from g where k = 'app'), '[{"name":"Base salary","amount":42000},{"name":"Pension (employer)","amount":2000}]', 45000); raise exception 'SHOULD HAVE FAILED';
exception when others then if sqlerrm not like 'The lines add up to 44000 but the CTC is 45000%' then raise exception 'FAILED: arithmetic check: %', sqlerrm; end if; end $$;
do $$ declare r jsonb := save_manual_offer((select v::uuid from g where k = 'app'),
       '[{"name":"Base salary","amount":42000},{"name":"Pension (employer)","amount":3000}]', 45000, '2027-01-11'); o offer; begin
  select * into o from offer where id = (r->>'offer_id')::uuid;
  if o.currency <> 'GBP' or o.ctc <> 45000 then raise exception 'FAILED: offer currency/ctc: % %', o.currency, o.ctc; end if;
  if o.manual_label <> 'No statutory rules for United Kingdom yet: figures entered by Alex' then raise exception 'FAILED: label: %', o.manual_label; end if;
  if (o.wages_check->>'applicable')::boolean or not (o.wages_check->>'passes')::boolean or not (o.wages_check->'not_applicable') ? 'PF'
     or not (o.wages_check->'not_applicable') ? '50% wages check' or o.wages_check->>'label' <> o.manual_label then
    raise exception 'FAILED: manual check: %', o.wages_check; end if;
  if exists (select 1 from jsonb_array_elements(o.components) c where c->>'kind' <> 'manual') then raise exception 'FAILED: statutory lines on a manual offer'; end if;
end $$;
do $$ begin update offer set inputs = '{"ctc":45000}' where company_id = (select v::uuid from g where k = 'GB'); raise exception 'SHOULD HAVE FAILED';
exception when others then if sqlerrm not like 'No statutory rules for United Kingdom yet%' then raise exception 'FAILED: inputs on a UK offer: %', sqlerrm; end if; end $$;
do $$ begin update offer set manual_label = null where company_id = (select v::uuid from g where k = 'GB'); raise exception 'SHOULD HAVE FAILED';
exception when others then if sqlerrm not like 'Manual Annexure lines must say who%' then raise exception 'FAILED: unlabelled manual offer: %', sqlerrm; end if; end $$;

-- 4. Isolation re-run for the UK company: it sees only itself, and India sees nothing of it
do $$ begin
  if (select count(*) from company) <> 1 then raise exception 'FAILED: UK company sees other companies'; end if;
  if exists (select 1 from offer where company_id <> (select v::uuid from g where k = 'GB')) then raise exception 'FAILED: UK sees other offers'; end if;
  if exists (select 1 from person where company_id <> (select v::uuid from g where k = 'GB')) then raise exception 'FAILED: UK sees other people'; end if;
end $$;
reset role;
select set_config('request.jwt.claim.sub', (select user_id::text from member where company_id = (select v::uuid from g where k = 'IN') order by created_at limit 1), false);
set role authenticated;
do $$ begin
  if exists (select 1 from company where id = (select v::uuid from g where k = 'GB')) then raise exception 'FAILED: India sees the UK company'; end if;
  if exists (select 1 from offer where currency = 'GBP') then raise exception 'FAILED: India sees UK offers'; end if;
  -- India is unchanged: pack 1, rupees, Telangana professional tax
  if not (my_company_region()->>'statutory_pack')::boolean or my_company_region()->>'currency' <> 'INR' then raise exception 'FAILED: India region: %', my_company_region(); end if;
  if ((ctc_breakup('{"ctc":1200000,"basic_monthly":35000}', '2026-12-01')->'check'->>'wages_percent')::numeric <> 35.6) then raise exception 'FAILED: Kiran draft changed'; end if;
  if (ctc_breakup('{"ctc":1200000,"basic_monthly":50000}', '2026-12-01')->'monthly'->>'professional_tax')::int <> 200 then raise exception 'FAILED: Telangana PT'; end if;
  if not exists (select 1 from jsonb_array_elements_text(ctc_breakup('{"ctc":1200000,"basic_monthly":50000}', '2026-12-01', 'IN', 'IN-KA')->'warnings') w
                 where w like 'No professional tax rule for IN-KA%') then raise exception 'FAILED: missing-PT warning'; end if;
end $$;
do $$ begin perform save_manual_offer((select id from application limit 1), '[{"name":"Basic","amount":100}]', 100); raise exception 'SHOULD HAVE FAILED';
exception when others then if sqlerrm not like 'Your company uses the India statutory rules%' then raise exception 'FAILED: manual Annexure in India: %', sqlerrm; end if; end $$;
reset role;
do $$ begin if exists (select 1 from offer o join company c on c.id = o.company_id where o.currency <> c.currency) then raise exception 'FAILED: an offer in another currency'; end if; end $$;

-- 5. Working time and the scheduler use London hours and English bank holidays (as the database, not a client)
do $$ declare uk uuid := (select v::uuid from g where k = 'GB'); inn uuid := (select v::uuid from g where k = 'IN'); begin
  if company_is_working(uk, '2026-12-02 08:30+00') then raise exception 'FAILED: London 08:30 is working'; end if;
  if not company_is_working(uk, '2026-12-02 10:00+00') then raise exception 'FAILED: London 10:00 Wed not working'; end if;
  if company_is_working(uk, '2026-12-02 17:45+00') then raise exception 'FAILED: London 17:45 is working'; end if;
  if company_is_working(uk, '2026-12-05 10:00+00') then raise exception 'FAILED: London Saturday is working'; end if;
  if company_is_working(uk, '2026-12-28 10:00+00') then raise exception 'FAILED: Boxing Day substitute is working'; end if;
  if not company_is_working(uk, '2026-07-01 08:30+00') then raise exception 'FAILED: BST (09:30 London) not working'; end if;
  if not company_is_working(inn, '2026-12-02 10:00+00') then raise exception 'FAILED: India 15:30 IST not working'; end if;
  if not company_is_working(inn, '2026-12-05 10:00+00') then raise exception 'FAILED: India Saturday not working'; end if;
  if add_working_hours(uk, '2026-12-02 16:30+00', 2) <> '2026-12-03 10:00+00' then raise exception 'FAILED: UK +2h: %', add_working_hours(uk, '2026-12-02 16:30+00', 2); end if;
  if add_working_hours(uk, '2026-12-24 17:00+00', 1) <> '2026-12-29 09:30+00' then raise exception 'FAILED: UK over Christmas: %', add_working_hours(uk, '2026-12-24 17:00+00', 1); end if;
  if add_working_hours(uk, '2026-12-02 10:00+00', 12) <> '2026-12-03 13:30+00' then raise exception 'FAILED: UK 12 working hours: %', add_working_hours(uk, '2026-12-02 10:00+00', 12); end if;
  if add_working_hours(inn, '2026-12-02 13:00+00', 1) <> '2026-12-03 04:00+00' then raise exception 'FAILED: India +1h: %', add_working_hours(inn, '2026-12-02 13:00+00', 1); end if;
  if working_hours_between(uk, '2026-12-02 09:00+00', '2026-12-03 09:00+00') <> 8.5 then raise exception 'FAILED: UK hours between'; end if;
  if working_hours_between(inn, '2026-12-02 03:30+00', '2026-12-03 03:30+00') <> 10 then raise exception 'FAILED: India hours between'; end if;
end $$;

with t as (
  insert into task(company_id, title, kind, owner_id, due_at)
  values ((select v::uuid from g where k = 'GB'), 'Send feedback on Jordan Example', 'feedback',
          (select id from member where company_id = (select v::uuid from g where k = 'GB')), '2026-12-01 12:00+00') returning id)
insert into g select 'task', id::text from t;
do $$ declare tid uuid := (select v::uuid from g where k = 'task'); n int; begin
  select count(*) into n from run_task_scheduler('2026-12-02 08:30+00') r where r.task_id = tid;
  if n <> 0 then raise exception 'FAILED: UK reminder sent at 08:30 London'; end if;
  select count(*) into n from run_task_scheduler('2026-12-05 11:00+00') r where r.task_id = tid;
  if n <> 0 then raise exception 'FAILED: UK reminder sent on a Saturday'; end if;
  select count(*) into n from run_task_scheduler('2026-12-02 10:00+00') r where r.task_id = tid and r.action = 'reminded';
  if n <> 1 then raise exception 'FAILED: UK reminder not sent at 10:00 London'; end if;
  update task set last_reminded_at = null where id = tid;
  select count(*) into n from run_task_scheduler('2026-12-28 10:00+00') r where r.task_id = tid;
  if n <> 0 then raise exception 'FAILED: UK reminder sent on a bank holiday'; end if;
end $$;

-- 6. Chase cooldown message names London time, not IST
set role authenticated;
set request.jwt.claim.sub = 'dddddddd-0000-4000-8000-000000000001';
select desk_chase_owner((select v::uuid from g where k = 'task')) is not null;
do $$ begin perform desk_chase_owner((select v::uuid from g where k = 'task')); raise exception 'SHOULD HAVE FAILED';
exception when others then if sqlerrm !~ 'already chased at [0-9:]+ (GMT|BST)\.' then raise exception 'FAILED: chase message: %', sqlerrm; end if; end $$;
reset role;
select 'GLOBAL-READY (UK COMPANY) CHECKS PASSED';
