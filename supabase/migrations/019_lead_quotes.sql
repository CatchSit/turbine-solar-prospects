-- Quote-details costing (kit/scaffold/electrical/roofer) for the new CRM
-- page. One row per prospect — v1 is a single current quote, not a
-- revision history, matching the small "quote details" section asked for
-- (2026-09-07), not a full quote-builder. Total is computed client-side,
-- not stored, so it can't drift from the four inputs it's derived from.
-- Applies to any prospect, not just source:'manual' leads — a rep may
-- just as easily quote a pipeline-sourced prospect.
create table if not exists lead_quotes (
  prospect_id      uuid primary key references prospects(id) on delete cascade,
  kit_price        numeric,
  scaffold_price   numeric,
  electrical_cost  numeric,
  roofer_cost      numeric,
  updated_at       timestamptz not null default now(),
  updated_by_email text
);

alter table lead_quotes enable row level security;

-- Any Turbine Energy rep can read and write — quoting isn't manager-only,
-- unlike prospect_contacts' read (Section 5 of HANDOVER.md).
drop policy if exists "Turbine Energy read" on lead_quotes;
create policy "Turbine Energy read"
  on lead_quotes for select
  to authenticated
  using (lower(auth.jwt() ->> 'email') like '%@turbineenergyuk.co.uk');

drop policy if exists "Turbine Energy insert" on lead_quotes;
create policy "Turbine Energy insert"
  on lead_quotes for insert
  to authenticated
  with check (lower(auth.jwt() ->> 'email') like '%@turbineenergyuk.co.uk');

drop policy if exists "Turbine Energy update" on lead_quotes;
create policy "Turbine Energy update"
  on lead_quotes for update
  to authenticated
  using (lower(auth.jwt() ->> 'email') like '%@turbineenergyuk.co.uk')
  with check (lower(auth.jwt() ->> 'email') like '%@turbineenergyuk.co.uk');
