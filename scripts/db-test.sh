#!/usr/bin/env bash
# Loads every migration (each twice, to prove they re-run) plus the seed into a throwaway Postgres
# with Supabase stand-ins, then runs the database tests. Used by CI. Needs PGHOST/PGPORT/PGUSER set.
set -euo pipefail
cd "$(dirname "$0")/.."
P="psql -v ON_ERROR_STOP=1 -q"
$P -c "create schema auth; create table auth.users(id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as \$\$ select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid \$\$;
  create table auth.sessions(id uuid primary key, user_id uuid not null, created_at timestamptz not null default now());
  create function auth.jwt() returns jsonb language sql stable as \$\$ select jsonb_strip_nulls(jsonb_build_object('sub', nullif(current_setting('request.jwt.claim.sub', true),''),
    'session_id', coalesce(nullif(current_setting('request.jwt.claim.session_id', true),''), nullif(current_setting('request.jwt.claim.sub', true),'')))) \$\$;
  create function auth.new_user_session() returns trigger language plpgsql as \$\$ begin insert into auth.sessions(id, user_id) values (new.id, new.id) on conflict do nothing; return new; end \$\$;
  create trigger new_user_session after insert on auth.users for each row execute function auth.new_user_session();
  create schema storage;
  create table storage.buckets(id text primary key, name text not null, public boolean default false, file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text not null, owner uuid, created_at timestamptz default now(), unique (bucket_id, name));
  alter table storage.objects enable row level security;
  create function storage.foldername(name text) returns text[] language sql immutable as \$\$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] \$\$;
  do \$\$ begin create role anon; exception when duplicate_object then null; end \$\$; do \$\$ begin create role authenticated; exception when duplicate_object then null; end \$\$;
  grant usage on schema auth to authenticated, anon;
  grant usage on schema storage to authenticated, anon; grant select on storage.buckets to authenticated; grant select, insert, update, delete on storage.objects to authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant all on sequences to anon, authenticated;
  grant usage on schema public to anon, authenticated;"
$P -f supabase/migrations/001_schema.sql
$P -f supabase/migrations/002_scheduler.sql
$P -f supabase/seed.sql
for f in supabase/migrations/0*.sql; do case "$f" in *001_*|*002_*) continue;; esac; $P -f "$f"; $P -f "$f"; done
for t in supabase/tests/desk_tools.sql supabase/tests/allowlist_c5.sql supabase/tests/statutory_rules.sql supabase/tests/screening.sql supabase/tests/session.sql supabase/tests/isolation.sql supabase/tests/sample_access.sql supabase/tests/global_ready.sql supabase/tests/modules.sql supabase/tests/roles.sql supabase/tests/hire_scope.sql supabase/tests/desk_discard.sql; do
  last=$(psql -v ON_ERROR_STOP=1 -q -t -A -f "$t" | tail -1); echo "$last"
  case "$last" in *PASSED*) ;; *) echo "FAILED: $t"; exit 1;; esac
done
