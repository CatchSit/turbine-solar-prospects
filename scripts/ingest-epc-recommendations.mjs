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

const SOLAR_PATTERNS = [
  /solar\s+photovoltaic/i, /solar\s+water\s+heating/i, /\bsolar\s+pv\b/i,
  /\bphotovoltaic\b/i, /\bpv\s+panel/i,
];
const EFFICIENCY_PATTERNS = [
  /\b(roof|wall|loft|cavity)\s+insulation/i,
  /optimum\s+start\s*\/?\s*stop/i, /weather\s+compensation/i,
  /(time|zone|thermostatic)\s+control/i,
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

// ─── Fetch the set of LMK_KEYs already present in `prospects` — updates
// below are only ever attempted for keys in this set, matching how
// ingest-epc.mjs's region/floor-area filter already narrows what's written
// (a recommendations row for a certificate outside that filter has no
// prospect row to update, and at real scale is the vast majority of rows —
// see HANDOVER.md's ingest risk notes). Paginated the same way
// scripts/geocode-postcodes.mjs pages `prospects` (PostgREST's default
// max-rows cap requires paging past it explicitly). ─────────────────────

async function fetchExistingLmkKeys() {
  const keys = new Set();
  const PAGE = 1000; // PostgREST's default max-rows cap — must page past it explicitly
  let from = 0;
  while (true) {
    const { data, error } = await db
      .from('prospects')
      .select('epc_lmk_key')
      .not('epc_lmk_key', 'is', null)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(JSON.stringify(error));
    for (const row of data) keys.add(row.epc_lmk_key);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return keys;
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

  // CHUNK sizes an `.in('epc_lmk_key', chunk)` filter, which PostgREST
  // serializes into the PATCH request's URL query string (unlike
  // ingest-epc.mjs's CHUNK=500, which sizes an `.upsert()` request body —
  // no practical length limit there). EPC LMK_KEYs are ~24 chars each, so
  // keep this well under typical gateway URL-length limits (8-16KB).
  const CHUNK = 150;
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

  console.log('Fetching existing prospect LMK_KEYs...');
  const existingKeys = await fetchExistingLmkKeys();
  console.log(`Existing prospects with an epc_lmk_key: ${existingKeys.size}`);

  let rawCount = 0;
  let skippedNoMatch = 0;
  // lmk_key -> { solar, efficiency } — classified inline as each row is
  // read and OR-accumulated across multiple rows for the same key, so the
  // raw IMPROVEMENT_SUMMARY_TEXT strings are never retained past the row
  // they came from (at real scale, potentially 1M+ rows collapsing to two
  // booleans — retaining every string until a second pass would be a real
  // memory problem). Only keys already in `prospects` are kept at all.
  const flagsByKey = new Map();
  const unclassified = new Set(); // bounded by distinct unmatched strings, not row count

  for (const file of files) {
    console.log(`Reading ${file}...`);
    await parseCsvFile(file, (row, col) => {
      rawCount++;
      const lmkKey = String(row[col.lmk_key] ?? '').trim();
      const summary = String(row[col.improvement_summary] ?? '').trim();
      if (!lmkKey) return;
      if (!existingKeys.has(lmkKey)) { skippedNoMatch++; return; }
      const c = classify(summary);
      if (!c.solar && !c.efficiency) unclassified.add(summary);
      const prev = flagsByKey.get(lmkKey);
      flagsByKey.set(lmkKey, {
        solar: (prev?.solar ?? false) || c.solar,
        efficiency: (prev?.efficiency ?? false) || c.efficiency,
      });
    });
  }

  console.log(`Raw rows: ${rawCount}`);
  console.log(`Rows skipped (LMK_KEY not an existing prospect): ${skippedNoMatch}`);
  console.log(`Distinct LMK_KEYs matched to an existing prospect: ${flagsByKey.size}`);
  console.log(`Flagged solar: ${[...flagsByKey.values()].filter(f => f.solar).length}`);
  console.log(`Flagged efficiency: ${[...flagsByKey.values()].filter(f => f.efficiency).length}`);
  console.log(`Unclassified distinct summary texts (first 20): ${[...unclassified].slice(0, 20).join(' | ') || '(none)'}`);

  const matched = await applyFlags(flagsByKey);
  console.log(`Matched to existing prospects: ${matched}/${flagsByKey.size}`);
  console.log('Done.');
}

main().catch(e => { console.error(e); process.exit(1); });
