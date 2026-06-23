# Vendor SFTP Scheduled Import — Feature Plan

**Feature:** `vendor-sftp-import`
**Scope:** `admin-web` (vendor portal "Import" tab) + a new Node Azure Functions app
**Status:** Approved story + technical spec — ready for backend/frontend build
**Date:** 2026-06-02
**Pipeline:** feature-factory (researcher → story → spec captured here; builders/test/validate pending)

---

## 1. Summary

Add an SFTP auto-import automation layer on top of the existing manual CSV import in the vendor
portal "Import" tab. A VendorAdmin can configure reusable SFTP connections and recurring import
jobs. On a schedule, the system pulls CSV files from the configured SFTP folder, imports them into
the target tenant using the **existing** eligibility import/format-template logic, archives processed
files into an archive folder (default `archived`) on the same SFTP server, records per-run and
per-file results, and emails success/failure reports to configured recipients. A run-history UI shows
results as they happen.

This imitates the orchestration of the Python `sharewell-csv-processor` but reuses this repo's
existing import logic. No hardcoded file formats — the existing customizable format templates are used.

---

## 2. Locked Decisions

| # | Decision |
|---|----------|
| Scope | admin-web only (vendor portal Import tab). No member-web / mobile / TenantAdmin / SysAdmin surfaces. |
| Job runtime | New Node Azure Functions app (`sftp-import-job/`) mirroring `vendor-jobs/`. Thin timer only. |
| SFTP I/O location | **Backend** owns SFTP connect/list/download/import/archive. Functions app only POSTs to the trigger. |
| Run Now on disabled job | Allowed as a one-off; does not permanently enable the job. |
| Dedup / archive collision | Track by filename; on archive-folder name collision, append a timestamp suffix. |
| Missing sub-folder at run time | Treat as "no files found" (soft, no error). |
| Notify on no files | Optional per-job toggle, default off. |
| Private-key passphrase | Supported, encrypted at rest. |
| Concurrent run | Schedule fires while previous run in progress → skip silently + log `skipped`. |
| Schedules | Stored and evaluated in UTC; UI labels times as UTC. |
| File download | In-memory Buffer (matches manual upload); streaming-to-temp deferred unless feeds are very large. |

---

## 3. Research Findings (reuse references)

- **Manual import UI:** `frontend/src/components/vendor/import/VendorImportPanel.tsx` (tab switcher),
  `VendorImportMembersWizard.tsx`, `VendorImportFormatsPanel.tsx`. Entry page
  `frontend/src/pages/vendor/VendorImportPage.tsx`. Nav guard `frontend/src/components/vendor/VendorNavigation.tsx`.
- **Backend import routes:** `backend/routes/me/vendor/import.js` — uses `authenticate` +
  `authorize(['VendorAdmin'])`, resolves vendor via `getVendorId(req)`.
- **CORE reusable import logic:** `backend/services/eligibilityImportService.js`
  (`parseEligibilityTemplateColumns()`, `importHouseholdsCsv()` — builder to reconcile the exact
  exported entry point). Template engine `backend/utils/eligibilityRowTemplate.js` (slug-based presets
  + custom). Pricing `backend/utils/vendorImportPricingKey.js`, `backend/services/pricing/TierCalculator.js`.
- **Tenant eligibility for vendor:** `backend/services/vendorImportTenants.service.js`
  (`assertTenantEligibleForVendorImport`).
- **Encryption at rest:** `backend/services/encryptionService.js` (AES-256-GCM, `ENCRYPTION_KEY` env).
- **Email:** `backend/services/sendGridEmailService.js`. Example summary email:
  `backend/services/billingAuditDailyReportEmail.js`.
- **Scheduled-job auth:** backend validates `x-api-key: SCHEDULED_JOB_API_KEY`. Thin Azure Functions
  template: `vendor-jobs/VendorExportScheduler/index.js` + `function.json` + `host.json` + deploy scripts.
  Sync script `ai_scripts/sync-scheduled-job-api-keys.sh`; docs `docs/billing/scheduled-job-monitoring.md`.
- **DB conventions:** `oe.` schema, snake_case tables, `TenantId`/`VendorId` scoping, migrations in
  `sql-changes/` with `@DryRun BIT = 1` default + SELECT preview. Example:
  `sql-changes/2026-06-02-agent-import-batch-schema.sql`.
- **Prod gotchas (CLAUDE.md):** `database.sql` = SqlTypes only (use `require('mssql')` for `Transaction`);
  `Agencies.AgencyName`; `Enrollments` often has no `TenantId`.
- **No existing SFTP usage** — `ssh2-sftp-client` dependency required.

---

## 4. User Story

> **As a VendorAdmin, I want to configure SFTP connections and recurring import jobs within the Import
> tab, so that CSV member files are automatically pulled from my SFTP server on a schedule, imported
> into the correct tenant using the existing format templates, archived after processing, and reported
> to me by email — without me needing to manually upload files.**

### Acceptance Criteria

