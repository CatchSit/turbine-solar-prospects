-- lead_documents never had an UPDATE policy — it only ever needed
-- insert/select/delete (014, 036) until 037 switched deletion/restoration
-- to an UPDATE (deleted_at). Without this, that UPDATE was silently
-- blocked by RLS: 0 rows affected, no error, so "Remove" appeared to work
-- (the confirm dialog fired, no error alert) but the document just kept
-- showing in the list, since nothing had actually changed in the
-- database. Same any-rep permission level as delete/insert/read.
drop policy if exists "Turbine Energy update" on lead_documents;
create policy "Turbine Energy update"
  on lead_documents for update to authenticated
  using (lower(auth.jwt() ->> 'email') like '%@turbineenergyuk.co.uk')
  with check (lower(auth.jwt() ->> 'email') like '%@turbineenergyuk.co.uk');
