# Share Request Coding Revamp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make procedures (CPT) and diagnoses (ICD-10) first-class, multi-row, structured data surfaced in the Share Request **Request Details** tab as a diagnosis↔procedure crosswalk, and retire the redundant `SubType` / singular-diagnosis / legacy `RequestType` columns.

**Architecture:** Child tables `oe.ShareRequestProcedures` and `oe.ShareRequestDiagnoses` become the single source of truth. The detail API embeds both lists. A new **Coding** section in `RequestDetailsTab` renders the diagnosis list (new UI) beside the existing CPT pricing component (relocated out of Finances). The legacy denormalized columns are backfilled into the child tables and stop being read/written; a follow-up migration drops them after prod verification.

**Tech Stack:** Express + `mssql` (backend), React 18 + TypeScript + Tailwind + Lucide (frontend), Jest (backend tests), Vitest (frontend tests), Azure SQL migrations under `sql-changes/`.

**Spec:** `docs/superpowers/specs/2026-06-10-share-request-coding-revamp-design.md`

**Conventions reminder:**
- SQL files are **written only**, never executed. Default `@DryRun = 1`. Log both migrations atop the PR for prod (per `feedback_db_migration_tracking`).
- Backend tests mock the pool: `const mockRequest = { input: jest.fn().mockReturnThis(), query: jest.fn() }; const mockPool = { request: jest.fn(() => mockRequest) };` then `jest.mock('../../config/database', ...)`. See `services/__tests__/caseService.forwarding.test.js`.
- Run backend tests from `backend/` via the Docker toolchain (`reference_docker_toolchain`): `sudo docker exec allaboard365-backend npx jest <path>`. Frontend: `sudo docker exec allaboard365-frontend npx vitest run <path>` and `... npx tsc --noEmit`.
- Brand colors only (`oe-primary`/`oe-dark`), Tailwind + Lucide, no MUI.

**Deviations from spec (small, called out for the implementer):**
1. The CPT pricing component (`ProcedurePricingSection`) is **moved** from the Finances tab into the new Coding section rather than duplicated. Finances keeps bills + ledger + stats. (Spec §4 imagined Finances as a pricing read-view; moving the one component avoids a duplicate "Add code" box and still gives Finances users the codes via Request Details.)
2. `ProcedureName` (member-stated procedure free-text) **stays in the Clinical event card**; the Coding section owns the *codes*. The crosswalk (CPT beside ICD) is delivered without re-plumbing the edit-mode form for ProcedureName.

---

## File Structure

**Create:**
- `sql-changes/2026-06-10-sr-coding-backfill.sql` — backfill child rows + `RequestType` default (dry-run default).
- `sql-changes/2026-06-10-sr-drop-legacy-coding-columns.sql` — follow-up DROP (run after prod verify).
- `frontend/src/services/sr-diagnoses.service.ts` — diagnosis CRUD client.
- `frontend/src/services/__tests__/sr-diagnoses.service.test.ts` — service unit tests.
- `frontend/src/components/vendor/share-requests/DiagnosisList.tsx` — ICD-10 list UI (add/edit/delete/primary).
- `frontend/src/components/vendor/share-requests/CodingSection.tsx` — wraps DiagnosisList + ProcedurePricingSection side-by-side.
- `frontend/src/components/vendor/share-requests/__tests__/DiagnosisList.test.tsx` — component tests.

**Modify:**
- `backend/routes/me/vendor/share-requests.js` — `GET /:id` embeds `diagnoses` + `procedures`.
- `backend/services/shareRequestService.js` — `createShareRequest` + `updateShareRequest` stop writing legacy columns; `getShareRequests` drops legacy SELECT/search refs.
- `backend/services/publicFormShareLinkService.js` — drop `diagnosisDescription` narrative backfill.
- `backend/services/__tests__/shareRequestCoding.service.test.js` — new test file (create/update no longer reference legacy columns).
- `frontend/src/types/shareRequest.types.ts` — add `diagnoses`/`procedures` to detail; drop `SubType`/`DiagnosisCode`/`DiagnosisDescription` usage.
- `frontend/src/components/vendor/share-requests/tabs/RequestDetailsTab.tsx` — remove Sub-type + diagnosis fields; render `<CodingSection>`.
- `frontend/src/components/vendor/share-requests/tabs/FinancesTab.tsx` — remove relocated `ProcedurePricingSection`.

---

## Phase 0 — Migrations (SQL files only; do NOT execute)

### Task 1: Backfill migration

**Files:**
- Create: `sql-changes/2026-06-10-sr-coding-backfill.sql`

- [ ] **Step 1: Write the backfill migration with a default dry-run**

