-- Job type on the lead, and a heat pump install checklist (Greg, 2026-11-11).
--
-- prospects.product says what the job is: 'solar' (solar and battery, the
-- default, so every existing lead stays solar) or 'ashp' (air source heat
-- pump). With the existing lead_type (domestic / commercial) the CRM shows
-- four job types: Solar - Domestic, Solar - Commercial, ASHP - Domestic,
-- ASHP - Commercial.
--
-- The install checklist follows the product: solar needs scaffold,
-- electrician, roofer, kit; ASHP needs electrician, plumber, scaffold, kit.
-- This adds the plumber task (same columns as the other four) and re-creates
-- the stamping trigger function from 047 with plumber included.
--
-- Product changes go into the lead's edit history like lead_type does
-- (log_customer_name_change, last re-created in 049). Safe to run twice.

-- 1. Product on the lead
alter table prospects add column if not exists product text not null default 'solar';
alter table prospects drop constraint if exists prospects_product_check;
alter table prospects add constraint prospects_product_check check (product in ('solar', 'ashp'));

-- 2. Edit history
alter table prospect_name_audit
  add column if not exists old_product text,
  add column if not exists new_product text;

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
     or old.product is distinct from new.product
     or old.assigned_to_email is distinct from new.assigned_to_email
     or old.lead_origin_id is distinct from new.lead_origin_id
  then
    insert into prospect_name_audit (
      prospect_id, old_name, new_name,
      old_address, new_address, old_postcode, new_postcode,
      old_contact_phone, new_contact_phone, old_contact_email, new_contact_email,
      old_lead_type, new_lead_type,
      old_product, new_product,
      old_assigned_to_email, new_assigned_to_email,
      old_lead_origin_id, new_lead_origin_id,
      edited_by_email
    )
    values (
      new.id, old.customer_name, new.customer_name,
      old.address, new.address, old.postcode, new.postcode,
      old.contact_phone, new.contact_phone, old.contact_email, new.contact_email,
      old.lead_type, new.lead_type,
      old.product, new.product,
      old.assigned_to_email, new.assigned_to_email,
      old.lead_origin_id, new.lead_origin_id,
      lower(auth.jwt() ->> 'email')
    );
  end if;
  return new;
end;
$$;

-- 3. Plumber task on the install checklist
alter table install_checklists
  add column if not exists plumber_done        boolean not null default false,
  add column if not exists plumber_name        text,
  add column if not exists plumber_na          boolean not null default false,
  add column if not exists plumber_updated_at  timestamptz,
  add column if not exists plumber_updated_by  text;
-- An earlier draft of this migration put the type on the checklist; it lives on the lead now.
alter table install_checklists drop column if exists install_type;

alter table install_checklists drop constraint if exists install_checklists_plumber_done_na_excl;
alter table install_checklists add constraint install_checklists_plumber_done_na_excl
  check (not (plumber_done and plumber_na));

create or replace function stamp_install_checklist()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  who text := lower(auth.jwt() ->> 'email');
begin
  if tg_op = 'INSERT' then
    new.scaffold_updated_at := null; new.scaffold_updated_by := null;
    new.electrician_updated_at := null; new.electrician_updated_by := null;
    new.roofer_updated_at := null; new.roofer_updated_by := null;
    new.plumber_updated_at := null; new.plumber_updated_by := null;
    new.kit_updated_at := null; new.kit_updated_by := null;
    new.created_at := now();
    if new.scaffold_done or new.scaffold_na or new.scaffold_name is not null then new.scaffold_updated_at := now(); new.scaffold_updated_by := who; end if;
    if new.electrician_done or new.electrician_na or new.electrician_name is not null then new.electrician_updated_at := now(); new.electrician_updated_by := who; end if;
    if new.roofer_done or new.roofer_na or new.roofer_name is not null then new.roofer_updated_at := now(); new.roofer_updated_by := who; end if;
    if new.plumber_done or new.plumber_na or new.plumber_name is not null then new.plumber_updated_at := now(); new.plumber_updated_by := who; end if;
    if new.kit_done or new.kit_na or new.kit_name is not null then new.kit_updated_at := now(); new.kit_updated_by := who; end if;
  else
    new.scaffold_updated_at := old.scaffold_updated_at; new.scaffold_updated_by := old.scaffold_updated_by;
    new.electrician_updated_at := old.electrician_updated_at; new.electrician_updated_by := old.electrician_updated_by;
    new.roofer_updated_at := old.roofer_updated_at; new.roofer_updated_by := old.roofer_updated_by;
    new.plumber_updated_at := old.plumber_updated_at; new.plumber_updated_by := old.plumber_updated_by;
    new.kit_updated_at := old.kit_updated_at; new.kit_updated_by := old.kit_updated_by;
    if (new.scaffold_done, new.scaffold_na, new.scaffold_name) is distinct from (old.scaffold_done, old.scaffold_na, old.scaffold_name) then
      new.scaffold_updated_at := now(); new.scaffold_updated_by := who; end if;
    if (new.electrician_done, new.electrician_na, new.electrician_name) is distinct from (old.electrician_done, old.electrician_na, old.electrician_name) then
      new.electrician_updated_at := now(); new.electrician_updated_by := who; end if;
    if (new.roofer_done, new.roofer_na, new.roofer_name) is distinct from (old.roofer_done, old.roofer_na, old.roofer_name) then
      new.roofer_updated_at := now(); new.roofer_updated_by := who; end if;
    if (new.plumber_done, new.plumber_na, new.plumber_name) is distinct from (old.plumber_done, old.plumber_na, old.plumber_name) then
      new.plumber_updated_at := now(); new.plumber_updated_by := who; end if;
    if (new.kit_done, new.kit_na, new.kit_name) is distinct from (old.kit_done, old.kit_na, old.kit_name) then
      new.kit_updated_at := now(); new.kit_updated_by := who; end if;
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  return new;
end;
$$;
-- Trigger trg_stamp_install_checklist (044) is unchanged; it calls this function by name.
