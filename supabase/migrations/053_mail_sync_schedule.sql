-- Run the mail-sync Edge Function every 10 minutes (2026-10-20).
--
-- RUN THIS ONLY AFTER: 052 is applied, mail-sync is deployed, and its
-- secrets are set (see docs/superpowers/specs/2026-10-20-outlook-email-sync-design.md,
-- "Switching it on"). Before running, store the same random value you set
-- as the MAIL_SYNC_SECRET function secret in Vault, once:
--
--   select vault.create_secret('<the MAIL_SYNC_SECRET value>', 'mail_sync_secret');
--
-- The secret is read from Vault at run time, so it never appears in this
-- file, in cron.job, or in git.
--
-- To pause syncing:   select cron.unschedule('mail-sync');
-- To check it runs:   select * from cron.job_run_details where jobid =
--                       (select jobid from cron.job where jobname = 'mail-sync')
--                     order by start_time desc limit 10;

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('mail-sync')
where exists (select 1 from cron.job where jobname = 'mail-sync');

select cron.schedule(
  'mail-sync',
  '*/10 * * * *',
  $$
  select net.http_post(
    url     := 'https://gkvropheqktytghmiwgp.supabase.co/functions/v1/mail-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sync-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'mail_sync_secret')
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 300000
  );
  $$
);
