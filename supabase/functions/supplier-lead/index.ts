import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// Lead supplier -> CRM lead (2026-10-21). Called server-to-server by a lead
// generation company each time they have a lead for us. Each supplier has
// its own API key (a function secret, sent in the x-api-key header), so one
// can be cut off without touching the others. verify_jwt is off for this
// function in config.toml. The key can only add leads: nothing here reads
// back, edits or deletes CRM data.
//
// Decisions (Greg, 2026-10-21): leads land unassigned; a lead matching an
// existing CRM lead (email or phone) is logged against it as a duplicate
// instead of being created again; the price per lead depends on the
// product, via one lead_origins entry per product (migration 055).
// Developer instructions for suppliers: docs/supplier-lead-api.md.

const SUPABASE_URL              = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing required secrets - check SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY')
}
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// One entry per supplier. products maps the product value they send to the
// lead_origins name (and so the price) it's recorded under. To add a
// supplier: add their lead_origins rows, an entry here, set their key with
// `npx supabase secrets set <KEY_SECRET>=...`, and redeploy.
const SUPPLIERS = [
  { name: 'Pockla', keySecret: 'POCKLA_API_KEY', products: { solar: 'Pockla - Solar', ashp: 'Pockla - ASHP' } as Record<string, string> },
]

const KNOWN_FIELDS = new Set(['product', 'name', 'email', 'phone', 'address', 'postcode', 'property_type', 'notes',
  'reference', 'consent_timestamp', 'consent_wording', 'source_url', 'test'])

function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b)
  if (ea.length !== eb.length) return false
  let diff = 0
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i]
  return diff === 0
}

const clip = (v: unknown, n = 500) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null)
const digits = (p: string | null) => (p || '').replace(/\D/g, '').slice(-10)

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

async function geocode(postcode: string | null) {
  if (!postcode) return null
  try {
    const r = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(postcode)}`, { signal: AbortSignal.timeout(6000) })
    const j = await r.json()
    return j.status === 200 ? j.result : null
  } catch { return null }
}

// Same matching as ingest-enquiry: email first, then the last 10 digits of
// the phone number. Deleted leads (048) don't count.
async function findExistingLead(email: string | null, phone: string | null): Promise<string | null> {
  if (email) {
    const { data } = await db.from('prospects').select('id').eq('source', 'manual').is('deleted_at', null).ilike('contact_email', email).limit(1)
    if (data?.length) return data[0].id
  }
  const want = digits(phone)
  if (want.length >= 9) {
    const { data } = await db.from('prospects').select('id, contact_phone').eq('source', 'manual').is('deleted_at', null).not('contact_phone', 'is', null)
    const hit = (data || []).find(p => digits(p.contact_phone) === want)
    if (hit) return hit.id
  }
  return null
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405)

  const given = req.headers.get('x-api-key') || ''
  const supplier = SUPPLIERS.find(s => {
    const key = Deno.env.get(s.keySecret)
    return !!key && timingSafeEqual(given, key)
  })
  if (!supplier) return json({ error: 'Missing or wrong x-api-key' }, 401)

  let b: Record<string, unknown>
  try { b = await req.json() } catch { return json({ error: 'The body must be JSON' }, 400) }
  if (!b || typeof b !== 'object' || Array.isArray(b)) return json({ error: 'The body must be one JSON object (one lead per request)' }, 400)

  const product = (clip(b.product, 40) || '').toLowerCase()
  const originName = supplier.products[product]
  const name = clip(b.name, 200)
  const email = clip(b.email, 200)?.toLowerCase() ?? null
  const phone = clip(b.phone, 60)
  const postcode = clip(b.postcode, 12)?.toUpperCase() ?? null
  const propertyType = (clip(b.property_type, 20) || 'home').toLowerCase()
  const consentAtRaw = clip(b.consent_timestamp, 60)
  const consentAt = consentAtRaw && !isNaN(Date.parse(consentAtRaw)) ? new Date(consentAtRaw).toISOString() : null

  const problems: string[] = []
  if (!originName) problems.push(`product must be one of: ${Object.keys(supplier.products).join(', ')}`)
  if (!name) problems.push('name is required')
  if (!email && !phone) problems.push('email or phone is required')
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) problems.push('email is not a valid address')
  if (!postcode) problems.push('postcode is required')
  if (!['home', 'business'].includes(propertyType)) problems.push('property_type must be home or business')
  if (!consentAt) problems.push('consent_timestamp is required (ISO 8601, e.g. 2026-10-21T14:05:00Z)')
  if (problems.length) return json({ error: 'Lead not accepted', problems }, 400)

  // Test mode: checks the request without saving anything.
  if (b.test === true) return json({ ok: true, test: true, message: 'This lead would be accepted. Nothing was saved.' }, 200)

  const reference = clip(b.reference, 200)
  if (reference) {
    const { data: seen } = await db.from('supplier_leads').select('id, is_new_lead')
      .eq('supplier', supplier.name).eq('external_ref', reference).maybeSingle()
    if (seen) return json({ ok: true, status: 'already_received', crm_reference: seen.id }, 200)
  }

  const { data: origin, error: originErr } = await db.from('lead_origins').select('id').ilike('name', originName).maybeSingle()
  if (originErr || !origin) {
    console.error('supplier-lead: lead origin missing', originName, originErr)
    return json({ error: 'Not set up yet on our side - please tell Turbine Energy' }, 503)
  }

  const address = clip(b.address, 500)
  const extra: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(b)) if (!KNOWN_FIELDS.has(k) && Object.keys(extra).length < 30) extra[k] = typeof v === 'string' ? v.slice(0, 1000) : v

  let prospectId = await findExistingLead(email, phone)
  const isNew = !prospectId
  if (isNew) {
    const geo = await geocode(postcode)
    const { data, error } = await db.from('prospects').insert({
      source: 'manual',
      region: 'yorkshire-humber',
      customer_name: name,
      lead_type: propertyType === 'business' ? 'commercial' : 'domestic',
      contact_phone: phone,
      contact_email: email,
      address,
      postcode: geo?.postcode ?? postcode,
      local_authority: geo?.admin_district ?? null,
      lat: geo?.latitude ?? null,
      lng: geo?.longitude ?? null,
      geocode_source: geo ? 'postcodes.io' : null,
      lead_origin_id: origin.id,     // the 049 trigger stamps lead_cost from it
      assigned_to_email: null,       // Greg assigns supplier leads
    }).select('id').single()
    if (error) { console.error('supplier-lead: prospect insert failed', error.message); return json({ error: 'Could not save the lead - please try again later' }, 500) }
    prospectId = data.id
  }

  const { data: logged, error: logErr } = await db.from('supplier_leads').insert({
    supplier: supplier.name, product, lead_origin_id: origin.id, prospect_id: prospectId, is_new_lead: isNew,
    external_ref: reference, name, email, phone, address, postcode, property_type: propertyType,
    notes: clip(b.notes, 5000), consent_at: consentAt, consent_wording: clip(b.consent_wording, 2000),
    source_url: clip(b.source_url, 1000), extra: Object.keys(extra).length ? extra : null,
  }).select('id').single()
  if (logErr) {
    // 23505: the same reference arrived twice at the same moment.
    if (logErr.code === '23505') return json({ ok: true, status: 'already_received' }, 200)
    console.error('supplier-lead: supplier_leads insert failed', logErr.message)
  }

  return json({ ok: true, status: isNew ? 'created' : 'duplicate', crm_reference: logged?.id ?? null }, isNew ? 201 : 200)
})
