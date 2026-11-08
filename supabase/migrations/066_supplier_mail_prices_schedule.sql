-- Run the supplier-mail-prices Edge Function every 10 minutes (2026-11-08).
--
-- RUN THIS ONLY AFTER 064 and 065 are applied and supplier-mail-prices is
-- deployed. It reuses mail-sync's secret (vault 'mail_sync_secret', set up
-- for 053), so nothing new needs storing.
--
-- To pause it:      select cron.unschedule('supplier-mail-prices');
-- To check it runs: select * from cron.job_run_details where jobid =
--                     (select jobid from cron.job where jobname = 'supplier-mail-prices')
--                   order by start_time desc limit 10;

select cron.unschedule('supplier-mail-prices')
where exists (select 1 from cron.job where jobname = 'supplier-mail-prices');

select cron.schedule(
  'supplier-mail-prices',
  '*/10 * * * *',
  $$
  select net.http_post(
    url     := 'https://gkvropheqktytghmiwgp.supabase.co/functions/v1/supplier-mail-prices',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sync-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'mail_sync_secret')
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 300000
  );
  $$
);