**SFTP Connection Management**
1. Create a connection: host, port (default 22), username, auth method (password OR private key),
   optional base directory; scoped to VendorId; credentials encrypted at rest.
2. Test a connection before saving (connect + list base dir); show success or specific error; nothing
   persisted until explicit save.
3. Edit a connection; re-entering a credential replaces it, blank retains existing encrypted value.
4. Delete a connection; warn if jobs reference it; on delete those jobs are disabled + flagged.
5. Vendor isolation — each VendorAdmin sees only their own connections.

**Import Job Management**
6. Create a job binding: connection, optional sub-folder, target tenant (vendor-owned only), format
   template slug, cron/interval schedule (UTC), archive folder name (default `archived`), 1+ notify
   emails, notify-on-success/failure/no-files prefs. Saved disabled by default.
7. Enable/disable a job; scheduler honors the flag.
8. Edit a job; subsequent runs use new config; prior run history preserved.
9. Delete a job; SFTP connection not deleted.
10. Target tenant selection limited to tenants owned by the vendor.

**Automated Scheduled Execution**
11. Happy path: timer fires → backend connects to SFTP → lists files (base + sub-folder) → imports each
    via existing logic → archives each on success → records run with counts + status.
12. Archive folder auto-created if missing.
13. No files found → run recorded as `no-files`, zero counts, no error email (unless notify-on-no-files).
14. Duplicate / already-archived filename reappears → processed normally; archive move succeeds
    (timestamp suffix on collision).
15. Malformed CSV / partial failure → valid rows imported, file archived, run = `partial` with row errors.
16. Completely unparseable file → NOT archived (left for inspection), file-level failure recorded,
    failure email if configured.
17. Archive-move failure → recorded separately from import result; file not re-imported next run; warning
    in report.
18. SFTP connection failure at run time → run = `connection failed`, no files processed, failure email if
    configured, job stays enabled.
19. Concurrent run → detect in-progress run, skip/defer, log `skipped`, no notification.
20. Trigger endpoint without valid `x-api-key` → 401, no run.

**Run History / Report UI**
21. View run history for owned jobs: job name, tenant, start (UTC), status, counts; filter by job/status/date.
22. Per-file details within a run: filename, status, counts, row-level errors, archive path.
23. In-progress runs visible as `running` with updating partial counts.
24. Empty state when a job has never run.

**On-Demand Trigger**
25. Run Now triggers an immediate run; appears in history; next scheduled time unaffected.
26. Run Now allowed on a disabled job (one-off, does not enable permanently).

**Email Notifications**
27. Success email (when enabled): job, tenant, run time, files processed, household counts.
28. Failure email (when enabled): each failure + error message + file name.
29. Invalid notification email → field-level validation error; job not persisted.
30. Email delivery failure → noted on run record; import result unaffected.

### Out of Scope
Per-tenant timezone scheduling (UTC only), blob/cold-storage archival of run history, member-web /
mobile / TenantAdmin / SysAdmin surfaces, changes to the existing manual upload wizard, replacing the
Python `sharewell-csv-processor`, PGP/GPG decryption, non-SFTP sources, real-time streaming progress
(polling acceptable), per-file retry controls.

---

## 5. Architecture Decision — SFTP I/O Location

**SFTP connect / list / download / archive runs entirely inside `backend/`.** The `sftp-import-job/`
Azure Functions app is a thin timer that only POSTs to `/api/scheduled-jobs/sftp-import` with `x-api-key`.

Justification: keeps `ENCRYPTION_KEY` + decryption in the backend process only; reuses
`eligibilityImportService` in-process (no extra HTTP hop / failure mode); matches the existing
`vendor-jobs/` and `billing-nightly-job/` pattern; single secret to manage. The backend uses
`cron-parser` to decide which enabled jobs are actually due on each 5-minute tick.

---

## 6. Data Model

**Migration:** `sql-changes/2026-06-03-vendor-sftp-import-schema.sql` — `DECLARE @DryRun BIT = 1` with
SELECT preview + `ROLLBACK` on dry run / `COMMIT` on execute.

### `oe.VendorSftpConnections`
```sql
CREATE TABLE oe.VendorSftpConnections (
  ConnectionId    UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_VendorSftpConnections PRIMARY KEY DEFAULT NEWID(),
  VendorId        UNIQUEIDENTIFIER NOT NULL,
  DisplayName     NVARCHAR(150)    NOT NULL,
  Host            NVARCHAR(255)    NOT NULL,
  Port            INT              NOT NULL CONSTRAINT DF_VendorSftpConnections_Port DEFAULT 22,
  Username        NVARCHAR(150)    NOT NULL,
  AuthType        NVARCHAR(20)     NOT NULL CONSTRAINT DF_VendorSftpConnections_AuthType DEFAULT 'password',
  PasswordEncrypted     NVARCHAR(MAX) NULL,
  PrivateKeyEncrypted   NVARCHAR(MAX) NULL,
  PassphraseEncrypted   NVARCHAR(MAX) NULL,
  BaseDirectory   NVARCHAR(500)    NULL,
  IsActive        BIT              NOT NULL CONSTRAINT DF_VendorSftpConnections_IsActive DEFAULT 1,
  CreatedBy       UNIQUEIDENTIFIER NULL,
  CreatedUtc      DATETIME2        NOT NULL CONSTRAINT DF_VendorSftpConnections_CreatedUtc DEFAULT SYSUTCDATETIME(),
  ModifiedUtc     DATETIME2        NOT NULL CONSTRAINT DF_VendorSftpConnections_ModifiedUtc DEFAULT SYSUTCDATETIME()
);
CREATE INDEX IX_VendorSftpConnections_VendorId ON oe.VendorSftpConnections (VendorId, IsActive);
```
Encrypted fields: `PasswordEncrypted`, `PrivateKeyEncrypted`, `PassphraseEncrypted`. Never returned to
client — GET substitutes `hasPassword` / `hasPrivateKey` / `hasPassphrase` booleans.

