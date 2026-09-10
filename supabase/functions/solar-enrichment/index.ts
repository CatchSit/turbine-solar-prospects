import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL              = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const SUPABASE_ANON_KEY         = Deno.env.get('SUPABASE_ANON_KEY')!
const GOOGLE_SOLAR_API_KEY      = Deno.env.get('GOOGLE_SOLAR_API_KEY')!

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_ANON_KEY || !GOOGLE_SOLAR_API_KEY) {
  throw new Error('Missing required secrets — check SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY, GOOGLE_SOLAR_API_KEY')
}

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// This function was originally only ever invoked via the CLI/curl, so it
// never needed CORS headers. dashboard.html now calls it directly from the
// browser (db.functions.invoke) to drive the "Solar enrichment" panel
// (2026-09-10) — without these, the browser blocks the response before
// supabase-js can read it, surfacing as the generic "Failed to send a
// request to the Edge Function". Same origin-echo pattern as
// company-lookup, the only other function called from the browser.
const PROD_ORIGIN = 'https://catchsit.github.io'

function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false
  if (origin === PROD_ORIGIN) return true
  return /^http:\/\/localhost(:\d+)?$/.test(origin)
}

function corsHeadersFor(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  }
  if (isAllowedOrigin(origin)) headers['Access-Control-Allow-Origin'] = origin as string
  return headers
}

// Bounded per-invocation batch, to stay inside the Edge Function wall-clock
// timeout. Invoke this function repeatedly (manually, for the pilot) until
// no 'pending' rows remain — same "run until done" operational pattern as
// re-invoking mcs-scraper.
const BATCH_SIZE = 300
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// Self-imposed budget, independent of whatever quota is configured in the
// Google Cloud console — the app must never rely solely on external config
// to stay inside the Solar API's 10,000/month free tier. Tracked in the
// api_usage table (migration 005) and enforced here regardless of what the
// console quota is set to.
const MONTHLY_CAP = 9500
const API_NAME = 'solar_buildingInsights'

function currentPeriod(): string {
  const now = new Date()
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
}

type Prospect = { id: string; lat: number; lng: number }

// ─── Google Solar API ───────────────────────────────────────────────────────
//
// buildingInsights.findClosest with additionalInsights=DETECTED_ARRAYS returns
// both roof solar potential AND (per Google's docs) a detection layer for
// existing rooftop arrays. The exact JSON path for the detection field is
// NOT independently verified against a live response as of writing — this
// function checks several plausible locations and always stores the full
// raw response in solar_raw, so misclassifications can be corrected later by
// reprocessing solar_raw without a second paid API call. Verify against a
// real response early in the pilot and tighten classifyDetection() if needed.

type SolarResult = {
  status: 'prospect' | 'has_solar' | 'no_coverage' | 'error'
  detectionStatus: string | null
  maxPanels: number | null
  yearlyEnergyKwh: number | null
  raw: unknown
}

// deno-lint-ignore no-explicit-any
function classifyDetection(json: any): { detected: boolean | null; detectionStatus: string | null } {
  const candidates = [
    json?.detectionStatus,
    json?.solarPotential?.detectionStatus,
    json?.detectedArrays?.detectionStatus,
    json?.buildingStats?.detectionStatus,
  ].filter(Boolean)
  const detectionStatus = candidates[0] ?? null
  if (!detectionStatus) return { detected: null, detectionStatus: null }

  if (/NO_ARRAYS|NONE|ZERO/i.test(detectionStatus)) return { detected: false, detectionStatus }
  if (/DETECTED/i.test(detectionStatus)) return { detected: true, detectionStatus }

  // Unrecognized status (e.g. an UNSPECIFIED enum default) — don't guess,
  // fall through to 'error' so it gets flagged for review instead of
  // silently becoming a lead.
  return { detected: null, detectionStatus }
}

// deno-lint-ignore no-explicit-any
function extractRoofStats(json: any): { maxPanels: number | null; yearlyEnergyKwh: number | null } {
  const maxPanels = json?.solarPotential?.maxArrayPanelsCount ?? null
  const configs = json?.solarPotential?.solarPanelConfigs ?? []
  const best = configs.length
    ? configs.reduce((a: any, b: any) => (b.panelsCount > a.panelsCount ? b : a))
    : null
  const yearlyEnergyKwh = best?.yearlyEnergyDcKwh ?? null
  return { maxPanels, yearlyEnergyKwh }
}

