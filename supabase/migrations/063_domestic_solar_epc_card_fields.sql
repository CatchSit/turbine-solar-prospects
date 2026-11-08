-- 063: extra details for the domestic solar map card (Greg, 2026-11-07).
-- Costs are the assessor's yearly estimates from the certificate, in pounds.

alter table domestic_solar_epc
  add column if not exists roof_description text,
  add column if not exists floor_area numeric,
  add column if not exists age_band text,
  add column if not exists potential_rating text,
  add column if not exists energy_score integer,
  add column if not exists potential_score integer,
  add column if not exists energy_cost_yearly numeric;
