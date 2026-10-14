// Single source of truth for prospect_contacts.outcome colours/labels/date
// requirement. requiresDate === true means the Log Contact modal must
// block submission without a follow_up_date for that outcome.
// See docs/superpowers/specs/2026-08-17-crm-contact-log-design.md.
//
// Staged flow (agreed with the user 2026-10-12): every outcome belongs to
// one of LEAD_STAGES (stage = index) or closes/parks the lead (stage =
// 'lost' | 'bad' | 'later'), and carries the next step a rep should take,
// so nobody has to guess what follows. The keys are what's stored in
// prospect_contacts.outcome and are NEVER renamed — "Follow Up",
// "Converted", "Completed" and "Already Has Solar" keep their keys (home.
// html, sms-scheduler and existing rows depend on them) and only their
// labels changed.
//   next      — the instruction shown on the lead page after this outcome
//   dateLabel — what the required date means (Log Contact modal)
//   dateDays  — default the modal pre-fills the date with (days from today)
//   nextDays  — for outcomes without a date: due date = logged + nextDays
// Quote comes before Survey (user, 2026-10-14): the quote goes out first,
// then the site is surveyed to confirm it before the customer commits.
const LEAD_STAGES = ["Contacting", "Qualifying", "Quote", "Survey", "Won", "Install", "Complete"];

const CONTACT_OUTCOME = {
  // 1 Contacting
  "No Answer":         { stage: 0, color: "#b9b9a9", soft: "#f0f0e6", label: "No answer", requiresDate: false, nextDays: 1, next: "Try again at a different time of day" },
  "Left Message":      { stage: 0, color: "#a19c84", soft: "#ebe9df", label: "Left message", requiresDate: true, dateDays: 2, dateLabel: "Call again on", next: "Call again if they haven't replied" },
  "Follow Up":         { stage: 0, color: "#c08438", soft: "#f3e3cb", label: "Call back requested", requiresDate: true, dateDays: 1, dateLabel: "Call back on", next: "Call them back when they asked" },
  // 2 Qualifying
  "Info Sent":         { stage: 1, color: "#d29a3c", soft: "#f6e8cc", label: "Interested, info sent", requiresDate: true, dateDays: 3, dateLabel: "Chase on", next: "Chase them, then book a meeting or send a quote" },
  "Meeting Booked":    { stage: 1, color: "#3b7dd8", soft: "#dce7f7", label: "Meeting booked", requiresDate: true, dateLabel: "Meeting date", next: "Attend the meeting, then log what happened" },
  // 3 Quote
  "Quote Sent":        { stage: 2, color: "#8a6d3b", soft: "#ede2cf", label: "Quote sent", requiresDate: true, dateDays: 3, dateLabel: "Chase on", next: "Chase the quote, and book a survey if they want to go ahead" },
  "Negotiating":       { stage: 2, color: "#a5834a", soft: "#efe5d2", label: "Negotiating", requiresDate: true, dateDays: 3, dateLabel: "Chase on", next: "Send the revised quote, then chase" },
  // 4 Survey
  "Survey Booked":     { stage: 3, color: "#2a9d9d", soft: "#d9f0ef", label: "Survey booked", requiresDate: true, dateLabel: "Survey date", next: "Carry out the site survey" },
  "Survey Completed":  { stage: 3, color: "#1f8282", soft: "#d3eaea", label: "Survey completed", requiresDate: false, nextDays: 2, next: "Update the quote if the survey changed anything, then get the customer's go-ahead" },
  // 5 Won
  "Converted":         { stage: 4, color: "#2ba45e", soft: "#e6f4ec", label: "Quote accepted", requiresDate: false, nextDays: 0, next: "Send the order contract to sign and request the deposit" },
  "Contract Signed":   { stage: 4, color: "#23914f", soft: "#dcefe3", label: "Contract signed, deposit paid", requiresDate: false, nextDays: 5, next: "Apply to the DNO for grid connection approval" },
  // 6 Install — DNO approval comes back before the install can be booked
  // (added at the user's request 2026-10-12).
  "DNO Submitted":     { stage: 5, color: "#5b8fc9", soft: "#e0eaf6", label: "DNO application submitted", requiresDate: true, dateDays: 14, dateLabel: "Chase the DNO on", next: "Wait for the DNO decision. Chase them if there's no answer by the date" },
  "DNO Approved":      { stage: 5, color: "#3f7fc0", soft: "#dbe6f3", label: "DNO approved", requiresDate: false, nextDays: 3, next: "Book the install date and send the job to the installs team" },
  "Scheduled for Install": { stage: 5, color: "#2f6fb3", soft: "#dbe6f2", label: "Scheduled for install", requiresDate: true, dateLabel: "Install date", next: "Finish the install checklist: scaffold, electrician, roofer, kit" },
  "Completed":         { stage: 5, color: "#1f8a52", soft: "#dcf0e4", label: "Installed", requiresDate: false, nextDays: 3, next: "Send the handover pack, MCS certificate and final invoice" },
  // 7 Complete
  "Job Closed":        { stage: 6, color: "#16703f", soft: "#d6ebde", label: "Paid, job closed", requiresDate: false, next: "Ask for a Google review and a referral. Nothing else to do." },
  // Closed: not proceeding
  "Not Interested":    { stage: "lost", color: "#8e9080", soft: "#ececdf", label: "Not interested", requiresDate: false, next: "Nothing to do. The lead is closed." },
  "Already Has Solar": { stage: "lost", color: "#6f5b94", soft: "#e2dcec", label: "Already has the system", requiresDate: false, next: "Nothing to do. The lead is closed." },
  "Enquiring Only":    { stage: "lost", color: "#b8912f", soft: "#f3ecd6", label: "Enquiring only", requiresDate: false, next: "Nothing to do. The lead is closed." },
  "Not Suitable":      { stage: "lost", color: "#9a8478", soft: "#eee6e1", label: "Not suitable", requiresDate: false, next: "Closed. Note why in the log (roof, shading, property or grant eligibility)." },
  "Lost On Price":     { stage: "lost", color: "#b85544", soft: "#f0d3ce", label: "Lost on price", requiresDate: false, next: "Closed. Note the price they were comparing against, if known." },
  "Lost To Competitor":{ stage: "lost", color: "#a0473a", soft: "#ecd0cb", label: "Went with competitor", requiresDate: false, next: "Closed. Note which company, if known." },
  "Cancelled":         { stage: "lost", color: "#8c3a2f", soft: "#e8cdc8", label: "Cancelled after signing", requiresDate: false, next: "Closed. Tell the installs team and check whether the deposit needs refunding." },
  // Bad lead — counts against the lead supplier
  "Invalid Details":   { stage: "bad", color: "#7d5ba6", soft: "#e7def2", label: "Wrong number / invalid details", requiresDate: false, next: "Closed. Counts against the lead supplier." },
  "Duplicate":         { stage: "bad", color: "#8f72b3", soft: "#ebe4f4", label: "Duplicate", requiresDate: false, next: "Closed. Note which lead it duplicates." },
  "Never Enquired":    { stage: "bad", color: "#6a4a94", soft: "#e2d9ee", label: "Says they never enquired", requiresDate: false, next: "Closed. Counts against the lead supplier." },
  "Unreachable":       { stage: "bad", color: "#a493bd", soft: "#efebf5", label: "Unreachable", requiresDate: false, next: "Closed after repeated attempts with no reply." },
  // Not now
  "Recontact Later":   { stage: "later", color: "#c9a227", soft: "#f6efd2", label: "Not ready yet, recontact later", requiresDate: true, dateDays: 90, dateLabel: "Recontact on", next: "Call again on the recontact date" },
};
const CONTACT_OUTCOME_ORDER = Object.keys(CONTACT_OUTCOME);