### `oe.VendorImportJobs`
```sql
CREATE TABLE oe.VendorImportJobs (
  JobId           UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_VendorImportJobs PRIMARY KEY DEFAULT NEWID(),
  VendorId        UNIQUEIDENTIFIER NOT NULL,
  ConnectionId    UNIQUEIDENTIFIER NOT NULL,
  TenantId        UNIQUEIDENTIFIER NOT NULL,
  SubFolderPath   NVARCHAR(500)    NULL,
  FormatSlug      NVARCHAR(50)     NOT NULL,
  CronScheduleUtc NVARCHAR(100)    NOT NULL,
  ArchiveFolder   NVARCHAR(255)    NOT NULL CONSTRAINT DF_VendorImportJobs_ArchiveFolder DEFAULT 'archived',
  NotifyEmails    NVARCHAR(MAX)    NOT NULL,
  NotifyOnSuccess BIT              NOT NULL CONSTRAINT DF_VendorImportJobs_NotifyOnSuccess DEFAULT 1,
  NotifyOnFailure BIT              NOT NULL CONSTRAINT DF_VendorImportJobs_NotifyOnFailure DEFAULT 1,
  NotifyOnNoFiles BIT              NOT NULL CONSTRAINT DF_VendorImportJobs_NotifyOnNoFiles DEFAULT 0,
  LegacyProcessorKey NVARCHAR(80)    NULL,              -- sharewell-csv-processor function name; idempotent seed key
  IsEnabled       BIT              NOT NULL CONSTRAINT DF_VendorImportJobs_IsEnabled DEFAULT 0,
  IsRunning       BIT              NOT NULL CONSTRAINT DF_VendorImportJobs_IsRunning DEFAULT 0,
  LastRunAtUtc    DATETIME2        NULL,
  CreatedBy       UNIQUEIDENTIFIER NULL,
  CreatedUtc      DATETIME2        NOT NULL CONSTRAINT DF_VendorImportJobs_CreatedUtc DEFAULT SYSUTCDATETIME(),
  ModifiedUtc     DATETIME2        NOT NULL CONSTRAINT DF_VendorImportJobs_ModifiedUtc DEFAULT SYSUTCDATETIME()
);
CREATE INDEX IX_VendorImportJobs_VendorId  ON oe.VendorImportJobs (VendorId, IsEnabled);
CREATE INDEX IX_VendorImportJobs_TenantId  ON oe.VendorImportJobs (TenantId);
CREATE INDEX IX_VendorImportJobs_IsEnabled ON oe.VendorImportJobs (IsEnabled, LastRunAtUtc);
CREATE UNIQUE INDEX UX_VendorImportJobs_VendorLegacyKey
  ON oe.VendorImportJobs (VendorId, LegacyProcessorKey)
  WHERE LegacyProcessorKey IS NOT NULL;
```
`IsRunning` is the concurrency lock. `IsEnabled = 0` by default (enforced in service).
`LegacyProcessorKey` maps 1:1 to a `sharewell-csv-processor` timer function for cutover seeding.

