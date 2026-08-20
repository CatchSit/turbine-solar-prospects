// Company maturity bucketing from Companies House data already fetched by
// company-lookup / classify-companies.mjs — an established, actively-filing
// company is a safer sales target than a dormant or newly-incorporated one.
// Threshold is a plain tunable constant, same convention as MIN_FLOOR_AREA_M2
// (scripts/ingest-epc.mjs) and MAX_ACTIVE_COMPANIES (company-lookup).
const MATURITY_ESTABLISHED_YEARS = 3;
const MATURITY_DORMANT_ACCOUNTS_TYPES = ["dormant", "micro-entity"];

function bucketCompanyMaturity(company) {
  const incorporatedOn = company && company.incorporated_on;
  if (!incorporatedOn) return null; // no company match / no incorporation data at all
  const accountsType = company.accounts_type;
  if (accountsType && MATURITY_DORMANT_ACCOUNTS_TYPES.includes(accountsType)) return "Dormant/Minimal";
  const years = (Date.now() - new Date(incorporatedOn).getTime()) / (365.25 * 24 * 60 * 60 * 1000);
  return years >= MATURITY_ESTABLISHED_YEARS ? "Established" : "Newer";
}

const MATURITY_ORDER = ["Established", "Newer", "Dormant/Minimal"];
const MATURITY_COLORS = {
  "Established":     "#5d8a64",
  "Newer":           "#c08438",
  "Dormant/Minimal": "#9a9a9a",
};
