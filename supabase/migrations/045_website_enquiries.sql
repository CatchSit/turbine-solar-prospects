-- Website enquiries → CRM (2026-10-02). Every quote-wizard submission and
-- sales-topic Contact message on turbineenergyuk.co.uk is pushed here by the
-- WordPress plugin (te-estimate-handler v2.1) via the ingest-enquiry Edge
-- Function, so nobody re-types an enquiry from the info@ inbox.
--
-- Website leads are ordinary CRM leads (source = 'manual') so every existing
-- CRM feature (editing, map pin, quote options, install checklist,
-- install-hub, assignment) works unchanged. `lead_channel` records how the
-- lead arrived: 'website', or null = added by hand in the CRM/map.
alter table prospects add column if not exists lead_channel text;

-- One row per website submission, including repeat enquiries from an
-- existing lead (decided with Greg: add to the existing lead, don't create a
-- duplicate). Written only by ingest-enquiry with the service-role key.
create table if not exists website_enquiries (
  id             uuid primary key default gen_random_uuid(),
  prospect_id    uuid references prospects(id) on delete set null,
  received_at    timestamptz not null default now(),
  form           text not null,          -- e.g. 'Air Source Heat Pump Quote', 'Contact — Battery storage'
  name           text,
  email          text,
  phone          text,
  postcode       text,
  message        text,
  is_new_lead    boolean not null default true,
  -- Where the visitor came from. page_url = the page the form was sent from
  -- (no consent needed); landing_page/referrer/utm_* = first page of the
  -- visit, only captured if the visitor accepted analytics cookies.
  page_url       text,
  landing_page   text,
  referrer       text,
  utm_source     text,
  utm_medium     text,
  utm_campaign   text,
  utm_term       text,
  utm_content    text,
  gclid          text,
  fbclid         text,
  channel        text                    -- derived: 'Google Ads', 'Organic search', 'Facebook / Instagram', …
);
create index if not exists website_enquiries_prospect_idx on website_enquiries (prospect_id);
create index if not exists website_enquiries_received_idx on website_enquiries (received_at desc);
alter table website_enquiries enable row level security;

drop policy if exists "Turbine Energy read" on website_enquiries;
create policy "Turbine Energy read"
  on website_enquiries for select to authenticated
  using (lower(auth.jwt() ->> 'email') like '%@turbineenergyuk.co.uk');
