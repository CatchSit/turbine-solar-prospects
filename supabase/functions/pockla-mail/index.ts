// Pockla appointment emails -> CRM leads (Greg, 2026-11-25, migration 081).
//
// Run every 10 minutes by pg_cron (migration 082) with MAIL_SYNC_SECRET in
// x-sync-secret (verify_jwt off). Reads greg@ with the same read-only
// Microsoft app as mail-sync; it never changes the mailbox.
//
// Greg's rules: only emails that arrive after switch-on; leads land
// unassigned, from "Pockla - Solar"; logged as Meeting Booked with the date
// and time; a lead already in the CRM is logged against, not created again;
// the customer is NOT emailed here: the booking waits in the CRM until a
// manager has checked we're free and presses Confirm call (pockla-confirm).
// Cancellations and reschedules are done by hand.
//
// Body options: {"dry_run": true} checks the latest emails and saves
// nothing (no customer details returned); {"preview_to":
// "x@turbineenergyuk.co.uk"} sends a sample confirmation to one of us.
//
// Keep ASCII-only.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { POCKLA_SENDER, POCKLA_SUBJECT, parseAppointment, senderVerified, confirmationEmail, londonNow, clock, type Appointment } from '../_shared/pockla-email.ts'
import { sendFromInfo } from '../_shared/brevo.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const SYNC_SECRET = Deno.env.get('MAIL_SYNC_SECRET')
const MS_TENANT_ID = Deno.env.get('MS_TENANT_ID')
const MS_CLIENT_ID = Deno.env.get('MS_CLIENT_ID')
const MS_CLIENT_SECRET = Deno.env.get('MS_CLIENT_SECRET')
const BREVO_API_KEY = Deno.env.get('BREVO_API_KEY')
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const MAILBOX = 'greg@turbineenergyuk.co.uk'
const ORIGIN_NAME = 'Pockla - Solar'
const EMPLOYEE = 'Pockla (automatic)'
const MAX_PER_RUN = 20
const STUCK_AFTER_MINUTES = 15

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b)
  if (ea.length !== eb.length) return false
  let diff = 0
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i]
  return diff === 0
}