### `oe.VendorImportJobRuns`
```sql
CREATE TABLE oe.VendorImportJobRuns (
  RunId           UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_VendorImportJobRuns PRIMARY KEY DEFAULT NEWID(),
  JobId           UNIQUEIDENTIFIER NOT NULL,
  VendorId        UNIQUEIDENTIFIER NOT NULL,
  TenantId        UNIQUEIDENTIFIER NOT NULL,
  TriggerType     NVARCHAR(20)     NOT NULL,
  Status          NVARCHAR(20)     NOT NULL,  -- running|success|partial|failed|no-files|skipped
  FilesFound      INT NOT NULL CONSTRAINT DF_VendorImportJobRuns_FilesFound DEFAULT 0,
  FilesImported   INT NOT NULL CONSTRAINT DF_VendorImportJobRuns_FilesImported DEFAULT 0,
  FilesFailed     INT NOT NULL CONSTRAINT DF_VendorImportJobRuns_FilesFailed DEFAULT 0,
  HouseholdsCreated    INT NOT NULL CONSTRAINT DF_VendorImportJobRuns_HHCreated DEFAULT 0,
  HouseholdsUpdated    INT NOT NULL CONSTRAINT DF_VendorImportJobRuns_HHUpdated DEFAULT 0,
  HouseholdsTerminated INT NOT NULL CONSTRAINT DF_VendorImportJobRuns_HHTerm DEFAULT 0,
  HouseholdsSkipped    INT NOT NULL CONSTRAINT DF_VendorImportJobRuns_HHSkipped DEFAULT 0,
  ErrorSummary    NVARCHAR(MAX)    NULL,
  StartedUtc      DATETIME2        NOT NULL CONSTRAINT DF_VendorImportJobRuns_StartedUtc DEFAULT SYSUTCDATETIME(),
  CompletedUtc    DATETIME2        NULL
);
CREATE INDEX IX_VendorImportJobRuns_JobId    ON oe.VendorImportJobRuns (JobId, StartedUtc DESC);
CREATE INDEX IX_VendorImportJobRuns_VendorId ON oe.VendorImportJobRuns (VendorId, StartedUtc DESC);
CREATE INDEX IX_VendorImportJobRuns_Status   ON oe.VendorImportJobRuns (Status, StartedUtc DESC);
```

### `oe.VendorImportJobRunFiles`
```sql
CREATE TABLE oe.VendorImportJobRunFiles (
  FileId            UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_VendorImportJobRunFiles PRIMARY KEY DEFAULT NEWID(),
  RunId             UNIQUEIDENTIFIER NOT NULL,
  JobId             UNIQUEIDENTIFIER NOT NULL,
  VendorId          UNIQUEIDENTIFIER NOT NULL,
  FileName          NVARCHAR(500)    NOT NULL,
  RemotePath        NVARCHAR(1000)   NOT NULL,
  Status            NVARCHAR(20)     NOT NULL,  -- success|failed|skipped
  HouseholdsCreated    INT NOT NULL CONSTRAINT DF_VendorImportJobRunFiles_HHCreated DEFAULT 0,
  HouseholdsUpdated    INT NOT NULL CONSTRAINT DF_VendorImportJobRunFiles_HHUpdated DEFAULT 0,
  HouseholdsTerminated INT NOT NULL CONSTRAINT DF_VendorImportJobRunFiles_HHTerm DEFAULT 0,
  HouseholdsSkipped    INT NOT NULL CONSTRAINT DF_VendorImportJobRunFiles_HHSkipped DEFAULT 0,
  RowErrors         NVARCHAR(MAX)    NULL,  -- JSON array of {row, message}
  ArchivePath       NVARCHAR(1000)   NULL,
  ProcessedUtc      DATETIME2        NOT NULL CONSTRAINT DF_VendorImportJobRunFiles_ProcessedUtc DEFAULT SYSUTCDATETIME()
);
CREATE INDEX IX_VendorImportJobRunFiles_RunId ON oe.VendorImportJobRunFiles (RunId, ProcessedUtc);
CREATE INDEX IX_VendorImportJobRunFiles_JobId ON oe.VendorImportJobRunFiles (JobId, ProcessedUtc DESC);
```

---

## 7. Backend

New dependencies (`backend/package.json`): `ssh2-sftp-client` (^10.0.3), `cron-parser` (^4.9.0).

### Services
- **`backend/services/sftpConnectionService.js`** — CRUD for connections; all crypto via
  `encryptionService`; blank credential on edit skips that column; never returns encrypted columns.
  `createConnection`, `listConnections`, `getConnection`, `updateConnection`, `deleteConnection`
  (409 if referenced), `testConnection`, `decryptConnectionCreds` (internal-only).
- **`backend/services/sftpClientWrapper.js`** — wraps `ssh2-sftp-client`; isolates all `ssh2` internals;
  password + privateKey (+ optional passphrase) auth. `connect`, `listCsvFiles` (returns `[]` on ENOENT),
  `downloadFile`, `ensureDirectory`, `archiveFile` (timestamp suffix on collision), `disconnect`.
- **`backend/services/vendorImportJobService.js`** — CRUD for jobs; validates connection same-vendor,
  tenant eligibility (`assertTenantEligibleForVendorImport`), format slug, cron (`cron-parser`); jobs
  created `IsEnabled = 0`. `createJob`, `listJobs`, `getJob`, `updateJob`, `deleteJob` (409 if running),
  `setEnabled`.
- **`backend/services/vendorImportJobRunService.js`** — run records + history queries. `createRun`
  (sets `IsRunning = 1`), `completeRun` (clears `IsRunning`, sets `LastRunAtUtc`), `failRun`, `recordFile`,
  `listRuns` (paginated, filters), `getRunWithFiles`.
- **`backend/services/sftpImportOrchestrator.js`** — core scheduled logic. `runDueJobs` (cron + `IsRunning`
  + `IsEnabled` gate), `runJob` (connect → list → per-file download/import/archive → aggregate → complete →
  email; `try/finally` always clears `IsRunning`), `runJobById` (Run Now; bypasses `IsEnabled`).
