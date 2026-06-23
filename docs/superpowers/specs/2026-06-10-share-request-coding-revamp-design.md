# Share Request Coding Revamp — Design

**Date:** 2026-06-10
**Branch:** `feat/backoffice/cpt-pricing` (continues prior CPT pricing work)
**Status:** Approved (design), pending spec review → implementation plan

## Summary

Restructure the back-office Share Request so that **procedures (CPT)** and **diagnoses
(ICD-10)** are first-class, structured, multi-row data that lives in **Request Details**
(not buried in the Finances tab), enabling the care team's core audit workflow:
**crosswalk diagnosis (ICD-10) ↔ procedure (CPT)**.

This is the **solid base layer** for a later AI summarization feature (Feature 2, out of
scope here). It removes redundant/abandoned fields and establishes single sources of truth.

## Goals

- Move CPT code entry/management out of Finances and into Request Details, next to the
  diagnoses, so the care team works the codes where the request is described.
- Make the normalized child tables the **single source of truth** for procedures and
  diagnoses; retire the redundant denormalized columns on `ShareRequests`.
- Surface a **diagnosis (ICD-10) ↔ procedure (CPT) crosswalk** view for auditing.
- Keep Finances as the pricing deep-dive (read view) of the same procedure rows.

## Non-goals (explicitly out of scope)

- **Feature 2: AI summarization** of share requests (separate spec cycle later).
- **Member-side capture changes.** The member portal intake door is abandoned and ignored.
  The public sharing-request form is **not** changed — diagnosis is *not* asked of members.
- **AI document parsing** to auto-extract codes (future; schema is parser-ready — codes are rows).
- **Explicit dx↔CPT link table.** Crosswalk is *set-level* (all dx vs all CPT) for now.
- **ICD-10 lookup/typeahead.** Diagnosis entry is manual (code + description) for now.

## Background (current state, audited 2026-06-10)

- **Two intake doors today:** the *public form* (rich clinical capture) and the *member
  portal* (thin, abandoned). We ignore the member portal.
- The **public form collects zero diagnosis information** — no diagnosis field type exists in
  the form builder palette. `extractEditableSrFields()` maps 10 fields (procedure, narrative,
  symptoms-began, new-condition, other-insurance, switch-doctor, surgeon-in-net, maternity,
  ER-charity, relation) — none diagnosis. On form-created SRs, `DiagnosisDescription` is
  backfilled from narrative text and `DiagnosisCode` is `NULL`.
- Diagnosis information actually lives in **member-uploaded documents** (visit notes, test
  results); it is extracted manually by the care team today, by AI eventually.
- **Redundancy found:**
  - `SubType` (Classification) duplicates `ProcedureName` (Clinical event) — both free-text
    "what's the procedure." `SubType` is never auto-populated; vendor-manual only.
  - Diagnosis is doubly modeled: singular `DiagnosisCode`/`DiagnosisDescription` columns
    (shown in UI) **and** a `ShareRequestDiagnoses` child table (invisible, never populated
    at intake) — the inverse of what we want.
  - Legacy `RequestType` (NOT NULL string) coexists with `RequestTypeId` (per-vendor enum).
  - `categoryId` is collected by the member portal and dropped (never persisted).
- **CPT codes** live in `ShareRequestProcedures` but are surfaced **only in Finances**, and
  are never written at intake — the care team always hand-enters them. This is the friction.

### Key file references

- DB tables: `oe.ShareRequests`, `oe.ShareRequestProcedures`, `oe.ShareRequestDiagnoses`
- Pricing snapshot migration: `sql-changes/2026-06-09-share-request-procedure-pricing.sql`
- SR types migration: `sql-changes/2026-05-19-share-request-types.sql`
- Editable-form-fields migration: `sql-changes/allaboard365/2026-05-28-sr-editable-form-fields.sql`
- Backend service: `backend/services/shareRequestService.js`
  (`createShareRequest`, `updateShareRequest`, `getShareRequestById`, procedures/diagnoses CRUD)