```sql
-- 2026-06-10-sr-coding-backfill.sql
-- Coding revamp, migration 1 of 2 (backfill + soft-retire). Idempotent.
-- DOES NOT DROP COLUMNS. The follow-up 2026-06-10-sr-drop-legacy-coding-columns.sql
-- physically drops them after prod verification.
--
-- Run with @DryRun = 1 first (default): prints the rows that WOULD change.
-- Set @DryRun = 0 to apply.
SET NOCOUNT ON;
DECLARE @DryRun BIT = 1;

-- 1) Backfill ShareRequestDiagnoses from the singular DiagnosisCode column.
--    Only rows with a real CODE are migrated. Code-less DiagnosisDescription
--    values are narrative-derived (the public form never captured a diagnosis)
--    and are intentionally NOT imported as diagnoses.
;WITH src AS (
    SELECT sr.ShareRequestId, sr.DiagnosisCode, sr.DiagnosisDescription
    FROM oe.ShareRequests sr
    WHERE NULLIF(LTRIM(RTRIM(sr.DiagnosisCode)), '') IS NOT NULL
      AND NOT EXISTS (
          SELECT 1 FROM oe.ShareRequestDiagnoses d
          WHERE d.ShareRequestId = sr.ShareRequestId
      )
)
SELECT 'WOULD INSERT diagnosis' AS Action, ShareRequestId, DiagnosisCode, DiagnosisDescription
FROM src;

-- 2) Backfill ProcedureName from SubType where ProcedureName is empty.
SELECT 'WOULD UPDATE ProcedureName from SubType' AS Action,
       sr.ShareRequestId, sr.SubType AS NewProcedureName
FROM oe.ShareRequests sr
WHERE NULLIF(LTRIM(RTRIM(sr.SubType)), '') IS NOT NULL
  AND NULLIF(LTRIM(RTRIM(sr.ProcedureName)), '') IS NULL;

IF @DryRun = 0
BEGIN
    BEGIN TRAN;

    INSERT INTO oe.ShareRequestDiagnoses
        (DiagnosisId, ShareRequestId, ICD10Code, Description, IsPrimary, SortOrder, CreatedDate, CreatedBy)
    SELECT NEWID(), sr.ShareRequestId,
           UPPER(LTRIM(RTRIM(sr.DiagnosisCode))),
           NULLIF(LTRIM(RTRIM(sr.DiagnosisDescription)), ''),
           1, 0, GETDATE(), NULL
    FROM oe.ShareRequests sr
    WHERE NULLIF(LTRIM(RTRIM(sr.DiagnosisCode)), '') IS NOT NULL
      AND NOT EXISTS (
          SELECT 1 FROM oe.ShareRequestDiagnoses d
          WHERE d.ShareRequestId = sr.ShareRequestId
      );

    UPDATE sr
       SET sr.ProcedureName = LTRIM(RTRIM(sr.SubType))
    FROM oe.ShareRequests sr
    WHERE NULLIF(LTRIM(RTRIM(sr.SubType)), '') IS NOT NULL
      AND NULLIF(LTRIM(RTRIM(sr.ProcedureName)), '') IS NULL;

    -- 3) Soft-retire RequestType: a DEFAULT lets the app stop supplying it
    --    without violating the existing NOT NULL. Not dropped here.
    IF NOT EXISTS (
        SELECT 1 FROM sys.default_constraints
        WHERE name = 'DF_ShareRequests_RequestType'
    )
    BEGIN
        ALTER TABLE oe.ShareRequests
            ADD CONSTRAINT DF_ShareRequests_RequestType DEFAULT 'Medical' FOR RequestType;
    END

    COMMIT TRAN;
    PRINT 'Backfill applied.';
END
ELSE
    PRINT 'DRY RUN — no changes applied. Set @DryRun = 0 to apply.';
```

- [ ] **Step 2: Sanity-check the SQL parses (no execution)**

Visually confirm: dry-run previews the two change sets, writes are wrapped in `IF @DryRun = 0` + a transaction, and the default-constraint add is `IF NOT EXISTS`-guarded.

- [ ] **Step 3: Commit**

```bash
git add sql-changes/2026-06-10-sr-coding-backfill.sql
git commit -m "feat(sr-coding): backfill migration — child diagnoses + ProcedureName + RequestType default"
```

### Task 2: Drop-legacy-columns follow-up migration

**Files:**
- Create: `sql-changes/2026-06-10-sr-drop-legacy-coding-columns.sql`

- [ ] **Step 1: Write the drop migration (run only after prod verification)**

```sql
-- 2026-06-10-sr-drop-legacy-coding-columns.sql
-- Coding revamp, migration 2 of 2. RUN ONLY AFTER the app no longer reads/writes
-- these columns (this PR) is deployed AND verified in prod.
-- RequestType is intentionally KEPT (soft-retired with a default) — dropping it
-- needs a wider audit of legacy reports/code first.
SET NOCOUNT ON;
DECLARE @DryRun BIT = 1;

SELECT 'WOULD DROP columns SubType, DiagnosisCode, DiagnosisDescription on oe.ShareRequests' AS Action;

IF @DryRun = 0
BEGIN
    IF COL_LENGTH('oe.ShareRequests', 'SubType') IS NOT NULL
        ALTER TABLE oe.ShareRequests DROP COLUMN SubType;
    IF COL_LENGTH('oe.ShareRequests', 'DiagnosisCode') IS NOT NULL
        ALTER TABLE oe.ShareRequests DROP COLUMN DiagnosisCode;
    IF COL_LENGTH('oe.ShareRequests', 'DiagnosisDescription') IS NOT NULL
        ALTER TABLE oe.ShareRequests DROP COLUMN DiagnosisDescription;
    PRINT 'Legacy coding columns dropped.';
END
ELSE
    PRINT 'DRY RUN — no changes applied.';
```

- [ ] **Step 2: Commit**

```bash
git add sql-changes/2026-06-10-sr-drop-legacy-coding-columns.sql
git commit -m "feat(sr-coding): follow-up migration to drop legacy coding columns (post-verify)"
```

---

## Phase 1 — Backend

### Task 3: Stop writing legacy columns in `createShareRequest`

