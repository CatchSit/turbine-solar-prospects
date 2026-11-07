-- 062: domestic homes the EPC register recommended solar for (Greg, 2026-11-06).
--
-- Map layer only, loaded by a manager with the "Load domestic EPC recommends
-- solar" button. Kept out of prospects so these homes don't enter the CRM list,
-- pipeline or roof-check queue until someone chooses to work one.
--
-- Licence: the address and postcode fields are not under the Open Government
-- Licence. MHCLG's notice permits them "solely for specific purposes" and
-- general commercial marketing isn't listed:
-- https://get-energy-performance-data.communities.gov.uk/guidance/licensing-restrictions
-- Greg was told this and chose to map full addresses. Address-level energy data
-- is also personal data, so this table is manager-read only. Rows are written by
-- scripts/ingest-domestic-solar.mjs (service role); there are no write policies.

create table if not exists domestic_solar_epc (
  certificate_number text primary key,
  address            text not null,
  postcode           text,
  council            text,
  property_type      text,
  built_form         text,
  tenure             text,
  transaction_type   text,
  energy_rating      text,
  main_fuel          text,
  lodgement_date     date,
  uprn               text,
  lat                double precision not null,
  lng                double precision not null
);

alter table domestic_solar_epc enable row level security;

drop policy if exists "Manager read" on domestic_solar_epc;
create policy "Manager read"
  on domestic_solar_epc for select to authenticated
  using (is_manager());
