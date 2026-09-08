import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL              = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const SUPABASE_ANON_KEY         = Deno.env.get('SUPABASE_ANON_KEY')!

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_ANON_KEY) {
  throw new Error('Missing required secrets — check SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY')
}

// INSTALL_HUB_SHARED_SECRET is deliberately NOT asserted at module load —
// see company-lookup's identical comment re: COMPANIES_HOUSE_API_KEY. Same
// reasoning applies: don't crash the whole Deno worker (breaking even the
// CORS preflight) over a human-registered secret that may not be set yet.
const INSTALL_HUB_SHARED_SECRET = Deno.env.get('INSTALL_HUB_SHARED_SECRET')

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// install-hub is a separate app and a separate Supabase project
// (installer scheduling/ops — wpdrnviihmjfhleoavur.supabase.co) — Turbine
// Energy reps have no account there, so the cross-project call is
// authenticated with a shared secret (INSTALL_HUB_SHARED_SECRET, set as a
// secret on both projects), not a user session. See install-hub's
// supabase/functions/ingest-lead/index.ts for the receiving side.
// INSTALL_HUB_ORG_ID is install-hub's own Turbine Energy tenant
// (organisations.id), created 2026-09-08 — not sensitive, just an
// identifier, safe to hardcode here rather than treat as a secret.
const INSTALL_HUB_INGEST_URL = 'https://wpdrnviihmjfhleoavur.supabase.co/functions/v1/ingest-lead'
const INSTALL_HUB_ORG_ID = '7beff560-5455-4748-bc8c-810e2a6ed42d'

// Same CORS approach as company-lookup — this function is called
// cross-origin from the browser (window.db.functions.invoke), so every
// response (including error paths) needs these headers or the browser
// blocks it before the frontend sees anything.
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

function titleFor(leadType: string | null, customerName: string): string {
  const kind = leadType === 'commercial' ? 'Commercial' : leadType === 'domestic' ? 'Domestic' : 'Solar'
  return `${kind} Solar Install — ${customerName}`
}

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

  if (!INSTALL_HUB_SHARED_SECRET) {
    return jsonResponse({ error: 'Unavailable — INSTALL_HUB_SHARED_SECRET not configured' }, 503)
  }

  // Caller-identity check, same pattern as company-lookup: verify the
  // request's own JWT rather than trusting "authenticated" alone (public
  // email signup is enabled on this Supabase project).
  const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  })
  const { data: { user }, error: authErr } = await authClient.auth.getUser()
  if (authErr || !user || !user.email?.toLowerCase().endsWith('@turbineenergyuk.co.uk')) {
    return jsonResponse({ error: 'Forbidden' }, 403)
  }

  let body: { prospect_id?: string; scheduled_date?: string }
  try {
    body = await req.json()
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400)
  }

  const { prospect_id, scheduled_date } = body
  if (!prospect_id || !scheduled_date) {
    return jsonResponse({ error: 'prospect_id and scheduled_date are required' }, 400)
  }

  // Lead details are looked up server-side, never taken from the request
  // body — same reasoning as company-lookup's postcode lookup: otherwise
  // this is an authenticated-but-undomain-checked proxy for writing
  // arbitrary customer/job data into install-hub.
  const { data: prospect, error: prospectErr } = await db
    .from('prospects')
    .select('id, source, customer_name, lead_type, contact_phone, contact_email, address, postcode, install_hub_job_id')
    .eq('id', prospect_id)
    .maybeSingle()

  if (prospectErr) {
    console.error('Prospect lookup failed:', JSON.stringify(prospectErr))
    return jsonResponse({ error: 'Prospect lookup failed' }, 500)
  }
  if (!prospect) {
    return jsonResponse({ error: 'Prospect not found' }, 404)
  }
  if (prospect.source !== 'manual' || !prospect.customer_name) {
    return jsonResponse({ error: 'Only manual leads with a customer name can be sent to install-hub' }, 400)
  }
  if (prospect.install_hub_job_id) {
    return jsonResponse({ error: 'Already sent to install-hub' }, 409)
  }

  let ingestResp: Response
  try {
    ingestResp = await fetch(INSTALL_HUB_INGEST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Ingest-Secret': INSTALL_HUB_SHARED_SECRET },
      body: JSON.stringify({
        organisation_id: INSTALL_HUB_ORG_ID,
        customer: {
          full_name: prospect.customer_name,
          email: prospect.contact_email,
          phone: prospect.contact_phone,
          address: prospect.address,
          postcode: prospect.postcode,
        },
        job: {
          title: titleFor(prospect.lead_type, prospect.customer_name),
          address: prospect.address || prospect.postcode || 'Address not provided',
          customer_name: prospect.customer_name,
          customer_phone: prospect.contact_phone,
          scheduled_date,
        },
      }),
    })
  } catch (e) {
    console.error('install-hub call failed:', e)
    return jsonResponse({ error: 'Could not reach install-hub' }, 502)
  }

  const ingestJson = await ingestResp.json().catch(() => null)
  if (!ingestResp.ok || !ingestJson?.job_id) {
    console.error('install-hub ingest failed:', ingestResp.status, JSON.stringify(ingestJson))
    return jsonResponse({ error: ingestJson?.error || 'install-hub rejected the request' }, 502)
  }

  const { error: updateErr } = await db.from('prospects').update({
    install_hub_customer_id: ingestJson.customer_id,
    install_hub_job_id: ingestJson.job_id,
    sent_to_install_hub_at: new Date().toISOString(),
    sent_to_install_hub_by_email: user.email,
  }).eq('id', prospect_id)

  if (updateErr) {
    // The install-hub job genuinely exists at this point — report success
    // rather than risk a rep re-sending and creating a duplicate job over
    // there. Log loudly instead so this doesn't go unnoticed.
    console.error('Sent to install-hub but failed to record it locally:', JSON.stringify(updateErr))
  }

  return jsonResponse({ customer_id: ingestJson.customer_id, job_id: ingestJson.job_id }, 200)
})
