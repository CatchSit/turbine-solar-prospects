// SIC-derived business sector bucketing — groups a company's SIC 2007 codes
// (shared/sic-codes.js has the full code->description table) into a small
// set of sectors plausibly more energy-intensive than a typical office or
// retail unit, complementing the EPC-floor-area proxy with an independent
// signal. See docs/superpowers/specs/2026-08-20-company-sector-maturity-classification-design.md
// for the reasoning behind each grouping — spot-check against real matched
// companies before trusting broadly (same discipline as BUILDING_TYPE_BUCKETS,
// HANDOVER.md Section 7 risk 3).
const SIC_SECTOR_BUCKETS = {
  "Food & Drink Production":                  ["10", "11"],
  "Manufacturing (Materials & Chemicals)":     ["13", "14", "15", "16", "17", "19", "20", "21", "22", "23", "24", "25"],
  "Cold Storage, Warehousing & Waste":         ["38", "52"],
  "Data, IT & Telecoms":                       ["61", "63"],
  "Healthcare":                                ["86", "87"],
  "Hospitality & Leisure":                     ["55", "56", "93"],
  "Laundries & Industrial Cleaning":           ["96010", "8122"],
};
const SIC_SECTOR_ORDER = [...Object.keys(SIC_SECTOR_BUCKETS), "Other"];

// Prefix match on the raw 5-digit SIC code string — covers both 2-digit
// division-level entries (e.g. "10" matches "10110") and the two specific
// codes above that need finer granularity than their division.
function bucketSicSector(sicCodes) {
  if (!sicCodes || !sicCodes.length) return null; // no company/SIC data at all
  for (const [bucket, prefixes] of Object.entries(SIC_SECTOR_BUCKETS)) {
    if (sicCodes.some(code => prefixes.some(p => String(code).startsWith(p)))) return bucket;
  }
  return "Other";
}

const SIC_SECTOR_COLORS = {
  "Food & Drink Production":               "#c08438",
  "Manufacturing (Materials & Chemicals)":  "#5d8a64",
  "Cold Storage, Warehousing & Waste":     "#6f5b94",
  "Data, IT & Telecoms":                   "#3c6e91",
  "Healthcare":                            "#b85544",
  "Hospitality & Leisure":                 "#2f5a3d",
  "Laundries & Industrial Cleaning":       "#8e6b3f",
  "Other":                                 "#b9b9a9",
};
