// A manager confirms a Pockla call, and the customer gets the confirmation
// email from info@ (Greg, 2026-11-25: check we're free first, so nothing is
// sent until someone presses Confirm call). Called from crm.html.
//
//   { import_id, action: 'confirm', date: 'YYYY-MM-DD', time: 'HH:MM' }
//   { import_id, action: 'skip' }        no email is sent
//
// Managers only. The customer's details come from the lead, never the
// request. A changed date or time is saved on the Meeting Booked entry
// itself, so a lead that has since moved on (e.g. quote sent) keeps its
// stage. An email is only ever sent by whoever moves the import from
// 'awaiting' to 'sending', so two people pressing at once send one.
//
// Keep ASCII-only.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { confirmationEmail, londonNow, longDate, clock } from '../_shared/pockla-email.ts'
import { sendFromInfo } from '../_shared/brevo.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const MAX_EMAILS_PER_DAY = 30
// Outcomes that close or park a lead: never email those customers.
const CLOSED = new Set(['Not Interested', 'Already Has Solar', 'Enquiring Only', 'Not Suitable', 'Lost On Price', 'Lost To Competitor',
  'Cancelled', 'Invalid Details', 'Duplicate', 'Never Enquired', 'Unreachable', 'Recontact Later'])

const PROD_ORIGIN = 'https://catchsit.github.io'
function corsHeadersFor(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  }
  if (origin && (origin === PROD_ORIGIN || /^http:\/\/localhost(:\d+)?$/.test(origin))) headers['Access-Control-Allow-Origin'] = origin
  return headers
}

const hhmm = (t: string | null) => (t || '').slice(0, 5)

