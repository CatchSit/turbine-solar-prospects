-- Document categories on a lead (Greg, 2026-11-14), from the 12 Nov MCS/HIES
-- audit: commissioning sheets, DNO papers, MCS certificates and handover
-- packs were only in the shared folder, so nothing showed what a job still
-- needed. crm.html's Documents card now groups files by category and shows
-- the MCS paperwork still missing once a job is won.
--
-- Datasheets and Building Regs certificates are deliberately NOT categories
-- (Greg: datasheets get linked from the proposal itself; no Building Regs
-- category wanted). Existing rows stay null and show under "Other" until
-- someone moves them. Quote-option documents (quote_option_id set) keep no
-- category; they live inside their quote option.
--
-- Changing a category is an ordinary update, already allowed by the
-- "Turbine Energy update" policy (can_edit_lead, migrations 038/056). The
-- before-update trigger only acts when deleted_at changes.

alter table lead_documents add column if not exists category text;

alter table lead_documents drop constraint if exists lead_documents_category_check;
alter table lead_documents add constraint lead_documents_category_check check (
  category is null or category in (
    'survey',          -- Site survey and photos
    'bills',           -- Bills and usage data
    'design',          -- Design and MCS estimate (EasyPV/OpenSolar, heat loss, noise)
    'contract',        -- Signed quote and contract
    'dno',             -- DNO application and notification
    'commissioning',   -- Commissioning records
    'mcs_certificate', -- MCS certificate
    'handover',        -- Handover pack
    'hies',            -- HIES registration and insurance-backed guarantee
    'invoices',        -- Invoices and payments
    'other'
  )
);
