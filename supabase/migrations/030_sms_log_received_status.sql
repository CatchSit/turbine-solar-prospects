-- sms-inbound logs a customer's STOP reply as message_type='opt_out_received'
-- — that's a message received, not sent, so it belongs under its own
-- 'received' status rather than overloading 'sent' (029 didn't anticipate
-- this when the status check constraint was first written).
alter table sms_log drop constraint if exists sms_log_status_check;
alter table sms_log add constraint sms_log_status_check
  check (status in ('sent', 'failed', 'skipped_opted_out', 'skipped_no_phone', 'received'));
