# NPI Provider-Search Form Field — Design

- **Date:** 2026-05-21
- **Status:** Approved design, pending spec review
- **Branch:** `feat/back-office/form-NPI`
- **Author:** brainstormed with Amar

## 1. Summary

Add a new **`provider_search`** field type to the public-form builder. When a member
fills out a form, this field lets them find a healthcare provider — a primary care
provider (individual) or a hospital/facility (organization) — by searching the
national NPI registry, and pick the match instead of hand-typing NPI, name, and
address. If their provider isn't in the registry, they can still enter it manually.

The immediate consumer is forms like **"Claude's Form (Copy)"** (`docs/forms/claudes-form-copy.definition.json`),
whose surgery / ER / maternity paths currently collect provider info as free-text
NPI / surgeon-name / facility fields.

### Goal

Require as little input from the member as possible — ideally just **last name + ZIP**
(individuals) or **hospital name + ZIP** (organizations) — and auto-fill the rest from
the registry.

## 2. Background

### Existing NPI lookup (reused, not rebuilt)

- `backend/services/npiService.js` already integrates the free **NPPES NPI Registry
  API v2.1** (`https://npiregistry.cms.hhs.gov/api`). Methods: `search(params)`,
  `searchProviders(params)`, `lookupByNPI(npi)`, `formatProviderData(raw)`.
- `npiService.search()` accepts `number`, `enumeration_type` (`NPI-1` individual /
  `NPI-2` organization), `first_name`, `last_name`, `organization_name`, `city`,
  `state`, `postal_code`, `taxonomy_description`, `limit`, `skip`.
- `formatProviderData()` returns a normalized object: `npi`, `providerName`,
  `isOrganization`, `providerType`, `phone`, `address1/2`, `city`, `state`,
  `zipCode`, `specialty`, `taxonomyCode`, `firstName`, `lastName`,
  `organizationName`, `status`, etc.
- The existing routes (`backend/routes/me/vendor/npi.js`) are locked to
  `VendorAdmin`/`VendorAgent` auth — **not usable from a public form.**
- Reference UI for the results-list pattern: `frontend/src/pages/vendor/ProviderList.tsx`.

### NPPES capabilities — verified live (2026-05-21)

| Capability | Supported? |
|---|---|
| Last name + 5-digit ZIP | ✅ |
| Organization name, trailing `*` wildcard | ✅ (`hospital*` matches) |
| ZIP-prefix region search | ✅ (`postal_code=067*` matches the area) |
| Individual vs organization (`enumeration_type`) | ✅ |
| True mile-radius search | ❌ — not available |
| EIN / Tax ID in results | ❌ — NPPES does not return it |

### Form system (where this plugs in)

- Form definitions are JSON (`FormDefinition`) stored in
  `oe.PublicFormTemplateVersions.DefinitionJson`. Fields are `FieldDef` objects.
- Field-type enum: `PALETTE_FIELD_TYPES` in `frontend/src/types/publicFormDefinition.ts`.
- A new field type is purely additive — it touches ~5 frontend files and needs **no
  DB migration** (it's just another `type` string in `DefinitionJson`, and its value
  rides in the existing encrypted `oe.PublicFormSubmissions` payload).
