-- 077: HIES registration is a tick box, not an upload, and Building Control + EIC Certification document types (Greg, 2026-11-19).
--
-- We register the job with HIES ourselves and don't receive a document
-- back, so the MCS paperwork box on crm.html now has a "HIES registered"
-- tick box instead of asking for an upload in the 'hies' category (069).
-- Older 'hies' documents still show and still count.
--
-- Stored on install_checklists (one row per job, same edit rule:
-- can_edit_lead, 056) because client updates on prospects are limited to
-- manual leads (017). Its own small trigger stamps who ticked it and when,
-- so the 044/068 stamp function is left untouched.

alter table install_checklists
  add column if not exists hies_done        boolean not null default false,
  add column if not exists hies_updated_at  timestamptz,
  add column if not exists hies_updated_by  text;

create or replace function stamp_install_checklist_hies()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.hies_done then
      new.hies_updated_at := now();
      new.hies_updated_by := auth.jwt() ->> 'email';
    end if;
  elsif new.hies_done is distinct from old.hies_done then
    new.hies_updated_at := now();
    new.hies_updated_by := auth.jwt() ->> 'email';
  else
    new.hies_updated_at := old.hies_updated_at;
    new.hies_updated_by := old.hies_updated_by;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_stamp_install_checklist_hies on install_checklists;
create trigger trg_stamp_install_checklist_hies
  before insert or update on install_checklists
  for each row execute function stamp_install_checklist_hies();

-- Two more document types on a lead (Greg, 2026-11-19): 'building_control'
-- (building control notice / completion certificate) and 'eic' (EIC,
-- the Electrical Installation Certificate). Same list as 069 plus these.
-- Neither is part of the MCS paperwork count.
alter table lead_documents drop constraint if exists lead_documents_category_check;
alter table lead_documents add constraint lead_documents_category_check check (
  category is null or category in (
    'survey', 'bills', 'design', 'contract', 'dno', 'building_control',
    'eic', 'commissioning', 'mcs_certificate', 'handover', 'hies', 'invoices', 'other'
  )
);