async function checkBuilding(lat: number, lng: number): Promise<SolarResult> {
  const url = new URL('https://solar.googleapis.com/v1/buildingInsights:findClosest')
  url.searchParams.set('location.latitude', String(lat))
  url.searchParams.set('location.longitude', String(lng))
  url.searchParams.set('requiredQuality', 'HIGH')
  url.searchParams.set('additionalInsights', 'DETECTED_ARRAYS')
  url.searchParams.set('key', GOOGLE_SOLAR_API_KEY)

  const resp = await fetch(url)

  if (resp.status === 404) {
    return { status: 'no_coverage', detectionStatus: null, maxPanels: null, yearlyEnergyKwh: null, raw: null }
  }
  if (resp.status === 429) {
    throw new Error('RATE_LIMITED')
  }
  if (!resp.ok) {
    const body = await resp.text()
    return { status: 'error', detectionStatus: null, maxPanels: null, yearlyEnergyKwh: null, raw: { httpStatus: resp.status, body } }
  }

  const json = await resp.json()
  const { detected, detectionStatus } = classifyDetection(json)
  const { maxPanels, yearlyEnergyKwh } = extractRoofStats(json)

  return {
    status: detected === null ? 'error' : detected ? 'has_solar' : 'prospect',
    detectionStatus,
    maxPanels,
    yearlyEnergyKwh,
    raw: json,
  }
}

