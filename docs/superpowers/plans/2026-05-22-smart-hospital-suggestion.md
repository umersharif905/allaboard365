# Smart Hospital Suggestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a member picks a doctor, an organization-mode `provider_search` field suggests the facility registered at that doctor's exact practice street address.

**Architecture:** A new backend lookup matches a doctor's normalized practice street line against NPI-2 organizations in the same ZIP and returns the co-located ones. `PublicFormView` passes the selected doctor down to organization-mode `<ProviderSearchField>` widgets, which render the matches as a tap-to-pick suggestion. Builds on the shipped NPI provider-search feature.

**Tech Stack:** Node/Express + Jest/supertest (backend); React 18 + TypeScript + Vitest + Cypress (frontend).

**Spec:** `docs/superpowers/specs/2026-05-22-smart-hospital-suggestion-design.md`

**Environment:** No Node on the host — run tests inside the Docker containers:
- Backend Jest: `sudo docker exec -w /app/backend allaboard365-backend sh -lc "npx jest <path>"`
- Frontend Vitest: `sudo docker exec -w /app/frontend allaboard365-frontend sh -lc "npx vitest run <path>"`
- Frontend tsc: `sudo docker exec -w /app/frontend allaboard365-frontend sh -lc "npx tsc --noEmit"`
- Edit files at host paths under `/mnt/pool/docker/allaboard365/...`; run `git` on the host.
- Each commit's `git add` lists exact paths — never `git add -A`. Unrelated working-tree changes (deleted `frontend/public/config.json`, modified `frontend/package-lock.json`) must stay unstaged.

---

## Task 1: Backend — `normalizeStreet` helper

**Files:**
- Modify: `backend/services/publicNpiSearch.service.js`
- Test: `backend/services/__tests__/publicNpiSearch.service.test.js`

- [ ] **Step 1: Write the failing test**

In `backend/services/__tests__/publicNpiSearch.service.test.js`, change the import line at the top of the file from:

```js
const { searchProviders } = require('../publicNpiSearch.service');
```

to:

```js
const { searchProviders, normalizeStreet } = require('../publicNpiSearch.service');
```

Then append this block at the end of the file (after the final `});` that closes the existing `describe`):

```js

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
```

- [ ] **Step 2: Run the test to verify it fails**

`sudo docker exec -w /app/backend allaboard365-backend sh -lc "npx jest services/__tests__/publicNpiSearch.service.test.js"`
Expected: FAIL — `normalizeStreet is not a function`.

- [ ] **Step 3: Implement `normalizeStreet`**

In `backend/services/publicNpiSearch.service.js`, immediately before the line `module.exports = { searchProviders, zipDistance };`, add:

```js
// Street-type words → canonical abbreviation (NPPES addresses vary in spelling).
const STREET_ABBR = {
  STREET: 'ST', DRIVE: 'DR', AVENUE: 'AVE', ROAD: 'RD', BOULEVARD: 'BLVD',
  LANE: 'LN', COURT: 'CT', PLACE: 'PL', HIGHWAY: 'HWY', PARKWAY: 'PKWY',
  TERRACE: 'TER', CIRCLE: 'CIR'
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

```

Then change the export line from:

```js
module.exports = { searchProviders, zipDistance };
```

to:

```js
module.exports = { searchProviders, zipDistance, normalizeStreet };
```

- [ ] **Step 4: Run the test to verify it passes**

`sudo docker exec -w /app/backend allaboard365-backend sh -lc "npx jest services/__tests__/publicNpiSearch.service.test.js"`
Expected: PASS — all tests, including the 5 new `normalizeStreet` tests.

- [ ] **Step 5: Commit**

```bash
git add backend/services/publicNpiSearch.service.js backend/services/__tests__/publicNpiSearch.service.test.js
git commit -m "feat(forms): add normalizeStreet helper for address matching"
```

---

## Task 2: Backend — `findCoLocatedOrganizations` service

**Files:**
- Modify: `backend/services/publicNpiSearch.service.js`
- Test: `backend/services/__tests__/publicNpiSearch.service.test.js`

- [ ] **Step 1: Write the failing test**

In `backend/services/__tests__/publicNpiSearch.service.test.js`, change the import line from:

```js
const { searchProviders, normalizeStreet } = require('../publicNpiSearch.service');
```

to:

```js
const { searchProviders, normalizeStreet, findCoLocatedOrganizations } = require('../publicNpiSearch.service');
```