- **`backend/services/sftpImportEmailService.js`** — builds + sends HTML report via `sendGridEmailService`,
  honoring `NotifyOnSuccess`/`NotifyOnFailure`/`NotifyOnNoFiles`. Mirror `billingAuditDailyReportEmail.js`.

### Routes
- `backend/routes/me/vendor/sftp-connections.js` — `authenticate` + `authorize(['VendorAdmin'])`.
- `backend/routes/me/vendor/import-jobs.js` — same.
- `backend/routes/me/vendor/import-job-runs.js` — same.
- `backend/routes/scheduled-jobs/sftp-import.js` — `authenticateApiKey` (`x-api-key: SCHEDULED_JOB_API_KEY`).

### `app.js` registration
```js
app.use('/api/me/vendor/sftp-connections', require('./routes/me/vendor/sftp-connections'));
app.use('/api/me/vendor/import-jobs', require('./routes/me/vendor/import-jobs'));
app.use('/api/me/vendor/import-job-runs', require('./routes/me/vendor/import-job-runs'));
app.use('/api/scheduled-jobs/sftp-import', require('./routes/scheduled-jobs/sftp-import'));
```

---

## 8. API Surface

Response shape: `{ success: boolean, data?: any, message?: string }`. Vendor routes:
`authenticate` → `authorize(['VendorAdmin'])` → VendorId from `req.user.VendorId`.

### SFTP Connections
| Method | Path | Body | `data` |
|---|---|---|---|
| GET | `/api/me/vendor/sftp-connections` | — | list (no creds; `has*` booleans) |
| POST | `/api/me/vendor/sftp-connections` | `{ displayName, host, port, username, authType, password?, privateKey?, passphrase?, baseDirectory? }` | created (no creds) |
| GET | `/api/me/vendor/sftp-connections/:connectionId` | — | single (no creds), 404 on mismatch |
| PUT | `/api/me/vendor/sftp-connections/:connectionId` | same as POST; blank creds preserved | updated |
| DELETE | `/api/me/vendor/sftp-connections/:connectionId` | — | 409 if referenced, else 200 |
| POST | `/api/me/vendor/sftp-connections/:connectionId/test` | — | `{ success, latencyMs?, error? }` |

### Import Jobs
| Method | Path | Body | `data` |
|---|---|---|---|
| GET | `/api/me/vendor/import-jobs` | — | list w/ connection name, tenant name, last-run summary |
| POST | `/api/me/vendor/import-jobs` | `{ connectionId, tenantId, subFolderPath?, formatSlug, cronScheduleUtc, archiveFolder?, notifyEmails[], notifyOnSuccess, notifyOnFailure, notifyOnNoFiles }` | created (`IsEnabled=false`) |
| GET | `/api/me/vendor/import-jobs/:jobId` | — | full job |
| PUT | `/api/me/vendor/import-jobs/:jobId` | same fields (optional) | updated |
| DELETE | `/api/me/vendor/import-jobs/:jobId` | — | 409 if running, else 200 |
| PATCH | `/api/me/vendor/import-jobs/:jobId/enable` | `{ enabled }` | `{ IsEnabled }` |
| POST | `/api/me/vendor/import-jobs/:jobId/run-now` | — | `{ runId }` (async, returns immediately) |

### Run History
| Method | Path | Query | `data` |
|---|---|---|---|
| GET | `/api/me/vendor/import-job-runs` | `jobId?, status?, fromDate?, toDate?, page=1, limit=25` | `{ runs[], pagination }` |
| GET | `/api/me/vendor/import-job-runs/:runId` | — | run + `files[]` |

### Scheduled Trigger
| Method | Path | Auth | Body | Response |
|---|---|---|---|---|
| POST | `/api/scheduled-jobs/sftp-import` | `x-api-key` | `{}` | `{ jobsEvaluated, jobsFired, jobsSkipped }` |

---

## 9. Frontend

**Modify:** `frontend/src/components/vendor/import/VendorImportPanel.tsx` — add tabs
`'sftp-connections'` (Lucide `Server`) and `'scheduled-imports'` (Lucide `CalendarClock`).

**New components** (`frontend/src/components/vendor/import/`):
- `VendorSftpConnectionsManager.tsx` — connections table + Add/Edit/Delete/Test.
- `VendorSftpConnectionModal.tsx` — create/edit form; conditional password/privateKey + passphrase;
  on edit credential placeholder `••••••••` (blank retains); "Test Connection" button.
- `VendorScheduledImportsManager.tsx` — jobs table (schedule, enabled toggle, last-run badge, Run Now,
  Edit, Delete) + Run History sub-panel.
- `VendorImportJobModal.tsx` — create/edit job; connection dropdown, sub-folder, target tenant dropdown
  (`/api/me/vendor/import/tenants`), format slug dropdown (`/api/me/vendor/import/format-presets`), cron
  input w/ UTC label + human-readable preview, archive folder (default `archived`), notify email
  tag-input, notify toggles. Footer: "Jobs are created disabled. Enable after saving."
