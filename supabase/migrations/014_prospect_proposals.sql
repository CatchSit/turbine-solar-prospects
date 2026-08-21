create table if not exists prospect_proposals (
  id                 uuid primary key default gen_random_uuid(),
  prospect_id        uuid not null references prospects(id),
  file_name          text not null,
  storage_path       text not null,
  file_size_bytes    bigint,
  uploaded_by        text not null,
  uploaded_by_email  text,
  uploaded_at        timestamptz not null default now()
);

create index if not exists prospect_proposals_prospect_id_idx on prospect_proposals (prospect_id);

alter table prospect_proposals enable row level security;

-- Domain-restricted, not just "authenticated" — this project has public
-- email signup enabled, so `to authenticated` alone is not a real access
-- boundary (same bug class fixed in 004 and 008). uploaded_by_email must
-- match the caller's own JWT email, same as prospect_contacts' insert
-- policy, so a rep can't attach a proposal under someone else's name.
drop policy if exists "Turbine Energy insert" on prospect_proposals;
create policy "Turbine Energy insert"
  on prospect_proposals for insert
  to authenticated
  with check (
    lower(auth.jwt() ->> 'email') like '%@turbineenergyuk.co.uk'
    and uploaded_by_email = auth.jwt() ->> 'email'
  );

-- Any Turbine Energy rep can read — deliberately wider than
-- prospect_contacts' admin-only "Admin read" policy (007/008): a rep
-- should be able to reopen a proposal they, or a colleague on the same
-- lead, sent. New table, new policy — prospect_contacts is untouched.
drop policy if exists "Turbine Energy read" on prospect_proposals;
create policy "Turbine Energy read"
  on prospect_proposals for select
  to authenticated
  using (lower(auth.jwt() ->> 'email') like '%@turbineenergyuk.co.uk');

-- Private bucket for the PDF bytes themselves.
insert into storage.buckets (id, name, public)
values ('proposals', 'proposals', false)
on conflict (id) do nothing;

drop policy if exists "Turbine Energy upload to proposals" on storage.objects;
create policy "Turbine Energy upload to proposals"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'proposals'
    and lower(auth.jwt() ->> 'email') like '%@turbineenergyuk.co.uk'
  );

drop policy if exists "Turbine Energy read proposals" on storage.objects;
create policy "Turbine Energy read proposals"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'proposals'
    and lower(auth.jwt() ->> 'email') like '%@turbineenergyuk.co.uk'
  );
