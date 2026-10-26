-- New leads were always tagged region 'yorkshire-humber': it's hardcoded in
-- crm.html/index.html (Add lead), ingest-enquiry and supplier-lead, and is
-- the column default. Since the West Midlands import (2026-10-26) the map
-- loads each region separately, so a West Midlands enquiry would sit under
-- Yorkshire. Rather than fix four callers (two need function deploys), set
-- it here from the location every caller already fills in.
--
-- Only ever moves a row from the default into 'west-midlands', never the
-- other way: council (local_authority, from postcodes.io or the EPC) first,
-- postcode area only when the council is unknown. Same 7 councils as
-- scripts/regions.mjs. Runs on insert and when council/postcode change
-- (geocode-postcodes.mjs backfills local_authority after insert).

create or replace function set_prospect_region() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.region = 'yorkshire-humber' and (
       lower(coalesce(new.local_authority, '')) in ('birmingham', 'coventry', 'dudley', 'sandwell', 'solihull', 'walsall', 'wolverhampton')
       or (nullif(trim(coalesce(new.local_authority, '')), '') is null
           and upper(trim(coalesce(new.postcode, ''))) ~ '^(B|CV|DY|WS|WV)[0-9]')
     ) then
    new.region := 'west-midlands';
  end if;
  return new;
end $$;

drop trigger if exists prospects_set_region on prospects;
create trigger prospects_set_region
  before insert or update of local_authority, postcode, region on prospects
  for each row execute function set_prospect_region();

-- Existing rows (2 hand-added West Midlands leads at 2026-10-26).
update prospects set region = region
 where region = 'yorkshire-humber'
   and (lower(coalesce(local_authority, '')) in ('birmingham', 'coventry', 'dudley', 'sandwell', 'solihull', 'walsall', 'wolverhampton')
        or (nullif(trim(coalesce(local_authority, '')), '') is null
            and upper(trim(coalesce(postcode, ''))) ~ '^(B|CV|DY|WS|WV)[0-9]'));
