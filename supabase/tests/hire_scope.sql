-- QA-044 (S1), CTO ruling 26 Nov §1: a Recruiter sees and changes nothing outside Hire, in the database.
-- P-R probes on every non-Hire table and every Desk database tool, using QA's phrasings: "tell me about Sneha",
-- "tell me about Priya Nair", "what is Priya's phone number?", "show Sneha's appointment letter", and the people list.
-- Company A is "Rycruit"; Ritu (…02) is a Recruiter only. Runs after roles.sql. All people here are fictional.
\set ON_ERROR_STOP on
reset role;
create temp table hs(k text primary key, v text); grant select, insert on hs to authenticated;
insert into hs values ('A', (select id::text from company where name = 'Rycruit')), ('S', (select id::text from company where is_sample limit 1));

-- Fixture: a joiner with an appointment letter that states pay, onboarding and probation work, a message and audit
-- entries about them, plus a candidate with an offer (Hire, still visible).
do $$ declare a uuid := (select v::uuid from hs where k = 'A'); sneha uuid; priya uuid; cand uuid; app uuid; ritu uuid;
  hr uuid := (select id from member where user_id = 'aaaaaaaa-0000-4000-8000-000000000003' and company_id = (select v::uuid from hs where k = 'A')); begin
  insert into person(company_id, full_name, email, phone, status, joined_on) values (a, 'Sneha Rao HS', 'sneha.hs@test.in', '+91 90000 55555', 'employee', current_date + 5) returning id into sneha;
  insert into person(company_id, full_name, email, phone, status, joined_on, probation_ends_on) values (a, 'Priya Nair HS', 'priya.hs@test.in', '+91 90000 66666', 'employee', current_date - 170, current_date + 10) returning id into priya;
  insert into document(company_id, person_id, kind, body, summary) values (a, sneha, 'appointment_letter', 'Dear Sneha Rao HS, Compensation: HS-PAY-1800000 per year', 'appointment');
  insert into task(company_id, title, kind, subject_type, subject_id, due_at, why) values
    (a, 'Laptop for Sneha Rao HS', 'it_setup', 'person', sneha, now() + interval '2 days', 'HS-ONBOARD'),
    (a, 'Probation review: Priya Nair HS', 'probation_review', 'person', priya, now() + interval '3 days', 'HS-PROBATION');
  insert into message(company_id, channel, to_person, body, direction) values (a, 'email', sneha, 'Welcome Sneha Rao HS, HS-PAY-1800000', 'in');
  insert into audit_event(company_id, actor_kind, action, subject_type, subject_id, detail) values
    (a, 'human', 'document_drafted', 'person', sneha, '{"note":"HS-PAY-1800000"}'), (a, 'human', 'probation_review_started', 'person', priya, '{"note":"HS-PROBATION"}');
  select p.id, x.id into cand, app from person p join application x on x.person_id = p.id where p.company_id = a and p.status = 'candidate' order by p.full_name limit 1;
  insert into hs values ('sneha', sneha), ('priya', priya), ('cand', cand), ('app', app);
end $$;
-- a candidate's offer (Hire): HR drafts it
set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000003';
do $$ declare r jsonb; begin
  r := desk_save_offer((select v::uuid from hs where k = 'app'), '{"ctc": 900000}'::jsonb, false);
  insert into hs values ('offer', r->>'offer_id');
end $$;
reset role;
create temp table hs_secret(v text); grant select on hs_secret to authenticated;
insert into hs_secret values ('Sneha Rao HS'), ('Priya Nair HS'), ('HS-PAY-1800000'), ('HS-ONBOARD'), ('HS-PROBATION'), ('sneha.hs@test.in'), ('+91 90000 66666'),
  ((select v from hs where k = 'sneha')), ((select v from hs where k = 'priya')), ('Kavya Menon'), ('Rohit Bansal');

