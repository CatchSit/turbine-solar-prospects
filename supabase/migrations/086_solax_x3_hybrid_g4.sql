-- 086: SolaX X3-Hybrid G4 three-phase hybrid inverters added to the
-- product list (Greg, 2026-11-26).
--
-- Figures from the manufacturer's datasheet (V3.8, 2025-04-27), uploaded to
-- the website as media 1373. Max efficiency 98.0% for every size. Warranty is
-- not on the datasheet, so it is left blank for Greg to fill in (Settings >
-- Products). Aliases are the datasheet's model codes, so an EasyPV/OpenSolar
-- PDF that prints them still matches.
-- Safe to run twice: a model already in the list is skipped.

insert into products (kind, brand, model, aliases, kw, max_efficiency, product_warranty_years, datasheet_url, position)
select v.kind, v.brand, v.model, v.aliases, v.kw, v.eff, null, v.url, v.pos
from (values
  ('inverter', 'SolaX', 'X3-Hybrid G4 5kW 3ph Hybrid Inverter',  array['X3-HYBRID-5.0-D', 'X3-Hybrid-5.0-D G4'],   5::numeric, 98.0::numeric, 'https://www.turbineenergyuk.co.uk/wordpress/wp-content/uploads/2026/11/SolaX-X3-Hybrid-G4-datasheet.pdf', 170),
  ('inverter', 'SolaX', 'X3-Hybrid G4 6kW 3ph Hybrid Inverter',  array['X3-HYBRID-6.0-D', 'X3-Hybrid-6.0-D G4'],   6, 98.0, 'https://www.turbineenergyuk.co.uk/wordpress/wp-content/uploads/2026/11/SolaX-X3-Hybrid-G4-datasheet.pdf', 171),
  ('inverter', 'SolaX', 'X3-Hybrid G4 8kW 3ph Hybrid Inverter',  array['X3-HYBRID-8.0-D', 'X3-Hybrid-8.0-D G4'],   8, 98.0, 'https://www.turbineenergyuk.co.uk/wordpress/wp-content/uploads/2026/11/SolaX-X3-Hybrid-G4-datasheet.pdf', 172),
  ('inverter', 'SolaX', 'X3-Hybrid G4 10kW 3ph Hybrid Inverter', array['X3-HYBRID-10.0-D', 'X3-Hybrid-10.0-D G4'], 10, 98.0, 'https://www.turbineenergyuk.co.uk/wordpress/wp-content/uploads/2026/11/SolaX-X3-Hybrid-G4-datasheet.pdf', 173),
  ('inverter', 'SolaX', 'X3-Hybrid G4 12kW 3ph Hybrid Inverter', array['X3-HYBRID-12.0-D', 'X3-Hybrid-12.0-D G4'], 12, 98.0, 'https://www.turbineenergyuk.co.uk/wordpress/wp-content/uploads/2026/11/SolaX-X3-Hybrid-G4-datasheet.pdf', 174),
  ('inverter', 'SolaX', 'X3-Hybrid G4 15kW 3ph Hybrid Inverter', array['X3-HYBRID-15.0-D', 'X3-Hybrid-15.0-D G4'], 15, 98.0, 'https://www.turbineenergyuk.co.uk/wordpress/wp-content/uploads/2026/11/SolaX-X3-Hybrid-G4-datasheet.pdf', 175)
) as v(kind, brand, model, aliases, kw, eff, url, pos)
where not exists (select 1 from products p where p.kind = v.kind and lower(p.model) = lower(v.model));

-- Check: should list the 6 SolaX inverters
select brand, model, kw, max_efficiency, datasheet_url is not null as has_datasheet, active
from products where brand = 'SolaX' order by kw;
