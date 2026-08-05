#!/usr/bin/env node
// Export the current `prospects` table to prospects.json and push it to
// GitHub via the Git Data API — same blob/tree/commit/ref-update flow as
// mcs-map's mcs-scraper/index.ts pushInstallerJson(), adapted to plain
// Node instead of Deno.
//
// Unlike mcs-scraper (which merges a partial fetch on top of the existing
// file), this always re-exports the full current table state from
// Supabase, so it's a straight overwrite — Supabase is the source of
// truth, not the JSON file.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... GITHUB_PAT=... GITHUB_REPO=owner/repo \
//     node scripts/export-prospects-json.mjs

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL              = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GITHUB_PAT                = process.env.GITHUB_PAT;
const GITHUB_REPO               = process.env.GITHUB_REPO; // 'owner/repo'
const GITHUB_BRANCH             = process.env.GITHUB_BRANCH || 'main';
const MAP_FILE                  = 'prospects.json';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !GITHUB_PAT || !GITHUB_REPO) {
  throw new Error('Missing one of SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / GITHUB_PAT / GITHUB_REPO env vars');
}

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const GITHUB_HEADERS = {
  Authorization:  `Bearer ${GITHUB_PAT}`,
  Accept:         'application/vnd.github.v3+json',
  'User-Agent':   'turbine-solar-prospects-export',
  'Content-Type': 'application/json',
};

function toMapRecord(row) {
  return {
    id:           row.id,
    address:      row.address,
    postcode:     row.postcode,
    lat:          row.lat,
    lng:          row.lng,
    property_type: row.property_type,
    floor_area:   row.total_floor_area,
    epc_rating:   row.current_energy_rating,
    local_authority: row.local_authority,
    solar_status: row.solar_status,
    solar_max_panels: row.solar_max_panels,
    solar_yearly_energy_kwh: row.solar_yearly_energy_kwh,
  };
}

async function fetchAllProspects() {
  const rows = [];
  const PAGE = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await db
      .from('prospects')
      .select('*')
      .not('lat', 'is', null)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(JSON.stringify(error));
    rows.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return rows;
}

// ─── GitHub — Git Data API (no base64 on our side) ───────────────────────

async function pushProspectsJson(content) {
  const blobResp = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/git/blobs`, {
    method: 'POST', headers: GITHUB_HEADERS,
    body: JSON.stringify({ content, encoding: 'utf-8' }),
  });
  if (!blobResp.ok) throw new Error(`Blob ${blobResp.status}: ${await blobResp.text()}`);
  const { sha: blobSha } = await blobResp.json();

  const refResp = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/git/refs/heads/${GITHUB_BRANCH}`, {
    headers: GITHUB_HEADERS,
  });
  if (!refResp.ok) throw new Error(`Ref ${refResp.status}: ${await refResp.text()}`);
  const { object: { sha: commitSha } } = await refResp.json();

  const commitResp = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/git/commits/${commitSha}`, {
    headers: GITHUB_HEADERS,
  });
  const { tree: { sha: treeSha } } = await commitResp.json();

  const newTreeResp = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/git/trees`, {
    method: 'POST', headers: GITHUB_HEADERS,
    body: JSON.stringify({ base_tree: treeSha, tree: [{ path: MAP_FILE, mode: '100644', type: 'blob', sha: blobSha }] }),
  });
  const { sha: newTreeSha } = await newTreeResp.json();

  const newCommitResp = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/git/commits`, {
    method: 'POST', headers: GITHUB_HEADERS,
    body: JSON.stringify({ message: 'chore: update prospects data [skip ci]', tree: newTreeSha, parents: [commitSha] }),
  });
  const { sha: newCommitSha } = await newCommitResp.json();

  const patchResp = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/git/refs/heads/${GITHUB_BRANCH}`, {
    method: 'PATCH', headers: GITHUB_HEADERS,
    body: JSON.stringify({ sha: newCommitSha }),
  });
  if (!patchResp.ok) throw new Error(`Ref update ${patchResp.status}: ${await patchResp.text()}`);
}

async function main() {
  console.log('Fetching prospects from Supabase...');
  const rows = await fetchAllProspects();
  console.log(`Fetched ${rows.length} geocoded prospects`);

  const json = JSON.stringify(rows.map(toMapRecord));
  await pushProspectsJson(json);
  console.log(`${MAP_FILE} pushed to ${GITHUB_REPO}@${GITHUB_BRANCH} — ${rows.length} records`);
}

main().catch(e => { console.error(e); process.exit(1); });
