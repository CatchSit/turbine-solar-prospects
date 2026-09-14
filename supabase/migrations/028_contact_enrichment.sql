-- Manual, per-prospect contact enrichment via Apollo/Hunter (index.html's
-- "Find more info" popup button, 2026-09-14). Unlike solar-enrichment
-- (automatic batches), this is rep-triggered one prospect at a time, so no
-- batching/pending-status machinery — just a request log for audit/history
-- and reuse of the existing api_usage table (005) for the "N left this
-- month" counters shown before the rep picks a provider.
create table if not exists contact_enrichment_log (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid not null references prospects(id) on delete cascade,
  provider text not null check (provider in ('apollo', 'hunter')),
  requested_at timestamptz not null default now(),
  requested_by_email text,
  target_name text,
  target_company text,
  found_email text,
  found_phone text,
  status text not null check (status in ('found', 'not_found', 'error')),
  error_message text
);

create index if not exists contact_enrichment_log_prospect_id_idx
  on contact_enrichment_log (prospect_id);

-- Written only by the contact-enrichment Edge Function's service-role
-- client (bypasses RLS), same as api_usage — this policy is read-only
-- visibility for reps, not a write grant.
alter table contact_enrichment_log enable row level security;
drop policy if exists "Turbine Energy read" on contact_enrichment_log;
create policy "Turbine Energy read"
  on contact_enrichment_log for select
  to authenticated
  using (lower(auth.jwt() ->> 'email') like '%@turbineenergyuk.co.uk');
