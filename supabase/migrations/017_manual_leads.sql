-- Lets a rep add a lead directly from the map instead of only ever seeing
-- pipeline-sourced (EPC/VOA) rows. Reuses the existing `prospects` table
-- (source:'manual', already a free-text column with no CHECK constraint —
-- see 013_voa_prospect_source.sql) rather than a separate table, so the
-- new rows get the existing map markers/popup/filters/Log Contact/
-- Proposals machinery for free. Columns are all nullable — every existing
-- pipeline row simply leaves them null.
alter table prospects add column if not exists customer_name text;
alter table prospects add column if not exists lead_type text check (lead_type in ('commercial', 'domestic'));
alter table prospects add column if not exists contact_phone text;
alter table prospects add column if not exists contact_email text;
alter table prospects add column if not exists created_by_email text;

-- This project has never had a client insert/update policy on `prospects`
-- before now — every prior row is written server-side via the service-role
-- key (see HANDOVER.md Section 5). Both new policies are scoped tightly to
-- source = 'manual' so pipeline-owned EPC/VOA rows stay exactly as
-- unreachable from the client as they always were.
drop policy if exists "Turbine Energy insert manual lead" on prospects;
create policy "Turbine Energy insert manual lead"
  on prospects for insert
  to authenticated
  with check (
    source = 'manual'
    and lower(auth.jwt() ->> 'email') like '%@turbineenergyuk.co.uk'
    and created_by_email = auth.jwt() ->> 'email'
  );

-- Row-level only (Postgres RLS can't restrict to specific columns), so this
-- technically permits editing any field of a manual lead, not just
-- lat/lng — deliberate: the immediate need is letting a rep drag a
-- mis-geocoded pin to the exact building, but there's no reason a future
-- "edit lead" feature should need another migration to also allow fixing a
-- mistyped phone number on the same row.
drop policy if exists "Turbine Energy update manual lead" on prospects;
create policy "Turbine Energy update manual lead"
  on prospects for update
  to authenticated
  using (source = 'manual' and lower(auth.jwt() ->> 'email') like '%@turbineenergyuk.co.uk')
  with check (source = 'manual' and lower(auth.jwt() ->> 'email') like '%@turbineenergyuk.co.uk');
