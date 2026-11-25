-- Module tabs (016): module state per company (platform admin only), the preview lock, "I need this".
-- Runs after global_ready.sql: uses its UK company (Alex, dddd…01) and the platform admin from sample_access.sql (cccc…ad).
-- All people and companies here are fictional.
\set ON_ERROR_STOP on
reset role;
create temp table mo(k text primary key, v text); grant select, insert, update on mo to authenticated;
insert into mo values ('GB', (select id::text from company where name = 'Brit Hire Ltd (fictional)')),
                      ('S', (select id::text from company where is_sample));

set role authenticated;
set request.jwt.claim.sub = 'dddddddd-0000-4000-8000-000000000001';

-- 1. Defaults, and clients can't change them
do $$ declare m jsonb := my_modules(); begin
  if m <> '{"hire":"live","onboard":"preview","probation":"preview","compliance":"soon","exit":"soon","time":"soon","payroll":"soon","performance":"soon","policies":"soon"}'::jsonb then
    raise exception 'FAILED: default module states: %', m; end if;
end $$;
do $$ begin perform set_module_state((select v::uuid from mo where k = 'GB'), 'onboard', 'live'); raise exception 'SHOULD HAVE FAILED';
exception when others then if sqlerrm not like 'Only Clearstage can switch modules%' then raise exception 'FAILED: client switched a module: %', sqlerrm; end if; end $$;
do $$ begin insert into company_module values ((select v::uuid from mo where k = 'GB'), 'onboard', 'live'); raise exception 'SHOULD HAVE FAILED';
exception when insufficient_privilege then null; end $$;
do $$ begin perform platform_companies(); raise exception 'SHOULD HAVE FAILED';
exception when others then if sqlerrm not like 'Only Clearstage%' then raise exception 'FAILED: client listed companies: %', sqlerrm; end if; end $$;

-- 2. Preview lock: a real company can't save joiners or probation records while the module isn't live
select desk_create_role('Support Lead', 'London', 1, 30000, 40000) is not null;
insert into mo values ('app', (desk_add_candidate('Morgan Example', (select id from role where title = 'Support Lead'), null, null, true)->>'application_id'));
insert into mo select 'person', person_id::text from application where id = (select v::uuid from mo where k = 'app');
do $$ declare p uuid := (select v::uuid from mo where k = 'person'); co uuid := (select v::uuid from mo where k = 'GB'); begin
  begin update person set status = 'employee', joined_on = '2027-01-11' where id = p; raise exception 'SHOULD HAVE FAILED';
  exception when others then if sqlerrm <> 'Onboard is in preview in Clearstage, so real joiners can''t be saved yet.' then raise exception 'FAILED: joiner lock: %', sqlerrm; end if; end;
  begin insert into task(company_id, title, kind) values (co, 'Appointment letter', 'appointment_letter'); raise exception 'SHOULD HAVE FAILED';
  exception when others then if sqlerrm not like 'Onboard is in preview%' then raise exception 'FAILED: onboarding task lock: %', sqlerrm; end if; end;
  begin insert into task(company_id, title, kind) values (co, 'Probation review', 'probation_review'); raise exception 'SHOULD HAVE FAILED';
  exception when others then if sqlerrm not like 'Probation is in preview%probation records%' then raise exception 'FAILED: probation task lock: %', sqlerrm; end if; end;
  begin perform desk_save_document(p, 'appointment_letter', 'Dear Morgan…'); raise exception 'SHOULD HAVE FAILED';
  exception when others then if sqlerrm not like 'Onboard is in preview%' then raise exception 'FAILED: appointment letter lock: %', sqlerrm; end if; end;
  begin perform desk_save_document(p, 'confirmation_letter', 'Dear Morgan…'); raise exception 'SHOULD HAVE FAILED';
  exception when others then if sqlerrm not like 'Probation is in preview%' then raise exception 'FAILED: confirmation letter lock: %', sqlerrm; end if; end;
  begin update person set probation_ends_on = '2027-07-11' where id = p; raise exception 'SHOULD HAVE FAILED';
  exception when others then if sqlerrm not like 'Probation is in preview%' then raise exception 'FAILED: probation date lock: %', sqlerrm; end if; end;
  -- Hire stays live: candidate edits, tasks and offer letters still work
  update person set full_name = 'Morgan Example-Smith' where id = p;
  insert into task(company_id, title, kind) values (co, 'Feedback on Morgan', 'feedback');
  perform desk_save_document(p, 'offer_letter', 'Dear Morgan…');
