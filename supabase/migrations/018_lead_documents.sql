-- Generalises prospect_proposals (PDF sales proposals only) into a general
-- per-lead documents table — surveys, contracts, ID, site photos, etc.,
-- not just proposal PDFs. Requested alongside the new CRM page (2026-09-07)
-- so a lead's paperwork lives in one place regardless of document type.
--
-- A plain rename, not a drop/recreate: Postgres tracks a table's indexes,
-- constraints, and RLS policies by OID, not by name, so 014's "Turbine
-- Energy insert"/"Turbine Energy read" policies and the prospect_id index
-- carry over unchanged — no need to recreate them here.
alter table prospect_proposals rename to lead_documents;

-- The Storage bucket keeps its internal id ('proposals') — renaming a
-- Supabase Storage bucket means recreating it and moving every existing
-- object, and the id is never shown to a user, so there's no real benefit
-- to touching it. Only widen what it accepts beyond PDF-only.
update storage.buckets
set allowed_mime_types = array[
  'application/pdf',
  'image/jpeg', 'image/png', 'image/heic',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
]
where id = 'proposals';
