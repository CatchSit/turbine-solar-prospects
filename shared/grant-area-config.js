// Single source of truth for grant_areas.status colours/labels, shared
// between index.html (sidebar filter + boundary shading) and
// dashboard.html (manager status toggle).
const GRANT_STATUS = {
  "available": { color: "#2ba45e", soft: "#e6f4ec", label: "Funding available" },
  "limited":   { color: "#c08438", soft: "#f3e3cb", label: "Funding limited" },
  "exhausted": { color: "#b85544", soft: "#f0d3ce", label: "Funding exhausted" },
};
const GRANT_STATUS_ORDER = ["available", "limited", "exhausted"];

// The four South Yorkshire local authorities with a real tracked grant
// status and boundary shape (matches supabase/migrations/016_grant_areas.sql's
// seed rows and each area's `name` property in
// shared/south-yorkshire-boundaries.geojson). Fixed, not data-driven —
// unlike the pilot's other chip filters, this list intentionally doesn't
// grow/shrink with whatever local authorities happen to appear in
// `prospects`.
const GRANT_AREA_NAMED = ["Barnsley", "Doncaster", "Rotherham", "Sheffield"];

// Sidebar filter order: the four tracked areas, then a catch-all "Other"
// bucket for every other Yorkshire & Humber local authority in the pilot
// region (Leeds, Wakefield, Kirklees, Bradford, Calderdale, Hull, East
// Riding, York, North Yorkshire, North/North East Lincolnshire, etc.) —
// added 2026-09-08 so the area filter covers every lead, not just the four
// South Yorkshire ones. "Other" has no real boundary shape (it isn't one
// contiguous area) and no manager-editable status in dashboard.html — it's
// a sidebar filter convenience only, always rendered with a neutral grey
// dot.
const GRANT_AREA_ORDER = [...GRANT_AREA_NAMED, "Other"];