end $$;

-- 3. The platform admin: lists companies, can't put a module without screens into preview, switches Onboard live
reset role; set role authenticated;
set request.jwt.claim.sub = 'cccccccc-0000-4000-8000-0000000000ad';
do $$ declare co uuid := (select v::uuid from mo where k = 'GB'); l jsonb := platform_companies(); r jsonb; begin
  if not exists (select 1 from jsonb_array_elements(l) c where c->>'name' = 'Brit Hire Ltd (fictional)' and c->'modules'->>'onboard' = 'preview') then raise exception 'FAILED: platform_companies: %', l; end if;
  begin perform set_module_state(co, 'compliance', 'preview'); raise exception 'SHOULD HAVE FAILED';
  exception when others then if sqlerrm not like 'Compliance can''t be preview yet%' then raise exception 'FAILED: compliance preview: %', sqlerrm; end if; end;
  begin perform set_module_state(co, 'hire', 'soon'); raise exception 'SHOULD HAVE FAILED';
  exception when others then if sqlerrm not like 'Hire can''t be soon yet%' then raise exception 'FAILED: hire soon: %', sqlerrm; end if; end;
  begin perform set_module_state(co, 'banking', 'live'); raise exception 'SHOULD HAVE FAILED';
  exception when others then if sqlerrm not like 'Unknown module%' then raise exception 'FAILED: unknown module: %', sqlerrm; end if; end;
  r := set_module_state(co, 'onboard', 'live');
  if r->>'was' <> 'preview' or r->>'state' <> 'live' then raise exception 'FAILED: switch result: %', r; end if;
  perform set_module_state(co, 'probation', 'soon');
end $$;
reset role;
do $$ begin
  if not exists (select 1 from audit_event where action = 'module_state_set' and company_id = (select v::uuid from mo where k = 'GB') and detail->>'to' = 'live') then
    raise exception 'FAILED: module switch not audited'; end if;
end $$;

-- 4. Onboard live: the joiner saves; Probation now "coming soon" still refuses
set role authenticated;
set request.jwt.claim.sub = 'dddddddd-0000-4000-8000-000000000001';
do $$ declare p uuid := (select v::uuid from mo where k = 'person'); begin
  if my_modules()->>'onboard' <> 'live' or my_modules()->>'probation' <> 'soon' then raise exception 'FAILED: switched states: %', my_modules(); end if;
  update person set status = 'employee', joined_on = '2027-01-11' where id = p;
  begin update person set probation_ends_on = '2027-07-11' where id = p; raise exception 'SHOULD HAVE FAILED';
  exception when others then if sqlerrm <> 'Probation is coming soon in Clearstage, so real probation records can''t be saved yet.' then raise exception 'FAILED: soon lock: %', sqlerrm; end if; end;
end $$;

-- 5. "I need this": once per user per module, a note fills an empty one, never for a live module; no client counts
do $$ declare r jsonb; begin
  r := register_module_interest('exit', null, 'desk');
  if not (r->>'new')::boolean or r->>'by' <> 'Alex' or r->>'company' <> 'Brit Hire Ltd (fictional)' then raise exception 'FAILED: first interest: %', r; end if;
  r := register_module_interest('exit', 'we have 3 exits a month', 'page');
  if (r->>'new')::boolean or r->>'note' <> 'we have 3 exits a month' then raise exception 'FAILED: note fill: %', r; end if;
  r := register_module_interest('exit', 'a different note', 'page');
  if r->>'note' <> 'we have 3 exits a month' then raise exception 'FAILED: note overwritten: %', r; end if;
  if (select count(*) from module_interest) <> 1 then raise exception 'FAILED: more than one row per user and module'; end if;
  perform register_module_interest('payroll', repeat('x', 500));
  if char_length(my_module_interest()->'payroll'->>'note') <> 200 then raise exception 'FAILED: note not cut to 200'; end if;
  begin perform register_module_interest('onboard'); raise exception 'SHOULD HAVE FAILED';
  exception when others then if sqlerrm not like 'Onboard is already live%' then raise exception 'FAILED: interest in a live module: %', sqlerrm; end if; end;
  begin perform register_module_interest('exit', null, 'email'); raise exception 'SHOULD HAVE FAILED';
  exception when others then if sqlerrm not like 'Unknown source%' then raise exception 'FAILED: bad source: %', sqlerrm; end if; end;
  if (my_module_interest()->'exit'->>'source') <> 'desk' then raise exception 'FAILED: my_module_interest: %', my_module_interest(); end if;
  begin insert into module_interest(company_id, user_id, module) values ((select v::uuid from mo where k = 'GB'), auth.uid(), 'policies'); raise exception 'SHOULD HAVE FAILED';
  exception when insufficient_privilege then null; end;
  begin perform module_interest_counts(); raise exception 'SHOULD HAVE FAILED';
  exception when others then if sqlerrm not like 'Only Clearstage can see module interest%' then raise exception 'FAILED: client saw counts: %', sqlerrm; end if; end;
