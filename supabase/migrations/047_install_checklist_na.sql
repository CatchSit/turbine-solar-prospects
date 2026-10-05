-- Not every job needs all four install-prep tasks (e.g. no scaffold
-- needed for a bungalow, kit already on-site) — requested 2026-10-05.
-- Adds an N/A toggle alongside each task's existing done checkbox, mutually
-- exclusive with it (enforced both client-side, crm.html disables the Done
-- checkbox while N/A is ticked, and here via a check constraint as a
-- backstop against a direct API call bypassing the client).
alter table install_checklists
  add column if not exists scaffold_na    boolean not null default false,
  add column if not exists electrician_na boolean not null default false,
  add column if not exists roofer_na      boolean not null default false,
  add column if not exists kit_na         boolean not null default false;

alter table install_checklists drop constraint if exists install_checklists_scaffold_done_na_excl;
alter table install_checklists add constraint install_checklists_scaffold_done_na_excl
  check (not (scaffold_done and scaffold_na));
alter table install_checklists drop constraint if exists install_checklists_electrician_done_na_excl;
alter table install_checklists add constraint install_checklists_electrician_done_na_excl
  check (not (electrician_done and electrician_na));
alter table install_checklists drop constraint if exists install_checklists_roofer_done_na_excl;
alter table install_checklists add constraint install_checklists_roofer_done_na_excl
  check (not (roofer_done and roofer_na));
alter table install_checklists drop constraint if exists install_checklists_kit_done_na_excl;
alter table install_checklists add constraint install_checklists_kit_done_na_excl
  check (not (kit_done and kit_na));

-- Extends 044's stamp_install_checklist() so marking (or clearing) N/A
-- stamps who/when too, same as ticking done or changing the name —
-- the _na columns join each task's existing (done, name) comparison tuple.
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
    new.kit_updated_at := null; new.kit_updated_by := null;
    new.created_at := now();
    if new.scaffold_done or new.scaffold_na or new.scaffold_name is not null then new.scaffold_updated_at := now(); new.scaffold_updated_by := who; end if;
    if new.electrician_done or new.electrician_na or new.electrician_name is not null then new.electrician_updated_at := now(); new.electrician_updated_by := who; end if;
    if new.roofer_done or new.roofer_na or new.roofer_name is not null then new.roofer_updated_at := now(); new.roofer_updated_by := who; end if;
    if new.kit_done or new.kit_na or new.kit_name is not null then new.kit_updated_at := now(); new.kit_updated_by := who; end if;
  else
    new.scaffold_updated_at := old.scaffold_updated_at; new.scaffold_updated_by := old.scaffold_updated_by;
    new.electrician_updated_at := old.electrician_updated_at; new.electrician_updated_by := old.electrician_updated_by;
    new.roofer_updated_at := old.roofer_updated_at; new.roofer_updated_by := old.roofer_updated_by;
    new.kit_updated_at := old.kit_updated_at; new.kit_updated_by := old.kit_updated_by;
    if (new.scaffold_done, new.scaffold_na, new.scaffold_name) is distinct from (old.scaffold_done, old.scaffold_na, old.scaffold_name) then
      new.scaffold_updated_at := now(); new.scaffold_updated_by := who; end if;
    if (new.electrician_done, new.electrician_na, new.electrician_name) is distinct from (old.electrician_done, old.electrician_na, old.electrician_name) then
      new.electrician_updated_at := now(); new.electrician_updated_by := who; end if;
    if (new.roofer_done, new.roofer_na, new.roofer_name) is distinct from (old.roofer_done, old.roofer_na, old.roofer_name) then
      new.roofer_updated_at := now(); new.roofer_updated_by := who; end if;
    if (new.kit_done, new.kit_na, new.kit_name) is distinct from (old.kit_done, old.kit_na, old.kit_name) then
      new.kit_updated_at := now(); new.kit_updated_by := who; end if;
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  return new;
end;
$$;
-- Trigger itself (trg_stamp_install_checklist, 044) is unchanged — it
-- already fires on every install_checklists insert/update and calls this
-- function by name.
