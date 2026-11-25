-- 016_modules.sql — module tabs (PM spec RD-PM-Spec-Module-Tabs.md; CTO ruling RD-CTO-Rulings-Module-Tabs-25Nov.md).
-- 1. company_module: a state per company and module (live / preview / soon), set by the platform admin only, audited.
--    Defaults: Hire live; Onboard and Probation preview; Compliance, Exit, Time & attendance, Payroll, Performance,
--    Policies soon. Modules without screens yet can only be "soon".
-- 2. Preview lock: a real company can't save onboarding or probation records from the app or Desk while that module
--    isn't live (people becoming employees, joiner/probation tasks, appointment/confirmation letters). The sample company
--    is excepted. A label alone isn't enough once real clients are live (CTO).
-- 3. module_interest: "I need this" (page or Desk), one per user per module, with an optional one-line note.
--    Counts per module for the platform admin only (Insights → Module interest).
-- Re-runnable.

-- ---------- 1. module state ----------
create or replace function module_keys() returns text[] language sql immutable as $$
  select array['hire','onboard','probation','compliance','exit','time','payroll','performance','policies'] $$;
create or replace function module_default(p_module text) returns text language sql immutable as $$
  select case p_module when 'hire' then 'live' when 'onboard' then 'preview' when 'probation' then 'preview' else 'soon' end $$;
/** States a module may take today: only modules with screens can be preview or live. */
create or replace function module_states_allowed(p_module text) returns text[] language sql immutable as $$
  select case when p_module = 'hire' then array['live']
              when p_module in ('onboard','probation') then array['soon','preview','live']
              else array['soon'] end $$;

create table if not exists company_module (
  company_id uuid not null references company(id) on delete cascade,
  module text not null check (module = any (array['hire','onboard','probation','compliance','exit','time','payroll','performance','policies'])),
  state text not null check (state in ('live','preview','soon')),
  updated_by uuid,
  updated_at timestamptz not null default now(),
  primary key (company_id, module)
);
alter table company_module enable row level security;
drop policy if exists company_module_read on company_module;
create policy company_module_read on company_module for select to authenticated using (company_id in (select my_company_ids()));
revoke insert, update, delete, truncate on company_module from authenticated, anon;

create or replace function module_state(p_company uuid, p_module text) returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select state from company_module where company_id = p_company and module = p_module), module_default(p_module))
$$;
revoke all on function module_state(uuid, text) from public, anon, authenticated;

/** The signed-in user's own company: every module with its state. */
create or replace function my_modules() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare me member := current_member();
begin
  return (select jsonb_object_agg(k, module_state(me.company_id, k)) from unnest(module_keys()) k);
end $$;
revoke all on function my_modules() from public, anon;
grant execute on function my_modules() to authenticated;

/** Platform admin only: set one module's state for one company. Audited in that company's log. */
create or replace function set_module_state(p_company uuid, p_module text, p_state text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare was text;
begin
  if not is_platform_admin() then raise exception 'Only Clearstage can switch modules'; end if;
  if not exists (select 1 from company where id = p_company) then raise exception 'Unknown company'; end if;
  if not (p_module = any (module_keys())) then raise exception 'Unknown module %', p_module; end if;
  if not (p_state = any (module_states_allowed(p_module))) then
    raise exception '% can''t be % yet: it has no screens to show', initcap(p_module), p_state;
  end if;
  was := module_state(p_company, p_module);
  insert into company_module(company_id, module, state, updated_by) values (p_company, p_module, p_state, auth.uid())
    on conflict (company_id, module) do update set state = excluded.state, updated_by = excluded.updated_by, updated_at = now();
  insert into audit_event(company_id, actor_kind, action, detail)
    values (p_company, 'human', 'module_state_set', jsonb_build_object('module', p_module, 'from', was, 'to', p_state, 'by', auth.uid()));
  return jsonb_build_object('company_id', p_company, 'module', p_module, 'state', p_state, 'was', was);
end $$;
revoke all on function set_module_state(uuid, text, text) from public, anon;
grant execute on function set_module_state(uuid, text, text) to authenticated;

/** Platform admin only: every company with its module states (Settings → Modules). */
create or replace function platform_companies() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_platform_admin() then raise exception 'Only Clearstage can see every company'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'is_sample', c.is_sample, 'country', c.country,
      'modules', (select jsonb_object_agg(k, module_state(c.id, k)) from unnest(module_keys()) k)) order by c.is_sample desc, c.name)
    from company c), '[]');
