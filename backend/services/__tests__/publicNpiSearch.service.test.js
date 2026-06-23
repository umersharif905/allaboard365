const NPIService = require('../npiService');
const { searchProviders, normalizeStreet, findCoLocatedOrganizations } = require('../publicNpiSearch.service');

function rawIndividual(npi, lastName, zip) {
  return {
    number: npi,
    enumeration_type: 'NPI-1',
    basic: { first_name: 'Jane', last_name: lastName, status: 'A' },
    addresses: [
      { address_purpose: 'LOCATION', address_1: '1 Main St', city: 'Town', state: 'CT', postal_code: zip }
    ],
    taxonomies: [{ primary: true, desc: 'Internal Medicine', code: '207R00000X' }]
  };
}

function rawOrg(npi, orgName, zip) {
  return {
    number: npi,
    enumeration_type: 'NPI-2',
    basic: { organization_name: orgName, status: 'A' },
    addresses: [
      { address_purpose: 'LOCATION', address_1: '1 Hospital Way', city: 'Town', state: 'CT', postal_code: zip }
    ],
    taxonomies: [{ primary: true, desc: 'General Acute Care Hospital', code: '282N00000X' }]
  };
}

function rawOrgAt(npi, orgName, address1, zip, taxonomyDesc = 'General Acute Care Hospital') {
  return {
    number: npi,
    enumeration_type: 'NPI-2',
    basic: { organization_name: orgName, status: 'A' },
    addresses: [
      { address_purpose: 'LOCATION', address_1: address1, city: 'Town', state: 'CT', postal_code: zip }
    ],
    taxonomies: [{ primary: true, desc: taxonomyDesc, code: '282N00000X' }]
  };
}

describe('publicNpiSearch.service searchProviders', () => {
  afterEach(() => jest.restoreAllMocks());

  test('forwards the NPPES fax number on each provider result', async () => {
    const withFax = rawIndividual('1000000009', 'Smith', '06770');
    withFax.addresses[0].fax_number = '203-555-0142';
    const others = ['1', '2'].map((n) => rawIndividual(`30000000${n}9`, 'Smith', '06770'));
    jest.spyOn(NPIService, 'search').mockResolvedValueOnce({ result_count: 3, results: [withFax, ...others] });

    const out = await searchProviders({ mode: 'individual', lastName: 'Smith', zip: '06770' });

    const target = out.providers.find((p) => p.npi === '1000000009');
    expect(target.fax).toBe('203-555-0142');
  });

  test('rejects a non-5-digit ZIP', async () => {
    await expect(searchProviders({ mode: 'individual', lastName: 'Smith', zip: '123' }))
      .rejects.toThrow('5-digit ZIP');
  });

  test('exact pass with enough results does not widen', async () => {
    const results = ['1', '2', '3', '4', '5', '6'].map((n) => rawIndividual(`100000000${n}`, 'Smith', '06770'));
    const spy = jest.spyOn(NPIService, 'search').mockResolvedValueOnce({ result_count: 6, results });

    const out = await searchProviders({ mode: 'individual', lastName: 'Smith', zip: '06770' });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(out.widened).toBe(false);
    expect(out.providers).toHaveLength(6);
    expect(out.providers[0].source).toBe('registry');
  });

  test('thin exact pass triggers a widen pass', async () => {
    const exact = [rawIndividual('1000000001', 'Smith', '06770')];
    const wide = ['1', '2', '3', '4', '5', '6', '7', '8'].map((n) => rawIndividual(`200000000${n}`, 'Smith', `067${n}0`));
    const spy = jest.spyOn(NPIService, 'search')
      .mockResolvedValueOnce({ result_count: 1, results: exact })
      .mockResolvedValueOnce({ result_count: 8, results: wide });

    const out = await searchProviders({ mode: 'individual', lastName: 'Smith', zip: '06770' });

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0][0].postal_code).toBe('06770');
    expect(spy.mock.calls[1][0].postal_code).toBe('067*');
    expect(out.widened).toBe(true);
    expect(out.providers.length).toBe(8);
  });

  test('deduplicates by NPI and caps at 20', async () => {
    const many = [];
    for (let i = 0; i < 25; i++) many.push(rawIndividual(`30000000${String(i).padStart(2, '0')}`, 'Smith', '06770'));
    many.push(rawIndividual('3000000000', 'Smith', '06770')); // duplicate NPI
    jest.spyOn(NPIService, 'search').mockResolvedValueOnce({ result_count: many.length, results: many });

    const out = await searchProviders({ mode: 'individual', lastName: 'Smith', zip: '06770' });

    expect(out.providers.length).toBe(20);
    const npis = out.providers.map((p) => p.npi);
    expect(new Set(npis).size).toBe(npis.length);
  });

  test('sorts results by ZIP closeness to the entered ZIP', async () => {
    const results = [
      rawIndividual('4000000001', 'Smith', '06800'),
      rawIndividual('4000000002', 'Smith', '06770'),
      rawIndividual('4000000003', 'Smith', '06775')
    ];
    jest.spyOn(NPIService, 'search').mockResolvedValueOnce({ result_count: 3, results });

    const out = await searchProviders({ mode: 'individual', lastName: 'Smith', zip: '06770' });

    expect(out.providers.map((p) => p.zip)).toEqual(['06770', '06775', '06800']);
  });

  test('both mode runs an NPI-1 and an NPI-2 query', async () => {
    const spy = jest.spyOn(NPIService, 'search')
      .mockResolvedValueOnce({ result_count: 1, results: [rawIndividual('5000000001', 'Smith', '06770')] })
      .mockResolvedValueOnce({ result_count: 0, results: [] })
      .mockResolvedValueOnce({ result_count: 0, results: [] })
      .mockResolvedValueOnce({ result_count: 0, results: [] });

    await searchProviders({ mode: 'both', lastName: 'Smith', organizationName: 'Smith', zip: '06770' });

    expect(spy.mock.calls[0][0].enumeration_type).toBe('NPI-1');
    expect(spy.mock.calls[1][0].enumeration_type).toBe('NPI-2');
    // exact pass (NPI-1 + NPI-2) + widen pass (NPI-1 + NPI-2) — guards the widen branch
    expect(spy).toHaveBeenCalledTimes(4);
  });

  test('organization mode widens to a 2-digit ZIP prefix (wider than individual)', async () => {
    const spy = jest.spyOn(NPIService, 'search')
      .mockResolvedValueOnce({ result_count: 0, results: [] })
      .mockResolvedValueOnce({
        result_count: 2,
        results: [rawOrg('6000000001', 'Town Hospital', '06801'), rawOrg('6000000002', 'City Hospital', '06010')]
      });

    const out = await searchProviders({ mode: 'organization', organizationName: 'Hospital', zip: '06770' });

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0][0]).toMatchObject({ enumeration_type: 'NPI-2', postal_code: '06770' });
    expect(spy.mock.calls[1][0]).toMatchObject({ enumeration_type: 'NPI-2', postal_code: '06*' });
    expect(out.widened).toBe(true);
    expect(out.providers.length).toBe(2);
  });

  test('appends a trailing wildcard to name fields for prefix matching', async () => {
    const spy = jest.spyOn(NPIService, 'search')
      .mockResolvedValueOnce({ result_count: 1, results: [rawIndividual('7000000001', 'Smith', '06770')] })
      .mockResolvedValueOnce({
        result_count: 1,
        results: [rawOrg('7000000002', 'Valley Internal Medicine Associates P.C.', '06770')]
      })
      .mockResolvedValueOnce({ result_count: 0, results: [] })
      .mockResolvedValueOnce({ result_count: 0, results: [] });

    await searchProviders({
      mode: 'both',
      lastName: 'Smith',
      organizationName: 'Valley Internal Medicine',
      zip: '06770'
    });

    expect(spy.mock.calls[0][0].last_name).toBe('Smith*');
    expect(spy.mock.calls[1][0].organization_name).toBe('Valley Internal Medicine*');
  });
});

