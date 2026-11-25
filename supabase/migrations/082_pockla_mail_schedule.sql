-- Run pockla-mail every 10 minutes (2026-11-25). Run LAST: after 081, after
-- the function is deployed, and after its dry run looks right.
-- Uses the same Vault secret as 053 and 066, so nothing new needs storing.
-- To pause it: select cron.unschedule('pockla-mail');

-- Start from this moment, so nothing that came in before switch-on is imported.
update pockla_import_state set synced_through = now() where id = 1 and last_run_at is null;

select cron.unschedule('pockla-mail')
where exists (select 1 from cron.job where jobname = 'pockla-mail');

select cron.schedule(
  'pockla-mail',
  '*/10 * * * *',
  $$
  select net.http_post(
    url     := 'https://gkvropheqktytghmiwgp.supabase.co/functions/v1/pockla-mail',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sync-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'mail_sync_secret')
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
  $$
);
