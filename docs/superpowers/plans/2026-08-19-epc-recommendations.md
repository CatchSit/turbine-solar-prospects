# EPC Recommendations Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect, per prospect, whether its EPC assessment explicitly recommended solar (PV or water heating) or efficiency measures (insulation/heating controls), store it as two flags on `prospects`, and surface them as popup badges + sidebar filter toggles.

**Architecture:** A new ingestion script (`scripts/ingest-epc-recommendations.mjs`), mirroring the existing `scripts/ingest-epc.mjs`'s CSV-parsing/defensive-column-mapping shape, reads a separately-downloaded EPC "recommendations" CSV, classifies each row's improvement text via keyword matching, and bulk-updates two new boolean columns on `prospects` (matched by the existing `epc_lmk_key`). The frontend adds two badges to the popup and two toggle filters to the sidebar, following the existing `shared/*-config.js` + chip patterns already used for solar status and EPC rating.

**Tech Stack:** Node (`csv-parse`, `@supabase/supabase-js` — both already project dependencies), vanilla JS frontend, one new Postgres migration.

## Global Constraints

- No new npm dependency — `csv-parse` and `@supabase/supabase-js` are already in `package.json`.
- Only `LMK_KEY` and `IMPROVEMENT_SUMMARY_TEXT` are confirmed-real column names in the recommendations CSV (verified against public GOV.UK guidance text, 2026-08-19). The ingest script's column resolution must be defensive (candidate-list + fail-loudly-with-real-headers) and must never assume an unconfirmed column name is correct.
- Classification is keyword-matching on `IMPROVEMENT_SUMMARY_TEXT` text, not on any numeric `IMPROVEMENT_ID` code (not confirmed real/stable).
- The classifier must never match on the bare word "solar" alone — "Solar gain limit exceeded" is a real, different-meaning recommendation type (excess heat gain warning) and must NOT set `epc_recommends_solar`.
- LED lighting recommendations are explicitly out of scope — do not add a pattern for them.
- `epc_recommends_solar` / `epc_recommends_efficiency` must default to `null` (unknown), never `false`, for a prospect whose `LMK_KEY` has no matching recommendation data at all. Only prospects actually present in a real recommendations file get an explicit `true`/`false`.
- No real recommendations CSV has been downloaded yet (human-gated GOV.UK One Login download, same as certificates — see HANDOVER.md Section 4). Task 1's own verification must therefore use a synthetic test CSV built from the best-guess real column names and a handful of real `epc_lmk_key` values already in the live `prospects` table — this is not a substitute for the real-file verification called for in the design spec's "Testing & verification" section, which happens later once Greg actually downloads a real file.

---

### Task 1: Migration + `scripts/ingest-epc-recommendations.mjs`

**Files:**
- Create: `supabase/migrations/009_epc_recommendations.sql`
- Create: `scripts/ingest-epc-recommendations.mjs`

**Interfaces:**
- Produces: two new nullable boolean columns on `prospects` — `epc_recommends_solar`, `epc_recommends_efficiency` — consumed by Task 2's frontend `select()` query and rendering.
- Produces: `npm run ingest-recommendations` script entry in `package.json` (matches the existing `ingest`/`geocode` script pattern).

- [ ] **Step 1: Write and apply the migration**

Create `supabase/migrations/009_epc_recommendations.sql`:
```sql
alter table prospects
  add column if not exists epc_recommends_solar boolean,
  add column if not exists epc_recommends_efficiency boolean;
```

