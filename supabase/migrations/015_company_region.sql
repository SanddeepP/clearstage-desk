-- 015_company_region.sql — CTO ruling "Global-ready company settings" (25 Nov), G1 data part.
-- 1. Reference tables: country (currency, locale, default time zone and working week) and holiday (calendar + day).
-- 2. Company fields: country, state_region, currency, timezone, locale, working_week, holiday_calendar, data_region.
--    Existing companies get the India defaults; a new company can't exist without a country and a time zone.
-- 3. Sign-up: create_company_for_me takes country, region and time zone; currency and locale come from the country.
-- 4. Server rules read the company: working time (week, hours, holidays, time zone), the task scheduler's quiet hours,
--    the Today buckets, the chase cooldown message.
-- 5. Statutory packs keyed by country + region + effective date. India (IN, professional tax under IN-TG) is pack 1.
--    No pack for the company's country -> the calculator doesn't run; Annexure A takes manual lines with a label, and
--    only the arithmetic check runs. Every offer stores its currency. No conversion, ever.
-- Re-runnable.

-- ---------- 1. reference tables ----------
create table if not exists country (
  code text primary key check (code ~ '^[A-Z]{2}$'),                 -- ISO 3166-1 alpha-2
  name text not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),           -- ISO 4217
  locale text not null,                                             -- BCP-47
  default_timezone text not null,                                   -- IANA
  working_week jsonb not null
);
insert into country(code, name, currency, locale, default_timezone, working_week) values
  ('IN', 'India',                'INR', 'en-IN', 'Asia/Kolkata',      '{"days":[1,2,3,4,5,6],"start":"09:00","end":"19:00"}'),
  ('GB', 'United Kingdom',       'GBP', 'en-GB', 'Europe/London',     '{"days":[1,2,3,4,5],"start":"09:00","end":"17:30"}'),
  ('IE', 'Ireland',              'EUR', 'en-IE', 'Europe/Dublin',     '{"days":[1,2,3,4,5],"start":"09:00","end":"17:30"}'),
  ('US', 'United States',        'USD', 'en-US', 'America/New_York',  '{"days":[1,2,3,4,5],"start":"09:00","end":"17:00"}'),
  ('CA', 'Canada',               'CAD', 'en-CA', 'America/Toronto',   '{"days":[1,2,3,4,5],"start":"09:00","end":"17:00"}'),
  ('AE', 'United Arab Emirates', 'AED', 'en-AE', 'Asia/Dubai',        '{"days":[1,2,3,4,5],"start":"09:00","end":"18:00"}'),
  ('SG', 'Singapore',            'SGD', 'en-SG', 'Asia/Singapore',    '{"days":[1,2,3,4,5],"start":"09:00","end":"18:00"}'),
  ('MY', 'Malaysia',             'MYR', 'en-MY', 'Asia/Kuala_Lumpur', '{"days":[1,2,3,4,5],"start":"09:00","end":"18:00"}'),
  ('AU', 'Australia',            'AUD', 'en-AU', 'Australia/Sydney',  '{"days":[1,2,3,4,5],"start":"09:00","end":"17:00"}'),
  ('NZ', 'New Zealand',          'NZD', 'en-NZ', 'Pacific/Auckland',  '{"days":[1,2,3,4,5],"start":"09:00","end":"17:00"}'),
  ('NL', 'Netherlands',          'EUR', 'nl-NL', 'Europe/Amsterdam',  '{"days":[1,2,3,4,5],"start":"09:00","end":"17:30"}'),
  ('DE', 'Germany',              'EUR', 'de-DE', 'Europe/Berlin',     '{"days":[1,2,3,4,5],"start":"09:00","end":"17:30"}'),
  ('FI', 'Finland',              'EUR', 'fi-FI', 'Europe/Helsinki',   '{"days":[1,2,3,4,5],"start":"08:00","end":"16:00"}')
on conflict (code) do update set name = excluded.name, currency = excluded.currency, locale = excluded.locale,
  default_timezone = excluded.default_timezone, working_week = excluded.working_week;

