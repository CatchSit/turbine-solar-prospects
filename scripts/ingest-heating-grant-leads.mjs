#!/usr/bin/env node
// Ingest the oil/LPG BUS-grant lead list (already filtered to Turbine's
// South Yorkshire coverage area — Sheffield/Doncaster/Barnsley/Rotherham,
// and already deduped to one row per property) into the `prospects` table
// as a new lead category, source:'oil-lpg-bus'.
//
// Upstream pipeline that produced the input CSV lives in a separate,
// non-git project: C:\Users\user\Projects\oil-lpg-bus-leads\ — see its own
// HANDOVER.md for how the national EPC register was filtered down to this
// file. This script only does the final step: load it into this CRM.
//
// solar_status is seeded 'no_coverage' (not the table default 'pending')
// so these domestic heating leads are never picked up by
// supabase/functions/solar-enrichment's pending-only query — screening for
// existing rooftop solar arrays is meaningless for a heating-fuel lead and
// would only burn that function's monthly Google Solar API quota.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/ingest-heating-grant-leads.mjs [csv-file]
// Defaults to the known Downloads location if no path is given.

import { createReadStream } from 'node:fs';
import { parse } from 'csv-parse';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL              = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env vars');
}
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const DEFAULT_PATH = 'C:\\Users\\user\\Downloads\\oil-lpg-leads-south-yorkshire.csv';
const SOURCE = 'oil-lpg-bus';
const REGION = 'yorkshire-humber';

// ─── Row -> prospect record ────────────────────────────────────────────────

function buildAddress(row) {
  return [row.address1, row.address2, row.address3, row.posttown]
    .map(v => String(v ?? '').trim())
    .filter(Boolean)
    .join(', ');
}

function toProspectRow(row) {
  const floorArea = parseFloat(row.total_floor_area);
  const efficiency = parseInt(row.current_energy_efficiency, 10);
  return {
    epc_lmk_key:               String(row.certificate_number ?? '').trim(),
    uprn:                      String(row.uprn ?? '').trim() || null,
    address:                   buildAddress(row),
    postcode:                  String(row.postcode ?? '').trim(),
    local_authority:           String(row.local_authority_label ?? '').trim(),
    region:                    REGION,
    property_type:             String(row.property_type ?? '').trim() || null,
    total_floor_area:          Number.isFinite(floorArea) ? floorArea : null,
    current_energy_rating:     String(row.current_energy_rating ?? '').trim().toUpperCase() || null,
    current_energy_efficiency: Number.isFinite(efficiency) ? efficiency : null,
    lodgement_date:            String(row.lodgement_date ?? '').trim() || null,
    main_fuel:                 String(row.main_fuel ?? '').trim() || null,
    tenure:                    String(row.tenure ?? '').trim() || null,
    source:                    SOURCE,
    solar_status:              'no_coverage',
  };
}

// ─── CSV parsing ────────────────────────────────────────────────────────────

async function parseCsvFile(filePath, onRow) {
  const stream = createReadStream(filePath).pipe(parse({ columns: true, bom: true, relax_quotes: true }));
  for await (const row of stream) onRow(row);
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
  const filePath = process.argv[2] || DEFAULT_PATH;
  console.log(`Reading ${filePath} ...`);

  const rows = [];
  let skippedNoKey = 0;
  await parseCsvFile(filePath, row => {
    const rec = toProspectRow(row);
    if (!rec.epc_lmk_key || !rec.postcode) { skippedNoKey++; return; }
    rows.push(rec);
  });

  console.log(`Parsed ${rows.length} rows (skipped ${skippedNoKey} with no certificate number / postcode).`);
  if (!rows.length) { console.log('Nothing to upsert.'); return; }

  await upsertBatch(rows);
  console.log(`Done. ${rows.length} rows upserted with source:'${SOURCE}'.`);
  console.log(`Run "npm run geocode" next to fill lat/lng for these new rows.`);
}

main().catch(err => { console.error(err); process.exit(1); });
