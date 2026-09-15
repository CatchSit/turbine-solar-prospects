-- crm.html's lead detail "Edit" now covers every editable field (customer
-- name, address, postcode, contact phone/email, lead type), not just the
-- name — extends the existing prospect_name_audit table/trigger (025)
-- rather than adding a parallel table, so one save produces one unified
-- history row (same "one row per edit event, whichever fields actually
-- changed" shape as lead_quote_audit) instead of fragmenting history
-- across tables per field.
alter table prospect_name_audit
  add column if not exists old_address text,
  add column if not exists new_address text,
  add column if not exists old_postcode text,
  add column if not exists new_postcode text,
  add column if not exists old_contact_phone text,
  add column if not exists new_contact_phone text,
  add column if not exists old_contact_email text,
  add column if not exists new_contact_email text,
  add column if not exists old_lead_type text,
  add column if not exists new_lead_type text;

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
  then
    insert into prospect_name_audit (
      prospect_id, old_name, new_name,
      old_address, new_address, old_postcode, new_postcode,
      old_contact_phone, new_contact_phone, old_contact_email, new_contact_email,
      old_lead_type, new_lead_type,
      edited_by_email
    )
    values (
      new.id, old.customer_name, new.customer_name,
      old.address, new.address, old.postcode, new.postcode,
      old.contact_phone, new.contact_phone, old.contact_email, new.contact_email,
      old.lead_type, new.lead_type,
      lower(auth.jwt() ->> 'email')
    );
  end if;
  return new;
end;
$$;
-- Trigger itself (trg_log_customer_name_change, 025) is unchanged — it
-- already fires on every prospects UPDATE and calls this function by name.
