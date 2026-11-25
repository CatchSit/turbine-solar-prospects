// Single source of truth for who a manual lead (crm.html) can be assigned
// to — same "hardcoded roster, keep it updated as staff join/leave" choice
// as ADMIN_EMAILS, rather than deriving the list from auth.users (keeps it
// predictable and independent of who has actually logged in yet).
const REP = {
  "greg@turbineenergyuk.co.uk":  { name: "Greg",  color: "#2563eb" },
  // left: no longer offered when assigning (2026-10-26). Kept here so leads
  // still assigned to him keep their name/colour and stay in the CRM filter
  // until a manager reassigns them.
  "matty@turbineenergyuk.co.uk": { name: "Matty", color: "#059669", left: true },
  "tim@turbineenergyuk.co.uk":   { name: "Tim",   color: "#d97706" },
  "chris@turbineenergyuk.co.uk": { name: "Chris", color: "#7c3aed" },
  "jackie@turbineenergyuk.co.uk": { name: "Jackie", color: "#0891b2" },
  // Her Turbine account, not the old AOL address (Greg 2026-11-25, migration 085).
  "vicky@turbineenergyuk.co.uk": { name: "Vic", color: "#db2777" },
};
const REP_ORDER = ["greg@turbineenergyuk.co.uk", "matty@turbineenergyuk.co.uk", "tim@turbineenergyuk.co.uk", "chris@turbineenergyuk.co.uk", "jackie@turbineenergyuk.co.uk", "vicky@turbineenergyuk.co.uk"];
function isAssignable(email) { return !email || !REP[email]?.left; }
function repName(email) { return email ? (REP[email]?.name || email.split('@')[0]) : 'Unassigned'; }
