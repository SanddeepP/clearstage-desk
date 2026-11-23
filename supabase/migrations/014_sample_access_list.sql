-- 014_sample_access_list.sql — founder 23 Nov: Settings → Sample data access lists who has demo access.
-- sample_access_list(): platform admin only. Emails of people with sample access, when and by whom it was granted.
-- Re-runnable.
create or replace function sample_access_list() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_platform_admin() then raise exception 'Only Clearstage can see who has sample access'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('email', u.email, 'granted_at', s.granted_at, 'granted_by', g.email) order by s.granted_at desc)
    from sample_access s join auth.users u on u.id = s.user_id left join auth.users g on g.id = s.granted_by), '[]');
end $$;
revoke all on function sample_access_list() from public, anon; grant execute on function sample_access_list() to authenticated;
