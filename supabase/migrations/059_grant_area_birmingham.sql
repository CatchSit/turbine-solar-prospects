-- Birmingham gets a tracked grant status (2026-10-27, Greg), like the four
-- South Yorkshire councils in 016: a manager sets it in Manager Home's
-- "Grant funding by area" card, and the map shades Birmingham's boundary
-- (added to shared/south-yorkshire-boundaries.geojson) and colours its area
-- chip. grant_areas only allows managers to update, not insert, so the row
-- has to exist. `on conflict do nothing` so a re-run never overwrites a
-- status a manager has since set.
insert into grant_areas (local_authority, status) values
  ('Birmingham', 'available')
on conflict (local_authority) do nothing;
