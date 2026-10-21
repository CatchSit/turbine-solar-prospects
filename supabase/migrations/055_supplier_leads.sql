-- Lead suppliers sending leads straight into the CRM (2026-10-21).
-- First supplier: Pockla (Greg: "they want some API details of our CRM so
-- they can add the leads directly in there"). The supplier-lead Edge
-- Function takes their leads; this migration adds what it needs.
--
-- Decisions (Greg, 2026-10-21):
--   - Pockla charges per product: GBP 27 a solar lead, GBP 32 an air source
--     heat pump lead. Each product is its own lead supplier entry, so the
--     existing cost snapshot (049) records the right price on every lead
--     with no new pricing logic, and the supplier report can compare
--     solar and ASHP lead quality separately;
--   - supplier leads land unassigned; Greg assigns them;
--   - a lead whose email or phone matches an existing CRM lead is NOT
--     created again: it's logged against the existing lead and marked as a
--     duplicate, so it isn't paid for without checking.

insert into lead_origins (name, cost_per_lead, created_by_email) values
  ('Pockla - Solar', 27.00, 'greg@turbineenergyuk.co.uk'),
  ('Pockla - ASHP',  32.00, 'greg@turbineenergyuk.co.uk')
on conflict ((lower(trim(name)))) do nothing;

-- Every lead a supplier sends, as sent, including duplicates. The CRM lead
-- (prospects) holds the working copy; this is the record of what was
-- delivered and when, for checking the supplier's invoice.
create table if not exists supplier_leads (
  id                uuid primary key default gen_random_uuid(),
  received_at       timestamptz not null default now(),
  supplier          text not null,                 -- 'Pockla'
  product           text not null,                 -- 'solar' | 'ashp'
  lead_origin_id    uuid references lead_origins(id),
  prospect_id       uuid references prospects(id) on delete set null,
  is_new_lead       boolean not null,              -- false = matched an existing lead (duplicate)
  external_ref      text,                          -- the supplier's own lead ID
  name              text,
  email             text,
  phone             text,
  address           text,
  postcode          text,
  property_type     text,                          -- 'home' | 'business'
  notes             text,
  consent_at        timestamptz,                   -- when the customer agreed to be passed on
  consent_wording   text,                          -- what they agreed to
  source_url        text,                          -- the page the customer filled in
  extra             jsonb                          -- any other fields the supplier sent
);
create index if not exists supplier_leads_prospect_idx on supplier_leads (prospect_id);
create index if not exists supplier_leads_received_idx on supplier_leads (received_at desc);
-- A supplier re-sending the same lead (a retry after a timeout) is
-- recognised by its own ID and not logged twice.
create unique index if not exists supplier_leads_ref_key on supplier_leads (supplier, external_ref) where external_ref is not null;
alter table supplier_leads enable row level security;

drop policy if exists "Turbine Energy read" on supplier_leads;
create policy "Turbine Energy read"
  on supplier_leads for select to authenticated
  using (lower(auth.jwt() ->> 'email') like '%@turbineenergyuk.co.uk');
-- No insert/update/delete policies: only the Edge Function (service role) writes.
