-- Install checklist per job (requested 2026-09-30): once a job is
-- Scheduled for Install, track the four things that have to be booked
-- before install day — scaffold, electrician, roofer, kit — each as a
-- done checkbox plus who it's booked with (scaffold company / electrician
-- / roofer / kit supplier). Edited on crm.html's lead page; home.html's
-- "Install prep" tracker and "Needs attention" read it.
--
-- A separate table rather than columns on `prospects`, because client
-- updates on `prospects` are limited to source = 'manual' (017) — a won
-- job that started as an EPC/VOA map prospect still needs a checklist.
create table if not exists install_checklists (
  prospect_id               uuid primary key references prospects(id) on delete cascade,
  scaffold_done             boolean not null default false,
  scaffold_name             text,
  scaffold_updated_at       timestamptz,
  scaffold_updated_by       text,
  electrician_done          boolean not null default false,
  electrician_name          text,
  electrician_updated_at    timestamptz,
  electrician_updated_by    text,
  roofer_done               boolean not null default false,
  roofer_name               text,
  roofer_updated_at         timestamptz,
  roofer_updated_by         text,
  kit_done                  boolean not null default false,
  kit_name                  text,
  kit_updated_at            timestamptz,
  kit_updated_by            text,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);
alter table install_checklists enable row level security;

-- Any Turbine Energy account can read and edit, same as quote_options (034).
-- No delete policy — unticking is the way to "undo".
drop policy if exists "Turbine Energy read" on install_checklists;
create policy "Turbine Energy read"
  on install_checklists for select to authenticated
  using (lower(auth.jwt() ->> 'email') like '%@turbineenergyuk.co.uk');

drop policy if exists "Turbine Energy insert" on install_checklists;
create policy "Turbine Energy insert"
  on install_checklists for insert to authenticated
  with check (lower(auth.jwt() ->> 'email') like '%@turbineenergyuk.co.uk');

drop policy if exists "Turbine Energy update" on install_checklists;
create policy "Turbine Energy update"
  on install_checklists for update to authenticated
  using (lower(auth.jwt() ->> 'email') like '%@turbineenergyuk.co.uk')
  with check (lower(auth.jwt() ->> 'email') like '%@turbineenergyuk.co.uk');

-- Stamps who changed each task and when, from the caller's own JWT — never
-- trusted from the client. Only the task(s) whose done/name actually changed
-- get re-stamped.
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
    -- Stamps can't be supplied by the client.
    new.scaffold_updated_at := null; new.scaffold_updated_by := null;
    new.electrician_updated_at := null; new.electrician_updated_by := null;
    new.roofer_updated_at := null; new.roofer_updated_by := null;
    new.kit_updated_at := null; new.kit_updated_by := null;
    new.created_at := now();
    if new.scaffold_done or new.scaffold_name is not null then new.scaffold_updated_at := now(); new.scaffold_updated_by := who; end if;
    if new.electrician_done or new.electrician_name is not null then new.electrician_updated_at := now(); new.electrician_updated_by := who; end if;
    if new.roofer_done or new.roofer_name is not null then new.roofer_updated_at := now(); new.roofer_updated_by := who; end if;
    if new.kit_done or new.kit_name is not null then new.kit_updated_at := now(); new.kit_updated_by := who; end if;
  else
    -- Stamps can't be set directly from the client on update.
    new.scaffold_updated_at := old.scaffold_updated_at; new.scaffold_updated_by := old.scaffold_updated_by;
    new.electrician_updated_at := old.electrician_updated_at; new.electrician_updated_by := old.electrician_updated_by;
    new.roofer_updated_at := old.roofer_updated_at; new.roofer_updated_by := old.roofer_updated_by;
    new.kit_updated_at := old.kit_updated_at; new.kit_updated_by := old.kit_updated_by;
    if (new.scaffold_done, new.scaffold_name) is distinct from (old.scaffold_done, old.scaffold_name) then
      new.scaffold_updated_at := now(); new.scaffold_updated_by := who; end if;
    if (new.electrician_done, new.electrician_name) is distinct from (old.electrician_done, old.electrician_name) then
      new.electrician_updated_at := now(); new.electrician_updated_by := who; end if;
    if (new.roofer_done, new.roofer_name) is distinct from (old.roofer_done, old.roofer_name) then
      new.roofer_updated_at := now(); new.roofer_updated_by := who; end if;
    if (new.kit_done, new.kit_name) is distinct from (old.kit_done, old.kit_name) then
      new.kit_updated_at := now(); new.kit_updated_by := who; end if;
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_stamp_install_checklist on install_checklists;
create trigger trg_stamp_install_checklist
  before insert or update on install_checklists
  for each row execute function stamp_install_checklist();
