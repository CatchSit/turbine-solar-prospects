-- 074: product list (Greg, 2026-11-19).
--
-- The Proposal Generator fills max efficiency, warranties and the datasheet
-- link for the panel, inverter and battery on a solar Proposal from this
-- list, instead of the rep typing them each time (77 saved proposals showed
-- the same product typed with different figures). Managers keep the list
-- in the CRM: Settings > Products.
--
-- model = the name printed on the proposal (Greg tweaks these).
-- aliases = other spellings EasyPV / OpenSolar print for the same product,
--   so the app still matches it. Battery aliases are written the way the
--   battery line is printed (brand included).
-- Sizes: watts (panels), kw (inverters), kwh = usable kWh per unit (batteries).
-- Prices are NOT here: supplier costs stay in price_lines (managers only).
--
-- Seed values: taken from the saved proposals where they agreed, or from the
-- manufacturer datasheet where proposals disagreed (Jinko 470W 25/30 from
-- JKM460-485N-48QL6-DB-F2; Sigenstor 8kW 97.6% from the Sigen Energy
-- Controller SP datasheet; Fox EVO 97.6% from EN-EVO-10-datasheet-UK).
-- Left blank (null) where still unconfirmed, for Greg to fill in.

create table if not exists products (
  id                          uuid primary key default gen_random_uuid(),
  kind                        text not null check (kind in ('panel', 'inverter', 'battery', 'heat_pump', 'other')),
  brand                       text not null default '',
  model                       text not null,
  description                 text,
  aliases                     text[] not null default '{}',
  watts                       numeric,
  kw                          numeric,
  kwh                         numeric,
  max_efficiency              numeric check (max_efficiency is null or (max_efficiency > 0 and max_efficiency <= 100)),
  product_warranty_years      integer check (product_warranty_years is null or product_warranty_years >= 0),
  performance_warranty_years  integer check (performance_warranty_years is null or performance_warranty_years >= 0),
  datasheet_url               text check (datasheet_url is null or datasheet_url ~* '^https://'),
  active                      boolean not null default true,
  position                    integer not null default 0,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  updated_by_email            text
);

alter table products enable row level security;

drop policy if exists "Turbine Energy read" on products;
create policy "Turbine Energy read"
  on products for select to authenticated
  using (lower(auth.jwt() ->> 'email') like '%@turbineenergyuk.co.uk');

drop policy if exists "Manager insert" on products;
create policy "Manager insert" on products for insert to authenticated with check (is_manager());
drop policy if exists "Manager update" on products;
create policy "Manager update" on products for update to authenticated using (is_manager()) with check (is_manager());
-- No delete: untick Active to retire a product (old proposals keep pointing at it).

create or replace function stamp_products()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  new.updated_by_email := auth.jwt() ->> 'email';
  return new;
end;
$$;
drop trigger if exists products_stamp on products;
create trigger products_stamp before insert or update on products
  for each row execute function stamp_products();

