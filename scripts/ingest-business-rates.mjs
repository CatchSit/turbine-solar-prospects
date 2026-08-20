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

main().catch(e => { console.error(e); process.exit(1); });