- Pricing service: `backend/services/cptPricingService.js`
- Form→SR mapper: `backend/services/publicFormShareLinkService.js` (`extractEditableSrFields`, ~L247-296, L752)
- Vendor routes: `backend/routes/me/vendor/share-requests.js`, `backend/routes/me/vendor/pricing.js`
- Detail UI: `frontend/src/components/vendor/share-requests/tabs/RequestDetailsTab.tsx`
- Finances UI: `frontend/src/components/vendor/share-requests/tabs/FinancesTab.tsx`
- Pricing section: `frontend/src/components/vendor/pricing/ProcedurePricingSection.tsx`, `CptSearchBox.tsx`

## Data model

### Source-of-truth tables (normalized, kept)

- **`oe.ShareRequestProcedures`** — procedures/CPT. Columns already exist:
  `ProcedureId, ShareRequestId, CPTCode, Description, SortOrder, CreatedDate, CreatedBy`
  + pricing snapshot (`PricingSnapshot, MedicareTotal, TargetMin, TargetMax, SnapshotZip,
  SnapshotDate`). Multiple rows per SR. Canonical home for "what procedures."
- **`oe.ShareRequestDiagnoses`** — diagnoses/ICD-10. Columns already exist:
  `DiagnosisId, ShareRequestId, ICD10Code, Description, IsPrimary, SortOrder, CreatedDate,
  CreatedBy`. Multiple rows per SR. Canonical home for "what diagnoses." Back-office entered.

### Columns retired on `oe.ShareRequests`

| Column | Reason | Backfill |
|---|---|---|
| `DiagnosisCode`, `DiagnosisDescription` | Replaced by `ShareRequestDiagnoses` rows | Non-null values → one `ShareRequestDiagnoses` row, `IsPrimary=1` |
| `SubType` | Redundant with `ProcedureName` | Non-null `SubType` → `ProcedureName` where it's empty; else discard |
| `RequestType` (legacy NOT NULL string) | Superseded by `RequestTypeId` enum | **Soft-retire only**: add a `DEFAULT 'Medical'` so the code can stop writing it; do NOT physically drop it (may be referenced by legacy reports/code — needs a wider audit first) |
| `categoryId` (member-portal) | Dead input | None (never persisted) |

### Columns kept

- `RequestTypeId` — category enum (Surgery–Inpatient/Outpatient, Procedure, Treatment, Maternity).
- `ProcedureName` — the **single** free-text "member-stated procedure" (from form `surg_procedure`).
  *Not* redundant with CPT rows: member's words vs. back-office coding.
- Clinical-context fields: `EventNarrative, SymptomsBeganDate, IsNewCondition, OtherInsurance,
  WouldSwitchDoctor, SurgeonInNetwork, MaternityDeliveryStatus, ErCharityCareApplied,
  PatientRelationToPrimary`, service dates.

### Crosswalk

Set-level: all diagnoses on the SR are weighed against all procedures (how a human reads the
page). No explicit dx↔CPT link table yet — schema can grow one later if precision is needed.

### Phased column drop (safety)

- **Migration 1** (this feature): backfill child rows from `DiagnosisCode/Description` and
  `SubType`; add a `DEFAULT` constraint on `RequestType` so inserts no longer supply it; code
  stops reading/writing the retired columns. Columns remain physically present.
- **Migration 2** (follow-up, after prod verification): physically `DROP` the retired columns.

Matches the established pattern (SR-types deferred its legacy column drop).

## Backend changes

1. **Detail API** (`getShareRequestById`): embed `diagnoses[]` (from `ShareRequestDiagnoses`)
   and `procedures[]` (from `ShareRequestProcedures`, incl. pricing snapshot) in the detail
   response, so Request Details renders the Coding section in one fetch. Existing dedicated
   endpoints (`/:id/procedures`, `/:id/diagnoses`) remain for mutations/refresh.
2. **`createShareRequest` / `updateShareRequest`**: stop setting `SubType`, `DiagnosisCode`,
   `DiagnosisDescription`, and legacy `RequestType` (default constraint satisfies its NOT NULL
   until dropped). `RequestTypeId` is the only category the code touches.
3. **Form→SR mapper** (`publicFormShareLinkService.js`): remove the line backfilling
   `diagnosisDescription` from narrative text. `ProcedureName` keeps mapping from
   `surg_procedure`. Form submissions populate procedure + context, never diagnosis.
