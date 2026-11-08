#!/usr/bin/env node
// Upload domestic homes recommended solar to domestic_solar_epc (migration 062).
// The CSV holds home addresses and is built outside this public repo by
// C:\Users\user\Projects\domestic-solar-leads. Never copy it in here.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/ingest-domestic-solar.mjs <csv-file>

import { createReadStream } from 'node:fs';
import { parse } from 'csv-parse';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL              = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env vars');
}
const csvFile = process.argv[2];
if (!csvFile) throw new Error('Usage: node scripts/ingest-domestic-solar.mjs <csv-file>');
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const num = v => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));
const CHUNK = 500;
let batch = [];
let total = 0;

async function flush() {
  if (!batch.length) return;
  const { error } = await db.from('domestic_solar_epc').upsert(batch, { onConflict: 'certificate_number' });
  if (error) throw error;
  total += batch.length;
  batch = [];
  console.log(`  uploaded ${total.toLocaleString()}`);
}

for await (const r of createReadStream(csvFile).pipe(parse({ columns: true, bom: true }))) {
  batch.push({
    certificate_number: r.certificate_number,
    address: r.address,
    postcode: r.postcode || null,
    council: r.local_authority_label || null,
    property_type: r.property_type || null,
    built_form: r.built_form || null,
    tenure: r.tenure || null,
    transaction_type: r.transaction_type || null,
    energy_rating: r.current_energy_rating || null,
    main_fuel: r.main_fuel || null,
    lodgement_date: r.lodgement_date || null,
    uprn: r.uprn || null,
    roof_description: r.roof_description || null,
    floor_area: num(r.total_floor_area),
    age_band: r.construction_age_band || null,
    potential_rating: r.potential_energy_rating || null,
    energy_score: num(r.current_energy_efficiency),
    potential_score: num(r.potential_energy_efficiency),
    energy_cost_yearly: (num(r.lighting_cost_current) ?? 0) + (num(r.heating_cost_current) ?? 0) + (num(r.hot_water_cost_current) ?? 0) || null,
    lat: Number(r.lat),
    lng: Number(r.lng),
  });
  if (batch.length >= CHUNK) await flush();
}
await flush();
console.log(`Done: ${total.toLocaleString()} homes.`);