end $$;
revoke all on function platform_companies() from public, anon;
grant execute on function platform_companies() to authenticated;

-- ---------- 2. preview lock ----------
create or replace function module_lock() returns trigger language plpgsql set search_path = public as $$
declare m text; st text; samp boolean;
begin
  if current_user <> 'authenticated' then return new; end if;            -- only app and Desk writes (migrations, seed, scheduler pass)
  if tg_table_name = 'person' then
    if new.status = 'employee' and (tg_op = 'INSERT' or old.status is distinct from 'employee' or new.joined_on is distinct from old.joined_on) then m := 'onboard';
    elsif new.probation_ends_on is not null and (tg_op = 'INSERT' or new.probation_ends_on is distinct from old.probation_ends_on) then m := 'probation';
    end if;
  elsif tg_table_name = 'task' then
    if new.kind in ('appointment_letter','it_setup','onboarding','day1_plan','documents','joiner_checklist') then m := 'onboard';
    elsif new.kind in ('probation_review','confirmation_letter','probation_extension') then m := 'probation';
    end if;
  elsif tg_table_name = 'document' then
    if new.kind ~ '^appointment' then m := 'onboard';
    elsif new.kind ~ '^(confirmation|probation)' then m := 'probation';
    end if;
  end if;
  if m is null then return new; end if;
  select is_sample into samp from company where id = new.company_id;
  if not found then return new; end if;                                   -- not the caller's company: row-level security refuses it
  if samp then return new; end if;                                        -- the sample company shows the flow
  st := coalesce((select state from company_module where company_id = new.company_id and module = m), module_default(m));   -- own company: readable
  if st = 'live' then return new; end if;
  raise exception '% is % in Clearstage, so real % can''t be saved yet.', initcap(m),
    case st when 'preview' then 'in preview' else 'coming soon' end,
    case m when 'onboard' then 'joiners' else 'probation records' end
    using hint = 'module_' || st || ':' || m;
end $$;
drop trigger if exists module_lock on person;
create trigger module_lock before insert or update on person for each row execute function module_lock();
drop trigger if exists module_lock on task;
create trigger module_lock before insert or update on task for each row execute function module_lock();
drop trigger if exists module_lock on document;
create trigger module_lock before insert or update on document for each row execute function module_lock();

-- ---------- 3. "I need this" ----------
create table if not exists module_interest (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references company(id) on delete cascade,
  user_id uuid not null,
  member_id uuid references member(id) on delete set null,
  module text not null check (module = any (array['hire','onboard','probation','compliance','exit','time','payroll','performance','policies'])),
  note text check (char_length(note) <= 200),
  source text not null default 'page' check (source in ('page','desk')),
  created_at timestamptz not null default now(),
  unique (company_id, user_id, module)
);
alter table module_interest enable row level security;
drop policy if exists module_interest_own on module_interest;
create policy module_interest_own on module_interest for select to authenticated using (user_id = auth.uid() and company_id in (select my_company_ids()));
revoke insert, update, delete, truncate on module_interest from authenticated, anon;

/** Records that the signed-in user needs a module (once per user per module; a later note fills an empty one). No email is sent. */
create or replace function register_module_interest(p_module text, p_note text default null, p_source text default 'page') returns jsonb
language plpgsql security definer set search_path = public as $$
declare me member := current_member(); r module_interest; n text := nullif(left(trim(coalesce(p_note, '')), 200), ''); fresh boolean;
        had boolean;
begin
  if not (p_module = any (module_keys())) then raise exception 'Unknown module %', p_module; end if;
  if module_state(me.company_id, p_module) = 'live' then raise exception '% is already live for your company', initcap(p_module); end if;
  if p_source not in ('page','desk') then raise exception 'Unknown source'; end if;
  had := exists (select 1 from module_interest where company_id = me.company_id and user_id = auth.uid() and module = p_module);
  insert into module_interest(company_id, user_id, member_id, module, note, source)
    values (me.company_id, auth.uid(), me.id, p_module, n, p_source)
    on conflict (company_id, user_id, module) do update set note = coalesce(module_interest.note, excluded.note)
    returning * into r;
  fresh := not had;
  if fresh then
    insert into audit_event(company_id, actor_kind, action, detail)
      values (me.company_id, case when p_source = 'desk' then 'desk' else 'human' end, 'module_interest', jsonb_build_object('module', p_module, 'source', p_source));
  end if;
  return jsonb_build_object('module', r.module, 'created_at', r.created_at, 'note', r.note, 'by', me.full_name, 'new', fresh,
    'company', (select name from company where id = me.company_id));
