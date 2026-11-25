// Reads a Pockla "New solar survey appointment" email, and writes the
// confirmation the customer gets (Greg, 2026-11-25). No network or database
// in here, so it can be tested on its own. Keep ASCII-only.

export const POCKLA_SENDER = 'appointments@notify.pockla.com'
export const POCKLA_SUBJECT = 'New solar survey appointment'

export type Appointment = {
  name: string; phone: string | null; email: string | null
  address: string | null; postcode: string
  date: string        // YYYY-MM-DD, UK
  time: string        // HH:MM, UK
  reference: string   // BK-0017
  outsideHours: boolean
  about: [string, string][]   // "About the home" rows, as sent
}

function decode(s: string): string {
  return s.replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|\u00a0/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#0?39;|&apos;/gi, "'").replace(/&pound;/gi, '\u00a3')
    .replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim()
}

const KNOWN = ['name', 'phone number', 'email address', 'address line 1', 'address line 2', 'town', 'city', 'postcode', 'date', 'time']
const POSTCODE = /^[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}$/

// Throws with a plain reason when anything needed is missing or odd: a
// person then adds that lead by hand, rather than the CRM guessing.
export function parseAppointment(html: string): Appointment {
  const rows: [string, string][] = []
  // Only a label cell directly followed by its value cell (the layout tables hold neither).
  for (const m of html.matchAll(/<td[^>]*>((?:(?!<td|<table)[\s\S])*?)<\/td>\s*<td[^>]*>((?:(?!<td|<table)[\s\S])*?)<\/td>/gi)) {
    const label = decode(m[1])
    if (label) rows.push([label, decode(m[2])])
  }
  const get = (label: string) => rows.find(([l, v]) => l.toLowerCase() === label && v)?.[1] || null
  const text = decode(html)

  const name = get('name')
  const phone = get('phone number')
  const email = (get('email address') || '').toLowerCase() || null
  const postcode = (get('postcode') || '').toUpperCase().replace(/\s+/g, ' ')
  const date = get('date')
  const time = get('time')
  const reference = text.match(/Reference:\s*([A-Z]{1,6}-\d{1,10})\b/)?.[1]

  const problems: string[] = []
  if (!name) problems.push('no name')
  if (!phone && !email) problems.push('no phone or email')
  if (email && !/^[^@\s<>,;]+@[^@\s<>,;]+\.[^@\s<>,;]+$/.test(email)) problems.push('email address not valid')
  if (!POSTCODE.test(postcode)) problems.push('postcode not valid')
  const d = date?.match(/^(\d{2})\/(\d{2})\/(\d{4})$/)
  let iso = ''
  if (d) {
    iso = `${d[3]}-${d[2]}-${d[1]}`
    const check = new Date(iso + 'T00:00:00Z')
    if (isNaN(check.getTime()) || check.toISOString().slice(0, 10) !== iso) iso = ''
  }
  if (!iso) problems.push('appointment date not valid')
  if (!time || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) problems.push('appointment time not valid')
  if (!reference) problems.push('no reference')
  if (problems.length) throw new Error(problems.join(', '))

  // The postcode is kept in its own field, so drop it from the end of the address.
  const loose = postcode.replace(' ', ' ?')
  const address = ['address line 1', 'address line 2', 'town', 'city'].map(get).filter(Boolean).join(', ')
    .replace(new RegExp(`[\\s,]*${loose}[\\s,]*$`, 'i'), '').replace(/[\s,]+$/, '').slice(0, 500)

  return {
    name: name!.slice(0, 200), phone: phone ? phone.slice(0, 60) : null, email: email ? email.slice(0, 200) : null,
    address: address || null, postcode, date: iso, time: time!, reference: reference!,
    outsideHours: /outside your survey hours/i.test(text),
    about: rows.filter(([l, v]) => v && !KNOWN.includes(l.toLowerCase())).slice(0, 15)
      .map(([l, v]) => [l.slice(0, 80), v.slice(0, 300)] as [string, string]),
  }
}

// Microsoft adds its own Authentication-Results header on top when mail
// arrives. Only the first one counts: anything lower could be the sender's.
export function senderVerified(headers: { name: string; value: string }[] | undefined): boolean {
  const first = (headers || []).find(h => h.name.toLowerCase() === 'authentication-results')
  if (!first) return false
  const v = first.value.toLowerCase().replace(/\s+/g, ' ')
  const own = '(?:[a-z0-9-]+\\.)*pockla\\.com(?![a-z0-9.-])'
  if (new RegExp(`dmarc=pass\\b[^;]*header\\.from=${own}`).test(v)) return true
  return new RegExp(`dkim=pass\\b[^;]*header\\.d=${own}`).test(v)
}

