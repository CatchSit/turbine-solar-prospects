#!/usr/bin/env node
// Fill lat/lng on `prospects` rows using postcodes.io's free bulk endpoint.
//
// Free/hosted, built on the same ONSPD data a from-scratch pipeline would
// use. Fine for a pilot-sized dataset (low thousands of postcodes -> tens
// of bulk requests). If this ever scales to a national run, switch to a
// local ONSPD CSV join instead — both to avoid hammering a free public
// service at that volume, and because a local copy is more robust for bulk
// work. Keep that swap isolated to this script.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/geocode-postcodes.mjs

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL              = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env vars');
}
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const BULK_ENDPOINT = 'https://api.postcodes.io/postcodes';
const BATCH_SIZE = 100; // postcodes.io bulk cap per request
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function geocodeBatch(postcodes) {
  const resp = await fetch(BULK_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ postcodes }),
  });
  if (!resp.ok) throw new Error(`postcodes.io ${resp.status}: ${await resp.text()}`);
  const { result } = await resp.json();
  return result; // [{ query, result: { latitude, longitude, ... } | null }]
}

async function main() {
  const { data: rows, error } = await db
    .from('prospects')
    .select('id, postcode')
    .is('lat', null)
    .not('postcode', 'is', null);
  if (error) throw new Error(JSON.stringify(error));

  console.log(`Prospects needing geocoding: ${rows.length}`);
  if (!rows.length) return;

  let geocoded = 0;
  let failed = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const postcodes = batch.map(r => r.postcode);
    const results = await geocodeBatch(postcodes);

    const updates = [];
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

    for (const u of updates) {
      const { error: updErr } = await db
        .from('prospects')
        .update({ lat: u.lat, lng: u.lng, geocode_source: 'postcodes.io' })
        .eq('id', u.id);
      if (updErr) console.error(`  update failed for ${u.id}:`, JSON.stringify(updErr));
    }

    console.log(`  batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(rows.length / BATCH_SIZE)}: ${updates.length} geocoded`);
    await sleep(150); // be polite to a free public service
  }

  console.log(`Done. Geocoded: ${geocoded}, failed: ${failed}`);
}

main().catch(e => { console.error(e); process.exit(1); });
