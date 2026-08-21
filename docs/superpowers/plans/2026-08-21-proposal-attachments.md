# Proposal File Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let any authenticated rep attach a proposal PDF (generated separately by the `turbine-proposals` desktop app) to a prospect from the map, and let any authenticated rep reopen it later — a new, standalone "Proposals" popup tab, independent of the existing `prospect_contacts` log.

**Architecture:** A new table `prospect_proposals` (metadata + storage path) plus a new private Supabase Storage bucket `proposals` (the PDF bytes). All client-side — no new Edge Function, since this is a plain authenticated Storage write + a metadata insert, not a call to an external API needing a server-side secret.

**Tech Stack:** Supabase Postgres + Storage (existing project), plain HTML/CSS/JS in `index.html` (existing pattern) — no new dependencies.

## Global Constraints

- **Every new RLS policy — on `prospect_proposals` and on `storage.objects` — MUST include the domain check `lower(auth.jwt() ->> 'email') like '%@turbineenergyuk.co.uk'`, never a bare `to authenticated`.** This Supabase project has public email signup enabled, so `to authenticated` alone is not a real access boundary — this exact bug class has already been fixed three times in this repo (`003_prospects_auth_rls.sql`→`004_prospects_domain_rls.sql`, `007_prospect_contacts.sql`→`008_prospect_contacts_insert_domain_check.sql`, and the `company-lookup` function). This supersedes the simplified `with check (true)`/`using (true)` SQL shown in the approved design spec (`docs/superpowers/specs/2026-08-21-proposal-attachments-design.md`) — that spec predates re-discovering this convention while writing this plan.
- The insert policy must also check `uploaded_by_email = auth.jwt() ->> 'email'`, mirroring `prospect_contacts`' insert policy exactly (`007`/`008`) — prevents a rep spoofing another rep's name on an upload.
- Only `.pdf` accepted client-side, checked by both MIME type (`file.type === 'application/pdf'`) and a filename-extension fallback (`.toLowerCase().endsWith('.pdf')`), since `file.type` can be empty for some OS/browser combinations.
- Max upload size **20 MB**, enforced client-side before any network call.
- The global Supabase client is `window.db` (already initialized at `index.html:612`) — no new client instance.
- No new npm dependency.

---

### Task 1: Database migration + storage bucket

**Files:**
- Create: `supabase/migrations/014_prospect_proposals.sql`

**Interfaces:**
- Produces: `prospect_proposals` table (`id`, `prospect_id`, `file_name`, `storage_path`, `file_size_bytes`, `uploaded_by`, `uploaded_by_email`, `uploaded_at`) and the `proposals` Storage bucket, both readable/writable only by `@turbineenergyuk.co.uk` authenticated sessions. Consumed by Task 2 (reads), Task 3 (writes), Task 4 (signed-URL reads against Storage).

- [ ] **Step 1: Write the migration**

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

-- Domain-restricted, not just "authenticated" — this project has public
-- email signup enabled, so `to authenticated` alone is not a real access
-- boundary (same bug class fixed in 004 and 008). uploaded_by_email must
-- match the caller's own JWT email, same as prospect_contacts' insert
-- policy, so a rep can't attach a proposal under someone else's name.
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
create policy "Turbine Energy read"
  on prospect_proposals for select
  to authenticated
  using (lower(auth.jwt() ->> 'email') like '%@turbineenergyuk.co.uk');

-- Private bucket for the PDF bytes themselves.
insert into storage.buckets (id, name, public)
values ('proposals', 'proposals', false)
on conflict (id) do nothing;

create policy "Turbine Energy upload to proposals"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'proposals'
    and lower(auth.jwt() ->> 'email') like '%@turbineenergyuk.co.uk'
  );

create policy "Turbine Energy read proposals"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'proposals'
    and lower(auth.jwt() ->> 'email') like '%@turbineenergyuk.co.uk'
  );
