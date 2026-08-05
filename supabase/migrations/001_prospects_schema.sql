-- prospects table
-- Enriched commercial-building prospect list: non-domestic EPC record +
-- geocoded location + Google Solar API detection result.
--
-- Run this file, then 002_prospects_rls.sql, against a fresh Supabase project.

CREATE TABLE IF NOT EXISTS prospects (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  epc_lmk_key               text        UNIQUE NOT NULL,
  uprn                      text,
  address                   text,
  postcode                  text,
  local_authority           text,
  region                    text        NOT NULL DEFAULT 'yorkshire-humber',
  property_type             text,
  total_floor_area          numeric,
  current_energy_rating     text,
  current_energy_efficiency int,
  lodgement_date            date,
  lat                       numeric,
  lng                       numeric,
  geocode_source            text,
  solar_status              text        NOT NULL DEFAULT 'pending'
                               CHECK (solar_status IN ('pending','prospect','has_solar','no_coverage','error')),
  solar_checked_at          timestamptz,
  solar_detection_status    text,
  solar_max_panels          int,
  solar_yearly_energy_kwh   numeric,
  solar_raw                 jsonb,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz
);

CREATE INDEX IF NOT EXISTS prospects_region_idx      ON prospects (region);
CREATE INDEX IF NOT EXISTS prospects_solar_status_idx ON prospects (solar_status);
CREATE INDEX IF NOT EXISTS prospects_postcode_idx     ON prospects (postcode);
CREATE INDEX IF NOT EXISTS prospects_floor_area_idx   ON prospects (total_floor_area);

-- ─── Future extension — NOT created by this migration ────────────────────
-- A prospect_contacts table, mirroring mcs-map's `contacts` table, can be
-- added later without a schema rewrite because `prospects.id` is a real
-- uuid primary key:
--
-- CREATE TABLE prospect_contacts (
--   id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
--   prospect_id    uuid NOT NULL REFERENCES prospects(id),
--   employee       text NOT NULL,
--   employee_email text,
--   outcome        text NOT NULL,
--   notes          text,
--   next_action    text,
--   follow_up_date date,
--   contacted_at   timestamptz NOT NULL DEFAULT now(),
--   updated_at     timestamptz,
--   updated_by     text,
--   deleted_at     timestamptz,
--   deleted_by     text
-- );
