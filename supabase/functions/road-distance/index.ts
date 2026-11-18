// road-distance: real road miles from the office to a lead (Greg, 2026-11-18).
//
// Called from crm.html with { prospect_id }. Used for fuel per installer on
// quote options (migration 072). The route comes from OpenRouteService
// (driving-car), the office postcode from app_settings
// crm_fuel_office_postcode (default DN5 7TR, Wader Lodge). The answer is
// saved on the lead (prospects.road_miles_from_office + the postcode it was
// worked out for), so each lead is only looked up again if its postcode
// changes.
//
// Secret: ORS_API_KEY (free key from openrouteservice.org), set by Greg in
// Supabase. Without it the function answers 503 and the CRM says the
// distance can't be worked out yet.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
// Checked inside the handler (not at load) so CORS preflights still work
// while the key is missing - same reasoning as company-lookup.
const ORS_API_KEY = Deno.env.get('ORS_API_KEY')

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const PROD_ORIGIN = 'https://catchsit.github.io'
function corsHeadersFor(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  }
  if (origin && (origin === PROD_ORIGIN || /^http:\/\/localhost(:\d+)?$/.test(origin))) {
    headers['Access-Control-Allow-Origin'] = origin
  }
  return headers
}

const METRES_PER_MILE = 1609.344

function normalizePostcode(pc: string): string {
  return (pc || '').trim().toUpperCase().replace(/\s+/g, '')
}

async function postcodeLatLng(pc: string): Promise<{ lat: number; lng: number } | null> {
  const r = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(normalizePostcode(pc))}`)
  if (!r.ok) return null
  const j = await r.json()
  if (!j?.result?.latitude) return null
  return { lat: j.result.latitude, lng: j.result.longitude }
}

Deno.serve(async (req) => {
  const CORS = corsHeadersFor(req.headers.get('Origin'))
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: CORS })
  if (!ORS_API_KEY) return json({ error: 'Road distance not set up yet (ORS_API_KEY missing)' }, 503)

  // Only signed-in Turbine accounts (public sign-up is enabled on the project).
  const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  })
  const { data: { user }, error: authErr } = await authClient.auth.getUser()
  if (authErr || !user || !user.email?.toLowerCase().endsWith('@turbineenergyuk.co.uk')) {
    return json({ error: 'Forbidden' }, 403)
  }

  let body: { prospect_id?: string }
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON body' }, 400) }
  if (!body.prospect_id) return json({ error: 'prospect_id is required' }, 400)

  // The destination always comes from the lead itself, never the request.
  const { data: lead, error: leadErr } = await db.from('prospects')
    .select('id, postcode, lat, lng, road_miles_from_office, road_miles_postcode')
    .eq('id', body.prospect_id).maybeSingle()
  if (leadErr) return json({ error: 'Lead lookup failed' }, 500)
  if (!lead) return json({ error: 'Lead not found' }, 404)

  const pc = normalizePostcode(lead.postcode || '')
  if (!pc) return json({ error: 'This lead has no postcode' }, 422)
  if (lead.road_miles_from_office != null && lead.road_miles_postcode === pc) {
    return json({ miles: Number(lead.road_miles_from_office), postcode: pc, cached: true })
  }

  const { data: setting } = await db.from('app_settings')
    .select('value').eq('key', 'crm_fuel_office_postcode').maybeSingle()
  const office = await postcodeLatLng(setting?.value || 'DN5 7TR')
  if (!office) return json({ error: 'Could not find the office postcode' }, 502)

  // Work from the current postcode: editing the postcode in crm.html does
  // not move the saved map position, so lat/lng can be out of date. The
  // saved position is only a fallback.
  const dest = (await postcodeLatLng(pc))
    ?? ((lead.lat != null && lead.lng != null) ? { lat: Number(lead.lat), lng: Number(lead.lng) } : null)
  if (!dest) return json({ error: 'Could not find the lead postcode' }, 422)

  const r = await fetch('https://api.openrouteservice.org/v2/directions/driving-car', {
    method: 'POST',
    headers: { 'Authorization': ORS_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      coordinates: [[office.lng, office.lat], [dest.lng, dest.lat]],
      // Postcode centres can sit off-road; let the start/end snap to the
      // nearest road within 2 km.
      radiuses: [2000, 2000],
    }),
  })
  if (!r.ok) {
    const text = (await r.text()).slice(0, 200)
    console.error('ORS error', r.status, text)
    return json({ error: 'Route planner could not find a route' }, 502)
  }
  const route = await r.json()
  const metres = route?.routes?.[0]?.summary?.distance
  if (typeof metres !== 'number') return json({ error: 'Route planner gave no distance' }, 502)
  const miles = Math.round((metres / METRES_PER_MILE) * 10) / 10

  const { error: saveErr } = await db.from('prospects').update({
    road_miles_from_office: miles,
    road_miles_postcode: pc,
    road_miles_checked_at: new Date().toISOString(),
  }).eq('id', lead.id)
  if (saveErr) console.error('save failed', saveErr.message)

  return json({ miles, postcode: pc, cached: false })
})
