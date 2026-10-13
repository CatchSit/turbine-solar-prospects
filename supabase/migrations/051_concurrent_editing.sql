-- Several people on the same lead at once (requested 2026-10-12, before
-- opening the CRM up to the whole team). Decided: no locking. Instead:
--  (1) crm.html refuses a save that would overwrite someone else's newer
--      change: Customer details and quote options are saved with "...and
--      the fields still hold the values I loaded", so nothing needed here;
--  (2) the Log Contact form warns if someone logged a contact meanwhile
--      (client-side check, nothing needed here);
--  (4) the open lead page updates live when someone else changes it,
--      which needs these tables in Supabase Realtime's publication.
-- RLS still applies: a subscriber only receives rows they're allowed to
-- read. prospects is included for the open lead's own row only (the page
-- subscribes with an id filter); the bulk EPC/VOA pipelines write to
-- prospects too, but nobody subscribes to those rows.
-- Needs migration 050 (email_log) applied first.
do $$
declare
  t text;
begin
  foreach t in array array['prospects', 'prospect_contacts', 'quote_options', 'install_checklists', 'email_log']
  loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end;
$$;
