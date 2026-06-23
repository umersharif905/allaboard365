# Plan: PCP records + Direct Deposit fields on Unshared Amount Sharing Request

## Goal

Add two new sections to the public form `Unshared Amount Sharing Request`
(FormTemplateId `C2DE2CEB-0CEF-4646-9E52-479F3A677F44`) that members fill out
when submitting a sharing request:

1. **Primary care provider (PCP) records** — provider name, phone, fax,
   uploaded office notes.
2. **Direct deposit / ACH banking** — account holder, bank, account type,
   routing #, account #.

PCP data should ride along with the share request submission (already
encrypted at rest in the public-forms pipeline).

ACH data should land in a new per-member table — `oe.MemberDirectDeposits` —
distinct from `Payments` / `ACHAccounts` / `ProductOverrideACH`, which all
deal with money flowing **into** the system. This new table represents the
member's reimbursement destination (money flowing **out** to the member).
A member can have many records but only one **Active** at a time; the most
recent one becomes Active automatically.

These records should be surfaced when a tenant-admin or agent looks up a
member.

---

## Scope summary

| Area | Change |
|---|---|
| Form template | Add 4 PCP fields + 5 ACH fields via the form editor (no code) |
| DB migration | New table `oe.MemberDirectDeposits` + indexes |
| Backend service | New `memberDirectDepositService.js` (encrypt/decrypt, upsert with active rotation) |
| Backend integration | Extend `publicFormShareLinkService.js#linkSubmissionToShareWorkflow` to extract ACH on submit |
| Backend route | New `GET/POST/PATCH` endpoints under `/api/me/tenant-admin/members/:memberId/direct-deposits` (and agent equivalent) |
| Backend payload hygiene | Strip ACH fields from form payload before encryption so banking data only lives in the dedicated table |
| Frontend | Direct Deposit section in `MemberOverviewTab.tsx` (last4-only, role-gated reveal) |
| Tests | Unit tests for service, integration test for submission → DirectDeposit creation |

---

## 1. Edit the form template (no code)

Done in the tenant-admin Forms tab editor on the existing `Unshared Amount
Sharing Request` template. Publishes a new version (currently v19 → v20).
This step is independent of the code changes and can be staged behind a
feature toggle by simply not publishing until backend is deployed.

### PCP section (new fields, all in form-builder palette types)

Add a `paragraph`/`static_html` field for the section heading + intro text +
warning callout copy from the screenshot, then:

| Field name | Type | Required | Notes |
|---|---|---|---|
| `pcpProviderName` | `text` | yes | Placeholder "e.g. Dr. Sarah Johnson" |
| `pcpProviderPhone` | `tel` | yes | Placeholder `(000) 000-0000` |
| `pcpProviderFax` | `tel` | no | Optional |
| `pcpOfficeNotes` | `file` | yes | Multiple files; PDF/JPG/PNG (existing public-forms file pipeline already enforces allowlist) |

These flow through the existing pipeline:
- Values in `payload` → encrypted into `PayloadEncrypted` on
  `oe.PublicFormSubmissions`
- Files uploaded to `public-form-uploads` blob container, rows in
  `oe.PublicFormSubmissionFiles` with `FilePurpose='attachment'`
- `attachSubmissionFilesToShareRequest` (already wired) attaches the PDFs
  to the auto-created ShareRequest so the back-office vendor sees them on
  the Documents tab.
- General notes on the ShareRequest are already auto-filled from
  `payload.providerInformation` etc; we'll add a line for PCP info to
  `linkSubmissionToShareWorkflow`'s `generalNotes` builder
  (`backend/services/publicFormShareLinkService.js`, the array around
  line 195) so the vendor can see PCP name/phone/fax inline without
  decrypting the payload.

### Direct Deposit section (new fields)

| Field name | Type | Required | Notes |
|---|---|---|---|
| `dd_accountHolderName` | `text` | yes | "Full name as it appears on your bank account" |
| `dd_bankName` | `text` | yes | Placeholder "e.g. Chase, Wells Fargo" |
| `dd_accountType` | `select` | yes | Options: `Checking`, `Savings` |
| `dd_routingNumber` | `text` | yes | 9 digits (validation in builder helper text only; format-checked server-side) |
| `dd_accountNumber` | `text` | yes | Member's account # |

Add a `terms` or `static_html` field above for the warning callout copy.

> **Important:** these fields do NOT need `includeInPdf: true`. We do **not**
> want raw account/routing numbers ending up in the per-submission PDF
> snapshot the system generates.

---

## 2. New DB table — `oe.MemberDirectDeposits`

Migration file: `sql-changes/allaboard365/2026-05-06-member-direct-deposits.sql`

