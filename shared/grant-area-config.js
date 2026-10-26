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
//
// West Midlands councils (metropolitan county), added 2026-10-26 when its
// EPC/VOA leads were imported (region 'west-midlands'). Their own chips in
// the area filter, but no grant status or boundary shading - the tracked
// grant is South Yorkshire's.
const WEST_MIDLANDS_AREAS = ["Birmingham", "Coventry", "Dudley", "Sandwell", "Solihull", "Walsall", "Wolverhampton"];
const GRANT_AREA_ORDER = [...GRANT_AREA_NAMED, ...WEST_MIDLANDS_AREAS, "Other"];
function areaBucket(localAuthority) {
  return GRANT_AREA_NAMED.includes(localAuthority) || WEST_MIDLANDS_AREAS.includes(localAuthority) ? localAuthority : 'Other';
}

// Pipeline regions (prospects.region) the map loads one at a time - the
// full set is too slow to load in one go. `bounds` is where the map moves
// when that region is loaded.
const PIPELINE_REGIONS = [
  { key: 'yorkshire-humber', label: 'Yorkshire', bounds: [[53.25, -2.2], [54.4, -0.1]] },
  { key: 'west-midlands', label: 'West Midlands', bounds: [[52.34, -2.22], [52.68, -1.42]] },
];
