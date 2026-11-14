-- The application connects as the non-superuser role semak_app (created by the DBA; see README).
-- It may read everything and insert evidence, but it can never update or delete evidence or audit
-- rows (the append-only triggers also stop the owner).
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'semak_app') then
    raise notice 'role semak_app does not exist; skipping grants';
    return;
  end if;
  grant usage on schema public to semak_app;
  grant select on all tables in schema public to semak_app;
  grant insert on app_users, premises, licences, photos, inspections, inspection_items, inspection_photos,
    unlisted_reports, unlisted_report_photos, pin_corrections, audit_events to semak_app;
  grant update on app_users, premises, licences, unlisted_reports, pin_corrections to semak_app;
  revoke update, delete, truncate on audit_events, inspections, inspection_items, inspection_photos from semak_app;
end $$;
