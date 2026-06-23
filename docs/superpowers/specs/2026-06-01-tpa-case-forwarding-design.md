# TPA Case Forwarding — Design Spec

**Date:** 2026-06-01
**Branch:** `fix/backoffice/combining-communications-and-encounters` (feature continues here)
**Status:** Approved design — pending implementation plan

## Problem

Preventative-care reimbursement requests arrive in our system as **cases** in the vendor
portal (the care-team "backoffice"). After the care team verifies the information, the case
must be forwarded by email to the appropriate third-party administrator (TPA). Today we work
with two TPAs: **ARM** and **Tall Tree**. There is currently no in-app way to (a) see which
cases need forwarding or (b) send the standardized request to the TPA, which risks missed or
duplicated sends.

## Goal

Let the care team, from a reimbursement case:

1. **See** which cases qualify for TPA forwarding (a badge in the case list).
2. **Generate** a pre-filled email/report from the case + member data via a button.
3. **Preview & edit** the email (recipient, body, which documents to attach) before sending.
4. **Send** to the TPA and **record** the send in the case history, so duplicate sends are
   visible and avoidable.

## Decisions (from brainstorming)

- **Trigger:** `CaseType = 'reimbursement'` only (subcategory ignored).
- **Recipient:** Admin-editable **comma-separated list** of forwarding emails per TPA, configured
  in VendorAdmin backoffice settings. At preview/generation time the list is shown as a
  **multi-select** of recipients (care team picks which to send to; defaults to all selected),
  and the `To` field also remains **editable** so an address can be added/overridden ad hoc.
- **Dedup:** **Warn but allow** — show "Already sent on <date>" but permit resend.
- **List surfacing:** **Badge/indicator** on qualifying case rows (the TPA label).
- **Email content:** Member identity, plan/product details, case details, and the case's
  **structured bills** (`oe.CaseBills`: provider, date of service, billed/allowed/paid/balance)
  with provider names from `oe.CaseProviders`, plus attachable documents. The bills section
  renders only when bills exist; raw uploaded bills (`oe.CaseDocuments`) are attachable regardless.
- **Attachments:** User picks which case documents to attach (checkboxes in the modal).
- **Templates:** Draft two starter vendor-scoped templates (ARM, Tall Tree); admin edits copy
  later in the message center.
- **Settings home:** VendorAdmin backoffice settings.

## Chosen approach

**Config-driven forwarding targets.** A settings table maps a *plan vendor* (the ARM/Tall Tree
`oe.Vendors` row) → forwarding email + template + label, managed by VendorAdmin. Detection,
badge, and button all derive from resolving a configured target for the case's member.

Rejected alternatives:
- **Hard-coded ARM/Tall Tree (env/config):** vendor IDs differ across environments and it is
  not admin-editable — contradicts the requirement.
- **Routing baked into message templates:** templates have no "trigger vendor" concept;
  overloading them muddies detection.

Rendering/preview is **server-side** for consistent merge, secure data access, and amount
handling.

## Architecture

### Components

1. **`caseForwardingService` (backend)** — single-purpose service:
   - `resolveTargetsForCases(vendorId, caseIds)` → `{ caseId: { targetId, label, planVendorId } }`
     (set-based; used by the case-list endpoint for badges).
   - `resolveTargetForCase(vendorId, caseId)` → target or null (used by preview/button gating).
   - `buildPreview(vendorId, caseId)` → `{ target, recipients[], subject, body, documents[], priorSends[] }`
     where `recipients[]` is the target's comma-separated list parsed into individual addresses
     (each selectable in the modal).
   - `send(vendorId, caseId, { to[], subject, body, documentIds[], userId })` → `to[]` is the
     care-team-selected subset (plus any ad-hoc additions); sends email, records `MessageHistory`
     + `CaseNote`, returns send record.
   - `renderTemplate(template, context)` → merge-field substitution over a **case-aware context**
     (`member.*`, `plan.*`, `case.*`, `bills`), separate from the existing member-only substitution.