**Files:**
- Modify: `backend/services/shareRequestService.js` (create: ~333-413)
- Test: `backend/services/__tests__/shareRequestCoding.service.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// backend/services/__tests__/shareRequestCoding.service.test.js
const mockRequest = { input: jest.fn().mockReturnThis(), query: jest.fn(), output: jest.fn().mockReturnThis(), execute: jest.fn() };
const mockPool = { request: jest.fn(() => mockRequest) };
jest.mock('../../config/database', () => ({
  getPool: jest.fn(async () => mockPool),
  sql: new Proxy({}, { get: (_t, p) => (typeof p === 'string' ? p : undefined), apply: () => 'SQLTYPE' }),
}));

const ShareRequestService = require('../shareRequestService');

beforeEach(() => {
  jest.clearAllMocks();
  mockRequest.execute.mockResolvedValue({ output: { requestNumber: 'SR-1' } });
  mockRequest.query.mockResolvedValue({ recordset: [] });
});

describe('createShareRequest column hygiene', () => {
  test('INSERT does not reference retired coding columns', async () => {
    await ShareRequestService.createShareRequest('vendor-1', { requestTypeId: 'type-1' }, 'user-1');
    const insertCall = mockRequest.query.mock.calls.find(c => /INSERT INTO oe\.ShareRequests/i.test(c[0]));
    expect(insertCall).toBeDefined();
    const sql = insertCall[0];
    expect(sql).not.toMatch(/\bSubType\b/);
    expect(sql).not.toMatch(/\bDiagnosisCode\b/);
    expect(sql).not.toMatch(/\bDiagnosisDescription\b/);
    expect(sql).not.toMatch(/\bRequestType\b(?!Id)/); // RequestType (not RequestTypeId)
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `sudo docker exec allaboard365-backend npx jest services/__tests__/shareRequestCoding.service.test.js -t "INSERT does not reference"`
Expected: FAIL (current INSERT still lists `RequestType, ... SubType, ... DiagnosisCode, DiagnosisDescription`).

- [ ] **Step 3: Edit `createShareRequest` — remove the retired inputs**

Delete these `request.input(...)` lines (around 343, 348-349, 385):
```javascript
            request.input('subType', sql.NVarChar(500), data.subType || null);
```
```javascript
            request.input('diagnosisCode', sql.NVarChar, data.diagnosisCode || null);
            request.input('diagnosisDescription', sql.NVarChar, data.diagnosisDescription || null);
```
```javascript
            // Legacy NOT-NULL column. Caller may pass a name (e.g. resolved
            // type's Name, or formKind-derived value). Default to 'Medical'
            // so a caller forgetting the field doesn't crash on insert.
            request.input('requestType', sql.NVarChar(100), data.requestType || 'Medical');
```

- [ ] **Step 4: Edit the INSERT column + values lists**

Replace the column list line:
```javascript
                        RequestType, RequestTypeId, SubType, Status, Determination,
                        DateOfService, DateOfServiceEnd, DiagnosisCode, DiagnosisDescription,
```
with:
```javascript
                        RequestTypeId, Status, Determination,
                        DateOfService, DateOfServiceEnd,
```
and the values list line:
```javascript
                        @requestType, @requestTypeId, @subType, @status, @determination,
                        @dateOfService, @dateOfServiceEnd, @diagnosisCode, @diagnosisDescription,
```
with:
```javascript
                        @requestTypeId, @status, @determination,
                        @dateOfService, @dateOfServiceEnd,
```

(`RequestType` is omitted from the INSERT; the `DF_ShareRequests_RequestType` default from Task 1 supplies `'Medical'`.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `sudo docker exec allaboard365-backend npx jest services/__tests__/shareRequestCoding.service.test.js -t "INSERT does not reference"`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add backend/services/shareRequestService.js backend/services/__tests__/shareRequestCoding.service.test.js
git commit -m "feat(sr-coding): createShareRequest stops writing SubType/Diagnosis*/RequestType"
```

### Task 4: Stop writing legacy columns in `updateShareRequest`

**Files:**
- Modify: `backend/services/shareRequestService.js` (update: 515-523, 542-551)
- Test: `backend/services/__tests__/shareRequestCoding.service.test.js`

- [ ] **Step 1: Add the failing test**

Append to the test file:
```javascript
describe('updateShareRequest column hygiene', () => {
  test('UPDATE never sets retired coding columns even if passed', async () => {
    // getShareRequestById (called first) returns current row
    mockRequest.query
      .mockResolvedValueOnce({ recordset: [{ ShareRequestId: 'sr-1', SubType: 'old', DiagnosisCode: 'A00', DiagnosisDescription: 'd', RequestTypeName: 'X' }] })
      .mockResolvedValue({ recordset: [] });
    await ShareRequestService.updateShareRequest('sr-1', 'vendor-1', {
      subType: 'new', diagnosisCode: 'B11', diagnosisDescription: 'changed', nextSteps: 'go',
    }, 'user-1');
    const updateCall = mockRequest.query.mock.calls.find(c => /UPDATE oe\.ShareRequests\s+SET/i.test(c[0]) && /NextSteps/.test(c[0]));
    expect(updateCall).toBeDefined();
    expect(updateCall[0]).not.toMatch(/\bSubType\b/);
    expect(updateCall[0]).not.toMatch(/\bDiagnosisCode\b/);
    expect(updateCall[0]).not.toMatch(/\bDiagnosisDescription\b/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `sudo docker exec allaboard365-backend npx jest services/__tests__/shareRequestCoding.service.test.js -t "UPDATE never sets"`
Expected: FAIL

- [ ] **Step 3: Delete the three retired update blocks**

Remove the `SubType` block (515-523):
```javascript
        if (data.subType !== undefined && data.subType !== current.SubType) {
            updateFields.push('SubType = @subType');
            request.input('subType', sql.NVarChar(500), data.subType || null);
            changes.push({
                field: 'Sub-type',
                from: current.SubType || '—',
                to: data.subType || '—'
            });
        }
