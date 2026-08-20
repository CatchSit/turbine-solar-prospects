# VOA as a Primary Prospect Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `ingest-business-rates.mjs` seed brand-new `prospects` rows from VOA hereditaments whose postcode has no existing prospect (above a rateable-value floor), not just enrich prospects that already arrived via EPC — closing a structural gap where owner-occupied buildings with no EPC certificate are currently invisible to the pipeline.

**Architecture:** One migration relaxes `prospects`' schema to accept a second provenance (`source`, nullable `epc_lmk_key`, new `voa_ba_reference` unique key). `ingest-business-rates.mjs` gains a dry-run mode and a new-prospect-seeding step within its existing single download/parse pass — no second expensive parse. `geocode-postcodes.mjs` backfills `local_authority` from data it already fetches but doesn't currently store, needed for VOA-only prospects that have no EPC-derived value there. The frontend gets one filter-logic fix (`ratingOk`) to prevent a bug this change would otherwise reintroduce.

**Tech Stack:** Node scripts (existing pipeline), Supabase Postgres migration, plain HTML/CSS/JS frontend — no new dependencies.

## Global Constraints

- New VOA-sourced prospects: one row **per postcode** (highest-rateable-value hereditament as the representative record), never per hereditament — matches the existing building-level model everywhere else.
- `MIN_VOA_RATEABLE_VALUE = 15000` — calibrated against real data (p05=£11,750, p10=£19,750 among the 19,050 existing prospects that already qualify via floor area), not guessed. Plain tunable constant.
- The existing "prefilter to bound update volume" lesson (`docs/superpowers/specs/2026-08-19-voa-business-rates-design.md`) is being *relaxed on one dimension only* (no longer requiring "already a known prospect"), not abandoned — the Yorkshire & Humber outcode filter, which is what actually bounds the 2-million-row national file down to a tractable regional subset, stays fully in place.
- `DRY_RUN=1` must make zero writes — no prospect inserts, no `business_rates_matches` upserts — and report the candidate count only. Always run before a real run.
- Neither `ingest-business-rates.mjs` nor `geocode-postcodes.mjs` can be run by an agent in this environment without `SUPABASE_SERVICE_ROLE_KEY` as a local env var — same constraint hit building the previous two plans this session. Tasks involving an actual script run are explicitly flagged as a handoff, not something to attempt inline.

---

### Task 1: Database migration

**Files:**
- Create: `supabase/migrations/013_voa_prospect_source.sql`

**Interfaces:**
- Produces: `prospects.epc_lmk_key` (now nullable), `prospects.voa_ba_reference` (new, nullable, unique), `prospects.source` (new, `text not null default 'epc'`). Consumed by Task 3's insert.

- [ ] **Step 1: Write the migration**

```sql
alter table prospects alter column epc_lmk_key drop not null;
alter table prospects add column if not exists voa_ba_reference text unique;
alter table prospects add column if not exists source text not null default 'epc';
```

- [ ] **Step 2: Apply it to the linked project**

Run: `supabase db push` (confirm with `supabase db push --dry-run` first that only `013_voa_prospect_source.sql` is pending — same check used for migration `012` earlier this session).

Expected: succeeds. Verify with `supabase migration list` showing `013` in both Local and Remote columns.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/013_voa_prospect_source.sql
git commit -m "$(cat <<'EOF'
Relax prospects schema to accept a second provenance (VOA)

epc_lmk_key becomes nullable (UNIQUE still holds — Postgres allows
multiple NULLs), voa_ba_reference is the new upsert key for
VOA-sourced rows, source makes provenance explicit rather than
inferred from which key column is populated.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Backfill `local_authority` during geocoding

**Files:**
- Modify: `scripts/geocode-postcodes.mjs`

**Interfaces:**
- Consumes: postcodes.io's `admin_district` field (already fetched, not currently stored).
- Produces: `prospects.local_authority` filled for any row where it was previously null — needed for VOA-only prospects, since VOA doesn't provide a readable local authority name (only a billing-authority code this project doesn't map to a name).

- [ ] **Step 1: Verify `admin_district` is really in postcodes.io's response**

Run this directly (no credentials needed — postcodes.io is a free, unauthenticated public API):

