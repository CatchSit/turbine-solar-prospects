#!/usr/bin/env node
// Ingest non-domestic EPC bulk CSV export(s) into the `prospects` table.
//
// Source: https://get-energy-performance-data.communities.gov.uk/
// (bulk download requires a GOV.UK One Login account — see HANDOVER.md).
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/ingest-epc.mjs [csv-files...]
// If no files are given, every *.csv under data/ is used.
//
// IMPORTANT: the column-name mapping below is our best guess at the bulk
// CSV schema (matching the historical opendatacommunities format). This
// script fails loudly, listing the actual headers found, if it can't match
// the columns it needs — check against a real downloaded file before
// trusting a silent success. See HANDOVER.md "Known risks".

import { createReadStream, readdirSync } from 'node:fs';
import { parse } from 'csv-parse';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL              = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env vars');
}
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ─── Tunables ──────────────────────────────────────────────────────────────

const MIN_FLOOR_AREA_M2 = 500;
const REGION = 'yorkshire-humber';

// Matched case-insensitively against LOCAL_AUTHORITY_LABEL.
const YORKSHIRE_HUMBER_LAS = new Set([
  'leeds', 'sheffield', 'bradford', 'kirklees', 'wakefield', 'calderdale',
  'kingston upon hull, city of', 'kingston upon hull', 'hull',
  'east riding of yorkshire', 'york', 'north yorkshire',
  'doncaster', 'rotherham', 'barnsley',
  'north lincolnshire', 'north east lincolnshire',
].map(s => s.toLowerCase()));

// Secondary sanity check — postcode outcode prefix.
const YORKSHIRE_HUMBER_OUTCODES = new Set(['BD', 'DN', 'HD', 'HG', 'HU', 'HX', 'LS', 'S', 'WF', 'YO']);

function postcodeOutcodeArea(postcode) {
  const m = String(postcode || '').trim().toUpperCase().match(/^([A-Z]{1,2})\d/);
  return m ? m[1] : '';
}

// ─── Column mapping (defensive — see header note above) ──────────────────

const COLUMN_CANDIDATES = {
  lmk_key:                  ['LMK_KEY', 'lmk-key'],
  uprn:                     ['UPRN', 'uprn'],
  address1:                 ['ADDRESS1', 'address1', 'ADDRESS'],
  address2:                 ['ADDRESS2', 'address2'],
  address3:                 ['ADDRESS3', 'address3'],
  posttown:                 ['POSTTOWN', 'posttown', 'TOWN'],
  postcode:                 ['POSTCODE', 'postcode'],
  local_authority_label:    ['LOCAL_AUTHORITY_LABEL', 'local-authority-label'],
  property_type:            ['PROPERTY_TYPE', 'property-type'],
  total_floor_area:         ['TOTAL_FLOOR_AREA', 'total-floor-area'],
  current_energy_rating:    ['CURRENT_ENERGY_RATING', 'current-energy-rating', 'ASSET_RATING_BAND'],
  current_energy_efficiency:['CURRENT_ENERGY_EFFICIENCY', 'current-energy-efficiency', 'ASSET_RATING'],
  lodgement_date:           ['LODGEMENT_DATE', 'lodgement-date'],
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
      `ingest-epc.mjs: could not find columns for [${missing.join(', ')}] in CSV header.\n` +
      `Actual headers found: ${headers.join(', ')}\n` +
      `Update COLUMN_CANDIDATES in this script to match the real export.`
    );
  }
  return resolved;
}

// ─── Row -> prospect record ────────────────────────────────────────────────

function buildAddress(row, col) {
  return [row[col.address1], row[col.address2], row[col.address3], row[col.posttown]]
    .map(v => String(v ?? '').trim())
    .filter(Boolean)
    .join(', ');
}

function toProspectRow(row, col) {
  const floorArea = parseFloat(row[col.total_floor_area]);
  return {
    epc_lmk_key:               String(row[col.lmk_key] ?? '').trim(),
    uprn:                      String(row[col.uprn] ?? '').trim() || null,
    address:                   buildAddress(row, col),
    postcode:                  String(row[col.postcode] ?? '').trim(),
    local_authority:           String(row[col.local_authority_label] ?? '').trim(),
    region:                    REGION,
    property_type:             String(row[col.property_type] ?? '').trim(),
    total_floor_area:          Number.isFinite(floorArea) ? floorArea : null,
    current_energy_rating:     String(row[col.current_energy_rating] ?? '').trim().toUpperCase() || null,
    current_energy_efficiency: parseInt(row[col.current_energy_efficiency], 10) || null,
    lodgement_date:            String(row[col.lodgement_date] ?? '').trim() || null,
  };
}

function passesFilter(rec) {
  if (!rec.epc_lmk_key) return false;
  if (!(rec.total_floor_area >= MIN_FLOOR_AREA_M2)) return false;
  const laOk  = YORKSHIRE_HUMBER_LAS.has(rec.local_authority.toLowerCase());
  const pcOk  = YORKSHIRE_HUMBER_OUTCODES.has(postcodeOutcodeArea(rec.postcode));
  return laOk || pcOk;
}

// ─── Dedupe: keep the most recent lodgement per building ──────────────────

function dedupeKey(rec) {
  return rec.uprn || `${rec.address.toLowerCase()}|${rec.postcode.toLowerCase()}`;
}

function keepNewest(existing, candidate) {
  if (!existing) return candidate;
  return (candidate.lodgement_date || '') > (existing.lodgement_date || '') ? candidate : existing;
}

// ─── CSV parsing ────────────────────────────────────────────────────────────

async function parseCsvFile(filePath, onRow) {
  const stream = createReadStream(filePath).pipe(parse({ columns: true, bom: true, relax_quotes: true }));
  let col = null;
  for await (const row of stream) {
    if (!col) col = buildColumnResolver(Object.keys(row));
    onRow(row, col);
  }
}

// ─── Supabase upsert ────────────────────────────────────────────────────────

async function upsertBatch(rows) {
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error } = await db.from('prospects').upsert(chunk, { onConflict: 'epc_lmk_key' });
    if (error) throw new Error(`Upsert failed at row ${i}: ${JSON.stringify(error)}`);
    console.log(`  upserted ${Math.min(i + CHUNK, rows.length)}/${rows.length}`);
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const files = process.argv.slice(2).length
    ? process.argv.slice(2)
    : readdirSync('data').filter(f => f.endsWith('.csv')).map(f => `data/${f}`);

  if (!files.length) {
    console.error('No CSV files given and none found under data/. Download the non-domestic EPC bulk CSV first.');
    process.exit(1);
  }

  let rawCount = 0;
  let afterFilterCount = 0;
  const dedup = new Map(); // dedupeKey -> most recent record

  for (const file of files) {
    console.log(`Reading ${file}...`);
    await parseCsvFile(file, (row, col) => {
      rawCount++;
      const rec = toProspectRow(row, col);
      if (!passesFilter(rec)) return;
      afterFilterCount++;
      const key = dedupeKey(rec);
      dedup.set(key, keepNewest(dedup.get(key), rec));
    });
  }

  const finalRows = [...dedup.values()];
  console.log(`Raw rows: ${rawCount}`);
  console.log(`After region + floor-area filter: ${afterFilterCount}`);
  console.log(`After dedupe by building: ${finalRows.length}`);

  await upsertBatch(finalRows);
  console.log('Done.');
}

main().catch(e => { console.error(e); process.exit(1); });
