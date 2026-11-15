#!/usr/bin/env bash
# Loads every migration (each twice, to prove they re-run) plus the seed into a throwaway Postgres
# with Supabase stand-ins, then runs the database tests. Used by CI. Needs PGHOST/PGPORT/PGUSER set.
set -euo pipefail
cd "$(dirname "$0")/.."
P="psql -v ON_ERROR_STOP=1 -q"
$P -c "create schema auth; create table auth.users(id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as \$\$ select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid \$\$;
  do \$\$ begin create role anon; exception when duplicate_object then null; end \$\$; do \$\$ begin create role authenticated; exception when duplicate_object then null; end \$\$;
  grant usage on schema auth to authenticated, anon;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant all on sequences to anon, authenticated;
  grant usage on schema public to anon, authenticated;"
$P -f supabase/migrations/001_schema.sql
$P -f supabase/migrations/002_scheduler.sql
$P -f supabase/seed.sql
for f in supabase/migrations/00[3-9]_*.sql; do $P -f "$f"; $P -f "$f"; done
for t in supabase/tests/desk_tools.sql supabase/tests/allowlist_c5.sql; do psql -v ON_ERROR_STOP=1 -q -t -A -f "$t" | tail -1; done
