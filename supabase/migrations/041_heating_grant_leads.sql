-- Adds two nullable columns to support the new source:'oil-lpg-bus' lead
-- category — domestic properties still on oil/LPG heating, eligible for the
-- temporary £9,000 Boiler Upgrade Scheme grant (21 Jul 2026 - 31 Mar 2027).
-- Additive only, no backfill, no constraint changes.
--
-- source itself needs no schema change (013_voa_prospect_source.sql already
-- made it free text with no CHECK constraint); solar_status is seeded
-- 'no_coverage' at insert time by scripts/ingest-heating-grant-leads.mjs so
-- these rows are never queued by solar-enrichment's pending-only query.

alter table prospects
  add column if not exists main_fuel text,
  add column if not exists tenure text;
