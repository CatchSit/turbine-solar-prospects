# VOA Business Rates Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ingest VOA's public non-domestic rating list (rateable value per business property), match it to `prospects` by postcode, and surface each matched hereditament in the popup plus a new rateable-value range filter.

**Architecture:** A new self-contained ingest script (`scripts/ingest-business-rates.mjs`) downloads VOA's current rating-list baseline zip itself (public, unauthenticated — verified directly), extracts only the current-entries CSV (the zip also contains a separate historic-entries file that must NOT be parsed), stream-parses the asterisk-delimited, header-less, positional-field CSV, filters to Yorkshire & Humber and to postcodes that already exist in `prospects`, and upserts into a new `business_rates_matches` table. The frontend embeds this table directly into the existing bulk prospect fetch (no on-demand per-popup call needed, since it's pre-ingested data) and adds a popup section + sidebar range filter.

**Tech Stack:** Node (`csv-parse`, `@supabase/supabase-js` — already dependencies; `unzipper` — new dependency, streaming ZIP extraction, verified working under this project's ESM setup), vanilla JS frontend, one new Postgres migration.

## Global Constraints

- New npm dependency: `unzipper` (`^0.12`) — required because Node has no built-in ZIP archive support, and the extracted current-entries CSV is ~511MB uncompressed (cannot be buffered in memory or extracted to a temp file whole — must stream directly from the zip entry into the CSV parser).
- The VOA zip contains exactly two files: the current entries (large, no "historic" in the filename) and a separate historic entries file (small, filename contains "historic"). The script MUST select only the non-historic file — verified directly against a real downloaded zip, 2026-08-19 (`uk-englandwales-ndr-2026-listentries-compiled-epoch-0003-baseline-csv.csv` = current, `...-baseline-historic-csv.csv` = historic).
- Field positions are fixed/positional (no header row) — confirmed against VOA's own published spec AND real downloaded rows, field-by-field, 2026-08-19: index 1 (0-based) = Billing Authority Code, index 5 = Primary Description Text, index 14 = Postcode, index 17 = Rateable Value. Do not guess different indices without re-verifying against a real row.
- No `.env` file exists in this project — `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` are passed as inline env vars per the existing `ingest`/`geocode`/`ingest-recommendations` script convention.
- Apply the lesson from the EPC recommendations final review proactively: prefilter to postcodes that already exist in `prospects` BEFORE building any match/upsert data — never let a ~2-million-row national file generate work proportional to its own size rather than the ~21,800-prospect pilot.
- `.gitignore`'s existing `data/*.zip` line has the same `data/**/*.csv`-vs-`data/*.csv` gap already fixed once this project (a bare `*` doesn't cross a `/` boundary) — the new download path is `data/business-rates/baseline.zip`, a subdirectory, so this must be fixed to `data/**/*.zip` as part of this work, not left to repeat the same mistake a third time.
- Rateable value is a real, sourced, government-published figure (not an estimate) — does not conflict with this project's "no invented £ figures" rule, but must carry the same "proxy/valuation-snapshot, not a live measurement" caveat already used for EPC data.

---

### Task 1: `scripts/ingest-business-rates.mjs` + migration

**Files:**
- Create: `supabase/migrations/010_business_rates.sql`
- Create: `scripts/ingest-business-rates.mjs`
- Create: `data/business-rates/` (directory only comes into being when the script runs — no file to create ahead of time)
- Modify: `package.json` (new dependency + npm script)
- Modify: `.gitignore` (fix the `data/*.zip` gap)
- Modify: `data/README.md` (document the new subdirectory, matching the existing note about `data/recommendations/`)

**Interfaces:**
- Produces: `business_rates_matches` table — `prospect_id` (PK/FK → `prospects.id`), `hereditaments` (jsonb array of `{ description, rateable_value, billing_authority_code }`), `no_match` (boolean), `fetched_at` (timestamptz) — consumed by Task 2's frontend embedded-select query.

