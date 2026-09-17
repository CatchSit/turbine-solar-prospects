-- True soft-delete for quote_options and lead_documents — 036's hard
-- delete + audit-log snapshot preserved the *data* but gave no way to
-- actually get a deleted row back short of manually reading the log and
-- re-inserting it by hand. This replaces the delete path with an UPDATE
-- (deleted_at set), so a restore is just clearing that column back to
-- null — the row, and everything referencing it, never actually left the
-- table.

-- ── quote_options ────────────────────────────────────────────────────
alter table quote_options add column if not exists deleted_at timestamptz;
alter table quote_options add column if not exists deleted_by_email text;
alter table quote_options add column if not exists restored_at timestamptz;
alter table quote_options add column if not exists restored_by_email text;

-- The "one selected option per lead" index must ignore soft-deleted rows —
-- otherwise a soft-deleted-but-still-is_selected row would block any other
-- option in the same lead from ever being marked selected.
drop index if exists quote_options_one_selected_per_prospect;
create unique index quote_options_one_selected_per_prospect
  on quote_options (prospect_id) where is_selected and deleted_at is null;

-- Deleting/restoring a quote option must stay manager-only even though
-- ordinary cost/label edits go through the same general "Turbine Energy
-- update" policy (any rep) — a plain RLS policy can't cleanly express
-- "this column only, admin only" without a subquery comparing old vs new,
-- so it's enforced with a trigger instead, same reasoning as every other
-- old-vs-new guard in this project. Reuses quote_option_deletion_log (036)
-- for the snapshot, since its purpose — "what was deleted, when, by
-- whom" — is identical whether the row is hard- or soft-deleted.
create or replace function guard_quote_option_soft_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.deleted_at is distinct from old.deleted_at then
    if lower(auth.jwt() ->> 'email') <> 'greg@turbineenergyuk.co.uk' then
      raise exception 'Only a manager can delete or restore a quote option';
    end if;
    if new.deleted_at is not null then
      insert into quote_option_deletion_log (
        prospect_id, quote_option_id, label, kit_price, scaffold_price, electrical_cost, roofer_cost,
        mcs_cost, fuel_cost, commission_cost, quote_price, was_selected, deleted_by_email
      ) values (
        old.prospect_id, old.id, old.label, old.kit_price, old.scaffold_price, old.electrical_cost, old.roofer_cost,
        old.mcs_cost, old.fuel_cost, old.commission_cost, old.quote_price, old.is_selected, new.deleted_by_email
      );
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_guard_quote_option_soft_delete on quote_options;
create trigger trg_guard_quote_option_soft_delete
  before update on quote_options
  for each row execute function guard_quote_option_soft_delete();

-- ── lead_documents ───────────────────────────────────────────────────
-- Not admin-gated — delete/restore stays any-rep, symmetric with the
-- existing insert/read/delete policies (014/036), so no guard trigger
-- needed here, just logging.
alter table lead_documents add column if not exists deleted_at timestamptz;
alter table lead_documents add column if not exists deleted_by_email text;
alter table lead_documents add column if not exists restored_at timestamptz;
alter table lead_documents add column if not exists restored_by_email text;

create or replace function log_document_soft_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.deleted_at is not null and old.deleted_at is null then
    insert into lead_document_audit (
      prospect_id, quote_option_id, file_name, storage_path, file_size_bytes,
      uploaded_by, uploaded_by_email, uploaded_at, deleted_by_email
    ) values (
      old.prospect_id, old.quote_option_id, old.file_name, old.storage_path, old.file_size_bytes,
      old.uploaded_by, old.uploaded_by_email, old.uploaded_at, new.deleted_by_email
    );
  end if;
  return new;
end;
$$;
drop trigger if exists trg_log_document_soft_delete on lead_documents;
create trigger trg_log_document_soft_delete
  before update on lead_documents
  for each row execute function log_document_soft_delete();