```bash
node -e "
fetch('https://api.postcodes.io/postcodes', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ postcodes: ['LS1 1UR'] }),
})
  .then(r => r.json())
  .then(json => console.log(JSON.stringify(json.result[0].result.admin_district)));
"
```

Expected: prints a real local authority name (e.g. `"Leeds"`), not `null` or `undefined`. If it's missing, stop and re-check postcodes.io's current response shape before continuing — don't guess the field name.

- [ ] **Step 2: Select `local_authority` alongside the existing fields**

In `scripts/geocode-postcodes.mjs`'s `fetchPendingRows()`, change:
```js
      .select('id, postcode')
```
to:
```js
      .select('id, postcode, local_authority')
```

- [ ] **Step 3: Backfill it only when currently null**

In the `main()` loop's `results.forEach(...)`, change:
```js
    results.forEach((entry, idx) => {
      const row = batch[idx];
      if (entry.result) {
        updates.push({ id: row.id, lat: entry.result.latitude, lng: entry.result.longitude });
        geocoded++;
      } else {
        failed++;
        console.warn(`  no match: ${row.postcode} (id=${row.id})`);
      }
    });
```
to:
```js
    results.forEach((entry, idx) => {
      const row = batch[idx];
      if (entry.result) {
        const update = { id: row.id, lat: entry.result.latitude, lng: entry.result.longitude };
        // Only backfill when the row has no local_authority already — never
        // overwrite an EPC-sourced value with postcodes.io's naming, which
        // may not match (e.g. "Leeds" vs whatever EPC's own label was).
        if (!row.local_authority && entry.result.admin_district) {
          update.local_authority = entry.result.admin_district;
        }
        updates.push(update);
        geocoded++;
      } else {
        failed++;
        console.warn(`  no match: ${row.postcode} (id=${row.id})`);
      }
    });
```

- [ ] **Step 4: Apply the backfilled field in the update call**

Change:
```js
    for (const u of updates) {
      const { error: updErr } = await db
        .from('prospects')
        .update({ lat: u.lat, lng: u.lng, geocode_source: 'postcodes.io' })
        .eq('id', u.id);
      if (updErr) console.error(`  update failed for ${u.id}:`, JSON.stringify(updErr));
    }
```
to:
```js
    for (const u of updates) {
      const patch = { lat: u.lat, lng: u.lng, geocode_source: 'postcodes.io' };
      if (u.local_authority) patch.local_authority = u.local_authority;
      const { error: updErr } = await db
        .from('prospects')
        .update(patch)
        .eq('id', u.id);
      if (updErr) console.error(`  update failed for ${u.id}:`, JSON.stringify(updErr));
    }
```

- [ ] **Step 5: Commit**

```bash
git add scripts/geocode-postcodes.mjs
git commit -m "$(cat <<'EOF'
Backfill local_authority from postcodes.io when missing

Needed for VOA-sourced prospects, which have no EPC-derived local
authority name. Verified admin_district is really in postcodes.io's
response against a real call before wiring this in. Never overwrites
an existing (EPC-sourced) value.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: New-prospect seeding in `ingest-business-rates.mjs`

**Files:**
- Modify: `scripts/ingest-business-rates.mjs`

**Interfaces:**
- Produces: new `prospects` rows (`source: 'voa'`) for postcodes with no existing prospect, above `MIN_VOA_RATEABLE_VALUE`. `DRY_RUN=1` env var makes the whole run read-only.
- Consumes: Task 1's schema (`voa_ba_reference`, `source` columns).

- [ ] **Step 1: Add the new field positions and tunables**

Change:
```js
const FIELD = {
  BILLING_AUTHORITY_CODE: 1,
  DESCRIPTION_TEXT: 5,
  POSTCODE: 14,
  RATEABLE_VALUE: 17,
};
```
to:
```js
const FIELD = {
  BILLING_AUTHORITY_CODE: 1,
  BA_REFERENCE_NUMBER: 3,
  DESCRIPTION_TEXT: 5,
  ADDRESS_COMBINED: 7,
  POSTCODE: 14,
  RATEABLE_VALUE: 17,
};