- Conditional branching (the "5 paths" in Claude's Form) works via `preScreening` +
  `pageId`; a `provider_search` field participates like any other field — no special
  handling needed.

## 3. Decisions locked

1. **ZIP matching:** member enters their *own* (home) ZIP; we search the surrounding
   area and sort results by ZIP closeness. (NPPES has no mile-radius.)
2. **Not found:** manual-entry fallback — the form never dead-ends.
3. **Field type:** one configurable `provider_search` field; the form builder admin
   sets a **mode** per instance: Individual / Organization / Both.
4. **Architecture:** a new **public backend endpoint** proxies NPPES via the existing
   `npiService` (chosen over browser-direct NPPES calls or relaxing the vendor
   routes) — reuses existing code, allows rate-limiting + token scoping.

## 4. Detailed design

### 4.1 Backend — public NPI search endpoint

**New file:** `backend/routes/public/npi-search.js`, mounted (in `backend/app.js`)
at `/api/public/npi/search`, alongside `backend/routes/public/public-forms.js`.

**Auth:** unauthenticated, **but** requires the public form's identifier — the
same value the public form page is already loaded with (the `formId` route param
on `PublicFormPage`). The endpoint validates it resolves to a *published* form via
the public-form lookup that `routes/public/public-forms.js` already uses; an
unknown/unpublished form → `401`. This scopes the endpoint to people actually
filling a live form rather than leaving an open NPPES proxy.

**Rate limit:** a light per-IP limit (e.g. 30 requests / minute, in-memory) to cap
abuse. NPPES data is public, so the only real risk is traffic volume.

**Request:**

```
GET /api/public/npi/search
  ?form=<publicFormId>
  &mode=individual|organization|both
  &lastName=<str>         # individual / both
  &firstName=<str>        # optional, individual / both
  &organizationName=<str> # organization / both
  &zip=<5-digit ZIP>
```

**Response:**

```json
{
  "success": true,
  "count": 12,
  "widened": true,
  "data": [ /* normalized provider objects (subset of formatProviderData) */ ]
}
```

`widened: true` signals the UI that no/few exact-ZIP matches were found and results
were broadened to the surrounding area (so the UI can show a hint).

**Search algorithm (mode-aware), reusing `npiService`:**

1. Build base params from `mode`:
   - `individual` → `enumeration_type: NPI-1`, `last_name` (+ optional `first_name`).
   - `organization` → `enumeration_type: NPI-2`, `organization_name`.
   - `both` → run the individual and organization queries and merge.
2. **Exact pass:** query with `postal_code` = the full 5-digit ZIP.
3. **Widen pass:** if the exact pass returns fewer than a small threshold
   (e.g. 5) or zero, re-query with `postal_code` = first 3 digits + `*`
   (the regional area). Set `widened: true`.
4. Merge + de-duplicate results by `npi`.
5. **Sort by ZIP closeness:** ascending by `abs(providerZip5 − enteredZip5)`.
   Exact-ZIP matches sort first (distance 0). This is a numeric-proximity
   heuristic — adequate for "show nearby first", not a true geodistance.
6. Cap at 20 results. Return via `formatProviderData`'s existing shape.

No new NPPES integration code — only new orchestration on top of `npiService`.

### 4.2 Form builder — the `provider_search` field type

Add the field type across these files (the audit confirmed this is the full set):

| File | Change |
|---|---|
| `frontend/src/types/publicFormDefinition.ts` | Add `'provider_search'` to `PALETTE_FIELD_TYPES`; add optional `providerSearchMode?: 'individual' \| 'organization' \| 'both'` to `FieldDef`; add a default in `newFieldFromPalette()`; add a label in `defaultLabelForType()`. (`KNOWN_FIELD_TYPES` picks it up automatically.) |
| `frontend/src/components/tenant-admin/public-form-builder/FieldPalette.tsx` | Add a `FIELD_META` entry (Lucide `Stethoscope` icon) and place it in a `GROUPS` category (a new "Healthcare" group, or "Basic"). |
| `frontend/src/components/tenant-admin/public-form-builder/FieldInspector.tsx` | Add a mode picker (Individual / Organization / Both) plus the standard props (label, required, helperText, width, includeInPdf). |
| `frontend/src/components/tenant-admin/public-form-builder/FieldCanvas.tsx` | Add a static builder-preview block in `FieldPreview()`. |
| `frontend/src/components/public/PublicFormView.tsx` | Add a `renderField()` branch for `provider_search` → renders `<ProviderSearchField>`. |

Field default: `providerSearchMode` defaults to `'individual'`; default label
"Find your provider".

### 4.3 Runtime widget — `<ProviderSearchField>`

**New file:** `frontend/src/components/public/fields/ProviderSearchField.tsx`
(plus a thin service fn for the endpoint call, e.g. in
`frontend/src/services/publicForm.service.ts` or a new `npiPublic.service.ts`).
The public form's `formId` (already held by `PublicFormPage` via `useParams`) is
passed down to `<ProviderSearchField>` as a prop and forwarded to the search
endpoint for scoping.

**UX states:**

1. **Search** — two inputs only:
   - Mode `individual`: **Last name** (+ optional first name) + **ZIP**.
   - Mode `organization`: **Hospital / facility name** + **ZIP**.
   - Mode `both`: a single **Provider or facility name** input + **ZIP** (the
     typed value is sent as both `lastName` and `organizationName`).
   - A Search button; Enter also triggers search.
2. **Results** — a scrollable list (pattern from `ProviderList.tsx`): each row shows
   provider name, NPI, type, and city / state / ZIP. Clicking a row selects it.
   If `widened`, show a subtle hint ("No exact matches in 06770 — showing nearby
   providers").
3. **Selected** — a confirmed card showing the chosen provider, with a "Change"
   link to search again.
4. **Manual fallback** — a "Can't find your provider? Enter it manually" link that
   reveals plain name / address inputs. Submitting these stores the provider with
   `source: 'manual'`.

**UI rules:** Tailwind only, Lucide icons only, brand colors (`bg-oe-primary
hover:bg-oe-dark`, etc.) — per `CLAUDE.md`. No Material-UI, no inline styles.

**Stored value** — written to the submission payload under `values[field.name]`:

```json
{
  "source": "registry",          // "registry" | "manual"
  "npi": "1234567890",           // omitted for manual
  "name": "Jane Smith, MD",
  "providerType": "Physician",
  "address1": "123 Main St",
  "city": "Naugatuck",
  "state": "CT",
  "zip": "06770",
  "phone": "(555) 123-4567",
  "specialty": "Internal Medicine"
}
```

**Validation:** when the field is `required`, the submission is valid only if the
value object exists and has a non-empty `name`. `PublicFormView`'s required-field
check must treat a `provider_search` value as an object (not a truthy string).

### 4.4 Submission display & PDF

A `provider_search` value is an object, but the submission viewers render values as
strings — both need a `provider_search` branch:

- **`frontend/src/pages/tenant-admin/TenantSharingSubmissionDetailPage.tsx`** —
  format the object into a readable block (name, NPI, address, and a
  "registry-verified" vs "manually entered" badge).
- **`backend/services/publicFormSubmissionPdfService.js`** — the submission-PDF
  generator must format the object into a one-line string, e.g. *"Jane Smith, MD
  — NPI 1234567890 — 123 Main St, Naugatuck CT 06770 (registry-verified)"*,
  honoring `FieldDef.includeInPdf`.

### 4.5 Testing

- **Backend Jest:** the new route — token validation, mode handling, exact→widen
  fallback, ZIP-closeness sort, rate limiting — with NPPES (`npiService`/axios)
  mocked. No live NPPES calls.
- **Vitest:** `<ProviderSearchField>` — search, render results, select, change,
  and manual fallback — with the search fetch mocked.
- **Cypress:** one stub-driven spec — a form containing a `provider_search` field:
  search → pick a provider → submit. All network stubbed via `cy.intercept` (no
  live NPPES, no real submission send).

## 5. Out of scope / non-goals

- No true geographic mile-radius search (NPPES can't; numeric ZIP proximity is the
  approximation).
- No EIN / Tax ID capture from the registry (NPPES doesn't return it). A Tax ID
  field, where a form needs one, remains a separate manual field.
- No change to the existing `VendorAdmin` NPI routes or the vendor Providers page.
- No migration of "Claude's Form (Copy)" itself in this work — that form can adopt
  the new field type afterward as a separate content edit.
- No DB schema changes.

## 6. Files touched (summary)

**New:**
- `backend/routes/public/npi-search.js`
- `frontend/src/components/public/fields/ProviderSearchField.tsx`
- frontend service fn for the public NPI search call
- test files (Jest / Vitest / Cypress per §4.5)

**Modified:**
- `backend/app.js` (route registration)
- `frontend/src/types/publicFormDefinition.ts`
- `frontend/src/components/tenant-admin/public-form-builder/FieldPalette.tsx`
- `frontend/src/components/tenant-admin/public-form-builder/FieldInspector.tsx`
- `frontend/src/components/tenant-admin/public-form-builder/FieldCanvas.tsx`
- `frontend/src/components/public/PublicFormView.tsx`
- `frontend/src/pages/tenant-admin/TenantSharingSubmissionDetailPage.tsx`
- `backend/services/publicFormSubmissionPdfService.js`

**Reused as-is:** `backend/services/npiService.js`, the public-form lookup used by
`backend/routes/public/public-forms.js`.
