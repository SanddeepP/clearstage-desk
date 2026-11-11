-- Demo data for Acme Fintech (all names fictional). Safe to re-run on an empty project.
-- Dates are relative to the demo week of Mon 16 Nov 2026.

do $$
declare
  co uuid := '00000000-0000-4000-8000-000000000001';
  rahul uuid := gen_random_uuid(); ritu uuid := gen_random_uuid(); meera uuid := gen_random_uuid();
  arjun uuid := gen_random_uuid(); vikram uuid := gen_random_uuid(); suresh uuid := gen_random_uuid();
  r_backend uuid := gen_random_uuid(); r_ops uuid := gen_random_uuid(); r_cs uuid := gen_random_uuid();
  p uuid; a uuid; i uuid; n int;
begin
  insert into company(id, name, city, headcount, team_setup) values (co, 'Acme Fintech', 'Hyderabad', 42, 'solo')
    on conflict (id) do nothing;

  insert into member(id, company_id, full_name, title, app_role, phone, whatsapp_opt_in) values
    (rahul,  co, 'Rahul',  'Founder',            'approver', '+910000000001', true),
    (ritu,   co, 'Ritu',   'HR & recruiter',     'owner',    null, false),
    (meera,  co, 'Meera',  'HR Manager',         'lead',     '+910000000003', true),
    (arjun,  co, 'Arjun',  'Engineering Manager','member',   '+910000000004', true),
    (vikram, co, 'Vikram', 'Head of Engineering','member',   '+910000000005', true),
    (suresh, co, 'Suresh', 'IT',                 'member',   '+910000000006', true);

  insert into role(id, company_id, title, city, openings, budget_min, budget_max, status, owner_id, approved_by, approved_at) values
    (r_backend, co, 'Backend Developer',  'Hyderabad', 1, 1000000, 1400000, 'open', ritu, rahul, now() - interval '21 days'),
    (r_ops,     co, 'Operations Analyst', 'Hyderabad', 1,  500000,  700000, 'open', ritu, rahul, now() - interval '14 days'),
    (r_cs,      co, 'Customer Success',   'Hyderabad', 1,  450000,  600000, 'open', ritu, rahul, now() - interval '9 days');

  -- Backend Developer funnel: 12 applied, 5 screened, 3 interview, 1 offer
  for n in 1..12 loop
    insert into person(company_id, full_name) values (co, 'Applicant ' || n) returning id into p;
    insert into application(company_id, role_id, person_id, stage) values (co, r_backend, p, 'Applied');
  end loop;
  for n in 1..5 loop
    insert into person(company_id, full_name) values (co, 'Screened ' || n) returning id into p;
    insert into application(company_id, role_id, person_id, stage) values (co, r_backend, p, 'Screened');
  end loop;
  insert into person(company_id, full_name) values (co, 'Ankit Verma') returning id into p;
  insert into application(company_id, role_id, person_id, stage) values (co, r_backend, p, 'Interview') returning id into a;
  insert into interview(company_id, application_id, round, interviewer_id, scheduled_at) values (co, a, 'Round 1', arjun, now() - interval '26 hours') returning id into i;
  insert into task(company_id, title, kind, owner_id, subject_type, subject_id, due_at, escalation_chain, why) values
    (co, 'Arjun hasn''t given feedback on 2 candidates', 'feedback', arjun, 'interview', i, now() - interval '2 hours', array[vikram], 'Backend Developer · escalates to Vikram at 4 pm');
  insert into person(company_id, full_name) values (co, 'Lakshmi R.') returning id into p;
  insert into application(company_id, role_id, person_id, stage) values (co, r_backend, p, 'Interview');
  insert into person(company_id, full_name) values (co, 'Sameer T.') returning id into p;
  insert into application(company_id, role_id, person_id, stage) values (co, r_backend, p, 'Interview');

  insert into person(company_id, full_name) values (co, 'Kiran S.') returning id into p;
  insert into application(company_id, role_id, person_id, stage) values (co, r_backend, p, 'Offer') returning id into a;
  -- Deliberately fails the 50% wages check
  insert into offer(company_id, application_id, ctc, components, status) values (co, a, 1200000,
    '[{"name":"Basic + DA","kind":"basic","amount":420000},{"name":"HRA","kind":"hra","amount":210000},{"name":"Special allowance","kind":"special","amount":510000},{"name":"Employer PF","kind":"employer_pf","amount":60000}]', 'draft');

  -- Joiner Sneha on Mon 16 Nov with no appointment letter yet
  insert into person(company_id, full_name, status, joined_on, probation_ends_on, manager_id) values
    (co, 'Sneha Rao', 'employee', date '2026-11-16', date '2027-05-16', vikram) returning id into p;
  insert into task(company_id, title, kind, owner_id, subject_type, subject_id, due_at, why) values
    (co, 'Sneha joins Monday with no appointment letter', 'appointment_letter', ritu, 'person', p, now() - interval '1 hour', 'Every joiner needs one before Day 1');

  -- Priya's probation ends 23 Nov
  insert into person(company_id, full_name, status, joined_on, probation_ends_on, manager_id) values
    (co, 'Priya Nair', 'employee', date '2026-05-23', date '2026-11-23', vikram) returning id into p;
  insert into task(company_id, title, kind, owner_id, subject_type, subject_id, due_at, escalation_chain, why) values
    (co, 'Priya''s probation ends soon', 'probation_review', vikram, 'person', p, date '2026-11-20', array[rahul], 'Manager review is due before the end date');
end $$;
