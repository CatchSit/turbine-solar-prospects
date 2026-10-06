-- "Delete" a lead from the CRM list without losing the underlying data —
-- same soft-delete shape as quote_options/lead_documents (037): a
-- deleted_at/deleted_by_email pair to hide it, restored_at/restored_by_email
-- to bring it back, the row (and everything referencing prospect_id —
-- quote_options, contacts, documents, install checklist, etc.) never
-- actually leaves the table.
alter table prospects add column if not exists deleted_at timestamptz;
alter table prospects add column if not exists deleted_by_email text;
alter table prospects add column if not exists restored_at timestamptz;
alter table prospects add column if not exists restored_by_email text;

create index if not exists prospects_deleted_at_idx on prospects (deleted_at);

-- The existing "Turbine Energy update manual lead" policy (017) is
-- row-level only and already lets any Turbine Energy rep update any column
-- of a manual lead — Postgres RLS can't restrict a policy to specific
-- columns. Deleting a lead removes it from the whole team's list, not just
-- the acting rep's own view, so (like quote_options' guard_quote_option_
-- soft_delete, 037/043) this is kept manager-only via a trigger instead,
-- reusing is_manager() (043) rather than hardcoding an email.
create or replace function guard_prospect_soft_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.deleted_at is distinct from old.deleted_at then
    if not is_manager() then
      raise exception 'Only a manager can delete or restore a lead';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_guard_prospect_soft_delete on prospects;
create trigger trg_guard_prospect_soft_delete
  before update on prospects
  for each row execute function guard_prospect_soft_delete();