- `VendorImportRunHistory.tsx` — filterable list, expandable per-file detail, status badges, empty
  state, 5s polling while any run is `running`.

**New service:** `frontend/src/services/vendorSftpImport.service.ts` (uses `apiClient`).

**New hooks** (`frontend/src/hooks/vendor/`): `useVendorSftpConnections.ts`, `useVendorImportJobs.ts`,
`useVendorImportJobRuns.ts` (refetchInterval 5000 only while a run is `running`).

**New types:** `frontend/src/types/vendor/vendorSftpImport.types.ts` (`SftpConnection`, `ImportJob`,
`ImportJobRun`, `ImportJobRunFile`).

UI rules: Tailwind + Lucide + `oe-primary`/`oe-dark` brand colors only; clean, uncluttered layout.

---

## 10. Azure Functions App

**New folder `sftp-import-job/`** mirroring `vendor-jobs/`:
- `SftpImportScheduler/function.json` — timer `0 */5 * * * *`, `runOnStartup: false`.
- `SftpImportScheduler/index.js` — reads `SFTP_IMPORT_ENDPOINT_URL` + `SCHEDULED_JOB_API_KEY`, POSTs `{}`,
  logs result. No SFTP / no creds / no DB.
- `host.json` — copy from `vendor-jobs/`, `functionTimeout: "00:10:00"`.
- `package.json` — `allaboard-sftp-import-job`, no runtime deps.
- `local.settings.json.example`, `deploy.sh`, `create-and-deploy.sh` (copied + renamed), `.gitignore`.

**Updates:**
- `ai_scripts/sync-scheduled-job-api-keys.sh` — add `allaboard-sftp-import-job`.
- `docs/billing/scheduled-job-monitoring.md` — add the app + stuck-`IsRunning` remediation note
  (`UPDATE oe.VendorImportJobs SET IsRunning = 0 WHERE IsRunning = 1`).

---

## 11. Security / Tenant Isolation

| Concern | Enforcement |
|---|---|
| VendorId scoping | Every query `WHERE VendorId = @vendorId` from JWT; 404 on mismatch (no info leak). |
| Connection FK | `ConnectionId` validated to same VendorId before job insert. |
| Target tenant | `assertTenantEligibleForVendorImport(vendorId, tenantId)` on job create/update. |
| Credential encryption | `encryptionService.encrypt()` before write; `decryptConnectionCreds` internal-only; GET returns `has*` booleans. |
| ENCRYPTION_KEY | Backend App Service only; absent from the Functions app. |
| Trigger auth | `authenticateApiKey` validates `x-api-key`. |
| Run Now on disabled | `isEnabled` is a scheduling gate, not a security gate; auth + ownership still required. |
| Concurrency | Atomic `UPDATE ... WHERE IsRunning = 0; IF @@ROWCOUNT = 0 → skip` + `skipped` run record. |

---

## 12. Edge Case Map

| Edge case | Handling |
|---|---|
| Sub-folder missing | `listCsvFiles` returns `[]` on ENOENT → `no-files`. |
| Archive folder missing | `ensureDirectory` auto-creates. |
| Archive name collision | append `_YYYYMMDDTHHMMSS` suffix. |
| Concurrent fire | atomic `IsRunning` guard → `skipped` record, no SFTP call. |
| Run Now on disabled | allowed; `triggerType='manual'`; no enable. |
| Blank credential on edit | omit column from UPDATE; preserve encrypted value. |
| Private key, no passphrase | `PassphraseEncrypted` NULL. |
| Partial file failure | per-file `failed`; others continue; run `partial`. |
| Unparseable file | not archived (left in place); file-level failure recorded. |
| Delete connection w/ jobs | 409 with count message. |
| Delete running job | 409. |
| Invalid cron | 400 on create/update. |
| SendGrid down | catch + log; run status reflects import only. |
| SFTP connect timeout | 30s `Promise.race`; run `failed` with timeout error. |

---

## 13. Tests

### Backend Jest (mock SFTP client, DB pool, SendGrid)
- `backend/services/__tests__/sftpConnectionService.test.js` — encrypt on create; GET hides creds;
  blank-password edit preserves; test connect success/fail; delete 409 when referenced; VendorId
  mismatch 404.
- `backend/services/__tests__/vendorImportJobService.test.js` — `IsEnabled=0` default; reject cross-vendor
  connection; reject ineligible tenant; reject invalid cron; enable/disable; update preserves runs.
- `backend/services/__tests__/sftpImportOrchestrator.test.js` — due-job selection; concurrency skip;
  no-files path; partial failure; archive collision suffix; decrypted creds passed (never logged);
  notify-prefs honored.
- `backend/routes/__tests__/sftp-connections.test.js` — 401 no JWT; 403 non-vendor; CRUD; test response shape.
- `backend/routes/__tests__/sftp-import-trigger.test.js` — 401 missing/wrong key; 200 valid key →
  `runDueJobs()`.