Immediately after the existing `rawOrg` helper function, add this fixture helper:

```js

function rawOrgAt(npi, orgName, address1, zip) {
  return {
    number: npi,
    enumeration_type: 'NPI-2',
    basic: { organization_name: orgName, status: 'A' },
    addresses: [
      { address_purpose: 'LOCATION', address_1: address1, city: 'Town', state: 'CT', postal_code: zip }
    ],
    taxonomies: [{ primary: true, desc: 'General Acute Care Hospital', code: '282N00000X' }]
  };
}
```

Then append this block at the end of the file (after the final `});`):

```js

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
});
```

- [ ] **Step 2: Run the test to verify it fails**

`sudo docker exec -w /app/backend allaboard365-backend sh -lc "npx jest services/__tests__/publicNpiSearch.service.test.js"`
Expected: FAIL — `findCoLocatedOrganizations is not a function`.

- [ ] **Step 3: Implement `findCoLocatedOrganizations`**

In `backend/services/publicNpiSearch.service.js`, immediately before the line `module.exports = { searchProviders, zipDistance, normalizeStreet };`, add:

```js
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

  const raw = await NPIService.search({
    enumeration_type: 'NPI-2',
    postal_code: zip5,
    limit: NPPES_LIMIT
  });
  const results = raw && Array.isArray(raw.results) ? raw.results : [];

  const byNpi = new Map();
  for (const r of results) {
    const p = toPublicProvider(NPIService.formatProviderData(r));
    if (p.npi && !byNpi.has(p.npi) && normalizeStreet(p.address1) === targetStreet) {
      byNpi.set(p.npi, p);
    }
  }
  return { providers: [...byNpi.values()] };
}

```

Then change the export line from:

```js
module.exports = { searchProviders, zipDistance, normalizeStreet };
```

to:

```js
module.exports = { searchProviders, zipDistance, normalizeStreet, findCoLocatedOrganizations };
```

- [ ] **Step 4: Run the test to verify it passes**

`sudo docker exec -w /app/backend allaboard365-backend sh -lc "npx jest services/__tests__/publicNpiSearch.service.test.js"`
Expected: PASS — all tests including the 4 new `findCoLocatedOrganizations` tests.

- [ ] **Step 5: Commit**

```bash
git add backend/services/publicNpiSearch.service.js backend/services/__tests__/publicNpiSearch.service.test.js
git commit -m "feat(forms): add findCoLocatedOrganizations address-match lookup"
```

---

## Task 3: Backend — `GET /co-located` route

**Files:**
- Modify: `backend/routes/public/npi-search.js`
- Test: `backend/routes/public/__tests__/npi-search.test.js`

- [ ] **Step 1: Write the failing test**

In `backend/routes/public/__tests__/npi-search.test.js`, change the `jest.mock` of the service from:

```js
jest.mock('../../../services/publicNpiSearch.service', () => ({
  searchProviders: jest.fn()
}));
```

to:

```js
jest.mock('../../../services/publicNpiSearch.service', () => ({
  searchProviders: jest.fn(),
  findCoLocatedOrganizations: jest.fn()
}));
```

Change the destructuring `require` of the service from:

```js
const { searchProviders } = require('../../../services/publicNpiSearch.service');
```

to:

```js
const { searchProviders, findCoLocatedOrganizations } = require('../../../services/publicNpiSearch.service');
```

Then append this block at the end of the file (after the final `});`):

