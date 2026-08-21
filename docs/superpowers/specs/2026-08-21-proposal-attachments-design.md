# Proposal File Attachments — Design

## Context

`turbine-solar-prospects` already has a CRM layer: `prospect_contacts` (migration `007_prospect_contacts.sql`) logs contact attempts against a prospect with an 8-value outcome enum (`No Answer`, `Follow Up`, `Meeting Booked`, `Survey Booked`, `Quote Sent`, `Converted`, `Not Interested`, `Already Has Solar`), readable only by the admin (`greg@turbineenergyuk.co.uk`) via RLS, insertable by any authenticated rep.

Separately, `C:\Users\GregRoy\turbine-proposals\` is a standalone desktop app (unrelated codebase — Python/tkinter, packaged as a `.exe`) that turns an OpenSolar PDF export into an 8-page branded Turbine Energy proposal PDF, saved locally (e.g. `Football-Club-Proposal.pdf`). The two have never been connected — a proposal generated for a prospect currently has no link back to that prospect's record on the map/CRM.

This design adds the missing link: a rep can attach the PDF a proposal was saved as to the matching prospect, and any authenticated rep (not just the admin) can reopen it later. Verified live end-to-end (log a contact → attach a proposal → progress the outcome to `Converted`) once built — see Testing & verification.

## Goals

- A rep can upload a proposal PDF (generated separately by `turbine-proposals`, saved to their local disk) and attach it to a prospect from the map.
- Any authenticated rep can see what's already attached to a prospect and reopen a file — this is a deliberately *wider* read policy than `prospect_contacts`' admin-only log, since a rep should be able to reopen a proposal they (or a colleague covering the same lead) sent.
- Attaching is a standalone action available on the prospect at any time — not gated behind logging a specific contact outcome.
- Never block or break the existing popup if an upload fails.

## Non-goals

- No change to `prospect_contacts` or its RLS — this is new, separate infrastructure.
- No integration with the `turbine-proposals` desktop app itself (e.g. auto-upload on generate) — the rep manually picks the already-generated PDF file, same as attaching any file. A tighter integration is a plausible future step, not this one.
- No non-PDF attachments (images, docs, etc.) — explicitly out of scope per direction during brainstorming; a general-purpose attachment area is a separate future concern, not this feature.
- No edit/delete UI for an attached proposal — append-only for now, matching `prospect_contacts`' current pattern (a file attached in error stays attached; removing it is a manual DB/Storage operation until there's real demand for a UI).
- No re-design of the `prospect_contacts` outcome pipeline — the "first contact to end result" walkthrough (see Testing & verification) is a live check that the existing stages work end-to-end with a proposal attached, not a request to change the stages themselves.

## Architecture

New Supabase Storage bucket `proposals` (private, not public) holds the PDF bytes. A new table `prospect_proposals` holds the metadata and the link to the prospect — mirroring how `prospect_contacts` is structured, but with its own RLS.

Upload flow (all client-side, no new Edge Function needed — this is a straightforward authenticated Storage write + a metadata insert, unlike Companies House/solar-enrichment which need a server-side secret):
1. Rep picks a `.pdf` file in the popup's new Proposals tab.
2. Frontend uploads it to `proposals/<prospect_id>/<timestamp>-<filename>` via `supabase.storage.from('proposals').upload(...)`.
3. Frontend inserts a `prospect_proposals` row recording the prospect, the storage path, and who uploaded it.
4. Tab re-renders the list to include the new entry.

View flow: clicking "Open" on a listed proposal calls `supabase.storage.from('proposals').createSignedUrl(path, 300)` and opens the result in a new tab. The bucket stays private; the signed URL is short-lived (5 minutes) and only ever generated for a session that already passed the bucket's `authenticated`-only read policy.

## Database changes

New migration `supabase/migrations/014_prospect_proposals.sql`:

```sql
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

-- Any authenticated rep can attach a proposal.
create policy "Authenticated insert"
  on prospect_proposals for insert
  to authenticated
  with check (true);

