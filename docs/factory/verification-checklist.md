# Factory verification checklist

Mandatory reference for **spec-writer**, **backend-builder**, **test-verifier**, and **implementation-validator**. Goal: prove the **expected result** is achieved — not just that code compiles.

Lessons from real misses (agent tenant migration, commission codes):
- Wrong column names on prod (`Agencies.Name` → `AgencyName`, `Enrollments.TenantId` absent)
- Wrong `sql` import (`database.js` exports **SqlTypes only**; `Transaction`/`Request` need `require('mssql')` or `rawSql`)
- **Preview** path tested but **execute** path never run (different SQL, transactions, imports)
- Mock tests that return `{ ok: 0 }` for `tableHasColumn` treated as “column exists”

---

## 1. Before build (spec-writer)

Every technical brief **must** include a **Verification plan** section:

| Item | Required detail |
|------|-----------------|
| User-visible outcomes | What Jeremy sees when it works (UI labels, API JSON fields, error messages) |
| Code paths | List every route/handler (e.g. `preview` **and** `execute`, not just one) |
| Prod schema assumptions | Tables/columns used; note if optional (`tableHasColumn` or join fallback) |
| SQL import pattern | Transactions → `require('mssql')`; types from `database` or same module |
| Manual QA (if any) | Steps that cannot run in mocked CI |

---

## 2. During build (backend-builder)

### SQL / schema

- **Never assume column names.** Confirm via existing queries in codebase or read-only `db-query.sh --prod-readonly` against `sys.columns`.
- Common prod names: `Agencies.AgencyName` (not `Name`), `Tenants.Name`, `Products.Name`.
- **`oe.Enrollments` has no `TenantId` on prod** — scope via `Members.TenantId` or probe with `tableHasColumn`.
- Optional columns: use `tableHasColumn(pool, table, column)`; treat empty recordset as false, `ok === 1` as true.

### Imports

```javascript
// WRONG for transactions:
const { getPool, sql } = require('../config/database');
new sql.Transaction(pool); // sql is SqlTypes only → TypeError

// RIGHT:
const { getPool } = require('../config/database');
const sql = require('mssql');
```

### Multi-step features

- If there is **preview + execute**, **commit**, **send**, **publish**, etc. — implement and test **each** path.
- Route-level tests should hit the same entrypoints the UI uses.

### Tests (minimum per feature)

| Case | Required |
|------|----------|
| Happy path | Yes |
| Validation / 400 | Yes |
| Auth / 403 | Yes when roles matter |
| Not found | Yes |
| **SQL shape** | Assert generated SQL uses correct column names (capture `query()` args in mocks) |
| **Import regression** | If file uses `sql.Transaction`, assert `require('mssql')` pattern (see factory test helper) |

---

## 3. Acceptance tests (test-verifier)

For **each acceptance criterion**, report:

1. **Test file + name**
2. **PASS / FAIL**
3. **Which code path** (preview vs execute, GET vs POST, etc.)

### Mandatory backend checks (when `backend/` changed)

Run:

```bash
./ai_scripts/factory-verify-changed.sh
```

Fix or document any **FAIL** before marking criteria covered.

### Test types to add when applicable

| Pattern | Test approach |
|---------|----------------|
| Multi-endpoint flow | One test file per route; mock pool + `mssql.Transaction` for execute |
| Dynamic schema | Mock `tableHasColumn`: `[]` = missing, `[{ ok: 1 }]` = present |
| SQL column names | Join `_sqlCalls` from mocks; assert `AgencyName`, reject `SELECT AgencyId, Name FROM oe.Agencies` |
| Tenant isolation | Assert queries include `TenantId` / member context |
| Public onboarding | Reject invalid state (orphan tiers, inactive codes) |

### Cannot mock in CI

Mark criterion **Not coverable in CI** + give **manual QA steps** (read-only prod OK for verification, never writes).

---

## 4. Final validation (implementation-validator)

Run **all** of:

```bash
./ai_scripts/factory-verify-changed.sh
cd backend && npx jest --testPathPattern="<feature>"
cd frontend && npx vitest run   # if frontend changed
cd frontend && npx tsc --noEmit # if TS changed
```

### Outcome verification (not checkbox theater)

For each acceptance criterion, answer:

- **Implemented?** (file:line)
- **Tested?** (test name)
- **Expected result achievable?** (describe what user sees; flag if only preview tested)

### Factory-specific failure categories

| Category | Example | Severity |
|----------|---------|----------|
| Schema mismatch | `e.TenantId` on Enrollments | CRITICAL |
| Wrong sql import | `sql.Transaction` with database sql | CRITICAL |
| Path not tested | execute never covered | CRITICAL |
| Wrong display data | tier label fallback vs tenant name | IMPORTANT |
| Missing dry-run SQL | migration without `@DryRun = 1` | CRITICAL |

---

## 5. Orchestrator (feature-factory)

- Steps 6–7 are **blocking** — no “done” without verifier + validator reports attached.
- If validator finds CRITICAL gaps, route to builder → re-run test-verifier → re-run validator.
- Attach `factory-verify-changed.sh` output to final summary.

---

## 6. Quick reference: database.js exports

```javascript
const { getPool, sql, rawSql } = require('../config/database');
// sql  → SqlTypes (UniqueIdentifier, NVarChar, …) ONLY
// rawSql / require('mssql') → Transaction, Request, full module
```