```
Remove the `DiagnosisCode` block (542-546):
```javascript
        if (data.diagnosisCode !== undefined && data.diagnosisCode !== current.DiagnosisCode) {
            updateFields.push('DiagnosisCode = @diagnosisCode');
            request.input('diagnosisCode', sql.NVarChar, data.diagnosisCode);
            changes.push({ field: 'Primary Diagnosis Code', from: current.DiagnosisCode || 'None', to: data.diagnosisCode || 'None' });
        }
```
Remove the `DiagnosisDescription` block (547-551):
```javascript
        if (data.diagnosisDescription !== undefined && data.diagnosisDescription !== current.DiagnosisDescription) {
            updateFields.push('DiagnosisDescription = @diagnosisDescription');
            request.input('diagnosisDescription', sql.NVarChar, data.diagnosisDescription);
            changes.push({ field: 'Diagnosis Description', from: current.DiagnosisDescription || 'None', to: data.diagnosisDescription || 'None' });
        }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `sudo docker exec allaboard365-backend npx jest services/__tests__/shareRequestCoding.service.test.js -t "UPDATE never sets"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/services/shareRequestService.js backend/services/__tests__/shareRequestCoding.service.test.js
git commit -m "feat(sr-coding): updateShareRequest stops writing SubType/Diagnosis*"
```

### Task 5: Drop legacy column references in `getShareRequests`

**Files:**
- Modify: `backend/services/shareRequestService.js` (list query: 65-74, 129, 133-134)

- [ ] **Step 1: Remove the diagnosis search clause (65-74)**

Change:
```javascript
            whereConditions.push(`(
                sr.RequestNumber LIKE @search 
                OR sr.RequestName LIKE @search
                OR u.FirstName LIKE @search 
                OR u.LastName LIKE @search
                OR sr.DiagnosisDescription LIKE @search
            )`);
```
to (drop the `DiagnosisDescription` line):
```javascript
            whereConditions.push(`(
                sr.RequestNumber LIKE @search 
                OR sr.RequestName LIKE @search
                OR u.FirstName LIKE @search 
                OR u.LastName LIKE @search
            )`);
```

- [ ] **Step 2: Remove the SELECT references (129, 133-134)**

Delete these three lines from the data query SELECT list:
```javascript
                sr.SubType,
```
```javascript
                sr.DiagnosisCode,
                sr.DiagnosisDescription,
```

- [ ] **Step 3: Run the existing SR suite to confirm nothing else references them**

Run: `sudo docker exec allaboard365-backend npx jest services/__tests__/shareRequestCoding.service.test.js`
Expected: PASS (and `npx eslint services/shareRequestService.js` clean).

- [ ] **Step 4: Commit**

```bash
git add backend/services/shareRequestService.js
git commit -m "feat(sr-coding): drop SubType/Diagnosis* from share-request list query"
```

### Task 6: Embed `diagnoses` + `procedures` in the detail route

**Files:**
- Modify: `backend/routes/me/vendor/share-requests.js` (GET `/:id`, 400-426)

- [ ] **Step 1: Edit the GET `/:id` handler to attach both lists**

Replace the body of the try block:
```javascript
        const shareRequest = await ShareRequestService.getShareRequestById(
            req.params.id,
            req.vendor.VendorId
        );

        if (!shareRequest) {
            return res.status(404).json({
                success: false,
                message: 'Share request not found'
            });
        }

        res.json({
            success: true,
            data: shareRequest
        });
```
with:
```javascript
        const shareRequest = await ShareRequestService.getShareRequestById(
            req.params.id,
            req.vendor.VendorId
        );

        if (!shareRequest) {
            return res.status(404).json({
                success: false,
                message: 'Share request not found'
            });
        }

        // Embed the coding child lists so Request Details renders the Coding
        // section (diagnoses + procedures crosswalk) in one fetch.
        const [diagnoses, procedures] = await Promise.all([
            ShareRequestService.getDiagnoses(req.params.id),
            ShareRequestService.getProcedures(req.params.id),
        ]);

        res.json({
            success: true,
            data: { ...shareRequest, diagnoses, procedures }
        });
```

- [ ] **Step 2: Manual smoke (no automated route harness exists for this file)**

Confirm by reading: `getDiagnoses`/`getProcedures` are `static` methods on `ShareRequestService` (they are — `shareRequestService.js:1235,1383`) and return arrays. ESLint clean: `sudo docker exec allaboard365-backend npx eslint routes/me/vendor/share-requests.js`.

- [ ] **Step 3: Commit**

```bash
git add backend/routes/me/vendor/share-requests.js
git commit -m "feat(sr-coding): embed diagnoses + procedures in share-request detail response"
```

### Task 7: Stop the mapper backfilling `diagnosisDescription` from narrative

**Files:**
- Modify: `backend/services/publicFormShareLinkService.js` (SR-create payload, ~752)

- [ ] **Step 1: Locate and remove the narrative→diagnosis line**

In the object passed to `createShareRequest` (the SR-create payload built from the form), remove the line:
```javascript
            diagnosisDescription: payload.detailedDescription || payload.requestDescription || null,
```
Leave `procedureName` (mapped from `surg_procedure`) and all other mappings intact. (Confirm the exact key name in context before deleting; it is the only `diagnosisDescription:` assignment in this file.)

- [ ] **Step 2: Verify no other code in the file sets diagnosis fields**

Run: `sudo docker exec allaboard365-backend bash -lc "grep -n diagnosis services/publicFormShareLinkService.js"`
Expected: no remaining `diagnosisDescription`/`diagnosisCode` assignments into the SR payload.

- [ ] **Step 3: Commit**

