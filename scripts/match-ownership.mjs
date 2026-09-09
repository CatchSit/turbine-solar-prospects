#!/usr/bin/env node
// Computes prospects.ownership_status (migration 024) by matching each
// prospect's postcode against HM Land Registry's "UK companies that own
// property in England and Wales" (CCOD) dataset — a downloaded monthly
// CSV, not a live API, so this is a plain batch script re-run whenever a
// newer CCOD file is downloaded, same shape as classify-companies.mjs.
//
// Matching logic (from the 2026-09-09 investigation — only resolves ~20%
// of leads, see HANDOVER.md):
//   - postcode has exactly one CCOD title  -> that title's tenure
//   - postcode has multiple CCOD titles AND one has a Company
//     Registration No. exactly matching this prospect's
//     company_classifications match -> that title's tenure
//   - otherwise -> 'unknown' (not "confirmed leased" — just unresolved)
//
// Usage:
//   CCOD_CSV_PATH=data/CCOD_FULL_2026_09.zip SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/match-ownership.mjs
//
// CCOD_CSV_PATH may point at either the .zip HMLR ships or an already-
// extracted .csv. Idempotent: always recomputes and rewrites every
// prospect with a postcode, so re-running against a newer CCOD file
// naturally corrects any prospect whose status has changed (e.g. sold).

import { createReadStream, existsSync } from 'node:fs';
import { parse } from 'csv-parse';
import unzipper from 'unzipper';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL              = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CCOD_CSV_PATH             = process.env.CCOD_CSV_PATH || 'data/CCOD_FULL_2026_09.zip';
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env vars');
}
if (!existsSync(CCOD_CSV_PATH)) {
  throw new Error(`CCOD file not found at ${CCOD_CSV_PATH} — set CCOD_CSV_PATH or download it to that path`);
}
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const PAGE = 1000;
const UPDATE_CONCURRENCY = 15;

function normPostcode(pc) {
  return (pc || '').toUpperCase().replace(/\s+/g, '');
}
function normCompanyNo(n) {
  return (n || '').toUpperCase().replace(/^0+/, '');
}

// ─── Step 1: load every prospect's postcode + resolved company number ──────

async function fetchProspects() {
  const rows = [];
  let from = 0;
  while (true) {
    const { data, error } = await db.from('prospects')
      .select('id, postcode')
      .not('postcode', 'is', null)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(JSON.stringify(error));
    rows.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return rows;
}

async function fetchCompanyNumbers() {
  const map = new Map(); // prospect_id -> company_number
  let from = 0;
  while (true) {
    const { data, error } = await db.from('company_classifications')
      .select('prospect_id, company_number')
      .not('company_number', 'is', null)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(JSON.stringify(error));
    data.forEach(row => map.set(row.prospect_id, row.company_number));
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return map;
}

// ─── Step 2: stream CCOD, keeping only postcodes our prospects care about ──
// (restricting to relevant postcodes up front keeps this to a few tens of
// thousands of Map entries instead of CCOD's full ~4.5M rows nationwide)

async function loadCcod(path, relevantPostcodes) {
  const map = new Map(); // normalized postcode -> [{ tenure, companyNo }]
  const isZip = path.toLowerCase().endsWith('.zip');
  let csvStream;
  if (isZip) {
    const directory = await unzipper.Open.file(path);
    const entry = directory.files.find(f => f.path.toLowerCase().endsWith('.csv'));
    if (!entry) throw new Error(`No .csv file found inside ${path}`);
    csvStream = entry.stream();
  } else {
    csvStream = createReadStream(path);
  }

  const parser = csvStream.pipe(parse({ columns: true }));
  let seen = 0;
  for await (const record of parser) {
    seen++;
    if (seen % 500_000 === 0) console.log(`  scanned ${seen.toLocaleString()} CCOD rows...`);
    const pc = normPostcode(record['Postcode']);
    if (!pc || !relevantPostcodes.has(pc)) continue;
    if (!map.has(pc)) map.set(pc, []);
    map.get(pc).push({ tenure: record['Tenure'], companyNo: record['Company Registration No. (1)'] });
  }
  console.log(`  scanned ${seen.toLocaleString()} CCOD rows total, kept ${map.size.toLocaleString()} relevant postcodes`);
  return map;
}

// ─── Step 3: resolve + write ────────────────────────────────────────────────

function resolveStatus(hits, companyNumber) {
  if (!hits || hits.length === 0) return null;
  if (hits.length === 1) return hits[0].tenure === 'Freehold' ? 'freehold_confirmed' : hits[0].tenure === 'Leasehold' ? 'leasehold_confirmed' : null;
  if (companyNumber) {
    const exact = hits.find(h => normCompanyNo(h.companyNo) && normCompanyNo(h.companyNo) === normCompanyNo(companyNumber));
    if (exact) return exact.tenure === 'Freehold' ? 'freehold_confirmed' : exact.tenure === 'Leasehold' ? 'leasehold_confirmed' : null;
  }
  return null;
}

async function updateOne(id, status, checkedAt) {
  const { error } = await db.from('prospects')
    .update({ ownership_status: status, ownership_checked_at: checkedAt })
    .eq('id', id);
  if (error) console.error(`  ${id}: update failed — ${JSON.stringify(error)}`);
}

async function main() {
  console.log('Fetching prospects + company matches...');
  const [prospects, companyNumbers] = await Promise.all([fetchProspects(), fetchCompanyNumbers()]);
  console.log(`${prospects.length} prospects with a postcode, ${companyNumbers.size} with a resolved company number`);

  const relevantPostcodes = new Set(prospects.map(p => normPostcode(p.postcode)));
  console.log(`Loading CCOD from ${CCOD_CSV_PATH}...`);
  const ccod = await loadCcod(CCOD_CSV_PATH, relevantPostcodes);

  const checkedAt = new Date().toISOString();
  const counts = { freehold_confirmed: 0, leasehold_confirmed: 0, unknown: 0 };
  let queue = [];
  for (let i = 0; i < prospects.length; i++) {
    const p = prospects[i];
    const hits = ccod.get(normPostcode(p.postcode));
    const status = resolveStatus(hits, companyNumbers.get(p.id)) || 'unknown';
    counts[status]++;
    queue.push(updateOne(p.id, status, checkedAt));
    if (queue.length >= UPDATE_CONCURRENCY) { await Promise.all(queue); queue = []; }
    if ((i + 1) % 2000 === 0) console.log(`  ${i + 1}/${prospects.length} written`);
  }
  await Promise.all(queue);

  console.log('Done.', counts);
}

main().catch(e => { console.error(e); process.exit(1); });