2. **`oe.CaseForwardingTargets` (DB)** — admin-managed routing config (see Data Model).

3. **Vendor routes** (`backend/routes/me/vendor/`):
   - `GET    /api/me/vendor/cases/:id/forwarding/preview` → preview payload.
   - `POST   /api/me/vendor/cases/:id/forwarding/send` → send + record.
   - `GET/POST/PUT/DELETE /api/me/vendor/settings/forwarding-targets` → settings CRUD
     (VendorAdmin only).
   - Case list endpoint (`GET /api/me/vendor/cases`) extended to include `forwardingTarget` per row.
   - All routes behind existing `VendorAdmin`/`VendorAgent` auth + `requireTenantAccess`. Settings
     CRUD restricted to **VendorAdmin**.

4. **Frontend:**
   - `CaseListRail` — render a TPA chip on rows where `forwardingTarget` is set.
   - `CaseHeaderCard` — "Generate Email Report" button (reimbursement + resolved target only).
   - `TpaForwardPreviewModal` (new) — recipient multi-select (configured list, all checked by
     default) + editable add-a-recipient field, subject, body, document checklist, prior-send
     warning, Send action.
   - VendorAdmin settings — "TPA Case Forwarding" section with target CRUD.
   - `caseForwarding.service.ts` (new) — frontend API client.

### Data model

**New table `oe.CaseForwardingTargets`:**

| Column | Type | Notes |
|---|---|---|
| `TargetId` | UNIQUEIDENTIFIER PK | default NEWID() |
| `VendorId` | UNIQUEIDENTIFIER NOT NULL | operating care-team vendor (tenant isolation) |
| `PlanVendorId` | UNIQUEIDENTIFIER NOT NULL | FK → `oe.Vendors`; the TPA whose plans trigger forwarding |
| `Label` | NVARCHAR(100) NOT NULL | badge/button display (e.g. "ARM", "Tall Tree") |
| `ForwardingEmails` | NVARCHAR(1000) NOT NULL | admin-editable **comma-separated** list of destinations |
| `TemplateId` | UNIQUEIDENTIFIER NULL | FK → `oe.MessageTemplates` |
| `IsActive` | BIT NOT NULL DEFAULT 1 | |
| `CreatedDate/By`, `ModifiedDate/By` | | audit |

- Unique index on `(VendorId, PlanVendorId)`.
- Index on `(VendorId, IsActive)`.

**Reuse `oe.MessageHistory`** (already has `CaseId` from the 2026-05-20 history-timeline
migration). A send writes one row: `CaseId`, `MessageType='Email'`, `RecipientAddress`,
`Subject`, `Status`, `SentDate`. This:
- auto-appears in the case **History timeline** (via `historyTimelineService.collectOutreach`), and
- powers **dedup**: `buildPreview` queries `MessageHistory WHERE CaseId=@id AND RecipientAddress=@email`
  (and/or matching target) to populate `priorSends[]`.

> SQL is delivered as a migration file in `sql-changes/` only. Per project policy the shared
> `allaboard-testing` DB is **not** migrated by this work; the file is written, not run.

### Data flow

**Badge:** case-list query LEFT JOINs reimbursement cases' members → active enrollments →
products → `CaseForwardingTargets.PlanVendorId` for the operating vendor, yielding the target
label per case. Frontend renders the chip.

**Preview:** button → `GET …/forwarding/preview` → service resolves target, parses the target's
comma-separated `ForwardingEmails` into `recipients[]`, aggregates member/plan/case data and the
case bills (`oe.CaseBills` + `oe.CaseProviders`), renders the target's template into subject+body,
lists active case documents, and attaches prior-send history → modal.

