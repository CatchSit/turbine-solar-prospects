// Single source of truth for prospect_contacts.outcome colours/labels/date
// requirement. requiresDate === true means the Log Contact modal must
// block submission without a follow_up_date for that outcome.
// See docs/superpowers/specs/2026-08-17-crm-contact-log-design.md.
const CONTACT_OUTCOME = {
  "No Answer":         { color: "#b9b9a9", soft: "#f0f0e6", label: "No answer",         requiresDate: false },
  "Follow Up":         { color: "#c08438", soft: "#f3e3cb", label: "Follow up",         requiresDate: true  },
  "Meeting Booked":    { color: "#3b7dd8", soft: "#dce7f7", label: "Meeting booked",    requiresDate: true  },
  "Survey Booked":     { color: "#2a9d9d", soft: "#d9f0ef", label: "Survey booked",     requiresDate: true  },
  "Quote Sent":        { color: "#8a6d3b", soft: "#ede2cf", label: "Quote sent",        requiresDate: false },
  "Converted":         { color: "#2ba45e", soft: "#e6f4ec", label: "Converted",         requiresDate: false },
  "Scheduled for Install": { color: "#2f6fb3", soft: "#dbe6f2", label: "Scheduled for install", requiresDate: true },
  "Completed":         { color: "#1f8a52", soft: "#dcf0e4", label: "Completed",         requiresDate: false },
  "Not Interested":    { color: "#8e9080", soft: "#ececdf", label: "Not interested",    requiresDate: false },
  "Already Has Solar": { color: "#6f5b94", soft: "#e2dcec", label: "Already has solar", requiresDate: false },
};
const CONTACT_OUTCOME_ORDER = Object.keys(CONTACT_OUTCOME);

// For Node.js testing/module consumption
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CONTACT_OUTCOME, CONTACT_OUTCOME_ORDER };
}