// New prospects seeded from VOA data need a size-equivalent floor since
// floor area isn't available from VOA — calibrated against the real
// rateable-value distribution of prospects that already qualify today
// (p05=£11,750, p10=£19,750 among 19,050 matched prospects, checked
// 2026-08-20). See
// docs/superpowers/specs/2026-08-20-voa-primary-prospect-source-design.md.
const MIN_VOA_RATEABLE_VALUE = 15000;

// Set DRY_RUN=1 to report how many new prospects this would create without
// writing anything — no prospects inserted, no business_rates_matches
// touched. Always run this first after changing MIN_VOA_RATEABLE_VALUE.
const DRY_RUN = process.env.DRY_RUN === '1';
```

- [ ] **Step 2: Collect every Yorkshire & Humber hereditament, not just ones matching an existing prospect**

Change:
```js
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
```
to:
```js
// Collects every Yorkshire & Humber hereditament (region-bounded — that's
// what keeps this tractable against a 2-million-row national file, same as
// before), regardless of whether its postcode already has a prospect. The
// "already a known prospect" filter that used to live here moved to
// selectNewProspectCandidates() below, since we now need this same data for
// two different purposes: enriching existing prospects AND seeding new ones.
async function collectHereditamentsByPostcode(stream) {
  const byPostcode = new Map(); // normalized postcode -> hereditament[]
  let rawCount = 0, yhCount = 0;

  const parser = stream.pipe(parse({ delimiter: '*', relax_column_count: true, bom: true }));
  for await (const row of parser) {
    rawCount++;
    const postcode = String(row[FIELD.POSTCODE] || '').trim();
    if (!postcode) continue;
    const outcode = postcodeOutcodeArea(postcode);
    if (!YORKSHIRE_HUMBER_OUTCODES.has(outcode)) continue;
    yhCount++;

    const rateableValue = parseInt(row[FIELD.RATEABLE_VALUE], 10);
    if (!Number.isFinite(rateableValue)) continue;

    const norm = postcode.toUpperCase().replace(/\s+/g, '');
    const hereditament = {
      description: String(row[FIELD.DESCRIPTION_TEXT] || '').trim(),
      rateable_value: rateableValue,
      billing_authority_code: String(row[FIELD.BILLING_AUTHORITY_CODE] || '').trim(),
      ba_reference: String(row[FIELD.BA_REFERENCE_NUMBER] || '').trim(),
      address: String(row[FIELD.ADDRESS_COMBINED] || '').trim(),
      postcode,
    };
    if (!byPostcode.has(norm)) byPostcode.set(norm, []);
    byPostcode.get(norm).push(hereditament);
  }

  console.log(`Raw rows: ${rawCount}`);
  console.log(`Yorkshire & Humber rows (by postcode outcode): ${yhCount}`);
  console.log(`Distinct Yorkshire & Humber postcodes: ${byPostcode.size}`);
  return byPostcode;
}
```

- [ ] **Step 3: Add candidate selection and insertion functions**

Insert after `collectHereditamentsByPostcode` (before the existing `upsertMatches`):
```js
// ─── Step 5b: identify postcodes with no existing prospect that qualify as
// new VOA-sourced prospects ─────────────────────────────────────────────

function selectNewProspectCandidates(byPostcode, existingPostcodes) {
  const candidates = [];
  for (const [norm, hereditaments] of byPostcode) {
    if (existingPostcodes.has(norm)) continue;
    const top = hereditaments.reduce(
      (best, h) => (h.rateable_value > (best?.rateable_value ?? -1) ? h : best),
      null,
    );
    if (!top || top.rateable_value < MIN_VOA_RATEABLE_VALUE) continue;
    candidates.push({
      voa_ba_reference: top.ba_reference,
      address: top.address,
      postcode: top.postcode,
      property_type: top.description,
      source: 'voa',
      region: 'yorkshire-humber',
    });
  }
  console.log(`New-prospect candidate postcodes (no existing prospect, top hereditament >= £${MIN_VOA_RATEABLE_VALUE.toLocaleString()}): ${candidates.length}`);
  return candidates;
}

// ─── Step 5c: insert new VOA-sourced prospects ─────────────────────────────

