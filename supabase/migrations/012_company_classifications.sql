create table if not exists company_classifications (
  prospect_id uuid primary key references prospects(id) on delete cascade,
  fetched_at timestamptz not null default now(),
  no_match boolean not null default false,
  company_name text,
  company_number text,
  sic_codes text[],
  incorporated_on date,
  accounts_type text
);

alter table company_classifications enable row level security;

create policy "Authenticated Turbine Energy users can read company classifications"
  on company_classifications for select
  to authenticated
  using (lower(auth.jwt() ->> 'email') like '%@turbineenergyuk.co.uk');