describe('publicNpiSearch.service normalizeStreet', () => {
  test('uppercases, trims, collapses whitespace', () => {
    expect(normalizeStreet('  100   main  st  ')).toBe('100 MAIN ST');
  });

  test('canonicalizes street-type words to abbreviations', () => {
    expect(normalizeStreet('1 Prestige Drive')).toBe('1 PRESTIGE DR');
    expect(normalizeStreet('1250 Silver Street')).toBe('1250 SILVER ST');
    expect(normalizeStreet('90 S Main Avenue')).toBe('90 S MAIN AVE');
  });

  test('treats abbreviated and spelled-out forms as equal', () => {
    expect(normalizeStreet('1250 Silver St')).toBe(normalizeStreet('1250 Silver Street'));
  });

  test('canonicalizes directional words (WEST = W, NORTH = N, etc.)', () => {
    expect(normalizeStreet('3737 West Main Street')).toBe('3737 W MAIN ST');
    expect(normalizeStreet('3737 West Main Street')).toBe(normalizeStreet('3737 W Main St'));
    expect(normalizeStreet('100 North Pollard Ave')).toBe(normalizeStreet('100 N Pollard Ave'));
    expect(normalizeStreet('22 Northeast Highway')).toBe('22 NE HWY');
  });

  test('drops a unit/suite tail', () => {
    expect(normalizeStreet('1 Prestige Dr Ste 200')).toBe('1 PRESTIGE DR');
    expect(normalizeStreet('1 Prestige Dr., Suite 200')).toBe('1 PRESTIGE DR');
    expect(normalizeStreet('1 Main St #200')).toBe('1 MAIN ST');
    expect(normalizeStreet('1 Main St Floor 3')).toBe('1 MAIN ST');
  });

  test('returns empty string for empty/invalid input', () => {
    expect(normalizeStreet('')).toBe('');
    expect(normalizeStreet(null)).toBe('');
    expect(normalizeStreet(undefined)).toBe('');
  });
});