```js

describe('GET /api/public/npi/co-located', () => {
  test('400 on a missing/invalid form id', async () => {
    const res = await request(buildApp())
      .get('/api/public/npi/co-located?address1=1%20Main%20St&zip=06770')
      .expect(400);
    expect(res.body.success).toBe(false);
  });

  test('401 when the form is not found or unpublished', async () => {
    publicFormAdminService.getPublishedDefinitionByTemplateId.mockResolvedValueOnce(null);
    const res = await request(buildApp())
      .get(`/api/public/npi/co-located?form=${VALID_FORM}&address1=1%20Main%20St&zip=06770`)
      .expect(401);
    expect(res.body.success).toBe(false);
  });

  test('200 returns co-located organizations for a valid form', async () => {
    publicFormAdminService.getPublishedDefinitionByTemplateId.mockResolvedValueOnce({ FormTemplateId: VALID_FORM });
    findCoLocatedOrganizations.mockResolvedValueOnce({
      providers: [{ source: 'registry', npi: '8000000001', name: 'Co-Located Surgery Center' }]
    });
    const res = await request(buildApp())
      .get(`/api/public/npi/co-located?form=${VALID_FORM}&address1=1%20Prestige%20Dr&zip=06770`)
      .expect(200);
    expect(res.body).toEqual({
      success: true,
      count: 1,
      data: [{ source: 'registry', npi: '8000000001', name: 'Co-Located Surgery Center' }]
    });
    expect(findCoLocatedOrganizations).toHaveBeenCalledWith({ address1: '1 Prestige Dr', zip: '06770' });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

`sudo docker exec -w /app/backend allaboard365-backend sh -lc "npx jest routes/public/__tests__/npi-search.test.js"`
Expected: FAIL — the co-located requests return 404 (route not defined).

- [ ] **Step 3: Implement the route**

In `backend/routes/public/npi-search.js`, change the service `require` from:

```js
const { searchProviders } = require('../../services/publicNpiSearch.service');
```

to:

```js
const { searchProviders, findCoLocatedOrganizations } = require('../../services/publicNpiSearch.service');
```

Then immediately before the line `module.exports = router;`, add:

```js
/**
 * GET /api/public/npi/co-located?form=<uuid>&address1=&zip=
 * Organizations registered at a given street address (smart hospital suggestion).
 */
router.get('/co-located', async (req, res) => {
  try {
    const { form, address1, zip } = req.query;

    if (!form || !uuidRe.test(String(form))) {
      return res.status(400).json({ success: false, message: 'Invalid form id' });
    }
    const formRow = await publicFormAdminService.getPublishedDefinitionByTemplateId(String(form));
    if (!formRow) {
      return res.status(401).json({ success: false, message: 'Form not found or not published' });
    }

    const { providers } = await findCoLocatedOrganizations({
      address1: address1 ? String(address1).trim() : '',
      zip: String(zip || '')
    });

    return res.json({ success: true, count: providers.length, data: providers });
  } catch (e) {
    const status = e.statusCode || 500;
    if (status >= 500) console.error('public npi co-located', e);
    return res.status(status).json({ success: false, message: e.message || 'Co-located lookup failed' });
  }
});

```

- [ ] **Step 4: Run the test to verify it passes**

`sudo docker exec -w /app/backend allaboard365-backend sh -lc "npx jest routes/public/__tests__/npi-search.test.js"`
Expected: PASS — all tests including the 3 new `/co-located` tests.

- [ ] **Step 5: Commit**

```bash
git add backend/routes/public/npi-search.js backend/routes/public/__tests__/npi-search.test.js
git commit -m "feat(forms): add GET /api/public/npi/co-located route"
```

---

## Task 4: Frontend — `findCoLocatedProviders` service

**Files:**
- Modify: `frontend/src/types/providerSearch.ts`
- Modify: `frontend/src/services/npiPublicSearch.service.ts`
- Test: `frontend/src/services/__tests__/npiPublicSearch.service.test.ts`

- [ ] **Step 1: Write the failing test**

In `frontend/src/services/__tests__/npiPublicSearch.service.test.ts`, change the import of the module under test from:

```ts
import { searchPublicProviders } from '../npiPublicSearch.service';
```

to:

```ts
import { searchPublicProviders, findCoLocatedProviders } from '../npiPublicSearch.service';
```

Then append this block at the end of the file (after the final `});`):

```ts

