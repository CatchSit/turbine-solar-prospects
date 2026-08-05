-- RLS policies for the prospects table.
--
-- Stricter than mcs-map's `contacts` table: there is no user-generated
-- content in v1 (no CRM layer), so the anon/authenticated client role only
-- gets read access. All writes happen server-side, using the service-role
-- key, from scripts/ingest-epc.mjs, scripts/geocode-postcodes.mjs, and the
-- solar-enrichment Edge Function.

ALTER TABLE prospects ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read"
  ON prospects FOR SELECT
  TO anon, authenticated
  USING (true);

-- Deliberately no INSERT / UPDATE / DELETE policy for anon/authenticated —
-- the service-role key (used server-side only) bypasses RLS entirely.