async function insertNewProspects(candidates) {
  const inserted = new Map(); // normalized postcode -> Set<prospect id>
  const CHUNK = 500;
  for (let i = 0; i < candidates.length; i += CHUNK) {
    const chunk = candidates.slice(i, i + CHUNK);
    const { data, error } = await db.from('prospects')
      .upsert(chunk, { onConflict: 'voa_ba_reference' })
      .select('id, postcode');
    if (error) throw new Error(`New-prospect insert failed at row ${i}: ${JSON.stringify(error)}`);
    for (const row of data) {
      const norm = row.postcode.toUpperCase().replace(/\s+/g, '');
      if (!inserted.has(norm)) inserted.set(norm, new Set());
      inserted.get(norm).add(row.id);
    }
    console.log(`  inserted ${Math.min(i + CHUNK, candidates.length)}/${candidates.length} new prospects`);
  }
  return inserted;
}
```

- [ ] **Step 4: Rewire `main()`**

Change:
```js
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
```
to:
```js
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

  const byPostcode = await collectHereditamentsByPostcode(stream);
  const matchedExistingCount = [...existingPostcodes.keys()].filter(norm => byPostcode.has(norm)).length;
  console.log(`Existing prospect postcodes with at least one hereditament match: ${matchedExistingCount}`);

  const newCandidates = selectNewProspectCandidates(byPostcode, existingPostcodes);

  if (DRY_RUN) {
    console.log('DRY_RUN=1 set — no writes made. Re-run without it to apply.');
    return;
  }

  const newlyInserted = await insertNewProspects(newCandidates);
  for (const [norm, ids] of newlyInserted) {
    if (!existingPostcodes.has(norm)) existingPostcodes.set(norm, new Set());
    for (const id of ids) existingPostcodes.get(norm).add(id);
  }

  await upsertMatches(byPostcode, existingPostcodes);
  console.log('Done.');
}
```

Note `upsertMatches` is now called once, after merging newly-inserted prospects into `existingPostcodes` — it enriches both existing and newly-seeded prospects with their hereditament list in a single pass, no second matching step needed.

- [ ] **Step 5: Syntax-check**

Run: `node --check scripts/ingest-business-rates.mjs`
Expected: no output (success).

- [ ] **Step 6: Commit — do not run yet**

The actual run (even `DRY_RUN=1`) needs `SUPABASE_SERVICE_ROLE_KEY`, not available to an agent in this environment. Task 5 hands the run off explicitly.

```bash
git add scripts/ingest-business-rates.mjs
git commit -m "$(cat <<'EOF'
Seed new prospects from VOA data, not just enrich existing ones

Postcodes with no existing prospect and a top hereditament above
MIN_VOA_RATEABLE_VALUE now become new source:'voa' prospect rows,
one per postcode (highest-value hereditament as the representative
record) — closes the gap where owner-occupied buildings with no EPC
certificate were structurally invisible to the pipeline. DRY_RUN=1
reports the candidate count with zero writes; always run that first.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Frontend — fix EPC Rating's null-passthrough

**Files:**
- Modify: `index.html` (`applyFilters()`)

**Interfaces:** none new — this is a bug fix matching the pattern already established for `sectorOk`/`maturityOk`.

- [ ] **Step 1: Apply the same "strict once touched" fix**

Change:
```js
    const ratingOk = !d.epc_rating || activeRatings.has(d.epc_rating);
```
to:
```js
    // Full selection (untouched default) passes everything through,
    // including prospects with no rating. Deselecting even one chip goes
    // strict — same fix already applied to sectorOk/maturityOk, needed here
    // too now that VOA-sourced prospects (no EPC data at all) exist.
    const ratingOk = activeRatings.size === EPC_RATING_ORDER.length || activeRatings.has(d.epc_rating);
```

- [ ] **Step 2: Verify in a real browser**