- [ ] **Step 1: Write and apply the migration**

Create `supabase/migrations/010_business_rates.sql`:
```sql
create table if not exists business_rates_matches (
  prospect_id uuid primary key references prospects(id) on delete cascade,
  hereditaments jsonb not null default '[]'::jsonb,
  -- hereditaments: [{ description, rateable_value, billing_authority_code }]
  no_match boolean not null default false,
  fetched_at timestamptz not null default now()
);

alter table business_rates_matches enable row level security;
-- No policies — service-role only, same pattern as company_lookups/api_usage.
```

Apply it directly against the linked project (this project's migrations are applied by hand, not via `supabase db push` — see `HANDOVER.md` "How to apply migrations". `supabase db query` does NOT accept a `--project-ref` flag — `--linked` alone is sufficient, verified 2026-08-19):
```bash
npx supabase db query --linked -f supabase/migrations/010_business_rates.sql
```

Verify:
```bash
npx supabase db query --linked "select column_name, data_type from information_schema.columns where table_name = 'business_rates_matches' order by ordinal_position;"
```
Expected: `prospect_id` (uuid), `hereditaments` (jsonb), `no_match` (boolean), `fetched_at` (timestamp with time zone).

- [ ] **Step 2: Add the new dependency and npm script**

First declare the dependency and script in `package.json` (do this BEFORE running `npm install`, since `npm install <pkg>` would otherwise auto-edit the file first and make this exact Find block not match anymore). In `package.json`, find:
```json
  "scripts": {
    "ingest": "node scripts/ingest-epc.mjs",
    "geocode": "node scripts/geocode-postcodes.mjs",
    "ingest-recommendations": "node scripts/ingest-epc-recommendations.mjs"
  },
  "dependencies": {
    "@supabase/supabase-js": "^2",
    "csv-parse": "^5"
  }
```
Replace with:
```json
  "scripts": {
    "ingest": "node scripts/ingest-epc.mjs",
    "geocode": "node scripts/geocode-postcodes.mjs",
    "ingest-recommendations": "node scripts/ingest-epc-recommendations.mjs",
    "ingest-business-rates": "node scripts/ingest-business-rates.mjs"
  },
  "dependencies": {
    "@supabase/supabase-js": "^2",
    "csv-parse": "^5",
    "unzipper": "^0.12"
  }
```

Then install it (this reads the version you just declared and updates `node_modules`/`package-lock.json` to match — it should NOT rewrite the `^0.12` you just wrote in `package.json`, since a satisfying version is already declared):
```bash
npm install
```
Confirm afterward that `package.json`'s `unzipper` line still reads `^0.12` (not rewritten to something else) and that `node_modules/unzipper` now exists.

- [ ] **Step 3: Fix `.gitignore` and document the new data subdirectory**

Find:
```
data/**/*.csv
data/*.zip
```
Replace with:
```
data/**/*.csv
data/**/*.zip
```

In `data/README.md`, find:
```
`data/recommendations/` holds the separate "recommendations" bulk CSV export(s), used
by `scripts/ingest-epc-recommendations.mjs` (optional/additive — see HANDOVER.md
Section 4). Also gitignored (`data/**/*.csv` in `.gitignore` covers this subdirectory).
```
Replace with:
```
`data/recommendations/` holds the separate "recommendations" bulk CSV export(s), used
by `scripts/ingest-epc-recommendations.mjs` (optional/additive — see HANDOVER.md
Section 4). Also gitignored (`data/**/*.csv` in `.gitignore` covers this subdirectory).

`data/business-rates/` holds the VOA rating-list baseline zip downloaded automatically
by `scripts/ingest-business-rates.mjs` — unlike the EPC sources, this one requires no
manual download step. Gitignored via `data/**/*.zip`.
```

- [ ] **Step 4: Write the ingest script**

Create `scripts/ingest-business-rates.mjs`:
```js
#!/usr/bin/env node
// Ingest the VOA (Valuation Office Agency) non-domestic rating list —
// unlike the EPC/Companies House sources, this is a real, public,
// unauthenticated bulk download; this script fetches it itself.
//
// Source: https://voaratinglists.blob.core.windows.net/ (confirmed public,
// no login/API key needed — verified 2026-08-19 via direct curl).
// Field layout confirmed against VOA's own published spec AND real rows
// (asterisk-delimited, no header row, positional fields) — see
// docs/superpowers/specs/2026-08-19-voa-business-rates-design.md.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/ingest-business-rates.mjs

import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { parse } from 'csv-parse';
import unzipper from 'unzipper';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL              = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env vars');
}
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ─── Tunables ──────────────────────────────────────────────────────────────

// Current rating list, compiled 1 April 2026. The next list compiles
// 1 April 2029 — update this then (VOA's own spec, "Background" section).
const LIST_YEAR = '2026';

const DATA_DIR = 'data/business-rates';
const ZIP_PATH = `${DATA_DIR}/baseline.zip`;

const YORKSHIRE_HUMBER_OUTCODES = new Set(['BD', 'DN', 'HD', 'HG', 'HU', 'HX', 'LS', 'S', 'WF', 'YO']);
function postcodeOutcodeArea(postcode) {
  const m = String(postcode || '').trim().toUpperCase().match(/^([A-Z]{1,2})\d/);
  return m ? m[1] : '';
}

// Field positions (0-indexed) — confirmed against VOA's own published spec
// AND real downloaded rows, 2026-08-19. See the design doc for the full
// 28-field layout; only these four are needed here.
const FIELD = {
  BILLING_AUTHORITY_CODE: 1,
  DESCRIPTION_TEXT: 5,
  POSTCODE: 14,
  RATEABLE_VALUE: 17,
};

// ─── Step 1: discover the current baseline zip URL ────────────────────────

async function discoverBaselineUrl() {
  const resp = await fetch('https://voaratinglists.blob.core.windows.net/downloads?restype=container&comp=list');
  if (!resp.ok) throw new Error(`VOA blob listing failed: ${resp.status}`);
  const xml = await resp.text();

  const pattern = new RegExp(
    `<Name>(uk-englandwales-ndr-${LIST_YEAR}-listentries-compiled-epoch-(\\d+)-baseline-csv\\.zip)</Name>`,
    'g',
  );
  let match, best = null;
  while ((match = pattern.exec(xml))) {
    const [, name, epochStr] = match;
    const epoch = parseInt(epochStr, 10);
    if (!best || epoch > best.epoch) best = { name, epoch };
  }
  if (!best) throw new Error(`No baseline zip found for list year ${LIST_YEAR} in VOA blob listing.`);
  return `https://voaratinglists.blob.core.windows.net/downloads/${best.name}`;
}