create table if not exists holiday (
  calendar text not null check (calendar ~ '^[A-Z]{2}(-[A-Z0-9]{1,3})?$'),   -- a country (IN) or ISO 3166-2 region (IN-TG, GB-ENG)
  day date not null,
  name text not null,
  primary key (calendar, day)
);
-- IN-TG: Telangana general holidays 2026 (state GO) + national 2027 (same list as lib/holidays.js; * = moon-dependent)
insert into holiday(calendar, day, name) values
  ('IN-TG','2026-01-14','Bhogi'),('IN-TG','2026-01-15','Sankranti / Pongal'),('IN-TG','2026-01-26','Republic Day'),
  ('IN-TG','2026-02-15','Maha Shivaratri'),('IN-TG','2026-03-03','Holi'),('IN-TG','2026-03-19','Ugadi'),
  ('IN-TG','2026-03-21','Eid-ul-Fitr*'),('IN-TG','2026-03-22','Day after Eid-ul-Fitr*'),('IN-TG','2026-03-27','Sri Rama Navami'),
  ('IN-TG','2026-04-03','Good Friday'),('IN-TG','2026-04-05','Babu Jagjivan Ram''s birthday'),('IN-TG','2026-04-14','Dr B.R. Ambedkar''s birthday'),
  ('IN-TG','2026-05-27','Eid-ul-Adha*'),('IN-TG','2026-06-26','Muharram*'),('IN-TG','2026-08-10','Bonalu'),
  ('IN-TG','2026-08-15','Independence Day'),('IN-TG','2026-08-26','Milad-un-Nabi*'),('IN-TG','2026-09-04','Sri Krishna Ashtami'),
  ('IN-TG','2026-09-14','Vinayaka Chavithi'),('IN-TG','2026-10-02','Gandhi Jayanti'),('IN-TG','2026-10-18','Saddula Bathukamma'),
  ('IN-TG','2026-10-20','Vijaya Dasami'),('IN-TG','2026-10-21','Day after Vijaya Dasami'),('IN-TG','2026-11-08','Deepavali'),
  ('IN-TG','2026-11-24','Kartika Purnima / Guru Nanak Jayanti'),('IN-TG','2026-12-25','Christmas'),('IN-TG','2026-12-26','Boxing Day'),
  ('IN-TG','2027-01-26','Republic Day'),('IN-TG','2027-08-15','Independence Day'),('IN-TG','2027-10-02','Gandhi Jayanti'),
  -- IN: national holidays only, for Indian companies in a state without a calendar yet
  ('IN','2026-01-26','Republic Day'),('IN','2026-08-15','Independence Day'),('IN','2026-10-02','Gandhi Jayanti'),
  ('IN','2027-01-26','Republic Day'),('IN','2027-08-15','Independence Day'),('IN','2027-10-02','Gandhi Jayanti'),
  -- GB-ENG: bank holidays in England and Wales, 2026 and 2027 (substitute days where the date falls on a weekend)
  ('GB-ENG','2026-01-01','New Year''s Day'),('GB-ENG','2026-04-03','Good Friday'),('GB-ENG','2026-04-06','Easter Monday'),
  ('GB-ENG','2026-05-04','Early May bank holiday'),('GB-ENG','2026-05-25','Spring bank holiday'),('GB-ENG','2026-08-31','Summer bank holiday'),
  ('GB-ENG','2026-12-25','Christmas Day'),('GB-ENG','2026-12-28','Boxing Day (substitute day)'),
  ('GB-ENG','2027-01-01','New Year''s Day'),('GB-ENG','2027-03-26','Good Friday'),('GB-ENG','2027-03-29','Easter Monday'),
  ('GB-ENG','2027-05-03','Early May bank holiday'),('GB-ENG','2027-05-31','Spring bank holiday'),('GB-ENG','2027-08-30','Summer bank holiday'),
  ('GB-ENG','2027-12-27','Christmas Day (substitute day)'),('GB-ENG','2027-12-28','Boxing Day (substitute day)')
on conflict (calendar, day) do update set name = excluded.name;

alter table country enable row level security;
alter table holiday enable row level security;
drop policy if exists country_read on country;
create policy country_read on country for select to authenticated using (true);
drop policy if exists holiday_read on holiday;
create policy holiday_read on holiday for select to authenticated using (true);
revoke insert, update, delete, truncate on country, holiday from authenticated, anon;

-- ---------- 2. company fields ----------
alter table company add column if not exists country text references country(code);
alter table company add column if not exists state_region text;
alter table company add column if not exists currency text;
alter table company add column if not exists timezone text;
alter table company add column if not exists locale text;
alter table company add column if not exists working_week jsonb;
alter table company add column if not exists holiday_calendar text;
alter table company add column if not exists data_region text;
update company set country = 'IN', state_region = coalesce(state_region, 'IN-TG'), currency = 'INR', timezone = 'Asia/Kolkata',
  locale = 'en-IN', working_week = '{"days":[1,2,3,4,5,6],"start":"09:00","end":"19:00"}', holiday_calendar = 'IN-TG',
  data_region = 'ap-south-1'
  where country is null;
alter table company alter column country set not null, alter column currency set not null, alter column timezone set not null,
  alter column locale set not null, alter column working_week set not null, alter column holiday_calendar set not null,
  alter column data_region set not null;

