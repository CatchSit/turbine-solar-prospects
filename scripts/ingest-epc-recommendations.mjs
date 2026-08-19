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
