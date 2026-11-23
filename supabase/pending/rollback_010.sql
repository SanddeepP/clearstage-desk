-- Emergency rollback for 010 (only if signed-in users see empty screens because tokens lack session_id).
-- Apply through the workflow as a new migration (copy to supabase/migrations/0NN_rollback_010.sql). Re-runnable.
do $$ declare t record; begin
  for t in select schemaname, tablename from pg_policies where policyname = 'session_fresh' and schemaname in ('public') loop
    execute format('drop policy if exists session_fresh on %I.%I', t.schemaname, t.tablename);
  end loop;
end $$;
create or replace function current_member() returns member
language sql stable security definer set search_path = public as $$ select * from member where user_id = auth.uid() limit 1 $$;
