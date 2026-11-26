-- 021_cv_live.sql — Live CV screening for real companies (founder register FA-014, Approved 26 Nov).
-- FA-014 safeguards, each enforced here or in screen-cv:
--   * only a company Clearstage switches on can upload: company.cv_live, set by the platform admin only (audited), and
--     at most ONE real company until the founder approves more pilots (FA-015). The founder's own workspace first;
--   * only CVs the person agreed to share: the app makes the uploader confirm it, and desk_add_candidate refuses without it;
--   * paid AI key only: screen-cv uses GEMINI_API_KEY_PAID for every real company and never a free key (ai.js pickKey);
--   * every file deletable from the app: a storage delete policy for the company's own folder plus desk_delete_cv,
--     which removes the CV's rows (file record, screening job, the masked text, quotes, score, cached AI answer);
--   * no client sees anything: files stay in the company's own folder; the existing isolation test covers them.
-- Re-runnable. All people in tests are fictional.

alter table company add column if not exists cv_live boolean not null default false;

-- A signed-in user can't switch it, even an owner (same rule as desk_enabled, 006): only set_cv_live, below.
create or replace function guard_cv_live() returns trigger language plpgsql as $$
begin
  if current_user in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then new.cv_live := false;
    elsif new.cv_live is distinct from old.cv_live then raise exception 'Live CV screening is switched on by Clearstage';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists guard_cv_live on company;
create trigger guard_cv_live before insert or update on company for each row execute function guard_cv_live();

/** How many real companies may have live CV screening at once. 1 until the founder approves the pilot cap (FA-015). */
create or replace function cv_live_cap() returns int language sql immutable as $$ select 1 $$;
grant execute on function cv_live_cap() to authenticated;

/** Platform admin only: switch live CV screening on or off for one real company. Audited in that company's log. */
create or replace function set_cv_live(p_company uuid, p_on boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c company; others text;
begin
  if not is_platform_admin() then raise exception 'Only Clearstage can switch live CV screening'; end if;
  select * into c from company where id = p_company;
  if c.id is null then raise exception 'Unknown company'; end if;
  if c.is_sample then raise exception 'The sample company only uses the fictional CVs'; end if;
  if p_on and not c.cv_live then
    select string_agg(name, ', ') into others from company where cv_live and not is_sample and id <> p_company;
    if (select count(*) from company where cv_live and not is_sample and id <> p_company) >= cv_live_cap() then
      raise exception 'Live CV screening is already on for %. Until the founder approves more pilot companies, only % can upload real CVs', others, cv_live_cap();
    end if;
  end if;
  update company set cv_live = p_on where id = p_company;
  insert into audit_event(company_id, actor_kind, action, detail)
    values (p_company, 'human', 'cv_live_set', jsonb_build_object('from', c.cv_live, 'to', p_on, 'by', auth.uid()));
  return jsonb_build_object('company_id', p_company, 'cv_live', p_on);
end $$;
revoke all on function set_cv_live(uuid, boolean) from public, anon; grant execute on function set_cv_live(uuid, boolean) to authenticated;

/** May the signed-in user's company screen CVs now? Sample company: when its Desk is on. Real company: cv_live. */
create or replace function cv_screening_enabled() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select case when c.is_sample then c.desk_enabled else c.cv_live end from company c where c.id = (current_member()).company_id), false)
$$;
revoke all on function cv_screening_enabled() from public, anon; grant execute on function cv_screening_enabled() to authenticated;

/** Storage: may files be added to this company's folder? Only the caller's own company, and only when screening is on. */
create or replace function cv_folder_open(p_company text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from company c where c.id::text = p_company and c.id in (select my_company_ids())
                 and (c.is_sample or c.cv_live))
$$;
revoke all on function cv_folder_open(text) from public, anon; grant execute on function cv_folder_open(text) to authenticated;

drop policy if exists cvs_company_add on storage.objects;
create policy cvs_company_add on storage.objects for insert to authenticated
  with check (bucket_id = 'cvs' and (storage.foldername(name))[1] in (select c::text from public.my_company_ids() c) and public.session_fresh()
              and name !~ '\.\.' and array_length(storage.foldername(name), 1) >= 1
              and public.cv_folder_open((storage.foldername(name))[1]));
/** Every stored CV path of the caller's companies, whoever can see the row (for the delete policy's "no record" case). */
create or replace function cv_file_paths() returns setof text
language sql stable security definer set search_path = public as $$
  select storage_path from cv_file where company_id in (select my_company_ids())