```bash
git add backend/services/publicFormShareLinkService.js
git commit -m "feat(sr-coding): form->SR mapper no longer backfills diagnosis from narrative"
```

---

## Phase 2 — Frontend types + diagnosis service

### Task 8: Extend the detail type; drop legacy field usage

**Files:**
- Modify: `frontend/src/types/shareRequest.types.ts` (ShareRequest: 160-161; ShareRequestProcedure: 131-138; add embed fields)

- [ ] **Step 1: Make `ShareRequestProcedure` carry the pricing snapshot fields**

Replace the slim interface (131-138):
```typescript
export interface ShareRequestProcedure {
  ProcedureId: string;
  ShareRequestId: string;
  CPTCode: string;
  Description?: string;
  SortOrder: number;
  CreatedDate: string;
}
```
with one that re-exports the richer pricing type so detail + pricing UI agree:
```typescript
// The detail embed returns the full pricing-enriched procedure row. Re-use the
// canonical pricing type so RequestDetails and the pricing component agree.
export type { ShareRequestProcedure } from './cptPricing.types';
```
(Remove the local `interface ShareRequestProcedure { ... }`.)

- [ ] **Step 2: Drop the singular diagnosis fields and add the embed arrays on `ShareRequest`**

Remove from the `// Service Details` block (160-161):
```typescript
  DiagnosisCode?: string;
  DiagnosisDescription?: string;
```
Remove the `SubType` line (151):
```typescript
  SubType?: string | null;
```
Add, near the bottom of the `ShareRequest` interface (e.g. after `ProviderCount?`):
```typescript
  // Coding child lists — embedded by GET /api/me/vendor/share-requests/:id.
  diagnoses?: ShareRequestDiagnosis[];
  procedures?: ShareRequestProcedure[];
```

- [ ] **Step 3: Type-check**

Run: `sudo docker exec allaboard365-frontend npx tsc --noEmit`
Expected: errors ONLY in files that referenced `SubType`/`DiagnosisCode`/`DiagnosisDescription` (RequestDetailsTab — fixed in Task 11). Note them; proceed.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/types/shareRequest.types.ts
git commit -m "feat(sr-coding): detail type carries diagnoses/procedures; drop singular diagnosis/subtype"
```

### Task 9: Diagnosis CRUD client

**Files:**
- Create: `frontend/src/services/sr-diagnoses.service.ts`
- Test: `frontend/src/services/__tests__/sr-diagnoses.service.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// frontend/src/services/__tests__/sr-diagnoses.service.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { srDiagnosesService } from '../sr-diagnoses.service';
import { apiService } from '../api.service';