### Frontend Vitest
- `VendorSftpConnectionsManager.test.tsx` — list + auth badge; Add opens modal; Test inline result.
- `VendorSftpConnectionModal.test.tsx` — create submit; edit empty-password sends `undefined`; Test
  disabled until host+username.
- `VendorImportRunHistory.test.tsx` — status badges; running → spinner + polling; empty state; expandable files.
- `useVendorImportJobRuns.test.ts` — `refetchInterval` 5000 while running, `false` otherwise.

---

## 14. Verification Plan (acceptance → impl → test)

See spec matrix; every criterion maps to an implementation location and a test (or documented manual QA),
covering both config/preview and execute paths. Final gate: `./ai_scripts/factory-verify-changed.sh`
(no bare `sql` import, `Agencies.AgencyName`, vendor routes use `authorize(['VendorAdmin'])`, no raw
Tailwind `blue-*`).

---

## 15. Files to Create / Modify

### Create
```
sql-changes/2026-06-03-vendor-sftp-import-schema.sql
sql-changes/2026-06-03-vendor-sftp-import-sharewell-cutover-seed.sql

backend/services/sftpConnectionService.js
backend/services/sftpClientWrapper.js
backend/services/vendorImportJobService.js
backend/services/vendorImportJobRunService.js
backend/services/sftpImportOrchestrator.js
backend/services/sftpImportEmailService.js
backend/routes/me/vendor/sftp-connections.js
backend/routes/me/vendor/import-jobs.js
backend/routes/me/vendor/import-job-runs.js
backend/routes/scheduled-jobs/sftp-import.js
backend/services/__tests__/sftpConnectionService.test.js
backend/services/__tests__/vendorImportJobService.test.js
backend/services/__tests__/sftpImportOrchestrator.test.js
backend/routes/__tests__/sftp-connections.test.js
backend/routes/__tests__/sftp-import-trigger.test.js

sftp-import-job/SftpImportScheduler/index.js
sftp-import-job/SftpImportScheduler/function.json
sftp-import-job/host.json
sftp-import-job/package.json
sftp-import-job/local.settings.json.example
sftp-import-job/deploy.sh
sftp-import-job/create-and-deploy.sh
sftp-import-job/.gitignore

frontend/src/services/vendorSftpImport.service.ts
frontend/src/types/vendor/vendorSftpImport.types.ts
frontend/src/hooks/vendor/useVendorSftpConnections.ts
frontend/src/hooks/vendor/useVendorImportJobs.ts
frontend/src/hooks/vendor/useVendorImportJobRuns.ts
frontend/src/components/vendor/import/VendorSftpConnectionsManager.tsx
frontend/src/components/vendor/import/VendorSftpConnectionModal.tsx
frontend/src/components/vendor/import/VendorScheduledImportsManager.tsx
frontend/src/components/vendor/import/VendorImportJobModal.tsx
frontend/src/components/vendor/import/VendorImportRunHistory.tsx
frontend/src/components/vendor/import/__tests__/VendorSftpConnectionsManager.test.tsx
frontend/src/components/vendor/import/__tests__/VendorSftpConnectionModal.test.tsx
frontend/src/components/vendor/import/__tests__/VendorImportRunHistory.test.tsx
frontend/src/hooks/vendor/__tests__/useVendorImportJobRuns.test.ts
```

### Modify
```
backend/app.js                                              (4 route registrations)
backend/package.json                                        (ssh2-sftp-client, cron-parser)
frontend/src/components/vendor/import/VendorImportPanel.tsx  (2 new tabs)
ai_scripts/sync-scheduled-job-api-keys.sh                   (add allaboard-sftp-import-job)
docs/billing/scheduled-job-monitoring.md                    (new app + stuck-run note)
```

---

## 16. Open Items / Risks

- **Import entry point name:** spec references `commitEligibilityImport()`; research found
  `importHouseholdsCsv()`. Builder reconciles against the actual export in `eligibilityImportService.js`.
- **File size:** in-memory Buffer assumed (typical eligibility CSVs < 5MB). Switch to streaming-to-temp
  if feeds are very large.
- **`IsRunning` stuck flag** if backend crashes mid-run — `try/finally` clears it; monitoring doc has a
  manual reset.
- **SFTP host-key verification** — `ssh2-sftp-client` accepts host keys without verification by default;
  consider a `hostVerifier` option as future hardening.
- **`NotifyEmails` as JSON in NVARCHAR(MAX)** — fine for v1; normalize to a junction table only if
  per-recipient querying is needed later.
- **Summit format slug:** no `sharewell_summit` preset exists yet; cutover seed uses
  `sharewell_default` with a guard comment — confirm Summit CSV columns map before enabling that job.

---

## 17. Sharewell cutover seed + disable legacy processors

After the schema migration and feature build, run
`sql-changes/2026-06-03-vendor-sftp-import-sharewell-cutover-seed.sql` to mirror the **member CSV**
timers in `sharewell-csv-processor/` as AllAboard `VendorSftpConnections` + `VendorImportJobs`
rows (all **`IsEnabled = 0`** until cutover is verified).