// ─── Step 2: download it ───────────────────────────────────────────────────

async function downloadZip(url) {
  mkdirSync(DATA_DIR, { recursive: true });
  console.log(`Downloading ${url} ...`);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
  await pipeline(resp.body, createWriteStream(ZIP_PATH));
  console.log(`Saved to ${ZIP_PATH}`);
}

// ─── Step 3: find the current-entries file inside the zip (NOT historic) ──

async function openCurrentEntriesStream() {
  const directory = await unzipper.Open.file(ZIP_PATH);
  const entry = directory.files.find(f => f.path.endsWith('.csv') && !f.path.includes('historic'));
  if (!entry) {
    throw new Error(
      `Could not find the current-entries CSV inside ${ZIP_PATH} (files found: ${directory.files.map(f => f.path).join(', ')}). ` +
      `VOA's zip naming convention may have changed — update the selection logic above.`
    );
  }
  console.log(`Using ${entry.path} (skipping any "historic" file in the same archive)`);
  return entry.stream();
}

// ─── Step 4: fetch existing prospect postcodes (prefilter before matching) ─

async function fetchExistingPostcodes() {
  const postcodes = new Map(); // normalized postcode -> Set<prospect id>
  const PAGE = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await db.from('prospects').select('id, postcode').range(from, from + PAGE - 1);
    if (error) throw new Error(JSON.stringify(error));
    for (const row of data) {
      if (!row.postcode) continue;
      const norm = row.postcode.trim().toUpperCase().replace(/\s+/g, '');
      if (!postcodes.has(norm)) postcodes.set(norm, new Set());
      postcodes.get(norm).add(row.id);
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return postcodes;
}

// ─── Step 5: stream-parse, filter, group by postcode ───────────────────────

async function collectHereditamentsByPostcode(stream, existingPostcodes) {
  const byPostcode = new Map(); // normalized postcode -> hereditament[]
  let rawCount = 0, yhCount = 0, matchedCount = 0;

  const parser = stream.pipe(parse({ delimiter: '*', relax_column_count: true, bom: true }));
  for await (const row of parser) {
    rawCount++;
    const postcode = String(row[FIELD.POSTCODE] || '').trim();
    if (!postcode) continue;
    const outcode = postcodeOutcodeArea(postcode);
    if (!YORKSHIRE_HUMBER_OUTCODES.has(outcode)) continue;
    yhCount++;

    const norm = postcode.toUpperCase().replace(/\s+/g, '');
    if (!existingPostcodes.has(norm)) continue;
    matchedCount++;

    const rateableValue = parseInt(row[FIELD.RATEABLE_VALUE], 10);
    if (!Number.isFinite(rateableValue)) continue;

    const hereditament = {
      description: String(row[FIELD.DESCRIPTION_TEXT] || '').trim(),
      rateable_value: rateableValue,
      billing_authority_code: String(row[FIELD.BILLING_AUTHORITY_CODE] || '').trim(),
    };
    if (!byPostcode.has(norm)) byPostcode.set(norm, []);
    byPostcode.get(norm).push(hereditament);
  }

  console.log(`Raw rows: ${rawCount}`);
  console.log(`Yorkshire & Humber rows (by postcode outcode): ${yhCount}`);
  console.log(`Matched to an existing prospect postcode: ${matchedCount}`);
  return byPostcode;
}

// ─── Step 6: upsert into business_rates_matches ────────────────────────────

async function upsertMatches(byPostcode, existingPostcodes) {
  const rows = [];
  for (const [norm, prospectIds] of existingPostcodes) {
    const hereditaments = byPostcode.get(norm) || [];
    for (const prospectId of prospectIds) {
      rows.push({
        prospect_id: prospectId,
        hereditaments,
        no_match: hereditaments.length === 0,
      });
    }
  }

  const CHUNK = 500; // upsert body, not a URL filter — safe at this size (mirrors ingest-epc.mjs)
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error } = await db.from('business_rates_matches').upsert(chunk, { onConflict: 'prospect_id' });
    if (error) throw new Error(`Upsert failed at row ${i}: ${JSON.stringify(error)}`);
    console.log(`  upserted ${Math.min(i + CHUNK, rows.length)}/${rows.length}`);
  }

  const matchedProspects = rows.filter(r => !r.no_match).length;
  console.log(`Prospects with at least one hereditament match: ${matchedProspects}/${rows.length}`);
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  if (!existsSync(ZIP_PATH)) {
    const url = await discoverBaselineUrl();
    await downloadZip(url);
  } else {
    console.log(`Using existing download at ${ZIP_PATH} (delete it to force a re-download of the latest epoch)`);
  }

  const stream = await openCurrentEntriesStream();
  const existingPostcodes = await fetchExistingPostcodes();
  console.log(`Distinct prospect postcodes: ${existingPostcodes.size}`);

  const byPostcode = await collectHereditamentsByPostcode(stream, existingPostcodes);
  await upsertMatches(byPostcode, existingPostcodes);
  console.log('Done.');
}

