// EPC PROPERTY_TYPE bucketing — groups EPC's property_type (UK planning Use
// Classes Order labels, not free text) into ~6 buckets via word-boundary
// keyword matching. Spot-checked against real ingested data — see
// HANDOVER.md Section 7, risk 3 for the one known ambiguous case (B1
// "Offices and Workshop businesses" landing in Warehouse/Industrial).
// Depended on by shared/talking-points.js (bucketPropertyType), so this file
// must load before it — see index.html's shared-script block.
const BUILDING_TYPE_BUCKETS = {
  // Checked in this order — "Retail" must come before "Warehouse/Industrial"
  // so EPC's "Retail Warehouse" property type lands in Retail, not Industrial.
  "Retail":               ["retail", "shop", "supermarket", "shopping"],
  "Warehouse/Industrial": ["warehouse", "industrial", "factory", "distribution", "storage", "workshop", "manufacturing"],
  "Office":                ["office"],
  "Hotel/Leisure":        ["hotel", "leisure", "restaurant", "pub", "bar", "sport", "gym", "cinema"],
  "Healthcare":           ["hospital", "health", "clinic", "surgery", "care home"],
  "Education":            ["school", "college", "university", "education"],
};
const BUILDING_TYPE_ORDER = [...Object.keys(BUILDING_TYPE_BUCKETS), "Other"];

// Word-boundary matching, not plain substring — otherwise short keywords like
// "bar" or "sport" false-match inside unrelated words ("barn", "transport").
const BUILDING_TYPE_MATCHERS = Object.fromEntries(
  Object.entries(BUILDING_TYPE_BUCKETS).map(([bucket, keywords]) => [
    bucket, keywords.map(k => new RegExp(`\\b${k}s?\\b`, "i")),
  ])
);

function bucketPropertyType(pt) {
  const text = pt || "";
  for (const [bucket, matchers] of Object.entries(BUILDING_TYPE_MATCHERS)) {
    if (matchers.some(re => re.test(text))) return bucket;
  }
  return "Other";
}

const BUILDING_TYPE_COLORS = {
  "Warehouse/Industrial": "#5d8a64",
  "Retail":               "#c08438",
  "Office":               "#6f5b94",
  "Hotel/Leisure":        "#2f5a3d",
  "Healthcare":           "#b85544",
  "Education":            "#8e9080",
  "Other":                "#b9b9a9",
};