Deno.serve(async (req) => {
  const CORS = corsHeadersFor(req.headers.get('Origin'))
  // Problems come back as 200 { error } so the page can show the reason.
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: CORS })
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)

  const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } })
  const { data: { user }, error: authErr } = await authClient.auth.getUser()
  const me = user?.email?.toLowerCase() || ''
  if (authErr || !me.endsWith('@turbineenergyuk.co.uk') || !user?.email_confirmed_at) return json({ error: 'Forbidden' }, 403)
  const { data: manager, error: managerErr } = await db.from('managers').select('email, name').eq('email', me).maybeSingle()
  if (managerErr || !manager) return json({ error: 'Only a manager can do this' }, 403)

  let b: { import_id?: string; action?: string; date?: string; time?: string }
  try { b = await req.json() } catch { return json({ error: 'Invalid JSON body' }, 400) }
  if (!b.import_id || !/^[0-9a-f-]{36}$/i.test(b.import_id)) return json({ error: 'import_id is required' }, 400)

  if (b.action === 'skip') {
    const { data, error } = await db.from('pockla_imports')
      .update({ email_status: `not sent: skipped by ${manager.name || me}`, updated_at: new Date().toISOString() })
      .eq('id', b.import_id).eq('email_status', 'awaiting').select('id')
    if (error) return json({ error: 'Saving failed. Please try again.' })
    return json(data?.length ? { ok: true } : { error: 'Someone has already dealt with this one.' })
  }
  if (b.action !== 'confirm') return json({ error: 'Unknown action' }, 400)

  const date = b.date || '', time = b.time || ''
  const parsed = new Date(date + 'T00:00:00Z')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return json({ error: 'Pick a valid date.' })
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return json({ error: 'Pick a valid time.' })
  if (`${date}T${time}` <= londonNow()) return json({ error: 'That time has already passed. Pick a new one.' })
  if (date > londonNow(new Date(Date.now() + 90 * 86400000)).slice(0, 10)) return json({ error: 'That date is more than 3 months away. Please check it.' })

  const { data: state, error: stateErr } = await db.from('pockla_import_state').select('email_enabled').eq('id', 1).single()
  if (stateErr) return json({ error: 'Loading the settings failed. Please try again.' })
  if (!state.email_enabled) return json({ error: 'Confirmation emails are switched off.' })

  const { data: imp, error: impErr } = await db.from('pockla_imports')
    .select('id, prospect_id, contact_id, email_status, appointment_date, appointment_time, outside_hours').eq('id', b.import_id).maybeSingle()
  if (impErr) return json({ error: 'Loading the booking failed. Please try again.' })
  if (!imp || imp.email_status !== 'awaiting') return json({ error: 'Someone has already dealt with this one.' })
  if (!imp.prospect_id || !imp.contact_id) return json({ error: 'This booking has no lead to confirm.' })
  if (imp.outside_hours && imp.appointment_date === date && hhmm(imp.appointment_time) === time) {
    return json({ error: 'Pockla booked this outside your survey hours. Agree a new time with the customer first.' })
  }

  const { data: lead } = await db.from('prospects').select('id, customer_name, contact_phone, contact_email').eq('id', imp.prospect_id).is('deleted_at', null).maybeSingle()
  if (!lead) return json({ error: 'This lead has been deleted.' })
  const email = (lead.contact_email || '').trim()
  if (!/^[^@\s<>,;]+@[^@\s<>,;]+\.[^@\s<>,;]+$/.test(email)) return json({ error: 'This lead has no valid email address. Ring them instead, then press No email.' })
  const { data: latest, error: latestErr } = await db.from('prospect_contacts').select('outcome').eq('prospect_id', lead.id)
    .is('deleted_at', null).order('contacted_at', { ascending: false }).limit(1)
  if (latestErr) return json({ error: 'Loading the lead failed. Please try again.' })
  if (CLOSED.has(latest?.[0]?.outcome)) return json({ error: 'This lead is closed, so no email was sent.' })

  // The newest meeting on the lead: a person may have rebooked it by hand.
  const { data: meetings, error: meetErr } = await db.from('prospect_contacts').select('id, follow_up_date, appointment_time, notes').eq('prospect_id', lead.id)
    .eq('outcome', 'Meeting Booked').is('deleted_at', null).order('contacted_at', { ascending: false }).limit(1)
  const meeting = meetings?.[0]
  if (meetErr || !meeting) return json({ error: 'The meeting is no longer on this lead.' })

  const { count, error: countErr } = await db.from('email_log').select('id', { count: 'exact', head: true })
    .eq('email_type', 'meeting_confirm').gte('created_at', new Date(Date.now() - 86400000).toISOString())
  if (countErr || (count ?? 0) >= MAX_EMAILS_PER_DAY) return json({ error: 'The daily limit for confirmation emails has been reached.' })

  // From here, only one caller can be sending this one.
  const { data: claimed, error: claimErr } = await db.from('pockla_imports').update({ email_status: 'sending', updated_at: new Date().toISOString() })
    .eq('id', imp.id).eq('email_status', 'awaiting').select('id')
  if (claimErr) return json({ error: 'Saving failed. Please try again.' })
  if (!claimed?.length) return json({ error: 'Someone has already dealt with this one.' })
  const release = async (status: string) => {
    const { error } = await db.from('pockla_imports').update({ email_status: status, updated_at: new Date().toISOString() }).eq('id', imp.id).eq('email_status', 'sending')
    if (error) console.error('pockla-confirm: status', error.message)
  }

  const moved = meeting.follow_up_date !== date || hhmm(meeting.appointment_time) !== time
  if (moved) {
    const was = meeting.follow_up_date ? `${longDate(meeting.follow_up_date)}${meeting.appointment_time ? ' at ' + clock(hhmm(meeting.appointment_time)) : ''}` : 'no date'
    const { error } = await db.from('prospect_contacts').update({
      follow_up_date: date, appointment_time: time, updated_at: new Date().toISOString(), updated_by: me,
      notes: [meeting.notes, `Moved from ${was} by ${manager.name || me} when confirming.`].filter(Boolean).join('\n'),
    }).eq('id', meeting.id)
    if (error) { await release('awaiting'); return json({ error: 'Saving the new time failed, so no email was sent.' }) }
  }

  const name = (lead.customer_name || '').trim() || 'there'
  const mail = confirmationEmail({ name, phone: lead.contact_phone, date, time })
  let problem: string | null
  try {
    problem = await sendFromInfo(email, name, mail)
  } catch {
    await release('failed: no answer from Brevo, check before resending')
    return json({ error: "Brevo didn't answer, so the email may or may not have gone. Check with the customer. It won't be sent again.", moved })
  }
  if (problem) {
    await release('awaiting')
    return json({ error: `The email wasn't sent (${problem}). Please try again.${moved ? ' The new time has been saved.' : ''}`, moved })
  }

  const { error: doneErr } = await db.from('pockla_imports').update({
    email_status: 'sent', appointment_date: date, appointment_time: time, confirmed_by_email: me, confirmed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).eq('id', imp.id)
  if (doneErr) console.error('pockla-confirm: done', doneErr.message)
  const { error: logErr } = await db.from('email_log').insert({
    prospect_id: lead.id, related_contact_id: meeting.id, email_type: 'meeting_confirm', sequence_no: 1,
    status: 'sent', to_email: email, subject: mail.subject, created_by_email: me,
  })
  if (logErr) console.error('pockla-confirm: email_log', logErr.message)
  return json({ ok: true, moved })
})
