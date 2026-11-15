-- 007_screening.sql — AI screening (PM brief 15 Nov; CTO Tech Decisions §1.1–1.3). Run after 006. Re-runnable.
-- Tables: requirement (versioned card), cv_file, cv_job (one queued job per CV), evidence_cache, evidence, score,
-- shortlist_pin. Every table has row-level security by company.
-- Rules the database enforces (not just the app):
--   * nothing is screened before the requirements card is confirmed by a named person;
--   * a quote is stored only if it appears word for word in the stored, masked CV text;
--   * the score is computed here from stored evidence (same formula as lib/screening.js); clients can't write scores;
--   * unreadable CVs get "needs a human look", no score, never the rejection batch;
--   * the rejection batch is a preview: preparing it creates no message at all.

-- ---------- tables ----------
create table if not exists requirement (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references company(id) on delete cascade,
  role_id uuid not null references role(id) on delete cascade,
  version int not null,
  must jsonb not null,                -- [{id, label, terms[]}], 1–8 items
  nice jsonb not null default '[]',
  conditions jsonb not null default '[]',
  exp_min numeric not null default 0,
  exp_max numeric not null default 50,
  weights jsonb not null default '{"must":60,"experience":20,"nice":15,"conditions":5}',
  drafted_by text not null default 'desk',
  confirmed_by uuid references member(id),
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (role_id, version),
  check (jsonb_array_length(must) between 1 and 8),
  check ((weights->>'must')::int + (weights->>'experience')::int + (weights->>'nice')::int + (weights->>'conditions')::int = 100)
);
create table if not exists cv_file (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references company(id) on delete cascade,
  application_id uuid not null references application(id) on delete cascade,
  storage_path text not null,          -- private bucket "cvs", signed URLs only
  file_name text not null,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  source text,
  referred boolean not null default false,
  added_by_hand boolean not null default false,
  readable boolean,                    -- null until read
  masked_text text,                    -- what the AI saw (personal details removed); quotes are checked against it
  created_at timestamptz not null default now()
);
create table if not exists cv_job (
  id bigint generated always as identity primary key,
  company_id uuid not null references company(id) on delete cascade,
  cv_file_id uuid not null references cv_file(id) on delete cascade,
  requirement_id uuid not null references requirement(id) on delete cascade,
  status text not null default 'queued' check (status in ('queued','running','done','needs_human')),
  attempts int not null default 0,
  last_error text,
  locked_at timestamptz,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (cv_file_id, requirement_id)
);
create index if not exists cv_job_queued on cv_job (company_id, status, id);
create table if not exists evidence_cache (
  company_id uuid not null references company(id) on delete cascade,
  cache_key text not null,             -- file sha256 : requirement id : version : prompt version
  evidence jsonb not null,
  roles jsonb not null,
  model text not null,
  prompt_version text not null,
  created_at timestamptz not null default now(),
  primary key (company_id, cache_key)
);
create table if not exists evidence (
  id bigint generated always as identity primary key,
  company_id uuid not null references company(id) on delete cascade,
  application_id uuid not null references application(id) on delete cascade,
  requirement_id uuid not null references requirement(id) on delete cascade,
  item_id text not null,               -- requirement item id (m1, n2, c1) or 'role' for a dated role
  quote text not null check (array_length(regexp_split_to_array(btrim(quote), '\s+'), 1) <= 20),
  section text not null check (section in ('Summary','Experience','Skills','Projects','Education','Certifications','Other')),
  confidence text not null check (confidence in ('high','medium','low')),
  created_at timestamptz not null default now()
);
create index if not exists evidence_app on evidence (application_id, requirement_id);
create table if not exists score (
  application_id uuid not null references application(id) on delete cascade,
  requirement_id uuid not null references requirement(id) on delete cascade,
  company_id uuid not null references company(id) on delete cascade,
  version int not null,
  readable boolean not null,
  label text,                          -- 'needs a human look' when unreadable
  must_met int, must_total int, coverage numeric, years numeric, exp_in_range boolean,
  nice_met int, nice_total int, cond_met int, cond_total int,
  fit int, stars int check (stars between 1 and 5), under50 boolean not null default false,
  override_stars int check (override_stars between 1 and 5), override_reason text, override_by uuid references member(id), override_at timestamptz,
  status text not null default 'new' check (status in ('new','contacted','rejected','withdrawn','moved_forward')),
  applied_at timestamptz not null,
  scored_at timestamptz not null default now(),
  primary key (application_id, requirement_id)
);
create table if not exists shortlist_pin (
  company_id uuid not null references company(id) on delete cascade,
  role_id uuid not null references role(id) on delete cascade,
  application_id uuid not null references application(id) on delete cascade,
  pinned_by uuid not null references member(id),
  pinned_at timestamptz not null default now(),
  primary key (role_id, application_id)
);

