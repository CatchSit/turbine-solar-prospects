// Which buildings each import script keeps, per region. Pick one with the
// REGION env var (default 'yorkshire-humber', the original pilot region, so
// running a script without it behaves exactly as before).
//
// las:          matched case-insensitively against the EPC's
//               LOCAL_AUTHORITY_LABEL.
// outcodes:     postcode areas also accepted (EPC fallback when the council
//               label is blank, and the VOA filter). null = council match
//               only, for regions whose postcode areas cross the boundary.
// voaBaCodes:   VOA billing-authority codes (field 1 of the rating list),
//               used instead of outcodes when set. Checked 2026-10-26
//               against the real 2026 list.
//
// West Midlands = the metropolitan county (7 councils). Its postcode areas
// (B, CV, DY, WS, WV) spill into Bromsgrove, Lichfield, Warwickshire etc.,
// so it filters by council, never by postcode.
export const REGIONS = {
  'yorkshire-humber': {
    las: [
      'leeds', 'sheffield', 'bradford', 'kirklees', 'wakefield', 'calderdale',
      'kingston upon hull, city of', 'kingston upon hull', 'hull',
      'east riding of yorkshire', 'york', 'north yorkshire',
      'doncaster', 'rotherham', 'barnsley',
      'north lincolnshire', 'north east lincolnshire',
    ],
    outcodes: ['BD', 'DN', 'HD', 'HG', 'HU', 'HX', 'LS', 'S', 'WF', 'YO'],
    voaBaCodes: null,
  },
  'west-midlands': {
    las: ['birmingham', 'coventry', 'dudley', 'sandwell', 'solihull', 'walsall', 'wolverhampton'],
    outcodes: null,
    voaBaCodes: ['4605', '4610', '4615', '4620', '4625', '4630', '4635'],
  },
};

export function getRegion() {
  const name = process.env.REGION || 'yorkshire-humber';
  const cfg = REGIONS[name];
  if (!cfg) throw new Error(`Unknown REGION "${name}" - expected one of: ${Object.keys(REGIONS).join(', ')}`);
  return {
    name,
    las: new Set(cfg.las),
    outcodes: cfg.outcodes ? new Set(cfg.outcodes) : null,
    voaBaCodes: cfg.voaBaCodes ? new Set(cfg.voaBaCodes) : null,
  };
}

export function postcodeOutcodeArea(postcode) {
  const m = String(postcode || '').trim().toUpperCase().match(/^([A-Z]{1,2})\d/);
  return m ? m[1] : '';
}
