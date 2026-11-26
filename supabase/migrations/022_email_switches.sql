-- 022_email_switches.sql — founder order 26 Nov 15:23, items 3 and 6.
-- Item 3: approved offers, letters, chases and Closure Notes go out by email through Resend, from
--   "<Company> via Clearstage". The send-email function claims queued messages (email_claim), sends each, and records
--   the result (email_result): sent, failed after 3 tries, or no address. Every send and final failure is audited
--   (message id only, no address or text). WhatsApp stays a preview: an outbound WhatsApp message is sent by email.
--   Once queued, a message can't be edited by a user (only cancelled), so what was approved is what goes out.
-- Item 6: platform safety switches, set by the platform admin only and logged in platform_audit:
--   desk_off       — Desk AI and CV screening paused for every company (approvals and screens still work);
--   sending_paused — nothing is sent; messages stay queued until it's switched back;
--   pilot_cap      — how many real companies may have live CV screening. 1 until the founder approves the number (FA-015).
-- Re-runnable. All people in tests are fictional.

-- ---------- item 6: platform switches ----------
create table if not exists platform_setting (key text primary key check (key in ('desk_off', 'sending_paused', 'pilot_cap')),
  value jsonb not null, updated_by uuid, updated_at timestamptz not null default now());
alter table platform_setting enable row level security;
revoke all on platform_setting from anon, authenticated;
insert into platform_setting(key, value) values ('desk_off', 'false'), ('sending_paused', 'false'), ('pilot_cap', '1') on conflict do nothing;

create table if not exists platform_audit (id bigint generated always as identity primary key, action text not null, detail jsonb not null default '{}',
  by_user uuid, at timestamptz not null default now());
alter table platform_audit enable row level security;
revoke all on platform_audit from anon, authenticated;

/** A platform switch (desk_off, sending_paused). Not company data; every signed-in user's functions read it. */
create or replace function platform_flag(p_key text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select value = 'true'::jsonb from platform_setting where key = p_key and p_key in ('desk_off', 'sending_paused')), false)
$$;
revoke all on function platform_flag(text) from public, anon; grant execute on function platform_flag(text) to authenticated;

