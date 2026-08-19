create table if not exists business_rates_matches (
  prospect_id uuid primary key references prospects(id) on delete cascade,
  hereditaments jsonb not null default '[]'::jsonb,
  -- hereditaments: [{ description, rateable_value, billing_authority_code }]
  no_match boolean not null default false,
  fetched_at timestamptz not null default now()
);

alter table business_rates_matches enable row level security;
-- No policies — service-role only, same pattern as company_lookups/api_usage.
-- Superseded by 011_business_rates_rls.sql — see that file.
