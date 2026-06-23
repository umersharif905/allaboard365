# NPI Provider-Search Form Field Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `provider_search` form-builder field type that lets a public-form respondent find a healthcare provider (PCP or hospital) via the national NPI registry, with a manual-entry fallback.

**Architecture:** A new public (anonymous, form-scoped, rate-limited) backend endpoint proxies the NPPES registry through the existing `npiService`. A new configurable form-builder field type renders a `<ProviderSearchField>` widget on the public form; the selected provider is stored as a structured object in the submission payload and formatted for the submission detail page and PDF.

**Tech Stack:** Node/Express + Jest/supertest (backend); React 18 + TypeScript + Vite + Vitest + Cypress (frontend); Tailwind + lucide-react (UI).

**Spec:** `docs/superpowers/specs/2026-05-21-npi-provider-search-form-field-design.md`

---

## Task 1: Backend — public NPI search service

**Files:**
- Create: `backend/services/publicNpiSearch.service.js`
- Test: `backend/services/__tests__/publicNpiSearch.service.test.js`

- [ ] **Step 1: Write the failing test**

Create `backend/services/__tests__/publicNpiSearch.service.test.js`:

```js
const NPIService = require('../npiService');
const { searchProviders } = require('../publicNpiSearch.service');

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

describe('publicNpiSearch.service searchProviders', () => {
  afterEach(() => jest.restoreAllMocks());

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
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npx jest services/__tests__/publicNpiSearch.service.test.js`
Expected: FAIL — `Cannot find module '../publicNpiSearch.service'`.

- [ ] **Step 3: Write the implementation**

Create `backend/services/publicNpiSearch.service.js`:

```js
// backend/services/publicNpiSearch.service.js
// Orchestrates public (anonymous) NPI provider search for public-form fields.
// Wraps NPIService (NPPES registry); adds ZIP-region widening + proximity sort.

const NPIService = require('./npiService');

const MAX_RESULTS = 20;
const WIDEN_THRESHOLD = 5;
const NPPES_LIMIT = 200;

/** Numeric distance between a provider ZIP and the entered 5-digit ZIP (proximity heuristic). */
function zipDistance(providerZip, enteredZip5) {
  const pz = parseInt(String(providerZip || '').replace(/\D/g, '').slice(0, 5), 10);
  const ez = parseInt(enteredZip5, 10);
  if (Number.isNaN(pz) || Number.isNaN(ez)) return Number.MAX_SAFE_INTEGER;
  return Math.abs(pz - ez);
}

/** NPPES query objects for the given mode + postal code. */
function buildQueries(mode, names, postalCode) {
  const queries = [];
  if ((mode === 'individual' || mode === 'both') && names.lastName) {
    const q = { enumeration_type: 'NPI-1', last_name: names.lastName, postal_code: postalCode, limit: NPPES_LIMIT };
    if (names.firstName) q.first_name = names.firstName;
    queries.push(q);
  }
  if ((mode === 'organization' || mode === 'both') && names.organizationName) {
    queries.push({
      enumeration_type: 'NPI-2',
      organization_name: names.organizationName,
      postal_code: postalCode,
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

  let providers = await runQueries(buildQueries(safeMode, names, zip5));
  let widened = false;

  if (providers.length < WIDEN_THRESHOLD) {
    const region = `${zip5.slice(0, 3)}*`;
    const wide = await runQueries(buildQueries(safeMode, names, region));
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

module.exports = { searchProviders, zipDistance };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && npx jest services/__tests__/publicNpiSearch.service.test.js`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/services/publicNpiSearch.service.js backend/services/__tests__/publicNpiSearch.service.test.js
git commit -m "feat(forms): add public NPI provider search service"
```

---

## Task 2: Backend — public NPI search route + registration

**Files:**
- Create: `backend/routes/public/npi-search.js`
- Modify: `backend/app.js` (after the `/api/public/forms` registration block, ~line 795)
- Test: `backend/routes/public/__tests__/npi-search.test.js`

- [ ] **Step 1: Write the failing test**

Create `backend/routes/public/__tests__/npi-search.test.js`:

```js
const express = require('express');
const request = require('supertest');

jest.mock('../../../services/publicFormAdminService', () => ({
  getPublishedDefinitionByTemplateId: jest.fn()
}));
jest.mock('../../../services/publicNpiSearch.service', () => ({
  searchProviders: jest.fn()
}));

const publicFormAdminService = require('../../../services/publicFormAdminService');
const { searchProviders } = require('../../../services/publicNpiSearch.service');
const npiSearchRoutes = require('../npi-search');

beforeAll(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => {
  console.error.mockRestore();
});
beforeEach(() => jest.clearAllMocks());

function buildApp() {
  const app = express();
  app.use('/api/public/npi', npiSearchRoutes);
  return app;
}

const VALID_FORM = '11111111-1111-4111-8111-111111111111';

