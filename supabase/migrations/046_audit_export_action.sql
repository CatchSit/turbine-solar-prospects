-- Manager Home: allow 'export' in manager_audit_log (2026-10-02).
-- home.html's Marketing page logs one 'export' row (section = 'marketing')
-- each time a manager downloads the "won jobs for Google Ads" offline
-- conversion CSV — it contains Google click IDs tied to paying customers, so
-- who took a copy and when is worth recording. Until this is applied that
-- insert fails the CHECK and is only logged to the browser console; the
-- download itself is unaffected.
--
-- 043 declared the check inline, so Postgres named it
-- manager_audit_log_action_check.
alter table manager_audit_log drop constraint if exists manager_audit_log_action_check;
alter table manager_audit_log add constraint manager_audit_log_action_check
  check (action in ('sign_in', 'view_section', 'export'));