export function longDate(iso: string): string {
  return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })
}
export function clock(time: string): string {
  const [h, m] = time.split(':').map(Number)
  return `${h % 12 || 12}${m ? ':' + String(m).padStart(2, '0') : ''}${h < 12 ? 'am' : 'pm'}`
}
export function firstName(name: string): string {
  const w = name.trim().split(/\s+/)
  if (/^(mr|mrs|ms|miss|dr)\.?$/i.test(w[0]) && w.length > 1) return `${w[0]} ${w[w.length - 1]}`
  return w[0].charAt(0).toUpperCase() + w[0].slice(1)
}
export function londonNow(now = new Date()): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map(x => [x.type, x.value]))
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))

// Branded like the website's own confirmation email (te-estimate-handler.php),
// but on a white header: the logo's lettering is dark and vanishes on dark green.
// Tables and inline styles only, so it holds up in Outlook. The plain text
// version says the same thing. Wording approved by Greg 2026-11-25.
const LOGO = 'https://www.turbineenergyuk.co.uk/wordpress/wp-content/uploads/2023/06/Turbine-Energy-logo-resized2.png'
const FONT = 'font-family:Arial,Helvetica,sans-serif;'

export function confirmationEmail(a: Pick<Appointment, 'name' | 'phone' | 'date' | 'time'>) {
  const when = `${longDate(a.date)} at ${clock(a.time)}`
  const onNumber = a.phone ? `We'll call you on ${a.phone}.` : `We'll call you at that time.`
  const hi = `Hi ${firstName(a.name)},`
  const intro = `Thank you for booking a call with us about solar for your home. Your call is confirmed for:`
  const talk = `${onNumber} We'll talk about your home and how you use electricity, and what a system could look like for you. There's no obligation.`
  const bill = `If you can, please have a recent electricity bill to hand. Knowing how much you use in a year (in kWh) helps us give you a more accurate estimate.`
  const change = `If the time no longer suits, just reply to this email or call us on 01302 898508 (Monday to Friday, 8:30am to 5:30pm) and we'll rearrange.`
  const bye = `We look forward to speaking to you.`
  const sign = ['Kind regards,', 'Turbine Energy', '01302 898508', 'www.turbineenergyuk.co.uk']
  const company = ['Turbine Marketing Ltd T/A Turbine Energy, Company No. 08530306', 'Wader Lodge, Back Lane, Cusworth, Doncaster, England DN5 7TR']

  const p = (html: string, gap = 16) => `<p style="${FONT}font-size:15px;line-height:1.6;color:#374151;margin:0 0 ${gap}px">${html}</p>`
  const tel = '<a href="tel:01302898508" style="color:#1F8A52;font-weight:bold;text-decoration:none;white-space:nowrap">01302 898508</a>'
  const table = 'role="presentation" cellpadding="0" cellspacing="0" border="0"'
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(when)}</title></head>` +
    `<body style="margin:0;padding:0;background:#f4f6f3">` +
    `<div style="display:none;max-height:0;overflow:hidden">Your call is confirmed for ${esc(when)}.</div>` +
    `<table ${table} width="100%" style="background:#f4f6f3"><tr><td align="center" style="padding:28px 12px">` +
    `<table ${table} width="560" style="width:100%;max-width:560px;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">` +
    `<tr><td align="center" style="background:#ffffff;border-bottom:4px solid #2BA45E;padding:22px 24px 18px"><img src="${LOGO}" alt="Turbine Energy" width="140" height="80" style="display:block;width:140px;height:80px;border:0;${FONT}font-size:20px;font-weight:bold;color:#0C2A1E"></td></tr>` +
    `<tr><td style="padding:32px 28px 28px">` +
    `<p style="${FONT}font-size:12px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;color:#1F8A52;margin:0 0 12px">Call confirmed</p>` +
    p(esc(hi)) + p(esc(intro)) +
    `<table ${table} width="100%" style="margin:0 0 22px"><tr><td style="background:#EBF7F0;border-left:4px solid #2BA45E;border-radius:6px;padding:18px 20px">` +
    `<p style="${FONT}font-size:20px;line-height:1.35;font-weight:bold;color:#111827;margin:0">${esc(longDate(a.date))}</p>` +
    `<p style="${FONT}font-size:20px;line-height:1.35;font-weight:bold;color:#1F8A52;margin:2px 0 0">${esc(clock(a.time))}</p></td></tr></table>` +
    p(esc(talk)) + p(esc(bill)) + p(esc(change).replace('01302 898508', tel)) + p(esc(bye)) +
    p(`${sign[0]}<br><strong style="color:#111827">${sign[1]}</strong><br>${tel}<br><a href="https://www.turbineenergyuk.co.uk/" style="color:#1F8A52;text-decoration:none">${sign[3]}</a>`, 0) +
    `</td></tr><tr><td style="background:#f4f6f3;border-top:1px solid #e5e7eb;padding:20px 28px">` +
    `<p style="${FONT}font-size:12px;line-height:1.6;color:#6B7280;margin:0">${company.map(esc).join('<br>')}</p>` +
    `</td></tr></table></td></tr></table></body></html>`

  return {
    subject: `Your call with Turbine Energy: ${when}`,
    text: [hi, intro, when, talk, bill, change, bye, sign.join('\n'), company.join('\n')].join('\n\n'),
    html,
  }
}
