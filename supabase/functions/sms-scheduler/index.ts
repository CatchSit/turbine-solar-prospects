import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL              = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const SUPABASE_ANON_KEY         = Deno.env.get('SUPABASE_ANON_KEY')!

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_ANON_KEY) {
  throw new Error('Missing required secrets — check SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY')
}

// Human-registered, may genuinely be unset — same reasoning as
// company-lookup's COMPANIES_HOUSE_API_KEY (not asserted at module load, so
// a missing key doesn't crash the whole worker before the CORS preflight
// can even be answered).
const TWILIO_ACCOUNT_SID  = Deno.env.get('TWILIO_ACCOUNT_SID')
const TWILIO_AUTH_TOKEN   = Deno.env.get('TWILIO_AUTH_TOKEN')
const TWILIO_FROM_NUMBER  = Deno.env.get('TWILIO_FROM_NUMBER')

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

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

// This first version is dashboard-triggered (a manager clicks "Send
// scheduled texts now"), not a silent pg_cron job — same "click to run a
// batch" shape as solar-enrichment. True zero-touch scheduling (pg_cron +
// pg_net calling this on a timer) is a clean fast-follow once this has been
// run a few times and the message copy/timing are confirmed good — see
// HANDOVER.md risk 15. One click here still scans every eligible lead
// across all three message types in one go; nobody composes a text by hand.
const MAX_SENDS_PER_RUN = 100
const FOLLOWUP_DAYS_AFTER_QUOTE_SENT = 3
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function todayUTC(): Date {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}
function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 24 * 60 * 60 * 1000)
}
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}
function currentPeriod(): string {
  const now = new Date()
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
}

// Cost-visibility counter only (dashboard.html's "API usage this month"
// card) — unlike Solar/Maps/Apollo/Hunter, Twilio SMS has no free tier to
// budget against, so this never gates sending, just makes spend visible.
async function incrementSmsSendCount(): Promise<void> {
  const period = currentPeriod()
  const { data } = await db.from('api_usage').select('request_count').eq('api_name', 'sms_send').eq('period', period).maybeSingle()
  const next = (data?.request_count ?? 0) + 1
  await db.from('api_usage').upsert(
    { api_name: 'sms_send', period, request_count: next, updated_at: new Date().toISOString() },
    { onConflict: 'api_name,period' },
  )
}

// UK-only normalization to E.164 — reps enter phone numbers as free text
// (07…, spaces, dashes), Twilio needs +44…. Anything that doesn't clearly
// look like a UK mobile/landline after stripping punctuation is treated as
// unusable rather than guessed at.
function toE164UK(raw: string | null): string | null {
  if (!raw) return null
  const digits = raw.replace(/[^\d+]/g, '')
  if (digits.startsWith('+44')) return digits
  if (digits.startsWith('44')) return '+' + digits
  if (digits.startsWith('0')) return '+44' + digits.slice(1)
  return null
}