create or replace function company_region_check() returns trigger language plpgsql set search_path = public as $$
declare c country; d jsonb;
begin
  if new.country is null then raise exception 'Choose the company''s country'; end if;
  select * into c from country where code = new.country;
  if c.code is null then raise exception 'Clearstage doesn''t support the country % yet', new.country; end if;
  if new.timezone is null then raise exception 'Choose the company''s time zone'; end if;
  if not exists (select 1 from pg_timezone_names where name = new.timezone) then raise exception '% isn''t a time zone name', new.timezone; end if;
  if new.state_region is not null and (new.state_region !~ '^[A-Z]{2}-[A-Z0-9]{1,3}$' or left(new.state_region, 2) <> new.country) then
    raise exception 'The state or region must be in %', c.name;
  end if;
  new.currency := coalesce(new.currency, c.currency);
  if not exists (select 1 from country where currency = new.currency) then raise exception '% isn''t a supported currency', new.currency; end if;
  new.locale := coalesce(new.locale, c.locale);
  if not exists (select 1 from country where locale = new.locale) then raise exception '% isn''t a supported locale', new.locale; end if;
  new.working_week := coalesce(new.working_week, c.working_week);
  d := new.working_week->'days';
  if jsonb_typeof(d) <> 'array' or jsonb_array_length(d) = 0
     or exists (select 1 from jsonb_array_elements(d) x where jsonb_typeof(x) <> 'number' or x::int not between 1 and 7)
     or coalesce(new.working_week->>'start', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
     or coalesce(new.working_week->>'end', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
     or (new.working_week->>'start')::time >= (new.working_week->>'end')::time then
    raise exception 'Working week needs days 1-7 (Monday = 1) and a start before the end, like 09:00 to 18:00';
  end if;
  new.holiday_calendar := coalesce(new.holiday_calendar,
    (select h.calendar from holiday h where h.calendar = new.state_region limit 1), new.country);
  if left(new.holiday_calendar, 2) <> new.country then raise exception 'The holiday calendar must be in %', c.name; end if;
  if tg_op = 'INSERT' then new.data_region := coalesce(new.data_region, 'ap-south-1');
  elsif new.data_region is distinct from old.data_region and current_user in ('authenticated', 'anon') then
    raise exception 'The data region is set by Clearstage';
  end if;
  return new;
end $$;
drop trigger if exists company_region_check on company;
create trigger company_region_check before insert or update on company for each row execute function company_region_check();

-- ---------- 3. sign-up ----------
drop function if exists create_company_for_me(text, text, text, text, text);
create or replace function create_company_for_me(p_company text, p_city text, p_full_name text, p_phone text, p_setup text,
                                                 p_country text, p_region text, p_timezone text)
returns uuid language plpgsql security definer set search_path = public as $$
declare cid uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  if not session_fresh() then raise exception 'Your session has expired. Sign in again.' using errcode = '28000'; end if;
  if exists (select 1 from member m join company c on c.id = m.company_id where m.user_id = auth.uid() and not c.is_sample) then raise exception 'You already have a workspace'; end if;
  if length(coalesce(trim(p_company),'')) not between 2 and 120 or length(coalesce(trim(p_full_name),'')) not between 1 and 80
     or length(coalesce(p_city,'')) > 80 then raise exception 'Check the company and name fields'; end if;
  if p_phone is not null and p_phone !~ '^\+[1-9][0-9]{7,14}$' then raise exception 'Phone must be in international format, like +447700900123'; end if;
  if nullif(trim(p_country), '') is null then raise exception 'Choose the company''s country'; end if;
  if nullif(trim(p_timezone), '') is null then raise exception 'Choose the company''s time zone'; end if;
  insert into company(name, city, team_setup, country, state_region, timezone)
    values (trim(p_company), p_city, coalesce(p_setup,'solo'), upper(trim(p_country)), nullif(upper(trim(p_region)), ''), trim(p_timezone))
    returning id into cid;                                   -- currency, locale, week and holidays come from the country (trigger)
  insert into member(company_id, user_id, full_name, email, phone, app_role, whatsapp_opt_in)
    values (cid, auth.uid(), trim(p_full_name), (select email from auth.users where id = auth.uid()), p_phone,
            case when p_setup = 'lead_juniors' then 'lead' else 'owner' end, p_phone is not null);
  insert into audit_event(company_id, actor_kind, action, detail)
    values (cid, 'human', 'company_created', jsonb_build_object('setup', p_setup, 'country', upper(trim(p_country)), 'timezone', trim(p_timezone)));
  return cid;
end $$;
revoke all on function create_company_for_me(text, text, text, text, text, text, text, text) from public, anon;
grant execute on function create_company_for_me(text, text, text, text, text, text, text, text) to authenticated;

-- ---------- 4. working time, by company ----------
create or replace function company_is_working(p_company uuid, p_at timestamptz) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare c company; l timestamp;
begin
  select * into c from company where id = p_company;
  if c.id is null then return false; end if;
  l := p_at at time zone c.timezone;
  return extract(isodow from l)::int in (select x::int from jsonb_array_elements_text(c.working_week->'days') x)
     and not exists (select 1 from holiday where calendar = c.holiday_calendar and day = l::date)
     and l::time >= (c.working_week->>'start')::time and l::time < (c.working_week->>'end')::time;
end $$;

create or replace function company_working_day(c company, d date) returns boolean
language sql stable set search_path = public as $$
  select extract(isodow from d)::int in (select x::int from jsonb_array_elements_text(c.working_week->'days') x)
     and not exists (select 1 from holiday where calendar = c.holiday_calendar and day = d)
$$;

/** Adds working hours in the company's own week, hours, holidays and time zone. */
create or replace function add_working_hours(p_company uuid, p_from timestamptz, p_hours numeric) returns timestamptz
language plpgsql stable security definer set search_path = public as $$
declare c company; cur timestamp; d date; o timestamp; cl timestamp; lft interval := make_interval(secs => p_hours * 3600); room interval;
begin
  select * into c from company where id = p_company;
  if c.id is null then raise exception 'Unknown company'; end if;
  cur := p_from at time zone c.timezone;
  for i in 1..400 loop
    d := cur::date; o := d + (c.working_week->>'start')::time; cl := d + (c.working_week->>'end')::time;
    if not company_working_day(c, d) or cur >= cl then cur := (d + 1) + (c.working_week->>'start')::time; continue; end if;
    if cur < o then cur := o; end if;
    room := cl - cur;
    if lft <= room then return (cur + lft) at time zone c.timezone; end if;
    lft := lft - room; cur := (d + 1) + (c.working_week->>'start')::time;
  end loop;
  raise exception 'No working time in the next 400 days for this company';
end $$;

/** Working hours between two instants, in the company's own working time. */
create or replace function working_hours_between(p_company uuid, p_a timestamptz, p_b timestamptz) returns numeric
language plpgsql stable security definer set search_path = public as $$
declare c company; a timestamp; b timestamp; d date; o timestamp; cl timestamp; total interval := '0';
begin
  select * into c from company where id = p_company;
  if c.id is null or p_b <= p_a then return 0; end if;
  a := p_a at time zone c.timezone; b := p_b at time zone c.timezone; d := a::date;
  while d <= b::date and d <= a::date + 400 loop
    if company_working_day(c, d) then
      o := greatest(d + (c.working_week->>'start')::time, a); cl := least(d + (c.working_week->>'end')::time, b);
      if cl > o then total := total + (cl - o); end if;
    end if;
    d := d + 1;
  end loop;
  return round(extract(epoch from total) / 3600, 2);
end $$;
revoke all on function company_is_working(uuid, timestamptz) from public, anon, authenticated;
revoke all on function company_working_day(company, date) from public, anon, authenticated;
revoke all on function add_working_hours(uuid, timestamptz, numeric) from public, anon, authenticated;
revoke all on function working_hours_between(uuid, timestamptz, timestamptz) from public, anon, authenticated;

-- Scheduler: reminders and escalations only inside the company's working time (quiet hours outside it)
create or replace function run_task_scheduler(p_now timestamptz default now())
returns table (task_id uuid, action text, to_member uuid)
language plpgsql security definer set search_path = public as $$
declare t record; cycle interval; nxt uuid;
begin
  for t in
    select * from task where status = 'open' and due_at is not null and due_at < p_now
    for update skip locked
  loop
    continue when not company_is_working(t.company_id, p_now);                            -- quiet hours, weekends, holidays
    cycle := make_interval(secs => coalesce((t.reminder_rule->>'every_hours')::numeric, 24) * 3600);
    continue when t.last_reminded_at is not null and p_now - t.last_reminded_at < cycle;   -- one step per cycle

    if (t.last_reminded_at is not null or t.owner_id is null)
       and t.escalated_level < coalesce(array_length(t.escalation_chain, 1), 0) then
      nxt := t.escalation_chain[t.escalated_level + 1];
      update task set escalated_level = escalated_level + 1, last_reminded_at = p_now where id = t.id;
      insert into message(company_id, channel, to_member, body, status)
        values (t.company_id, 'whatsapp', nxt, 'Escalation: ' || t.title, 'queued');
      insert into audit_event(company_id, actor_kind, action, subject_type, subject_id, detail)
        values (t.company_id, 'system', 'task_escalated', 'task', t.id, jsonb_build_object('to', nxt, 'level', t.escalated_level + 1));
      task_id := t.id; action := 'escalated'; to_member := nxt; return next;
    elsif t.owner_id is not null then
      update task set last_reminded_at = p_now where id = t.id;
      insert into message(company_id, channel, to_member, body, status)
        values (t.company_id, 'whatsapp', t.owner_id, 'Reminder: ' || t.title, 'queued');
      insert into audit_event(company_id, actor_kind, action, subject_type, subject_id)
        values (t.company_id, 'system', 'task_reminded', 'task', t.id);
      task_id := t.id; action := 'reminded'; to_member := t.owner_id; return next;
    end if;
  end loop;
end $$;
revoke all on function run_task_scheduler(timestamptz) from public, anon, authenticated;

-- Today buckets by the company's own date
create or replace view today_tasks with (security_invoker = true) as
select t.*,
  case
    when t.status = 'done' then 'Done'
    when t.due_at < now() then 'Late'
    when (t.due_at at time zone c.timezone)::date = (now() at time zone c.timezone)::date then 'Today'
    else 'This week'
  end as bucket
from task t join company c on c.id = t.company_id
where t.status in ('open','done') and (t.due_at is null or t.due_at < now() + interval '7 days');

-- Chase cooldown message in the company's time zone
create or replace function desk_chase_owner(p_task uuid) returns jsonb language plpgsql as $$
declare t task; o member; last_chase timestamptz; tz text; ab text;
begin
  select * into t from task where id = p_task;
  if t.id is null or t.status <> 'open' then raise exception 'That task is not open'; end if;
  select * into o from member where id = t.owner_id;
  if o.id is null then raise exception 'That task has no owner to chase'; end if;
  select timezone into tz from company where id = t.company_id;
  select abbrev into ab from pg_timezone_names where name = tz;
  select max(created_at) into last_chase from audit_event
    where company_id = t.company_id and action = 'owner_chased' and subject_id = t.id;
  if last_chase is not null and last_chase > now() - interval '4 hours' then
    raise exception '% was already chased at % %. You can chase again after %.', o.full_name,
      to_char(last_chase at time zone tz, 'HH24:MI'), ab,
      to_char((last_chase + interval '4 hours') at time zone tz, 'HH24:MI');
  end if;
  insert into message(company_id, channel, to_member, body, status) values (t.company_id, 'whatsapp', o.id, 'Reminder: ' || t.title, 'queued');
  perform desk_log('owner_chased', 'task', t.id, jsonb_build_object('owner', o.id));
  return jsonb_build_object('chased', o.full_name, 'has_whatsapp', o.phone is not null,
    'next_chase_after', now() + interval '4 hours',
    'escalates_to', (select full_name from member where id = t.escalation_chain[t.escalated_level + 1]));
end $$;
revoke all on function desk_chase_owner(uuid) from public, anon;
grant execute on function desk_chase_owner(uuid) to authenticated;

-- ---------- 5. statutory packs by country + region + effective date ----------
alter table statutory_rule add column if not exists country text not null default 'IN' references country(code);
alter table statutory_rule add column if not exists region text;
update statutory_rule set code = 'pt_slabs', region = 'IN-TG' where code = 'pt_slabs_tg';
alter table statutory_rule drop constraint if exists statutory_rule_once;
create unique index if not exists statutory_rule_key on statutory_rule (country, coalesce(region, ''), code, effective_from);

create or replace function has_statutory_pack(p_country text) returns boolean
language sql stable set search_path = public as $$ select exists (select 1 from statutory_rule where country = p_country) $$;

drop function if exists rule_value(text, date);
drop function if exists rule_row(text, date);
create or replace function rule_row(p_code text, p_on date, p_country text default 'IN', p_region text default null) returns statutory_rule
language plpgsql stable set search_path = public as $$
declare r statutory_rule;
begin
  select * into r from statutory_rule
    where country = p_country and code = p_code and (region is null or region = p_region)
      and effective_from <= p_on and (effective_to is null or p_on <= effective_to)
    order by (region is not null) desc, effective_from desc limit 1;
  if r.id is null then raise exception 'No % rule in force on % for %', p_code, p_on, coalesce(p_region, p_country); end if;
  return r;
end $$;
create or replace function rule_value(p_code text, p_on date, p_country text default 'IN', p_region text default null) returns jsonb
language sql stable set search_path = public as $$ select (rule_row(p_code, p_on, p_country, p_region)).value $$;

-- The India calculator, now reading the company's country and region. Same arithmetic as 008.
drop function if exists ctc_breakup(jsonb, date);
create or replace function ctc_breakup(p_inputs jsonb, p_offer_date date default current_date, p_country text default 'IN', p_region text default 'IN-TG') returns jsonb
language plpgsql stable set search_path = public as $$
declare i jsonb; on_d date; ctc bigint; bm bigint; variable bigint;
        pf_ceiling statutory_rule; esi statutory_rule; pt_rule statutory_rule;
        pf_wages bigint; basic bigint; hra bigint; employer_pf bigint; gratuity bigint; x bigint; gross bigint; employer_esi bigint := 0;
        special bigint; comps jsonb; chk jsonb; gm bigint; e_pf bigint; e_esi bigint; pt int := 0; s jsonb; lim bigint; warnings jsonb := '[]';
begin
  if not has_statutory_pack(p_country) then
    raise exception 'No statutory rules for % yet. Enter the Annexure lines by hand.', coalesce((select name from country where code = p_country), p_country);
  end if;
  if p_country <> 'IN' then raise exception 'The salary calculator only knows the India pack so far'; end if;
  i := ctc_inputs(p_inputs);
  on_d := coalesce((i->>'joining_on')::date, p_offer_date);
  ctc := (i->>'ctc')::bigint; bm := (i->>'basic_monthly')::bigint; variable := (i->>'variable')::bigint;
  pf_ceiling := rule_row('pf_wage_ceiling', on_d, p_country, p_region); esi := rule_row('esi_wage_limit', on_d, p_country, p_region);
  pf_wages := case when i->>'pf_rule' = 'ceiling' then least(bm, (pf_ceiling.value#>>'{}')::bigint) else bm end;
  basic := bm * 12;
  hra := round(basic * (i->>'hra_pct')::numeric / 100);
  employer_pf := round(0.12 * pf_wages * 12);
  gratuity := round(basic * 15 / 312.0);
  x := ctc - employer_pf - gratuity - variable;
  lim := (esi.value->>(case when (i->>'disability')::boolean then 'disability' else 'general' end))::bigint;
  gross := x;
  if x / 1.0325 / 12 <= lim then gross := round(x / 1.0325); employer_esi := x - gross; end if;   -- CTO §4.1.4
  special := gross - basic - hra;
  if special < 0 then raise exception 'Basic and HRA come to more than the gross pay. Lower Basic or HRA.'; end if;
  comps := jsonb_build_array(
    jsonb_build_object('name','Basic + DA','kind','basic','amount',basic),
    jsonb_build_object('name','HRA','kind','hra','amount',hra),
    jsonb_build_object('name','Special allowance','kind','special','amount',special));
  if variable > 0 then comps := comps || jsonb_build_object('name','Variable pay (at target)','kind','variable','amount',variable); end if;
  comps := comps || jsonb_build_object('name','Employer PF','kind','employer_pf','amount',employer_pf);
  if employer_esi > 0 then comps := comps || jsonb_build_object('name','Employer ESI','kind','employer_esi','amount',employer_esi); end if;
  comps := comps || jsonb_build_object('name','Gratuity','kind','gratuity','amount',gratuity);
  chk := wages_check(comps);
  if (chk->>'ctc')::bigint <> ctc then raise exception 'Internal error: the lines don''t add up to the CTC'; end if;
  gm := round(gross / 12.0);
  e_pf := round(0.12 * pf_wages);
  e_esi := case when employer_esi > 0 then round(gm * 0.0075) else 0 end;
  select * into pt_rule from statutory_rule where country = p_country and region = p_region and code = 'pt_slabs'
    and effective_from <= on_d and (effective_to is null or on_d <= effective_to) order by effective_from desc limit 1;
  if pt_rule.id is null then
    warnings := warnings || to_jsonb(format('No professional tax rule for %s yet: take-home leaves it out.', coalesce(p_region, p_country)));
  else
    for s in select * from jsonb_array_elements(pt_rule.value) loop
      if s->'upto' = 'null'::jsonb or gm <= (s->>'upto')::bigint then pt := (s->>'tax')::int; exit; end if;
    end loop;
  end if;
  if bm <= (rule_value('bonus_wage_limit', on_d, p_country, p_region)#>>'{}')::bigint then
    warnings := warnings || to_jsonb('Statutory bonus applies (wages of ₹21,000 a month or less): part C must carry at least 8.33%. Not added yet, awaiting legal review.'::text);
  end if;
  return jsonb_build_object('inputs', i, 'rules_date', on_d, 'country', p_country, 'region', p_region, 'components', comps, 'check', chk, 'gross', gross,
    'monthly', jsonb_build_object('gross', gm, 'employee_pf', e_pf, 'employee_esi', e_esi, 'professional_tax', pt, 'take_home', gm - e_pf - e_esi - pt),
    'pf_citation', 'PF: 12% × min(PF wages, ₹25,000) — Code on Social Security, 2020; EPF Scheme; S.O. 5109(E), 17 Sep 2026. Awaiting legal review.',
    'rules', jsonb_build_array(
      jsonb_build_object('code', pf_ceiling.code, 'value', pf_ceiling.value, 'citation', pf_ceiling.citation, 'status', pf_ceiling.status),
      jsonb_build_object('code', esi.code, 'value', esi.value, 'citation', esi.citation, 'status', esi.status)),
    'warnings', warnings, 'computed_by', 'database');
end $$;

drop function if exists ctc_fix(jsonb, date);
create or replace function ctc_fix(p_inputs jsonb, p_offer_date date default current_date, p_country text default 'IN', p_region text default 'IN-TG') returns jsonb
language plpgsql stable set search_path = public as $$
declare i jsonb; b bigint; r jsonb; n int := 0;
begin
  if not has_statutory_pack(p_country) then
    raise exception 'No statutory rules for % yet. Enter the Annexure lines by hand.', coalesce((select name from country where code = p_country), p_country);
  end if;
  i := ctc_inputs(p_inputs); b := floor((i->>'basic_monthly')::bigint / 1000.0) * 1000;
  loop
    begin
      r := ctc_breakup(i || jsonb_build_object('basic_monthly', b), p_offer_date, p_country, p_region);
    exception when others then
      if sqlerrm like 'Basic and HRA%' then
        raise exception 'This CTC can''t reach 51%% wages with these inputs. Lower HRA or variable pay.';
      end if;
      raise;
    end;
    if (r->'check'->>'wages_share')::numeric >= 0.51 then
      return r || jsonb_build_object('fixed_from', (i->>'basic_monthly')::bigint);
    end if;
    b := b + 1000; n := n + 1;
    if n > 5000 then raise exception 'This CTC can''t reach 51%% wages with these inputs. Lower HRA or variable pay.'; end if;
  end loop;
end $$;
revoke all on function ctc_breakup(jsonb, date, text, text) from public, anon;
grant execute on function ctc_breakup(jsonb, date, text, text) to authenticated;
revoke all on function ctc_fix(jsonb, date, text, text) from public, anon;
grant execute on function ctc_fix(jsonb, date, text, text) to authenticated;

-- ---------- offers: currency, and the manual Annexure for countries with no pack ----------
alter table offer add column if not exists currency text;
alter table offer add column if not exists manual_label text;
alter table offer add column if not exists manual_by uuid references member(id);
update offer o set currency = c.currency from company c where c.id = o.company_id and o.currency is null;
alter table offer alter column currency set not null;

create or replace function offer_compute_check() returns trigger language plpgsql set search_path = public as $$
declare chk jsonb; b jsonb; c company; l jsonb; total bigint := 0; n int := 0;
begin
  select * into c from company where id = new.company_id;
  if c.id is null then return new; end if;              -- not the caller's company: row-level security refuses the write
  if tg_op = 'INSERT' or new.currency is null then new.currency := c.currency; end if;   -- stored once; never converted
  if has_statutory_pack(c.country) then
    if new.inputs is not null then
      b := ctc_breakup(new.inputs, coalesce(new.created_at::date, current_date), c.country, c.state_region);
      new.inputs := b->'inputs';
      new.components := b->'components';       -- whatever amounts a client sent are ignored
    end if;
    chk := wages_check(new.components);
    new.manual_label := null; new.manual_by := null;
  else
    -- No statutory pack: manual lines only; the arithmetic check runs, nothing else.
    if new.inputs is not null then raise exception 'No statutory rules for % yet. Enter the Annexure lines by hand.', (select name from country where code = c.country); end if;
    if new.manual_label is null or new.manual_by is null then raise exception 'Manual Annexure lines must say who entered them'; end if;
    if jsonb_typeof(new.components) <> 'array' or jsonb_array_length(new.components) not between 1 and 30 then
      raise exception 'Add between 1 and 30 Annexure lines';
    end if;
    for l in select * from jsonb_array_elements(new.components) loop
      n := n + 1;
      if length(coalesce(trim(l->>'name'), '')) not between 1 and 80 then raise exception 'Line % needs a name of up to 80 characters', n; end if;
      if jsonb_typeof(l->'amount') <> 'number' or (l->>'amount') !~ '^[0-9]+$' then raise exception 'Line % needs a whole amount of 0 or more', n; end if;
      total := total + (l->>'amount')::bigint;
    end loop;
    new.components := (select jsonb_agg(jsonb_build_object('name', trim(x->>'name'), 'kind', 'manual', 'amount', (x->>'amount')::bigint))
                         from jsonb_array_elements(new.components) x);
    chk := jsonb_build_object('ctc', total, 'passes', true, 'applicable', false, 'mode', 'manual', 'label', new.manual_label,
      'not_applicable', jsonb_build_array('PF', 'ESI', 'Statutory bonus', 'Gratuity', 'Professional tax', '50% wages check'));
  end if;
  new.wages_check := chk;
  new.ctc := (chk->>'ctc')::bigint;
  return new;
end $$;
drop trigger if exists offer_compute_check on offer;
create trigger offer_compute_check before insert or update of components, ctc, wages_check, inputs, manual_label on offer
  for each row execute function offer_compute_check();

-- Desk sends inputs only; the company's country and region pick the pack (no pack -> plain refusal)
create or replace function desk_save_offer(p_application uuid, p_inputs jsonb, p_fix boolean default false)
returns jsonb language plpgsql set search_path = public as $$
declare me member := current_member(); oid uuid; b jsonb; app application; c company;
begin
  select * into app from application where id = p_application;
  if app.id is null or app.company_id <> me.company_id then raise exception 'That candidate isn''t in your workspace'; end if;
  select * into c from company where id = me.company_id;
  b := case when p_fix then ctc_fix(p_inputs, current_date, c.country, c.state_region)
            else ctc_breakup(p_inputs, current_date, c.country, c.state_region) end;   -- raises on any amount, unknown key, or no pack
  select id into oid from offer where application_id = p_application and status in ('draft','in_review') limit 1;
  if oid is null then
    insert into offer(company_id, application_id, inputs, components, ctc, joining_on)
      values (me.company_id, p_application, b->'inputs', b->'components', (b->'check'->>'ctc')::bigint, (b->'inputs'->>'joining_on')::date)
      returning id into oid;
  else
    update offer set inputs = b->'inputs', joining_on = coalesce((b->'inputs'->>'joining_on')::date, joining_on) where id = oid;
  end if;
  perform desk_log(case when p_fix then 'offer_fixed' else 'offer_drafted' end, 'offer', oid,
    jsonb_build_object('passes', b->'check'->'passes', 'wages_percent', b->'check'->'wages_percent', 'inputs', b->'inputs'));
  return jsonb_build_object('offer_id', oid, 'ctc', (b->'check'->>'ctc')::bigint, 'currency', c.currency, 'check', b->'check', 'components', b->'components',
    'monthly', b->'monthly', 'warnings', b->'warnings', 'pf_citation', b->'pf_citation', 'fixed_from', b->'fixed_from', 'inputs', b->'inputs');
end $$;
revoke all on function desk_save_offer(uuid, jsonb, boolean) from public, anon;
grant execute on function desk_save_offer(uuid, jsonb, boolean) to authenticated;

/** A person (never Desk) enters Annexure A by hand, for a company whose country has no statutory pack.
 *  Lines must add up to the CTC; the offer carries "No statutory rules for <country> yet: figures entered by <name>". */
create or replace function save_manual_offer(p_application uuid, p_lines jsonb, p_ctc bigint, p_joining_on date default null)
returns jsonb language plpgsql set search_path = public as $$
declare me member := current_member(); app application; c company; oid uuid; total bigint := 0; lbl text; o offer;
begin
  select * into app from application where id = p_application;
  if app.id is null or app.company_id <> me.company_id then raise exception 'That candidate isn''t in your workspace'; end if;
  select * into c from company where id = me.company_id;
  if has_statutory_pack(c.country) then raise exception 'Your company uses the % statutory rules. Use the salary calculator.', (select name from country where code = c.country); end if;
  if jsonb_typeof(p_lines) <> 'array' then raise exception 'Add the Annexure lines'; end if;
  select coalesce(sum(case when (x->>'amount') ~ '^[0-9]+$' then (x->>'amount')::bigint end), 0) into total from jsonb_array_elements(p_lines) x;
  if p_ctc is null or p_ctc <= 0 then raise exception 'Enter the total CTC'; end if;
  if total <> p_ctc then raise exception 'The lines add up to % but the CTC is %. They must match.', total, p_ctc; end if;
  lbl := format('No statutory rules for %s yet: figures entered by %s', (select name from country where code = c.country), me.full_name);
  select id into oid from offer where application_id = p_application and status in ('draft','in_review') limit 1;
  if oid is null then
    insert into offer(company_id, application_id, components, ctc, joining_on, manual_label, manual_by)
      values (me.company_id, p_application, p_lines, p_ctc, p_joining_on, lbl, me.id) returning id into oid;
  else
    update offer set components = p_lines, joining_on = coalesce(p_joining_on, joining_on), manual_label = lbl, manual_by = me.id where id = oid;
  end if;
  select * into o from offer where id = oid;
  perform desk_log('offer_manual_annexure', 'offer', oid, jsonb_build_object('ctc', o.ctc, 'currency', o.currency, 'lines', jsonb_array_length(o.components)));
  return jsonb_build_object('offer_id', oid, 'ctc', o.ctc, 'currency', o.currency, 'components', o.components, 'check', o.wages_check, 'label', o.manual_label);
end $$;
revoke all on function save_manual_offer(uuid, jsonb, bigint, date) from public, anon;
grant execute on function save_manual_offer(uuid, jsonb, bigint, date) to authenticated;

/** Region fields for the signed-in user's own company (Settings, the app's formatting, Desk prompts later). */
create or replace function my_company_region() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('country', c.country, 'country_name', k.name, 'state_region', c.state_region, 'currency', c.currency,
    'timezone', c.timezone, 'locale', c.locale, 'working_week', c.working_week, 'holiday_calendar', c.holiday_calendar,
    'data_region', c.data_region, 'statutory_pack', has_statutory_pack(c.country))
  from company c join country k on k.code = c.country where c.id = (current_member()).company_id
$$;
revoke all on function my_company_region() from public, anon;
grant execute on function my_company_region() to authenticated;

-- SEC-1: every table with row-level security also carries the restrictive fresh-session policy (as in 010)
do $$ declare t record; begin
  for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity loop
    execute format('drop policy if exists session_fresh on public.%I', t.relname);
    execute format('create policy session_fresh on public.%I as restrictive for all to authenticated using ((select public.session_fresh())) with check ((select public.session_fresh()))', t.relname);
  end loop;
end $$;
