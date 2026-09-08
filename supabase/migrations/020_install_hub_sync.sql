-- Tracks whether a manual lead has been pushed to install-hub (the separate
-- installer-scheduling app/Supabase project) as a customer+job, once a deal
-- is won and moves to "being installed". Written only by the
-- send-to-install-hub Edge Function via the service-role key — no client
-- insert/update policy needed, same as solar_status/solar_checked_at etc.
-- install_hub_job_id doubles as the "already sent" guard (the function
-- refuses to re-send a prospect that already has one, to avoid creating a
-- duplicate job in install-hub).
alter table prospects add column if not exists install_hub_customer_id uuid;
alter table prospects add column if not exists install_hub_job_id uuid;
alter table prospects add column if not exists sent_to_install_hub_at timestamptz;
alter table prospects add column if not exists sent_to_install_hub_by_email text;