```

- [ ] **Step 2: Apply it to the linked project**

Run: `supabase db push` from the repo root (same flow used for migrations 009-013 this session — check `supabase migration list` first in case it's already been applied another way).

Expected: no errors. `prospect_proposals` exists with 0 rows; `storage.buckets` has a `proposals` row with `public = false`.

- [ ] **Step 3: Verify the policies actually exist**

Run: `supabase db query --linked "select tablename, policyname, cmd from pg_policies where tablename in ('prospect_proposals','objects') order by tablename, policyname;"`

Expected: 4 rows — `prospect_proposals`'s "Turbine Energy insert"/"Turbine Energy read" and `objects`'s "Turbine Energy upload to proposals"/"Turbine Energy read proposals".

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/014_prospect_proposals.sql
git commit -m "$(cat <<'EOF'
Add prospect_proposals table and proposals Storage bucket

New, standalone attachment feature — separate from prospect_contacts,
with its own wider (any-authenticated-rep) read policy. Domain-checked
per this repo's established RLS convention, not a bare `to
authenticated`, since public email signup is enabled on this project.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Proposals tab — markup and list rendering

**Files:**
- Modify: `index.html` (CSS block near `index.html:257`, `buildPopup()` near `index.html:839-846`, new `loadProposals()` function near `loadCompanyMatch()` at `index.html:884`, marker click handler near `index.html:1065`, new date-formatting helper near `formatMonthYear()`)

**Interfaces:**
- Consumes: `prospect_proposals` table (Task 1); `window.db`; `escapeHtml()` (`shared/escape-html.js`).
- Produces: a third popup tab with panel id `proposals-panel-${d.id}`, and `loadProposals(d)` — called the same way `loadCompanyMatch(d)` already is, right after `marker.bindPopup(...).openPopup()`. Task 3 (upload) calls `loadProposals(d)` again after a successful upload to refresh the list; Task 4 (open) reads the `data-storage-path` attribute this task renders onto each list row.

- [ ] **Step 1: Add the tab button and empty panel to `buildPopup()`**

In `index.html`, change:

```html
      <div class="popup-tabs">
        <button class="popup-tab active" type="button" onclick="switchPopupTab(this, 'rates')">Business rates</button>
        <button class="popup-tab" type="button" onclick="switchPopupTab(this, 'companies')">Companies</button>
      </div>
      <div class="business-rates popup-tab-panel active" data-panel="rates">${businessRatesHtml(d)}</div>
      <div class="company-match popup-tab-panel" data-panel="companies" id="company-match-${escapeHtml(d.id)}">
        <div class="company-match-body">Looking up company registered at this address…</div>
      </div>
```

to:

```html
      <div class="popup-tabs">
        <button class="popup-tab active" type="button" onclick="switchPopupTab(this, 'rates')">Business rates</button>
        <button class="popup-tab" type="button" onclick="switchPopupTab(this, 'companies')">Companies</button>
        <button class="popup-tab" type="button" onclick="switchPopupTab(this, 'proposals')">Proposals</button>
      </div>
      <div class="business-rates popup-tab-panel active" data-panel="rates">${businessRatesHtml(d)}</div>
      <div class="company-match popup-tab-panel" data-panel="companies" id="company-match-${escapeHtml(d.id)}">
        <div class="company-match-body">Looking up company registered at this address…</div>
      </div>
      <div class="proposals-panel popup-tab-panel" data-panel="proposals" id="proposals-panel-${escapeHtml(d.id)}">
        <div class="proposals-list">Loading…</div>
        <div class="proposals-upload">
          <input type="file" accept="application/pdf" class="proposals-file-input" id="proposals-file-${escapeHtml(d.id)}">
          <button type="button" class="proposals-upload-btn" onclick="uploadProposal(${escapeHtml(JSON.stringify(d.id))})">Upload</button>
        </div>
        <div class="proposals-upload-status"></div>
      </div>
