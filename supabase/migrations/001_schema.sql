-- Clearstage Desk: engine schema (source of truth). Run in Supabase SQL editor, Mumbai region.
-- One person record runs from candidate to employee to alumnus. Task is the shared spine.

create extension if not exists pgcrypto;

-- Companies and who works in Clearstage for them
create table company (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  city text,
  headcount int,
  team_setup text not null default 'solo' check (team_setup in ('solo','lead_juniors','split')),
  -- split teams later: separate TA and HR owners, handoff at offer accepted
  ta_owner uuid,
  hr_owner uuid,
  created_at timestamptz not null default now()
);

create table member (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references company(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,   -- null for WhatsApp-only people (managers, IT)
  full_name text not null,
  email text,
  phone text,                       -- E.164, e.g. +9198xxxxxxxx; used for WhatsApp
  title text,
  app_role text not null default 'member' check (app_role in ('owner','lead','junior','member','approver')),
  whatsapp_opt_in boolean not null default false,
  created_at timestamptz not null default now(),
  unique (company_id, email)
);

create table person (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references company(id) on delete cascade,
  full_name text not null,
  email text,
  phone text,
  status text not null default 'candidate' check (status in ('candidate','employee','alumnus')),
  joined_on date,
  probation_ends_on date,
  manager_id uuid references member(id),
  aadhaar_last4 text check (aadhaar_last4 ~ '^[0-9]{4}$'),   -- masked: never store the full number
  consent_at timestamptz,
  created_at timestamptz not null default now()
);

create table role (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references company(id) on delete cascade,
  title text not null,
  city text,
  openings int not null default 1 check (openings > 0),
  budget_min int, budget_max int,            -- yearly CTC in rupees
  stages text[] not null default array['Applied','Screened','Interview','Offer'],
  status text not null default 'draft' check (status in ('draft','awaiting_approval','open','on_hold','closed')),
  owner_id uuid references member(id),
  approved_by uuid references member(id),
  approved_at timestamptz,
  target_fill_on date,
  created_at timestamptz not null default now()
);

create table application (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references company(id) on delete cascade,
  role_id uuid not null references role(id) on delete cascade,
  person_id uuid not null references person(id) on delete cascade,
  stage text not null default 'Applied',
  outcome text check (outcome in ('hired','rejected','withdrawn')),
  reject_reason text check (reject_reason in (
    'skills_gap','assessment_below_bar','experience_mismatch','salary_mismatch',
    'location_mismatch','notice_period','role_filled','no_show','withdrew')),
  created_at timestamptz not null default now(),
  unique (role_id, person_id)
);

create table interview (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references company(id) on delete cascade,
  application_id uuid not null references application(id) on delete cascade,
  round text not null,
  interviewer_id uuid references member(id),
  scheduled_at timestamptz,
  created_at timestamptz not null default now()
);

create table feedback (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references company(id) on delete cascade,
  interview_id uuid not null references interview(id) on delete cascade,
  scores jsonb not null default '{}'::jsonb,     -- {"API design":4,"SQL":2,"Overall":4}
  recommendation text check (recommendation in ('next_round','hire','reject','hold')),
  raw_text text,                                  -- WhatsApp reply as received
  channel text default 'whatsapp',
  created_at timestamptz not null default now()
);

create table offer (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references company(id) on delete cascade,
  application_id uuid not null references application(id) on delete cascade,
  components jsonb not null,                      -- [{name,kind,amount}]
  ctc int not null,
  wages_check jsonb,                              -- result of calculate_ctc (plain code)
  status text not null default 'draft' check (status in ('draft','in_review','sent','accepted','declined','expired')),
  valid_until date,
  joining_on date,
  approved_by uuid references member(id),
  approved_at timestamptz,
  created_at timestamptz not null default now()
);

create table task (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references company(id) on delete cascade,
  title text not null,
  kind text not null,                             -- feedback | approval | appointment_letter | it_setup | probation_review | ...
  owner_id uuid references member(id),
  subject_type text, subject_id uuid,             -- e.g. ('person', id)
  due_at timestamptz,
  reminder_rule jsonb default '{"every_hours":24}'::jsonb,
  escalation_chain uuid[] default '{}',           -- members in order
  escalated_level int not null default 0,
  last_reminded_at timestamptz,
  status text not null default 'open' check (status in ('open','done','cancelled')),
  why text,                                       -- one line shown in the brief
  created_at timestamptz not null default now(),
  done_at timestamptz
);
create index task_due_idx on task (company_id, status, due_at);

create table template (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references company(id) on delete cascade,  -- null = Clearstage playbook template
  kind text not null,
  name text not null,
  body text not null,
  created_at timestamptz not null default now()
);

create table document (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references company(id) on delete cascade,
  person_id uuid references person(id) on delete cascade,
  kind text not null,
  version int not null default 1,
  body text,
  storage_path text,
  approved_by uuid references member(id),
  approved_at timestamptz,
  acknowledged_at timestamptz,
  created_at timestamptz not null default now()
);

create table message (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references company(id) on delete cascade,
  channel text not null check (channel in ('whatsapp','email','in_app')),
  to_member uuid references member(id),
  to_person uuid references person(id),
  body text not null,
  direction text not null default 'out' check (direction in ('out','in')),
  approved_by uuid references member(id),         -- required for anything reaching a candidate or employee
  status text not null default 'queued',
  provider_id text,
  created_at timestamptz not null default now()
);

create table rule (
  id text primary key,                            -- e.g. code-on-wages-50
  citation text not null,
  conditions jsonb,
  status text not null default 'awaiting legal review',
  reviewed_on date,
  reviewer text
);

create table audit_event (
  id bigint generated always as identity primary key,
  company_id uuid not null references company(id) on delete cascade,
  actor_member uuid references member(id),
  actor_kind text not null default 'human' check (actor_kind in ('human','desk','system')),
  action text not null,
  subject_type text, subject_id uuid,
  detail jsonb,
  undo_until timestamptz,                         -- actions can be undone for 10 minutes
  created_at timestamptz not null default now()
);

-- Guardrail: anything sent to a candidate or employee needs a named approver
alter table message add constraint person_messages_need_approval
  check (to_person is null or direction = 'in' or approved_by is not null);

-- Row-level security: members only see their own company's rows
create or replace function my_company_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select company_id from member where user_id = auth.uid()
$$;

do $$
declare t text;
begin
  foreach t in array array['member','person','role','application','interview','feedback','offer','task','document','message','audit_event'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy %I on %I for all using (company_id in (select my_company_ids())) with check (company_id in (select my_company_ids()))', t||'_company', t);
  end loop;
end $$;

alter table company enable row level security;
create policy company_member on company for select using (id in (select my_company_ids()));
create policy company_update on company for update using (id in (select my_company_ids()));

alter table template enable row level security;
create policy template_read on template for select using (company_id is null or company_id in (select my_company_ids()));
create policy template_write on template for all using (company_id in (select my_company_ids())) with check (company_id in (select my_company_ids()));

alter table rule enable row level security;
create policy rule_read on rule for select using (true);

-- Sign-up: create a company and make the new user its owner, in one call from the app
create or replace function create_company_for_me(p_company text, p_city text, p_full_name text, p_phone text, p_setup text)
returns uuid language plpgsql security definer set search_path = public as $$
declare cid uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  insert into company(name, city, team_setup) values (p_company, p_city, coalesce(p_setup,'solo')) returning id into cid;
  insert into member(company_id, user_id, full_name, email, phone, app_role, whatsapp_opt_in)
    values (cid, auth.uid(), p_full_name, (select email from auth.users where id = auth.uid()), p_phone,
            case when p_setup = 'lead_juniors' then 'lead' else 'owner' end, p_phone is not null);
  insert into audit_event(company_id, actor_kind, action, detail) values (cid, 'human', 'company_created', jsonb_build_object('setup', p_setup));
  return cid;
end $$;

insert into rule(id, citation, conditions) values
  ('code-on-wages-50', 'Code on Wages, 2019, section 2(y): excluded payments above one-half of total remuneration count as wages', '{"threshold":0.5}')
on conflict (id) do nothing;
