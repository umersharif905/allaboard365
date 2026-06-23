# Unmatched public-form submissions create a flagged SR/Case

**Date:** 2026-05-30
**Status:** Design — approved approach, pending spec review

## Problem

When a public form is submitted and the member resolver can't match the submitter
(`MemberMatchStatus = 'Unmatched'`), no ShareRequest or Case is auto-created — the
submission only lands in the back-office **Submissions** queue (flagged "Needs
attention"). Back-office staff work primarily out of the **ShareRequest** and
**Case** dashboards, so unmatched items are easy to miss.

We want an unmatched submission to **still create a ShareRequest or Case** so it
appears in the dashboards the team actually works, clearly marked **Unmatched**,
and convertible to a normal SR/Case once a staffer matches the member.

## Constraints discovered

- `oe.ShareRequests.MemberId` and `oe.Cases.MemberId` are both **`NOT NULL`** today.
- `oe.ShareRequests.VendorId` and `oe.Cases.VendorId` are both **`NOT NULL`**.
- `oe.PublicFormSubmissions` already carries `MemberId` (nullable), `ShareRequestId`,
  `CaseId`, and `MemberMatchStatus` ('Matched' | 'Unmatched' | 'Ambiguous'); the
  submission row is the link back to any SR/Case it created.
- `linkSubmissionToShareWorkflow` currently derives household, vendor, request type,
  and the request name **from the matched member** — so an unmatched path must supply
  these from the form + payload instead.

## Approach (approved)

Allow a **member-less "shell"** ShareRequest/Case, marked with a dedicated
**`NeedsMemberMatch` flag** (workflow status stays `New`/`Open`). When a staffer
later sets the member on the submission, the linked shell is **backfilled in place**
(real `MemberId`, flag cleared) — no duplicate is created.

Decisions:
- **Representation:** a separate `NeedsMemberMatch BIT` flag, not a new status value —
  keeps the workflow-status enum clean and gives dashboards a single boolean to
  badge/filter on.
- **No-vendor fallback:** vendor comes from the form's `DefaultVendorId` (we have no
  member to read enrollments from). If the form has no default vendor, we **do not**
  force a null-vendor SR/Case — the item stays **submission-only** (today's behavior)
  with a logged `LinkError`. `VendorId` therefore stays `NOT NULL`.

## Data model (migration — additive, idempotent)

`sql-changes/allaboard365/2026-05-30-unmatched-shell-sr-case.sql`:

1. `ALTER TABLE oe.ShareRequests ALTER COLUMN MemberId UNIQUEIDENTIFIER NULL;`
2. `ALTER TABLE oe.Cases ALTER COLUMN MemberId UNIQUEIDENTIFIER NULL;`
   (Widening NOT NULL → NULL is a metadata-only change; existing FK to `oe.Members`
   is preserved and simply permits NULL.)
3. `ALTER TABLE oe.ShareRequests ADD NeedsMemberMatch BIT NOT NULL CONSTRAINT
   DF_ShareRequests_NeedsMemberMatch DEFAULT 0;` (guarded by `IF NOT EXISTS`)
4. Same `NeedsMemberMatch` column on `oe.Cases`.

`VendorId` stays `NOT NULL` on both. DRY-RUN default per repo DB policy; applied to
testing first, then prod at deploy time.

## Submission flow

`backend/services/publicFormSubmissionService.js`
- Today: `if (resolution.status === 'Matched' && resolution.memberId && !skipShareWorkflow) linkSubmissionToShareWorkflow(...)`.
- Change: also enter the link step when `resolution.status === 'Unmatched'`, passing a
  `needsMemberMatch: true` signal and the **typed identity** from the payload
  (`firstName`, `lastName`, `memberId` text) for naming/description.

`backend/services/publicFormShareLinkService.js` (`linkSubmissionToShareWorkflow`)
- Add an unmatched branch that:
  - Resolves vendor from `templateRow.DefaultVendorId` only. If absent →
    `setLinkError('Unmatched and no Default Vendor on form; left as submission for manual review')`
    and return without creating an SR/Case.
  - Creates the shell SR (or Case, per the same `createsSr`/`createsCase` routing the
    matched path uses) with: `memberId = null`, `householdId = null`,
    `needsMemberMatch = true`, `requestName`/description from the typed payload text,
    `requestTypeId` resolved from `vendorId + formKind + payload` (already member-
    independent), status defaulting to `New`/`Open`.
  - The member-dependent enrichments in the matched path (household lookup,
    `AdditionalDocuments` verifier match, prior-provider linking that needs a member)
    are **skipped** when there's no member.

`backend/services/shareRequestService.js` `createShareRequest` and
`backend/services/caseService.js` `createCase`
- Accept a null `memberId` **only** when `needsMemberMatch` is set, and persist the
  `NeedsMemberMatch` flag. `createCase`'s current `if (!memberId) throw` guard is
  relaxed to allow the flagged case; all other callers are unchanged (they always pass
  a member, default flag = 0).

## Match-later backfill

When a staffer resolves/sets the member on a submission
(`POST /api/me/vendor/public-forms/submissions/:id/set-member` and the tenant-admin
mirror): if that submission's `ShareRequestId`/`CaseId` points to a row with
`NeedsMemberMatch = 1`, update that row's `MemberId` (and `HouseholdId`) and set
`NeedsMemberMatch = 0` — converting the shell into a normal SR/Case in place. No new
SR/Case is created.

## Back-office display

- **ShareRequest dashboard / Case workspace:** show shells with an **"Unmatched"**
  badge; the member column shows the submitter's typed name/ID text instead of a member
  link. SR list query already `LEFT JOIN`s members; the Case list query is made
  null-safe the same way. Add a `NeedsMemberMatch` filter so staff can isolate the
  triage set.
- No member-detail navigation is rendered for a shell (no member to link to).

## Edge cases

- **Ambiguous** (`MemberMatchStatus = 'Ambiguous'`): treated like Unmatched (no
  confident member) → shell with `NeedsMemberMatch = 1`.
- **Signed-in / invitation submissions:** unaffected — they always carry a
  server-authorized `boundMemberId`/recipient, so they never take the unmatched path.
- **`AdditionalDocuments` forms:** require a member to find the existing SR; with no
  member they stay submission-only (unchanged).
- **Idempotency:** the existing `skipShareWorkflow` / single-link guard still prevents
  double-creation on retried submissions.

## Scope

In the shared submission service, so it covers **all** auto-create forms — both the
`[NEW]` Share Request form and the Out-of-Network/Case form. No per-form config needed
beyond having a Default Vendor.

## Testing

- Unit: `linkSubmissionToShareWorkflow` unmatched branch (shell created with flag,
  vendor from default, name from typed text); no-default-vendor → submission-only;
  match-later backfill clears the flag in place.
- Unit: `createShareRequest`/`createCase` accept null member only with the flag.
- Regression: matched path unchanged (flag = 0, member present).

## Out of scope

- Bulk "match all" tooling, auto-rematch on member import, and any change to the
  resolver itself (that's the already-merged `ResolverTenantIds` work).
