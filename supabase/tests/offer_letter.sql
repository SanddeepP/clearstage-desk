-- Item 4 (CTO approval-packet rulings 21 Nov §4.2–4.4): offer letter + Annexure A from the calculator, versions with a
-- content hash, review to the end before approve (in the database), one exact version approved. Fictional data only.
\set ON_ERROR_STOP on
reset role;
create temp table ol(k text primary key, v text); grant select, insert on ol to authenticated;
set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000001';
reset request.jwt.claim.session_id;
do $$ declare rid uuid; a jsonb; o jsonb; oid uuid; v1 offer_version; v2 offer_version; v3 offer_version; c jsonb; n int; p jsonb; total bigint; begin
  insert into role(company_id, title, city, status, approved_by, budget_min, budget_max) values ((current_member()).company_id, 'Data Analyst (letter test)', 'Hyderabad', 'open', (current_member()).id, 1000000, 1400000) returning id into rid;
  a := desk_add_candidate('Kavya Fictional', rid, 'kavya.fictional@example.com', null, true);
  o := desk_save_offer((a->>'application_id')::uuid, '{"ctc": 1200000, "basic_monthly": 50000, "joining_on": "2027-01-04"}'::jsonb);
  oid := (o->>'offer_id')::uuid; insert into ol values ('offer', oid::text);
  select * into v1 from offer_version where offer_id = oid order by version_no desc limit 1;
  if v1.version_no <> 1 or v1.content_hash !~ '^[0-9a-f]{64}$' or v1.content_hash <> content_hash(v1.content) then raise exception 'FAILED: v1 %', to_jsonb(v1); end if;
  c := v1.content;
  if c->'template'->>'status' <> 'rules review pending' then raise exception 'FAILED: template not labelled: %', c->'template'; end if;
  if not exists (select 1 from jsonb_array_elements(c->'clauses') x where x->>'text' = 'Dear Kavya,')
     or not exists (select 1 from jsonb_array_elements(c->'clauses') x where x->>'text' like 'We are pleased to offer you the position of Data Analyst (letter test) at Rycruit, based in Hyderabad.')
     or not exists (select 1 from jsonb_array_elements(c->'clauses') x where x->>'text' like '%₹12,00,000 a year%' and x->>'text' like '%Annexure A%')
     or not exists (select 1 from jsonb_array_elements(c->'clauses') x where x->>'text' = 'We would like you to join on 4 Jan 2027.') then
    raise exception 'FAILED: clauses %', c->'clauses'; end if;
  if exists (select 1 from jsonb_array_elements(c->'clauses') x where x->>'text' ~ '\{[a-z_]+\}') then raise exception 'FAILED: an unfilled field in %', c->'clauses'; end if;
  select sum((x->>'annual')::bigint) into total from jsonb_array_elements(c->'annexure'->'lines') x;
  if total <> 1200000 or (c->'annexure'->>'passes')::boolean is not true or c->'annexure'->>'note' not like 'PF: 12%% × min(PF wages, ₹25,000)%' then raise exception 'FAILED: annexure %', c->'annexure'; end if;
  -- the same content again: no new version
  perform desk_save_offer((a->>'application_id')::uuid, '{"ctc": 1200000, "basic_monthly": 50000, "joining_on": "2027-01-04"}'::jsonb);
  if (select count(*) from offer_version where offer_id = oid) <> 1 then raise exception 'FAILED: identical content made a new version'; end if;
  -- Desk may write only the role summary and welcome line
  perform set_offer_letter_text(oid, 'You will build the weekly lending reports.', 'We look forward to working with you.');
  select * into v2 from offer_version where offer_id = oid order by version_no desc limit 1;
  if v2.version_no <> 2 or v2.content_hash = v1.content_hash then raise exception 'FAILED: v2 %', to_jsonb(v2); end if;
  begin perform set_offer_letter_text(oid, 'Hi, we prefer unmarried candidates', null); raise exception 'FAILED: blocked words accepted';
  exception when others then if sqlerrm <> 'That wording isn''t allowed in a letter' then raise exception 'FAILED: blocked: %', sqlerrm; end if; end;
  -- approve needs the review of the latest version, by the approver
  begin perform desk_approve('offer', oid); raise exception 'FAILED: approved without reading';
  exception when others then if sqlerrm <> 'Open the offer and read the letter to the end (Annexure A) before approving' then raise exception 'FAILED: no review: %', sqlerrm; end if; end;
  perform mark_offer_reviewed(v2.id);
  perform set_offer_letter_text(oid, 'You will build the weekly lending reports.', 'Welcome aboard.');     -- a change after the review
  select * into v3 from offer_version where offer_id = oid order by version_no desc limit 1;
  if v3.version_no <> 3 then raise exception 'FAILED: v3 missing'; end if;
  begin perform desk_approve('offer', oid); raise exception 'FAILED: approved v3 after reading only v2';
  exception when others then if sqlerrm not like 'Open the offer%' then raise exception 'FAILED: stale review: %', sqlerrm; end if; end;
  p := offer_packet(oid);
  if (p->'version'->>'no')::int <> 3 or (p->'version'->>'reviewed_by_me')::boolean or jsonb_array_length(p->'versions') <> 3 or (p->'checks'->>'in_budget')::boolean is not true
     or not (p->>'can_approve')::boolean or jsonb_typeof(p->'cv') <> 'null' then raise exception 'FAILED: packet before approval: %', p - 'history'; end if;
  perform mark_offer_reviewed(v3.id);
  if (desk_approve('offer', oid)->>'approved')::int <> 1 then raise exception 'FAILED: approval'; end if;
  if (select approved_version_id from offer where id = oid) <> v3.id then raise exception 'FAILED: approved version not recorded'; end if;
  p := offer_packet(oid);
  if p->'approved_version'->>'hash' <> v3.content_hash or not exists (select 1 from jsonb_array_elements(p->'history') h where h->>'action' = 'offer_approved' and h->'detail'->>'content_hash' = v3.content_hash) then
    raise exception 'FAILED: packet after approval: %', p->'history'; end if;
  -- versions are append-only for users
  begin insert into offer_version(company_id, offer_id, version_no, content, content_hash) values ((current_member()).company_id, oid, 9, '{}', repeat('a', 64)); raise exception 'FAILED: user wrote a version';
  exception when others then if sqlerrm like 'FAILED%' then raise; end if; end;
  begin update offer_version set content_hash = repeat('b', 64) where offer_id = oid; get diagnostics n = row_count;
    if n <> 0 then raise exception 'FAILED: user changed a version'; end if;
  exception when others then if sqlerrm like 'FAILED%' then raise; end if; end;
  -- an offer can't be pushed to "sent" around the approval
  o := desk_save_offer((desk_add_candidate('Ravi Fictional', rid, null, null, true)->>'application_id')::uuid, '{"ctc": 1200000, "basic_monthly": 50000}'::jsonb);
  begin update offer set status = 'sent', approved_by = (current_member()).id where id = (o->>'offer_id')::uuid; raise exception 'FAILED: sent without an approved version';
  exception when others then if sqlerrm like 'FAILED%' then raise; end if; end;
end $$;
-- a Recruiter can't mark a letter reviewed (only approvers)
set request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000002';
do $$ begin
  perform mark_offer_reviewed((select id from offer_version where offer_id = (select v::uuid from ol where k = 'offer') order by version_no desc limit 1)); raise exception 'FAILED: a Recruiter reviewed';
exception when others then if sqlerrm like 'FAILED%' then raise; end if; end $$;
reset role;
select 'OFFER LETTER, VERSIONS AND REVIEW-BEFORE-APPROVE (ITEM 4) CHECKS PASSED';
