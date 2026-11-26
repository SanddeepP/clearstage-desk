-- Founder order 26 Nov, items 3 and 6: email sending (claim → send → result), and the platform safety switches.
-- All people and addresses here are fictional (example.com).
\set ON_ERROR_STOP on
reset role;
create temp table em(k text primary key, v text); grant select, insert on em to authenticated;
insert into em values ('A', (select id::text from company where name = 'Rycruit')), ('B', (select id::text from company where name = 'Other Co'));
insert into auth.users values ('dddddddd-0000-4000-8000-0000000000ae', 'em.platform@test.in') on conflict do nothing;
insert into platform_admin(user_id) values ('dddddddd-0000-4000-8000-0000000000ae') on conflict do nothing;
update platform_setting set value = 'false' where key in ('desk_off', 'sending_paused');
-- a fictional candidate with an email, and one without
do $$ declare a uuid := (select v::uuid from em where k = 'A'); p1 uuid; p2 uuid; begin
  insert into person(company_id, full_name, email) values (a, 'Nila Fictional', 'nila.fictional@example.com') returning id into p1;
  insert into person(company_id, full_name) values (a, 'Noaddr Fictional') returning id into p2;
  insert into em values ('p1', p1::text), ('p2', p2::text);
  update message set status = 'cancelled' where company_id = a and channel = 'email' and status in ('queued', 'sending');   -- start from a clean queue
end $$;

set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000001';
reset request.jwt.claim.session_id;
do $$ declare p1 uuid := (select v::uuid from em where k = 'p1'); p2 uuid := (select v::uuid from em where k = 'p2'); d uuid; r jsonb; c jsonb; m jsonb; mid uuid; n int; begin
  -- approving a letter queues an email with its kind and subject
  d := (desk_save_document(p1, 'offer_letter', 'Dear Nila, please find your offer letter.')->>'document_id')::uuid;
  r := desk_approve('document', d);
  select id into mid from message where to_person = p1 and kind = 'offer_letter';
  if mid is null or (select subject from message where id = mid) <> 'Your offer letter from Rycruit' or (select status from message where id = mid) <> 'queued' then
    raise exception 'FAILED: approved letter not queued with subject: %', (select to_jsonb(x) from message x where id = mid); end if;
  insert into em values ('mid', mid::text);
  -- what was approved can't be edited, re-sent or marked sent by a user
  begin update message set body = 'changed' where id = mid; raise exception 'FAILED: queued body edited';
  exception when others then if sqlerrm <> 'A queued message can''t be edited. Cancel it and draft a new one' then raise exception 'FAILED: edit: %', sqlerrm; end if; end;
  begin update message set status = 'sent' where id = mid; raise exception 'FAILED: status set by a user';
  exception when others then if sqlerrm like 'FAILED%' then raise; end if; end;
  -- a user insert is always queued, whatever status it claims; WhatsApp goes by email
  insert into message(company_id, channel, to_person, body, approved_by, status) values ((current_member()).company_id, 'whatsapp', p2, 'Hi', (current_member()).id, 'sent');
  if not exists (select 1 from message where to_person = p2 and channel = 'email' and status = 'queued') then raise exception 'FAILED: user insert not queued by email'; end if;
  -- claim: the approved one with an address goes out; no address → no_address
  c := email_claim(10);
  if (c->>'paused')::boolean then raise exception 'FAILED: paused by default'; end if;
  select x into m from jsonb_array_elements(c->'messages') x where x->>'id' = mid::text;
  if m is null or m->>'to' <> 'nila.fictional@example.com' or m->>'subject' <> 'Your offer letter from Rycruit' or m->>'company' <> 'Rycruit' or m->>'body' not like 'Dear Nila%' then
    raise exception 'FAILED: claim: %', c; end if;
  if (select status from message where to_person = p2) <> 'no_address' then raise exception 'FAILED: no-address message not marked'; end if;
  if (select status from message where id = mid) <> 'sending' then raise exception 'FAILED: claimed message not "sending"'; end if;
  if jsonb_array_length(email_claim(10)->'messages') <> 0 then raise exception 'FAILED: claimed twice'; end if;
  -- results: a failure goes back to the queue; the 3rd failure is final; a success is audited
  r := email_result(mid, false, null, 'The email service is busy. It will try again.');
  if r->>'status' <> 'queued' then raise exception 'FAILED: first failure: %', r; end if;
  perform email_claim(10); perform email_result(mid, false, null, 'busy');
  perform email_claim(10); r := email_result(mid, false, null, 'busy');
  if r->>'status' <> 'failed' then raise exception 'FAILED: third failure not final: %', r; end if;
  if jsonb_array_length(email_claim(10)->'messages') <> 0 then raise exception 'FAILED: a failed email was claimed again'; end if;
  r := email_retry(mid);
  c := email_claim(10);
  r := email_result(mid, true, 're_fictional_1', null);
  if r->>'status' <> 'sent' or (select provider_id from message where id = mid) <> 're_fictional_1' then raise exception 'FAILED: sent not recorded'; end if;
  begin perform email_result(mid, true, 'again', null); raise exception 'FAILED: result recorded twice';
  exception when others then if sqlerrm <> 'That email isn''t being sent' then raise exception 'FAILED: double result: %', sqlerrm; end if; end;
  if not exists (select 1 from jsonb_array_elements(company_outbox()) x where x->>'id' = mid::text and x->>'status' = 'sent' and x->>'to' = 'Nila Fictional') then
    raise exception 'FAILED: outbox: %', company_outbox(); end if;
  -- clients can't use the switches
  begin perform set_platform_switch('sending_paused', true); raise exception 'FAILED: client paused sending';
  exception when others then if sqlerrm <> 'Only Clearstage can use the safety switches' then raise exception 'FAILED: client switch: %', sqlerrm; end if; end;
  begin perform set_pilot_cap(3); raise exception 'FAILED: client set the cap';
  exception when others then if sqlerrm <> 'Only Clearstage can set the pilot cap' then raise exception 'FAILED: client cap: %', sqlerrm; end if; end;
  begin perform platform_status(); raise exception 'FAILED: client read platform status';
  exception when others then if sqlerrm like 'FAILED%' then raise; end if; end;