**Send:** modal → `POST …/forwarding/send` with `{ to[], subject, body, documentIds }` (where
`to[]` is the selected recipients) → `sendGridEmailService.sendEmail()` with selected documents
fetched from blob storage as attachments → insert `MessageHistory` (CaseId-linked, one row per
send recording all recipients) + internal `CaseNote` audit row → return.

### Email templates (starter)

Two vendor-scoped `oe.MessageTemplates` rows (ARM, Tall Tree), `MessageType='Email'`, with
case-aware merge fields. Supported placeholders in the forwarding render context:

- `{[member.FirstName]}`, `{[member.LastName]}`, `{[member.MemberNumber]}`, `{[member.DateOfBirth]}`,
  `{[member.Address]}`, contact fields.
- `{[plan.Name]}`, `{[plan.EffectiveDate]}`, `{[plan.GroupName]}`.
- `{[case.Number]}`, `{[case.Type]}`, `{[case.Subcategory]}`, `{[case.Title]}`,
  `{[case.Description]}`, `{[case.SubmittedDate]}`, `{[case.Status]}`.
- A **bills section** rendered from `oe.CaseBills` rows (provider name, `BillType`, `DateOfService`,
  `Description`, `BilledAmount`, `AllowedAmount`, `PaidAmount`, `Balance`) — renders only when the
  case has bills. Implemented as a repeatable block in the render context, not a flat placeholder.

## Error handling

- **No target resolves** → button hidden; preview endpoint returns 409 if called.
- **No recipients configured** → button visible; preview returns the target with an empty
  `recipients[]` and a warning. The modal's Send button stays disabled until the user selects or
  types at least one recipient, with guidance to set defaults in settings.
- **SendGrid disabled (no API key)** → `sendEmail` returns success without sending (dev/testing);
  we still record the `MessageHistory` row so the flow is fully testable without real sends.
- **Attachment fetch failure** → fail the send with a clear message; do not record a partial send.
- **Tenant/role violations** → standard 403 via `requireTenantAccess` / role checks.

## Testing

- **Backend (Jest):** `caseForwardingService` unit tests — target resolution (match/no-match,
  inactive, wrong case type), template render with/without bills, comma-separated recipient
  parsing, dedup `priorSends` population, send path with `sendEmail` **mocked** (never a real
  send). Route tests for preview/send/settings CRUD incl. role gating and tenant isolation.
- **Frontend (Vitest):** modal renders preview, document selection, prior-send warning, Send
  calls API; settings CRUD; badge rendering logic.
- **Cypress:** stub-driven (no DB) flow — open reimbursement case → button → modal → pick docs →
  send → confirmation; `cy.intercept` on the send endpoint (no real SendGrid). Per project
  policy, **no real message sends** in any test.

## Out of scope

- Inbound/automatic processing of TPA replies.
- Bulk/multi-case forwarding.
- "Not yet sent vs sent" list emphasis and list sorting/filtering (only the row badge was
  requested; can be a follow-up).
- Editing the message-template *catalog* beyond the two starter templates.

## Reference: confirmed DB facts (testing)

- **Vendors:** `ARM` = `406B4EEA-F334-4EFC-82D5-89545E55CC01`; `Tall Tree Administrators` =
  `C34859BA-1B50-4AE8-9A14-2DC7794886A4`. These IDs are environment-specific — admins select the
  actual vendor in settings, so no IDs are hard-coded.
- **Amounts source (resolved):** `oe.CaseBills` holds structured per-bill amounts
  (`BilledAmount`, `AllowedAmount`, `PaidAmount`, `Balance`, `DateOfService`, `ProviderId`,
  `BillType`). `oe.CaseTransactions` holds payment records (`Amount`, `TransactionType`,
  `TransactionStatus`). The TPA email's bills section reads `oe.CaseBills`; reimbursement
  payment status (from `CaseTransactions`) is out of scope for the outbound request email.

## Open items to confirm during planning

- Whether the badge should also reflect **sent state** (e.g. checkmark once forwarded) — design
  currently shows TPA label only.
