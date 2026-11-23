-- 011_cvs_storage.sql — G1 (CTO go-live sizing, 23 Nov): the private "cvs" bucket and its row-level security, so the
-- CI isolation test can cover storage. Files live at "<company_id>/<file>"; a member reads and adds files only in
-- their own company's folder, and only with a fresh session (SEC-1). No update or delete policy: removing files is a
-- DPDP-delete job (G2) that runs as the service, not as a user. Re-runnable.
insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('cvs', 'cvs', false, 5242880, array['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists cvs_company_read on storage.objects;
create policy cvs_company_read on storage.objects for select to authenticated
  using (bucket_id = 'cvs' and (storage.foldername(name))[1] in (select c::text from public.my_company_ids() c) and public.session_fresh());
drop policy if exists cvs_company_add on storage.objects;
create policy cvs_company_add on storage.objects for insert to authenticated
  with check (bucket_id = 'cvs' and (storage.foldername(name))[1] in (select c::text from public.my_company_ids() c) and public.session_fresh()
              and name !~ '\.\.' and array_length(storage.foldername(name), 1) >= 1);

-- A screening job may only point at a file in the caller's own company folder.
create or replace function desk_enqueue_cv(p_application uuid, p_requirement uuid, p_path text, p_name text, p_sha text, p_source text default null, p_referred boolean default false, p_by_hand boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me member := current_member(); r requirement; fid uuid; jid bigint;
begin
  if p_path is null or split_part(p_path, '/', 1) <> me.company_id::text or p_path ~ '\.\.' or p_path !~ '^[0-9a-f-]{36}/[^/]' then
    raise exception 'CV files must be in your company''s folder';
  end if;
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

-- Isolation fixes found by supabase/tests/isolation.sql (23 Nov):
-- 1. desk_mark_contacted removed shortlist pins by application id without a company filter (security definer):
--    another company could unpin your candidates. Now it refuses unless the application is the caller's.
create or replace function desk_mark_contacted(p_application uuid, p_status text default 'contacted') returns jsonb
language plpgsql security definer set search_path = public as $$
declare me member := current_member();
begin
  if p_status not in ('contacted','withdrawn','moved_forward') then raise exception 'Unknown status'; end if;
  if not exists (select 1 from application where id = p_application and company_id = me.company_id) then raise exception 'Application not found'; end if;
  update score set status = p_status where application_id = p_application and company_id = me.company_id;
  delete from shortlist_pin where application_id = p_application and company_id = me.company_id;
  perform desk_log('shortlist_' || p_status, 'application', p_application);
  return jsonb_build_object('status', p_status);
end $$;
-- 2. desk_save_document accepted another company's person id: the document stayed in the caller's company but
--    pointed at someone else's person. Now the person must be the caller's.
create or replace function desk_save_document(p_person uuid, p_kind text, p_body text, p_summary text default null, p_batch uuid default null)
returns jsonb language plpgsql as $$
declare me member := current_member(); did uuid; v int;
begin
  if not exists (select 1 from person where id = p_person and company_id = me.company_id) then raise exception 'Person not found'; end if;
  if p_kind = 'rejection_note' and desk_blocked_text(p_body) then
    raise exception 'Rejection text can''t mention age, gender, marital status, religion, caste or pregnancy';
  end if;
  select coalesce(max(version), 0) + 1 into v from document where person_id = p_person and kind = p_kind and company_id = me.company_id;
  insert into document(company_id, person_id, kind, version, body, summary, batch_id) values (me.company_id, p_person, p_kind, v, p_body, p_summary, p_batch)
    returning id into did;
  perform desk_log('document_drafted', 'document', did, jsonb_build_object('kind', p_kind));
  return jsonb_build_object('document_id', did, 'version', v);
end $$;
