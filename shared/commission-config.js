// Commission (migration 084, Greg 2026-11-25). The database decides who can
// claim what; this is only wording and the same "earned" rule for display.
// Needs contact-outcome-config.js for isCommissionEarned.

// Where a job's commission stands, in order.
const COMMISSION_STATE = {
  not_earned: { label: "Not earned yet",       color: "#9ca3af" },
  blocked:    { label: "Can't be claimed yet", color: "#b85544" },
  ready:      { label: "Ready to claim",       color: "#2a9d9d" },
  submitted:  { label: "Waiting for approval", color: "#2563eb" },
  approved:   { label: "Approved, to pay",     color: "#d97706" },
  paid:       { label: "Paid",                 color: "#16a34a" },
};

// A form (claim) can also end as one of these, which frees its jobs.
const COMMISSION_CLAIM_STATE = {
  submitted: COMMISSION_STATE.submitted,
  approved:  COMMISSION_STATE.approved,
  paid:      COMMISSION_STATE.paid,
  sent_back: { label: "Sent back", color: "#b85544" },
  void:      { label: "Void",      color: "#6b7280" },
};

const COMMISSION_BLOCK_REASON = {
  cancelled: "The job was closed or cancelled after it was paid",
  no_option: "No quote option is selected on the lead. Ask a manager",
  no_person: "Nobody is set to earn this commission. Ask a manager",
  no_amount: "No commission amount is set yet. Ask a manager",
  claimed:   "This job is already on a claim",
  deleted:   "The lead has been deleted",
  not_paid:  "The customer isn't logged as paid",
};

const COMMISSION_TYPE = { self_employed: "Self-employed", employed: "Employed" };

// Same reference the database gives the job: TE- and the start of the lead's id.
function commissionJobRef(id) { return id ? 'TE-' + String(id).slice(0, 8).toUpperCase() : ''; }

// Earned = the customer has paid ("Paid, job closed") and nothing has closed
// the lead since. Any order of contacts.
// Greg 2026-11-27: "Paid, job closed" logged by mistake is put right by logging
// an earlier won/install stage after it (e.g. "Installed"): the job is then not
// paid. Matches commission_job_state in migration 089. Other later logs (a
// call back, info sent, ...) change nothing.
const COMMISSION_UNPAID_AGAIN = ['Converted', 'Contract Signed', 'DNO Submitted', 'DNO Approved', 'Scheduled for Install', 'Completed'];
function isCommissionEarned(contacts) {
  const at = c => new Date(c.contacted_at).getTime();
  const now = Date.now() + 60000;
  const paid = Math.max(-1, ...contacts.filter(c => c.outcome === 'Job Closed' && at(c) <= now).map(at));
  if (paid < 0) return false;
  return !contacts.some(c => (['lost', 'bad'].includes(CONTACT_OUTCOME[c.outcome]?.stage)
    || COMMISSION_UNPAID_AGAIN.includes(c.outcome)) && at(c) >= paid);
}
