# Smart Hospital Suggestion — Design

- **Date:** 2026-05-22
- **Status:** Approved design, pending spec review
- **Branch:** `feat/back-office/form-NPI` (extends the NPI provider-search feature)
- **Author:** brainstormed with Amar

## 1. Summary

Enhance the `provider_search` form field so that, once a member has picked a
**doctor**, an organization-mode provider field on the same form proactively
suggests the **facility registered at that doctor's exact practice address** —
a tap-to-pick suggestion shown before the member types anything. If no facility
is co-located, nothing is shown (no fallback guessing).

This builds on the shipped NPI provider-search feature (spec
`2026-05-21-npi-provider-search-form-field-design.md`).

## 2. Background

### What NPPES provides — verified live (2026-05-22)

- NPPES has **no doctor→hospital affiliation field.** A doctor record cannot
  tell us "Dr. X works at Y Hospital."
- An individual (NPI-1) record has a **LOCATION** address (the practice/office —
  reliable) and a **MAILING** address (often a billing address in another
  city/state — unreliable). The optional `practiceLocations` array is almost
  always empty.
- NPI-2 (organization) records **can be searched by `postal_code` alone** (no
  name needed) and every result includes its LOCATION `address_1`.
- Probe evidence: in ZIP 06457, individual doctors cluster at shared building
  street lines ("90 S MAIN ST" ×4, "1250 SILVER ST" ×4); organizations are
  registered at street addresses too. So matching a doctor's practice street
  line against organizations in that ZIP genuinely identifies the facility the
  doctor practices at.
- Street formatting varies ("1250 SILVER ST" vs "1000 SILVER STREET") — matching
  requires normalization.

### Why address-match, not ZIP-area

A ZIP-area "nearby hospitals" guess is imprecise and noisy (a name-less ZIP
search returns dental offices, nursing homes, labs). Matching the doctor's
**exact practice street address** is precise: the organization at that address
*is* where the doctor practices. When there is no co-located organization, the
feature shows nothing rather than guessing.

## 3. Decisions locked

1. **Pairing — auto-detect.** The organization field uses the doctor selected in
   the form's individual-mode `provider_search` field; no form-builder config.
2. **Suggestion source — the doctor's practice (LOCATION) street address.** Not
   ZIP-area, not the mailing address.
3. **No taxonomy filter.** Whatever organization(s) sit at the doctor's address
   are shown — that *is* the precise answer.
4. **Show-or-nothing.** Zero address matches → no suggestion, no fallback.

## 4. Detailed design

### 4.1 Behavior & data flow

1. A selected **registry** doctor already carries `address1` + `zip` in the
   stored form value (the NPI provider-search feature captures the LOCATION
   address on selection).
2. `PublicFormView` computes the form's current "linked doctor" — among
   `provider_search` fields with `providerSearchMode === 'individual'` that
   currently hold a selected registry value, the last one in field order — and
   passes it to every organization-mode `<ProviderSearchField>` as a
   `linkedProvider` prop. (Field order, not fill time; for the canonical
   one-doctor form the distinction is moot.)
3. When an organization-mode field has **no value yet** and has a
   `linkedProvider` that is a registry provider with a non-empty `address1` and
   a 5-digit `zip`, the widget calls
   `GET /api/public/npi/co-located?form=<id>&address1=<doctor street>&zip=<doctor zip>`.
4. The backend searches NPPES for NPI-2 organizations in that ZIP and keeps only
   those whose LOCATION `address_1` matches the doctor's (normalized — §4.3).
