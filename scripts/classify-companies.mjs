#!/usr/bin/env node
// Bulk-classify every prospect's most-relevant matched company by SIC codes,
// incorporation date, and accounts-filing status — powers the sector/maturity
// sidebar filters and popup tags (shared/sic-sector-config.js,
// shared/company-maturity-config.js). See
// docs/superpowers/specs/2026-08-20-company-sector-maturity-classification-design.md
// for why this is a plain script (Companies House has no monthly cap, only a
// rate limit, so unlike solar-enrichment this can run to completion in one
// long sitting instead of needing repeated manual invocations over months).
//
// Usage:
//   COMPANIES_HOUSE_API_KEY=... SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/classify-companies.mjs
//
// Idempotent: only processes prospects with no existing company_classifications
// row, so an interrupted run can just be re-started with no special resume logic.

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL              = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const COMPANIES_HOUSE_API_KEY   = process.env.COMPANIES_HOUSE_API_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !COMPANIES_HOUSE_API_KEY) {
  throw new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / COMPANIES_HOUSE_API_KEY env vars');
}
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ─── Tunables ──────────────────────────────────────────────────────────────

// Companies House free tier: 600 requests/5 min (~2/sec sustained). 600ms
// between calls targets ~1.67/sec — comfortable margin, not the ceiling.
const SLEEP_MS = 600;
const MAX_RATE_LIMIT_RETRIES = 5;
const RATE_LIMIT_BACKOFF_MS = 30_000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Companies House helpers (verbatim port of company-lookup/index.ts's
// pure ranking logic — already exercised by that function; not shared
// cross-runtime between Deno and Node, see the design spec's Non-goals) ────

function normalizePostcode(pc) {
  return pc.trim().toUpperCase().replace(/\s+/g, '');
}

function leadingNumber(text) {
  const m = typeof text === 'string' ? text.match(/\d+/) : null;
  return m ? parseInt(m[0], 10) : null;
}

function isAddressMatch(prospectAddress, candidate) {
  const prospectToken = prospectAddress.split(',')[0];
  const chToken = candidate.address?.premises || candidate.address?.address_line_1;
  const prospectNumber = leadingNumber(prospectToken);
  const chNumber = leadingNumber(chToken);
  return prospectNumber !== null && chNumber !== null && prospectNumber === chNumber;
}

function rankByAddressMatch(prospectAddress, candidates) {
  return candidates
    .map(c => ({ ...c, address_match: isAddressMatch(prospectAddress, c) }))
    .sort((a, b) => Number(b.address_match) - Number(a.address_match));
}

function authHeader() {
  return { Authorization: 'Basic ' + btoa(COMPANIES_HOUSE_API_KEY + ':') };
}

async function fetchWithRateLimitRetry(url, options) {
  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
    const resp = await fetch(url, options);
    if (resp.status !== 429) return resp;
    console.warn(`  rate limited, backing off ${RATE_LIMIT_BACKOFF_MS}ms (attempt ${attempt + 1}/${MAX_RATE_LIMIT_RETRIES})`);
    await sleep(RATE_LIMIT_BACKOFF_MS);
  }
  throw new Error('RATE_LIMITED_RETRIES_EXHAUSTED');
}

async function searchCompaniesHouse(postcode) {
  const url = new URL('https://api.company-information.service.gov.uk/search/companies');
  url.searchParams.set('q', postcode);
  url.searchParams.set('items_per_page', '20');
  const resp = await fetchWithRateLimitRetry(url, { headers: authHeader() });
  await sleep(SLEEP_MS);
  if (!resp.ok) throw new Error(`Companies House search failed: ${resp.status}`);
  const json = await resp.json();
  return json.items ?? [];
}

async function fetchProfile(companyNumber) {
  const resp = await fetchWithRateLimitRetry(
    `https://api.company-information.service.gov.uk/company/${companyNumber}`,
    { headers: authHeader() },
  );
  await sleep(SLEEP_MS);
  if (!resp.ok) return null;
  const json = await resp.json();
  return {
    sic_codes: json.sic_codes ?? [],
    incorporated_on: json.date_of_creation ?? null,
    accounts_type: json.accounts?.last_accounts?.type ?? null, // unverified path, see HANDOVER/spec
  };
}

// ─── Step 1: find prospects still needing classification ──────────────────

async function fetchPendingProspects() {
  const PAGE = 1000;
  const prospects = [];
  let from = 0;
  while (true) {
    const { data, error } = await db.from('prospects')
      .select('id, address, postcode')
      .not('postcode', 'is', null)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(JSON.stringify(error));
    prospects.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }

  const classified = new Set();
  from = 0;
  while (true) {
    const { data, error } = await db.from('company_classifications')
      .select('prospect_id')
      .range(from, from + PAGE - 1);
    if (error) throw new Error(JSON.stringify(error));
    data.forEach(row => classified.add(row.prospect_id));
    if (data.length < PAGE) break;
    from += PAGE;
  }

  const pending = prospects.filter(p => !classified.has(p.id));
  console.log(`${prospects.length} prospects with a postcode, ${classified.size} already classified, ${pending.length} pending`);
  return pending;
}

// ─── Step 2: classify one prospect ─────────────────────────────────────────

async function classifyOne(prospect) {
  const normalizedTarget = normalizePostcode(prospect.postcode);
  let results;
  try {
    results = await searchCompaniesHouse(prospect.postcode);
  } catch (e) {
    console.error(`  ${prospect.id}: search failed, skipping (will retry on next run) — ${e.message}`);
    return;
  }

  const activeMatches = results.filter(r =>
    r.address?.postal_code &&
    normalizePostcode(r.address.postal_code) === normalizedTarget &&
    r.company_status === 'active'
  );

  if (activeMatches.length === 0) {
    const { error } = await db.from('company_classifications')
      .upsert({ prospect_id: prospect.id, no_match: true }, { onConflict: 'prospect_id' });
    if (error) console.error(`  ${prospect.id}: no-match upsert failed — ${JSON.stringify(error)}`);
    return;
  }

  const top = rankByAddressMatch(prospect.address || '', activeMatches)[0];
  const profile = await fetchProfile(top.company_number);
  if (!profile) {
    console.error(`  ${prospect.id}: profile fetch failed, skipping (will retry on next run)`);
    return;
  }

  const { error } = await db.from('company_classifications').upsert({
    prospect_id: prospect.id,
    no_match: false,
    company_name: top.title,
    company_number: top.company_number,
    sic_codes: profile.sic_codes,
    incorporated_on: profile.incorporated_on,
    accounts_type: profile.accounts_type,
  }, { onConflict: 'prospect_id' });
  if (error) console.error(`  ${prospect.id}: upsert failed — ${JSON.stringify(error)}`);
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const pending = await fetchPendingProspects();
  for (let i = 0; i < pending.length; i++) {
    await classifyOne(pending[i]);
    if ((i + 1) % 100 === 0) console.log(`  ${i + 1}/${pending.length} processed`);
  }
  console.log('Done.');
}

main().catch(e => { console.error(e); process.exit(1); });
