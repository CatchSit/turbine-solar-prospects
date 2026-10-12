-- Lead origin: which company supplied a lead, so lead quality can be
-- reported per supplier (requested 2026-10-12 — "I'm going to start
-- importing leads from different companies"). A lead with no origin is
-- shown and reported as "Manual" (or "Website" when lead_channel =
-- 'website', 045) — derived in the client, never stored, so every
-- existing lead is already correctly classed without a backfill.
--
-- The supplier list is a managed table rather than free text so the
-- per-supplier report can't fragment ("ABC Leads" / "abc leads ltd").
-- Managers add and edit suppliers; nobody deletes one (deactivate
-- instead), since leads keep pointing at it.
create table if not exists lead_origins (
  id               uuid primary key default gen_random_uuid(),
  name             text not null check (length(trim(name)) > 0),
  cost_per_lead    numeric(10,2) check (cost_per_lead is null or cost_per_lead >= 0),
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  created_by_email text default lower(auth.jwt() ->> 'email')
);
create unique index if not exists lead_origins_name_key on lead_origins (lower(trim(name)));

alter table lead_origins enable row level security;

drop policy if exists "Turbine Energy read lead origins" on lead_origins;
create policy "Turbine Energy read lead origins"
  on lead_origins for select to authenticated
  using (lower(auth.jwt() ->> 'email') like '%@turbineenergyuk.co.uk');

drop policy if exists "Manager insert lead origins" on lead_origins;
create policy "Manager insert lead origins"
  on lead_origins for insert to authenticated
  with check (is_manager());

drop policy if exists "Manager update lead origins" on lead_origins;
create policy "Manager update lead origins"
  on lead_origins for update to authenticated
  using (is_manager())
  with check (is_manager());
-- No delete policy on purpose.

-- lead_cost is a snapshot of the supplier's cost_per_lead at the moment
-- the origin was set, so a later price change doesn't rewrite what past
-- leads cost.
alter table prospects add column if not exists lead_origin_id uuid references lead_origins(id);
alter table prospects add column if not exists lead_cost numeric(10,2);
create index if not exists prospects_lead_origin_id_idx on prospects (lead_origin_id);

-- Any rep may pick an origin when adding a lead, but only a manager may
-- change it afterwards: the supplier report is what decides who keeps
-- getting paid, so it can't be quietly edited. Same trigger-not-policy
-- reasoning as guard_prospect_soft_delete (048) — the 017 update policy
-- is row-level and can't be scoped to one column. lead_cost is always
-- taken from the supplier, never from the client.
create or replace function stamp_prospect_lead_origin()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    if new.lead_origin_id is distinct from old.lead_origin_id and not is_manager() then
      raise exception 'Only a manager can change where a lead came from';
    end if;
    if new.lead_origin_id is not distinct from old.lead_origin_id then
      new.lead_cost := old.lead_cost;
      return new;
    end if;
  end if;
  new.lead_cost := case
    when new.lead_origin_id is null then null
    else (select cost_per_lead from lead_origins where id = new.lead_origin_id)
  end;
  return new;
end;
$$;
drop trigger if exists trg_stamp_prospect_lead_origin on prospects;
create trigger trg_stamp_prospect_lead_origin
  before insert or update on prospects
  for each row execute function stamp_prospect_lead_origin();

-- Origin changes go in the same unified edit-history log as name/address/
-- type/assignment (025 → 031 → 042).
alter table prospect_name_audit
  add column if not exists old_lead_origin_id uuid,
  add column if not exists new_lead_origin_id uuid;

create or replace function log_customer_name_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.customer_name is distinct from new.customer_name
     or old.address is distinct from new.address
     or old.postcode is distinct from new.postcode
     or old.contact_phone is distinct from new.contact_phone
     or old.contact_email is distinct from new.contact_email
     or old.lead_type is distinct from new.lead_type
     or old.assigned_to_email is distinct from new.assigned_to_email
     or old.lead_origin_id is distinct from new.lead_origin_id
  then
    insert into prospect_name_audit (
      prospect_id, old_name, new_name,
      old_address, new_address, old_postcode, new_postcode,
      old_contact_phone, new_contact_phone, old_contact_email, new_contact_email,
      old_lead_type, new_lead_type,
      old_assigned_to_email, new_assigned_to_email,
      old_lead_origin_id, new_lead_origin_id,
      edited_by_email
    )
    values (
      new.id, old.customer_name, new.customer_name,
      old.address, new.address, old.postcode, new.postcode,
      old.contact_phone, new.contact_phone, old.contact_email, new.contact_email,
      old.lead_type, new.lead_type,
      old.assigned_to_email, new.assigned_to_email,
      old.lead_origin_id, new.lead_origin_id,
      lower(auth.jwt() ->> 'email')
    );
  end if;
  return new;
end;
$$;
