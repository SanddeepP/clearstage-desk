-- 023_offer_letter.sql — founder order 26 Nov 15:23, item 4 (CTO approval-packet rulings 21 Nov §4.2–4.4).
-- The offer letter and Annexure A come from the calculator, in versions with a content hash, approved one exact
-- version at a time after the approver has read it to the end:
--   * letter_template: one Clearstage sample offer letter (India), labelled "rules review pending" until the founder's
--     register approves the wording (FA-005). Client DOCX templates come next.
--   * offer_letter_content(offer): the canonical letter as JSON — template id and version, every clause's text, all
--     fields, the full Annexure A lines and the wages check — built by the database from the offer.
--   * offer_version: append-only. A new version is written whenever that content changes; content_hash is the SHA-256
--     of the canonical JSON text (jsonb's normalised form), so the same letter always gives the same hash.
--   * review before approve, in the database: mark_offer_reviewed(version) when the approver reaches Annexure A;
--     desk_approve('offer') refuses unless that same person reviewed the latest version, and records approved_version_id.
--   * Desk can write only role_summary and welcome_line on a letter (set_offer_letter_text); every other line comes
--     from the template and the calculator.
--   * offer_packet(offer): the approval panel — letter, checks, CV (approvers only), history.
-- Re-runnable. All people in tests are fictional.

create table if not exists letter_template (
  id text not null, version int not null, kind text not null, country text, name text not null,
  status text not null default 'rules review pending', clauses jsonb not null, created_at timestamptz not null default now(),
  primary key (id, version));
alter table letter_template enable row level security;
drop policy if exists letter_template_read on letter_template;
create policy letter_template_read on letter_template for select to authenticated using (true);
revoke insert, update, delete on letter_template from anon, authenticated;

insert into letter_template(id, version, kind, country, name, status, clauses) values
('clearstage-offer-in', 1, 'offer_letter', 'IN', 'Clearstage sample offer letter (India)', 'rules review pending', jsonb_build_array(
  jsonb_build_object('id', 'opening', 'text', 'Dear {first_name},'),
  jsonb_build_object('id', 'offer', 'text', 'We are pleased to offer you the position of {role_title} at {company}, based in {city}.'),
  jsonb_build_object('id', 'role_summary', 'text', '{role_summary}'),
  jsonb_build_object('id', 'ctc', 'text', 'Your total cost to company (CTC) will be {ctc_display} a year. The full breakdown is in Annexure A, which is part of this letter.'),
  jsonb_build_object('id', 'joining', 'text', 'We would like you to join on {joining_display}.'),
  jsonb_build_object('id', 'conditions', 'text', 'This offer depends on satisfactory verification of your documents and references. Your appointment letter, given on joining, will set out your probation, notice period and other terms.'),
  jsonb_build_object('id', 'validity', 'text', 'Please confirm your acceptance within 3 days of receiving this letter. After that, this offer lapses.'),
  jsonb_build_object('id', 'welcome', 'text', '{welcome_line}'),
  jsonb_build_object('id', 'closing', 'text', 'Yours sincerely,'),
  jsonb_build_object('id', 'signature', 'text', 'For {company}')))
on conflict (id, version) do nothing;

alter table offer add column if not exists role_summary text check (role_summary is null or length(role_summary) <= 400);
alter table offer add column if not exists welcome_line text check (welcome_line is null or length(welcome_line) <= 200);
alter table offer add column if not exists template_id text not null default 'clearstage-offer-in';
alter table offer add column if not exists template_version int not null default 1;
alter table offer add column if not exists approved_version_id uuid;

/** Indian-style rupees: 1200000 → "₹12,00,000". */
create or replace function inr(n bigint) returns text language plpgsql immutable as $$
declare s text := abs(coalesce(n, 0))::text; head text; tail text;
begin
  if length(s) <= 3 then return case when n < 0 then '-' else '' end || '₹' || s; end if;
  tail := right(s, 3); head := left(s, length(s) - 3);
  head := regexp_replace(head, '(\d)(?=(\d\d)+$)', '\1,', 'g');
  return case when n < 0 then '-' else '' end || '₹' || head || ',' || tail;
end $$;
grant execute on function inr(bigint) to authenticated;

/** The canonical content of an offer's letter (everything the hash covers). Runs as the caller (row-level security). */
create or replace function offer_letter_content(p_offer uuid) returns jsonb
language plpgsql stable set search_path = public as $$
declare o offer; t letter_template; p person; r role; c company; f jsonb; clauses jsonb := '[]'; cl jsonb; txt text; k text;
begin
  select * into o from offer where id = p_offer;
  if o.id is null then return null; end if;
  select * into t from letter_template where id = o.template_id and version = o.template_version;
  select x.* into p from person x join application a on a.person_id = x.id where a.id = o.application_id;
  select x.* into r from role x join application a on a.role_id = x.id where a.id = o.application_id;
  select * into c from company where id = o.company_id;
  f := jsonb_build_object(
    'candidate_name', p.full_name, 'first_name', split_part(coalesce(p.full_name, ''), ' ', 1), 'role_title', r.title, 'company', c.name,
    'city', coalesce(r.city, c.city, ''), 'currency', coalesce(o.currency, c.currency, 'INR'),
    'ctc', o.ctc, 'ctc_display', case when coalesce(o.currency, c.currency, 'INR') = 'INR' then inr(o.ctc) else coalesce(o.currency, c.currency) || ' ' || o.ctc::text end,
    'joining_on', o.joining_on, 'joining_display', coalesce(to_char(o.joining_on, 'FMDD Mon YYYY'), 'a date we agree with you'),
    'role_summary', coalesce(o.role_summary, ''), 'welcome_line', coalesce(o.welcome_line, ''));
  for cl in select * from jsonb_array_elements(t.clauses) loop
    txt := cl->>'text';
    for k in select jsonb_object_keys(f) loop txt := replace(txt, '{' || k || '}', coalesce(f->>k, '')); end loop;
    if btrim(txt) <> '' then clauses := clauses || jsonb_build_array(jsonb_build_object('id', cl->>'id', 'text', txt)); end if;
  end loop;
  return jsonb_build_object(
    'template', jsonb_build_object('id', t.id, 'version', t.version, 'name', t.name, 'status', t.status),
    'fields', f,
    'clauses', clauses,
    'annexure', jsonb_build_object('title', 'Annexure A: salary structure', 'currency', f->'currency',
      'lines', (select coalesce(jsonb_agg(jsonb_build_object('name', x->>'name', 'kind', x->>'kind', 'annual', (x->>'amount')::bigint,
                  'monthly', round((x->>'amount')::numeric / 12)) order by ord), '[]') from jsonb_array_elements(o.components) with ordinality y(x, ord)),
      'ctc', o.ctc, 'wages_percent', o.wages_check->'wages_percent', 'passes', o.wages_check->'passes',
      'label', o.manual_label,
      'note', case when o.manual_label is not null then o.manual_label
              else 'PF: 12% × min(PF wages, ₹25,000) — Code on Social Security, 2020; EPF Scheme; S.O. 5109(E), 17 Sep 2026. Awaiting legal review.' end));
end $$;
revoke all on function offer_letter_content(uuid) from public, anon; grant execute on function offer_letter_content(uuid) to authenticated;

create table if not exists offer_version (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references company(id) on delete cascade,
  offer_id uuid not null references offer(id) on delete cascade,
  version_no int not null,
  content jsonb not null,
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid references member(id),
  created_at timestamptz not null default now(),
  unique (offer_id, version_no));
alter table offer_version enable row level security;
drop policy if exists offer_version_read on offer_version;
create policy offer_version_read on offer_version for select to authenticated using (company_id in (select my_company_ids()));
drop policy if exists hire_scope on offer_version;
create policy hire_scope on offer_version as restrictive for all to authenticated using (not hire_only(company_id) or hs_offer(offer_id)) with check (not hire_only(company_id) or hs_offer(offer_id));
revoke insert, update, delete, truncate on offer_version from anon, authenticated;            -- append-only, written by the database

create table if not exists offer_review (
  version_id uuid not null references offer_version(id) on delete cascade,
  company_id uuid not null references company(id) on delete cascade,
  member_id uuid not null references member(id) on delete cascade,
  reviewed_at timestamptz not null default now(),
  primary key (version_id, member_id));
alter table offer_review enable row level security;
drop policy if exists offer_review_read on offer_review;
create policy offer_review_read on offer_review for select to authenticated using (company_id in (select my_company_ids()));
revoke insert, update, delete, truncate on offer_review from anon, authenticated;

alter table offer drop constraint if exists offer_approved_version_fk;
alter table offer add constraint offer_approved_version_fk foreign key (approved_version_id) references offer_version(id);

create or replace function content_hash(p jsonb) returns text language sql immutable as $$
  select encode(sha256(convert_to(p::text, 'UTF8')), 'hex') $$;
grant execute on function content_hash(jsonb) to authenticated;

/** Write a new version when the letter's content changed (definer: offer_version is append-only for users). */
create or replace function offer_snapshot(p_offer uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare o offer; c jsonb; h text; last offer_version; me member; vid uuid;
begin
  select * into o from offer where id = p_offer;
  if o.id is null then return null; end if;
  c := offer_letter_content(p_offer);
  if c is null then return null; end if;
  h := content_hash(c);
  select * into last from offer_version where offer_id = p_offer order by version_no desc limit 1;
  if last.id is not null and last.content_hash = h then return last.id; end if;
  me := my_member(o.company_id);
  insert into offer_version(company_id, offer_id, version_no, content, content_hash, created_by)
    values (o.company_id, o.id, coalesce(last.version_no, 0) + 1, c, h, me.id) returning id into vid;
  return vid;
end $$;
revoke all on function offer_snapshot(uuid) from public, anon;

create or replace function offer_versioning() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status in ('draft', 'in_review') then
    perform offer_snapshot(new.id);
    -- a new version clears any approval in the same transaction
    if new.approved_version_id is not null and new.approved_version_id <> (select id from offer_version where offer_id = new.id order by version_no desc limit 1) then
      update offer set approved_version_id = null where id = new.id;
    end if;
  end if;
  return null;
end $$;
drop trigger if exists offer_versioning on offer;
create trigger offer_versioning after insert or update of components, ctc, inputs, joining_on, role_summary, welcome_line, template_id, template_version, manual_label on offer
  for each row execute function offer_versioning();

/** The approver has read this version to the end (Annexure A). Only someone who can approve in that company. */
create or replace function mark_offer_reviewed(p_version uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v offer_version; me member;
begin
  select * into v from offer_version where id = p_version and company_id in (select my_company_ids());
  if v.id is null or (hire_only(v.company_id) and not hs_offer(v.offer_id)) then raise exception 'That offer isn''t in your workspace'; end if;
  me := my_member(v.company_id);
  if not can_approve(v.company_id) then raise exception 'Your drafts go to your lead for approval'; end if;
  insert into offer_review(version_id, company_id, member_id) values (v.id, v.company_id, me.id) on conflict do nothing;
  return jsonb_build_object('version_id', v.id, 'version_no', v.version_no, 'reviewed_by', me.full_name);
end $$;
revoke all on function mark_offer_reviewed(uuid) from public, anon; grant execute on function mark_offer_reviewed(uuid) to authenticated;

/** Desk (and people) may write only these two lines of a letter. Everything else comes from the template and calculator. */
create or replace function set_offer_letter_text(p_offer uuid, p_role_summary text default null, p_welcome_line text default null) returns jsonb
language plpgsql set search_path = public as $$
declare o offer;
begin
  select * into o from offer where id = p_offer and company_id = (current_member()).company_id;
  if o.id is null then raise exception 'That offer isn''t in your workspace'; end if;
  if o.status not in ('draft', 'in_review') then raise exception 'That offer has already gone out'; end if;
  if desk_blocked_text(coalesce(p_role_summary, '') || ' ' || coalesce(p_welcome_line, '')) then raise exception 'That wording isn''t allowed in a letter'; end if;
  update offer set role_summary = nullif(btrim(p_role_summary), ''), welcome_line = nullif(btrim(p_welcome_line), '') where id = o.id;
  perform desk_log('offer_letter_text', 'offer', o.id, '{}'::jsonb);
  return jsonb_build_object('offer_id', o.id, 'version', (select version_no from offer_version where offer_id = o.id order by version_no desc limit 1));
end $$;
revoke all on function set_offer_letter_text(uuid, text, text) from public, anon; grant execute on function set_offer_letter_text(uuid, text, text) to authenticated;

-- Approving an offer: one exact version, reviewed to the end by the same person (CTO 21 Nov §4.3).
create or replace function desk_approve(p_subject_type text, p_subject_id uuid)
returns jsonb language plpgsql as $$
declare me member := current_member(); o offer; d document; n int := 0; pid uuid; co text; v offer_version;
begin
  if me.id is null then raise exception 'Sign in first'; end if;
  select name into co from company where id = me.company_id;
  if p_subject_type = 'role' then
    update role set status = 'open', approved_by = me.id where id = p_subject_id and status in ('draft','awaiting_approval');
    get diagnostics n = row_count;
  elsif p_subject_type = 'offer' then
    select * into v from offer_version where offer_id = p_subject_id and company_id = me.company_id order by version_no desc limit 1;
    if v.id is not null and exists (select 1 from offer where id = p_subject_id and status in ('draft', 'in_review'))
       and not exists (select 1 from offer_review where version_id = v.id and member_id = me.id) then
      raise exception 'Open the offer and read the letter to the end (Annexure A) before approving';
    end if;
    update offer set status = 'sent', approved_by = me.id, approved_version_id = v.id, valid_until = current_date + 3
      where id = p_subject_id and status in ('draft','in_review') and (wages_check->>'passes')::boolean returning * into o;
    get diagnostics n = row_count;
    if n = 1 then
      select a.person_id into pid from application a where a.id = o.application_id;
      insert into message(company_id, channel, to_person, body, approved_by, status, kind, subject)
        values (me.company_id, 'email', pid, 'Your offer from ' || co || ' is ready to review.', me.id, 'queued', 'offer', email_subject('offer', co));
      perform desk_log('offer_approved', 'offer', o.id, jsonb_build_object('version', v.version_no, 'content_hash', v.content_hash));
    end if;
  elsif p_subject_type in ('document', 'batch') then
    for d in select * from document where company_id = me.company_id and approved_by is null
               and (case when p_subject_type = 'batch' then batch_id = p_subject_id else id = p_subject_id end) loop
      update document set approved_by = me.id where id = d.id;
      insert into message(company_id, channel, to_person, body, approved_by, status, kind, subject)
        values (me.company_id, 'email', d.person_id, d.body, me.id, 'queued', d.kind, email_subject(d.kind, co));
      if d.kind = 'rejection_note' then
        update application set outcome = 'rejected', stage = 'Rejected', reject_reason = coalesce(d.summary, reject_reason)
          where person_id = d.person_id and outcome is null;
      end if;
      n := n + 1;
    end loop;
  else raise exception 'Unknown approval type %', p_subject_type;
  end if;
  if n = 0 then return jsonb_build_object('approved', 0, 'note', 'Nothing to approve: it may already be approved or not allowed'); end if;
  update task set status = 'done', done_at = now() where kind = 'approval' and subject_id = p_subject_id and status = 'open';
  return jsonb_build_object('approved', n, 'by', me.full_name);
end $$;

-- An offer goes out only with its approved version, and that version is the latest one.
create or replace function offer_sent_version() returns trigger language plpgsql set search_path = public as $$
begin
  if new.status = 'sent' and old.status in ('draft', 'in_review') and exists (select 1 from offer_version where offer_id = new.id) then
    if new.approved_version_id is null or new.approved_version_id <> (select id from offer_version where offer_id = new.id order by version_no desc limit 1) then
      raise exception 'Approve the latest version of the letter';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists offer_sent_version on offer;
create trigger offer_sent_version before update of status on offer for each row execute function offer_sent_version();

/** The approval panel for one offer: letter (latest version, hash), checks, CV (approvers only), history. */
create or replace function offer_packet(p_offer uuid) returns jsonb
language plpgsql stable set search_path = public as $$
declare o offer; v offer_version; me member; r role; cvf cv_file; approver boolean;
begin
  select * into o from offer where id = p_offer and company_id = (current_member()).company_id;
  if o.id is null then raise exception 'That offer isn''t in your workspace'; end if;
  me := current_member(); approver := can_approve(o.company_id);
  select * into v from offer_version where offer_id = o.id order by version_no desc limit 1;
  select x.* into r from role x join application a on a.role_id = x.id where a.id = o.application_id;
  select * into cvf from cv_file where application_id = o.application_id order by created_at desc limit 1;
  return jsonb_build_object(
    'offer_id', o.id, 'status', o.status, 'can_approve', approver,
    'version', case when v.id is null then null else jsonb_build_object('id', v.id, 'no', v.version_no, 'hash', v.content_hash, 'content', v.content, 'created_at', v.created_at,
      'reviewed_by_me', exists (select 1 from offer_review x where x.version_id = v.id and x.member_id = me.id)) end,
    'approved_version', (select jsonb_build_object('no', x.version_no, 'hash', x.content_hash) from offer_version x where x.id = o.approved_version_id),
    'versions', (select coalesce(jsonb_agg(jsonb_build_object('no', x.version_no, 'hash', x.content_hash, 'created_at', x.created_at,
                  'by', (select full_name from member m where m.id = x.created_by)) order by x.version_no desc), '[]') from offer_version x where x.offer_id = o.id),
    'checks', jsonb_build_object('wages_percent', o.wages_check->'wages_percent', 'passes', o.wages_check->'passes', 'rule', 'Code on Wages: wages at least 50% of pay',
      'in_budget', case when r.budget_max is null then null else o.ctc between coalesce(r.budget_min, 0) and r.budget_max end,
      'budget', case when r.budget_max is null then null else jsonb_build_object('min', r.budget_min, 'max', r.budget_max) end,
      'template_status', v.content->'template'->>'status', 'manual_label', o.manual_label),
    'cv', case when cvf.id is null then null else jsonb_build_object('file_name', cvf.file_name, 'readable', cvf.readable,
      'storage_path', case when approver then cvf.storage_path end) end,
    'history', (select coalesce(jsonb_agg(jsonb_build_object('action', e.action, 'at', e.created_at, 'by', (select full_name from member m where m.id = e.actor_member),
                  'detail', e.detail - 'inputs') order by e.created_at desc), '[]')
                from audit_event e where e.company_id = o.company_id and ((e.subject_type = 'offer' and e.subject_id = o.id) or (e.subject_type = 'application' and e.subject_id = o.application_id))));
end $$;
revoke all on function offer_packet(uuid) from public, anon; grant execute on function offer_packet(uuid) to authenticated;

-- Existing draft offers get their first version now.
do $$ declare x record; begin
  for x in select id from offer where status in ('draft', 'in_review') loop perform offer_snapshot(x.id); end loop;
end $$;

-- SEC-1: every table with row-level security also carries the restrictive fresh-session policy (as in 010)
do $$ declare t record; begin
  for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity loop
    execute format('drop policy if exists session_fresh on public.%I', t.relname);
    execute format('create policy session_fresh on public.%I as restrictive for all to authenticated using ((select public.session_fresh())) with check ((select public.session_fresh()))', t.relname);
  end loop;
end $$;
