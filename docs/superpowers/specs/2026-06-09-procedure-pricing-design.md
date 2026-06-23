# Procedure Pricing — spec + implementation plan (combined)

Date: 2026-06-09 · Branch: `feat/backoffice/cpt-pricing` · Status: approved, fast-iteration

## Goal

Surface CPT/hospital pricing from the internal pricing API
(`pricing.mightywellhealth.com`, DO droplet `mighty-parser`) inside the back
office:

1. A per-share-request **Procedure Pricing section** at the top of the
   Finances tab — CPT codes per SR, Medicare breakdown, and a **target
   negotiation range = 150%–200% of the Medicare all-in rate**.
2. A standalone **Procedure Pricing** left-nav page (`/vendor/procedure-pricing`)
   — lookup by procedure name or code + ZIP, no SR required.

Out of scope (future): auto-extracting CPT codes from uploaded documents.
Schema/UI are parser-ready (codes are rows; a parser inserts rows later).

## Existing infrastructure (verified)

- `oe.ShareRequestProcedures` (ProcedureId, ShareRequestId, CPTCode,
  Description, SortOrder, CreatedDate, CreatedBy) exists on **testing and
  prod** (its CREATE predates sql-changes tracking). Full CRUD already
  exposed: `GET/POST/PUT/DELETE /api/me/vendor/share-requests/:id/procedures`
  (`backend/routes/me/vendor/share-requests.js:869-1000`,
  `backend/services/shareRequestService.js:1383-1497`). Only UI today is on
  the New-SR form.
- `oe.ShareRequests.ProcedureName` — free-text name, stays as-is.
- Pricing API endpoints (behind nginx basic auth, app on droplet :5000):
  - `GET /api/cpt/price/<code>?zip=&site=&anes_min=` — Medicare allowed
    amounts: `sections[]` (professional / facility ASC+HOPD / anesthesia /
    inpatient DRG) with formula steps + provenance, `totals[]` per-site
    all-in.
  - `GET /api/procedure/<code>?zip=&radius=&limit=` — hospital cash/gross/
    negotiated prices (MRF data), `top_payers` per hospital.
  - `GET /api/search?q=&zip=` — procedure-text → price matches.
  - `GET /api/cpt/procedures?q=` — name → code/short_name catalog.

## Architecture

Backend proxy. Frontend never talks to the pricing API; creds live in backend
env only.

- Auth: dedicated basic-auth user `allaboard-backend` minted in the droplet's
  `/etc/nginx/.mighty-htpasswd`. Backend env:
  `PRICING_API_URL` (default `https://pricing.mightywellhealth.com`),
  `PRICING_API_USER`, `PRICING_API_PASS`. Must also be added to Azure App
  Service config on deploy.
- Target range math (server-side): `targetMin = 1.5 × total`,
  `targetMax = 2.0 × total`, computed per eligible site; headline numbers use
  the cheapest site.

## Files

### Database

- `sql-changes/2026-06-09-share-request-procedure-pricing.sql` — ALTER
  `oe.ShareRequestProcedures` add nullable:
  - `PricingSnapshot NVARCHAR(MAX)` — full JSON (sections, per-site totals,
    target ranges) as fetched; UI re-renders without refetch
  - `MedicareTotal DECIMAL(12,2)`, `TargetMin DECIMAL(12,2)`,
    `TargetMax DECIMAL(12,2)` — cheapest-site headline numbers
  - `SnapshotZip CHAR(5)`, `SnapshotDate DATETIME2`
  - Header notes the base table's CREATE is untracked; prod gets ALTERs only.
  - **Run on testing now; log atop the PR for prod application on merge.**

### Backend

- `backend/services/cptPricingService.js` — axios client (basic auth from
  env), ~60s in-memory cache keyed by URL+params, methods: `searchProcedures`,
  `getCptPrice`, `getHospitalPrices`, `buildSnapshot(code, zip)` (fetch +
  compute target ranges per site + headline cheapest-site numbers).
- `backend/routes/me/vendor/pricing.js` (VendorAdmin/VendorAgent):
  - `GET /search?q=&zip=` → merged `/api/cpt/procedures` + `/api/search`
  - `GET /cpt/:code?zip=&site=` → Medicare breakdown + computed targets
  - `GET /hospital-prices/:code?zip=&radius=` → MRF asking prices
- `backend/routes/me/vendor/share-requests.js` — add
  `POST /:id/procedures/:procedureId/pricing-refresh` (body: optional `zip`;
  default member ZIP) → `buildSnapshot`, persist snapshot columns, return row.
- `backend/services/shareRequestService.js` — `getProcedures` selects new
  columns; new `savePricingSnapshot(procedureId, snapshot)`.
- Register pricing router in `backend/routes/me/vendor/index.js`.

### Frontend

- `frontend/src/services/cpt-pricing.service.ts` — typed client for the three
  proxy endpoints + pricing-refresh.
- `frontend/src/components/vendor/pricing/` (shared by both surfaces):
  - `MedicareBreakdownCard.tsx` — professional/facility/anesthesia sections,
    per-site comparison (ASC / HOPD / inpatient) each with all-in +
    150–200% range
  - `TargetRangeBadge.tsx` — "$X – $Y" headline range
  - `HospitalPricesTable.tsx` — nearby asking prices (cash, gross, negotiated
    min/max, top payers), collapsed by default in SR context
  - `CptSearchBox.tsx` — name/code typeahead via `/pricing/search`
- `frontend/src/components/vendor/share-requests/tabs/FinancesTab.tsx` — new
  **Procedure Pricing section above** the Bills/Ledger sub-tabs: CPT rows
  (add/edit/remove via existing CRUD), per row: description, Medicare all-in
  (cheapest site), target range, SnapshotDate, Refresh; expandable detail =
  MedicareBreakdownCard + HospitalPricesTable. ZIP defaults from member,
  editable before refresh. "Find CPT" affordance next to ProcedureName uses
  CptSearchBox.
- `frontend/src/pages/vendor/ProcedurePricingPage.tsx` — standalone lookup:
  CptSearchBox + ZIP → MedicareBreakdownCard + HospitalPricesTable. Read-only.
- `frontend/src/components/vendor/VendorNavigation.tsx` — "Procedure Pricing"
  item after Share Requests (Lucide `Calculator`).
- `frontend/src/App.tsx` — route `procedure-pricing` under `/vendor/*`.

UI follows CLAUDE.md rules: Tailwind only, `oe-primary` buttons, Lucide icons.

### Tests (minimal, fast-iteration)

- Jest: `cptPricingService` target math + snapshot shape (axios mocked).
- Skip route/Vitest/Cypress coverage for now; revisit before merge if needed.

## Sequencing

1. Droplet: mint `allaboard-backend` htpasswd user; backend `.env` creds.
2. Migration file + apply to testing (tracked for prod).
3. Backend service + routes + snapshot persistence.
4. Frontend service + shared components + FinancesTab section.
5. Nav page + route.
6. Jest for target math; manual verify against live API.