describe('GET /api/public/npi/search', () => {
  test('400 on a missing/invalid form id', async () => {
    const res = await request(buildApp())
      .get('/api/public/npi/search?mode=individual&lastName=Smith&zip=06770')
      .expect(400);
    expect(res.body.success).toBe(false);
  });

  test('401 when the form is not found or unpublished', async () => {
    publicFormAdminService.getPublishedDefinitionByTemplateId.mockResolvedValueOnce(null);
    const res = await request(buildApp())
      .get(`/api/public/npi/search?form=${VALID_FORM}&mode=individual&lastName=Smith&zip=06770`)
      .expect(401);
    expect(res.body.success).toBe(false);
  });

  test('200 returns providers for a valid published form', async () => {
    publicFormAdminService.getPublishedDefinitionByTemplateId.mockResolvedValueOnce({ FormTemplateId: VALID_FORM });
    searchProviders.mockResolvedValueOnce({
      providers: [{ source: 'registry', npi: '1234567890', name: 'Jane Smith, MD', zip: '06770' }],
      widened: true
    });
    const res = await request(buildApp())
      .get(`/api/public/npi/search?form=${VALID_FORM}&mode=individual&lastName=Smith&zip=06770`)
      .expect(200);
    expect(res.body).toEqual({
      success: true,
      count: 1,
      widened: true,
      data: [{ source: 'registry', npi: '1234567890', name: 'Jane Smith, MD', zip: '06770' }]
    });
    expect(searchProviders).toHaveBeenCalledWith({
      mode: 'individual', lastName: 'Smith', firstName: '', organizationName: '', zip: '06770'
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npx jest routes/public/__tests__/npi-search.test.js`
Expected: FAIL — `Cannot find module '../npi-search'`.

- [ ] **Step 3: Create the route file**

Create `backend/routes/public/npi-search.js`:

```js
// backend/routes/public/npi-search.js
// Public (anonymous) NPI provider search for public-form provider_search fields.
// Scoped to a published public form; no auth. Rate-limited at mount time in app.js.

const express = require('express');
const publicFormAdminService = require('../../services/publicFormAdminService');
const { searchProviders } = require('../../services/publicNpiSearch.service');

const router = express.Router();
const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/public/npi/search?form=<uuid>&mode=&lastName=&organizationName=&firstName=&zip=
 */
router.get('/search', async (req, res) => {
  try {
    const { form, mode, lastName, firstName, organizationName, zip } = req.query;

    if (!form || !uuidRe.test(String(form))) {
      return res.status(400).json({ success: false, message: 'Invalid form id' });
    }
    const formRow = await publicFormAdminService.getPublishedDefinitionByTemplateId(String(form));
    if (!formRow) {
      return res.status(401).json({ success: false, message: 'Form not found or not published' });
    }

    const { providers, widened } = await searchProviders({
      mode: String(mode || 'individual'),
      lastName: lastName ? String(lastName).trim() : '',
      firstName: firstName ? String(firstName).trim() : '',
      organizationName: organizationName ? String(organizationName).trim() : '',
      zip: String(zip || '')
    });

    return res.json({ success: true, count: providers.length, widened, data: providers });
  } catch (e) {
    const status = e.statusCode || 500;
    if (status >= 500) console.error('public npi search', e);
    return res.status(status).json({ success: false, message: e.message || 'NPI search failed' });
  }
});

module.exports = router;
```

- [ ] **Step 4: Run the route test to verify it passes**

Run: `cd backend && npx jest routes/public/__tests__/npi-search.test.js`
Expected: PASS — 3 tests.

- [ ] **Step 5: Register the route in `app.js`**

In `backend/app.js`, find the `/api/public/forms` block that ends with:

```js
app.use('/api/public/forms', publicFormsLimiter, publicFormsRoutes);
console.log('✅ Mounted /api/public/forms (public sharing forms)');
```

Immediately after that `console.log` line, add:

```js

const publicNpiSearchRoutes = require('./routes/public/npi-search');
const publicNpiSearchLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: Number(process.env.PUBLIC_NPI_RATE_LIMIT_MAX || 30),
    standardHeaders: true,
    legacyHeaders: false
});
app.use('/api/public/npi', publicNpiSearchLimiter, publicNpiSearchRoutes);
console.log('✅ Mounted /api/public/npi (public NPI provider search)');
```

- [ ] **Step 6: Verify the route file loads cleanly**

Run: `cd backend && node -e "require('./routes/public/npi-search'); console.log('npi-search route loads OK')"`
Expected: prints `npi-search route loads OK` with no error.

- [ ] **Step 7: Commit**

```bash
git add backend/routes/public/npi-search.js backend/routes/public/__tests__/npi-search.test.js backend/app.js
git commit -m "feat(forms): add public NPI search route at /api/public/npi/search"
```

---

## Task 3: Frontend — shared provider types + value formatter util

**Files:**
- Create: `frontend/src/types/providerSearch.ts`
- Create: `frontend/src/utils/providerFieldValue.ts`
- Test: `frontend/src/utils/__tests__/providerFieldValue.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/utils/__tests__/providerFieldValue.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { isProviderValue, formatProviderValue } from '../providerFieldValue';

describe('isProviderValue', () => {
  it('accepts a registry provider', () => {
    expect(isProviderValue({ source: 'registry', name: 'Jane Smith', npi: '1234567890' })).toBe(true);
  });
  it('accepts a manual provider', () => {
    expect(isProviderValue({ source: 'manual', name: 'Town Clinic' })).toBe(true);
  });
  it('rejects non-provider values', () => {
    expect(isProviderValue(null)).toBe(false);
    expect(isProviderValue('Jane')).toBe(false);
    expect(isProviderValue({ name: 'x' })).toBe(false);
    expect(isProviderValue({ source: 'registry' })).toBe(false);
  });
});

describe('formatProviderValue', () => {
  it('formats a registry provider with NPI and verified tag', () => {
    const s = formatProviderValue({
      source: 'registry', name: 'Jane Smith, MD', npi: '1234567890',
      address1: '1 Main St', city: 'Naugatuck', state: 'CT', zip: '06770'
    });
    expect(s).toBe('Jane Smith, MD — NPI 1234567890 — 1 Main St Naugatuck, CT 06770 — (registry-verified)');
  });
  it('formats a manual provider as manually entered', () => {
    expect(formatProviderValue({ source: 'manual', name: 'Town Clinic' }))
      .toBe('Town Clinic — (manually entered)');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/utils/__tests__/providerFieldValue.test.ts`
Expected: FAIL — cannot resolve `../providerFieldValue`.

- [ ] **Step 3: Create the types file**

Create `frontend/src/types/providerSearch.ts`:

```ts
// frontend/src/types/providerSearch.ts
// Types for the provider_search form field and the public NPI search endpoint.

export type ProviderSearchMode = 'individual' | 'organization' | 'both';

/** A provider result from the public NPI search endpoint. */
export type NpiProvider = {
  source: 'registry';
  npi: string;
  name: string;
  providerType?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  phone?: string | null;
  specialty?: string | null;
};

/** A provider entered by hand when not found in the registry. */
export type ManualProvider = {
  source: 'manual';
  name: string;
  address1?: string;
  city?: string;
  state?: string;
  zip?: string;
};

/** The value stored in the form submission for a provider_search field. */
export type ProviderFieldValue = NpiProvider | ManualProvider;

/** Response shape of GET /api/public/npi/search. */
export type NpiSearchResponse = {
  success: boolean;
  count: number;
  widened: boolean;
  data: NpiProvider[];
  message?: string;
};
```

- [ ] **Step 4: Create the util file**

Create `frontend/src/utils/providerFieldValue.ts`:

```ts
// frontend/src/utils/providerFieldValue.ts
// Type guard + human-readable formatter for a stored provider_search field value.

import type { ProviderFieldValue } from '../types/providerSearch';

export function isProviderValue(v: unknown): v is ProviderFieldValue {
  if (!v || typeof v !== 'object') return false;
  const o = v as { name?: unknown; source?: unknown };
  return (
    typeof o.name === 'string' &&
    (o.source === 'registry' || o.source === 'manual')
  );
}

export function formatProviderValue(v: ProviderFieldValue): string {
  const segments: string[] = [v.name];
  if (v.source === 'registry' && v.npi) segments.push(`NPI ${v.npi}`);
  const addr = [v.address1, [v.city, v.state].filter(Boolean).join(', '), v.zip]
    .filter(Boolean)
    .join(' ');
  if (addr) segments.push(addr);
  segments.push(v.source === 'registry' ? '(registry-verified)' : '(manually entered)');
  return segments.filter(Boolean).join(' — ');
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/utils/__tests__/providerFieldValue.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/types/providerSearch.ts frontend/src/utils/providerFieldValue.ts frontend/src/utils/__tests__/providerFieldValue.test.ts
git commit -m "feat(forms): add provider-search types and value formatter"
```

---

## Task 4: Frontend — register the `provider_search` field type

**Files:**
- Modify: `frontend/src/types/publicFormDefinition.ts`
- Test: `frontend/src/types/__tests__/publicFormDefinition.providerSearch.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/types/__tests__/publicFormDefinition.providerSearch.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  PALETTE_FIELD_TYPES,
  KNOWN_FIELD_TYPES,
  newFieldFromPalette
} from '../publicFormDefinition';

describe('provider_search field type', () => {
  it('is registered in the palette and known types', () => {
    expect(PALETTE_FIELD_TYPES).toContain('provider_search');
    expect(KNOWN_FIELD_TYPES.has('provider_search')).toBe(true);
  });

  it('newFieldFromPalette creates a provider_search field defaulting to individual mode', () => {
    const f = newFieldFromPalette('provider_search', new Set<string>());
    expect(f.type).toBe('provider_search');
    expect(f.providerSearchMode).toBe('individual');
    expect(f.label).toBe('Find your provider');
    expect(typeof f.name).toBe('string');
    expect(f.name.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/types/__tests__/publicFormDefinition.providerSearch.test.ts`
Expected: FAIL — `PALETTE_FIELD_TYPES` does not contain `provider_search`.

- [ ] **Step 3: Add `provider_search` to `PALETTE_FIELD_TYPES`**

In `frontend/src/types/publicFormDefinition.ts`, change the end of the `PALETTE_FIELD_TYPES` array from:

```ts
  'file',
  'signature'
] as const;
```

to:

```ts
  'file',
  'signature',
  'provider_search'
] as const;
```

- [ ] **Step 4: Add `providerSearchMode` to `FieldDef`**

In the same file, in the `FieldDef` type, after the `softWarnIfMissing?: SoftWarning;` line and before the closing `};`, add:

```ts
  /** Provider-search field mode (`type: 'provider_search'`). */
  providerSearchMode?: 'individual' | 'organization' | 'both';
```

- [ ] **Step 5: Add a `provider_search` case to `newFieldFromPalette`**

In `newFieldFromPalette()`, immediately after the `case 'signature': { ... }` block and before `default: {`, add:

```ts
    case 'provider_search': {
      const name = uniqueFieldName(`provider_${id}`, usedNames);
      return {
        name,
        type: 'provider_search',
        label: 'Find your provider',
        required: false,
        providerSearchMode: 'individual'
      };
    }
```

- [ ] **Step 6: Add a `provider_search` case to `defaultLabelForType`**

In `defaultLabelForType()`, immediately before `default:`, add:

```ts
    case 'provider_search':
      return 'Find your provider';
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/types/__tests__/publicFormDefinition.providerSearch.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/types/publicFormDefinition.ts frontend/src/types/__tests__/publicFormDefinition.providerSearch.test.ts
git commit -m "feat(forms): register provider_search field type"
```

---

## Task 5: Frontend — field palette tile + builder canvas preview

**Files:**
- Modify: `frontend/src/components/tenant-admin/public-form-builder/FieldPalette.tsx`
- Modify: `frontend/src/components/tenant-admin/public-form-builder/FieldCanvas.tsx`
- Test: `frontend/src/components/tenant-admin/public-form-builder/__tests__/FieldPalette.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/tenant-admin/public-form-builder/__tests__/FieldPalette.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FieldPalette } from '../FieldPalette';

describe('FieldPalette', () => {
  it('renders a Provider search tile that fires onAdd', () => {
    const onAdd = vi.fn();
    render(<FieldPalette onAdd={onAdd} />);
    fireEvent.click(screen.getByTitle('Add Provider search'));
    expect(onAdd).toHaveBeenCalledWith('provider_search');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/components/tenant-admin/public-form-builder/__tests__/FieldPalette.test.tsx`
Expected: FAIL — no element with title `Add Provider search` (also a TypeScript error: `FIELD_META` missing the `provider_search` key).

- [ ] **Step 3: Add the `Stethoscope` icon import**

In `FieldPalette.tsx`, add `Stethoscope` to the `lucide-react` import block (keep the list alphabetical — insert between `ScrollText` and `Type`):

```tsx
  ScrollText,
  Stethoscope,
  Type,
```

- [ ] **Step 4: Add the `FIELD_META` entry**

In the `FIELD_META` object, change the last entry from:

```ts
  signature: { label: 'Signature', icon: PenLine }
};
```

to:

```ts
  signature: { label: 'Signature', icon: PenLine },
  provider_search: { label: 'Provider search', icon: Stethoscope }
};
```

- [ ] **Step 5: Add a `Healthcare` group**

In the `GROUPS` array, change:

```ts
  { title: 'Legal & files', types: ['terms', 'file', 'signature'] }
];
```

to:

```ts
  { title: 'Legal & files', types: ['terms', 'file', 'signature'] },
  { title: 'Healthcare', types: ['provider_search'] }
];
```

- [ ] **Step 6: Add the canvas preview block**

In `FieldCanvas.tsx`, inside `FieldPreview()`, immediately after the `file` preview block (the `{field.type === 'file' ? ( ... ) : null}` block) and before the `{field.helperText && ...}` line, add:

```tsx
      {field.type === 'provider_search' ? (
        <div className="border border-dashed border-gray-300 rounded bg-gray-50 p-2 space-y-1">
          <div className="h-7 border border-gray-300 rounded bg-white" />
          <div className="flex gap-1">
            <div className="h-7 flex-1 border border-gray-300 rounded bg-white" />
            <div className="h-7 w-16 rounded bg-oe-primary/70" />
          </div>
          <span className="text-[9px] text-gray-400">
            NPI provider search ({field.providerSearchMode || 'individual'})
          </span>
        </div>
      ) : null}
```

- [ ] **Step 7: Run the test + type-check to verify**

Run: `cd frontend && npx vitest run src/components/tenant-admin/public-form-builder/__tests__/FieldPalette.test.tsx && npx tsc --noEmit`
Expected: test PASS — 1 test; `tsc` exits with no errors.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/components/tenant-admin/public-form-builder/FieldPalette.tsx frontend/src/components/tenant-admin/public-form-builder/FieldCanvas.tsx frontend/src/components/tenant-admin/public-form-builder/__tests__/FieldPalette.test.tsx
git commit -m "feat(forms): add provider search to field palette and canvas preview"
```

---

## Task 6: Frontend — field inspector mode picker

**Files:**
- Modify: `frontend/src/components/tenant-admin/public-form-builder/FieldInspector.tsx`
- Test: `frontend/src/components/tenant-admin/public-form-builder/__tests__/FieldInspector.providerSearch.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/tenant-admin/public-form-builder/__tests__/FieldInspector.providerSearch.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FieldInspector } from '../FieldInspector';
import type { FieldDef } from '../../../../types/publicFormDefinition';

const baseField: FieldDef = {
  name: 'provider_1',
  type: 'provider_search',
  label: 'Find your provider',
  required: false,
  providerSearchMode: 'individual'
};

describe('FieldInspector — provider_search', () => {
  it('renders the mode picker and emits providerSearchMode on change', () => {
    const onChange = vi.fn();
    render(
      <FieldInspector
        field={baseField}
        nameDuplicate={false}
        multiPage={false}
        pages={[]}
        onChange={onChange}
        onRemove={() => {}}
        onClose={() => {}}
      />
    );
    const select = screen.getByLabelText('Provider search mode') as HTMLSelectElement;
    expect(select.value).toBe('individual');
    fireEvent.change(select, { target: { value: 'organization' } });
    expect(onChange).toHaveBeenCalledWith({ providerSearchMode: 'organization' });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/components/tenant-admin/public-form-builder/__tests__/FieldInspector.providerSearch.test.tsx`
Expected: FAIL — no form control labelled `Provider search mode`.

- [ ] **Step 3: Add the mode picker block**

In `FieldInspector.tsx`, immediately after the Required-checkbox block (the `{field.type !== 'static_html' && ( <label ...> ... Required ... </label> )}` block), add:

```tsx
      {field.type === 'provider_search' && (
        <label className="block text-sm">
          <span className="text-gray-600">Provider search mode</span>
          <select
            className="mt-1 w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
            value={field.providerSearchMode || 'individual'}
            onChange={(e) =>
              onChange({
                providerSearchMode: e.target.value as 'individual' | 'organization' | 'both'
              })
            }
          >
            <option value="individual">Individual provider (PCP, doctor)</option>
            <option value="organization">Organization (hospital, facility)</option>
            <option value="both">Both</option>
          </select>
        </label>
      )}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/components/tenant-admin/public-form-builder/__tests__/FieldInspector.providerSearch.test.tsx`
Expected: PASS — 1 test.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/tenant-admin/public-form-builder/FieldInspector.tsx frontend/src/components/tenant-admin/public-form-builder/__tests__/FieldInspector.providerSearch.test.tsx
git commit -m "feat(forms): add provider search mode picker to field inspector"
```

---

## Task 7: Frontend — public NPI search service

**Files:**
- Create: `frontend/src/services/npiPublicSearch.service.ts`
- Test: `frontend/src/services/__tests__/npiPublicSearch.service.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/services/__tests__/npiPublicSearch.service.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api.service', () => ({ apiService: { get: vi.fn() } }));
import { apiService } from '../api.service';
import { searchPublicProviders } from '../npiPublicSearch.service';

const mockedGet = apiService.get as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => vi.clearAllMocks());

describe('searchPublicProviders', () => {
  it('builds the public NPI search URL with all params', async () => {
    mockedGet.mockResolvedValue({ success: true, count: 0, widened: false, data: [] });
    await searchPublicProviders({ formId: 'form-1', mode: 'individual', lastName: 'Smith', zip: '06770' });
    expect(mockedGet).toHaveBeenCalledWith(
      '/api/public/npi/search?form=form-1&mode=individual&lastName=Smith&zip=06770'
    );
  });

  it('omits empty optional params', async () => {
    mockedGet.mockResolvedValue({ success: true, count: 0, widened: false, data: [] });
    await searchPublicProviders({ formId: 'f', mode: 'organization', organizationName: 'Hosp', zip: '06770' });
    const url = mockedGet.mock.calls[0][0] as string;
    expect(url).toContain('organizationName=Hosp');
    expect(url).not.toContain('lastName=');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/services/__tests__/npiPublicSearch.service.test.ts`
Expected: FAIL — cannot resolve `../npiPublicSearch.service`.

- [ ] **Step 3: Create the service file**

Create `frontend/src/services/npiPublicSearch.service.ts`:

```ts
// frontend/src/services/npiPublicSearch.service.ts
// Calls the public (anonymous) NPI provider search endpoint.

import { apiService } from './api.service';
import type { NpiSearchResponse, ProviderSearchMode } from '../types/providerSearch';

export type ProviderSearchParams = {
  formId: string;
  mode: ProviderSearchMode;
  lastName?: string;
  organizationName?: string;
  zip: string;
};

export async function searchPublicProviders(
  params: ProviderSearchParams
): Promise<NpiSearchResponse> {
  const qs = new URLSearchParams();
  qs.set('form', params.formId);
  qs.set('mode', params.mode);
  if (params.lastName) qs.set('lastName', params.lastName);
  if (params.organizationName) qs.set('organizationName', params.organizationName);
  qs.set('zip', params.zip);
  return apiService.get<NpiSearchResponse>(`/api/public/npi/search?${qs.toString()}`);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/services/__tests__/npiPublicSearch.service.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/services/npiPublicSearch.service.ts frontend/src/services/__tests__/npiPublicSearch.service.test.ts
git commit -m "feat(forms): add public NPI search frontend service"
```

---

## Task 8: Frontend — the `<ProviderSearchField>` widget

**Files:**
- Create: `frontend/src/components/public/fields/ProviderSearchField.tsx`
- Test: `frontend/src/components/public/fields/__tests__/ProviderSearchField.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/public/fields/__tests__/ProviderSearchField.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ProviderSearchField from '../ProviderSearchField';
import type { FieldDef } from '../../../../types/publicFormDefinition';

vi.mock('../../../../services/npiPublicSearch.service', () => ({
  searchPublicProviders: vi.fn()
}));
import { searchPublicProviders } from '../../../../services/npiPublicSearch.service';
const mockedSearch = searchPublicProviders as unknown as ReturnType<typeof vi.fn>;

const field: FieldDef = {
  name: 'provider_1',
  type: 'provider_search',
  label: 'Find your provider',
  providerSearchMode: 'individual'
};

beforeEach(() => vi.clearAllMocks());

describe('ProviderSearchField', () => {
  it('searches and selects a registry provider', async () => {
    mockedSearch.mockResolvedValue({
      success: true, count: 1, widened: false,
      data: [{ source: 'registry', npi: '1234567890', name: 'Jane Smith, MD', city: 'Naugatuck', state: 'CT', zip: '06770' }]
    });
    const onChange = vi.fn();
    render(<ProviderSearchField field={field} formId="form-1" value={undefined} onChange={onChange} />);

    fireEvent.change(screen.getByPlaceholderText('Provider last name'), { target: { value: 'Smith' } });
    fireEvent.change(screen.getByPlaceholderText('Your ZIP code'), { target: { value: '06770' } });
    fireEvent.click(screen.getByRole('button', { name: /^search$/i }));

    await waitFor(() => expect(screen.getByText('Jane Smith, MD')).toBeInTheDocument());
    expect(mockedSearch).toHaveBeenCalledWith({
      formId: 'form-1', mode: 'individual', lastName: 'Smith', organizationName: undefined, zip: '06770'
    });

    fireEvent.click(screen.getByText('Jane Smith, MD'));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'registry', npi: '1234567890', name: 'Jane Smith, MD' })
    );
  });

  it('shows the selected provider with a Change button', () => {
    const onChange = vi.fn();
    render(
      <ProviderSearchField
        field={field}
        formId="form-1"
        value={{ source: 'registry', npi: '1234567890', name: 'Jane Smith, MD' }}
        onChange={onChange}
      />
    );
    expect(screen.getByText(/Jane Smith, MD/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Change'));
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it('submits a manually entered provider', () => {
    const onChange = vi.fn();
    render(<ProviderSearchField field={field} formId="form-1" value={undefined} onChange={onChange} />);
    fireEvent.click(screen.getByText(/Enter it manually/i));
    fireEvent.change(screen.getByPlaceholderText('Provider / facility name'), { target: { value: 'Town Clinic' } });
    fireEvent.click(screen.getByText('Use this provider'));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'manual', name: 'Town Clinic' })
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/components/public/fields/__tests__/ProviderSearchField.test.tsx`
Expected: FAIL — cannot resolve `../ProviderSearchField`.

- [ ] **Step 3: Create the widget**

Create `frontend/src/components/public/fields/ProviderSearchField.tsx`:

```tsx
// frontend/src/components/public/fields/ProviderSearchField.tsx
// Public-form widget: search the NPI registry for a provider, or enter one manually.

import { useState } from 'react';
import { Search, Stethoscope } from 'lucide-react';
import type { FieldDef } from '../../../types/publicFormDefinition';
import type { NpiProvider, ProviderFieldValue } from '../../../types/providerSearch';
import { searchPublicProviders } from '../../../services/npiPublicSearch.service';
import { isProviderValue, formatProviderValue } from '../../../utils/providerFieldValue';

type Props = {
  field: FieldDef;
  formId?: string;
  value: unknown;
  onChange: (v: ProviderFieldValue | undefined) => void;
  disabled?: boolean;
};

const US_ZIP = /^\d{5}$/;

export default function ProviderSearchField({ field, formId, value, onChange, disabled }: Props) {
  const mode = field.providerSearchMode || 'individual';
  const nameLabel =
    mode === 'organization'
      ? 'Hospital / facility name'
      : mode === 'both'
        ? 'Provider or facility name'
        : 'Provider last name';

  const [name, setName] = useState('');
  const [zip, setZip] = useState('');
  const [results, setResults] = useState<NpiProvider[]>([]);
  const [searching, setSearching] = useState(false);
  const [widened, setWidened] = useState(false);
  const [error, setError] = useState('');
  const [manualOpen, setManualOpen] = useState(false);
  const [manual, setManual] = useState({ name: '', address1: '', city: '', state: '', zip: '' });

  const selected = isProviderValue(value) ? value : null;
  const canSearch = !!formId && !disabled && name.trim().length > 0 && US_ZIP.test(zip.trim());

  const runSearch = async () => {
    if (!canSearch || !formId) return;
    setSearching(true);
    setError('');
    setResults([]);
    try {
      const res = await searchPublicProviders({
        formId,
        mode,
        lastName: mode !== 'organization' ? name.trim() : undefined,
        organizationName: mode !== 'individual' ? name.trim() : undefined,
        zip: zip.trim()
      });
      setWidened(!!res.widened);
      setResults(res.data || []);
      if (!res.data || res.data.length === 0) {
        setError('No providers found. Try a different spelling, or enter your provider manually below.');
      }
    } catch {
      setError('Provider search is unavailable right now. You can enter your provider manually below.');
    } finally {
      setSearching(false);
    }
  };

  const submitManual = () => {
    if (!manual.name.trim()) return;
    onChange({
      source: 'manual',
      name: manual.name.trim(),
      address1: manual.address1.trim() || undefined,
      city: manual.city.trim() || undefined,
      state: manual.state.trim() || undefined,
      zip: manual.zip.trim() || undefined
    });
  };

  if (selected) {
    return (
      <div className="border border-oe-primary/40 rounded-lg bg-oe-light/40 p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-start gap-2">
            <Stethoscope className="h-4 w-4 text-oe-primary mt-0.5 shrink-0" />
            <div className="text-sm text-slate-800">{formatProviderValue(selected)}</div>
          </div>
          {!disabled && (
            <button
              type="button"
              onClick={() => onChange(undefined)}
              className="text-xs text-oe-primary hover:underline shrink-0"
            >
              Change
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <input
          type="text"
          className="sm:col-span-2 w-full border border-slate-300 rounded px-2 py-2 text-sm"
          placeholder={nameLabel}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              runSearch();
            }
          }}
          disabled={disabled}
        />
        <input
          type="text"
          inputMode="numeric"
          maxLength={5}
          className="w-full border border-slate-300 rounded px-2 py-2 text-sm"
          placeholder="Your ZIP code"
          value={zip}
          onChange={(e) => setZip(e.target.value.replace(/\D/g, ''))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              runSearch();
            }
          }}
          disabled={disabled}
        />
      </div>

      <button
        type="button"
        onClick={runSearch}
        disabled={!canSearch || searching}
        className="w-full px-4 py-2 bg-oe-primary text-white rounded hover:bg-oe-dark disabled:opacity-50 flex items-center justify-center gap-2 text-sm"
      >
        {searching ? (
          <>
            <span className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full" />
            Searching…
          </>
        ) : (
          <>
            <Search className="h-4 w-4" />
            Search
          </>
        )}
      </button>

      {!formId && (
        <p className="text-xs text-slate-400">Provider search is available on the live form.</p>
      )}

      {widened && results.length > 0 && (
        <p className="text-xs text-slate-500">
          No exact matches in {zip} — showing providers in the surrounding area.
        </p>
      )}

      {results.length > 0 && (
        <div className="border border-oe-primary/30 rounded-lg max-h-64 overflow-y-auto bg-white">
          <div className="sticky top-0 bg-oe-light px-3 py-1.5 text-xs text-oe-primary font-medium border-b border-oe-primary/30">
            {results.length} result{results.length !== 1 ? 's' : ''} — tap to select
          </div>
          {results.map((r) => (
            <button
              key={r.npi}
              type="button"
              onClick={() => onChange(r)}
              className="w-full px-3 py-2.5 text-left hover:bg-oe-light border-b border-gray-100 last:border-0"
            >
              <div className="flex justify-between items-start gap-2">
                <span className="font-medium text-gray-900">{r.name}</span>
                <span className="font-mono text-xs text-oe-primary bg-oe-light px-2 py-0.5 rounded shrink-0">
                  {r.npi}
                </span>
              </div>
              <div className="text-xs text-gray-500 mt-0.5">
                {r.providerType && (
                  <span className="inline-block bg-gray-100 text-gray-700 px-1.5 py-0.5 rounded mr-2">
                    {r.providerType}
                  </span>
                )}
                {r.specialty}
              </div>
              {(r.address1 || r.city || r.state) && (
                <div className="text-xs text-gray-400 mt-1">
                  {r.address1 ? `${r.address1}, ` : ''}
                  {r.city ? `${r.city}, ` : ''}
                  {r.state} {r.zip}
                </div>
              )}
            </button>
          ))}
        </div>
      )}

      {error && <p className="text-xs text-amber-700">{error}</p>}

      <div>
        <button
          type="button"
          onClick={() => setManualOpen((o) => !o)}
          className="text-xs text-oe-primary hover:underline"
          disabled={disabled}
        >
          {manualOpen ? 'Hide manual entry' : "Can't find your provider? Enter it manually"}
        </button>
      </div>

      {manualOpen && (
        <div className="border border-slate-200 rounded-lg p-3 space-y-2 bg-slate-50">
          <input
            type="text"
            className="w-full border border-slate-300 rounded px-2 py-2 text-sm"
            placeholder="Provider / facility name"
            value={manual.name}
            onChange={(e) => setManual({ ...manual, name: e.target.value })}
            disabled={disabled}
          />
          <input
            type="text"
            className="w-full border border-slate-300 rounded px-2 py-2 text-sm"
            placeholder="Street address (optional)"
            value={manual.address1}
            onChange={(e) => setManual({ ...manual, address1: e.target.value })}
            disabled={disabled}
          />
          <div className="grid grid-cols-3 gap-2">
            <input
              type="text"
              className="w-full border border-slate-300 rounded px-2 py-2 text-sm"
              placeholder="City"
              value={manual.city}
              onChange={(e) => setManual({ ...manual, city: e.target.value })}
              disabled={disabled}
            />
            <input
              type="text"
              maxLength={2}
              className="w-full border border-slate-300 rounded px-2 py-2 text-sm uppercase"
              placeholder="State"
              value={manual.state}
              onChange={(e) => setManual({ ...manual, state: e.target.value.toUpperCase() })}
              disabled={disabled}
            />
            <input
              type="text"
              inputMode="numeric"
              maxLength={5}
              className="w-full border border-slate-300 rounded px-2 py-2 text-sm"
              placeholder="ZIP"
              value={manual.zip}
              onChange={(e) => setManual({ ...manual, zip: e.target.value.replace(/\D/g, '') })}
              disabled={disabled}
            />
          </div>
          <button
            type="button"
            onClick={submitManual}
            disabled={disabled || !manual.name.trim()}
            className="w-full px-4 py-2 border border-oe-primary text-oe-primary rounded hover:bg-oe-light disabled:opacity-50 text-sm"
          >
            Use this provider
          </button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/components/public/fields/__tests__/ProviderSearchField.test.tsx`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/public/fields/ProviderSearchField.tsx frontend/src/components/public/fields/__tests__/ProviderSearchField.test.tsx
git commit -m "feat(forms): add ProviderSearchField widget"
```

---

## Task 9: Frontend — wire `provider_search` into the public form renderer

**Files:**
- Modify: `frontend/src/components/public/PublicFormView.tsx`

This task is verified by type-checking and the existing test suite; end-to-end behavior is covered by the Cypress spec in Task 12.

- [ ] **Step 1: Import the widget**

In `PublicFormView.tsx`, add to the import block near the other component imports:

```tsx
import ProviderSearchField from './fields/ProviderSearchField';
```

- [ ] **Step 2: Add the `renderField` branch**

In the `renderField` function, immediately after the `signature` ternary block (`{field.type === 'signature' ? ( ... ) : null}`) and before the helper-text footer (`{field.helperText && ...}`), add:

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

- [ ] **Step 3: Add the validation branch**

In the standalone `firstValidationError()` function, immediately after the `radio` block (`if (field.type === 'radio') { ... continue; }`) and before the `// text-like` comment, add:

```tsx
    if (field.type === 'provider_search') {
      if (req) {
        const v = values[field.name];
        const ok =
          !!v &&
          typeof v === 'object' &&
          typeof (v as { name?: unknown }).name === 'string' &&
          (v as { name: string }).name.trim() !== '';
        if (!ok) return `Please find and select a provider for “${field.label}”.`;
      }
      continue;
    }
```

- [ ] **Step 4: Type-check and run the frontend test suite**

Run: `cd frontend && npx tsc --noEmit && npx vitest run`
Expected: `tsc` no errors; all vitest tests PASS (including the new provider-search tests from Tasks 3–8).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/public/PublicFormView.tsx
git commit -m "feat(forms): render and validate provider_search fields in public form"
```

---

## Task 10: Frontend — submission detail page rendering

**Files:**
- Modify: `frontend/src/pages/tenant-admin/TenantSharingSubmissionDetailPage.tsx`

A `provider_search` value is a structured object; without this change it renders as raw `JSON.stringify`. This task is verified by type-checking — the formatter it uses (`formatProviderValue`) is already unit-tested in Task 3.

- [ ] **Step 1: Import the formatter util**

In `TenantSharingSubmissionDetailPage.tsx`, add near the other imports:

```tsx
import { isProviderValue, formatProviderValue } from '../../utils/providerFieldValue';
```

- [ ] **Step 2: Add the branch to `renderPayloadValue`**

Change the `renderPayloadValue` function from:

```tsx
function renderPayloadValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (Array.isArray(v)) return v.map(renderPayloadValue).join(', ');
  if (isSignatureValue(v)) return '[Signature on file]';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
```

to:

```tsx
function renderPayloadValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (Array.isArray(v)) return v.map(renderPayloadValue).join(', ');
  if (isSignatureValue(v)) return '[Signature on file]';
  if (isProviderValue(v)) return formatProviderValue(v);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
```

- [ ] **Step 3: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/tenant-admin/TenantSharingSubmissionDetailPage.tsx
git commit -m "feat(forms): render provider_search values on submission detail page"
```

---

## Task 11: Backend — submission PDF rendering

**Files:**
- Modify: `backend/services/publicFormSubmissionPdfService.js`
- Test: `backend/services/__tests__/publicFormSubmissionPdfService.providerValue.test.js`

The PDF service's generic field branch calls `formatPayloadValue`, which `JSON.stringify`s unknown objects. This task makes it format a provider object readably.

- [ ] **Step 1: Write the failing test**

Create `backend/services/__tests__/publicFormSubmissionPdfService.providerValue.test.js`:

```js
const { formatProviderValue } = require('../publicFormSubmissionPdfService');

describe('publicFormSubmissionPdfService formatProviderValue', () => {
  test('formats a registry provider', () => {
    expect(
      formatProviderValue({
        source: 'registry',
        name: 'Jane Smith, MD',
        npi: '1234567890',
        address1: '1 Main St',
        city: 'Naugatuck',
        state: 'CT',
        zip: '06770'
      })
    ).toBe('Jane Smith, MD — NPI 1234567890 — 1 Main St Naugatuck, CT 06770 — (registry-verified)');
  });

  test('formats a manual provider', () => {
    expect(formatProviderValue({ source: 'manual', name: 'Town Clinic' }))
      .toBe('Town Clinic — (manually entered)');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npx jest services/__tests__/publicFormSubmissionPdfService.providerValue.test.js`
Expected: FAIL — `formatProviderValue` is not exported (`TypeError: formatProviderValue is not a function`).

- [ ] **Step 3: Add the `formatProviderValue` function**

In `backend/services/publicFormSubmissionPdfService.js`, immediately before the `formatPayloadValue` function definition, add:

```js
/**
 * Render a provider_search field value (registry or manual) as one line.
 * @param {{ source?: string, name?: string, npi?: string, address1?: string, city?: string, state?: string, zip?: string }} v
 */
function formatProviderValue(v) {
  const segments = [String(v.name || '').trim()];
  if (v.source === 'registry' && v.npi) segments.push(`NPI ${v.npi}`);
  const addr = [v.address1, [v.city, v.state].filter(Boolean).join(', '), v.zip]
    .filter(Boolean)
    .join(' ');
  if (addr) segments.push(addr);
  segments.push(v.source === 'registry' ? '(registry-verified)' : '(manually entered)');
  return segments.filter(Boolean).join(' — ');
}
```

- [ ] **Step 4: Use it inside `formatPayloadValue`**

Change the object branch of `formatPayloadValue` from:

```js
    if (typeof v === 'object') {
        if (typeof v.imageDataUrl === 'string') return '[Signature on file]';
        return JSON.stringify(v);
    }
```

to:

```js
    if (typeof v === 'object') {
        if (typeof v.imageDataUrl === 'string') return '[Signature on file]';
        if (typeof v.name === 'string' && (v.source === 'registry' || v.source === 'manual')) {
            return formatProviderValue(v);
        }
        return JSON.stringify(v);
    }
```

- [ ] **Step 5: Export `formatProviderValue`**

Change the `module.exports` line from:

```js
module.exports = { buildSubmissionPdfBuffer, includeFieldInPdf, stripHtml, htmlToPlainTextForPdf };
```

to:

```js
module.exports = { buildSubmissionPdfBuffer, includeFieldInPdf, stripHtml, htmlToPlainTextForPdf, formatProviderValue };
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd backend && npx jest services/__tests__/publicFormSubmissionPdfService.providerValue.test.js`
Expected: PASS — 2 tests.

- [ ] **Step 7: Commit**

```bash
git add backend/services/publicFormSubmissionPdfService.js backend/services/__tests__/publicFormSubmissionPdfService.providerValue.test.js
git commit -m "feat(forms): format provider_search values in submission PDF"
```

---

## Task 12: Frontend — Cypress end-to-end spec

**Files:**
- Create: `frontend/cypress/e2e/forms/provider-search-field.cy.ts`

Stub-driven — no live NPPES, no real submission send (all network intercepted with `cy.intercept`).

- [ ] **Step 1: Write the spec**

Create `frontend/cypress/e2e/forms/provider-search-field.cy.ts`:

```ts
describe('Provider search form field', () => {
  const formId = '11111111-1111-4111-8111-111111111111';

  const definition = {
    version: 1,
    title: 'Provider Test Form',
    fields: [
      {
        name: 'provider_1',
        type: 'provider_search',
        label: 'Find your provider',
        required: true,
        providerSearchMode: 'individual'
      }
    ]
  };

  beforeEach(() => {
    cy.intercept('GET', `/api/public/forms/${formId}`, {
      statusCode: 200,
      body: { success: true, data: { title: 'Provider Test Form', definition } }
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
            city: 'Naugatuck',
            state: 'CT',
            zip: '06770'
          }
        ]
      }
    }).as('npiSearch');

    cy.intercept('POST', `/api/public/forms/${formId}/submit`, {
      statusCode: 201,
      body: { success: true, message: 'received', data: {} }
    }).as('submit');
  });

  it('searches, selects a provider, and submits', () => {
    cy.visit(`/forms/${formId}`);
    cy.wait('@loadForm');

    cy.get('input[placeholder="Provider last name"]').type('Smith');
    cy.get('input[placeholder="Your ZIP code"]').type('06770');
    cy.contains('button', 'Search').click();
    cy.wait('@npiSearch');

    cy.contains('Jane Smith, MD').click();
    cy.contains('(registry-verified)').should('be.visible');

    cy.contains('button', /submit/i).click();
    cy.wait('@submit');
  });

  it('blocks submit when a required provider field is empty', () => {
    cy.visit(`/forms/${formId}`);
    cy.wait('@loadForm');

    cy.contains('button', /submit/i).click();
    cy.contains('select a provider').should('be.visible');
  });
});
```

- [ ] **Step 2: Run the spec**

Run: `cd frontend && npx cypress run --spec "cypress/e2e/forms/provider-search-field.cy.ts"`
Expected: 2 tests PASS. (Requires the frontend dev server running, per the project's Cypress setup.)

- [ ] **Step 3: Commit**

```bash
git add frontend/cypress/e2e/forms/provider-search-field.cy.ts
git commit -m "test(forms): e2e spec for provider_search field"
```

---

## Self-Review

- **Spec coverage:** §4.1 backend endpoint → Tasks 1–2. §4.2 field type (5 files) → Tasks 4 (`publicFormDefinition.ts`), 5 (`FieldPalette.tsx`, `FieldCanvas.tsx`), 6 (`FieldInspector.tsx`). §4.3 widget → Tasks 3, 7, 8, wired in 9. §4.4 submission detail + PDF → Tasks 10, 11. §4.5 tests → woven into every task + Cypress in 12. No DB migration — none in plan. ✓
- **Type consistency:** `ProviderFieldValue` / `NpiProvider` / `NpiSearchResponse` / `ProviderSearchMode` defined once in `types/providerSearch.ts` (Task 3) and consumed unchanged by Tasks 7, 8, 10. Backend stored-object shape (`source`, `npi`, `name`, `address1`, `city`, `state`, `zip`) matches the frontend `ProviderFieldValue` and both formatters (`utils/providerFieldValue.ts` and `publicFormSubmissionPdfService.formatProviderValue`). Endpoint path `/api/public/npi/search` consistent across service (Task 1), route (Task 2), frontend service (Task 7), Cypress (Task 12). ✓
- **Placeholders:** none — every step has concrete code or an exact command.

## Notes for the implementer

- Backend tests auto-discover under `__tests__/` dirs; the new `backend/routes/public/__tests__/` dir needs no Jest config change.
- The `npiService` is mocked via `jest.spyOn(NPIService, 'search')` (static method) — `formatProviderData` runs for real against the raw fixtures.
- Tasks 9 and 10 modify hard-to-unit-test files; they are verified by `tsc` + the suite, with Task 12's Cypress spec covering the integration. Run `npx tsc --noEmit` after Task 9 before moving on.