$$;
revoke all on function cv_file_paths() from public, anon; grant execute on function cv_file_paths() to authenticated;
-- Delete: own company folder only, and only a file whose CV record the caller can see (row-level security on
-- cv_file, including the Recruiter limit of 019), or a file the caller uploaded that never got a record.
drop policy if exists cvs_company_delete on storage.objects;
create policy cvs_company_delete on storage.objects for delete to authenticated
  using (bucket_id = 'cvs' and (storage.foldername(name))[1] in (select c::text from public.my_company_ids() c) and public.session_fresh()
         and (exists (select 1 from public.cv_file f where f.storage_path = storage.objects.name)
              or (owner = auth.uid() and not exists (select 1 from public.cv_file_paths() p where p = storage.objects.name))));

-- A screening job may only point at a file in the caller's own company folder, and only when screening is on.
create or replace function desk_enqueue_cv(p_application uuid, p_requirement uuid, p_path text, p_name text, p_sha text, p_source text default null, p_referred boolean default false, p_by_hand boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me member := current_member(); r requirement; fid uuid; jid bigint;
begin
  if me.id is null then raise exception 'Sign in first'; end if;
  if not cv_screening_enabled() then raise exception 'Live CV screening isn''t switched on for your company yet'; end if;
  if p_path is null or split_part(p_path, '/', 1) <> me.company_id::text or p_path ~ '\.\.' or p_path !~ '^[0-9a-f-]{36}/[^/]' then
    raise exception 'CV files must be in your company''s folder';
  end if;
  select * into r from requirement where id = p_requirement and company_id = me.company_id;
  if r.id is null then raise exception 'Requirements not found'; end if;
  if r.confirmed_at is null then raise exception 'Confirm the requirements card before screening'; end if;
  if not exists (select 1 from application where id = p_application and company_id = me.company_id and role_id = r.role_id) then raise exception 'Application not found for this role'; end if;
  if hire_only(me.company_id) and not hs_application(p_application) then raise exception 'Application not found for this role'; end if;
  insert into cv_file(company_id, application_id, storage_path, file_name, sha256, source, referred, added_by_hand)
    values (me.company_id, p_application, p_path, p_name, p_sha, p_source, p_referred, p_by_hand) returning id into fid;
  insert into cv_job(company_id, cv_file_id, requirement_id) values (me.company_id, fid, r.id)
    on conflict (cv_file_id, requirement_id) do nothing returning id into jid;
  return jsonb_build_object('job_id', jid, 'cv_file_id', fid);
end $$;
revoke all on function desk_enqueue_cv(uuid, uuid, text, text, text, text, boolean, boolean) from public, anon;
grant execute on function desk_enqueue_cv(uuid, uuid, text, text, text, text, boolean, boolean) to authenticated;

/** Roles that can take CVs now: the caller's open roles with confirmed requirements (latest version). */
create or replace function cv_upload_roles() returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('role_id', x.role_id, 'title', x.title, 'city', x.city, 'requirement_id', x.req_id, 'version', x.version) order by x.title), '[]')
  from (select distinct on (r.id) r.id role_id, r.title, r.city, q.id req_id, q.version
        from role r join requirement q on q.role_id = r.id and q.confirmed_at is not null
        where r.company_id = (current_member()).company_id and r.status not in ('closed', 'draft', 'awaiting_approval')
        order by r.id, q.version desc) x
$$;
revoke all on function cv_upload_roles() from public, anon; grant execute on function cv_upload_roles() to authenticated;

/** The result card for one screened CV: score, stars, the quotes for each matched requirement and the gaps. */
create or replace function desk_cv_result(p_cv_file uuid) returns jsonb
language sql stable as $$
  select jsonb_build_object('cv_file_id', f.id, 'application_id', f.application_id, 'file_name', f.file_name, 'readable', f.readable, 'storage_path', f.storage_path,
    'status', (select j.status from cv_job j where j.cv_file_id = f.id order by j.id desc limit 1),
    'name', p.full_name, 'role', r.title,
    'score', (select jsonb_build_object('fit', s.fit, 'stars', coalesce(s.override_stars, s.stars), 'must_met', s.must_met, 'must_total', s.must_total,
                'years', s.years, 'under50', s.under50, 'safeguard', s.safeguard, 'label', s.label, 'version', s.version)
              from score s where s.application_id = f.application_id order by s.version desc limit 1),
    'evidence', coalesce((select jsonb_agg(jsonb_build_object('item', e.item_id, 'quote', e.quote, 'section', e.section) order by e.item_id)
              from evidence e where e.application_id = f.application_id and e.verified and e.item_id <> 'role'), '[]'),
    'requirements', (select jsonb_build_object('must', q.must, 'nice', q.nice) from cv_job j join requirement q on q.id = j.requirement_id where j.cv_file_id = f.id order by j.id desc limit 1))
  from cv_file f join application a on a.id = f.application_id join person p on p.id = a.person_id join role r on r.id = a.role_id
  where f.id = p_cv_file
