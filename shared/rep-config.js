// Single source of truth for who a manual lead (crm.html) can be assigned
// to — same "hardcoded roster, keep it updated as staff join/leave" choice
// as ADMIN_EMAILS, rather than deriving the list from auth.users (keeps it
// predictable and independent of who has actually logged in yet).
const REP = {
  "greg@turbineenergyuk.co.uk":  { name: "Greg",  color: "#2563eb" },
  "matty@turbineenergyuk.co.uk": { name: "Matty", color: "#059669" },
  "tim@turbineenergyuk.co.uk":   { name: "Tim",   color: "#d97706" },
  // Not a @turbineenergyuk.co.uk address (external marketing contact) —
  // fine for assignment itself (tag/filter only, no login involved), but
  // she won't be able to sign into the CRM/map at all under the existing
  // Azure AD + RLS domain restriction (see migrations 003/004) unless
  // that's deliberately widened for her too.
  "vickyturbinemarketingltd@aol.com": { name: "Vic", color: "#db2777" },
};
const REP_ORDER = ["greg@turbineenergyuk.co.uk", "matty@turbineenergyuk.co.uk", "tim@turbineenergyuk.co.uk", "vickyturbinemarketingltd@aol.com"];
function repName(email) { return email ? (REP[email]?.name || email.split('@')[0]) : 'Unassigned'; }