### What the seed creates

One shared SFTP connection (same host as `sharewell-csv-processor`: `sparkling-water-50295.sftptogo.com`)
scoped to ShareWELL vendor `D2A84803-5A9B-4E97-98A5-BEE1A11BBDA6`, plus five jobs:

| LegacyProcessorKey | sharewell-csv-processor | SFTP folder | Archive folder | Cron (UTC) | Format slug | AllAboard tenant (lookup) |
|---|---|---|---|---|---|---|
| `CalstarProcessor` | CalstarProcessor | `/Calstar` | `Archive` | `0 0 5,17 * * *` | `sharewell_calstar` | ShareWELL Health |
| `MPoweringBenefitsProcessor` | MPoweringBenefitsProcessor | `/MBP` | `Archive` | `0 30 1,13 * * *` | `sharewell_mpb` | ShareWELL Health |
| `SummitHealthProcessor` | SummitHealthProcessor | `/Summit` | `Archive` | `0 0 2,14 * * *` | `sharewell_default` | ShareWELL Health |
| `AlignHealthSHAProcessor` | AlignHealthSHAProcessor | `/ALIGN/SHA` | `Archive` | `0 30 3,15 * * *` | `sharewell_align_sha` | Align Health SHA — runs 30 min after Python (`0 0 3,15`) |
| `AlignHealthProcessor` | AlignHealthProcessor | `/ALIGN` | `archive` | `0 30 4,16 * * *` | `sharewell_align` | Align Health — runs 30 min after Python (`0 0 4,16`) |

Notification emails match sharewell config:
`admin@open-enroll.net`, `membersuccess@sharewellpartners.com`.

**Out of scope for this seed (still run on ShareWELL Partners DB via Python until separately migrated):**
`E123AgentProcessor`, `E123MemberProcessor` (agents + PGP member pipeline).

### Credentials

The seed does **not** store SFTP passwords in SQL. After apply:

1. Vendor portal → Import → SFTP Connections → edit **Sharewell production SFTP** → enter password → Test Connection.
2. Or set `@ApplyPasswordFromEnv` only in a local dry-run session (never commit plaintext passwords).

### Dual ingest (Align + Align SHA — transitional)

While both ShareWELL DB (Python) and AllAboard (OE) need the same eligibility CSVs:

1. Deploy `sharewell-csv-processor` with **`ALIGN_SKIP_SFTP_ARCHIVE=true`** (default in code) so
   `AlignHealthProcessor` / `AlignHealthSHAProcessor` ingest but **do not** move files off SFTP.
2. Keep Python timers **enabled** at `:00` UTC (`0 0 3,15` SHA, `0 0 4,16` Align).
3. Enable AllAboard Align jobs with cron **`0 30 3,15`** / **`0 30 4,16`** UTC (apply
   `sql-changes/2026-06-08-align-dual-sftp-ingest-schedule.sql` after dry-run).
4. AllAboard imports the same files ~30 minutes later and **archives** them.

Never run both systems on the same folder **without** skip-archive on Python — the first archiver wins
and the other sees no files.

### Cutover checklist (AllAboard live → disable og DB writers)

1. Run schema migration (`@DryRun = 0` after preview).
2. Deploy backend + `sftp-import-job/` + sync `SCHEDULED_JOB_API_KEY`.
3. Run cutover seed (`@DryRun = 0` after preview).
4. Configure SFTP password in vendor portal; test connection.
5. Enable **one** job → **Run Now** → verify run history + member data in AllAboard tenant.
6. Enable remaining jobs one at a time; confirm archive moves on SFTP.
7. **Disable legacy Python timers** on function app `sharewell-csv-processor` so they stop writing to
   **ShareWELLPartners** (og database):

   | Disable in Azure | Keeps running? |
   |---|---|
   | `CalstarProcessor` | No — cut over to AllAboard |
   | `MPoweringBenefitsProcessor` | No |
   | `SummitHealthProcessor` | No |
   | `AlignHealthSHAProcessor` | No |
   | `AlignHealthProcessor` | No |
   | `E123AgentProcessor` | Yes — until E123 agent migration is done |
   | `E123MemberProcessor` | Yes — until E123 member migration is done |

   Azure CLI example (disable one function):

   ```bash
   az functionapp function update \
     --resource-group ShareWELLPartners \
     --name sharewell-csv-processor \
     --function-name CalstarProcessor \
     --disabled true
   ```

8. Monitor Application Insights on both apps for 48h. For **dual ingest**, duplicate processing of the
   same file is intentional (ShareWELL DB then OE); the risk is **archive races** — use
   `ALIGN_SKIP_SFTP_ARCHIVE` on Python until AllAboard owns archive.

### Rollback

Re-enable the Python timer (`--disabled false`), set AllAboard jobs `IsEnabled = 0` via vendor portal
or `UPDATE oe.VendorImportJobs SET IsEnabled = 0 WHERE LegacyProcessorKey IS NOT NULL`.
