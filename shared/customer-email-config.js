// Customer emails at each stage, v1 (decided with the user 2026-10-12;
// design: docs/superpowers/specs/2026-10-12-stage-customer-emails-design.md).
// Nothing is sent by the system: the CRM works out which email is due,
// opens it pre-filled in the rep's own Outlook (mailto:) for them to review
// and send, and the rep then clicks "Mark as sent" or "Skip" (email_log,
// migration 050). Replies go to the assigned rep with info@ CC'd.
//
// Depends on shared/contact-outcome-config.js (CONTACT_OUTCOME, addDaysStr,
// localDateStr) being loaded first.

const CUSTOMER_EMAIL_CC = 'info@turbineenergyuk.co.uk';

// Emails only become due for outcomes logged on/after launch, so older jobs
// don't suddenly fill up with to-dos.
const CUSTOMER_EMAILS_LAUNCH = '2026-10-12T00:00:00Z';

const KEEP_IN_TOUCH_EVERY_DAYS = 14;
const KEEP_IN_TOUCH_MAX = 3;

// Outcome → email it triggers, and where it sits in the job's order. A
// later outcome at the same or a later point supersedes an earlier email
// that was never dealt with (e.g. no "DNO submitted" email once approval
// is already logged). Job Closed has no email but still supersedes.
const OUTCOME_EMAIL = {
  'Contract Signed':       { type: 'welcome',         order: 1 },
  'DNO Submitted':         { type: 'dno_submitted',   order: 2 },
  'DNO Approved':          { type: 'dno_approved',    order: 3 },
  'Scheduled for Install': { type: 'install_confirm', order: 4 },
  'Completed':             { type: 'handover',        order: 5 },
  'Job Closed':            { type: null,              order: 6 },
};

function formatLongDate(dateStr) {
  if (!dateStr) return 'the booked date';
  const d = new Date(dateStr.length === 10 ? dateStr + 'T12:00:00' : dateStr);
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
}

const OPT_OUT_LINE = "Don't want these updates? Just reply and let us know.";

// ctx: { firstName, siteAddress, date ('YYYY-MM-DD'), senderName, sequenceNo }
const CUSTOMER_EMAIL_TEMPLATES = {
  welcome: {
    label: 'Welcome, what happens next',
    subject: () => 'Welcome to Turbine Energy: what happens next',
    body: c => [
      `Hi ${c.firstName},`,
      `Thank you for choosing Turbine Energy. We've received your signed contract.`,
      `Here's what happens next:\n1. We apply to your local network operator for permission to connect your new system to the grid.\n2. Once they approve, we agree an installation date with you.\n3. We install and commission your system, then hand over all the paperwork.`,
      `We'll keep you updated at each step. If you have any questions in the meantime, just reply to this email.`,
    ],
  },
  dno_submitted: {
    label: 'DNO application submitted',
    subject: () => "Your installation: we've applied to the network operator",
    body: c => [
      `Hi ${c.firstName},`,
      `A quick update on your installation${c.siteAddress ? ` at ${c.siteAddress}` : ''}. We've applied to your local network operator for permission to connect your new system to the grid. They have to approve it before we can fit it.`,
      `This usually takes a few weeks and there's nothing you need to do in the meantime. We'll be in touch as soon as we hear back.`,
    ],
  },
  dno_keep_in_touch: {
    label: 'DNO still being processed',
    subject: () => 'Your installation: still with the network operator',
    body: c => [
      `Hi ${c.firstName},`,
      `Just keeping you posted. Your grid connection application is still with your local network operator. That's completely normal, as these can take several weeks.`,
      `There's nothing you need to do, and we'll let you know as soon as it's approved. If you have any questions in the meantime, just reply to this email.`,
    ],
  },
  dno_approved: {
    label: 'DNO approved',
    subject: () => 'Good news: your grid connection has been approved',
    body: c => [
      `Hi ${c.firstName},`,
      `Good news. Your local network operator has approved the grid connection for your new system.`,
      `The next step is booking your installation. We'll be in touch shortly to agree a date that suits you.`,
    ],
  },
  install_confirm: {
    label: 'Install date confirmed',
    subject: c => `Your installation is booked for ${formatLongDate(c.date)}`,
    body: c => [
      `Hi ${c.firstName},`,
      `Your installation${c.siteAddress ? ` at ${c.siteAddress}` : ''} is booked for ${formatLongDate(c.date)}. Our team will confirm arrival times nearer the day.`,
      `Please make sure we can get to the roof area and your fuse board. If the date no longer works, just reply and we'll rearrange.`,
    ],
  },
  handover: {
    label: 'Installed, thank you',
    subject: () => 'Your new system is installed',
    body: c => [
      `Hi ${c.firstName},`,
      `Thank you for having us. Your new system is now installed.`,
      `Your certificates and warranty documents will follow by email shortly. If you notice anything at all, just reply and we'll sort it.`,
    ],
  },
};