Apply it directly against the linked project (this project's migrations are applied by hand, not via `supabase db push` — `db push` would try to replay migrations 001-008 which were never tracked in local migration history and are not all idempotent; see HANDOVER.md "How to apply migrations"). `db query` does NOT accept a `--project-ref` flag (verified 2026-08-19 — passing one errors with "Unrecognized flag"); `--linked` alone targets whichever project this repo is already linked to (`gkvropheqktytghmiwgp`), which is sufficient and confirmed working:
```bash
npx supabase db query --linked -f supabase/migrations/009_epc_recommendations.sql
```

Verify:
```bash
npx supabase db query --linked "select column_name, data_type from information_schema.columns where table_name = 'prospects' and column_name like 'epc_recommends%';"
```
Expected: two rows, both `data_type = boolean`.

- [ ] **Step 2: Write the ingest script**

Create `scripts/ingest-epc-recommendations.mjs`:
```js
#!/usr/bin/env node
// Ingest non-domestic EPC "recommendations" bulk CSV export(s) and flag
// prospects whose EPC assessment recommended solar or efficiency measures.
//
// Source: https://get-energy-performance-data.communities.gov.uk/
// (same GOV.UK One Login-gated bulk download as certificates, but the
// separate "recommendations" file per year — see HANDOVER.md).
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/ingest-epc-recommendations.mjs [csv-files...]
// If no files are given, every *.csv under data/recommendations/ is used.
//
// IMPORTANT: only LMK_KEY and IMPROVEMENT_SUMMARY_TEXT are confirmed real
// column names (verified against public GOV.UK guidance text, 2026-08-19).
// This script fails loudly, listing the actual headers found, if it can't
// match the columns it needs — check against a real downloaded file before
// trusting a silent success, same discipline as scripts/ingest-epc.mjs.

import { createReadStream, readdirSync, existsSync } from 'node:fs';
import { parse } from 'csv-parse';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL              = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env vars');
}
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ─── Column mapping (defensive — see header note above) ──────────────────

const COLUMN_CANDIDATES = {
  lmk_key:             ['LMK_KEY', 'lmk-key', 'certificate_number'],
  improvement_summary: ['IMPROVEMENT_SUMMARY_TEXT', 'improvement-summary-text', 'IMPROVEMENT_SUMMARY'],
};

function normalizeHeader(h) {
  return String(h).trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function buildColumnResolver(headers) {
  const normalized = new Map(headers.map(h => [normalizeHeader(h), h]));
  const resolved = {};
  const missing = [];
  for (const [key, candidates] of Object.entries(COLUMN_CANDIDATES)) {
    const hit = candidates.map(normalizeHeader).map(c => normalized.get(c)).find(Boolean);
    if (hit) resolved[key] = hit;
    else missing.push(key);
  }
  if (missing.length) {
    throw new Error(
      `ingest-epc-recommendations.mjs: could not find columns for [${missing.join(', ')}] in CSV header.\n` +
      `Actual headers found: ${headers.join(', ')}\n` +
      `Update COLUMN_CANDIDATES in this script to match the real export.`
    );
  }
  return resolved;
}

// ─── Classification ─────────────────────────────────────────────────────
// "Solar gain limit exceeded" is a real, different-meaning recommendation
// (excess unshaded-glazing heat gain warning) — the patterns below require
// "solar" alongside "photovoltaic"/"water heating"/"pv", never bare "solar".

const SOLAR_PATTERNS = [/solar\s+photovoltaic/i, /solar\s+water\s+heating/i, /\bsolar\s+pv\b/i];
const EFFICIENCY_PATTERNS = [
  /loft\s+insulation/i, /cavity\s+wall\s+insulation/i,
  /optimum\s+start\s*\/?\s*stop/i, /weather\s+compensation/i,
];

function classify(summaryText) {
  const text = String(summaryText || '');
  return {
    solar: SOLAR_PATTERNS.some(p => p.test(text)),
    efficiency: EFFICIENCY_PATTERNS.some(p => p.test(text)),
  };
}

// ─── CSV parsing ────────────────────────────────────────────────────────

async function parseCsvFile(filePath, onRow) {
  const stream = createReadStream(filePath).pipe(parse({ columns: true, bom: true, relax_quotes: true }));
  let col = null;
  for await (const row of stream) {
    if (!col) col = buildColumnResolver(Object.keys(row));
    onRow(row, col);
  }
}

// ─── Supabase update (grouped by exact flag combination — at most 4
// combinations exist, so this is 4 bulk `.in()` updates total per chunk
// rather than one HTTP request per building) ───────────────────────────

async function applyFlags(flagsByKey) {
  const groups = new Map(); // "true|false" -> [lmk_key, ...]
  for (const [lmkKey, f] of flagsByKey) {
    const comboKey = `${f.solar}|${f.efficiency}`;
    if (!groups.has(comboKey)) groups.set(comboKey, []);
    groups.get(comboKey).push(lmkKey);
  }

  const CHUNK = 500;
  let totalMatched = 0;
  for (const [comboKey, lmkKeys] of groups) {
    const [solar, efficiency] = comboKey.split('|').map(v => v === 'true');
    for (let i = 0; i < lmkKeys.length; i += CHUNK) {
      const chunk = lmkKeys.slice(i, i + CHUNK);
      const { data, error } = await db
        .from('prospects')
        .update({ epc_recommends_solar: solar, epc_recommends_efficiency: efficiency })
        .in('epc_lmk_key', chunk)
        .select('id');
      if (error) throw new Error(`Update failed for combo ${comboKey}: ${JSON.stringify(error)}`);
      totalMatched += data.length;
      console.log(`  [solar=${solar} efficiency=${efficiency}] updated ${data.length}/${chunk.length}`);
    }
  }
  return totalMatched;
}

// ─── Main ───────────────────────────────────────────────────────────────

async function main() {
  const files = process.argv.slice(2).length
    ? process.argv.slice(2)
    : (existsSync('data/recommendations')
        ? readdirSync('data/recommendations').filter(f => f.endsWith('.csv')).map(f => `data/recommendations/${f}`)
        : []);

  if (!files.length) {
    console.error('No CSV files given and none found under data/recommendations/. Download the non-domestic EPC recommendations bulk CSV first.');
    process.exit(1);
  }

  let rawCount = 0;
  const perKeyRows = new Map(); // lmk_key -> array of summary texts
  const unclassified = new Set();

  for (const file of files) {
    console.log(`Reading ${file}...`);
    await parseCsvFile(file, (row, col) => {
      rawCount++;
      const lmkKey = String(row[col.lmk_key] ?? '').trim();
      const summary = String(row[col.improvement_summary] ?? '').trim();
      if (!lmkKey) return;
      if (!perKeyRows.has(lmkKey)) perKeyRows.set(lmkKey, []);
      perKeyRows.get(lmkKey).push(summary);
    });
  }

  const flagsByKey = new Map();
  for (const [lmkKey, summaries] of perKeyRows) {
    let solar = false, efficiency = false;
    for (const summary of summaries) {
      const c = classify(summary);
      if (c.solar) solar = true;
      if (c.efficiency) efficiency = true;
      if (!c.solar && !c.efficiency) unclassified.add(summary);
    }
    flagsByKey.set(lmkKey, { solar, efficiency });
  }

  console.log(`Raw rows: ${rawCount}`);
  console.log(`Distinct LMK_KEYs: ${perKeyRows.size}`);
  console.log(`Flagged solar: ${[...flagsByKey.values()].filter(f => f.solar).length}`);
  console.log(`Flagged efficiency: ${[...flagsByKey.values()].filter(f => f.efficiency).length}`);
  console.log(`Unclassified distinct summary texts (first 20): ${[...unclassified].slice(0, 20).join(' | ') || '(none)'}`);

  const matched = await applyFlags(flagsByKey);
  console.log(`Matched to existing prospects: ${matched}/${flagsByKey.size}`);
  console.log('Done.');
}

main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 3: Add the `npm run` script entry**

In `package.json`, find:
```json
  "scripts": {
    "ingest": "node scripts/ingest-epc.mjs",
    "geocode": "node scripts/geocode-postcodes.mjs"
  },
```
Replace with:
```json
  "scripts": {
    "ingest": "node scripts/ingest-epc.mjs",
    "geocode": "node scripts/geocode-postcodes.mjs",
    "ingest-recommendations": "node scripts/ingest-epc-recommendations.mjs"
  },
```

- [ ] **Step 4: Build a synthetic test CSV and verify end-to-end (no real download exists yet)**

Fetch 3 real `epc_lmk_key` values already in the live `prospects` table to build a realistic test fixture:
```bash
npx supabase db query --linked "select epc_lmk_key from prospects where epc_lmk_key is not null limit 3;"
```

Using those 3 real keys (substitute for `<key1>`/`<key2>`/`<key3>` below), create a throwaway test CSV (not committed) at `scratch-test-recommendations.csv`:
```csv
LMK_KEY,IMPROVEMENT_SUMMARY_TEXT
<key1>,Consider installing solar photovoltaic panels
<key1>,Change to LED lighting technologies
<key2>,Consider installing solar water heating
<key2>,Improve loft insulation
<key3>,Solar gain limit exceeded
<key3>,Add optimum start/stop to the heating system
```
This exercises: multi-row-per-key aggregation (key1 has 2 rows, only one matches), the LED-lighting-is-unclassified case, the solar-water-heating pattern, the loft-insulation pattern, and — critically — confirms "Solar gain limit exceeded" does NOT set `epc_recommends_solar` (key3 should end up `solar: false, efficiency: true`).

Run it:
```bash
SUPABASE_URL=<url> SUPABASE_SERVICE_ROLE_KEY=<key> node scripts/ingest-epc-recommendations.mjs scratch-test-recommendations.csv
```

Verify the actual DB state afterward:
```bash
npx supabase db query --linked "select epc_lmk_key, epc_recommends_solar, epc_recommends_efficiency from prospects where epc_lmk_key in ('<key1>','<key2>','<key3>');"
```
Expected: key1 → `solar=true, efficiency=false`; key2 → `solar=true, efficiency=true`; key3 → `solar=false, efficiency=true`. The console output's "Unclassified" line should include the LED lighting text.

Delete the throwaway test CSV afterward (do not commit it):
```bash
rm scratch-test-recommendations.csv
```

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/009_epc_recommendations.sql scripts/ingest-epc-recommendations.mjs package.json
git commit -m "Add EPC recommendations ingest pipeline (solar/efficiency flags)"
```

---

### Task 2: Frontend badges + filter toggles

**Files:**
- Create: `shared/epc-recommendation-config.js`
- Modify: `index.html`

**Interfaces:**
- Consumes: `prospects.epc_recommends_solar` / `prospects.epc_recommends_efficiency` (Task 1) — must be added to `fetchAllProspects()`'s `select()` list.

- [ ] **Step 1: Create the config file**

Create `shared/epc-recommendation-config.js` (mirrors `shared/solar-status-config.js`'s pattern):
```js
// Colours/labels for the two EPC-recommendation boolean flags. "Solar" is
// the headline signal (bright/high-visibility); "efficiency" is secondary
// (muted) — see docs/superpowers/specs/2026-08-19-epc-recommendations-design.md.
const EPC_RECOMMENDATION = {
  solar:      { color: "#c07a2b", soft: "#f5ead8", label: "EPC recommends solar" },
  efficiency: { color: "#7a8a7d", soft: "#e9ede9", label: "EPC recommends efficiency improvements" },
};
```

- [ ] **Step 2: Load the config file**

In `index.html`, find:
```html
<script src="shared/sic-codes.js"></script>
<script src="shared/contact-outcome-config.js"></script>
```
Replace with:
```html
<script src="shared/sic-codes.js"></script>
<script src="shared/epc-recommendation-config.js"></script>
<script src="shared/contact-outcome-config.js"></script>
```

- [ ] **Step 3: Add the two columns to the data fetch**

Find (in `fetchAllProspects()`):
```js
      .select('id, address, postcode, lat, lng, property_type, floor_area:total_floor_area, epc_rating:current_energy_rating, local_authority, solar_status, solar_max_panels, solar_yearly_energy_kwh, current_energy_efficiency')
```
Replace with:
```js
      .select('id, address, postcode, lat, lng, property_type, floor_area:total_floor_area, epc_rating:current_energy_rating, local_authority, solar_status, solar_max_panels, solar_yearly_energy_kwh, current_energy_efficiency, epc_recommends_solar, epc_recommends_efficiency')
```

- [ ] **Step 4: Add the popup badges**

Find (in `buildPopup()`):
```js
  const typeTag = `<span class="tag"><span class="tag-dot" style="background:${BUILDING_TYPE_COLORS[bucket]}"></span>${escapeHtml(bucket)}</span>`;
```
Directly after it, add:
```js
  const solarRecTag = d.epc_recommends_solar
    ? `<span class="tag"><span class="tag-dot" style="background:${EPC_RECOMMENDATION.solar.color}"></span>${escapeHtml(EPC_RECOMMENDATION.solar.label)}</span>`
    : '';
  const efficiencyRecTag = d.epc_recommends_efficiency
    ? `<span class="tag"><span class="tag-dot" style="background:${EPC_RECOMMENDATION.efficiency.color}"></span>${escapeHtml(EPC_RECOMMENDATION.efficiency.label)}</span>`
    : '';
```
Then find:
```js
        <div class="tags">${statusPill}${epcTag}${typeTag}</div>
```
Replace with:
```js
        <div class="tags">${statusPill}${epcTag}${typeTag}${solarRecTag}${efficiencyRecTag}</div>
```

- [ ] **Step 5: Add the sidebar filter toggles**

Find:
```html
  <div class="section">
    <h3>Solar status <span class="clear" id="solar-status-clear">show all</span></h3>
    <div id="solar-status-list" class="chip-list"></div>
  </div>

  <button id="reset">Reset filters</button>
```
Replace with:
```html
  <div class="section">
    <h3>Solar status <span class="clear" id="solar-status-clear">show all</span></h3>
    <div id="solar-status-list" class="chip-list"></div>
  </div>

  <div class="section">
    <h3>EPC recommendations</h3>
    <div class="chip-list">
      <label class="chip" id="epc-solar-chip">
        <input type="checkbox" id="epc-solar-filter"/>
        <span class="dot" style="background:#c07a2b"></span>
        EPC recommends solar<span class="chip-n" id="epc-solar-count"></span>
      </label>
      <label class="chip" id="epc-efficiency-chip">
        <input type="checkbox" id="epc-efficiency-filter"/>
        <span class="dot" style="background:#7a8a7d"></span>
        EPC recommends efficiency improvements<span class="chip-n" id="epc-efficiency-count"></span>
      </label>
    </div>
  </div>

  <button id="reset">Reset filters</button>
```

- [ ] **Step 6: Wire up filter state and logic**

Find:
```js
let activeBuildingTypes = new Set(BUILDING_TYPE_ORDER);
let activeRatings = new Set(EPC_RATING_ORDER);
let activeSolarStatuses = new Set(['prospect']); // default: only show fresh prospects
let searchTerm = "";
let floorMin = null;
```
Replace with:
```js
let activeBuildingTypes = new Set(BUILDING_TYPE_ORDER);
let activeRatings = new Set(EPC_RATING_ORDER);
let activeSolarStatuses = new Set(['prospect']); // default: only show fresh prospects
let filterEpcSolar = false;      // opt-in: when true, only show prospects with epc_recommends_solar
let filterEpcEfficiency = false; // opt-in: when true, only show prospects with epc_recommends_efficiency
let searchTerm = "";
let floorMin = null;
```

Find (in `applyFilters()`):
```js
    const statusOk = activeSolarStatuses.has(d.solar_status);
```
Replace with:
```js
    const statusOk = activeSolarStatuses.has(d.solar_status);
    const epcSolarOk = !filterEpcSolar || d.epc_recommends_solar === true;
    const epcEfficiencyOk = !filterEpcEfficiency || d.epc_recommends_efficiency === true;
```
Find:
```js
    if (typeOk && ratingOk && statusOk && searchOk && minOk && maxOk) {
```
Replace with:
```js
    if (typeOk && ratingOk && statusOk && epcSolarOk && epcEfficiencyOk && searchOk && minOk && maxOk) {
```

- [ ] **Step 7: Wire up the checkbox listeners and counts**

Find (in `initMap()`, after the existing chip-builder calls):
```js
  buildBuildingTypeChips(data);
  buildEpcRatingChips(data);
  buildSolarStatusChips(data);
}
```
Replace with:
```js
  buildBuildingTypeChips(data);
  buildEpcRatingChips(data);
  buildSolarStatusChips(data);
  buildEpcRecommendationCounts(data);
}
```
Then, directly after the existing `buildSolarStatusChips` function definition, add:
```js
function buildEpcRecommendationCounts(data) {
  const solarCount = data.filter(d => d.epc_recommends_solar === true).length;
  const efficiencyCount = data.filter(d => d.epc_recommends_efficiency === true).length;
  document.getElementById('epc-solar-count').textContent = solarCount.toLocaleString();
  document.getElementById('epc-efficiency-count').textContent = efficiencyCount.toLocaleString();
}

document.getElementById('epc-solar-filter').addEventListener('change', e => {
  filterEpcSolar = e.target.checked;
  document.getElementById('epc-solar-chip').classList.toggle('on', filterEpcSolar);
  applyFilters();
});
document.getElementById('epc-efficiency-filter').addEventListener('change', e => {
  filterEpcEfficiency = e.target.checked;
  document.getElementById('epc-efficiency-chip').classList.toggle('on', filterEpcEfficiency);
  applyFilters();
});
```

- [ ] **Step 8: Include the new toggles in "Reset filters"**

Find (the `#reset` button's click handler):
```js
document.getElementById("reset").addEventListener("click", () => {
  activeBuildingTypes = new Set(BUILDING_TYPE_ORDER);
  activeRatings = new Set(EPC_RATING_ORDER);
  activeSolarStatuses = new Set(['prospect']);
  searchTerm = ""; floorMin = null; floorMax = null;
  document.getElementById("search").value = "";
  document.getElementById("floor-min").value = "";
  document.getElementById("floor-max").value = "";
  document.querySelectorAll("#building-type-list input, #epc-rating-list input").forEach(cb => {
    cb.checked = true;
    cb.closest('.chip').classList.add('on');
  });
  document.querySelectorAll("#solar-status-list input").forEach(cb => {
    const isProspect = cb.dataset.status === 'prospect';
    cb.checked = isProspect;
    cb.closest('.chip').classList.toggle('on', isProspect);
  });
  applyFilters();
});
```
Replace with:
```js
document.getElementById("reset").addEventListener("click", () => {
  activeBuildingTypes = new Set(BUILDING_TYPE_ORDER);
  activeRatings = new Set(EPC_RATING_ORDER);
  activeSolarStatuses = new Set(['prospect']);
  filterEpcSolar = false;
  filterEpcEfficiency = false;
  searchTerm = ""; floorMin = null; floorMax = null;
  document.getElementById("search").value = "";
  document.getElementById("floor-min").value = "";
  document.getElementById("floor-max").value = "";
  document.querySelectorAll("#building-type-list input, #epc-rating-list input").forEach(cb => {
    cb.checked = true;
    cb.closest('.chip').classList.add('on');
  });
  document.querySelectorAll("#solar-status-list input").forEach(cb => {
    const isProspect = cb.dataset.status === 'prospect';
    cb.checked = isProspect;
    cb.closest('.chip').classList.toggle('on', isProspect);
  });
  document.getElementById('epc-solar-filter').checked = false;
  document.getElementById('epc-solar-chip').classList.remove('on');
  document.getElementById('epc-efficiency-filter').checked = false;
  document.getElementById('epc-efficiency-chip').classList.remove('on');
  applyFilters();
});
```

- [ ] **Step 9: Live-test in the browser**

Using the 3 synthetic-test prospects from Task 1 Step 4 (if their flags are still set in the DB — otherwise re-run that test first), serve the site locally, sign in (throwaway test account, same pattern as the Companies House work), and confirm:
- The prospect with `epc_recommends_solar=true` shows the "EPC recommends solar" badge in its popup.
- The prospect with `epc_recommends_efficiency=true` (and solar false) shows only the efficiency badge, not the solar one.
- Checking "EPC recommends solar" in the sidebar narrows the map to only that flagged prospect (plus any others already flagged); unchecking restores the full view.
- "Reset filters" clears both new checkboxes back to unchecked/all-shown.
- A prospect with `null` for both flags (i.e. most of the ~21,800 real rows, since no real recommendations file has been ingested yet) shows neither badge and isn't excluded by either filter (since both default off/no-filter).

- [ ] **Step 10: Commit**

```bash
git add shared/epc-recommendation-config.js index.html
git commit -m "Add EPC recommendation badges and filter toggles to the popup and sidebar"
```

---

## Self-review notes

- Spec coverage: solar/efficiency detection (Task 1), badges + filters (Task 2), the solar-gain-exclusion requirement (tested explicitly in Task 1 Step 4's synthetic CSV), the LED-lighting-out-of-scope requirement (also tested there), and the `null`-vs-`false` distinction (Global Constraints + Task 2 Step 9's explicit check) are all covered.
- No placeholders: all code is complete and real; the one intentionally-left-flexible spot (Task 2 Step 8's reset-handler wiring) explicitly tells the implementer to read the real existing code first rather than guessing its structure, which is a legitimate "confirm against reality" step, not a placeholder.
- Type/naming consistency: `epc_recommends_solar`/`epc_recommends_efficiency` used identically across the migration, ingest script, and frontend select/render code.