describe('publicNpiSearch.service findCoLocatedOrganizations', () => {
  afterEach(() => jest.restoreAllMocks());

  test('returns empty without calling NPPES when ZIP is not 5 digits', async () => {
    const spy = jest.spyOn(NPIService, 'search');
    const out = await findCoLocatedOrganizations({ address1: '1 Main St', zip: '123' });
    expect(out.providers).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  test('returns empty without calling NPPES when address is blank', async () => {
    const spy = jest.spyOn(NPIService, 'search');
    const out = await findCoLocatedOrganizations({ address1: '   ', zip: '06770' });
    expect(out.providers).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  test('keeps only organizations whose street address matches the doctor', async () => {
    jest.spyOn(NPIService, 'search').mockResolvedValueOnce({
      result_count: 3,
      results: [
        rawOrgAt('8000000001', 'Co-Located Surgery Center', '1 Prestige Drive', '06770'),
        rawOrgAt('8000000002', 'Unrelated Clinic', '999 Other Rd', '06770'),
        rawOrgAt('8000000003', 'Co-Located Imaging', '1 PRESTIGE DR STE 4', '06770')
      ]
    });

    const out = await findCoLocatedOrganizations({ address1: '1 Prestige Dr', zip: '06770' });

    expect(out.providers.map((p) => p.npi).sort()).toEqual(['8000000001', '8000000003']);
    expect(out.providers.every((p) => p.source === 'registry')).toBe(true);
  });

  test('returns empty when no organization shares the address', async () => {
    jest.spyOn(NPIService, 'search').mockResolvedValueOnce({
      result_count: 1,
      results: [rawOrgAt('8000000009', 'Somewhere Else', '500 Far Away Blvd', '06770')]
    });
    const out = await findCoLocatedOrganizations({ address1: '1 Prestige Dr', zip: '06770' });
    expect(out.providers).toEqual([]);
  });

  test('paginates NPPES when the first page is full (finds matches past the first 200)', async () => {
    // Page 1 is a full 200-result NPPES page of unrelated orgs (dense ZIP).
    const fullFirstPage = [];
    for (let i = 0; i < 200; i++) {
      fullFirstPage.push(rawOrgAt(`5${String(i).padStart(9, '0')}`, `Other Org ${i}`, '999 Unrelated Rd', '24153'));
    }
    // Page 2 contains the actual co-located org.
    const spy = jest.spyOn(NPIService, 'search')
      .mockResolvedValueOnce({ result_count: 200, results: fullFirstPage })
      .mockResolvedValueOnce({
        result_count: 1,
        results: [rawOrgAt('1255438461', 'Valley Internal Medicine Associates P.C.', '3737 W. MAIN STREET', '24153')]
      });

    const out = await findCoLocatedOrganizations({ address1: '3737 WEST MAIN STREET', zip: '24153' });

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0][0]).toMatchObject({ enumeration_type: 'NPI-2', postal_code: '24153', skip: 0 });
    expect(spy.mock.calls[1][0]).toMatchObject({ enumeration_type: 'NPI-2', postal_code: '24153', skip: 200 });
    expect(out.providers.map((p) => p.name)).toEqual(['Valley Internal Medicine Associates P.C.']);
  });

  test('collapses same-name entries into a parent + departments[]', async () => {
    jest.spyOn(NPIService, 'search').mockResolvedValueOnce({
      result_count: 4,
      results: [
        // Three "Hartford Hospital" entries — same building, mixed taxonomies
        rawOrgAt('9000000001', 'HARTFORD HOSPITAL', '80 Seymour St', '06102', 'Clinic/Center, Dental'),
        rawOrgAt('9000000002', 'HARTFORD HOSPITAL', '80 Seymour St', '06102', 'General Acute Care Hospital'),
        rawOrgAt('9000000003', 'HARTFORD HOSPITAL', '80 Seymour St', '06102', 'Pathology'),
        // A genuinely different org at the same building
        rawOrgAt('9000000004', 'Jefferson Radiology PC', '80 Seymour St', '06102', 'Nuclear Medicine')
      ]
    });

    const out = await findCoLocatedOrganizations({ address1: '80 Seymour St', zip: '06102' });

    const names = out.providers.map((p) => p.name).sort();
    expect(names).toEqual(['HARTFORD HOSPITAL', 'Jefferson Radiology PC']);

    const hh = out.providers.find((p) => p.name === 'HARTFORD HOSPITAL');
    expect(hh.npi).toBe('9000000002'); // umbrella = the Hospital-typed one
    expect(hh.providerType).toBe('Hospital');
    expect(hh.departments).toHaveLength(2);
    expect(hh.departments.map((d) => d.npi).sort()).toEqual(['9000000001', '9000000003']);
    // each department carries its own specialty for the UI sub-list
    expect(hh.departments.find((d) => d.npi === '9000000001').specialty).toContain('Dental');

    const jr = out.providers.find((p) => p.name === 'Jefferson Radiology PC');
    expect(jr.departments).toBeUndefined(); // single entry → no departments field
  });
});