main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 5: Verify with a real (small) end-to-end run**

This script genuinely downloads a real ~93MB file and streams a ~511MB extracted CSV — running it for real is itself the verification, not a synthetic substitute (unlike the EPC recommendations script, there's no manual-download gate blocking a real test here). Run it for real:
```bash
SUPABASE_URL=<url> SUPABASE_SERVICE_ROLE_KEY=<key> node scripts/ingest-business-rates.mjs
```
Expected console output: a "Downloading..." line, "Using ...-baseline-csv.csv (skipping any 'historic' file...)", raw/Yorkshire-Humber/matched row counts (matched count should be in the same order of magnitude as the ~21,800 prospect count, not the ~2,000,000 national row count — if it's close to 2 million, the prefilter in Step 5 of the script has a bug), and a final "Prospects with at least one hereditament match: X/Y" line.

Verify the DB state directly:
```bash
npx supabase db query --linked "select count(*) as total, count(*) filter (where no_match = false) as matched from business_rates_matches;"
```

Spot-check 2-3 real matched rows against VOA's own public live lookup (search "VOA find a business rates valuation" or similar, using the prospect's postcode) to confirm the rateable value and description are plausible and correctly attributed — this is real production data, not a synthetic fixture, so this spot-check is the actual verification the design spec's "Testing & verification" section calls for.
```bash
npx supabase db query --linked "select p.address, p.postcode, b.hereditaments from prospects p join business_rates_matches b on b.prospect_id = p.id where b.no_match = false limit 3;"
```

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/010_business_rates.sql scripts/ingest-business-rates.mjs package.json package-lock.json .gitignore data/README.md
git commit -m "Add VOA business rates ingest pipeline"
```

---

### Task 2: Frontend — popup section + rateable value filter

**Files:**
- Modify: `index.html`

**Interfaces:**
- Consumes: `business_rates_matches` rows embedded via Supabase's foreign-table select (Task 1) — each prospect object gains a `business_rates_matches` property, either `null` (no row exists yet) or `{ hereditaments: [...], no_match: boolean }` (Supabase returns embedded single-row relationships as an object, not an array, when the FK is `unique`/primary-key — `business_rates_matches.prospect_id` is the primary key, so this is a one-to-one embed).

- [ ] **Step 1: Embed the table in the data fetch**

Find (in `fetchAllProspects()`):
```js
      .select('id, address, postcode, lat, lng, property_type, floor_area:total_floor_area, epc_rating:current_energy_rating, local_authority, solar_status, solar_max_panels, solar_yearly_energy_kwh, current_energy_efficiency, epc_recommends_solar, epc_recommends_efficiency')
```
Replace with:
```js
      .select('id, address, postcode, lat, lng, property_type, floor_area:total_floor_area, epc_rating:current_energy_rating, local_authority, solar_status, solar_max_panels, solar_yearly_energy_kwh, current_energy_efficiency, epc_recommends_solar, epc_recommends_efficiency, business_rates_matches(hereditaments, no_match)')
```

- [ ] **Step 2: Add a helper for the filter's "any hereditament in range" logic**

Find:
```js
/* ── Filter logic ────────────────────────────────────────── */
function applyFilters() {
```
Replace with:
```js
function maxHereditamentValue(d) {
  const hereditaments = d.business_rates_matches?.hereditaments;
  if (!hereditaments || !hereditaments.length) return null;
  return Math.max(...hereditaments.map(h => h.rateable_value));
}

/* ── Filter logic ────────────────────────────────────────── */
function applyFilters() {
```
Note: this returns the single highest hereditament value at that prospect's postcode, used only for the min/max range filter (Step 5 below) — the popup itself (Step 3) lists every hereditament individually, not just the max.

- [ ] **Step 3: Add the popup section**

Find:
```js
      <div class="popup-facts">${addr}${area}${type}${la}</div>
      <div class="company-match" id="company-match-${escapeHtml(d.id)}">
```
Replace with:
```js
      <div class="popup-facts">${addr}${area}${type}${la}</div>
      ${businessRatesHtml(d)}
      <div class="company-match" id="company-match-${escapeHtml(d.id)}">
```

Then find:
```js
/* ── Popup builder ───────────────────────────────────────── */
function buildPopup(d) {
```
Replace with:
```js
/* ── Popup builder ───────────────────────────────────────── */
function businessRatesHtml(d) {
  const hereditaments = d.business_rates_matches?.hereditaments;
  if (!hereditaments || !hereditaments.length) return '';
  const rows = hereditaments.map(h =>
    `<div>${escapeHtml(h.description || 'Unspecified')} — £${h.rateable_value.toLocaleString()}</div>`
  ).join('');
  return `
      <div class="business-rates">
        <div class="popup-section-label">Business rates</div>
        ${rows}
      </div>`;
}
function buildPopup(d) {
```

- [ ] **Step 4: Add CSS for the new section**

Find:
```css
    .company-psc { margin-top: 4px; color: var(--text2); }
```
Replace with:
```css
    .company-psc { margin-top: 4px; color: var(--text2); }
    .business-rates { margin: 4px 0 10px; padding: 0 20px; font-size: 12px; color: var(--text2); }
```

- [ ] **Step 5: Add the sidebar filter**

Find:
```html
  <div class="section">
    <h3>Floor area (m²)</h3>
    <div class="range-row">
      <input id="floor-min" type="number" min="0" step="100" placeholder="Min"/>
      <span>–</span>
      <input id="floor-max" type="number" min="0" step="100" placeholder="Max"/>
    </div>
    <div class="range-hint">Proxy for electricity usage — see note below.</div>
  </div>
```
Replace with:
```html
  <div class="section">
    <h3>Floor area (m²)</h3>
    <div class="range-row">
      <input id="floor-min" type="number" min="0" step="100" placeholder="Min"/>
      <span>–</span>
      <input id="floor-max" type="number" min="0" step="100" placeholder="Max"/>
    </div>
    <div class="range-hint">Proxy for electricity usage — see note below.</div>
  </div>

  <div class="section">
    <h3>Rateable value (£)</h3>
    <div class="range-row">
      <input id="rateable-min" type="number" min="0" step="1000" placeholder="Min"/>
      <span>–</span>
      <input id="rateable-max" type="number" min="0" step="1000" placeholder="Max"/>
    </div>
    <div class="range-hint">VOA valuation snapshot — see note below.</div>
  </div>
```

- [ ] **Step 6: Wire up filter state and logic**

Find:
```js
let searchTerm = "";
let floorMin = null;
let floorMax = null;
```
Replace with:
```js
let searchTerm = "";
let floorMin = null;
let floorMax = null;
let rateableMin = null;
let rateableMax = null;
```

Find:
```js
    const minOk    = floorMin == null || (d.floor_area != null && d.floor_area >= floorMin);
    const maxOk    = floorMax == null || (d.floor_area != null && d.floor_area <= floorMax);

    if (typeOk && ratingOk && statusOk && epcSolarOk && epcEfficiencyOk && searchOk && minOk && maxOk) {
```
Replace with:
```js
    const minOk    = floorMin == null || (d.floor_area != null && d.floor_area >= floorMin);
    const maxOk    = floorMax == null || (d.floor_area != null && d.floor_area <= floorMax);
    const rateableValue = maxHereditamentValue(d);
    const rateableMinOk = rateableMin == null || (rateableValue != null && rateableValue >= rateableMin);
    const rateableMaxOk = rateableMax == null || (rateableValue != null && rateableValue <= rateableMax);

    if (typeOk && ratingOk && statusOk && epcSolarOk && epcEfficiencyOk && searchOk && minOk && maxOk && rateableMinOk && rateableMaxOk) {
```

Find:
```js
document.getElementById("floor-min").addEventListener("input", e => { floorMin = e.target.value === '' ? null : Number(e.target.value); applyFilters(); });
document.getElementById("floor-max").addEventListener("input", e => { floorMax = e.target.value === '' ? null : Number(e.target.value); applyFilters(); });
```
Replace with:
```js
document.getElementById("floor-min").addEventListener("input", e => { floorMin = e.target.value === '' ? null : Number(e.target.value); applyFilters(); });
document.getElementById("floor-max").addEventListener("input", e => { floorMax = e.target.value === '' ? null : Number(e.target.value); applyFilters(); });
document.getElementById("rateable-min").addEventListener("input", e => { rateableMin = e.target.value === '' ? null : Number(e.target.value); applyFilters(); });
document.getElementById("rateable-max").addEventListener("input", e => { rateableMax = e.target.value === '' ? null : Number(e.target.value); applyFilters(); });
```

- [ ] **Step 7: Include the new filter in "Reset filters"**

Find:
```js
  searchTerm = ""; floorMin = null; floorMax = null;
  document.getElementById("search").value = "";
  document.getElementById("floor-min").value = "";
  document.getElementById("floor-max").value = "";
```
Replace with:
```js
  searchTerm = ""; floorMin = null; floorMax = null; rateableMin = null; rateableMax = null;
  document.getElementById("search").value = "";
  document.getElementById("floor-min").value = "";
  document.getElementById("floor-max").value = "";
  document.getElementById("rateable-min").value = "";
  document.getElementById("rateable-max").value = "";
```

- [ ] **Step 8: Add the footer caveat**

Find:
```html
      EPC recommendation badges only appear where the assessor's recommendation report
      has been ingested — their absence doesn't mean solar wasn't recommended, just that
      this data hasn't been checked yet.
    </div>
```
Replace with:
```html
      EPC recommendation badges only appear where the assessor's recommendation report
      has been ingested — their absence doesn't mean solar wasn't recommended, just that
      this data hasn't been checked yet.
      Rateable value is a VOA valuation as of its antecedent valuation date (normally
      around two years before the current list's 1 April 2026 compile date), not a
      live or current-market figure.
    </div>
```

- [ ] **Step 9: Live-test in the browser**

Using the real matched prospects from Task 1 Step 5's live run (query `select prospect_id from business_rates_matches where no_match = false limit 3;` if you need fresh IDs), serve the site locally, sign in (throwaway test account, same pattern as prior sub-projects), and confirm:
- A matched prospect's popup shows a "Business rates" section listing each hereditament with a formatted `£` value.
- A prospect with multiple hereditaments at the same postcode shows all of them, not just one.
- An unmatched prospect (`no_match = true` or entirely absent from `business_rates_matches`) shows no "Business rates" section at all — no empty box.
- Setting "Rateable value (£)" min/max narrows the map correctly; a prospect with one hereditament at £45,000 and another at £8,000 should pass a filter of min=£40,000 (since the filter checks the maximum, not every hereditament).
- "Reset filters" clears both new inputs.

- [ ] **Step 10: Commit**

```bash
git add index.html
git commit -m "Add business rates popup section and rateable value filter"
```

---

## Self-review notes

- Spec coverage: automatic download (Task 1), current-vs-historic file selection (Task 1, explicitly tested), postcode prefiltering (Task 1, applying the EPC recommendations lesson proactively), per-hereditament popup display (Task 2), range filter using max-hereditament semantics (Task 2), valuation-snapshot caveat copy (Task 2) — all covered.
- No placeholders: all code is complete and real, verified against actual VOA data and a real local zip-selection test (not just written from documentation).
- Type/naming consistency: `hereditaments`/`rateable_value`/`description`/`billing_authority_code` used identically across the migration, ingest script, and frontend render/filter code.
- Real end-to-end verification is possible for this sub-project in a way it wasn't for EPC recommendations (no human-gated download blocking a real test) — Task 1 Step 5 runs the actual pipeline against real production data, not a synthetic fixture.