```sql
CREATE TABLE oe.MemberDirectDeposits (
    DirectDepositId            UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
    MemberId                   UNIQUEIDENTIFIER NOT NULL,
    TenantId                   UNIQUEIDENTIFIER NOT NULL,
    AccountHolderName          NVARCHAR(200)    NOT NULL,
    BankName                   NVARCHAR(200)    NOT NULL,
    BankAccountType            NVARCHAR(20)     NOT NULL CHECK (BankAccountType IN ('Checking','Savings')),
    AccountNumberEncrypted     NVARCHAR(500)    NOT NULL,
    RoutingNumberEncrypted     NVARCHAR(500)    NOT NULL,
    AccountNumberLast4         CHAR(4)          NOT NULL,
    RoutingNumberLast4         CHAR(4)          NOT NULL,
    IsActive                   BIT              NOT NULL DEFAULT 1,
    Source                     NVARCHAR(40)     NOT NULL DEFAULT 'PublicFormSubmission',
    SourceSubmissionId         UNIQUEIDENTIFIER NULL,
    DeactivatedDate            DATETIME2        NULL,
    DeactivatedBy              UNIQUEIDENTIFIER NULL,
    CreatedDate                DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
    CreatedBy                  UNIQUEIDENTIFIER NULL,
    ModifiedDate               DATETIME2        NULL,
    ModifiedBy                 UNIQUEIDENTIFIER NULL,
    CONSTRAINT FK_MemberDirectDeposits_Member
        FOREIGN KEY (MemberId) REFERENCES oe.Members(MemberId),
    CONSTRAINT FK_MemberDirectDeposits_Tenant
        FOREIGN KEY (TenantId) REFERENCES oe.Tenants(TenantId)
);

-- Only one Active per member
CREATE UNIQUE INDEX UQ_MemberDirectDeposits_OneActive
    ON oe.MemberDirectDeposits(MemberId)
    WHERE IsActive = 1;

-- Tenant scope + lookup by member
CREATE INDEX IX_MemberDirectDeposits_Member
    ON oe.MemberDirectDeposits(TenantId, MemberId, IsActive, CreatedDate DESC);
```

Notes:
- Column naming mirrors `oe.ProductOverrideACH` so existing decrypt code
  patterns work without surprise.
- Encryption uses existing `services/encryptionService.js` (AES-256-GCM,
  `ENCRYPTION_KEY` env var).
- `Last4` columns let us render UI without ever decrypting.
- `Source` distinguishes how the row was created (e.g. `PublicFormSubmission`,
  `TenantAdminEntry`) — keeps the audit story clear.

---

## 3. New service — `backend/services/memberDirectDepositService.js`

Responsibilities:

```js
// pseudo-shape
async function upsertFromPayload({ memberId, tenantId, payload, sourceSubmissionId, actorUserId }) { … }
async function listForMember({ memberId, tenantId, includeInactive = true }) { … }
async function getById({ directDepositId, tenantId }) { … }
async function setActive({ directDepositId, tenantId, actorUserId }) { … }  // makes one active, deactivates all others — single transaction
async function deactivate({ directDepositId, tenantId, actorUserId }) { … }
async function revealEncrypted({ directDepositId, tenantId, actorUserId }) { … }  // decrypts; only callable from role-gated route
```

Key implementation notes:
- `upsertFromPayload`:
  1. Validates routing # is exactly 9 digits, account # is 4–17 digits,
     account type is `Checking|Savings`, account holder is non-empty.
  2. If existing Active row's encrypted account+routing+holder+bank match
     the new submission, **skip insert** (return the existing row). Avoids
     creating a new "v2" record every time the member resubmits the same
     bank info.
  3. Otherwise: in a single transaction — `UPDATE … SET IsActive=0,
     DeactivatedDate=SYSUTCDATETIME() WHERE MemberId=@memberId AND
     IsActive=1` then `INSERT` new row with `IsActive=1`.
  4. Returns `{ directDepositId, isNew: true|false }`.

- All service functions filter by `TenantId` (per CLAUDE.md tenant
  isolation rule).

---

## 4. Hook into the submission flow

File: `backend/services/publicFormShareLinkService.js`

Inside `linkSubmissionToShareWorkflow` — currently around line 101 — after
the member is resolved (`memberId`/`tenantId` known) and the ShareRequest
is created, call:

```js
if (hasDirectDepositFields(payload)) {
    try {
        await memberDirectDepositService.upsertFromPayload({
            memberId,
            tenantId,
            payload,
            sourceSubmissionId: submissionId,
            actorUserId
        });
    } catch (ddErr) {
        // Best-effort, same pattern as note/queue assignment failures
        console.warn('publicFormShareLinkService: DirectDeposit upsert failed', ddErr.message);
    }
}
```

Where `hasDirectDepositFields(payload)` returns true if any of the `dd_*`
keys exist in payload. We don't fail the whole submission if DD upsert
fails — same defensive pattern as `attachSubmissionFilesToShareRequest`.

