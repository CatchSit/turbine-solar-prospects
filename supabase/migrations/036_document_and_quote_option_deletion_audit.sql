-- Two new destructive actions (deleting a document, deleting a whole quote
-- option) each need their own durable audit trail — deleting the row is
-- exactly the moment the evidence it ever existed would otherwise be lost,
-- so these are written by AFTER DELETE triggers capturing OLD.*, same
-- "can't be skipped or forged by a rep" reasoning as every other audit
-- table in this project (023, 025/031).

-- ── Document deletion ───────────────────────────────────────────────────
-- Any Turbine Energy rep can delete — symmetric with the existing
-- insert/read policies on this table (014), neither of which is
-- admin-only. Deliberately not admin-gated, unlike quote option deletion
-- below (2026-09-17 decision — only the latter was asked to be
-- manager-only).
drop policy if exists "Turbine Energy delete" on lead_documents;
create policy "Turbine Energy delete"
  on lead_documents for delete to authenticated
  using (lower(auth.jwt() ->> 'email') like '%@turbineenergyuk.co.uk');

-- Deleting the row here only ever removes the lead_documents record, never
-- the underlying file in the 'proposals' Storage bucket — a deliberate
-- soft-delete-by-metadata choice, consistent with this project's general
-- bias toward not destroying recoverability (no hard column drops
-- elsewhere either). storage_path stays in this audit row forever, so an
-- admin can still retrieve the original file from Storage directly if a
-- deletion is later regretted, even though the app's own UI no longer
-- lists it.
create table if not exists lead_document_audit (
  id                uuid primary key default gen_random_uuid(),
  prospect_id       uuid not null references prospects(id) on delete cascade,
  quote_option_id   uuid, -- no FK — may reference an option deleted in the same cascade (see below)
  file_name         text,
  storage_path      text,
  file_size_bytes   bigint,
  uploaded_by       text,
  uploaded_by_email text,
  uploaded_at       timestamptz,
  deleted_at        timestamptz not null default now(),
  deleted_by_email  text
);
create index if not exists lead_document_audit_prospect_id_idx on lead_document_audit (prospect_id);

alter table lead_document_audit enable row level security;
drop policy if exists "Turbine Energy read" on lead_document_audit;
create policy "Turbine Energy read"
  on lead_document_audit for select to authenticated
  using (lower(auth.jwt() ->> 'email') like '%@turbineenergyuk.co.uk');

create or replace function log_document_deletion()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into lead_document_audit (
    prospect_id, quote_option_id, file_name, storage_path, file_size_bytes,
    uploaded_by, uploaded_by_email, uploaded_at, deleted_by_email
  ) values (
    old.prospect_id, old.quote_option_id, old.file_name, old.storage_path, old.file_size_bytes,
    old.uploaded_by, old.uploaded_by_email, old.uploaded_at, lower(auth.jwt() ->> 'email')
  );
  return old;
end;
$$;

drop trigger if exists trg_log_document_deletion on lead_documents;
create trigger trg_log_document_deletion
  after delete on lead_documents
  for each row execute function log_document_deletion();

-- ── Quote option deletion ───────────────────────────────────────────────
-- lead_quote_audit's own edit history for an option must survive the
-- option itself being deleted — otherwise deleting a quote option would
-- destroy the very audit trail meant to record what happened to it.
-- Switched from CASCADE to SET NULL; every audit row already carries
-- prospect_id and label directly (not just the FK), so full context
-- survives even once quote_option_id goes null.
alter table lead_quote_audit drop constraint if exists lead_quote_audit_quote_option_id_fkey;
alter table lead_quote_audit add constraint lead_quote_audit_quote_option_id_fkey
  foreign key (quote_option_id) references quote_options(id) on delete set null;

-- A one-row snapshot of the option at the moment it was deleted (who, when,
-- and everything it contained) — distinct from lead_quote_audit, which
-- records changes across the option's life, not its end.
create table if not exists quote_option_deletion_log (
  id                uuid primary key default gen_random_uuid(),
  prospect_id       uuid not null references prospects(id) on delete cascade,
  quote_option_id   uuid not null, -- no FK — the referenced row no longer exists by definition
  label             text,
  kit_price         numeric,
  scaffold_price    numeric,
  electrical_cost   numeric,
  roofer_cost       numeric,
  mcs_cost          numeric,
  fuel_cost         numeric,
  commission_cost   numeric,
  quote_price       numeric,
  was_selected      boolean,
  deleted_at        timestamptz not null default now(),
  deleted_by_email  text
);
create index if not exists quote_option_deletion_log_prospect_id_idx on quote_option_deletion_log (prospect_id);

alter table quote_option_deletion_log enable row level security;
drop policy if exists "Turbine Energy read" on quote_option_deletion_log;
create policy "Turbine Energy read"
  on quote_option_deletion_log for select to authenticated
  using (lower(auth.jwt() ->> 'email') like '%@turbineenergyuk.co.uk');

create or replace function log_quote_option_deletion()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into quote_option_deletion_log (
    prospect_id, quote_option_id, label, kit_price, scaffold_price, electrical_cost, roofer_cost,
    mcs_cost, fuel_cost, commission_cost, quote_price, was_selected, deleted_by_email
  ) values (
    old.prospect_id, old.id, old.label, old.kit_price, old.scaffold_price, old.electrical_cost, old.roofer_cost,
    old.mcs_cost, old.fuel_cost, old.commission_cost, old.quote_price, old.is_selected, lower(auth.jwt() ->> 'email')
  );
  return old;
end;
$$;

drop trigger if exists trg_log_quote_option_deletion on quote_options;
create trigger trg_log_quote_option_deletion
  after delete on quote_options
  for each row execute function log_quote_option_deletion();