describe('findCoLocatedProviders', () => {
  it('builds the co-located URL with form, address1 and zip', async () => {
    mockedGet.mockResolvedValue({ success: true, count: 0, data: [] });
    await findCoLocatedProviders({ formId: 'form-1', address1: '1 Prestige Dr', zip: '06770' });
    expect(mockedGet).toHaveBeenCalledWith(
      '/api/public/npi/co-located?form=form-1&address1=1+Prestige+Dr&zip=06770'
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

`sudo docker exec -w /app/frontend allaboard365-frontend sh -lc "npx vitest run src/services/__tests__/npiPublicSearch.service.test.ts"`
Expected: FAIL — `findCoLocatedProviders` is not exported.

- [ ] **Step 3: Add the `CoLocatedResponse` type**

In `frontend/src/types/providerSearch.ts`, immediately after the `NpiSearchResponse` type, add:

```ts

/** Response shape of GET /api/public/npi/co-located. */
export type CoLocatedResponse = {
  success: boolean;
  count: number;
  data: NpiProvider[];
  message?: string;
};
```

- [ ] **Step 4: Add the `findCoLocatedProviders` function**

In `frontend/src/services/npiPublicSearch.service.ts`, change the type import from:

```ts
import type { NpiSearchResponse, ProviderSearchMode } from '../types/providerSearch';
```

to:

```ts
import type { CoLocatedResponse, NpiSearchResponse, ProviderSearchMode } from '../types/providerSearch';
```

Then append at the end of the file:

```ts

export type CoLocatedParams = {
  formId: string;
  address1: string;
  zip: string;
};

/** Look up organizations registered at a doctor's practice street address. */
export async function findCoLocatedProviders(
  params: CoLocatedParams
): Promise<CoLocatedResponse> {
  const qs = new URLSearchParams();
  qs.set('form', params.formId);
  qs.set('address1', params.address1);
  qs.set('zip', params.zip);
  return apiService.get<CoLocatedResponse>(`/api/public/npi/co-located?${qs.toString()}`);
}
```

- [ ] **Step 5: Run the test to verify it passes**

`sudo docker exec -w /app/frontend allaboard365-frontend sh -lc "npx vitest run src/services/__tests__/npiPublicSearch.service.test.ts"`
Expected: PASS — 3 tests.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/types/providerSearch.ts frontend/src/services/npiPublicSearch.service.ts frontend/src/services/__tests__/npiPublicSearch.service.test.ts
git commit -m "feat(forms): add findCoLocatedProviders frontend service"
```

---

## Task 5: Frontend — co-located suggestion in `<ProviderSearchField>`

**Files:**
- Modify: `frontend/src/components/public/fields/ProviderSearchField.tsx`
- Test: `frontend/src/components/public/fields/__tests__/ProviderSearchField.test.tsx`

- [ ] **Step 1: Write the failing test**

In `frontend/src/components/public/fields/__tests__/ProviderSearchField.test.tsx`, change the service mock from:

```tsx
vi.mock('../../../../services/npiPublicSearch.service', () => ({
  searchPublicProviders: vi.fn()
}));
import { searchPublicProviders } from '../../../../services/npiPublicSearch.service';
const mockedSearch = searchPublicProviders as unknown as ReturnType<typeof vi.fn>;
```

to:

```tsx
vi.mock('../../../../services/npiPublicSearch.service', () => ({
  searchPublicProviders: vi.fn(),
  findCoLocatedProviders: vi.fn()
}));
import { searchPublicProviders, findCoLocatedProviders } from '../../../../services/npiPublicSearch.service';
const mockedSearch = searchPublicProviders as unknown as ReturnType<typeof vi.fn>;
const mockedCoLocated = findCoLocatedProviders as unknown as ReturnType<typeof vi.fn>;
```

Then append this block at the end of the file (after the final `});`):

```tsx

describe('ProviderSearchField — co-located suggestion', () => {
  const orgField: FieldDef = {
    name: 'hospital_1',
    type: 'provider_search',
    label: 'Find your hospital',
    providerSearchMode: 'organization'
  };
  const linkedDoctor = {
    source: 'registry' as const,
    npi: '1234567890',
    name: 'Jane Smith, MD',
    address1: '1 Prestige Dr',
    zip: '06770'
  };

  it('fetches and shows facilities at the doctor’s office, and selects on tap', async () => {
    mockedCoLocated.mockResolvedValue({
      success: true,
      count: 1,
      data: [{ source: 'registry', npi: '8000000001', name: 'Co-Located Surgery Center', city: 'Naugatuck', state: 'CT' }]
    });
    const onChange = vi.fn();
    render(
      <ProviderSearchField
        field={orgField}
        formId="form-1"
        value={undefined}
        onChange={onChange}
        linkedProvider={linkedDoctor}
      />
    );

    await waitFor(() => expect(screen.getByText('Co-Located Surgery Center')).toBeInTheDocument());
    expect(mockedCoLocated).toHaveBeenCalledWith({
      formId: 'form-1', address1: '1 Prestige Dr', zip: '06770'
    });

    fireEvent.click(screen.getByText('Co-Located Surgery Center'));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'registry', npi: '8000000001' })
    );
  });

  it('does not fetch a suggestion when there is no linked doctor', () => {
    render(
      <ProviderSearchField field={orgField} formId="form-1" value={undefined} onChange={vi.fn()} />
    );
    expect(mockedCoLocated).not.toHaveBeenCalled();
  });

  it('does not fetch a suggestion for a manually-entered doctor', () => {
    render(
      <ProviderSearchField
        field={orgField}
        formId="form-1"
        value={undefined}
        onChange={vi.fn()}
        linkedProvider={{ source: 'manual', name: 'Some Clinic' }}
      />
    );
    expect(mockedCoLocated).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

`sudo docker exec -w /app/frontend allaboard365-frontend sh -lc "npx vitest run src/components/public/fields/__tests__/ProviderSearchField.test.tsx"`
Expected: FAIL — no "Co-Located Surgery Center" text (the suggestion is not implemented).

- [ ] **Step 3: Import `useEffect` and `findCoLocatedProviders`**

In `ProviderSearchField.tsx`, change the React import from:

```tsx
import { useState } from 'react';
```

to:

```tsx
import { useEffect, useState } from 'react';
```

Change the service import from:

```tsx
import { searchPublicProviders } from '../../../services/npiPublicSearch.service';
```

to:

```tsx
import { findCoLocatedProviders, searchPublicProviders } from '../../../services/npiPublicSearch.service';
```

- [ ] **Step 4: Add the `linkedProvider` prop**

Change the `Props` type from:

```tsx
type Props = {
  field: FieldDef;
  formId?: string;
  value: unknown;
  onChange: (v: ProviderFieldValue | undefined) => void;
  disabled?: boolean;
};
```

to:

```tsx
type Props = {
  field: FieldDef;
  formId?: string;
  value: unknown;
  onChange: (v: ProviderFieldValue | undefined) => void;
  disabled?: boolean;
  /** The doctor selected elsewhere on the form — drives the co-located suggestion. */
  linkedProvider?: ProviderFieldValue;
};
```

Change the function signature from:

```tsx
export default function ProviderSearchField({ field, formId, value, onChange, disabled }: Props) {
```

to:

```tsx
export default function ProviderSearchField({ field, formId, value, onChange, disabled, linkedProvider }: Props) {
```

- [ ] **Step 5: Add the co-located state and fetch effect**

In `ProviderSearchField.tsx`, immediately after the line `const [manual, setManual] = useState({ name: '', address1: '', city: '', state: '', zip: '' });`, add:

```tsx
  const [coLocated, setCoLocated] = useState<NpiProvider[]>([]);

  // The doctor's practice address, when a registry doctor is linked.
  const doctorAddr =
    linkedProvider && linkedProvider.source === 'registry' && linkedProvider.address1 && linkedProvider.zip
      ? { npi: linkedProvider.npi, address1: linkedProvider.address1, zip: linkedProvider.zip }
      : null;
```

Then, immediately after the `const selected = isProviderValue(value) ? value : null;` line, add:

```tsx

  useEffect(() => {
    if (mode !== 'organization' || !formId || selected || !doctorAddr) {
      setCoLocated([]);
      return;
    }
    let alive = true;
    findCoLocatedProviders({ formId, address1: doctorAddr.address1, zip: doctorAddr.zip })
      .then((res) => {
        if (alive) setCoLocated(res.data || []);
      })
      .catch(() => {
        if (alive) setCoLocated([]);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, formId, !!selected, doctorAddr?.npi, doctorAddr?.address1, doctorAddr?.zip]);
```

- [ ] **Step 6: Render the suggestion block**

In the search-state `return` (the `return (` that begins `<div className="space-y-2">`), immediately after that opening `<div className="space-y-2">` line and before the `<div className="grid grid-cols-1 sm:grid-cols-3 gap-2">` line, add:

```tsx
      {coLocated.length > 0 && (
        <div className="border border-oe-primary/30 rounded-lg bg-oe-light/30 p-2 space-y-1">
          <p className="text-xs font-medium text-oe-primary">Facilities at your provider's office</p>
          {coLocated.map((r) => (
            <button
              key={r.npi}
              type="button"
              onClick={() => onChange(r)}
              className="w-full px-2 py-1.5 text-left rounded hover:bg-oe-light text-sm"
            >
              <span className="font-medium text-gray-900">{r.name}</span>
              {(r.city || r.state) && (
                <span className="text-xs text-gray-500"> · {r.city}{r.city && r.state ? ', ' : ''}{r.state}</span>
              )}
            </button>
          ))}
        </div>
      )}
```

- [ ] **Step 7: Run the test + type-check to verify**

`sudo docker exec -w /app/frontend allaboard365-frontend sh -lc "npx vitest run src/components/public/fields/__tests__/ProviderSearchField.test.tsx"` — expect PASS, 6 tests (3 original + 3 new).
`sudo docker exec -w /app/frontend allaboard365-frontend sh -lc "npx tsc --noEmit 2>&1 | grep ProviderSearchField || echo 'no tsc errors in ProviderSearchField'"` — expect `no tsc errors in ProviderSearchField`.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/components/public/fields/ProviderSearchField.tsx frontend/src/components/public/fields/__tests__/ProviderSearchField.test.tsx
git commit -m "feat(forms): show co-located facility suggestion in ProviderSearchField"
```

---

## Task 6: Frontend — wire `linkedProvider` from `PublicFormView`

**Files:**
- Modify: `frontend/src/components/public/PublicFormView.tsx`

Verified by type-checking and the existing test suite; end-to-end behavior is covered by Task 7.

- [ ] **Step 1: Add the imports**

In `PublicFormView.tsx`, immediately after the line `import ProviderSearchField from './fields/ProviderSearchField';`, add:

```tsx
import { isProviderValue } from '../../utils/providerFieldValue';
import type { ProviderFieldValue } from '../../types/providerSearch';
```

- [ ] **Step 2: Compute `linkedDoctor`**

In `PublicFormView.tsx`, immediately after the line `const [values, setValues] = useState<Record<string, unknown>>(initialValues || {});`, add:

```tsx

  // The registry doctor selected on this form (if any) — drives the
  // co-located hospital suggestion for organization-mode provider fields.
  const linkedDoctor = useMemo<ProviderFieldValue | undefined>(() => {
    let found: ProviderFieldValue | undefined;
    for (const f of def.fields || []) {
      if (f.type === 'provider_search' && f.providerSearchMode === 'individual') {
        const v = values[f.name];
        if (isProviderValue(v) && v.source === 'registry') found = v;
      }
    }
    return found;
  }, [def.fields, values]);
```

- [ ] **Step 3: Pass `linkedProvider` to the widget**

In the `renderField` function, change the `provider_search` branch from:

```tsx
      {field.type === 'provider_search' ? (
        <ProviderSearchField
          field={field}
          formId={formId}
          value={values[field.name]}
          onChange={(v) => setField(field.name, v)}
          disabled={previewMode}
        />
      ) : null}
```

to:

```tsx
      {field.type === 'provider_search' ? (
        <ProviderSearchField
          field={field}
          formId={formId}
          value={values[field.name]}
          onChange={(v) => setField(field.name, v)}
          disabled={previewMode}
          linkedProvider={linkedDoctor}
        />
      ) : null}
```

- [ ] **Step 4: Type-check and run the frontend test suite**

`sudo docker exec -w /app/frontend allaboard365-frontend sh -lc "npx tsc --noEmit 2>&1 | grep PublicFormView || echo 'no tsc errors in PublicFormView'"` — expect `no tsc errors in PublicFormView`.
`sudo docker exec -w /app/frontend allaboard365-frontend sh -lc "npx vitest run"` — all test files pass except the two known pre-existing failures (`auth.service.login.test.ts`, `Vendors.minimum.test.tsx`), which are unrelated and untouched by this branch.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/public/PublicFormView.tsx
git commit -m "feat(forms): pass the selected doctor to organization provider fields"
```

---

## Task 7: Frontend — Cypress end-to-end spec

**Files:**
- Create: `frontend/cypress/e2e/forms/smart-hospital-suggestion.cy.ts`

Stub-driven — no live NPPES, no real submission. Cypress is not runnable in this environment (the container has no Cypress binary); create and commit the spec only.

- [ ] **Step 1: Create the spec**

Create `frontend/cypress/e2e/forms/smart-hospital-suggestion.cy.ts`:

```ts
describe('Smart hospital suggestion', () => {
  const formId = '22222222-2222-4222-8222-222222222222';

  const definition = {
    version: 1,
    title: 'Smart Suggestion Form',
    fields: [
      {
        name: 'doctor_1',
        type: 'provider_search',
        label: 'Find your doctor',
        required: true,
        providerSearchMode: 'individual'
      },
      {
        name: 'hospital_1',
        type: 'provider_search',
        label: 'Find your hospital',
        required: true,
        providerSearchMode: 'organization'
      }
    ]
  };

  beforeEach(() => {
    cy.intercept('GET', `/api/public/forms/${formId}`, {
      statusCode: 200,
      body: { success: true, data: { title: 'Smart Suggestion Form', definition } }
    }).as('loadForm');

    cy.intercept('GET', '/api/public/npi/search*', {
      statusCode: 200,
      body: {
        success: true,
        count: 1,
        widened: false,
        data: [
          {
            source: 'registry',
            npi: '1234567890',
            name: 'Jane Smith, MD',
            providerType: 'Physician',
            address1: '1 Prestige Dr',
            city: 'Meriden',
            state: 'CT',
            zip: '06770'
          }
        ]
      }
    }).as('npiSearch');

    cy.intercept('GET', '/api/public/npi/co-located*', {
      statusCode: 200,
      body: {
        success: true,
        count: 1,
        data: [
          {
            source: 'registry',
            npi: '8000000001',
            name: 'Co-Located Surgery Center',
            city: 'Meriden',
            state: 'CT',
            zip: '06770'
          }
        ]
      }
    }).as('coLocated');

    cy.intercept('POST', `/api/public/forms/${formId}/submit`, {
      statusCode: 201,
      body: { success: true, message: 'received', data: {} }
    }).as('submit');
  });

  it('suggests the co-located facility after a doctor is selected', () => {
    cy.visit(`/forms/${formId}`);
    cy.wait('@loadForm');

    // Select a doctor in the first provider field.
    cy.get('input[placeholder="Provider last name"]').type('Smith');
    cy.get('input[placeholder="Your ZIP code"]').first().type('06770');
    cy.contains('button', 'Search').first().click();
    cy.wait('@npiSearch');
    cy.contains('Jane Smith, MD').click();

    // The hospital field now shows the co-located suggestion with no typing.
    cy.wait('@coLocated');
    cy.contains("Facilities at your provider's office").should('be.visible');
    cy.contains('Co-Located Surgery Center').click();

    cy.contains('(registry-verified)').should('be.visible');
    cy.contains('button', /submit/i).click();
    cy.wait('@submit');
  });
});
```

- [ ] **Step 2: Verify the file exists**

Confirm `frontend/cypress/e2e/forms/smart-hospital-suggestion.cy.ts` was created. Do NOT run Cypress.

- [ ] **Step 3: Commit**

```bash
git add frontend/cypress/e2e/forms/smart-hospital-suggestion.cy.ts
git commit -m "test(forms): e2e spec for the smart hospital suggestion"
```

---

## Self-Review

- **Spec coverage:** §4.3 backend (`normalizeStreet`, `findCoLocatedOrganizations`) → Tasks 1–2; `GET /co-located` → Task 3. §4.4 frontend service → Task 4; `<ProviderSearchField>` suggestion → Task 5; `PublicFormView` `linkedProvider` → Task 6. §4.5 tests → woven into Tasks 1–5 + Cypress in 7. §4.1 data flow and §4.2 non-applicable cases (no doctor / manual doctor / field has value / org-mode only) are all enforced by the Task 5 effect guard `mode !== 'organization' || !formId || selected || !doctorAddr` and the `source === 'registry'` check in `doctorAddr`. No DB migration, no form-builder change — none in plan. ✓
- **Type consistency:** `CoLocatedResponse` defined in Task 4 (`types/providerSearch.ts`), consumed by `findCoLocatedProviders` (Task 4) and the widget (Task 5). `findCoLocatedProviders` params `{ formId, address1, zip }` match between Task 4 definition, Task 5 caller, and the Task 5 test. Backend `findCoLocatedOrganizations({ address1, zip })` consistent between Task 2 and the Task 3 route caller + test. `normalizeStreet` consistent Tasks 1–2. `linkedProvider` prop consistent Tasks 5–6. ✓
- **Placeholders:** none — every step has concrete code or an exact command.

## Notes for the implementer

- Tasks 1–3 share `backend/services/__tests__/publicNpiSearch.service.test.js` and the service file; the import/export lines change across tasks — apply each task's exact old→new.
- The Task 5 effect uses `!!selected` and the primitive `doctorAddr?.*` fields as deps deliberately (stable across renders); keep the `eslint-disable` line.
- Task 6 is verified by `tsc` + the suite; Task 7's Cypress spec covers the integration but is not run here (no Cypress binary in the container).