const OUTCOME_EXIT_GROUPS = {
  lost:  { label: "Closed: not proceeding", color: "#b85544" },
  bad:   { label: "Bad lead (counts against the supplier)", color: "#7d5ba6" },
  later: { label: "Not now", color: "#c9a227" },
};

// Log Contact modal sections (crm.html + index.html's #cm-outcome-chips):
// one row per stage in flow order, then the three ways a lead can close.
const CONTACT_OUTCOME_SECTIONS = [
  ...LEAD_STAGES.map((label, i) => ({
    label: `${i + 1} · ${label}`,
    outcomes: CONTACT_OUTCOME_ORDER.filter(k => CONTACT_OUTCOME[k].stage === i),
  })),
  ...Object.entries(OUTCOME_EXIT_GROUPS).map(([key, g]) => ({
    label: g.label,
    outcomes: CONTACT_OUTCOME_ORDER.filter(k => CONTACT_OUTCOME[k].stage === key),
  })),
];

// 'YYYY-MM-DD' in local time, and date-only arithmetic on that format.
function localDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function addDaysStr(dateLike, days) {
  const d = new Date(dateLike);
  d.setDate(d.getDate() + days);
  return localDateStr(d);
}

const UNREACHABLE_SUGGEST_AFTER = 5;
const NO_REPLY_OUTCOMES = new Set(["No Answer", "Left Message"]);

// Where a lead is and what to do next, from its contact log (newest
// first) — drives the stage bar and "Next step" line on crm.html's lead
// page. Returns:
//   stageIndex  — current stage (0-6), or -1 for a lead nobody has
//                 contacted yet, or the furthest stage reached for a
//                 closed lead
//   exit        — null, or 'lost' | 'bad' | 'later'
//   next, dueDate ('YYYY-MM-DD' or null), overdue, dueToday
function leadProgress(contacts, createdAt) {
  const today = localDateStr(new Date());
  const reached = contacts.reduce((max, c) => {
    const s = CONTACT_OUTCOME[c.outcome]?.stage;
    return typeof s === 'number' && s > max ? s : max;
  }, -1);
  const result = (o) => ({
    ...o,
    overdue: !!o.dueDate && o.dueDate < today,
    dueToday: o.dueDate === today,
  });

  if (!contacts.length) {
    return result({ stageIndex: -1, exit: null, latest: null, next: 'Make the first call', dueDate: createdAt ? localDateStr(new Date(createdAt)) : null });
  }
  const latest = contacts[0];
  const cfg = CONTACT_OUTCOME[latest.outcome] || { stage: 0, next: 'Log the next contact' };
  const exit = typeof cfg.stage === 'number' ? null : cfg.stage;
  let next = cfg.next;
  let dueDate = null;
  if (cfg.requiresDate) dueDate = latest.follow_up_date || null;
  else if (cfg.nextDays != null && !exit) dueDate = addDaysStr(latest.contacted_at, cfg.nextDays);

  if (NO_REPLY_OUTCOMES.has(latest.outcome)) {
    let attempts = 0;
    for (const c of contacts) { if (NO_REPLY_OUTCOMES.has(c.outcome)) attempts++; else break; }
    if (attempts >= UNREACHABLE_SUGGEST_AFTER) {
      next = `No reply after ${attempts} attempts. Log "Unreachable" to close it, or try once more`;
    }
  }
  return result({
    stageIndex: exit ? reached : cfg.stage,
    exit, latest, next, dueDate,
  });
}

// For Node.js testing/module consumption
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CONTACT_OUTCOME, CONTACT_OUTCOME_ORDER, CONTACT_OUTCOME_SECTIONS, LEAD_STAGES, OUTCOME_EXIT_GROUPS, leadProgress, localDateStr, addDaysStr };
}