-- ---------- row-level security: members read their company; writes go through the functions below ----------
do $$ declare t text; begin
  foreach t in array array['requirement','cv_file','cv_job','evidence_cache','evidence','score','shortlist_pin'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t||'_read', t);
    execute format('create policy %I on %I for select using (company_id in (select my_company_ids()))', t||'_read', t);
    execute format('revoke insert, update, delete on %I from anon, authenticated', t);
  end loop;
end $$;

-- ---------- helpers ----------
create or replace function scr_norm(s text) returns text language sql immutable as $$
  select lower(btrim(regexp_replace(translate(coalesce(s,''), '‐‑‒–—―−‘’‛“”' || chr(160), '-------''''''"" '), '\s+', ' ', 'g')))
$$;

-- Years from dated role quotes ("Mar 2021 - Present"), overlaps merged. Same rule as lib/screening.js yearsFromRanges.
create or replace function scr_years(p_quotes text[], p_as_of date default current_date) returns numeric
language plpgsql immutable as $$
declare q text; m text[]; s int; e int; spans int[][] := '{}'; i int; months int := 0; cs int; ce int;
        mons text[] := array['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
begin
  foreach q in array coalesce(p_quotes, '{}') loop
    for m in select regexp_matches(lower(q), '(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+)?((?:19|20)\d\d)\s*(?:–|-|—|to)\s*(?:(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+)?((?:19|20)\d\d)|(present|now|current|till date))', 'g') loop
      s := m[2]::int * 12 + coalesce(array_position(mons, m[1]) - 1, 0);
      e := case when m[5] is not null then extract(year from p_as_of)::int * 12 + extract(month from p_as_of)::int - 1
                else m[4]::int * 12 + coalesce(array_position(mons, m[3]) - 1, 11) end;
      if e > s then spans := spans || array[[s, e]]; end if;
    end loop;
  end loop;
  if coalesce(array_length(spans, 1), 0) = 0 then return null; end if;
  select array_agg(array[a, b] order by a) into spans from (select spans[k][1] a, spans[k][2] b from generate_subscripts(spans, 1) k) x;
  cs := spans[1][1]; ce := spans[1][2];
  for i in 2 .. array_length(spans, 1) loop
    if spans[i][1] <= ce then ce := greatest(ce, spans[i][2]); else months := months + ce - cs; cs := spans[i][1]; ce := spans[i][2]; end if;
  end loop;
  months := months + ce - cs;
  return round(months / 12.0, 1);
end $$;

-- The fit formula, exactly (CTO §1.3): coverage × 60 + (experience in range ? 20 : 0) + nice fraction × 15
-- + conditions fraction × 5, rounded. Only high or medium confidence counts.
create or replace function scr_compute(p_app uuid, p_req uuid) returns score
language plpgsql security definer set search_path = public as $$
declare r requirement; f cv_file; sc score; w jsonb; has text[]; ids text[]; y numeric; raw numeric;
        mt int; nt int; ct int; mm int; nm int; cm int; app application;
begin
  select * into r from requirement where id = p_req;
  if r.confirmed_at is null then raise exception 'Confirm the requirements card before screening'; end if;
  select * into app from application where id = p_app;
  select * into f from cv_file where application_id = p_app order by created_at desc limit 1;
  sc.application_id := p_app; sc.requirement_id := p_req; sc.company_id := r.company_id; sc.version := r.version;
  sc.applied_at := app.created_at; sc.scored_at := now(); sc.status := 'new';
  if f.readable is not true then
    sc.readable := false; sc.label := 'needs a human look'; sc.under50 := false; return sc;
  end if;
  sc.readable := true;
  select array_agg(distinct item_id) into has from evidence where application_id = p_app and requirement_id = p_req and confidence in ('high','medium') and item_id <> 'role';
  has := coalesce(has, '{}');
  select array_agg(quote) into ids from evidence where application_id = p_app and requirement_id = p_req and item_id = 'role';
  y := scr_years(ids, coalesce(nullif(current_setting('clearstage.as_of', true), '')::date, current_date));   -- tests pin the day
  mt := jsonb_array_length(r.must); nt := jsonb_array_length(r.nice); ct := jsonb_array_length(r.conditions);
  select count(*) into mm from jsonb_array_elements(r.must) x where x->>'id' = any(has);
  select count(*) into nm from jsonb_array_elements(r.nice) x where x->>'id' = any(has);
  select count(*) into cm from jsonb_array_elements(r.conditions) x where x->>'id' = any(has);
  w := r.weights;
  sc.must_met := mm; sc.must_total := mt; sc.nice_met := nm; sc.nice_total := nt; sc.cond_met := cm; sc.cond_total := ct;
  sc.coverage := case when mt = 0 then 1 else mm::numeric / mt end;
  sc.years := y; sc.exp_in_range := y is not null and y between r.exp_min and r.exp_max;
  raw := sc.coverage * (w->>'must')::int + case when sc.exp_in_range then (w->>'experience')::int else 0 end
       + (case when nt = 0 then 1 else nm::numeric / nt end) * (w->>'nice')::int
       + (case when ct = 0 then 1 else cm::numeric / ct end) * (w->>'conditions')::int;
  sc.fit := floor(raw + 0.5);          -- JS Math.round (half up)
  sc.under50 := mt >= 3 and not f.referred and not f.added_by_hand and sc.coverage < 0.5;
  sc.stars := case when sc.under50 then 1 when sc.fit >= 85 then 5 when sc.fit >= 70 then 4 when sc.fit >= 55 then 3 when sc.fit >= 40 then 2 else 1 end;
  return sc;
end $$;
revoke all on function scr_compute(uuid, uuid) from public, anon, authenticated;

-- ---------- requirements card: Desk drafts, a named person confirms ----------
create or replace function desk_draft_requirements(p_role uuid, p_must jsonb, p_nice jsonb, p_conditions jsonb, p_exp_min numeric, p_exp_max numeric, p_weights jsonb default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me member := current_member(); r role; v int; rid uuid;
begin
  select * into r from role where id = p_role and company_id = me.company_id;
  if r.id is null then raise exception 'Role not found'; end if;
  select coalesce(max(version), 0) + 1 into v from requirement where role_id = p_role;
  insert into requirement(company_id, role_id, version, must, nice, conditions, exp_min, exp_max, weights)
    values (me.company_id, p_role, v, p_must, coalesce(p_nice, '[]'), coalesce(p_conditions, '[]'), p_exp_min, p_exp_max,
            coalesce(p_weights, '{"must":60,"experience":20,"nice":15,"conditions":5}'))
    returning id into rid;
  perform desk_log('requirements_drafted', 'requirement', rid, jsonb_build_object('version', v));
  return jsonb_build_object('requirement_id', rid, 'version', v, 'status', 'draft');
end $$;
-- A person's tap, never an AI tool (like desk_approve).
create or replace function desk_confirm_requirements(p_requirement uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me member := current_member(); r requirement;
begin
  select * into r from requirement where id = p_requirement and company_id = me.company_id;
  if r.id is null then raise exception 'Requirements not found'; end if;
  if r.confirmed_at is not null then return jsonb_build_object('version', r.version, 'confirmed_at', r.confirmed_at); end if;
  if me.app_role not in ('owner','lead') and not exists (select 1 from company c where c.id = me.company_id and c.team_setup = 'solo') then
    raise exception 'Only the lead or founder can confirm requirements';
  end if;
  update requirement set confirmed_by = me.id, confirmed_at = now() where id = r.id;
  perform desk_log('requirements_confirmed', 'requirement', r.id, jsonb_build_object('version', r.version));
  return jsonb_build_object('version', r.version, 'confirmed_by', me.full_name, 'confirmed_at', now());
end $$;

-- ---------- queue: one job per CV ----------
create or replace function desk_enqueue_cv(p_application uuid, p_requirement uuid, p_path text, p_name text, p_sha text, p_source text default null, p_referred boolean default false, p_by_hand boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me member := current_member(); r requirement; fid uuid; jid bigint;
begin
  select * into r from requirement where id = p_requirement and company_id = me.company_id;
  if r.id is null then raise exception 'Requirements not found'; end if;
  if r.confirmed_at is null then raise exception 'Confirm the requirements card before screening'; end if;
  if not exists (select 1 from application where id = p_application and company_id = me.company_id and role_id = r.role_id) then raise exception 'Application not found for this role'; end if;
  insert into cv_file(company_id, application_id, storage_path, file_name, sha256, source, referred, added_by_hand)
    values (me.company_id, p_application, p_path, p_name, p_sha, p_source, p_referred, p_by_hand) returning id into fid;
  insert into cv_job(company_id, cv_file_id, requirement_id) values (me.company_id, fid, r.id)
    on conflict (cv_file_id, requirement_id) do nothing returning id into jid;
  return jsonb_build_object('job_id', jid, 'cv_file_id', fid);
end $$;
-- Claim one job (the worker calls this once per Edge Function call).
create or replace function desk_claim_cv_job(p_job bigint default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me member := current_member(); j cv_job; f cv_file; r requirement;
begin
  select * into j from cv_job where company_id = me.company_id and status = 'queued' and (p_job is null or id = p_job)
    order by id limit 1 for update skip locked;
  if j.id is null then return null; end if;
  update cv_job set status = 'running', attempts = attempts + 1, locked_at = now() where id = j.id;
  select * into f from cv_file where id = j.cv_file_id; select * into r from requirement where id = j.requirement_id;
  return jsonb_build_object('job_id', j.id, 'attempt', j.attempts + 1, 'cv_file_id', f.id, 'application_id', f.application_id,
    'storage_path', f.storage_path, 'file_name', f.file_name, 'sha256', f.sha256, 'referred', f.referred,
    'requirement', jsonb_build_object('id', r.id, 'version', r.version, 'confirmed', true, 'must', r.must, 'nice', r.nice,
      'conditions', r.conditions, 'experience', jsonb_build_object('min', r.exp_min, 'max', r.exp_max), 'weights', r.weights));
end $$;
-- A failed attempt: back to the queue, or after 3 tries "needs a human look" (never a rejection).
create or replace function desk_fail_cv_job(p_job bigint, p_error text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me member := current_member(); j cv_job; f cv_file;
begin
  select * into j from cv_job where id = p_job and company_id = me.company_id;
  if j.id is null then raise exception 'Job not found'; end if;
  if j.attempts >= 3 then
    update cv_job set status = 'needs_human', last_error = left(p_error, 300), finished_at = now() where id = j.id;
    update cv_file set readable = coalesce(readable, false) where id = j.cv_file_id;
    select * into f from cv_file where id = j.cv_file_id;
    insert into score select (scr_compute(f.application_id, j.requirement_id)).* on conflict (application_id, requirement_id) do nothing;
    update score set readable = false, label = 'needs a human look', fit = null, stars = null, under50 = false where application_id = f.application_id and requirement_id = j.requirement_id;
    return jsonb_build_object('status', 'needs_human');
  end if;
  update cv_job set status = 'queued', last_error = left(p_error, 300), locked_at = null where id = j.id;
  return jsonb_build_object('status', 'queued', 'attempts', j.attempts);
end $$;
-- Save the worker's result: masked text, verified evidence; the database checks every quote and computes the score.
create or replace function desk_save_screening(p_job bigint, p_readable boolean, p_masked_text text, p_evidence jsonb, p_cache_key text default null, p_model text default null, p_prompt_version text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me member := current_member(); j cv_job; f cv_file; e jsonb; sc score; kept int := 0; dropped int := 0; masked text;
begin
  select * into j from cv_job where id = p_job and company_id = me.company_id;
  if j.id is null or j.status <> 'running' then raise exception 'Job not running'; end if;
  select * into f from cv_file where id = j.cv_file_id;
  update cv_file set readable = p_readable, masked_text = case when p_readable then p_masked_text end where id = f.id;
  delete from evidence where application_id = f.application_id and requirement_id = j.requirement_id;
  if p_readable then
    masked := scr_norm(p_masked_text);
    for e in select * from jsonb_array_elements(coalesce(p_evidence, '[]')) loop
      -- word-for-word check against the stored masked text, here in the database
      if position(scr_norm(e->>'quote') in masked) > 0 and array_length(regexp_split_to_array(btrim(e->>'quote'), '\s+'), 1) <= 20 then
        insert into evidence(company_id, application_id, requirement_id, item_id, quote, section, confidence)
          values (me.company_id, f.application_id, j.requirement_id, e->>'requirement_id', e->>'quote', e->>'section', e->>'confidence');
        kept := kept + 1;
      else dropped := dropped + 1; end if;
    end loop;
    if p_cache_key is not null then
      insert into evidence_cache(company_id, cache_key, evidence, roles, model, prompt_version)
        values (me.company_id, p_cache_key, (select coalesce(jsonb_agg(x), '[]') from jsonb_array_elements(p_evidence) x where x->>'requirement_id' <> 'role'),
                (select coalesce(jsonb_agg(x), '[]') from jsonb_array_elements(p_evidence) x where x->>'requirement_id' = 'role'), coalesce(p_model, 'unknown'), coalesce(p_prompt_version, 'unknown'))
        on conflict (company_id, cache_key) do nothing;
    end if;
  end if;
  sc := scr_compute(f.application_id, j.requirement_id);
  insert into score values (sc.*) on conflict (application_id, requirement_id) do update set
    version = excluded.version, readable = excluded.readable, label = excluded.label, must_met = excluded.must_met, must_total = excluded.must_total,
    coverage = excluded.coverage, years = excluded.years, exp_in_range = excluded.exp_in_range, nice_met = excluded.nice_met, nice_total = excluded.nice_total,
    cond_met = excluded.cond_met, cond_total = excluded.cond_total, fit = excluded.fit, stars = excluded.stars, under50 = excluded.under50, scored_at = now();
  update cv_job set status = case when p_readable then 'done' else 'needs_human' end, finished_at = now() where id = j.id;
  return jsonb_build_object('fit', sc.fit, 'stars', sc.stars, 'under50', sc.under50, 'readable', p_readable, 'quotes_kept', kept, 'quotes_dropped', dropped);
end $$;
create or replace function desk_cached_evidence(p_key text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('evidence', evidence, 'roles', roles) from evidence_cache where company_id = (current_member()).company_id and cache_key = p_key
$$;

-- ---------- shortlist, filter, override, pins ----------
create or replace function desk_get_shortlist(p_role uuid, p_stars int[] default null, p_limit int default 10) returns jsonb
language sql stable security definer set search_path = public as $$
  with r as (select id from requirement where role_id = p_role and company_id = (current_member()).company_id and confirmed_at is not null order by version desc limit 1)
  select coalesce(jsonb_agg(x order by (x->>'pinned')::boolean desc, (x->>'fit')::int desc, x->>'applied_at'), '[]') from (
    select jsonb_build_object('application_id', s.application_id, 'name', p.full_name, 'fit', s.fit, 'stars', coalesce(s.override_stars, s.stars),
      'coverage', s.coverage, 'years', s.years, 'version', s.version, 'applied_at', s.applied_at,
      'pinned', exists (select 1 from shortlist_pin sp where sp.role_id = p_role and sp.application_id = s.application_id)) x
    from score s join r on r.id = s.requirement_id join application a on a.id = s.application_id join person p on p.id = a.person_id
    where s.status = 'new' and s.fit is not null and not s.under50 and (p_stars is null or coalesce(s.override_stars, s.stars) = any(p_stars))
    order by s.fit desc, s.applied_at limit p_limit) y
$$;
create or replace function desk_explain_fit(p_application uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('score', to_jsonb(s) - 'company_id', 'evidence', coalesce((select jsonb_agg(jsonb_build_object('item', e.item_id, 'quote', e.quote, 'section', e.section, 'confidence', e.confidence))
    from evidence e where e.application_id = s.application_id and e.requirement_id = s.requirement_id), '[]'),
    'requirements', (select jsonb_build_object('version', r.version, 'must', r.must, 'nice', r.nice, 'conditions', r.conditions, 'experience', jsonb_build_array(r.exp_min, r.exp_max), 'weights', r.weights) from requirement r where r.id = s.requirement_id))
  from score s where s.application_id = p_application and s.company_id = (current_member()).company_id
  order by s.version desc limit 1
$$;
create or replace function desk_override_stars(p_application uuid, p_stars int, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me member := current_member(); s score;
begin
  if p_reason not in ('Strong in interview or call','Relevant experience the CV doesn''t show','Referral vouched for skills','Evidence was misread','Weaker than the CV suggests') then
    raise exception 'Pick a reason for the override'; end if;
  select * into s from score where application_id = p_application and company_id = me.company_id order by version desc limit 1;
  if s.application_id is null or s.fit is null then raise exception 'No score to override'; end if;
  update score set override_stars = p_stars, override_reason = p_reason, override_by = me.id, override_at = now()
    where application_id = s.application_id and requirement_id = s.requirement_id;
  perform desk_log('stars_overridden', 'application', p_application, jsonb_build_object('from', s.stars, 'to', p_stars, 'reason', p_reason));
  return jsonb_build_object('from', s.stars, 'to', p_stars);
end $$;
create or replace function desk_pin(p_role uuid, p_application uuid, p_pin boolean default true) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me member := current_member();
begin
  if not exists (select 1 from role where id = p_role and company_id = me.company_id) then raise exception 'Role not found'; end if;
  if not p_pin then delete from shortlist_pin where role_id = p_role and application_id = p_application; return jsonb_build_object('pinned', false); end if;
  if (select count(*) from shortlist_pin where role_id = p_role) >= 5 then raise exception 'At most 5 pins, so the list can still move'; end if;
  insert into shortlist_pin(company_id, role_id, application_id, pinned_by) values (me.company_id, p_role, p_application, me.id) on conflict do nothing;
  return jsonb_build_object('pinned', true);
end $$;
create or replace function desk_mark_contacted(p_application uuid, p_status text default 'contacted') returns jsonb
language plpgsql security definer set search_path = public as $$
declare me member := current_member();
begin
  if p_status not in ('contacted','withdrawn','moved_forward') then raise exception 'Unknown status'; end if;
  update score set status = p_status where application_id = p_application and company_id = me.company_id;
  delete from shortlist_pin where application_id = p_application;
  perform desk_log('shortlist_' || p_status, 'application', p_application);
  return jsonb_build_object('status', p_status);
end $$;

-- ---------- rejection batch: preview only (CTO rule 6: no message is created) ----------
create or replace function desk_prepare_reject_batch(p_role uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me member := current_member(); r requirement; people jsonb; bid uuid := gen_random_uuid(); oldest timestamptz;
begin
  select * into r from requirement where role_id = p_role and company_id = me.company_id and confirmed_at is not null order by version desc limit 1;
  if r.id is null then raise exception 'Confirm the requirements card first'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('application_id', s.application_id, 'name', p.full_name, 'must_met', s.must_met, 'must_total', s.must_total,
           'missing', (select coalesce(jsonb_agg(x->>'label'), '[]') from jsonb_array_elements(r.must) x
                       where not exists (select 1 from evidence e where e.application_id = s.application_id and e.requirement_id = r.id and e.item_id = x->>'id' and e.confidence in ('high','medium'))))
           order by s.applied_at), '[]'), min(s.applied_at)
    into people, oldest
    from score s join application a on a.id = s.application_id join person p on p.id = a.person_id
    where s.requirement_id = r.id and s.under50 and s.status = 'new';
  perform desk_log('reject_batch_previewed', 'role', p_role, jsonb_build_object('batch_id', bid, 'count', jsonb_array_length(people), 'preview_only', true));
  return jsonb_build_object('batch_id', bid, 'role_id', p_role, 'version', r.version, 'reason', 'skills_gap', 'people', people,
    'oldest_application', oldest, 'preview_only', true,
    'note', 'Hi {name}, thank you for applying. We''ve decided not to move forward because your profile doesn''t yet show {missing}, which this role needs. If you think we missed something, reply and a person will look again.');
end $$;

-- ---------- grants: signed-in users only ----------
do $$ declare f text; begin
  foreach f in array array['desk_draft_requirements(uuid,jsonb,jsonb,jsonb,numeric,numeric,jsonb)','desk_confirm_requirements(uuid)',
    'desk_enqueue_cv(uuid,uuid,text,text,text,text,boolean,boolean)','desk_claim_cv_job(bigint)','desk_fail_cv_job(bigint,text)',
    'desk_save_screening(bigint,boolean,text,jsonb,text,text,text)','desk_cached_evidence(text)','desk_get_shortlist(uuid,int[],int)',
    'desk_explain_fit(uuid)','desk_override_stars(uuid,int,text)','desk_pin(uuid,uuid,boolean)','desk_mark_contacted(uuid,text)','desk_prepare_reject_batch(uuid)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
