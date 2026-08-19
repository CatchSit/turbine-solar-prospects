Put downloaded EPC bulk CSV files here (gitignored — never commit raw EPC exports).

Download from https://get-energy-performance-data.communities.gov.uk/ (requires a
GOV.UK One Login account). See the root HANDOVER.md for the full manual pipeline steps.

`data/recommendations/` holds the separate "recommendations" bulk CSV export(s), used
by `scripts/ingest-epc-recommendations.mjs` (optional/additive — see HANDOVER.md
Section 4). Also gitignored (`data/**/*.csv` in `.gitignore` covers this subdirectory).
