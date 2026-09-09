-- Property-ownership signal (2026-09-09 investigation): computed offline by
-- scripts/match-ownership.mjs against HM Land Registry's "UK companies that
-- own property in England and Wales" (CCOD) dataset, joined against
-- company_classifications' Companies House match. Not a live join — CCOD is
-- a downloaded monthly CSV, matched in a batch script, same reasoning as
-- lead_quotes' "not stored, computed client-side" comment: this can't be a
-- live query, so it's a plain column re-populated by re-running the script
-- against a newer CCOD file.
--
-- Only ~20% of leads resolve to a confirmed status (see investigation
-- notes) — most commercial postcodes cover a multi-tenant building where
-- CCOD's proprietor can't be tied to the specific occupying business.
-- 'unknown' (the default) means "couldn't confirm either way", not
-- "confirmed to be leased" — never treat it as a negative signal.
alter table prospects add column if not exists ownership_status text
  not null default 'unknown'
  check (ownership_status in ('freehold_confirmed', 'leasehold_confirmed', 'unknown'));

alter table prospects add column if not exists ownership_checked_at timestamptz;