5. **1+ matches** → the widget renders a labelled suggestion block ("Facilities
   at your provider's office") listing the co-located organization(s), each
   tap-to-select (calls the field's `onChange`). **0 matches** → no suggestion
   block; the member uses the normal name+ZIP search.

The suggestion block is shown whenever matches exist and the field is empty —
the member does not have to focus or type. The normal search inputs remain
available beneath it.

### 4.2 Non-applicable cases (no suggestion shown)

- No doctor selected on the form.
- The selected doctor is a **manual-entry** provider (`source: 'manual'`) — no
  reliable registry address.
- The doctor's stored value lacks `address1` or a 5-digit `zip`.
- The organization field already has a selected value.
- The co-located lookup errors or returns nothing — fail silently (this is an
  enhancement, never a blocker).
- `both`-mode fields do not receive suggestions in v1 (the canonical forms use
  explicit `organization` mode for facility fields).

### 4.3 Backend

**`backend/services/publicNpiSearch.service.js`** — two additions:

- **`normalizeStreet(s)`** — a pure helper. Uppercases, trims, collapses internal
  whitespace, strips punctuation (`.` `,`), canonicalizes common street-type
  words to their abbreviation (`STREET→ST`, `DRIVE→DR`, `AVENUE→AVE`, `ROAD→RD`,
  `BOULEVARD→BLVD`, `LANE→LN`, `COURT→CT`, `PLACE→PL`, `HIGHWAY→HWY`,
  `PARKWAY→PKWY`, `SUITE→STE`), and truncates the line at the first unit/suite
  token (`STE`, `UNIT`, `#`, `FL`, `FLOOR`, `APT`, `BLDG`, `BUILDING`, `RM`) so
  "1 PRESTIGE DR STE 200" normalizes equal to "1 PRESTIGE DR". Returns the
  normalized core street line (`''` for empty/invalid input).

- **`findCoLocatedOrganizations({ address1, zip })`** — returns
  `Promise<{ providers: object[] }>`:
  - Normalize `zip` to 5 digits; if not 5 digits, or `address1` is empty, return
    `{ providers: [] }` (no throw — silent).
  - Query NPPES via `NPIService.search({ enumeration_type: 'NPI-2', postal_code:
    zip5, limit: 200 })`.
  - Map each result through `NPIService.formatProviderData` → `toPublicProvider`
    (the existing trimmed `{ source:'registry', npi, name, address1, ... }`).
  - Keep only providers where `normalizeStreet(provider.address1) ===
    normalizeStreet(address1)` and the normalized value is non-empty.
  - De-duplicate by `npi`. Return them (typically 0–3).

**`backend/routes/public/npi-search.js`** — add a second route `GET /co-located`
(final path `/api/public/npi/co-located`):
- Query params: `form` (UUID — validated, published-form check via
  `publicFormAdminService.getPublishedDefinitionByTemplateId`, unknown → `401`),
  `address1`, `zip`.
- Calls `findCoLocatedOrganizations({ address1, zip })`.
- Responds `200 { success: true, count, data }`.
- Errors → `e.statusCode || 500`, 5xx logged. Reuses the existing
  `/api/public/npi` rate limiter — no `app.js` change.

### 4.4 Frontend

**`frontend/src/components/public/PublicFormView.tsx`**
- Compute `linkedDoctor`: scan `def.fields` for `type === 'provider_search'`
  fields with `providerSearchMode === 'individual'`; of those whose
  `values[field.name]` is a registry `ProviderFieldValue`, take the
  last-in-field-order. (Reactive — recomputed on every render, so it updates
  when the doctor is picked.)
- In the `provider_search` branch of `renderField`, pass
  `linkedProvider={linkedDoctor}` to `<ProviderSearchField>`.

**`frontend/src/components/public/fields/ProviderSearchField.tsx`**
- New optional prop `linkedProvider?: ProviderFieldValue`.
- New state: `coLocated: NpiProvider[]`.
- Effect: when `field.providerSearchMode === 'organization'`, no `selected`
  value, `formId` present, and `linkedProvider` is a registry provider with
  `address1` + a 5-digit `zip` — call `findCoLocatedProviders(...)` and store the
  result. Keyed on the linked doctor's `npi` so it refetches if the doctor
  changes. Errors → empty (silent).
- Render: when `coLocated.length > 0` and no `selected` value, show a suggestion
  block above the search inputs — a labelled list ("Facilities at your
  provider's office") of rows reusing the existing result-row markup; tapping a
  row calls `onChange(org)`.

**`frontend/src/services/npiPublicSearch.service.ts`**
- Add `findCoLocatedProviders({ formId, address1, zip }): Promise<NpiSearchResponse>`
  → `GET /api/public/npi/co-located?form=&address1=&zip=` via `apiService`.

**No form-builder changes** — auto-detect pairing needs no configuration.

### 4.5 Testing

- **Backend Jest:** `normalizeStreet` units (abbreviations both spellings, suite
  stripping, punctuation, case, empty input); `findCoLocatedOrganizations` (NPPES
  mocked — returns orgs at varying addresses, asserts only address-matched orgs
  are kept, bad ZIP → empty); `GET /co-located` route test (form validation,
  401, happy path) — NPPES + DB mocked.
- **Vitest:** `ProviderSearchField` — given a `linkedProvider`, fetches and
  renders the suggestion block, tapping a suggestion selects it; no
  `linkedProvider` / manual doctor → no suggestion. `findCoLocatedProviders`
  service URL test.
- **Cypress:** a stub-driven spec — a form with a doctor field + a hospital
  field; select a doctor, the co-located hospital suggestion appears, pick it,
  submit. All network intercepted.

## 5. Out of scope / non-goals

- No ZIP-area "nearby hospitals" fallback.
- No use of the doctor's mailing address or `practiceLocations`.
- No taxonomy/"is it a hospital" filtering of co-located results.
- No form-builder UI changes; no new field type; no DB migration.
- `both`-mode fields neither source nor receive suggestions in v1.
- No fuzzy address matching beyond the normalization in §4.3 (no typo
  tolerance).

## 6. Files touched (summary)

**Modified:**
- `backend/services/publicNpiSearch.service.js` — `normalizeStreet`,
  `findCoLocatedOrganizations`
- `backend/routes/public/npi-search.js` — `GET /co-located`
- `frontend/src/components/public/PublicFormView.tsx` — compute + pass
  `linkedProvider`
- `frontend/src/components/public/fields/ProviderSearchField.tsx` — suggestion
  block
- `frontend/src/services/npiPublicSearch.service.ts` — `findCoLocatedProviders`
- test files per §4.5

**Reused as-is:** `NPIService` (`npiService.js`), `toPublicProvider` /
`zipDistance` patterns, the public-form token lookup, the `/api/public/npi`
rate limiter, the `NpiProvider` / `ProviderFieldValue` types.
