-- Audit trail for prospects.customer_name edits (crm.html's new inline
-- rename control). Same pattern as lead_quote_audit (migration 023):
-- written by a database trigger, not client code, so it can't be skipped
-- or forged, and edited_by_email comes from the caller's JWT rather than
-- a client-supplied value.
--
-- The trigger is on `prospects` as a whole (not a customer_name-specific
-- table) because that's the only table the name lives on — it only ever
-- inserts a row when customer_name actually changed, so the frequent
-- bulk updates to other columns (solar_status, ownership_status, etc.)
-- are a no-op check, not noise in this log.
create table if not exists prospect_name_audit (
  id               uuid primary key default gen_random_uuid(),
  prospect_id      uuid not null references prospects(id) on delete cascade,
  old_name         text,
  new_name         text,
  edited_at        timestamptz not null default now(),
  edited_by_email  text
);

alter table prospect_name_audit enable row level security;

-- Any Turbine Energy rep can read the history. No insert/update/delete
-- policies for regular reps — rows are only ever written by the trigger
-- function below (runs as its owner, bypassing RLS), so the log can't be
-- edited or deleted from the client.
drop policy if exists "Turbine Energy read" on prospect_name_audit;
create policy "Turbine Energy read"
  on prospect_name_audit for select
  to authenticated
  using (lower(auth.jwt() ->> 'email') like '%@turbineenergyuk.co.uk');

create or replace function log_customer_name_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.customer_name is distinct from new.customer_name then
    insert into prospect_name_audit (prospect_id, old_name, new_name, edited_by_email)
    values (new.id, old.customer_name, new.customer_name, lower(auth.jwt() ->> 'email'));
  end if;
  return new;
end;
$$;

drop trigger if exists trg_log_customer_name_change on prospects;
create trigger trg_log_customer_name_change
  after update on prospects
  for each row execute function log_customer_name_change();
