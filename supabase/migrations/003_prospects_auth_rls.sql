-- Replace public read access with authenticated-only read access.
-- The prospects table now holds real Turbine Energy sales-lead data
-- (~21,800 rows as of this migration) — see docs/superpowers/specs/
-- 2026-08-12-azure-ad-auth-design.md for the full rationale. Frontend
-- access now requires a signed-in @turbineenergyuk.co.uk Microsoft
-- account (Azure AD via Supabase Auth), enforced here at the database
-- level, not just in the UI.

DROP POLICY "Public read" ON prospects;

CREATE POLICY "Authenticated read"
  ON prospects FOR SELECT
  TO authenticated
  USING (true);
