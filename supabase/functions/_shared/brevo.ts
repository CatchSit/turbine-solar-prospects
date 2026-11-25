// Sends one email from info@ through Brevo. Returns null when Brevo accepted
// it, or what went wrong. Throws if Brevo never answered, when it may or may
// not have been sent. Keep ASCII-only.

export async function sendFromInfo(to: string, toName: string, mail: { subject: string; text: string; html: string }): Promise<string | null> {
  const key = Deno.env.get('BREVO_API_KEY')
  if (!key) return 'BREVO_API_KEY not set'
  const r = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST', headers: { 'api-key': key, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      sender: { email: 'info@turbineenergyuk.co.uk', name: 'Turbine Energy' }, replyTo: { email: 'info@turbineenergyuk.co.uk', name: 'Turbine Energy' },
      to: [{ email: to, name: toName }], subject: mail.subject, textContent: mail.text, htmlContent: mail.html,
    }),
    signal: AbortSignal.timeout(20000),
  })
  return r.ok ? null : `Brevo ${r.status}`
}
