import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL              = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const GOOGLE_SOLAR_API_KEY      = Deno.env.get('GOOGLE_SOLAR_API_KEY')!

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !GOOGLE_SOLAR_API_KEY) {
  throw new Error('Missing required secrets — check SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GOOGLE_SOLAR_API_KEY')
}

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// Bounded per-invocation batch, to stay inside the Edge Function wall-clock
// timeout. Invoke this function repeatedly (manually, for the pilot) until
// no 'pending' rows remain — same "run until done" operational pattern as
// re-invoking mcs-scraper.
const BATCH_SIZE = 300
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

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
  const detected = /DETECTED(?!_NO|_ZERO)/i.test(detectionStatus) && !/NO_ARRAYS|NONE|ZERO/i.test(detectionStatus)
  return { detected, detectionStatus }
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

Deno.serve(async () => {
  console.log('=== Solar Enrichment ===')

  const { data: batch, error: fetchErr } = await db
    .from('prospects')
    .select('id, lat, lng')
    .eq('solar_status', 'pending')
    .not('lat', 'is', null)
    .not('lng', 'is', null)
    .limit(BATCH_SIZE)

  if (fetchErr) {
    console.error('Failed to fetch batch:', JSON.stringify(fetchErr))
    return new Response(JSON.stringify({ error: fetchErr }), { status: 500 })
  }

  const rows = (batch ?? []) as Prospect[]
  console.log(`Batch size: ${rows.length}`)

  const counts = { prospect: 0, has_solar: 0, no_coverage: 0, error: 0, rateLimited: 0 }

  for (const row of rows) {
    let result: SolarResult
    try {
      result = await checkBuilding(row.lat, row.lng)
    } catch (e) {
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

  console.log(`Done. prospect=${counts.prospect} has_solar=${counts.has_solar} no_coverage=${counts.no_coverage} error=${counts.error} rateLimited=${counts.rateLimited}`)
  return new Response(JSON.stringify({ processed: rows.length, ...counts }), { status: 200 })
})