create or replace function pilot_cap() returns int
language sql stable security definer set search_path = public as $$
  select coalesce((select (value #>> '{}')::int from platform_setting where key = 'pilot_cap'), 1)
$$;
revoke all on function pilot_cap() from public, anon; grant execute on function pilot_cap() to authenticated;
-- The CV switch (021) reads the pilot cap now.
create or replace function cv_live_cap() returns int language sql stable as $$ select pilot_cap() $$;
grant execute on function cv_live_cap() to authenticated;

/** Platform admin only: Desk off / pause all sending. */
create or replace function set_platform_switch(p_key text, p_on boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare was jsonb;
begin
  if not is_platform_admin() then raise exception 'Only Clearstage can use the safety switches'; end if;
  if p_key not in ('desk_off', 'sending_paused') then raise exception 'Unknown switch'; end if;
  select value into was from platform_setting where key = p_key;
  update platform_setting set value = to_jsonb(coalesce(p_on, false)), updated_by = auth.uid(), updated_at = now() where key = p_key;
  insert into platform_audit(action, detail, by_user) values ('switch_set', jsonb_build_object('key', p_key, 'from', was, 'to', coalesce(p_on, false)), auth.uid());
  return jsonb_build_object('key', p_key, 'on', coalesce(p_on, false));
end $$;
revoke all on function set_platform_switch(text, boolean) from public, anon; grant execute on function set_platform_switch(text, boolean) to authenticated;

/** Platform admin only: the pilot cap. Set the number only once the founder's register says FA-015 is Approved. */
create or replace function set_pilot_cap(p_n int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare live int; was jsonb;
begin
  if not is_platform_admin() then raise exception 'Only Clearstage can set the pilot cap'; end if;
  if p_n is null or p_n < 1 or p_n > 10 then raise exception 'The pilot cap must be between 1 and 10'; end if;
  select count(*) into live from company where cv_live and not is_sample;
  if p_n < live then raise exception '% companies are live now. Switch some off before lowering the cap to %', live, p_n; end if;
  select value into was from platform_setting where key = 'pilot_cap';
  update platform_setting set value = to_jsonb(p_n), updated_by = auth.uid(), updated_at = now() where key = 'pilot_cap';
  insert into platform_audit(action, detail, by_user) values ('pilot_cap_set', jsonb_build_object('from', was, 'to', p_n), auth.uid());
  return jsonb_build_object('pilot_cap', p_n);
end $$;
revoke all on function set_pilot_cap(int) from public, anon; grant execute on function set_pilot_cap(int) to authenticated;

/** Platform admin only: the switches, the cap and the email queue across companies (counts only). */
create or replace function platform_status() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_platform_admin() then raise exception 'Only Clearstage can see the safety switches'; end if;
  return jsonb_build_object('desk_off', platform_flag('desk_off'), 'sending_paused', platform_flag('sending_paused'), 'pilot_cap', pilot_cap(),
    'cv_live_companies', (select count(*) from company where cv_live and not is_sample),
    'emails_queued', (select count(*) from message where channel = 'email' and direction = 'out' and status in ('queued', 'sending')),
    'emails_failed', (select count(*) from message where channel = 'email' and direction = 'out' and status in ('failed', 'no_address')));
end $$;
revoke all on function platform_status() from public, anon; grant execute on function platform_status() to authenticated;

-- Desk off reaches Desk (desk_ai_context, desk_live_enabled) and CV screening.
create or replace function desk_live_enabled() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select c.desk_enabled from company c where c.id = (current_member()).company_id), false) and not platform_flag('desk_off')
$$;
revoke all on function desk_live_enabled() from public, anon; grant execute on function desk_live_enabled() to authenticated;
create or replace function cv_screening_enabled() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select case when c.is_sample then c.desk_enabled else c.cv_live end from company c where c.id = (current_member()).company_id), false)
         and not platform_flag('desk_off')
$$;
revoke all on function cv_screening_enabled() from public, anon; grant execute on function cv_screening_enabled() to authenticated;
create or replace function desk_ai_context() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('company_id', c.id, 'is_sample', c.is_sample, 'desk_enabled', c.desk_enabled and not platform_flag('desk_off'),
    'desk_off', platform_flag('desk_off'), 'cv_live', c.cv_live,
    'channels', '["app", "email"]'::jsonb)        -- WhatsApp: not connected for any company yet (Gupshup sandbox pending)
  from company c where c.id = (current_member()).company_id
$$;
revoke all on function desk_ai_context() from public, anon; grant execute on function desk_ai_context() to authenticated;

-- ---------- item 3: email ----------
alter table message add column if not exists subject text;
alter table message add column if not exists kind text;
alter table message add column if not exists attempts int not null default 0;
alter table message add column if not exists last_error text;
alter table message add column if not exists claimed_at timestamptz;
alter table message add column if not exists sent_at timestamptz;

/** Outbound rules: WhatsApp isn't connected, so it goes by email; a user can queue or cancel a message, never edit one
 *  or set its delivery state (only the email functions below, which run as the database, do that). */
create or replace function message_out_rules() returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if new.direction = 'out' and new.channel = 'whatsapp' then new.channel := 'email'; end if;     -- QA-041: WhatsApp off
    if current_user in ('authenticated', 'anon') and new.direction = 'out' then
      new.status := 'queued'; new.provider_id := null; new.attempts := 0; new.last_error := null; new.claimed_at := null; new.sent_at := null;
    end if;
    return new;
  end if;
  if current_user in ('authenticated', 'anon') and (new.body, new.subject, new.kind, new.to_person, new.to_member, new.channel, new.direction, new.status,
      new.provider_id, new.attempts, new.last_error, new.claimed_at, new.sent_at, new.company_id)
      is distinct from (old.body, old.subject, old.kind, old.to_person, old.to_member, old.channel, old.direction, old.status,
      old.provider_id, old.attempts, old.last_error, old.claimed_at, old.sent_at, old.company_id) then
    raise exception 'A queued message can''t be edited. Cancel it and draft a new one';
  end if;
  return new;
end $$;
drop trigger if exists message_out_rules on message;
create trigger message_out_rules before insert or update on message for each row execute function message_out_rules();

/** The subject line for a message, from its kind. */
create or replace function email_subject(p_kind text, p_company text) returns text language sql immutable as $$
  select case
    when p_kind = 'offer' then 'Your offer from ' || p_company
    when p_kind = 'offer_letter' then 'Your offer letter from ' || p_company
    when p_kind = 'appointment_letter' then 'Your appointment letter from ' || p_company
    when p_kind = 'confirmation_letter' then 'Your confirmation letter from ' || p_company
    when p_kind = 'probation_extension' then 'About your probation at ' || p_company
    when p_kind = 'rejection_note' then 'Your application to ' || p_company
    when p_kind = 'chase' then 'Reminder from ' || p_company
    else 'A message from ' || p_company end $$;
grant execute on function email_subject(text, text) to authenticated;

-- Approving queues the email with its kind and subject (same rules as 004 otherwise).
create or replace function desk_approve(p_subject_type text, p_subject_id uuid)
returns jsonb language plpgsql as $$
declare me member := current_member(); o offer; d document; n int := 0; pid uuid; co text;
begin
  if me.id is null then raise exception 'Sign in first'; end if;
  select name into co from company where id = me.company_id;
  if p_subject_type = 'role' then
    update role set status = 'open', approved_by = me.id where id = p_subject_id and status in ('draft','awaiting_approval');
    get diagnostics n = row_count;
  elsif p_subject_type = 'offer' then
    update offer set status = 'sent', approved_by = me.id, valid_until = current_date + 3
      where id = p_subject_id and status in ('draft','in_review') and (wages_check->>'passes')::boolean returning * into o;
    get diagnostics n = row_count;
    if n = 1 then
      select a.person_id into pid from application a where a.id = o.application_id;
      insert into message(company_id, channel, to_person, body, approved_by, status, kind, subject)
        values (me.company_id, 'email', pid, 'Your offer from ' || co || ' is ready to review.', me.id, 'queued', 'offer', email_subject('offer', co));
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

/** Claim up to p_limit queued emails of the caller's company for sending. Returns { paused, messages: [...] }.
 *  A person only gets an email that a person approved; a Recruiter-only member never claims a joiner's or employee's.
 *  No address on file → status no_address. A claim left "sending" for 10 minutes is retried (3 tries in all). */
create or replace function email_claim(p_limit int default 10) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me member := current_member(); m record; out jsonb := '[]'; addr text; co text;
begin
  if me.id is null then raise exception 'Sign in first'; end if;
  if platform_flag('sending_paused') then return jsonb_build_object('paused', true, 'messages', '[]'::jsonb); end if;
  select name into co from company where id = me.company_id;
  for m in select x.*, p.email p_email, p.full_name p_name, mb.email m_email, mb.full_name m_name, ap.email ap_email
           from message x left join person p on p.id = x.to_person left join member mb on mb.id = x.to_member left join member ap on ap.id = x.approved_by
           where x.company_id = me.company_id and x.channel = 'email' and x.direction = 'out'
             and (x.status = 'queued' or (x.status = 'sending' and x.claimed_at < now() - interval '10 minutes' and x.attempts < 3))
             and (x.to_person is null or x.approved_by is not null)
             and (not hire_only(me.company_id) or hs_person(x.to_person))
           order by x.created_at limit least(greatest(coalesce(p_limit, 10), 1), 50)
           for update of x skip locked loop
    addr := coalesce(nullif(trim(m.p_email), ''), nullif(trim(m.m_email), ''));
    if addr is null or addr !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' then
      update message set status = 'no_address', last_error = 'No email address on file' where id = m.id;
      continue;
    end if;
    update message set status = 'sending', attempts = attempts + 1, claimed_at = now() where id = m.id;
    out := out || jsonb_build_object('id', m.id, 'to', addr, 'to_name', coalesce(m.p_name, m.m_name), 'subject', coalesce(m.subject, email_subject(m.kind, co)),
      'body', m.body, 'company', co, 'reply_to', m.ap_email);
  end loop;
  return jsonb_build_object('paused', false, 'messages', out);
end $$;
revoke all on function email_claim(int) from public, anon; grant execute on function email_claim(int) to authenticated;

/** Record what happened to one claimed email. A failure goes back to the queue until the 3rd try, then "failed". */
create or replace function email_result(p_id uuid, p_ok boolean, p_provider_id text default null, p_error text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me member := current_member(); m message; st text;
begin
  if me.id is null then raise exception 'Sign in first'; end if;
  select * into m from message where id = p_id and company_id = me.company_id for update;
  if m.id is null or m.status <> 'sending' then raise exception 'That email isn''t being sent'; end if;
  if p_ok then
    st := 'sent';
    update message set status = st, provider_id = left(p_provider_id, 100), sent_at = now(), last_error = null where id = m.id;
    insert into audit_event(company_id, actor_kind, action, subject_type, subject_id, detail)
      values (m.company_id, 'system', 'email_sent', 'message', m.id, jsonb_build_object('kind', m.kind, 'attempt', m.attempts));
  else
    st := case when m.attempts >= 3 then 'failed' else 'queued' end;
    update message set status = st, last_error = left(coalesce(p_error, 'Not sent'), 200) where id = m.id;
    if st = 'failed' then
      insert into audit_event(company_id, actor_kind, action, subject_type, subject_id, detail)
        values (m.company_id, 'system', 'email_failed', 'message', m.id, jsonb_build_object('kind', m.kind, 'attempts', m.attempts));
    end if;
  end if;
  return jsonb_build_object('id', m.id, 'status', st);
end $$;
revoke all on function email_result(uuid, boolean, text, text) from public, anon; grant execute on function email_result(uuid, boolean, text, text) to authenticated;

/** Put a failed email (or one that had no address) back in the queue. */
create or replace function email_retry(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me member := current_member(); m message;
begin
  if me.id is null then raise exception 'Sign in first'; end if;
  select * into m from message where id = p_id and company_id = me.company_id;
  if m.id is null or (hire_only(me.company_id) and not hs_person(m.to_person)) then raise exception 'That email isn''t in your workspace'; end if;
  if m.status not in ('failed', 'no_address') then raise exception 'Only a failed email can be retried'; end if;
  update message set status = 'queued', attempts = 0, last_error = null where id = m.id;
  perform desk_log('email_retried', 'message', m.id, '{}'::jsonb);
  return jsonb_build_object('id', m.id, 'status', 'queued');
end $$;
revoke all on function email_retry(uuid) from public, anon; grant execute on function email_retry(uuid) to authenticated;

/** The company's outbox (Settings → Email): newest first. Row-level security applies (invoker). */
create or replace function company_outbox(p_limit int default 20) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(x order by x->>'created_at' desc), '[]') from (
    select jsonb_build_object('id', m.id, 'to', coalesce(p.full_name, mb.full_name), 'subject', m.subject, 'kind', m.kind, 'status', m.status,
      'error', m.last_error, 'attempts', m.attempts, 'created_at', m.created_at, 'sent_at', m.sent_at) x
    from message m left join person p on p.id = m.to_person left join member mb on mb.id = m.to_member
    where m.company_id = (current_member()).company_id and m.direction = 'out' and m.channel = 'email'
    order by m.created_at desc limit least(greatest(coalesce(p_limit, 20), 1), 100)) y
$$;
revoke all on function company_outbox(int) from public, anon; grant execute on function company_outbox(int) to authenticated;

-- The email sender can raise an alert when Resend refuses the key (one per company per hour, as 013).
create or replace function raise_platform_alert(p_kind text, p_detail jsonb default '{}') returns boolean
language plpgsql security definer set search_path = public as $$
declare me member := current_member();
begin
  if p_kind not in ('ai_credit_exhausted', 'ai_key_missing', 'ai_error', 'email_setup') then raise exception 'Unknown alert'; end if;
  if exists (select 1 from platform_alert where kind = p_kind and company_id = me.company_id and created_at > now() - interval '1 hour') then return false; end if;
  insert into platform_alert(kind, company_id, detail) values (p_kind, me.company_id, coalesce(p_detail, '{}') || jsonb_build_object('member', me.id));
  return true;
end $$;
revoke all on function raise_platform_alert(text, jsonb) from public, anon; grant execute on function raise_platform_alert(text, jsonb) to authenticated;

-- SEC-1: every table with row-level security also carries the restrictive fresh-session policy (as in 010)
do $$ declare t record; begin
  for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity loop
    execute format('drop policy if exists session_fresh on public.%I', t.relname);
    execute format('create policy session_fresh on public.%I as restrictive for all to authenticated using ((select public.session_fresh())) with check ((select public.session_fresh()))', t.relname);
  end loop;
end $$;