-- Seed (only if the table is empty, so re-running never duplicates).
insert into products (kind, brand, model, aliases, watts, kw, kwh, max_efficiency, product_warranty_years, performance_warranty_years, position)
select * from (values
  -- Panels
  ('panel', 'Jinko', 'Tiger Neo 3.0 470W All Black Dual Glass Mono', '{}'::text[], 470, null::numeric, null::numeric, null::numeric, 25, 30, 10),
  ('panel', 'Jinko', 'Tiger Neo 460W Dual Glass All Black N-Type Mono', '{}', 460, null, null, null, 25, 30, 20),
  ('panel', 'Longi', 'Hi-Mo X10 HVB 480W All Black Mono', '{}', 480, null, null, null, null, 30, 30),
  ('panel', 'Longi', 'Hi-Mo X10 485W HVB All Black Mono', '{}', 485, null, null, null, null, 30, 40),
  ('panel', 'Canadian Solar', 'CS6.2-48TD-455', '{"CS6.2-48TD-455 - All Black"}', 455, null, null, null, 25, 30, 50),
  ('panel', 'Aiko', 'Neostar 3S 490W All Black ABC N-Type Mono (Traceable)', '{}', 490, null, null, null, 25, 30, 60),
  ('panel', 'Aiko', 'Neostar 3S+ 540W Dual Glass All Black ABC N-Type Bifacial', '{"Neostar 3S+ 540W Dual Glass All Black ABC N- type Bifacial"}', 540, null, null, null, 25, 30, 70),
  ('panel', 'Aiko', 'Neostar 3S+ 530W Dual Glass All Black N-Type ABC Bifacial', '{"Neostar 3S+ 530W Dual Glass All Black N- Type ABC Bifacial"}', 530, null, null, null, 25, 30, 80),
  ('panel', 'Aiko', 'Neostar 3P+ 540W Dual Glass Black White Mono Bifacial', '{}', 540, null, null, null, 25, 30, 90),
  ('panel', 'Aiko', 'Neostar 2S+ 510W Dual Glass All Black ABC N-Type Mono', '{"Neostar 2S+ 510W Dual Glass All Black ABC N- Type Mono"}', 510, null, null, null, 25, 30, 100),
  ('panel', 'Aiko', 'Neostar 510W Dual Glass All Black ABC N-Type Mono', '{"Neostar 510W Dual Glass All Black ABC N- Type Mono"}', 510, null, null, null, 25, 30, 110),
  ('panel', 'JA Solar', 'JAM72S30-570/LR', '{}', 570, null, null, null, null, null, 120),
  -- Inverters
  ('inverter', 'Sofar', 'PowerAll 3.68kW 1ph Hybrid Inverter', '{"PowerAll 3.6kw Hybrid Inverter","PowerAll 3.6kw Hybrid Inverter 1ph"}', null, 3.68, null, 98.2, 10, null, 10),
  ('inverter', 'Sofar', 'PowerAll 5.0kW 1ph Hybrid Inverter', '{}', null, 5, null, 98.2, 10, null, 20),
  ('inverter', 'Sofar', 'PowerAll 6.0kW 1ph Hybrid Inverter', '{"PowerAll 6.0kw Hybrid Inverter 1ph","PowerAll 6kw Hybrid Inverter 1ph"}', null, 6, null, 98.2, 10, null, 30),
  ('inverter', 'Sofar', '50kW 3ph Hybrid Inverter', '{"50kW 3ph Hybrid Inverter - Battery Cabinet Ready"}', null, 50, null, null, 10, null, 40),
  ('inverter', 'Sofar', 'HYD-60K-T1 Hybrid Inverter 3ph', '{"HYD-60K-T1"}', null, 60, null, 98.2, 10, null, 50),
  ('inverter', 'Sofar', '100KTLX-G4 PV Inverter', '{"100kw PV Inverter 100KTLX-G4"}', null, 100, null, 98.2, 10, null, 60),
  ('inverter', 'Sofar', '125KTLX-G4 Hybrid Inverter', '{"125kw Hybrid Inverter KTLX G4"}', null, 125, null, 98.3, 10, null, 70),
  ('inverter', 'Sigenergy', 'Sigenstor 3.6kW 1ph Hybrid', '{}', null, 3.6, null, 98.0, 10, null, 80),
  ('inverter', 'Sigenergy', 'Sigenstor 5kW 1ph Hybrid', '{}', null, 5, null, 98.0, 10, null, 90),
  ('inverter', 'Sigenergy', 'Sigenstor 6kW 1ph Hybrid', '{}', null, 6, null, 98.0, 10, null, 100),
  ('inverter', 'Sigenergy', 'Sigenstor 8kW 1ph Hybrid', '{}', null, 8, null, 97.6, 10, null, 110),
  ('inverter', 'Sigenergy', 'SP2 3.68kW 1ph Hybrid Inverter', '{}', null, 3.68, null, 98.0, 10, null, 120),
  ('inverter', 'EcoFlow', 'Ocean 2 Plus 8kW 1ph', '{}', null, 8, null, 98.0, 15, null, 130),
  ('inverter', 'EcoFlow', 'Ocean 2 Plus 10kW 1ph', '{}', null, 10, null, null, 15, null, 140),
  ('inverter', 'EcoFlow', 'PowerOcean 6kW 1ph (2 MPPTs)', '{"6kW 1ph (2 MPPTs)"}', null, 6, null, 96.5, 15, null, 150),
  ('inverter', 'Fox', 'ESS EVO 10 - 8kW with 10kWh Storage All in One (with Cover)', '{}', null, 8, null, 97.6, null, null, 160),
  -- Batteries (aliases as printed on the battery line, brand included)
  ('battery', 'Sigenergy', 'SigenStor 10.0 8.76kWh Battery', '{"Sigenergy SigenStor 10.0 8.76kWh Battery","Sigenergy SigenStor 10.0 8.8kWh Battery"}', null, null, 8.76, null, 10, null, 10),
  ('battery', 'Sofar', 'PowerAll 5.12kWh Heated Battery', '{"Sofar PowerAll 5.12kWh Heated Battery","Sofar PowerAll 5.12kwh Heated Battery","Sofar PowerAll 5.12kw Heated Battery","Sofar PowerAll 5.12kw HeatedBattery","Sofar PowerAll 5.12kwh Heated Stackable Battery","Sofar PowerAll 5.12kwh Heated Battery - Stackable"}', null, null, 5.12, null, 10, null, 20),
  ('battery', 'Sofar', 'PowerAll 5.0kWh Heated Battery', '{"Sofar PowerAll 5.0kwh Heated Battery","Sofar PowerAll 5.0kwh Heated Stackable Battery","Sofar PowerAll 5.0kWh Heated Stackable Battery","Sofar PowerAll 5.0kwh Heated Battery - Stackable","Sofar PowerAll 5.0kwh Heated Battery Stackable","Sofar PowerAll 5kw Heated Battery"}', null, null, 5, null, 10, null, 30),
  ('battery', 'Sofar', 'CBS5000 5kWh Battery Module', '{"Sofar CBS5000 5.0kwh Battery Modules","Sofar CBS5000 5kwh battery module"}', null, null, 5, null, 10, null, 40),
  ('battery', 'Sofar', 'CBS8000 Battery Cabinet', '{"Sofar CBS8000 96kwh Battery Cabinet","Sofar CBS8000-64 cabinet 64kwh"}', null, null, null, null, 10, null, 50),
  ('battery', 'EcoFlow', 'Ocean 2 5.02kWh Battery', '{"Ecoflow Ocean 2 5.02kWh Battery"}', null, null, 5.02, null, 15, null, 60),
  ('battery', 'EcoFlow', 'Ocean 2 8.03kWh Battery', '{"Ecoflow Ocean 2 8.03kWh Battery"}', null, null, 8.03, null, 15, null, 70),
  ('battery', 'EcoFlow', 'PowerOcean LFP 5kWh Battery', '{"EcoFlow Power Ocean LFP 5kWh"}', null, null, 5, null, 15, null, 80),
  ('battery', 'Fox', 'EVO 10.24kWh Battery (in the EVO all-in-one)', '{"Fox EVO 10kWh Battery","Fox EVO 10kWh Battery integrated in the Fox EVO all-in-one"}', null, null, 10.24, null, null, null, 90)
) as v(kind, brand, model, aliases, watts, kw, kwh, max_efficiency, product_warranty_years, performance_warranty_years, position)
where not exists (select 1 from products);
