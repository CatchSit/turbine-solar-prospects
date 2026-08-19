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