```

(`switchPopupTab` already toggles any number of `.popup-tab`/`.popup-tab-panel` pairs generically — no change needed there.)

- [ ] **Step 2: Add CSS**

Near `index.html:257` (after the existing `.popup-tab-panel.active` rule), add:

```css
    .proposals-list { padding: 0 20px; }
    .proposal-item { padding: 8px 0; border-top: 1px solid var(--border); display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
    .proposal-item:first-child { border-top: none; }
    .proposal-name { font-weight: 500; color: var(--text); font-size: 12.5px; }
    .proposal-meta { color: var(--text3); font-size: 11px; margin-top: 1px; }
    .proposal-open-link { color: var(--accent); font-size: 12px; white-space: nowrap; cursor: pointer; }
    .proposals-empty { color: var(--text3); font-size: 12px; padding: 4px 0; }
    .proposals-upload { display: flex; gap: 8px; align-items: center; padding: 10px 20px 0; border-top: 1px solid var(--border); margin-top: 8px; }
    .proposals-file-input { font-size: 11.5px; flex: 1; min-width: 0; }
    .proposals-upload-btn { padding: 5px 12px; background: var(--accentDim); color: var(--accentDk); border: none; border-radius: 6px; font-size: 12px; font-weight: 500; cursor: pointer; font-family: inherit; }
    .proposals-upload-status { padding: 4px 20px 0; font-size: 11.5px; color: var(--text3); }
    .proposals-upload-status.error { color: #c0392b; }
```

- [ ] **Step 3: Add a short date formatter**

Next to `formatMonthYear()`, add:

```js
function formatShortDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
```

- [ ] **Step 4: Write `loadProposals(d)` and its renderer**

Next to `loadCompanyMatch()`:

```js
function proposalsEmptyHtml() {
  return `<div class="proposals-empty">No proposals attached yet.</div>`;
}

function renderProposalsList(rows) {
  if (!rows.length) return proposalsEmptyHtml();
  return rows.map(p => `
    <div class="proposal-item">
      <div>
        <div class="proposal-name">${escapeHtml(p.file_name)}</div>
        <div class="proposal-meta">${escapeHtml(p.uploaded_by)} · ${formatShortDate(p.uploaded_at)}</div>
      </div>
      <span class="proposal-open-link" data-storage-path="${escapeHtml(p.storage_path)}" onclick="openProposal(this)">Open</span>
    </div>`).join('');
}

async function loadProposals(d) {
  const container = document.getElementById(`proposals-panel-${d.id}`);
  if (!container) return;
  const listEl = container.querySelector('.proposals-list');

  const { data, error } = await window.db
    .from('prospect_proposals')
    .select('file_name, storage_path, uploaded_by, uploaded_at')
    .eq('prospect_id', d.id)
    .order('uploaded_at', { ascending: false });

  // The popup may have closed (or a different one opened) while this was in flight.
  const el = document.getElementById(`proposals-panel-${d.id}`);
  if (!el) return;
  const list = el.querySelector('.proposals-list');

  if (error) {
    list.innerHTML = `<div class="proposals-empty">Couldn't load proposals. <span class="proposal-open-link" onclick="loadProposals({id: '${escapeHtml(d.id)}'})">Retry</span></div>`;
    return;
  }
  list.innerHTML = renderProposalsList(data || []);
}
```

- [ ] **Step 5: Call it alongside the existing company lookup**

In the marker click handler (`index.html:1064-1065`), change:

```js
      marker.bindPopup(buildPopup(d), { maxWidth: 360, autoPan: true }).openPopup();
      loadCompanyMatch(d);
```

to:

```js
      marker.bindPopup(buildPopup(d), { maxWidth: 360, autoPan: true }).openPopup();
      loadCompanyMatch(d);
      loadProposals(d);
```

- [ ] **Step 6: Verify against fixture data (no real Supabase auth needed)**

Using the local dev server (`npx serve . -l 5001`) and Playwright's `browser_evaluate`, mock `window.db.from('prospect_proposals')` to return a fixture row (`file_name: 'Test-Proposal.pdf', uploaded_by: 'Tim', uploaded_at: '2026-08-20T10:00:00Z', storage_path: 'abc/1-Test-Proposal.pdf'`), call `loadProposals({ id: 'test-id' })` against a manually-inserted `#proposals-panel-test-id` div in the page, and confirm the rendered HTML contains the file name, "Tim", a formatted date, and an "Open" element carrying the right `data-storage-path`. Also verify the empty-list case renders "No proposals attached yet." and the error case renders the retry link — same mocking technique already used this session for `buildPopup`/`fetchAllProspects`.

- [ ] **Step 7: Commit**

```bash
git add index.html
git commit -m "$(cat <<'EOF'
Add Proposals popup tab with read-only list rendering

Third tab alongside Business rates/Companies. loadProposals() mirrors
loadCompanyMatch()'s fire-and-forget-on-popup-open pattern. Upload
wiring lands in the next commit.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Upload flow

**Files:**
- Modify: `index.html` (new `uploadProposal(prospectId)` function next to `loadProposals()`)

**Interfaces:**
- Consumes: `window.db.storage`, `window.db.from('prospect_proposals')`, `getUserName(currentUser)` / `currentUser.email` (existing, same as the Log Contact modal), `loadProposals(d)` (Task 2, called again on success to refresh the list).
- Produces: nothing new consumed elsewhere — this is the write path.

- [ ] **Step 1: Write `uploadProposal`**

```js
const MAX_PROPOSAL_BYTES = 20 * 1024 * 1024; // 20 MB

function isPdfFile(file) {
  return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
}

async function uploadProposal(prospectId) {
  const panel = document.getElementById(`proposals-panel-${prospectId}`);
  if (!panel) return;
  const fileInput = panel.querySelector('.proposals-file-input');
  const statusEl = panel.querySelector('.proposals-upload-status');
  const file = fileInput.files[0];

  statusEl.classList.remove('error');
  statusEl.textContent = '';

  if (!file) {
    statusEl.textContent = 'Choose a PDF first.';
    statusEl.classList.add('error');
    return;
  }
  if (!isPdfFile(file)) {
    statusEl.textContent = 'Only PDF files are accepted.';
    statusEl.classList.add('error');
    return;
  }
  if (file.size > MAX_PROPOSAL_BYTES) {
    statusEl.textContent = 'File is too large (max 20 MB).';
    statusEl.classList.add('error');
    return;
  }

  statusEl.textContent = 'Uploading…';
  const storagePath = `${prospectId}/${Date.now()}-${file.name}`;

  const { error: uploadError } = await window.db.storage
    .from('proposals')
    .upload(storagePath, file, { contentType: 'application/pdf' });
  if (uploadError) {
    statusEl.textContent = `Upload failed: ${uploadError.message || 'try again'}`;
    statusEl.classList.add('error');
    return;
  }

  const { error: insertError } = await window.db.from('prospect_proposals').insert({
    prospect_id: prospectId,
    file_name: file.name,
    storage_path: storagePath,
    file_size_bytes: file.size,
    uploaded_by: currentUser ? getUserName(currentUser) : 'Unknown',
    uploaded_by_email: currentUser ? currentUser.email : null,
  });
  if (insertError) {
    statusEl.textContent = `Saved file but failed to record it: ${insertError.message || 'try again'}`;
    statusEl.classList.add('error');
    return;
  }

  statusEl.textContent = 'Uploaded.';
  fileInput.value = '';
  loadProposals({ id: prospectId });
}
```

- [ ] **Step 2: Verify against a mocked client**

Via Playwright `browser_evaluate` against the local dev server: mock `window.db.storage.from('proposals').upload` and `window.db.from('prospect_proposals').insert` to resolve successfully, construct a synthetic `File` (`new File(['%PDF-1.4 test'], 'Test.pdf', { type: 'application/pdf' })`), assign it to a real file input via a `DataTransfer`, call `uploadProposal('test-id')`, and confirm: `upload` was called with a path starting `test-id/`, `insert` was called with `file_name: 'Test.pdf'` and `uploaded_by`/`uploaded_by_email` populated, and the status text ends up "Uploaded." Then repeat with a non-PDF `File` and confirm neither `upload` nor `insert` is called and the status shows the "Only PDF files are accepted." error. Then repeat with a `File` larger than 20 MB (fake a large `size` via `Object.defineProperty`) and confirm the same no-network-call behavior with the size error message.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "$(cat <<'EOF'
Wire up proposal PDF upload

Client-side PDF/size validation before any network call, then a
Storage upload followed by a prospect_proposals insert, refreshing
the list on success. Matches the fallback-never-breaks-the-popup
pattern used elsewhere in this file.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Open/view flow

**Files:**
- Modify: `index.html` (new `openProposal(el)` function next to `uploadProposal()`)

**Interfaces:**
- Consumes: `window.db.storage.from('proposals').createSignedUrl` and the `data-storage-path` attribute Task 2 already renders onto each `.proposal-open-link`.
- Produces: nothing consumed elsewhere — terminal action (opens a new tab).

- [ ] **Step 1: Write `openProposal`**

```js
async function openProposal(linkEl) {
  const path = linkEl.dataset.storagePath;
  const originalText = linkEl.textContent;
  linkEl.textContent = 'Opening…';

  const { data, error } = await window.db.storage
    .from('proposals')
    .createSignedUrl(path, 300);

  linkEl.textContent = originalText;
  if (error || !data?.signedUrl) {
    alert("Couldn't open this proposal. Try again in a moment.");
    return;
  }
  window.open(data.signedUrl, '_blank', 'noopener');
}
```

- [ ] **Step 2: Verify against a mocked client**

Via Playwright `browser_evaluate`: mock `window.db.storage.from('proposals').createSignedUrl` to resolve with `{ data: { signedUrl: 'https://example.test/signed' }, error: null }`, stub `window.open` to record its call instead of actually opening a tab, build a `.proposal-open-link` element with `data-storage-path="abc/1-Test.pdf"`, call `openProposal(el)`, and confirm `createSignedUrl` was called with `('abc/1-Test.pdf', 300)` and `window.open` was called with the signed URL. Then mock an error response and confirm `window.open` is *not* called (stub `window.alert` too, to avoid an actual blocking dialog in the automated check).

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "$(cat <<'EOF'
Wire up proposal open via short-lived signed URL

Bucket stays private; a 5-minute signed URL is generated on demand
per click rather than stored or reused.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Live pipeline walkthrough (manual — run by the user, not automatable here)

**Files:** none — verification only, on the real deployed site with a real signed-in session.

- [ ] **Step 1: Confirm RLS is real, not just UI**

Sign in as one authenticated rep account, attach a real PDF to a real prospect. Sign in as a *different* authenticated rep account, open the same prospect, confirm the file is listed and opens. This proves the any-authenticated-rep read policy is genuinely enforced by Postgres, not just the popup hiding a button.

- [ ] **Step 2: Confirm a non-PDF is rejected and a signed-out/wrong-domain request is rejected**

Try uploading a non-PDF file — confirm the inline error and that nothing reaches Storage. If a non-`@turbineenergyuk.co.uk` test account is available, confirm it cannot insert into `prospect_proposals` or read/write the `proposals` bucket (expect an RLS-denial error, not silent success).

- [ ] **Step 3: Full pipeline, first contact to end result**

Against one real prospect, in order: log a `No Answer` contact, log a `Follow Up` contact with a follow-up date, log a `Quote Sent` contact, attach a real proposal PDF to that same prospect via the new Proposals tab, then log a `Converted` contact. Confirm every stage behaves as expected and the attached proposal is still listed and opens correctly throughout — this is a verification pass over the *existing* `prospect_contacts` pipeline with the new attachment feature in the mix, not a change to the pipeline itself.
