-- 020_desk_discard_channels.sql — R3 bug fixes (CTO QA rulings 26 Nov).
-- QA-040: Reject on a Desk draft discards it through the discard path, with a reason from the fixed list. A draft role
--   that was never approved is removed (it used to be set to "closed", which the database refuses for an unapproved
--   role: the raw error reached the screen). The reason is kept in the audit log.
-- QA-041: Desk's context carries the company's active channels. WhatsApp isn't connected for any company yet, so it's
--   the app and email; Desk never mentions WhatsApp while it's off.
-- Re-runnable.

create or replace function draft_reject_reasons() returns text[] language sql immutable as $$
  select array['wrong_details', 'wrong_tone', 'not_needed', 'needs_check', 'duplicate'] $$;
grant execute on function draft_reject_reasons() to authenticated;

drop function if exists desk_discard(text, uuid);
create or replace function desk_discard(p_subject_type text, p_subject_id uuid, p_reason text default null) returns jsonb
language plpgsql as $$
declare me member := current_member(); n int := 0;
begin
  if me.id is null then raise exception 'Sign in first'; end if;
  if p_reason is null or not p_reason = any(draft_reject_reasons()) then raise exception 'Pick a reason for sending it back'; end if;
  if p_subject_type = 'role' then
    if exists (select 1 from application a where a.role_id = p_subject_id) then raise exception 'This role already has candidates, so it can''t be discarded'; end if;
    delete from role where id = p_subject_id and status in ('draft', 'awaiting_approval');
  elsif p_subject_type = 'offer' then delete from offer where id = p_subject_id and status in ('draft', 'in_review');
  elsif p_subject_type = 'document' then delete from document where id = p_subject_id and approved_by is null;
  elsif p_subject_type = 'batch' then delete from document where batch_id = p_subject_id and approved_by is null;
  else raise exception 'That can''t be discarded';
  end if;
  get diagnostics n = row_count;
  if n = 0 then raise exception 'That draft was already approved or removed'; end if;
  update task set status = 'cancelled', done_at = now() where kind = 'approval' and subject_id = p_subject_id and status = 'open';
  perform desk_log('draft_discarded', p_subject_type, p_subject_id, jsonb_build_object('reason', p_reason));
  return jsonb_build_object('discarded', n, 'reason', p_reason);
end $$;
revoke all on function desk_discard(text, uuid, text) from public, anon; grant execute on function desk_discard(text, uuid, text) to authenticated;

create or replace function desk_ai_context() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('company_id', c.id, 'is_sample', c.is_sample, 'desk_enabled', c.desk_enabled,
    'channels', '["app", "email"]'::jsonb)        -- WhatsApp: not connected for any company yet (Gupshup sandbox pending)
  from company c where c.id = (current_member()).company_id
$$;
revoke all on function desk_ai_context() from public, anon; grant execute on function desk_ai_context() to authenticated;
