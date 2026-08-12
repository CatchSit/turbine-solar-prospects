-- Close a real gap found in final review: the "Authenticated read" policy
-- from 003 only checked that a session existed, not who it belonged to.
-- The domain restriction lived only in index.html's client-side check,
-- which an attacker who self-registers directly against the API never
-- executes. This makes the restriction a real, database-enforced
-- guarantee instead of a UI-only one — the RLS check is what actually
-- limits data to Turbine Energy staff, regardless of whether public
-- email signup is left enabled on the project.

DROP POLICY IF EXISTS "Authenticated read" ON prospects;

CREATE POLICY "Turbine staff read"
  ON prospects FOR SELECT
  TO authenticated
  USING (lower(auth.jwt() ->> 'email') LIKE '%@turbineenergyuk.co.uk');
