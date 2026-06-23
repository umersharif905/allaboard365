// backend/services/publicNpiSearch.service.js
// Orchestrates public (anonymous) NPI provider search for public-form fields.
// Wraps NPIService (NPPES registry); adds ZIP-region widening + proximity sort.

const NPIService = require('./npiService');

const MAX_RESULTS = 20;
const WIDEN_THRESHOLD = 3;
const NPPES_LIMIT = 200;

/** Numeric distance between a provider ZIP and the entered 5-digit ZIP (proximity heuristic). */
function zipDistance(providerZip, enteredZip5) {
  const pz = parseInt(String(providerZip || '').replace(/\D/g, '').slice(0, 5), 10);
  const ez = parseInt(enteredZip5, 10);
  if (Number.isNaN(pz) || Number.isNaN(ez)) return Number.MAX_SAFE_INTEGER;
  return Math.abs(pz - ez);
}

/**
 * NPPES matches name fields exactly unless a trailing '*' is appended, which
 * turns it into a prefix match (min 2 chars before the '*'). Members type the
 * start of a name ("valley internal medicine"), not the registry's verbatim
 * formal name ("VALLEY INTERNAL MEDICINE ASSOCIATES P.C."), so always append it.
 */
function namePrefix(name) {
  const t = String(name || '').trim();
  return t.length >= 2 ? `${t}*` : t;
}

/**
 * NPPES query objects for the given mode.
 * Exact pass (widen=false) filters by the full 5-digit ZIP. Widen pass
 * (widen=true) broadens postal_code to a ZIP-prefix wildcard — 3 digits for
 * individuals, but only 2 digits for organizations: a hospital/facility serves
 * a wide area, so its registered ZIP rarely shares the member's 3-digit zone.
 * Name fields always use a trailing-'*' prefix match (see namePrefix).
 */
function buildQueries(mode, names, zip5, widen) {
  const queries = [];
  if ((mode === 'individual' || mode === 'both') && names.lastName) {
    const q = {
      enumeration_type: 'NPI-1',
      last_name: namePrefix(names.lastName),
      postal_code: widen ? `${zip5.slice(0, 3)}*` : zip5,
      limit: NPPES_LIMIT
    };
    if (names.firstName) q.first_name = names.firstName;
    queries.push(q);
  }
  if ((mode === 'organization' || mode === 'both') && names.organizationName) {
    queries.push({
      enumeration_type: 'NPI-2',
      organization_name: namePrefix(names.organizationName),
      postal_code: widen ? `${zip5.slice(0, 2)}*` : zip5,
      limit: NPPES_LIMIT
    });
  }
  return queries;
}

/** Reshape a formatProviderData() result into the trimmed public shape. */
function toPublicProvider(p) {
  return {
    source: 'registry',
    npi: p.npi,
    name: p.providerName,
    providerType: p.providerType || null,
    address1: p.address1 || null,
    address2: p.address2 || null,
    city: p.city || null,
    state: p.state || null,
    zip: p.zipCode || null,
    phone: p.phone || null,
    fax: p.fax || null,
    specialty: p.specialty || null
  };
}

async function runQueries(queries) {
  const out = [];
  for (const q of queries) {
    const raw = await NPIService.search(q);
    const results = raw && Array.isArray(raw.results) ? raw.results : [];
    for (const r of results) out.push(toPublicProvider(NPIService.formatProviderData(r)));
  }
  return out;
}

/**
 * Search NPPES for providers near a member's ZIP.
 * @param {object} args
 * @param {'individual'|'organization'|'both'} args.mode
 * @param {string} [args.lastName]
 * @param {string} [args.firstName]
 * @param {string} [args.organizationName]
 * @param {string} args.zip - member's 5-digit ZIP
 * @returns {Promise<{ providers: object[], widened: boolean }>}
 */
async function searchProviders({ mode, lastName, firstName, organizationName, zip }) {
  const zip5 = String(zip || '').replace(/\D/g, '').slice(0, 5);
  if (zip5.length !== 5) {
    const err = new Error('A 5-digit ZIP code is required');
    err.statusCode = 400;
    throw err;
  }
  const safeMode = ['individual', 'organization', 'both'].includes(mode) ? mode : 'individual';
  const names = {
    lastName: (lastName || '').trim(),
    firstName: (firstName || '').trim(),
    organizationName: (organizationName || '').trim()
  };

  let providers = await runQueries(buildQueries(safeMode, names, zip5, false));
  let widened = false;

  if (providers.length < WIDEN_THRESHOLD) {
    const wide = await runQueries(buildQueries(safeMode, names, zip5, true));
    if (wide.length > providers.length) {
      providers = wide;
      widened = true;
    }
  }

  const byNpi = new Map();
  for (const p of providers) {
    if (p && p.npi && !byNpi.has(p.npi)) byNpi.set(p.npi, p);
  }
  const deduped = [...byNpi.values()];
  deduped.sort((a, b) => zipDistance(a.zip, zip5) - zipDistance(b.zip, zip5));

  return { providers: deduped.slice(0, MAX_RESULTS), widened };
}