end $$;
revoke all on function register_module_interest(text, text, text) from public, anon;
grant execute on function register_module_interest(text, text, text) to authenticated;

/** The signed-in user's own interest records: { module: { created_at, note } }. */
create or replace function my_module_interest() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare me member := current_member();
begin
  return coalesce((select jsonb_object_agg(module, jsonb_build_object('created_at', created_at, 'note', note, 'source', source))
    from module_interest where company_id = me.company_id and user_id = auth.uid()), '{}');
end $$;
revoke all on function my_module_interest() from public, anon;
grant execute on function my_module_interest() to authenticated;

/** Platform admin only: interest per module across companies (Insights → Module interest). */
create or replace function module_interest_counts() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_platform_admin() then raise exception 'Only Clearstage can see module interest'; end if;
  return coalesce((select jsonb_agg(x order by (x->>'people')::int desc, x->>'module') from (
    select jsonb_build_object('module', i.module, 'people', count(*), 'companies', count(distinct i.company_id),
      'from_desk', count(*) filter (where i.source = 'desk'), 'latest_at', max(i.created_at),
      'notes', coalesce((select jsonb_agg(jsonb_build_object('company', c2.name, 'note', n.note, 'at', n.created_at) order by n.created_at desc)
                 from (select * from module_interest n0 where n0.module = i.module and n0.note is not null order by n0.created_at desc limit 5) n
                 join company c2 on c2.id = n.company_id), '[]')) as x
    from module_interest i join company c on c.id = i.company_id and not c.is_sample
    group by i.module) t), '[]');
end $$;
revoke all on function module_interest_counts() from public, anon;
grant execute on function module_interest_counts() to authenticated;

-- ---------- QA-011: people can correct their own name (it showed "XXXX") ----------
/** A name a person would actually use: has a letter, isn't one character repeated ("XXXX", "cccc"), isn't a test word. */
create or replace function looks_like_name(p text) returns boolean language sql immutable as $$
  select length(trim(coalesce(p, ''))) between 2 and 80 and length(regexp_replace(trim(p), '\s', '', 'g')) >= 2 and trim(p) ~ '[[:alpha:]]'
     and lower(regexp_replace(trim(p), '\s', '', 'g')) !~ '^(.)\1+$'
     and lower(trim(p)) not in ('test', 'asdf', 'qwerty', 'name', 'user', 'admin', 'na', 'n/a', 'none', 'abc')
$$;
create or replace function member_name_check() returns trigger language plpgsql set search_path = public as $$
begin
  if (tg_op = 'INSERT' or new.full_name is distinct from old.full_name) and not looks_like_name(new.full_name) then
    raise exception 'Enter your name as people know you, like "Ritu Sharma"';
  end if;
  return new;
end $$;
drop trigger if exists member_name_check on member;
create trigger member_name_check before insert or update of full_name on member for each row execute function member_name_check();

/** Updates the signed-in user's own name everywhere they are a member (own company and sample company). */
create or replace function update_my_name(p_name text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me member := current_member(); n text := regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g');
begin
  if not looks_like_name(n) then raise exception 'Enter your name as people know you, like "Ritu Sharma"'; end if;
  update member set full_name = n where user_id = auth.uid();
  insert into audit_event(company_id, actor_kind, action, detail) values (me.company_id, 'human', 'name_changed', jsonb_build_object('member', me.id));
  return jsonb_build_object('full_name', n);
end $$;
revoke all on function update_my_name(text) from public, anon;
grant execute on function update_my_name(text) to authenticated;

-- SEC-1: every table with row-level security also carries the restrictive fresh-session policy (as in 010)
do $$ declare t record; begin
  for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity loop
    execute format('drop policy if exists session_fresh on public.%I', t.relname);
    execute format('create policy session_fresh on public.%I as restrictive for all to authenticated using ((select public.session_fresh())) with check ((select public.session_fresh()))', t.relname);
  end loop;
end $$;