### Strip ACH from the encrypted payload

In `publicFormSubmissionService.js#createSubmissionFromPublicRequest`,
right before `encryptPayloadObject(payload)` (around line 299):

```js
const { sanitizedPayload, redactedKeys } =
    redactDirectDepositFields(payload);  // returns shallow clone with dd_* removed
const enc = encryptPayloadObject(sanitizedPayload);
```

Then we use `payload` (with the dd_* still present) for the
`linkSubmissionToShareWorkflow` call so the DirectDeposit upsert can read
them, but `sanitizedPayload` for `PayloadEncrypted` so banking data only
ever lives in `oe.MemberDirectDeposits`. Submission viewer page sees a
"banking info redacted (stored in member profile)" placeholder.

This is the most security-meaningful piece of the plan — without it
there's a duplicate copy of bank account numbers in
`PublicFormSubmissions.PayloadEncrypted` that no one is managing.

---

## 5. New backend routes

File: `backend/routes/me/tenant-admin/member-direct-deposits.js`
Mounted under `/api/me/tenant-admin/members/:memberId/direct-deposits`.

| Method | Path | Roles | Purpose |
|---|---|---|---|
| GET | `/` | TenantAdmin, TenantAccounting, Agent (self-scope), SysAdmin | list (last4 only) |
| GET | `/:directDepositId/reveal` | TenantAdmin, TenantAccounting, SysAdmin | decrypt + return full # (audit log entry written) |
| POST | `/` | TenantAdmin, TenantAccounting, SysAdmin | manually add a new DD record (becomes Active) |
| PATCH | `/:directDepositId/activate` | TenantAdmin, TenantAccounting, SysAdmin | flip Active to this row |
| PATCH | `/:directDepositId/deactivate` | TenantAdmin, TenantAccounting, SysAdmin | mark inactive (no row becomes active automatically) |

All routes go through `requireTenantAccess` and verify the member belongs
to the caller's tenant.

The `reveal` endpoint should write an entry to `oe.UserActions` (or
whatever the existing audit table is — check) so we have a paper trail of
who saw raw bank info.

A parallel agent-scoped variant under `/api/me/agent/...` for read-only
list view if agents need it; revealing is admin-only.

---

## 6. Frontend — surface on member lookup

File: `frontend/src/pages/members/tabs/MemberOverviewTab.tsx`

Add a "Direct Deposit (Reimbursements)" card showing:

```
[ Active ]  Chase Checking  ····6789      ⓘ Updated May 6, 2026
            Routing  ····0021                Reveal full #

Older accounts (2)  ▾
  Wells Fargo Savings  ····1234   Inactive — replaced May 6, 2026
  …
```

- Default rendering uses last4 only (no API call to decrypt).
- "Reveal full #" hits `/reveal` endpoint, role-gated; click shows a
  popup confirmation (per user's "no toasts" preference) before disclosing.
- "Make Active" / "Deactivate" buttons next to inactive rows for admins.
- "Add Direct Deposit" button at top opens a modal with the same field set
  as the form section.

Hook: new `useMemberDirectDeposits(memberId)` in
`frontend/src/hooks/members/`.

Service: new `memberDirectDeposit.service.ts` in `frontend/src/services/`.

Match existing styling: `bg-white rounded-lg border border-gray-200`,
`oe-primary` brand colors, Lucide `Banknote` icon for the card.

---

## 7. Edge cases & decisions

- **Member not matched (`MemberMatchStatus != 'Matched'`)**: skip the
  DirectDeposit upsert. The submission already lands in the tenant-admin
  Submissions inbox with a `LinkError`; the admin manually resolves the
  member, and at that point we can offer a "Apply banking info from
  payload" button on the submission detail page (later phase — out of
  scope for v1; note in the plan that the data is in the encrypted payload
  if needed).

- **Submitter resubmits with different bank info two days later**: new
  row inserted, old one deactivated. History preserved.

- **Submitter resubmits with the SAME bank info**: `upsertFromPayload`
  detects no change (compare encrypted ciphertexts can't work since IVs
  differ — instead compare last4+holder+bank+type+decrypt; or just always
  insert and let the most recent become active. Recommend: always insert,
  always rotate active. Cheap, audit-honest, and avoids decrypt-on-read
  during the submission hot path.) **Decision needed from user.**

- **Encryption-at-rest only — what about export/PDF/email?** The system's
  email notify path (`publicFormNotifyService`) sends a "submission
  received" email but does not include payload values. Confirmed by code
  review — ok to leave as-is. The submission viewer (`/api/public/forms/
  submissions/:token`) renders payload — when banking is stripped, viewers
  will see the "redacted" placeholder, not the values.

