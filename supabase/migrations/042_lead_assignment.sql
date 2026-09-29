-- Lets a rep be assigned to a manual lead (crm.html, requested 2026-09-29)
-- — a tag/filter only, same as lead_type: every authenticated
-- @turbineenergyuk.co.uk user can still see and edit every lead (no RLS
-- change), it just adds an "Assigned to" field, a sidebar filter, and a
-- leads-table column. The roster itself (shared/rep-config.js) is a
-- hardcoded list, not derived from auth.users, so it's not enforced at
-- the database level — assigned_to_email is free text, validated only by
-- the client UI offering the fixed roster to pick from.
alter table prospects add column if not exists assigned_to_email text;

-- Extends prospect_name_audit (025 + 031) rather than adding a parallel
-- table, so a lead's edit history stays one unified log.
alter table prospect_name_audit
  add column if not exists old_assigned_to_email text,
  add column if not exists new_assigned_to_email text;

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
  then
    insert into prospect_name_audit (
      prospect_id, old_name, new_name,
      old_address, new_address, old_postcode, new_postcode,
      old_contact_phone, new_contact_phone, old_contact_email, new_contact_email,
      old_lead_type, new_lead_type,
      old_assigned_to_email, new_assigned_to_email,
      edited_by_email
    )
    values (
      new.id, old.customer_name, new.customer_name,
      old.address, new.address, old.postcode, new.postcode,
      old.contact_phone, new.contact_phone, old.contact_email, new.contact_email,
      old.lead_type, new.lead_type,
      old.assigned_to_email, new.assigned_to_email,
      lower(auth.jwt() ->> 'email')
    );
  end if;
  return new;
end;
$$;
-- Trigger itself (trg_log_customer_name_change, 025) is unchanged — it
-- already fires on every prospects UPDATE and calls this function by name.
