-- 071: everyone can upload documents (Greg, 2026-11-17).
--
-- Migration 056 limited every write on a lead to managers and the assigned
-- rep. Uploading documents is now open to anyone signed in with a
-- @turbineenergyuk.co.uk account, on ANY lead (assigned to someone else, or
-- unassigned), both lead-level and inside a quote option.
--
-- Unchanged: removing a document, moving it to another category and every
-- other lead edit still need can_edit_lead() (manager or assigned rep), and
-- restoring deleted documents stays manager-only.

-- Storage paths are "<prospect_id>/<timestamp>-<file>". The upload must point
-- at a real lead; anything else is refused rather than erroring.
create or replace function lead_path_exists(p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return exists (select 1 from prospects where id = split_part(p_name, '/', 1)::uuid);
exception when invalid_text_representation then
  return false;
end;
$$;
grant execute on function lead_path_exists(text) to authenticated;

drop policy if exists "Turbine Energy insert" on lead_documents;
create policy "Turbine Energy insert"
  on lead_documents for insert to authenticated
  with check (
    lower(auth.jwt() ->> 'email') like '%@turbineenergyuk.co.uk'
    and uploaded_by_email = (auth.jwt() ->> 'email')
    and exists (select 1 from prospects p where p.id = prospect_id)
  );

drop policy if exists "Turbine Energy upload to proposals" on storage.objects;
create policy "Turbine Energy upload to proposals"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'proposals'
    and lower(auth.jwt() ->> 'email') like '%@turbineenergyuk.co.uk'
    and lead_path_exists(name)
  );
