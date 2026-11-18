-- 072: fuel per installer on quote options (Greg, 2026-11-18).
--
-- Replaces the single flat "Fuel costs" box on NEW quote options with one
-- line per installer: tick who is on the job, and each ticked installer
-- costs road miles x 2 (there and back) x pence per mile. Jobs within the
-- free radius of the office (Wader Lodge, DN5 7TR) show N/A (GBP 0), and a
-- manager can mark any installer N/A by hand.
--
-- Going forward only: quote options that already exist keep fuel_breakdown
-- null and keep their flat fuel_cost, exactly as before. fuel_cost stays the
-- figure that profit, commission and Jobs won read; for new options crm.html
-- writes the per-installer total into it.
--
-- Settings live in app_settings (migration 060: everyone reads, managers
-- write). The keys are prefixed crm_fuel_ so they can't clash with the
-- proposal generator's own settings (it copies every key into its config,
-- harmlessly).

-- Road miles from the office to the lead, worked out by the road-distance
-- Edge Function (OpenRouteService) and saved once per postcode.
alter table prospects add column if not exists road_miles_from_office numeric;
alter table prospects add column if not exists road_miles_postcode text;
alter table prospects add column if not exists road_miles_checked_at timestamptz;

-- Snapshot per quote option, so changing the settings later never changes
-- a saved quote:
--   { "v": 1, "miles": 38.4, "radius": 40, "ppm": 30,
--     "rows": [ { "id": "alex-plant", "name": "Alex Plant", "on": true, "na": false }, ... ] }
alter table quote_options add column if not exists fuel_breakdown jsonb;

insert into app_settings (key, value) values
  ('crm_fuel_radius_miles', '40'),
  ('crm_fuel_pence_per_mile', '30'),
  ('crm_fuel_office_postcode', 'DN5 7TR'),
  ('crm_fuel_installers', '[{"id":"alex-plant","name":"Alex Plant","active":true},{"id":"steve-pears","name":"Steve Pears","active":true},{"id":"richard-nehles","name":"Richard Nehles","active":true},{"id":"dale-haywood","name":"Dale Haywood","active":true}]')
on conflict (key) do nothing;
