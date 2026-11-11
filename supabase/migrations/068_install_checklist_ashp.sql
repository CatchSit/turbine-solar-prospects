-- Heat pump installs get their own checklist (Greg, 2026-11-11).
--
-- Solar installs keep scaffold, electrician, roofer, kit. Air source heat
-- pump installs need electrician, plumber, scaffold, kit (no roofer). The
-- type is picked on the CRM lead page's Install checklist and defaults to
-- solar, so every existing checklist is unchanged.
--
-- Adds install_type plus a plumber task with the same columns as the other
-- four (done, name, N/A, who/when stamps), and re-creates the stamping
-- trigger function from 047 with plumber included. Safe to run twice.

alter table install_checklists
  add column if not exists install_type        text not null default 'solar',
  add column if not exists plumber_done        boolean not null default false,
  add column if not exists plumber_name        text,
  add column if not exists plumber_na          boolean not null default false,
  add column if not exists plumber_updated_at  timestamptz,
  add column if not exists plumber_updated_by  text;

alter table install_checklists drop constraint if exists install_checklists_install_type_check;
alter table install_checklists add constraint install_checklists_install_type_check
  check (install_type in ('solar', 'ashp'));
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