$$;
revoke all on function desk_cv_result(uuid) from public, anon; grant execute on function desk_cv_result(uuid) to authenticated;

/** The company's recent CVs (Hire → CVs list): newest first. Row-level security applies (invoker). */
create or replace function company_cvs(p_limit int default 50) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(x order by x->>'added_at' desc), '[]') from (
    select jsonb_build_object('cv_file_id', f.id, 'file_name', f.file_name, 'name', p.full_name, 'role', r.title, 'added_at', f.created_at,
      'status', (select j.status from cv_job j where j.cv_file_id = f.id order by j.id desc limit 1),
      'stars', (select coalesce(s.override_stars, s.stars) from score s where s.application_id = f.application_id order by s.version desc limit 1)) x
    from cv_file f join application a on a.id = f.application_id join person p on p.id = a.person_id join role r on r.id = a.role_id
    where f.company_id = (current_member()).company_id order by f.created_at desc limit least(greatest(coalesce(p_limit, 50), 1), 200)) y
$$;
revoke all on function company_cvs(int) from public, anon; grant execute on function company_cvs(int) to authenticated;

/** Delete one CV after its file has been removed from storage: the file record, its screening job, the masked text,
 *  the quotes and score it produced, and the cached AI answer for that file. The candidate record stays (deleting a
 *  person is the DPDP delete). Refuses while the file is still in storage, so a record never outlives a kept file. */
create or replace function desk_delete_cv(p_cv_file uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me member := current_member(); f cv_file; reqs uuid[];
begin
  if me.id is null then raise exception 'Sign in first'; end if;
  select * into f from cv_file where id = p_cv_file and company_id = me.company_id;
  if f.id is null or (hire_only(me.company_id) and not hs_cv_file(f.id)) then raise exception 'That CV isn''t in your workspace'; end if;
  if exists (select 1 from storage.objects o where o.bucket_id = 'cvs' and o.name = f.storage_path) then
    raise exception 'Remove the file first, then delete the record';
  end if;
  select coalesce(array_agg(requirement_id), '{}') into reqs from cv_job where cv_file_id = f.id;
  delete from evidence where application_id = f.application_id and requirement_id = any(reqs);
  delete from score where application_id = f.application_id and requirement_id = any(reqs);
  delete from shortlist_pin where application_id = f.application_id;
  if not exists (select 1 from cv_file x where x.company_id = me.company_id and x.sha256 = f.sha256 and x.id <> f.id) then
    delete from evidence_cache where company_id = me.company_id and cache_key like f.sha256 || '%';
  end if;
  delete from cv_file where id = f.id;                                  -- cv_job goes with it (on delete cascade)
  perform desk_log('cv_deleted', 'application', f.application_id, jsonb_build_object('cv_file', f.id));
  return jsonb_build_object('deleted', true, 'application_id', f.application_id);
end $$;
revoke all on function desk_delete_cv(uuid) from public, anon; grant execute on function desk_delete_cv(uuid) to authenticated;

/** Desk's context also says whether CVs can be screened now. */
create or replace function desk_ai_context() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('company_id', c.id, 'is_sample', c.is_sample, 'desk_enabled', c.desk_enabled, 'cv_live', c.cv_live,
    'channels', '["app", "email"]'::jsonb)        -- WhatsApp: not connected for any company yet (Gupshup sandbox pending)
  from company c where c.id = (current_member()).company_id
$$;
revoke all on function desk_ai_context() from public, anon; grant execute on function desk_ai_context() to authenticated;

/** Platform admin: every company with its module states, Desk switch and CV switch (Settings → Modules). */
create or replace function platform_companies() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_platform_admin() then raise exception 'Only Clearstage can see every company'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'is_sample', c.is_sample, 'country', c.country,
      'desk_enabled', c.desk_enabled, 'cv_live', c.cv_live,
      'modules', (select jsonb_object_agg(k, module_state(c.id, k)) from unnest(module_keys()) k)) order by c.is_sample desc, c.name)
    from company c), '[]');
end $$;
revoke all on function platform_companies() from public, anon; grant execute on function platform_companies() to authenticated;