-- Everything a role can read in A, as one text (every company table, so a new table is covered automatically)
create or replace function public.zz_readable(p_company uuid) returns text language plpgsql as $$
declare t record; x text; out text := ''; begin
  for t in select cl.relname from pg_class cl join pg_namespace s on s.oid = cl.relnamespace
           where s.nspname = 'public' and cl.relkind in ('r', 'v') and exists (select 1 from information_schema.columns c where c.table_schema = 'public' and c.table_name = cl.relname and c.column_name = 'company_id') loop
    execute format('select coalesce(string_agg(to_jsonb(r)::text, '' ''), '''') from public.%I r where company_id = $1', t.relname) into x using p_company;
    out := out || x;
  end loop;
  return out;
end $$;
grant execute on function public.zz_readable(uuid) to authenticated;

-- ===================== P-R: Recruiter only =====================
set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000002';
do $$ declare a uuid := (select v::uuid from hs where k = 'A'); seen text; n bigint; r jsonb; leak text; begin
  if not hire_only(a) then raise exception 'FAILED: Ritu is not Recruiter-only'; end if;
  if (my_access_modules())->'modules' <> '["hire", "policies"]'::jsonb then raise exception 'FAILED: modules %', my_access_modules(); end if;
  -- nothing about joiners or employees anywhere: tables, letters, tasks, messages, audit
  seen := zz_readable(a);
  select string_agg(v, ', ') into leak from hs_secret where position(v in seen) > 0;
  if leak is not null then raise exception 'FAILED: P-R reads outside Hire: %', leak; end if;
  if (select count(*) from person where company_id = a and status <> 'candidate') <> 0 then raise exception 'FAILED: P-R lists joiners or employees'; end if;
  if (select count(*) from employee_account where company_id = a) + (select count(*) from employee_change_request where company_id = a) <> 0 then raise exception 'FAILED: P-R reads employee logins or requests'; end if;
  if exists (select 1 from task where company_id = a and not hs_task_kind(kind)) then raise exception 'FAILED: P-R reads onboarding or probation tasks'; end if;
  if exists (select 1 from document where company_id = a and not hs_doc_kind(kind)) then raise exception 'FAILED: P-R reads joiner letters'; end if;
  -- Hire still works
  if (select count(*) from person where company_id = a and status = 'candidate') = 0 or (select count(*) from application where company_id = a) = 0
     or (select count(*) from role where company_id = a) = 0 or (select count(*) from interview where company_id = a) = 0 or (select count(*) from feedback where company_id = a) = 0 then
    raise exception 'FAILED: P-R lost Hire'; end if;
  if not exists (select 1 from offer where id = (select v::uuid from hs where k = 'offer')) then raise exception 'FAILED: P-R can''t see a candidate''s offer'; end if;
  -- Desk database tools, with QA's phrasings
  r := to_jsonb(desk_find_people('Sneha'));        if r::text like '%Sneha Rao HS%' then raise exception 'FAILED: "tell me about Sneha" finds the joiner'; end if;
  r := to_jsonb(desk_find_people('Priya Nair'));   if r::text like '%Priya Nair HS%' then raise exception 'FAILED: "tell me about Priya Nair" finds the employee'; end if;
  r := to_jsonb(desk_find_people('Priya'));        if r::text like '%90000 66666%' or r::text like '%Priya Nair HS%' then raise exception 'FAILED: "what is Priya''s phone number?" finds her'; end if;
  r := to_jsonb(desk_show_joiners());              if jsonb_array_length(coalesce(r, '[]')) <> 0 then raise exception 'FAILED: show_joiners for a Recruiter: %', left(r::text, 200); end if;
  r := to_jsonb(desk_get_brief());                 if r::text like '%Sneha Rao HS%' or r::text like '%HS-ONBOARD%' or r::text like '%HS-PROBATION%' then raise exception 'FAILED: the brief shows Onboard or Probation work'; end if;
  r := to_jsonb(desk_show_pipeline(null));         if r::text like '%Sneha Rao HS%' or r::text like '%Priya Nair HS%' then raise exception 'FAILED: the pipeline shows an employee'; end if;
  begin perform desk_start_probation_review((select v::uuid from hs where k = 'priya')); raise exception 'SHOULD HAVE FAILED';
  exception when others then if sqlerrm like 'SHOULD%' then raise exception 'FAILED: P-R started a probation review'; end if; end;
  begin perform desk_save_document((select v::uuid from hs where k = 'sneha'), 'appointment_letter', 'x', 'x', null); raise exception 'SHOULD HAVE FAILED';
  exception when others then if sqlerrm like 'SHOULD%' then raise exception 'FAILED: P-R drafted an appointment letter'; end if; end;
  begin perform desk_save_document((select v::uuid from hs where k = 'cand'), 'appointment_letter', 'x', 'x', null); raise exception 'SHOULD HAVE FAILED';
  exception when others then if sqlerrm like 'SHOULD%' then raise exception 'FAILED: P-R drafted an appointment letter for a candidate'; end if; end;
  begin perform desk_mark_offer_accepted((select v::uuid from hs where k = 'offer')); raise exception 'SHOULD HAVE FAILED';
  exception when others then if sqlerrm like 'SHOULD%' then raise exception 'FAILED: P-R created a joiner'; end if; end;
  if (select status from person where id = (select v::uuid from hs where k = 'cand')) <> 'candidate' then raise exception 'FAILED: the candidate became an employee'; end if;
  -- direct writes into Onboard or Probation are refused
  begin insert into person(company_id, full_name, status, joined_on) values (a, 'Planted Joiner', 'employee', current_date); raise exception 'SHOULD HAVE FAILED';
  exception when others then if sqlerrm like 'SHOULD%' then raise exception 'FAILED: P-R created an employee'; end if; end;
  begin update person set status = 'employee', joined_on = current_date where id = (select v::uuid from hs where k = 'cand');
  exception when others then null; end;
end $$;
do $$ begin
  if (select status from person where id = (select v::uuid from hs where k = 'cand')) <> 'candidate' then raise exception 'FAILED: P-R turned a candidate into an employee'; end if;
  begin insert into task(company_id, title, kind, subject_type, subject_id, due_at) values ((select v::uuid from hs where k = 'A'), 'Planted', 'it_setup', 'person', (select v::uuid from hs where k = 'cand'), now()); raise exception 'SHOULD HAVE FAILED';
  exception when others then if sqlerrm like 'SHOULD%' then raise exception 'FAILED: P-R created an onboarding task'; end if; end;
  begin insert into document(company_id, person_id, kind, body) values ((select v::uuid from hs where k = 'A'), (select v::uuid from hs where k = 'cand'), 'confirmation_letter', 'x'); raise exception 'SHOULD HAVE FAILED';
  exception when others then if sqlerrm like 'SHOULD%' then raise exception 'FAILED: P-R created a confirmation letter'; end if; end;
  update task set status = 'done' where why in ('HS-ONBOARD', 'HS-PROBATION');
  delete from document where body like '%HS-PAY-1800000%';
end $$;
reset role;
do $$ begin
  if (select count(*) from task where why in ('HS-ONBOARD', 'HS-PROBATION') and status = 'open') <> 2 then raise exception 'FAILED: P-R changed onboarding or probation tasks'; end if;
  if not exists (select 1 from document where body like '%HS-PAY-1800000%') then raise exception 'FAILED: P-R deleted an appointment letter'; end if;
end $$;

-- ===================== roles combine; Manager and HR unchanged; sample company exempt =====================
set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000001';      -- Super admin adds HR to Ritu
do $$ begin perform set_member_roles((select id from member where user_id = 'aaaaaaaa-0000-4000-8000-000000000002' and company_id = (select v::uuid from hs where k = 'A')), array['recruiter', 'hr']); end $$;
reset role; set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000002';
do $$ begin
  if hire_only((select v::uuid from hs where k = 'A')) or position('HS-PAY-1800000' in zz_readable((select v::uuid from hs where k = 'A'))) = 0 then raise exception 'FAILED: Recruiter + HR should see Onboard'; end if;
end $$;
reset role; set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000001';
do $$ begin perform set_member_roles((select id from member where user_id = 'aaaaaaaa-0000-4000-8000-000000000002' and company_id = (select v::uuid from hs where k = 'A')), array['recruiter']); end $$;
reset role; set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000002';
do $$ begin if position('Sneha Rao HS' in zz_readable((select v::uuid from hs where k = 'A'))) > 0 then raise exception 'FAILED: back to Recruiter still sees Sneha'; end if; end $$;
reset role; set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000004';      -- Manager (go-live access unchanged)
do $$ begin if position('Priya Nair HS' in zz_readable((select v::uuid from hs where k = 'A'))) = 0 then raise exception 'FAILED: Manager lost Probation'; end if; end $$;
reset role; set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000003';      -- HR
do $$ begin if position('HS-PAY-1800000' in zz_readable((select v::uuid from hs where k = 'A'))) = 0 then raise exception 'FAILED: HR lost Onboard'; end if; end $$;
reset role; set role authenticated;
set request.jwt.claim.sub = 'cccccccc-0000-4000-8000-0000000000ad';      -- sample access (a Recruiter by mapping in the sample company)
do $$ begin
  if (select count(*) from person where company_id = (select v::uuid from hs where k = 'S') and status = 'employee') = 0 then raise exception 'FAILED: the sample company lost its employees'; end if;
end $$;

reset role;
drop function public.zz_readable(uuid);
select 'HIRE SCOPE (QA-044) CHECKS PASSED';