end $$;
reset role;
do $$ begin
  if not exists (select 1 from audit_event where action = 'email_sent' and subject_id = (select v::uuid from em where k = 'mid')) then raise exception 'FAILED: send not audited'; end if;
  if not exists (select 1 from audit_event where action = 'email_failed' and subject_id = (select v::uuid from em where k = 'mid')) then raise exception 'FAILED: final failure not audited'; end if;
  if exists (select 1 from audit_event where action in ('email_sent', 'email_failed') and detail::text ~ '(example\.com|Nila|Dear)') then raise exception 'FAILED: audit holds an address or text'; end if;
end $$;

-- ---------- the switches ----------
set role authenticated;
set request.jwt.claim.sub = 'dddddddd-0000-4000-8000-0000000000ae';
do $$ declare s jsonb; begin
  perform set_platform_switch('sending_paused', true);
  perform set_platform_switch('desk_off', true);
  s := platform_status();
  if not (s->>'sending_paused')::boolean or not (s->>'desk_off')::boolean or (s->>'pilot_cap')::int <> 1 then raise exception 'FAILED: status %', s; end if;
  begin perform set_platform_switch('everything', true); raise exception 'FAILED: unknown switch';
  exception when others then if sqlerrm <> 'Unknown switch' then raise exception 'FAILED: unknown: %', sqlerrm; end if; end;
  begin perform set_pilot_cap(0); raise exception 'FAILED: cap 0';
  exception when others then if sqlerrm <> 'The pilot cap must be between 1 and 10' then raise exception 'FAILED: cap range: %', sqlerrm; end if; end;
end $$;
set request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000001';
do $$ declare p1 uuid := (select v::uuid from em where k = 'p1'); d uuid; c jsonb; begin
  d := (desk_save_document(p1, 'offer_letter', 'Dear Nila, a second letter.')->>'document_id')::uuid;
  perform desk_approve('document', d);
  c := email_claim(10);
  if not (c->>'paused')::boolean or jsonb_array_length(c->'messages') <> 0 then raise exception 'FAILED: sent while paused: %', c; end if;
  if (select count(*) from message where to_person = p1 and status = 'queued') <> 1 then raise exception 'FAILED: paused message not kept queued'; end if;
  if desk_live_enabled() or cv_screening_enabled() or (desk_ai_context()->>'desk_enabled')::boolean or not (desk_ai_context()->>'desk_off')::boolean then
    raise exception 'FAILED: Desk still on while switched off: %', desk_ai_context(); end if;
end $$;
-- the pilot cap governs the CV switch (021)
set request.jwt.claim.sub = 'dddddddd-0000-4000-8000-0000000000ae';
do $$ declare a uuid := (select v::uuid from em where k = 'A'); b uuid := (select v::uuid from em where k = 'B'); begin
  perform set_platform_switch('sending_paused', false);
  perform set_platform_switch('desk_off', false);
  perform set_cv_live(a, true);
  begin perform set_cv_live(b, true); raise exception 'FAILED: cap 1 let a second company on';
  exception when others then if sqlerrm not like 'Live CV screening is already on%' then raise exception 'FAILED: cap: %', sqlerrm; end if; end;
  perform set_pilot_cap(3);
  perform set_cv_live(b, true);
  begin perform set_pilot_cap(1); raise exception 'FAILED: cap lowered below the live count';
  exception when others then if sqlerrm not like '2 companies are live now.%' then raise exception 'FAILED: lower cap: %', sqlerrm; end if; end;
  perform set_cv_live(b, false); perform set_cv_live(a, false); perform set_pilot_cap(1);
end $$;
reset role;
do $$ begin
  if (select count(*) from platform_audit where action in ('switch_set', 'pilot_cap_set')) < 6 then raise exception 'FAILED: switches not audited'; end if;
end $$;
select 'EMAIL AND SAFETY SWITCH CHECKS PASSED';