4. **Diagnosis CRUD already exists** (corrected after code audit): the service has
   `getDiagnoses`/`addDiagnosis`/`updateDiagnosis`/`deleteDiagnosis` with `IsPrimary` handling,
   and the vendor routes already expose GET/POST/PUT/DELETE `/:id/diagnoses[/:diagnosisId]`
   with ICD-10 validation. **No new backend CRUD needed** — the diagnosis gap is purely the
   missing front-end UI plus the detail-embed.
5. **ICD-10 entry is manual** (code + description). No ICD lookup service exists; not building
   one now. ICD typeahead is a clean later enhancement (and a natural AI-fed feature).
6. **Finances backend unchanged** — already reads `ShareRequestProcedures`.

## Frontend changes

### Request Details — new "Coding" section (under Classification)

Stacked for at-a-glance crosswalk:
1. **Stated procedure** — `ProcedureName` (member's words, read-mostly).
2. **Procedures (CPT)** — `ShareRequestProcedures` list. Add via existing `CptSearchBox`
   typeahead; each row: code + official descriptor + compact pricing badge (Medicare total /
   target range). Reuses relocated `ProcedurePricingSection` machinery.
3. **Diagnoses (ICD-10)** — `ShareRequestDiagnoses` list. Manual add (code + description),
   mark one Primary, edit/delete inline.

### Card reorg (rest of Request Details)

- **Classification** — remove Sub-type; Request Type only.
- **Service** — remove the two diagnosis fields; keep service dates.
- **Clinical event** — keep narrative + context flags; the procedure free-text moves to Coding.
- **Status, Financial summary, Dates, Notes, Plan members** — unchanged.

### Finances tab

CPT codes are managed in Coding, not here. Finances becomes the **pricing read-view** of the
same `ShareRequestProcedures` rows: per-CPT Medicare breakdown, 150–200% target range,
nearby-hospital comparison, refresh action. One source, two views (Coding manages, Finances
prices). No duplicate entry.

## Migrations (must be logged atop the PR for prod application)

- `sql-changes/<date>-sr-coding-backfill.sql` — backfill `ShareRequestDiagnoses` from singular
  diagnosis columns; migrate `SubType` → `ProcedureName`; add `DEFAULT` on `RequestType`.
  Dry-run/SELECT-preview first per DB policy.
- `sql-changes/<date>-sr-drop-legacy-coding-columns.sql` — follow-up DROP of retired columns
  (run only after prod verification).

> Per repo conventions: write the SQL files only; do **not** run against shared `allaboard-testing`
> unless explicitly asked. Track both migrations atop the PR so they're applied to prod on merge.

## Verification plan

User-visible outcomes:
- Care team can add/edit/delete **multiple CPT codes** and **multiple ICD-10 diagnoses** from
  **Request Details**, with one diagnosis markable Primary.
- CPT and ICD lists render adjacent (crosswalk view) in the Coding section.
- Finances shows pricing for the same CPT codes; adding a code in Coding appears in Finances.
- A form-created SR no longer writes `DiagnosisDescription` from narrative; existing SRs show
  their migrated diagnosis as a `ShareRequestDiagnoses` row.
- Sub-type field is gone from the UI; existing Sub-type values appear as `ProcedureName` where
  it was empty.

Code paths: create (form + vendor), update, detail read (embedded lists), procedures CRUD,
diagnoses CRUD (incl. new update/delete/primary), mapper, backfill migration.

Tests: backend Jest for diagnoses CRUD + detail-embed + create/update no longer writing retired
columns + mapper change; frontend Vitest for the Coding section (CPT list + diagnoses list +
crosswalk render); migration dry-run preview verified before any write.

## Future (Feature 2 and beyond)

- AI summarization of the SR, re-summarizing on change (HIPAA-compliant model). The normalized
  Coding structure is the clean input for context assembly.
- AI document parsing to pre-fill CPT/ICD rows from uploaded visit notes / test results.
- ICD-10 lookup/typeahead.
- Explicit dx↔CPT link table if per-pair crosswalk precision is ever needed.
