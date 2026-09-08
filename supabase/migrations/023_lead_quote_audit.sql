-- Full edit history for lead_quotes (019/022). Written automatically by a
-- trigger on every insert/update — not by client code — so the audit
-- trail can't be skipped or forged by a rep, and edited_by_email reflects
-- the actual authenticated caller (from the JWT) rather than a
-- client-supplied value like lead_quotes.updated_by_email does.
create table if not exists lead_quote_audit (
  id               uuid primary key default gen_random_uuid(),
  prospect_id      uuid not null references prospects(id) on delete cascade,
  kit_price        numeric,
  scaffold_price   numeric,
  electrical_cost  numeric,
  roofer_cost      numeric,
  quote_price      numeric,
  edited_at        timestamptz not null default now(),
  edited_by_email  text
);

alter table lead_quote_audit enable row level security;

-- Any Turbine Energy rep can read the history. No insert/update/delete
-- policies are defined for regular reps — rows are only ever written by
-- the trigger function below (which runs as its owner and so bypasses
-- RLS), meaning the log can't be edited or deleted from the client.
drop policy if exists "Turbine Energy read" on lead_quote_audit;
create policy "Turbine Energy read"
  on lead_quote_audit for select
  to authenticated
  using (lower(auth.jwt() ->> 'email') like '%@turbineenergyuk.co.uk');

create or replace function log_lead_quote_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into lead_quote_audit (
    prospect_id, kit_price, scaffold_price, electrical_cost, roofer_cost,
    quote_price, edited_by_email
  ) values (
    new.prospect_id, new.kit_price, new.scaffold_price, new.electrical_cost,
    new.roofer_cost, new.quote_price, lower(auth.jwt() ->> 'email')
  );
  return new;
end;
$$;

drop trigger if exists trg_log_lead_quote_change on lead_quotes;
create trigger trg_log_lead_quote_change
  after insert or update on lead_quotes
  for each row execute function log_lead_quote_change();