Serve locally (`npx serve . -l 5001`) and, via Playwright `browser_evaluate`, replicate the same check pattern used for `sectorOk` earlier this session:
```js
() => {
  const results = {};
  function ratingOkFor(rating) {
    return activeRatings.size === EPC_RATING_ORDER.length || activeRatings.has(rating);
  }
  results.defaultState = { rated: ratingOkFor('C'), unrated: ratingOkFor(null) };
  activeRatings = new Set(['C']);
  results.onlyCSelected = { rated: ratingOkFor('C'), otherRated: ratingOkFor('D'), unrated: ratingOkFor(null) };
  activeRatings = new Set(EPC_RATING_ORDER);
  results.afterResetToFull = { rated: ratingOkFor('C'), unrated: ratingOkFor(null) };
  return results;
}
```
Expected: `defaultState` both `true`; `onlyCSelected` — `rated: true, otherRated: false, unrated: false`; `afterResetToFull` both `true`. Stop the server and close the browser afterward.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "$(cat <<'EOF'
Fix EPC Rating filter's null-passthrough before VOA prospects ship

Same bug class just fixed for Business Sector/Company Maturity:
!d.epc_rating || activeRatings.has(...) was a dead edge case while
every prospect had a real EPC rating, but VOA-sourced prospects (no
EPC data at all) would silently leak through any rating selection
the same way unclassified prospects did before that fix.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Push, dry run, and hand off the real run

**Files:** none (push + handoff only)

- [ ] **Step 1: Push all commits**

```bash
git push origin main
```

- [ ] **Step 2: Hand off the dry run**

Report back to the user with the exact command:
```
DRY_RUN=1 COMPANIES_HOUSE_API_KEY=<unused-here-but-harmless-if-set> SUPABASE_URL=<url> SUPABASE_SERVICE_ROLE_KEY=<key> npm run ingest-business-rates
```
(Companies House key isn't actually used by this script — omit it; included above only as a reminder not to confuse which key goes with which script.) Ask the user to report back the `New-prospect candidate postcodes...` count before running it for real — that's the number that determines whether `MIN_VOA_RATEABLE_VALUE` needs retuning before committing to a real run.

- [ ] **Step 3: Once the count looks reasonable, hand off the real run**

Same command without `DRY_RUN=1`. This re-downloads and re-parses the VOA file (the existing `data/business-rates/baseline.zip` cache from the original enrichment run may still be present locally and will be reused unless deleted — same behavior as today). After it completes, re-run `npm run geocode` to fill lat/lng (and now `local_authority`) for the newly-seeded prospects — they won't appear on the map until geocoded.

- [ ] **Step 4: Update `HANDOVER.md`**

Add an entry (Section 4, as a note on the existing Step 6 VOA description; Section 9 next-steps) documenting: VOA now seeds new prospects in addition to enriching existing ones, the `DRY_RUN=1` flag and why it exists, the £15,000 threshold and its calibration source, the requirement to re-run `npm run geocode` afterward, and the accepted limitation that re-running EPC ingest after a VOA seeding pass could create a duplicate prospect at the same postcode (one `source:'epc'`, one `source:'voa'`) — postcode-level dedup only, same precision already accepted elsewhere in this pipeline. Commit and push.

```bash
git add HANDOVER.md
git commit -m "$(cat <<'EOF'
Document VOA-as-primary-source in HANDOVER.md

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
git push origin main
```

---

## Self-Review Notes

- **Spec coverage:** schema change (Task 1), local_authority backfill (Task 2), the core seeding logic + dry-run mode (Task 3), the EPC Rating filter fix explicitly called out in the spec's Goals (Task 4), dry-run-before-real-run handoff (Task 5). Non-goals respected: one row per postcode not per hereditament (Task 3's `selectNewProspectCandidates` picks a single top hereditament), no billing-authority-code lookup table (Task 2 uses postcodes.io instead), no solar-enrichment changes (new rows get the existing `solar_status` default, untouched).
- **Placeholder scan:** no TBD/TODO; every step has literal code.
- **Type/name consistency:** `voa_ba_reference`/`source` match between the migration (Task 1) and `insertNewProspects`'s upsert payload (Task 3). `MIN_VOA_RATEABLE_VALUE` and `DRY_RUN` are defined once (Task 3, Step 1) and referenced consistently in `selectNewProspectCandidates` and `main()`.
- **Known constraint carried into Task 5:** neither `ingest-business-rates.mjs` nor `geocode-postcodes.mjs` can be executed by an agent in this environment (missing `SUPABASE_SERVICE_ROLE_KEY`) — Task 5 is explicitly a handoff, not something to attempt inline, consistent with how the classification pipeline's run was handled earlier this session.