vi.mock('../api.service', () => ({
  apiService: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

const SR = 'sr-1';
beforeEach(() => vi.clearAllMocks());

describe('srDiagnosesService', () => {
  it('lists diagnoses', async () => {
    (apiService.get as any).mockResolvedValue({ success: true, data: [{ DiagnosisId: 'd1' }] });
    const rows = await srDiagnosesService.list(SR);
    expect(apiService.get).toHaveBeenCalledWith(`/api/me/vendor/share-requests/${SR}/diagnoses`);
    expect(rows).toEqual([{ DiagnosisId: 'd1' }]);
  });

  it('adds a diagnosis', async () => {
    (apiService.post as any).mockResolvedValue({ success: true, data: { diagnosisId: 'd2' } });
    await srDiagnosesService.add(SR, { icd10Code: 'm17.11', description: 'OA knee', isPrimary: true });
    expect(apiService.post).toHaveBeenCalledWith(
      `/api/me/vendor/share-requests/${SR}/diagnoses`,
      { icd10Code: 'm17.11', description: 'OA knee', isPrimary: true }
    );
  });

  it('throws on failure', async () => {
    (apiService.get as any).mockResolvedValue({ success: false, message: 'nope' });
    await expect(srDiagnosesService.list(SR)).rejects.toThrow('nope');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `sudo docker exec allaboard365-frontend npx vitest run src/services/__tests__/sr-diagnoses.service.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the service**

```typescript
// frontend/src/services/sr-diagnoses.service.ts
// Client for the per-share-request diagnosis (ICD-10) CRUD endpoints.
import { apiService } from './api.service';
import type { ShareRequestDiagnosis } from '../types/shareRequest.types';

interface ApiEnvelope<T> { success: boolean; data?: T; message?: string }
const SR_BASE = '/api/me/vendor/share-requests';

function unwrap<T>(res: ApiEnvelope<T>, what: string): T {
  if (!res.success || res.data === undefined) throw new Error(res.message || `Failed to ${what}`);
  return res.data;
}

export interface DiagnosisInput {
  icd10Code: string;
  description?: string;
  isPrimary?: boolean;
  sortOrder?: number;
}

export const srDiagnosesService = {
  async list(shareRequestId: string): Promise<ShareRequestDiagnosis[]> {
    const res = await apiService.get<ApiEnvelope<ShareRequestDiagnosis[]>>(`${SR_BASE}/${shareRequestId}/diagnoses`);
    return unwrap(res, 'load diagnoses');
  },
  async add(shareRequestId: string, input: DiagnosisInput): Promise<{ diagnosisId: string; icd10Code: string }> {
    const res = await apiService.post<ApiEnvelope<{ diagnosisId: string; icd10Code: string }>>(`${SR_BASE}/${shareRequestId}/diagnoses`, input);
    return unwrap(res, 'add diagnosis');
  },
  async update(shareRequestId: string, diagnosisId: string, input: Partial<DiagnosisInput>): Promise<void> {
    const res = await apiService.put<ApiEnvelope<unknown>>(`${SR_BASE}/${shareRequestId}/diagnoses/${diagnosisId}`, input);
    if (!res.success) throw new Error(res.message || 'Failed to update diagnosis');
  },
  async remove(shareRequestId: string, diagnosisId: string): Promise<void> {
    const res = await apiService.delete<ApiEnvelope<unknown>>(`${SR_BASE}/${shareRequestId}/diagnoses/${diagnosisId}`);
    if (!res.success) throw new Error(res.message || 'Failed to delete diagnosis');
  },
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `sudo docker exec allaboard365-frontend npx vitest run src/services/__tests__/sr-diagnoses.service.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/services/sr-diagnoses.service.ts frontend/src/services/__tests__/sr-diagnoses.service.test.ts
git commit -m "feat(sr-coding): add ICD-10 diagnosis CRUD client"
```

---

## Phase 3 — Frontend UI

### Task 10: `DiagnosisList` component

**Files:**
- Create: `frontend/src/components/vendor/share-requests/DiagnosisList.tsx`
- Test: `frontend/src/components/vendor/share-requests/__tests__/DiagnosisList.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/components/vendor/share-requests/__tests__/DiagnosisList.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import DiagnosisList from '../DiagnosisList';
import { srDiagnosesService } from '../../../../services/sr-diagnoses.service';

vi.mock('../../../../services/sr-diagnoses.service', () => ({
  srDiagnosesService: { list: vi.fn(), add: vi.fn(), update: vi.fn(), remove: vi.fn() },
}));

beforeEach(() => vi.clearAllMocks());

describe('DiagnosisList', () => {
  it('renders existing diagnoses', async () => {
    (srDiagnosesService.list as any).mockResolvedValue([
      { DiagnosisId: 'd1', ICD10Code: 'M17.11', Description: 'OA right knee', IsPrimary: true, SortOrder: 0, CreatedDate: '2026-06-01' },
    ]);
    render(<DiagnosisList shareRequestId="sr-1" />);
    expect(await screen.findByText('M17.11')).toBeInTheDocument();
    expect(screen.getByText('OA right knee')).toBeInTheDocument();
  });

  it('adds a diagnosis and reloads', async () => {
    (srDiagnosesService.list as any).mockResolvedValue([]);
    (srDiagnosesService.add as any).mockResolvedValue({ diagnosisId: 'd2', icd10Code: 'E11.9' });
    render(<DiagnosisList shareRequestId="sr-1" />);
    await screen.findByText(/No diagnoses/i);
    fireEvent.click(screen.getByRole('button', { name: /Add diagnosis/i }));
    fireEvent.change(screen.getByPlaceholderText(/ICD-10/i), { target: { value: 'E11.9' } });
    fireEvent.change(screen.getByPlaceholderText(/Description/i), { target: { value: 'Type 2 diabetes' } });
    fireEvent.click(screen.getByRole('button', { name: /^Add$/ }));
    await waitFor(() => expect(srDiagnosesService.add).toHaveBeenCalledWith('sr-1', expect.objectContaining({ icd10Code: 'E11.9', description: 'Type 2 diabetes' })));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `sudo docker exec allaboard365-frontend npx vitest run src/components/vendor/share-requests/__tests__/DiagnosisList.test.tsx`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `DiagnosisList`**

```tsx
// frontend/src/components/vendor/share-requests/DiagnosisList.tsx
// ICD-10 diagnoses for one share request (oe.ShareRequestDiagnoses). Manual
// entry — code + description, one markable Primary. Sits beside the CPT pricing
// list in the Coding section to support the diagnosis<->procedure crosswalk.
import { useCallback, useEffect, useState } from 'react';
import { Plus, Star, Stethoscope, Trash2 } from 'lucide-react';
import { srDiagnosesService } from '../../../services/sr-diagnoses.service';
import type { ShareRequestDiagnosis } from '../../../types/shareRequest.types';
import Skeleton from '../ui/Skeleton';

interface DiagnosisListProps {
  shareRequestId: string;
}

const ICD10 = /^[A-Z]\d{2}\.?\d{0,4}[A-Z]?$/i;

const DiagnosisList = ({ shareRequestId }: DiagnosisListProps) => {
  const [rows, setRows] = useState<ShareRequestDiagnosis[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [code, setCode] = useState('');
  const [desc, setDesc] = useState('');

  const load = useCallback(async () => {
    try {
      setRows(await srDiagnosesService.list(shareRequestId));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [shareRequestId]);

  useEffect(() => { setLoading(true); load(); }, [load]);

  const handleAdd = async () => {
    const trimmed = code.trim();
    if (!ICD10.test(trimmed)) { setError('Enter a valid ICD-10 code (e.g. M17.11 or E119).'); return; }
    try {
      await srDiagnosesService.add(shareRequestId, {
        icd10Code: trimmed,
        description: desc.trim() || undefined,
        isPrimary: rows.length === 0, // first one defaults to primary
      });
      setCode(''); setDesc(''); setAdding(false);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const setPrimary = async (d: ShareRequestDiagnosis) => {
    try { await srDiagnosesService.update(shareRequestId, d.DiagnosisId, { isPrimary: true }); await load(); }
    catch (e) { setError((e as Error).message); }
  };

  const handleDelete = async (d: ShareRequestDiagnosis) => {
    if (!window.confirm(`Remove diagnosis ${d.ICD10Code}?`)) return;
    try { await srDiagnosesService.remove(shareRequestId, d.DiagnosisId); setRows((p) => p.filter((r) => r.DiagnosisId !== d.DiagnosisId)); }
    catch (e) { setError((e as Error).message); }
  };

  return (
    <div className="bg-white rounded-lg border border-gray-200">
      <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
          <Stethoscope className="h-4 w-4 text-oe-primary" />
          Diagnoses (ICD-10)
        </h3>
        <button
          type="button"
          onClick={() => setAdding((a) => !a)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-oe-primary hover:bg-oe-dark text-white text-sm font-medium rounded-lg"
        >
          <Plus className="h-4 w-4" />
          Add diagnosis
        </button>
      </div>

      {adding && (
        <div className="px-4 py-3 border-b border-gray-200 bg-gray-50 flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="ICD-10 code"
            className="w-32 px-2 py-1.5 border border-gray-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-transparent"
          />
          <input
            type="text"
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            placeholder="Description (optional)"
            className="flex-1 min-w-[12rem] px-2 py-1.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-transparent"
          />
          <button type="button" onClick={handleAdd} className="px-3 py-1.5 bg-oe-primary hover:bg-oe-dark text-white text-sm font-medium rounded-lg">Add</button>
        </div>
      )}

      {error && <p className="px-4 py-2 text-sm text-red-600 border-b border-gray-100">{error}</p>}

      {loading ? (
        <div className="px-4 py-3 space-y-2"><Skeleton className="h-6 w-full" /><Skeleton className="h-6 w-2/3" /></div>
      ) : rows.length === 0 ? (
        <p className="px-4 py-4 text-sm text-gray-500">No diagnoses logged yet. Add the ICD-10 code(s) from the member's uploaded visit notes / test results.</p>
      ) : (
        <ul>
          {rows.map((d) => (
            <li key={d.DiagnosisId} className="px-4 py-2.5 flex items-center gap-3 border-b border-gray-100 last:border-b-0">
              <button
                type="button"
                onClick={() => setPrimary(d)}
                title={d.IsPrimary ? 'Primary diagnosis' : 'Mark as primary'}
                className={`p-1 rounded ${d.IsPrimary ? 'text-amber-500' : 'text-gray-300 hover:text-amber-400'}`}
              >
                <Star className={`h-4 w-4 ${d.IsPrimary ? 'fill-amber-500' : ''}`} />
              </button>
              <span className="text-sm font-medium font-mono text-gray-900">{d.ICD10Code}</span>
              <span className="text-sm text-gray-600 truncate flex-1">{d.Description || ''}</span>
              <button type="button" onClick={() => handleDelete(d)} title="Remove diagnosis" className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded">
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default DiagnosisList;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `sudo docker exec allaboard365-frontend npx vitest run src/components/vendor/share-requests/__tests__/DiagnosisList.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/vendor/share-requests/DiagnosisList.tsx frontend/src/components/vendor/share-requests/__tests__/DiagnosisList.test.tsx
git commit -m "feat(sr-coding): DiagnosisList ICD-10 management component"
```

### Task 11: `CodingSection` + wire into RequestDetailsTab; remove legacy fields

**Files:**
- Create: `frontend/src/components/vendor/share-requests/CodingSection.tsx`
- Modify: `frontend/src/components/vendor/share-requests/tabs/RequestDetailsTab.tsx`

- [ ] **Step 1: Implement `CodingSection`**

```tsx
// frontend/src/components/vendor/share-requests/CodingSection.tsx
// Coding & crosswalk: diagnoses (ICD-10) beside procedures (CPT + Medicare
// pricing) so the care team can crosswalk a diagnosis against a procedure when
// auditing eligibility. Both lists manage themselves via their own endpoints.
import DiagnosisList from './DiagnosisList';
import ProcedurePricingSection from '../pricing/ProcedurePricingSection';

interface CodingSectionProps {
  shareRequestId: string;
}

const CodingSection = ({ shareRequestId }: CodingSectionProps) => (
  <section className="space-y-4">
    <h3 className="text-sm font-semibold text-gray-900">Coding &amp; crosswalk</h3>
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
      <DiagnosisList shareRequestId={shareRequestId} />
      <ProcedurePricingSection shareRequestId={shareRequestId} embedded />
    </div>
  </section>
);

export default CodingSection;
```

- [ ] **Step 2: Make `ProcedurePricingSection` accept an `embedded` prop (drop its outer page padding when embedded)**

In `frontend/src/components/vendor/pricing/ProcedurePricingSection.tsx`:

Change the props interface (16-18):
```tsx
interface ProcedurePricingSectionProps {
  shareRequestId: string;
}
```
to:
```tsx
interface ProcedurePricingSectionProps {
  shareRequestId: string;
  /** When true, drop the standalone page padding (used inside the Coding grid). */
  embedded?: boolean;
}
```
Change the signature (28):
```tsx
const ProcedurePricingSection = ({ shareRequestId }: ProcedurePricingSectionProps) => {
```
to:
```tsx
const ProcedurePricingSection = ({ shareRequestId, embedded = false }: ProcedurePricingSectionProps) => {
```
Change the outer wrapper (99):
```tsx
    <div className="px-4 sm:px-6 pt-4 shrink-0">
```
to:
```tsx
    <div className={embedded ? '' : 'px-4 sm:px-6 pt-4 shrink-0'}>
```

- [ ] **Step 3: In `RequestDetailsTab.tsx`, remove `subType` from the form**

- In `EditForm` (34-35) delete `subType: string;`.
- In `toForm` (87) delete `subType: r.SubType ?? '',`.
- In `handleSave` (167) delete `subType: form.subType || null,`.
- In the Classification card, delete the edit `<Field label="Sub-type">…</Field>` block (292-301) and the read `<ReadField label="Sub-type" value={request.SubType} />` line (306).

- [ ] **Step 4: Remove the diagnosis fields from the form + Service card**

- In `EditForm` (38-39) delete `diagnosisCode: string;` and `diagnosisDescription: string;`.
- In `toForm` (90-91) delete `diagnosisCode: r.DiagnosisCode ?? '',` and `diagnosisDescription: r.DiagnosisDescription ?? '',`.
- In `handleSave` (170-171) delete `diagnosisCode` and `diagnosisDescription` keys.
- In the Service card edit branch, delete the two `<Field label="Diagnosis code">…` (345-352) and `<Field label="Diagnosis">…` (353-360) blocks.
- In the Service card read branch, delete `<ReadField label="Diagnosis code" value={request.DiagnosisCode} />` (366) and `<ReadField label="Diagnosis" value={request.DiagnosisDescription} />` (367).

- [ ] **Step 5: Render `<CodingSection>` below the card grid**

Add the import near the other imports:
```tsx
import CodingSection from '../CodingSection';
```
Immediately after the closing `</div>` of the card grid (line 598, the `{/* System-data card grid */}` block) and before the member-direct-deposit block, insert:
```tsx
      {/* Coding & crosswalk — diagnoses (ICD-10) + procedures (CPT) */}
      <CodingSection shareRequestId={shareRequestId} />
```

- [ ] **Step 6: Type-check + lint**

Run: `sudo docker exec allaboard365-frontend npx tsc --noEmit && sudo docker exec allaboard365-frontend npx eslint src/components/vendor/share-requests/tabs/RequestDetailsTab.tsx src/components/vendor/share-requests/CodingSection.tsx`
Expected: no errors referencing `SubType`/`DiagnosisCode`/`DiagnosisDescription`.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/vendor/share-requests/CodingSection.tsx frontend/src/components/vendor/pricing/ProcedurePricingSection.tsx frontend/src/components/vendor/share-requests/tabs/RequestDetailsTab.tsx
git commit -m "feat(sr-coding): Coding section in Request Details; drop Sub-type + singular diagnosis fields"
```

### Task 12: Remove the relocated pricing section from Finances

**Files:**
- Modify: `frontend/src/components/vendor/share-requests/tabs/FinancesTab.tsx`

- [ ] **Step 1: Remove the import and the usage**

Delete the import (10):
```tsx
import ProcedurePricingSection from '../../pricing/ProcedurePricingSection';
```
Delete the render block (74-75):
```tsx
      {/* Procedure CPT codes + Medicare-anchored target negotiation ranges. */}
      <ProcedurePricingSection shareRequestId={shareRequestId} />
```

- [ ] **Step 2: Type-check + lint**

Run: `sudo docker exec allaboard365-frontend npx tsc --noEmit && sudo docker exec allaboard365-frontend npx eslint src/components/vendor/share-requests/tabs/FinancesTab.tsx`
Expected: clean (no unused-import error).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/vendor/share-requests/tabs/FinancesTab.tsx
git commit -m "feat(sr-coding): move procedure pricing out of Finances (now in Request Details Coding)"
```

---

## Phase 4 — Full verification

### Task 13: Run the suites + manual outcome check

- [ ] **Step 1: Backend tests**

Run: `sudo docker exec allaboard365-backend npx jest services/__tests__/shareRequestCoding.service.test.js`
Expected: PASS (all describe blocks).

- [ ] **Step 2: Frontend tests + typecheck + lint**

Run:
```
sudo docker exec allaboard365-frontend npx vitest run src/services/__tests__/sr-diagnoses.service.test.ts src/components/vendor/share-requests/__tests__/DiagnosisList.test.tsx
sudo docker exec allaboard365-frontend npx tsc --noEmit
sudo docker exec allaboard365-frontend npx eslint src/components/vendor/share-requests src/services/sr-diagnoses.service.ts
```
Expected: PASS / clean.

- [ ] **Step 3: Manual outcome matrix (spec Verification plan)**

Confirm in a running app (vendor login, open a share request → Request Details):
- Coding section shows **Diagnoses (ICD-10)** beside **Procedure Pricing (CPT)**.
- Add an ICD-10 code → appears, first is starred Primary; star another → primary moves; delete works.
- Add a CPT code → prices it (Medicare total + target range); same code visible because Finances no longer hosts it.
- Classification card has **no Sub-type**; Service card has **no diagnosis** fields.
- Finances tab shows stats + Bills/Ledger only (no pricing section), no console errors.

- [ ] **Step 4: Factory verify + migration log**

Run: `./ai_scripts/factory-verify-changed.sh`
Then ensure the PR description logs **both** SQL migrations (backfill + drop) for prod application per `feedback_db_migration_tracking`, noting the drop runs only after the backfill + this deploy are verified in prod.

---

## Self-Review (completed by plan author)

- **Spec coverage:** child tables as source of truth (Tasks 3-6, 8-11); retire SubType/diagnosis/RequestType (Tasks 1, 3-5, 8, 11); backfill (Task 1); phased drop (Task 2); detail embed (Task 6, 8); mapper fix (Task 7); Coding section + crosswalk (Tasks 10-11); ICD manual entry (Tasks 9-10); Finances adjust (Task 12); migrations logged (Task 13). All covered.
- **Correction vs spec:** diagnosis CRUD already exists (service + routes) — no backend CRUD task; spec updated to match.
- **Type consistency:** `srDiagnosesService.{list,add,update,remove}` used identically in service, tests, and `DiagnosisList`. `ShareRequestProcedure` unified to the cptPricing type. `embedded?` prop added where `CodingSection` passes it.
- **Placeholder scan:** none — every code step shows the code; every command shows expected output.
