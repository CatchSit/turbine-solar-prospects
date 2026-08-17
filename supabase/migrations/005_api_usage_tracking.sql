-- Self-imposed usage tracking, independent of Google Cloud console quotas.
-- solar-enrichment reads/increments this every invocation and refuses to
-- call the Solar API once request_count reaches its hard-coded monthly cap,
-- so the app never relies solely on external quota configuration to stay
-- inside the free tier.
create table if not exists api_usage (
  api_name text not null,
  period text not null, -- 'YYYY-MM', UTC calendar month
  request_count integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (api_name, period)
);

-- Service-role key (used only by the solar-enrichment Edge Function) bypasses
-- RLS entirely. No policies are added, so no anon/authenticated client can
-- read or write this table.
alter table api_usage enable row level security;
