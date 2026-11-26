-- QA-040: Reject on a Desk draft discards it with a reason from the fixed list; no raw database error. Fictional data.
\set ON_ERROR_STOP on
reset role;
set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000001';
do $$ declare r jsonb; rid uuid; begin
  r := desk_create_role('QA Engineer', 'Chennai', 1, 600000, 800000, '3 years', 45);
  rid := (r->>'role_id')::uuid;
  begin perform desk_discard('role', rid); raise exception 'SHOULD HAVE FAILED';
  exception when others then if sqlerrm <> 'Pick a reason for sending it back' then raise exception 'FAILED: no reason: %', sqlerrm; end if; end;
  begin perform desk_discard('role', rid, 'because'); raise exception 'SHOULD HAVE FAILED';
  exception when others then if sqlerrm <> 'Pick a reason for sending it back' then raise exception 'FAILED: free-text reason: %', sqlerrm; end if; end;
  r := desk_discard('role', rid, 'not_needed');
  if (r->>'discarded')::int <> 1 or exists (select 1 from role where id = rid) then raise exception 'FAILED: draft role not discarded: %', r; end if;
  if not exists (select 1 from audit_event where action = 'draft_discarded' and subject_id = rid and detail->>'reason' = 'not_needed') then raise exception 'FAILED: reason not logged'; end if;
  if exists (select 1 from task where subject_id = rid and status = 'open') then raise exception 'FAILED: approval task still open'; end if;
  begin perform desk_discard('role', rid, 'not_needed'); raise exception 'SHOULD HAVE FAILED';
  exception when others then if sqlerrm <> 'That draft was already approved or removed' then raise exception 'FAILED: second discard: %', sqlerrm; end if; end;
  -- an open role with candidates is never deleted by a discard
  begin perform desk_discard('role', (select a.role_id from application a join role x on x.id = a.role_id where x.company_id = (current_member()).company_id limit 1), 'duplicate');
    raise exception 'SHOULD HAVE FAILED';
  exception when others then if sqlerrm not in ('This role already has candidates, so it can''t be discarded') then raise exception 'FAILED: role with candidates: %', sqlerrm; end if; end;
  if (desk_ai_context())->'channels' <> '["app", "email"]'::jsonb then raise exception 'FAILED: channels %', desk_ai_context(); end if;
end $$;
reset role;
select 'DESK DISCARD AND CHANNELS (QA-040, QA-041) CHECKS PASSED';