async function graphToken(): Promise<string> {
  const r = await fetch(`https://login.microsoftonline.com/${MS_TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: MS_CLIENT_ID!, client_secret: MS_CLIENT_SECRET!, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }),
    signal: AbortSignal.timeout(30000),
  })
  const j = await r.json()
  if (!r.ok || !j.access_token) throw new Error(`Microsoft sign-in failed: ${j.error || r.status}`)
  return j.access_token
}

async function graphGet(token: string, url: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) })
    if (r.status === 429 || r.status >= 500) {
      await new Promise(res => setTimeout(res, Math.min(20, Number(r.headers.get('Retry-After')) || 2 ** attempt * 2) * 1000))
      continue
    }
    const j = await r.json()
    if (!r.ok) throw new Error(`Graph ${r.status}: ${j?.error?.code || ''}`)
    return j
  }
  throw new Error('Graph: too many retries')
}

type Msg = {
  id: string; internetMessageId?: string; subject?: string; receivedDateTime: string; webLink?: string
  from?: { emailAddress?: { address?: string } }; body?: { content?: string }
  internetMessageHeaders?: { name: string; value: string }[]
}
const userUrl = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(MAILBOX)}/messages`
const fromPockla = (m: Msg) => (m.from?.emailAddress?.address || '').toLowerCase() === POCKLA_SENDER

// receivedDateTime comes first in the filter because Graph needs the sorted
// field there. The sender is checked again here, exactly.
async function listMessages(token: string, since: string, order: 'asc' | 'desc', top: number): Promise<Msg[]> {
  const filter = `receivedDateTime ge ${new Date(since).toISOString()} and from/emailAddress/address eq '${POCKLA_SENDER}'`
  const page = await graphGet(token, `${userUrl}?$filter=${encodeURIComponent(filter)}&$orderby=receivedDateTime ${order}&$top=${top}` +
    `&$select=id,internetMessageId,subject,from,receivedDateTime`)
  return ((page.value || []) as Msg[]).filter(fromPockla)
}
const fullMessage = (token: string, id: string): Promise<Msg> =>
  graphGet(token, `${userUrl}/${encodeURIComponent(id)}?$select=id,internetMessageId,subject,from,receivedDateTime,webLink,body,internetMessageHeaders`)

const digits = (p: string | null) => (p || '').replace(/\D/g, '').slice(-10)

// Same matching as supplier-lead: email, then the last 10 digits of the phone.
async function findExistingLead(email: string | null, phone: string | null): Promise<string | null> {
  if (email) {
    const { data, error } = await db.from('prospects').select('id').eq('source', 'manual').is('deleted_at', null)
      .ilike('contact_email', email.replace(/[\\%_]/g, c => '\\' + c)).limit(1)
    if (error) throw new Error(`Looking up the lead failed: ${error.message}`)
    if (data?.length) return data[0].id
  }
  const want = digits(phone)
  if (want.length < 10) return null
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from('prospects').select('id, contact_phone').eq('source', 'manual').is('deleted_at', null)
      .not('contact_phone', 'is', null).order('id').range(from, from + 999)
    if (error) throw new Error(`Looking up the lead failed: ${error.message}`)
    const hit = (data || []).find(p => digits(p.contact_phone) === want)
    if (hit) return hit.id
    if (!data || data.length < 1000) return null
  }
}

async function geocode(postcode: string) {
  try {
    const r = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(postcode)}`, { signal: AbortSignal.timeout(6000) })
    const j = await r.json()
    return j.status === 200 ? j.result : null
  } catch { return null }
}

// Outcomes a Pockla booking may move on to Meeting Booked. Anything further
// along (quoted, won, closed) is left where it is.
const EARLY = new Set(['No Answer', 'Left Message', 'Follow Up', 'Info Sent', 'Meeting Booked'])

type ImportRow = { id: string; prospect_id: string | null; is_new_lead: boolean | null; contact_id: string | null; email_status: string | null }
const IMPORT_COLS = 'id, prospect_id, is_new_lead, contact_id, email_status'

async function save(id: string, patch: Record<string, unknown>) {
  const { error } = await db.from('pockla_imports').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id)
  if (error) throw new Error(`Saving the import record failed: ${error.message}`)
}

// Each email is claimed once (unique message id). A claim left by a run that
// was cut off is picked up again, continuing from what it had already saved.
async function claim(m: Msg): Promise<ImportRow | null> {
  const key = m.internetMessageId || m.id
  const { data, error } = await db.from('pockla_imports')
    .insert({ internet_message_id: key, received_at: m.receivedDateTime, status: 'processing' }).select(IMPORT_COLS).single()
  if (!error) return data
  if (error.code !== '23505') throw new Error(`Saving the import record failed: ${error.message}`)
  const { data: retaken, error: retakeErr } = await db.from('pockla_imports').update({ updated_at: new Date().toISOString() })
    .eq('internet_message_id', key).eq('status', 'processing')
    .lt('updated_at', new Date(Date.now() - STUCK_AFTER_MINUTES * 60000).toISOString()).select(IMPORT_COLS)
  if (retakeErr) throw new Error(retakeErr.message)
  if (retaken?.length) return retaken[0]
  const { data: now } = await db.from('pockla_imports').select('status').eq('internet_message_id', key).maybeSingle()
  if (!now || now.status === 'processing') throw new Error('An earlier run is still on this email')
  return null
}

// Throws when it should be tried again on the next run.
async function importOne(token: string, listed: Msg, originId: string): Promise<string> {
  const row = await claim(listed)
  if (!row) return 'already done'
  const m = await fullMessage(token, listed.id)
  if ((m.subject || '').trim() !== POCKLA_SUBJECT) {
    await save(row.id, { status: 'ignored', error: 'Not a new appointment email', web_link: m.webLink })
    return 'ignored'
  }
  if (!senderVerified(m.internetMessageHeaders)) {
    await save(row.id, { status: 'unverified', error: "Microsoft couldn't confirm this came from Pockla", web_link: m.webLink })
    return 'unverified'
  }
  let a: Appointment
  try {
    a = parseAppointment(m.body?.content || '')
  } catch (e) {
    await save(row.id, { status: 'failed', error: (e as Error).message.slice(0, 300), web_link: m.webLink })
    return 'failed'
  }
  await save(row.id, { reference: a.reference, appointment_date: a.date, appointment_time: a.time, outside_hours: a.outsideHours, web_link: m.webLink })

  // The same booking sent twice: keep the first.
  const { data: earlier, error: earlierErr } = await db.from('pockla_imports').select('id')
    .eq('reference', a.reference).neq('id', row.id).eq('status', 'done').limit(1)
  if (earlierErr) throw new Error(earlierErr.message)
  if (earlier?.length) {
    await save(row.id, { status: 'repeat', error: `${a.reference} was already imported. Check whether the time has changed.` })
    return 'repeat'
  }

  // 1. The lead
  let prospectId = row.prospect_id, isNew = row.is_new_lead
  if (!prospectId) {
    prospectId = await findExistingLead(a.email, a.phone)
    isNew = !prospectId
    if (!prospectId) {
      const geo = await geocode(a.postcode)
      const { data, error } = await db.from('prospects').insert({
        source: 'manual', region: 'yorkshire-humber', customer_name: a.name, lead_type: 'domestic', product: 'solar',
        contact_phone: a.phone, contact_email: a.email, address: a.address, postcode: geo?.postcode ?? a.postcode,
        local_authority: geo?.admin_district ?? null, lat: geo?.latitude ?? null, lng: geo?.longitude ?? null,
        geocode_source: geo ? 'postcodes.io' : null, lead_origin_id: originId, assigned_to_email: null,
      }).select('id').single()
      if (error) throw new Error(`Adding the lead failed: ${error.message}`)
      prospectId = data.id as string
    }
    await save(row.id, { prospect_id: prospectId, is_new_lead: isNew })
  }

  // 2. The delivery record (what the lead page's timeline shows)
  const about = a.about.map(([l, v]) => `${l}: ${v}`)
  const { error: slErr } = await db.from('supplier_leads').insert({
    supplier: 'Pockla', product: 'solar', lead_origin_id: originId, prospect_id: prospectId, is_new_lead: isNew,
    external_ref: a.reference, name: a.name, email: a.email, phone: a.phone, address: a.address, postcode: a.postcode,
    property_type: 'home', notes: [`Appointment ${a.date} at ${a.time}`, ...about].join('\n'), extra: { via: 'email' },
  })
  if (slErr && slErr.code !== '23505') throw new Error(`Saving the delivery failed: ${slErr.message}`)

  // 3. The booking
  let contactId = row.contact_id
  if (!contactId) {
    const { data: latest, error: latestErr } = await db.from('prospect_contacts').select('outcome').eq('prospect_id', prospectId)
      .is('deleted_at', null).order('contacted_at', { ascending: false }).limit(1)
    if (latestErr) throw new Error(latestErr.message)
    const current = latest?.[0]?.outcome ?? null
    if (!current || EARLY.has(current)) {
      const notes = [
        a.outsideHours ? 'OUTSIDE SURVEY HOURS: Pockla ask us to rebook this when we call.' : '',
        `Pockla appointment ${a.reference}, ${clock(a.time)}.`, about.join('. '),
      ].filter(Boolean).join('\n')
      const { data, error } = await db.from('prospect_contacts').insert({
        prospect_id: prospectId, employee: EMPLOYEE, employee_email: null, outcome: 'Meeting Booked', notes,
        follow_up_date: a.date, appointment_time: a.time,
      }).select('id').single()
      if (error) throw new Error(`Logging the meeting failed: ${error.message}`)
      contactId = data.id as string
      await save(row.id, { contact_id: contactId })
    }
  }
  const booked = !!contactId

  // 4. Wait for a manager to confirm it (pockla-confirm sends the email)
  if (!row.email_status) await save(row.id, { email_status: booked ? 'awaiting' : 'not sent: already past the meeting stage' })
  await save(row.id, { status: 'done', error: booked ? null : 'This lead is past the meeting stage, so its stage was left alone. Check the appointment.' })
  return isNew ? 'created' : 'matched'
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)
  if (!SYNC_SECRET) return json({ error: 'Unavailable - MAIL_SYNC_SECRET not configured' }, 503)
  if (!timingSafeEqual(req.headers.get('x-sync-secret') || '', SYNC_SECRET)) return json({ error: 'Forbidden' }, 403)
  const body = await req.json().catch(() => ({})) as { dry_run?: boolean; preview_to?: string }

  if (body.preview_to) {
    if (!/^[a-z0-9._-]+@turbineenergyuk\.co\.uk$/i.test(body.preview_to)) return json({ error: 'Previews only go to Turbine addresses' }, 400)
    if (!BREVO_API_KEY) return json({ error: 'BREVO_API_KEY not set' }, 503)
    const soon = londonNow(new Date(Date.now() + 2 * 86400000)).slice(0, 10)
    const problem = await sendFromInfo(body.preview_to, 'Preview', confirmationEmail({ name: 'Jane Example', phone: '07700 900123', date: soon, time: '13:30' }))
    return json(problem ? { error: problem } : { ok: true, sent: 'preview' }, problem ? 502 : 200)
  }

  if (!MS_TENANT_ID || !MS_CLIENT_ID || !MS_CLIENT_SECRET) return json({ error: 'Unavailable - Microsoft secrets not configured' }, 503)
  try {
    const token = await graphToken()
    if (body.dry_run) {
      const listed = await listMessages(token, new Date(Date.now() - 60 * 86400000).toISOString(), 'desc', 20)
      const checks = []
      for (const l of listed) {
        const m = await fullMessage(token, l.id)
        let reference: string | null = null, problem: string | null = null
        try { reference = parseAppointment(m.body?.content || '').reference } catch (e) { problem = (e as Error).message }
        checks.push({ received: m.receivedDateTime, reference, reads: !problem, problem, verified: senderVerified(m.internetMessageHeaders) })
      }
      return json({ ok: true, dry_run: true, brevo_key_set: !!BREVO_API_KEY, checked: checks.length, checks })
    }

    const { data: state, error } = await db.from('pockla_import_state').select('*').eq('id', 1).single()
    if (error) throw new Error(`Loading the import settings failed: ${error.message}`)
    if (!state.enabled) return json({ ok: true, skipped: 'switched off' })
    const { data: origin, error: originErr } = await db.from('lead_origins').select('id').ilike('name', ORIGIN_NAME).maybeSingle()
    if (originErr || !origin) throw new Error('The lead origin is missing')

    const listed = await listMessages(token, state.synced_through, 'asc', MAX_PER_RUN)
    const results: string[] = []
    let through: string = state.synced_through, lastError: string | null = null
    for (const m of listed) {
      try {
        results.push(await importOne(token, m, origin.id))
      } catch (e) {
        lastError = (e as Error).message.slice(0, 300)
        console.error('pockla-mail', lastError)
        break   // not moved past this email, so the next run starts with it
      }
      through = m.receivedDateTime
    }
    await db.from('pockla_import_state').update({ synced_through: through, last_run_at: new Date().toISOString(), last_error: lastError }).eq('id', 1)
    return json({ ok: !lastError, results, error: lastError }, lastError ? 500 : 200)
  } catch (e) {
    const message = (e as Error).message.slice(0, 300)
    if (!body.dry_run) await db.from('pockla_import_state').update({ last_run_at: new Date().toISOString(), last_error: message }).eq('id', 1)
    return json({ error: message }, 502)
  }
})