-- Any authenticated rep can see what's attached — deliberately wider than
-- prospect_contacts' admin-only read, since a rep should be able to reopen
-- a proposal they (or a colleague on the same lead) sent.
create policy "Authenticated read"
  on prospect_proposals for select
  to authenticated
  using (true);
```

Storage bucket + policies (created via Supabase dashboard or `supabase storage` CLI, then policies applied the same way migrations apply SQL — `storage.objects` is a real Postgres table, so these can live in the same migration file):

```sql
insert into storage.buckets (id, name, public)
values ('proposals', 'proposals', false)
on conflict (id) do nothing;

create policy "Authenticated upload to proposals"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'proposals');

create policy "Authenticated read proposals"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'proposals');
```

## Frontend changes (`index.html`)

### Third popup tab: "Proposals"

Added to the existing `.popup-tabs`/`.popup-tab-panel` structure (`buildPopup()`), alongside "Business rates" and "Companies":

```html
<button class="popup-tab" type="button" onclick="switchPopupTab(this, 'proposals')">Proposals</button>
...
<div class="proposals-panel popup-tab-panel" data-panel="proposals" id="proposals-panel-${escapeHtml(d.id)}">
  <div class="proposals-body">Loading…</div>
</div>
```

Loaded lazily on popup open (same fire-and-forget pattern as `loadCompanyMatch()`): a new `loadProposals(d)` queries `prospect_proposals` for that `prospect_id`, ordered newest-first, and renders each row as file name, `uploaded_by`, a relative/short date (reuse `formatMonthYear` or a similar short formatter), and an "Open" link/button wired to the signed-URL flow above.

Below the list: a `<input type="file" accept="application/pdf">` + "Upload" button. Client-side guard rejects anything whose `file.type !== 'application/pdf'` (and/or extension check as a fallback, since `file.type` can be empty for some OS/browser combos) before ever calling Storage. `uploaded_by`/`uploaded_by_email` prefilled from `getUserName(currentUser)`/`currentUser.email`, same as the existing Log Contact modal.

A reasonable client-side max-size guard (e.g. 20 MB — generous for an 8-page branded PDF with embedded images/fonts) blocks an oversized upload before it starts, with a clear inline message.

## Error handling

- Non-PDF selected → blocked before upload starts, inline message in the Proposals tab, rest of the popup unaffected.
- Upload fails (network, Storage error) → inline error in the tab; existing list of already-attached proposals stays intact and unaffected.
- Signed URL generation fails on "Open" → inline error, no broken `window.open` call.
- `prospect_proposals` query fails on tab load → same fallback-link pattern already used elsewhere in this popup (never a dead end) — show a simple "Couldn't load proposals" message with a retry option, rather than leaving the tab blank.

## Testing & verification

No automated test framework in this repo — same live-verification discipline used throughout this project:

1. Upload a real PDF as one authenticated test account; confirm the row + Storage object are created.
2. Open the same prospect as a *different* authenticated account; confirm the file is listed and opens (proves the wider, any-authenticated-rep RLS is genuinely working, not just the UI).
3. Confirm an unauthenticated request against the `proposals` bucket or `prospect_proposals` table is rejected.
4. Confirm a non-PDF file is rejected client-side without ever hitting Storage.
5. **Full pipeline walkthrough (live, on the real site):** log a `No Answer` → `Follow Up` → `Quote Sent` contact against a real prospect, attach a proposal PDF to that same prospect, then log a `Converted` contact — confirming each stage behaves as expected end-to-end with a real attached file in the mix. This is a verification pass over the *existing* pipeline, not a redesign of it.

## Deferred

- Auto-attach from the `turbine-proposals` desktop app directly (e.g. a "send to CRM" button in that app) — plausible future tightening, not needed for reps to get value from this now.
- Edit/delete UI for attached proposals.
- A general-purpose attachment area (images, other docs) — noted during brainstorming as a real future want, but explicitly separate from this PDF-specific feature.