- **Per-member uniqueness with families**: ACH info attaches to the
  resolved `MemberId`, which is the member submitting (could be primary,
  spouse, or dependent). This matches the form's `relationToPrimary`
  field. If a dependent submits with the primary's banking, that's the
  submitter's choice — we attach it to whoever submitted. If the user
  wants the policy "always attach to primary on the household," that's a
  small change in the upsert (look up `Members.HouseholdId`, then primary
  member of the household). **Decision needed from user.**

- **Backfill / migration of existing UA submissions?** Old submissions
  predate the new form fields, so there's nothing to backfill. The
  feature is forward-only.

- **Rollback safety**: the form-template change is reversible (republish
  the prior version). The backend changes are purely additive (new table,
  new code paths gated by `dd_*` field presence). The payload-redaction
  step is the one piece that affects existing submissions — if banking
  data ever appeared in old submissions (it didn't), the change wouldn't
  retroactively redact them; we just stop NEW writes from including it.

---

## 8. Testing strategy

Backend Jest:
- `services/__tests__/memberDirectDepositService.test.js` — unit tests for
  upsert, validation, active rotation, encryption round-trip.
- `services/__tests__/publicFormShareLinkService.directdeposit.test.js` —
  integration: feed a fake submission payload with dd_* fields, assert
  DirectDeposit row appears with correct memberId and IsActive.

Vitest (frontend):
- Component test for the Direct Deposit card in `MemberOverviewTab` —
  renders last4 only by default, makes the right API call on Reveal click.

Manual QA on localhost:
- Edit form → publish v20 → submit as a known matched member → verify
  ShareRequest is created, files attach, DirectDeposit row appears with
  IsActive=1, payload in DB has no dd_* keys.
- Submit again with different bank info → old row Inactive, new row Active.
- Open member overview as TenantAdmin → see DirectDeposit card with last4.
- Click Reveal → confirm popup → verify decrypted values match what was
  submitted; verify audit log row.

---

## 9. File change list (anticipated)

```
sql-changes/allaboard365/2026-05-06-member-direct-deposits.sql                NEW

backend/services/memberDirectDepositService.js                                 NEW
backend/services/publicFormShareLinkService.js                                 modify (call upsertFromPayload)
backend/services/publicFormSubmissionService.js                                modify (redact dd_* before encrypt)
backend/routes/me/tenant-admin/member-direct-deposits.js                       NEW
backend/routes/me/tenant-admin/index.js                                        modify (mount new route)
backend/routes/me/agent/member-direct-deposits.js                              NEW (read-only)
backend/routes/me/agent/index.js                                               modify
backend/services/__tests__/memberDirectDepositService.test.js                  NEW
backend/services/__tests__/publicFormShareLinkService.directdeposit.test.js    NEW

frontend/src/services/memberDirectDeposit.service.ts                           NEW
frontend/src/hooks/members/useMemberDirectDeposits.ts                          NEW
frontend/src/components/members/DirectDepositCard.tsx                          NEW
frontend/src/components/members/DirectDepositAddModal.tsx                      NEW
frontend/src/components/members/DirectDepositRevealDialog.tsx                  NEW
frontend/src/pages/members/tabs/MemberOverviewTab.tsx                          modify (slot the card in)
frontend/src/components/__tests__/DirectDepositCard.test.tsx                   NEW
```

Form-template edit happens in the running app (no file change in repo).

---

## 10. Open decisions for the user

1. **Resubmit with same bank info** — always insert + rotate, or
   dedupe-on-decrypt? (Recommend: always insert + rotate.)
2. **Family/household scope** — attach to the submitter MemberId (current
   plan), or always roll up to household primary?
3. **Reveal-full-number access** — TenantAdmin + TenantAccounting only, or
   also Agent? (Recommend: admin/accounting only; agents see last4.)
4. **PCP info — encrypt within payload or leave plain inside the
   already-encrypted payload?** (Currently the whole payload is encrypted
   at rest; PCP fields don't carry PCI/banking sensitivity, so no extra
   handling needed. Confirm we're comfortable with that.)
5. **Form template change — staging strategy.** Publish v20 in staging
   first; the submission flow's redaction code must already be deployed
   before v20 goes live in production, otherwise raw bank info briefly
   lands in `PayloadEncrypted` between deploys. Recommend deploying
   backend first, then publishing v20.

---

## Implementation order (smallest reversible steps)

1. SQL migration (additive, no risk).
2. `memberDirectDepositService.js` + unit tests.
3. Tenant-admin GET endpoint + frontend overview card (last4-only). Lets
   admins see records that don't yet exist — fine, empty state.
4. Hook into `linkSubmissionToShareWorkflow` + payload redaction +
   integration test.
5. Manual entry/manage endpoints (POST/PATCH activate/deactivate) +
   modals.
6. Reveal endpoint + audit log + reveal dialog.
7. Form-template edit (last, after backend is in production).