async function sendTwilioSms(to: string, body: string): Promise<{ ok: boolean; sid: string | null; error: string | null }> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`
  const form = new URLSearchParams({ To: to, From: TWILIO_FROM_NUMBER!, Body: body })
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form,
  })
  const json = await resp.json().catch(() => null)
  if (!resp.ok) return { ok: false, sid: null, error: json?.message || `Twilio ${resp.status}` }
  return { ok: true, sid: json?.sid ?? null, error: null }
}

// Every message ends with the same opt-out instruction — required so
// sms-inbound's STOP-keyword handling actually has something to reply to,
// not just good practice under PECR.
const APPOINTMENT_NOUN: Record<string, string> = {
  'Meeting Booked': 'appointment',
  'Survey Booked': 'solar survey',
}
function appointmentReminderBody(name: string, noun: string, dateStr: string): string {
  return `Hi ${name}, this is a reminder from Turbine Energy — your ${noun} is booked for ${dateStr}. Reply STOP to opt out of texts.`
}
function quoteFollowupBody(name: string): string {
  return `Hi ${name}, just checking you received your solar quote from Turbine Energy — happy to answer any questions. Reply STOP to opt out.`
}
function installConfirmationBody(name: string, dateStr: string): string {
  return `Hi ${name}, this confirms your solar installation with Turbine Energy is scheduled for ${dateStr}. Reply STOP to opt out.`
}
function formatUkDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00Z')
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })
}

type Counts = { sent: number; failed: number; skipped_opted_out: number; skipped_no_phone: number; already_sent: number }
function emptyCounts(): Counts { return { sent: 0, failed: 0, skipped_opted_out: 0, skipped_no_phone: 0, already_sent: 0 } }

type Candidate = {
  prospectId: string
  customerName: string | null
  contactPhone: string | null
  smsOptOut: boolean
  messageType: 'appointment_reminder' | 'quote_followup' | 'install_confirmation'
  targetDate: string
  relatedContactId: string | null
  body: string
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

  const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  })
  const { data: { user }, error: authErr } = await authClient.auth.getUser()
  if (authErr || !user || !user.email?.toLowerCase().endsWith('@turbineenergyuk.co.uk')) {
    return jsonResponse({ error: 'Unauthorized' }, 401)
  }

  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER) {
    return jsonResponse({ error: 'SMS sending unavailable — TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_FROM_NUMBER not configured' }, 503)
  }

  const today = todayUTC()
  const tomorrowStr = isoDate(addDays(today, 1))
  const quoteSentCutoffStr = isoDate(addDays(today, -FOLLOWUP_DAYS_AFTER_QUOTE_SENT))

  const candidates: Candidate[] = []

  // ── 1. Appointment reminders — Meeting Booked / Survey Booked contacts
  // whose follow_up_date is tomorrow. "Scheduled for Install" is deliberately
  // excluded here — that outcome's date is a rep's own log entry, while the
  // authoritative install date is install-hub's own scheduled_date (mirrored
  // locally as install_scheduled_date), covered separately below as
  // install_confirmation. Covering both would risk two different reminders
  // referencing two different dates for the same job.
  {
    const { data: dueContacts, error } = await db.from('prospect_contacts')
      .select('id, prospect_id, outcome, follow_up_date')
      .in('outcome', Object.keys(APPOINTMENT_NOUN))
      .eq('follow_up_date', tomorrowStr)
    if (error) return jsonResponse({ error: 'Failed to query due appointments' }, 500)

    if (dueContacts?.length) {
      const prospectIds = [...new Set(dueContacts.map(c => c.prospect_id))]
      const { data: prospects } = await db.from('prospects')
        .select('id, customer_name, contact_phone, sms_opt_out')
        .in('id', prospectIds)
      const byId = new Map((prospects ?? []).map(p => [p.id, p]))

      for (const c of dueContacts) {
        const p = byId.get(c.prospect_id)
        if (!p) continue
        const name = p.customer_name || 'there'
        candidates.push({
          prospectId: p.id,
          customerName: name,
          contactPhone: p.contact_phone,
          smsOptOut: p.sms_opt_out,
          messageType: 'appointment_reminder',
          targetDate: c.follow_up_date,
          relatedContactId: c.id,
          body: appointmentReminderBody(name, APPOINTMENT_NOUN[c.outcome], formatUkDate(c.follow_up_date)),
        })
      }
    }
  }

  // ── 2. Quote follow-up — a 'Quote Sent' contact logged exactly
  // FOLLOWUP_DAYS_AFTER_QUOTE_SENT days ago, with nothing logged for that
  // prospect since (otherwise a rep has already followed up, or the
  // customer's situation has already moved on).
  {
    const { data: quoteSentRows, error } = await db.from('prospect_contacts')
      .select('id, prospect_id, contacted_at')
      .eq('outcome', 'Quote Sent')
    if (error) return jsonResponse({ error: 'Failed to query Quote Sent contacts' }, 500)

    const dueRows = (quoteSentRows ?? []).filter(r => (r.contacted_at as string).slice(0, 10) === quoteSentCutoffStr)
    if (dueRows.length) {
      const prospectIds = [...new Set(dueRows.map(r => r.prospect_id))]

      // Latest contact per prospect, to confirm the Quote Sent row being
      // considered is still the most recent thing logged.
      const { data: allContacts } = await db.from('prospect_contacts')
        .select('id, prospect_id, contacted_at')
        .in('prospect_id', prospectIds)
        .order('contacted_at', { ascending: false })
      const latestByProspect = new Map<string, string>()
      for (const row of allContacts ?? []) {
        if (!latestByProspect.has(row.prospect_id)) latestByProspect.set(row.prospect_id, row.id)
      }

      const { data: prospects } = await db.from('prospects')
        .select('id, customer_name, contact_phone, sms_opt_out')
        .in('id', prospectIds)
      const byId = new Map((prospects ?? []).map(p => [p.id, p]))

      for (const row of dueRows) {
        if (latestByProspect.get(row.prospect_id) !== row.id) continue // something newer has been logged since
        const p = byId.get(row.prospect_id)
        if (!p) continue
        const name = p.customer_name || 'there'
        candidates.push({
          prospectId: p.id,
          customerName: name,
          contactPhone: p.contact_phone,
          smsOptOut: p.sms_opt_out,
          messageType: 'quote_followup',
          targetDate: quoteSentCutoffStr,
          relatedContactId: row.id,
          body: quoteFollowupBody(name),
        })
      }
    }
  }

  // ── 3. Install-day confirmation — leads with a real install-hub job
  // whose (locally mirrored) install_scheduled_date is tomorrow.
  {
    const { data: dueInstalls, error } = await db.from('prospects')
      .select('id, customer_name, contact_phone, sms_opt_out, install_scheduled_date')
      .eq('install_scheduled_date', tomorrowStr)
      .not('install_hub_job_id', 'is', null)
    if (error) return jsonResponse({ error: 'Failed to query due installs' }, 500)

    for (const p of dueInstalls ?? []) {
      const name = p.customer_name || 'there'
      candidates.push({
        prospectId: p.id,
        customerName: name,
        contactPhone: p.contact_phone,
        smsOptOut: p.sms_opt_out,
        messageType: 'install_confirmation',
        targetDate: p.install_scheduled_date,
        relatedContactId: null,
        body: installConfirmationBody(name, formatUkDate(p.install_scheduled_date)),
      })
    }
  }

  // Dedup against sms_log — a prospect/message_type/related_contact_id (or
  // target_date, for install_confirmation which has no related contact row)
  // that's already a 'sent' row must never be texted again.
  const { data: alreadySent } = await db.from('sms_log')
    .select('prospect_id, message_type, related_contact_id, target_date')
    .eq('status', 'sent')
    .in('message_type', ['appointment_reminder', 'quote_followup', 'install_confirmation'])
  const sentKey = (r: { prospect_id: string; message_type: string; related_contact_id: string | null; target_date: string | null }) =>
    `${r.prospect_id}|${r.message_type}|${r.related_contact_id ?? r.target_date}`
  const alreadySentKeys = new Set((alreadySent ?? []).map(sentKey))

  const counts: Record<string, Counts> = {
    appointment_reminder: emptyCounts(),
    quote_followup: emptyCounts(),
    install_confirmation: emptyCounts(),
  }

  let sentThisRun = 0
  for (const cand of candidates) {
    const key = `${cand.prospectId}|${cand.messageType}|${cand.relatedContactId ?? cand.targetDate}`
    if (alreadySentKeys.has(key)) { counts[cand.messageType].already_sent++; continue }

    if (sentThisRun >= MAX_SENDS_PER_RUN) break // remaining candidates stay unsent, picked up on the next run

    const logRow = {
      prospect_id: cand.prospectId,
      message_type: cand.messageType,
      target_date: cand.targetDate,
      related_contact_id: cand.relatedContactId,
      body: cand.body,
    }

    if (cand.smsOptOut) {
      counts[cand.messageType].skipped_opted_out++
      await db.from('sms_log').insert({ ...logRow, to_phone: cand.contactPhone, status: 'skipped_opted_out' })
      continue
    }
    const to = toE164UK(cand.contactPhone)
    if (!to) {
      counts[cand.messageType].skipped_no_phone++
      await db.from('sms_log').insert({ ...logRow, to_phone: cand.contactPhone, status: 'skipped_no_phone' })
      continue
    }

    const result = await sendTwilioSms(to, cand.body)
    sentThisRun++
    if (result.ok) {
      counts[cand.messageType].sent++
      await incrementSmsSendCount()
    } else {
      counts[cand.messageType].failed++
    }
    await db.from('sms_log').insert({
      ...logRow, to_phone: to, status: result.ok ? 'sent' : 'failed',
      twilio_sid: result.sid, error_message: result.error,
    })

    await sleep(150) // courtesy pacing on a paid external API, mirrors solar-enrichment/contact-enrichment
  }

  return jsonResponse({ counts, candidatesConsidered: candidates.length, sentThisRun }, 200)
})