// ─── Main handler ─────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  const origin = req.headers.get('Origin')
  const CORS_HEADERS = corsHeadersFor(origin)

  function jsonResponse(body: unknown, status: number): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    })
  }

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: CORS_HEADERS })
  }

  console.log('=== Solar Enrichment ===')

  // This function's own verify_jwt=true only checks that *some* valid
  // Supabase JWT was presented — the public anon key (embedded client-side
  // in index.html) satisfies that trivially. Re-verify the caller is an
  // actual signed-in Turbine Energy rep, same pattern as company-lookup,
  // so this isn't callable by anyone who's viewed the page source — it can
  // burn real Google Solar API budget and (via diagnostic modes) read
  // prospect data. Added 2026-09-09 after noticing the gap while adding
  // the test/areaCounts diagnostic modes.
  const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  })
  const { data: { user }, error: authErr } = await authClient.auth.getUser()
  if (authErr || !user || !user.email?.toLowerCase().endsWith('@turbineenergyuk.co.uk')) {
    return jsonResponse({ error: 'Unauthorized' }, 401)
  }

  const period = currentPeriod()
  const { data: usageRow, error: usageErr } = await db
    .from('api_usage')
    .select('request_count')
    .eq('api_name', API_NAME)
    .eq('period', period)
    .maybeSingle()

  if (usageErr) {
    console.error('Failed to read api_usage:', JSON.stringify(usageErr))
    return jsonResponse({ error: usageErr }, 500)
  }

  let usedThisPeriod = usageRow?.request_count ?? 0
  if (!usageRow) {
    await db.from('api_usage').insert({ api_name: API_NAME, period, request_count: 0 })
  }

  const remainingBudget = MONTHLY_CAP - usedThisPeriod
  if (remainingBudget <= 0) {
    console.warn(`Monthly Solar API budget (${MONTHLY_CAP}) exhausted for ${period} — used=${usedThisPeriod}`)
    return jsonResponse({ processed: 0, budgetExhausted: true, period, usedThisPeriod }, 200)
  }

  // Billing-check mode: POST {"test": true} to make exactly one real Solar
  // API call against a fixed known UK building (Leeds Town Hall — always
  // has coverage) instead of a full batch. Touches no prospects rows, only
  // the same api_usage counter a real call would. Added 2026-09-09 so
  // whether Google Cloud billing is actually enabled can be confirmed
  // without risking a wasted ~300-row batch against a bill that isn't
  // really on yet (HANDOVER.md Section 1, item 1).
  const body = await req.json().catch(() => null)

  // Read-only diagnostic mode: POST {"areaCounts": true} to see how many
  // 'pending' rows (eligible for enrichment — solar_status='pending', has
  // lat/lng) sit in each of the four named grant areas, so a batch can be
  // sized/targeted by area before spending real API budget on it. No
  // Google API calls, no writes — just counts. Added 2026-09-09.
  if (body?.areaCounts === true) {
    const AREAS = ['Barnsley', 'Doncaster', 'Rotherham', 'Sheffield']
    const counts: Record<string, number> = {}
    for (const area of AREAS) {
      const { count, error } = await db.from('prospects')
        .select('id', { count: 'exact', head: true })
        .eq('solar_status', 'pending')
        .not('lat', 'is', null)
        .not('lng', 'is', null)
        .eq('local_authority', area)
      if (error) return jsonResponse({ areaCounts: true, error }, 500)
      counts[area] = count ?? 0
    }
    const { count: totalCount, error: totalErr } = await db.from('prospects')
      .select('id', { count: 'exact', head: true })
      .eq('solar_status', 'pending')
      .not('lat', 'is', null)
      .not('lng', 'is', null)
    if (totalErr) return jsonResponse({ areaCounts: true, error: totalErr }, 500)
    counts['Other'] = (totalCount ?? 0) - AREAS.reduce((sum, a) => sum + counts[a], 0)
    counts['Total pending'] = totalCount ?? 0
    return jsonResponse({ areaCounts: true, counts, monthlyCap: MONTHLY_CAP, usedThisPeriod, remainingBudget, period }, 200)
  }

  if (body?.test === true) {
    const TEST_LAT = 53.7997
    const TEST_LNG = -1.5492
    let result: SolarResult
    try {
      result = await checkBuilding(TEST_LAT, TEST_LNG)
    } catch (e) {
      usedThisPeriod++
      await db.from('api_usage').update({
        request_count: usedThisPeriod, updated_at: new Date().toISOString(),
      }).eq('api_name', API_NAME).eq('period', period)
      return jsonResponse({ test: true, billingEnabled: false, error: String(e) }, 200)
    }
    usedThisPeriod++
    await db.from('api_usage').update({
      request_count: usedThisPeriod, updated_at: new Date().toISOString(),
    }).eq('api_name', API_NAME).eq('period', period)
    return jsonResponse({
      test: true,
      billingEnabled: result.status !== 'error',
      status: result.status,
      detectionStatus: result.detectionStatus,
      rawErrorBody: result.status === 'error' ? result.raw : undefined,
    }, 200)
  }

  // Optional area targeting: POST {"areas": ["Doncaster","Sheffield"]} to
  // restrict this batch to specific local authorities (e.g. running the
  // areas with grant funding currently available first) instead of
  // whatever 'pending' rows sort first nationwide. Added 2026-09-10.
  let batchQuery = db
    .from('prospects')
    .select('id, lat, lng')
    .eq('solar_status', 'pending')
    .not('lat', 'is', null)
    .not('lng', 'is', null)
  if (Array.isArray(body?.areas) && body.areas.length) {
    batchQuery = batchQuery.in('local_authority', body.areas)
  }
  const { data: batch, error: fetchErr } = await batchQuery
    .limit(Math.min(BATCH_SIZE, remainingBudget))

  if (fetchErr) {
    console.error('Failed to fetch batch:', JSON.stringify(fetchErr))
    return jsonResponse({ error: fetchErr }, 500)
  }

  const rows = (batch ?? []) as Prospect[]
  console.log(`Batch size: ${rows.length} (budget remaining this period: ${remainingBudget})`)

  const counts = { prospect: 0, has_solar: 0, no_coverage: 0, error: 0, rateLimited: 0 }

  for (const row of rows) {
    let result: SolarResult
    try {
      result = await checkBuilding(row.lat, row.lng)
    } catch (e) {
      // checkBuilding always issues the fetch before it can throw, so this
      // attempt still counts against the Solar API budget.
      usedThisPeriod++
      await db.from('api_usage').update({
        request_count: usedThisPeriod, updated_at: new Date().toISOString(),
      }).eq('api_name', API_NAME).eq('period', period)

      if (e instanceof Error && e.message === 'RATE_LIMITED') {
        console.warn(`Rate limited at id=${row.id} — stopping run, remaining rows stay pending`)
        counts.rateLimited++
        break
      }
      console.warn(`Error checking id=${row.id}:`, e)
      counts.error++
      await db.from('prospects').update({
        solar_status: 'error', solar_checked_at: new Date().toISOString(),
        solar_raw: { error: String(e) },
      }).eq('id', row.id)
      continue
    }

    usedThisPeriod++
    await db.from('api_usage').update({
      request_count: usedThisPeriod, updated_at: new Date().toISOString(),
    }).eq('api_name', API_NAME).eq('period', period)

    counts[result.status]++
    const { error: updErr } = await db.from('prospects').update({
      solar_status:            result.status,
      solar_checked_at:        new Date().toISOString(),
      solar_detection_status:  result.detectionStatus,
      solar_max_panels:        result.maxPanels,
      solar_yearly_energy_kwh: result.yearlyEnergyKwh,
      solar_raw:               result.raw,
    }).eq('id', row.id)
    if (updErr) console.error(`Update failed for id=${row.id}:`, JSON.stringify(updErr))

    await sleep(150) // courtesy pacing on a paid external API, mirrors mcs-scraper's sleep(100)
  }

  console.log(`Done. prospect=${counts.prospect} has_solar=${counts.has_solar} no_coverage=${counts.no_coverage} error=${counts.error} rateLimited=${counts.rateLimited} usedThisPeriod=${usedThisPeriod}/${MONTHLY_CAP}`)
  return jsonResponse({ processed: rows.length, ...counts, period, usedThisPeriod, monthlyCap: MONTHLY_CAP }, 200)
})
