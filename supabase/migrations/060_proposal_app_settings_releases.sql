-- 060: shared settings + auto-update for the Turbine Proposal Generator
-- desktop app (Greg, 2026-10-30, opening the app to the team).
--
-- app_settings  - one row per setting (company details, quote/contract
--                 options). Every Turbine sign-in reads them on start-up,
--                 so the team can't drift; only managers change them.
-- app_releases  - one row per published build. The app compares its own
--                 version with the newest is_current row, downloads the
--                 parts from the private `app-releases` bucket, checks the
--                 sha256 and swaps itself.
--
-- The exe (~58MB) is uploaded in parts of <=40MB so the bucket limit stays
-- under the plan's per-file cap. Secrets (DocuSign private key) are NOT
-- stored here: every Turbine user can read these rows.

create table if not exists app_settings (
  key         text primary key,
  value       text not null default '',
  updated_at  timestamptz not null default now(),
  updated_by  text default (auth.jwt() ->> 'email')
);

create table if not exists app_releases (
  version     text primary key,            -- e.g. '2026.10.30.1'
  created_at  timestamptz not null default now(),
  notes       text not null default '',
  sha256      text not null,                -- of the whole exe
  size_bytes  bigint not null,
  parts       text[] not null,              -- object names in app-releases, in order
  is_current  boolean not null default false
);
create unique index if not exists app_releases_one_current on app_releases (is_current) where is_current;

alter table app_settings enable row level security;
alter table app_releases enable row level security;

create policy "Turbine read" on app_settings for select to authenticated
  using (lower(coalesce(auth.jwt() ->> 'email', '')) like '%@turbineenergyuk.co.uk');
create policy "Manager write" on app_settings for all to authenticated
  using (is_manager()) with check (is_manager());

create policy "Turbine read" on app_releases for select to authenticated
  using (lower(coalesce(auth.jwt() ->> 'email', '')) like '%@turbineenergyuk.co.uk');
create policy "Manager write" on app_releases for all to authenticated
  using (is_manager()) with check (is_manager());

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('app-releases', 'app-releases', false, 41943040, array['application/octet-stream'])
on conflict (id) do nothing;

create policy "app-releases Turbine read" on storage.objects for select to authenticated
  using (bucket_id = 'app-releases'
         and lower(coalesce(auth.jwt() ->> 'email', '')) like '%@turbineenergyuk.co.uk');
create policy "app-releases manager write" on storage.objects for insert to authenticated
  with check (bucket_id = 'app-releases' and is_manager());
create policy "app-releases manager delete" on storage.objects for delete to authenticated
  using (bucket_id = 'app-releases' and is_manager());