// Street-type words and directionals → canonical abbreviation (NPPES addresses
// vary in spelling — e.g. one record has "3737 WEST MAIN STREET" while another
// at the same building has "3737 W MAIN ST"; both must normalize equal).
const STREET_ABBR = {
  // Street types
  STREET: 'ST', DRIVE: 'DR', AVENUE: 'AVE', ROAD: 'RD', BOULEVARD: 'BLVD',
  LANE: 'LN', COURT: 'CT', PLACE: 'PL', HIGHWAY: 'HWY', PARKWAY: 'PKWY',
  TERRACE: 'TER', CIRCLE: 'CIR',
  // Directionals
  NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W',
  NORTHEAST: 'NE', NORTHWEST: 'NW', SOUTHEAST: 'SE', SOUTHWEST: 'SW'
};

// Tokens that begin a unit/suite designator — the street line is cut here.
const UNIT_TOKENS = new Set([
  '#', 'STE', 'SUITE', 'UNIT', 'FL', 'FLOOR', 'APT', 'BLDG', 'BUILDING', 'RM', 'ROOM', 'DEPT'
]);

/**
 * Normalize a US street line for equality comparison: uppercase, strip
 * punctuation, canonicalize street-type words, and drop any unit/suite tail.
 * Returns '' for empty/invalid input.
 */
function normalizeStreet(street) {
  const raw = String(street || '').toUpperCase().replace(/[.,]/g, ' ').replace(/#/g, ' # ');
  const out = [];
  for (const tok of raw.split(/\s+/).filter(Boolean)) {
    if (UNIT_TOKENS.has(tok)) break;
    out.push(STREET_ABBR[tok] || tok);
  }
  return out.join(' ');
}

/**
 * Find NPI-2 organizations registered at a given street address. Searches
 * NPPES by ZIP, then keeps only organizations whose LOCATION street line
 * matches the input (normalized via normalizeStreet). Silent: invalid input
 * yields an empty list rather than throwing.
 * @param {object} args
 * @param {string} args.address1 - the doctor's practice street line
 * @param {string} args.zip - the doctor's practice ZIP
 * @returns {Promise<{ providers: object[] }>}
 */
async function findCoLocatedOrganizations({ address1, zip }) {
  const zip5 = String(zip || '').replace(/\D/g, '').slice(0, 5);
  const targetStreet = normalizeStreet(address1);
  if (zip5.length !== 5 || !targetStreet) {
    return { providers: [] };
  }

  // NPPES caps each request at 200 results and `skip` at 1000. Dense ZIPs
  // (Salem VA 24153 has 200+ NPI-2 orgs) can push the co-located org past the
  // first page, so we page through until a page returns fewer than the limit
  // (= last page) or we hit NPPES's max skip. Sequential with early break →
  // 1 request for the common case (<200 orgs in the ZIP), up to 6 for the
  // dense-ZIP case.
  const MAX_SKIP = 1000;
  const byNpi = new Map();
  for (let skip = 0; skip <= MAX_SKIP; skip += NPPES_LIMIT) {
    const raw = await NPIService.search({
      enumeration_type: 'NPI-2',
      postal_code: zip5,
      limit: NPPES_LIMIT,
      skip
    });
    const results = raw && Array.isArray(raw.results) ? raw.results : [];
    for (const r of results) {
      const p = toPublicProvider(NPIService.formatProviderData(r));
      if (p.npi && !byNpi.has(p.npi) && normalizeStreet(p.address1) === targetStreet) {
        byNpi.set(p.npi, p);
      }
    }
    if (results.length < NPPES_LIMIT) break;
  }

  // Group same-name entries — a single facility (e.g. "HARTFORD HOSPITAL")
  // often registers many NPIs at the same building for separate billing arms /
  // departments, all under the same organization_name. Pick one "umbrella" per
  // name (preferring providerType "Hospital" so a plain tap yields the main
  // hospital NPI) and attach the rest as `departments` so the UI can offer
  // them as a sub-selection. Solo entries (no siblings) have no `departments`.
  const groups = new Map();
  for (const p of byNpi.values()) {
    const key = String(p.name || '').toUpperCase().trim();
    if (!key) continue;
    const g = groups.get(key);
    if (!g) {
      groups.set(key, { umbrella: p, all: [p] });
    } else {
      g.all.push(p);
      if (g.umbrella.providerType !== 'Hospital' && p.providerType === 'Hospital') {
        g.umbrella = p;
      }
    }
  }
  const providers = [...groups.values()].map(({ umbrella, all }) => {
    const departments = all
      .filter((x) => x.npi !== umbrella.npi)
      .map((x) => ({ npi: x.npi, specialty: x.specialty || null, providerType: x.providerType || null }));
    return departments.length > 0 ? { ...umbrella, departments } : umbrella;
  });
  return { providers };
}

module.exports = { searchProviders, zipDistance, normalizeStreet, findCoLocatedOrganizations };