function customerEmailLabel(type, sequenceNo) {
  const label = CUSTOMER_EMAIL_TEMPLATES[type]?.label || type;
  return type === 'dno_keep_in_touch' ? `${label} (${sequenceNo} of ${KEEP_IN_TOUCH_MAX})` : label;
}

function customerFirstName(customerName) {
  const words = (customerName || '').trim().split(/\s+/).filter(Boolean);
  // "Mr J. Harper" → "Mr Harper"; "Sarah Jones" → "Sarah"; companies fall back.
  if (!words.length) return 'there';
  if (/^(mr|mrs|ms|miss|dr)\.?$/i.test(words[0]) && words.length > 1) return `${words[0]} ${words[words.length - 1]}`;
  if (/\b(ltd|limited|plc|llp|group|services|farm|school|church)\b/i.test(customerName)) return 'there';
  return words[0];
}

function buildCustomerEmail(item, lead, senderName) {
  const t = CUSTOMER_EMAIL_TEMPLATES[item.type];
  const ctx = {
    firstName: customerFirstName(lead.customer_name),
    siteAddress: [lead.address, lead.postcode].filter(Boolean).join(', '),
    date: item.contact?.follow_up_date || null,
    senderName: senderName || 'The Turbine Energy team',
    sequenceNo: item.sequenceNo,
  };
  const paragraphs = [...t.body(ctx), OPT_OUT_LINE, `Kind regards,\n${ctx.senderName}\nTurbine Energy`];
  return { subject: t.subject(ctx), body: paragraphs.join('\n\n') };
}

// mailto: for the rep's Outlook. To = customer; CC = info@ plus the
// assigned rep when someone else is sending, so replies reach them.
function customerEmailMailto({ to, subject, body, assignedTo, senderEmail }) {
  const cc = [CUSTOMER_EMAIL_CC];
  if (assignedTo && assignedTo.toLowerCase() !== (senderEmail || '').toLowerCase()) cc.push(assignedTo);
  const enc = v => encodeURIComponent(v).replace(/%40/g, '@');
  return `mailto:${enc(to || '')}?cc=${cc.map(enc).join(',')}&subject=${enc(subject)}&body=${enc(body.replace(/\n/g, '\r\n'))}`;
}

// Which customer emails are due on a lead.
//   contacts — prospect_contacts rows (any order) with id, outcome, contacted_at, follow_up_date
//   logs     — email_log rows for the lead (email_type, related_contact_id, sequence_no, status)
// Returns { due: [{ type, sequenceNo, contact, dueDate }], upcoming: same | null }
function dueCustomerEmails(contacts, logs, today) {
  today = today || localDateStr(new Date());
  const chrono = [...contacts].sort((a, b) => new Date(a.contacted_at) - new Date(b.contacted_at));
  const handled = new Set((logs || []).map(l => `${l.email_type}|${l.related_contact_id}|${l.sequence_no}`));
  const isClosing = o => typeof CONTACT_OUTCOME[o]?.stage === 'string';
  const supersededAfter = (i, order) => chrono.slice(i + 1).some(c => (OUTCOME_EMAIL[c.outcome]?.order ?? 0) >= order || isClosing(c.outcome));

  const due = [];
  chrono.forEach((c, i) => {
    const cfg = OUTCOME_EMAIL[c.outcome];
    if (!cfg?.type || c.contacted_at < CUSTOMER_EMAILS_LAUNCH) return;
    if (supersededAfter(i, cfg.order)) return;
    if (handled.has(`${cfg.type}|${c.id}|1`)) return;
    due.push({ type: cfg.type, sequenceNo: 1, contact: c, dueDate: localDateStr(new Date(c.contacted_at)) });
  });

  // Keep-in-touch series off the latest DNO Submitted, until anything later
  // in the job (approval, install, close) or a closing outcome is logged.
  let upcoming = null;
  const sIdx = chrono.map(c => c.outcome).lastIndexOf('DNO Submitted');
  if (sIdx !== -1 && chrono[sIdx].contacted_at >= CUSTOMER_EMAILS_LAUNCH) {
    const s = chrono[sIdx];
    const stopped = chrono.slice(sIdx + 1).some(c => (OUTCOME_EMAIL[c.outcome]?.order ?? 0) > OUTCOME_EMAIL['DNO Submitted'].order || isClosing(c.outcome));
    if (!stopped) {
      for (let n = 1; n <= KEEP_IN_TOUCH_MAX; n++) {
        if (handled.has(`dno_keep_in_touch|${s.id}|${n}`)) continue;
        const item = { type: 'dno_keep_in_touch', sequenceNo: n, contact: s, dueDate: addDaysStr(s.contacted_at, KEEP_IN_TOUCH_EVERY_DAYS * n) };
        if (item.dueDate <= today) due.push(item); else upcoming = item;
        break;
      }
    }
  }
  return { due, upcoming };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CUSTOMER_EMAIL_TEMPLATES, dueCustomerEmails, buildCustomerEmail, customerEmailMailto, customerEmailLabel, customerFirstName };
}