end $$;

-- 6. The founder's counts: real companies only, with notes
reset role; set role authenticated;
set request.jwt.claim.sub = 'cccccccc-0000-4000-8000-0000000000ad';
do $$ declare c jsonb := module_interest_counts(); e jsonb; begin
  select x into e from jsonb_array_elements(c) x where x->>'module' = 'exit';
  if e is null or (e->>'people')::int < 1 or (e->>'from_desk')::int < 1 or not exists (select 1 from jsonb_array_elements(e->'notes') n where n->>'note' = 'we have 3 exits a month' and n->>'company' = 'Brit Hire Ltd (fictional)') then
    raise exception 'FAILED: module interest counts: %', c; end if;
end $$;

-- 7. The sample company shows the flow: the preview lock doesn't apply there
reset role;
do $$ declare s uuid := (select v::uuid from mo where k = 'S'); begin
  insert into member(company_id, user_id, full_name, email, app_role)
    select s, 'cccccccc-0000-4000-8000-0000000000ad', 'Founder', 'clearstage-admin@test.in', 'member'
    where not exists (select 1 from member where company_id = s and user_id = 'cccccccc-0000-4000-8000-0000000000ad');
end $$;
set role authenticated;
set request.jwt.claim.sub = 'cccccccc-0000-4000-8000-0000000000ad';
insert into task(company_id, title, kind) values ((select v::uuid from mo where k = 'S'), 'Appointment letter for a sample joiner', 'appointment_letter');
reset role;
-- 8. QA-011: names
set role authenticated;
set request.jwt.claim.sub = 'dddddddd-0000-4000-8000-000000000001';
do $$ declare n text; begin
  foreach n in array array['XXXX', 'cccc', 'x', '1234', '', '   ', 'test', 'a a a a'] loop
    begin perform update_my_name(n); raise exception 'SHOULD HAVE FAILED for %', n;
    exception when others then if sqlerrm not like 'Enter your name%' then raise exception 'FAILED: placeholder name % accepted: %', n, sqlerrm; end if; end;
  end loop;
end $$;
do $$ begin
  if update_my_name('  Alex   Morgan ')->>'full_name' <> 'Alex Morgan' then raise exception 'FAILED: name tidy'; end if;
  if (select full_name from member where user_id = auth.uid() limit 1) <> 'Alex Morgan' then raise exception 'FAILED: name not saved'; end if;
  if not looks_like_name('Lê Văn An') or not looks_like_name('O''Brien') or not looks_like_name('Ritu') then raise exception 'FAILED: real names refused'; end if;
end $$;
reset role;
insert into auth.users values ('eeeeeeee-0000-4000-8000-000000000001', 'newbie@placeholder.test') on conflict do nothing;
set role authenticated;
set request.jwt.claim.sub = 'eeeeeeee-0000-4000-8000-000000000001';
do $$ begin perform create_company_for_me('Placeholder Co', 'Leeds', 'XXXX', null, 'solo', 'GB', null, 'Europe/London'); raise exception 'SHOULD HAVE FAILED';
exception when others then if sqlerrm not like 'Enter your name%' then raise exception 'FAILED: XXXX at sign-up: %', sqlerrm; end if; end $$;
do $$ begin if exists (select 1 from company where name = 'Placeholder Co') then raise exception 'FAILED: company created with a placeholder name'; end if; end $$;
reset role;
select 'MODULE TAB CHECKS PASSED';
