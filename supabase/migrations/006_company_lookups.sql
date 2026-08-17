-- Free, on-demand Companies House lookup per prospect, cached so repeat
-- opens of the same prospect don't re-hit the external API. Written only
-- by the company-lookup Edge Function via the service-role key.
create table if not exists company_lookups (
  prospect_id uuid primary key references prospects(id) on delete cascade,
  fetched_at timestamptz not null default now(),
  source text not null default 'companies_house', -- 'companies_house' | 'ai_agent' (future, deferred)
  companies jsonb not null default '[]'::jsonb,
  -- companies: [{ company_name, company_number, status, officers: [{ name, role }] }]
  no_match boolean not null default false
);

alter table company_lookups enable row level security;
-- No policies: only the service-role key (used by company-lookup) reads/writes this table.
