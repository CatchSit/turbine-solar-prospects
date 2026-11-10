-- Vicky becomes a manager (Greg, 2026-11-10), with the same rights as Greg
-- and Tim across the CRM and the Proposal Generator (full app, not Quick mode).
-- Keep shared/manager-config.js in sync.
insert into managers (email, name) values
  ('vicky@turbineenergyuk.co.uk', 'Vicky')
on conflict (email) do nothing;
