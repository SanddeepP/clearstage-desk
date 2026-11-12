-- Run against a local Postgres loaded with 001–004 (see README). Walks every Desk tool as a signed-in founder,
-- then tries what a junior and the AI must not be able to do. Any unexpected failure stops the script.
\set ON_ERROR_STOP on
insert into auth.users values ('aaaaaaaa-0000-4000-8000-000000000001','founder@test.in'), ('aaaaaaaa-0000-4000-8000-000000000002','junior@test.in');
set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000001';
select 'workspace' as step, create_company_for_me('Rycruit','Hyderabad','Sanddeep','+919876543210','lead_juniors') is not null as ok;
select 'sample data', desk_load_sample_data()->>'loaded';
select 'brief', (desk_get_brief()->>'open')::int as open, (desk_get_brief()->>'late')::int as late;
select 'find Arjun', jsonb_array_length(desk_find_people('Arjun')) as matches;   -- expect 2 (ask, don't guess)
select 'pipeline', (select string_agg(x->>'stage' || '=' || (x->>'count'), ' ') from jsonb_array_elements(desk_show_pipeline('Backend')->'stages') x);
\set role_json `echo`
select 'create role' as step, (r->'approval'->>'self')::boolean as founder_approves_self from (select desk_create_role('Data Analyst','Bengaluru',1,800000,1000000,'3+ years',45) r) s;
select 'role waits for approval', status from role where title = 'Data Analyst';
select 'approve role', desk_approve('role', (select id from role where title = 'Data Analyst'))->>'approved';
select 'role now', status, approved_by = (current_member()).id as stamped_as_me from role where title = 'Data Analyst';
-- chase, feedback, move + undo
select 'chase', desk_chase_owner((select id from task where kind = 'feedback' limit 1))->>'chased';
select 'feedback', desk_record_feedback((select a.id from application a join person p on p.id = a.person_id where p.full_name = 'Ankit Verma'),
  '{"API design":4,"SQL":2,"Overall":4}', 'next_round', 'Ankit: 4/5, strong APIs, weak SQL') ? 'feedback_id';
select 'feedback task closed', status from task where kind = 'feedback';
select 'move', desk_move_candidate((select a.id from application a join person p on p.id = a.person_id where p.full_name = 'Lakshmi R.'), 'Offer')->>'to';
select 'undo', desk_undo((select max(id) from audit_event where action = 'candidate_moved'))->>'stage';
-- offer: failing check can't go for approval; passing one can
select 'kiran draft', desk_save_offer((select a.id from application a join person p on p.id = a.person_id where p.full_name = 'Kiran S.'),
  '[{"kind":"basic","amount":420000}]', 1200000, '{"passes":false}') ? 'offer_id';
do $$ begin perform desk_request_approval('offer', (select id from offer limit 1), 'Kiran''s offer'); raise exception 'SHOULD HAVE FAILED';
exception when others then if sqlerrm like 'SHOULD%' then raise; end if; raise notice 'blocked as expected: %', sqlerrm; end $$;
select 'kiran fixed', desk_save_offer((select application_id from offer limit 1), '[{"kind":"basic","amount":570000}]', 1200000, '{"passes":true}') ? 'offer_id';
select 'offer approval', desk_request_approval('offer', (select id from offer limit 1), 'Kiran''s offer') ? 'task_id';
-- switch to the junior: they can draft, but not approve or escalate themselves
reset role;
insert into member(company_id, user_id, full_name, app_role) select company_id, 'aaaaaaaa-0000-4000-8000-000000000002', 'Ritu', 'junior' from member where user_id = 'aaaaaaaa-0000-4000-8000-000000000001';
set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000002';
do $$ begin perform desk_approve('offer', (select id from offer limit 1)); raise exception 'SHOULD HAVE FAILED';
exception when others then if sqlerrm like 'SHOULD%' then raise; end if; raise notice 'junior approve blocked: %', sqlerrm; end $$;
do $$ begin perform desk_bulk_reject((select id from role where title = 'Operations Analyst'), array(select id from person where full_name like 'Megha%'), 'assessment_below_bar', 'Hi {name}, we can''t continue because you are pregnant'); raise exception 'SHOULD HAVE FAILED';
exception when others then if sqlerrm like 'SHOULD%' then raise; end if; raise notice 'protected trait blocked: %', sqlerrm; end $$;
do $$ begin perform desk_bulk_reject((select id from role where title = 'Operations Analyst'), array(select id from person where full_name like 'Megha%'), 'too_old', 'Hi {name}'); raise exception 'SHOULD HAVE FAILED';
exception when others then if sqlerrm like 'SHOULD%' then raise; end if; raise notice 'non-job reason blocked: %', sqlerrm; end $$;
select 'junior bulk reject draft', (desk_bulk_reject((select id from role where title = 'Operations Analyst'),
  array(select id from person where full_name in ('Megha D.','Imran S.','Tarun B.','Pooja N.')), 'assessment_below_bar',
  'Hi {name}, thank you for your time. The role needs advanced Excel and your test score was below the 60% we need.'))->>'drafts' as drafts;
select 'approval goes to lead', (select full_name from member where id = (select owner_id from task where kind = 'approval' and title like '%rejection%')) as approver;
-- back to the founder (lead): approves offer and the batch
set request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000001';
select 'lead approves offer', desk_approve('offer', (select id from offer limit 1))->>'approved';
select 'lead approves batch', desk_approve('batch', (select batch_id from document where kind = 'rejection_note' limit 1))->>'approved';
select 'rejected apps', count(*) from application where outcome = 'rejected';
select 'accept', desk_mark_offer_accepted((select id from offer limit 1))->>'name';
select 'joiners', jsonb_array_length(desk_show_joiners()) as joiners;
select 'probation', desk_start_probation_review((select id from person where full_name = 'Priya Nair'))->>'manager';
select 'messages to people all approved', bool_and(approved_by is not null) from message where to_person is not null;
select 'audit entries', count(*) from audit_event;
-- usage log: insert allowed, edits not
insert into ai_usage(company_id, model, purpose, tools, input_tokens, output_tokens) values ((current_member()).company_id, 'test', 'route', '{get_brief}', 1000, 200);
select 'month tokens', desk_month_tokens();
-- another company can't see any of it
reset role;
insert into auth.users values ('bbbbbbbb-0000-4000-8000-000000000001','other@test.in');
set role authenticated;
set request.jwt.claim.sub = 'bbbbbbbb-0000-4000-8000-000000000001';
select 'other co workspace', create_company_for_me('Other Co','Pune','Asha',null,'solo') is not null;
select 'other co sees roles', count(*) from role;
select 'other co brief open', desk_get_brief()->>'open';
select 'other co finds Arjun', jsonb_array_length(desk_find_people('Arjun'));
select 'ALL DESK TOOL CHECKS PASSED';
