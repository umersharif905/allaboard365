# Vendor Minimums & List-Bill Groups — High-Level Design

**Date:** 2026-04-23
**Author:** Joey Desai (w/ Claude)
**Status:** Draft for review

---

## 1. Executive Summary

Two coupled features are proposed to handle a real-world constraint from our vendors (notably Tall Tree, which requires at least 5 employees per group):

1. **Vendor Minimums + Enrollment Deadlines** — Vendors gain a configurable "minimum employees per group" setting. Groups that fall short of the strictest applicable minimum receive a one-time warning email 10 days before their effective date and have new enrollments locked 5 days before. This protects us and the agent from submitting sub-minimum groups to the carrier.

2. **List-Bill Groups** — A new group type that exempts a group from vendor minimums by selling individual-SKU products instead of group products. Everything else (billing, contributions, group admin, reporting) stays identical. This gives agents a recovery path when a group can't reach the minimum while preserving the group-level billing experience.

The two features are designed together because list bill is the agent's primary escape hatch when a group is about to trip the vendor minimum.

**Not in V1:** Mid-month (15th) enrollments, automated refunds, auto-promotion of list-bill groups back to standard when they later hit the minimum.

---

## 2. Background & Problem

### Today
- Groups in `oe.Groups` have no notion of a "type" — every group is treated the same.
- Vendors in `oe.Vendors` have no minimum-membership setting. Tall Tree's 5-employee requirement is enforced only by manual agent diligence.
- Products carry a `SalesType` (`Group` / `Individual` / `Both`), but groups only ever enroll members into `Group` products.
- There is no automated notification telling an agent "your group is about to miss the vendor minimum."
- When a group fails to reach the minimum, there is no defined process. Agents currently handle these ad-hoc, often after enrollments have already been collected.

### Related in-flight work
**PR #90 (`rich/25thcutoffenrollments`, open):** Adds a tenant-configurable day-of-month cutoff (default 25th). If today is past the cutoff, new enrollments cannot land on next month's 1st — they are pushed to the month after. It is synchronous validation only (no emails, no scheduled job, no DB flag). This is conceptually adjacent to our work and should be merged first so our T-10/T-5 math can read the adjusted effective date from Rich's utility rather than re-implementing the cutoff calculation.

### What we need
- A vendor-level setting honored across the system.
- An automated, time-based notification and lock mechanism.
- A second-class group type that behaves like a group for billing but carries individual products.
- A controlled conversion process between the two types with audit trail.

---

## 3. Features Summary

| Feature | Who | Trigger | Behavior |
|---|---|---|---|
| Vendor minimum setting | SysAdmin | Vendor admin UI | New `MinimumEmployeesPerGroup` column on `oe.Vendors` (nullable = no minimum) |
| T-10 warning | Scheduled job | 10 days before group's effective 1st, group below minimum | One-time email to agent + configurable tenant recipient list |
| T-5 lock | Scheduled job | 5 days before group's effective 1st, group below minimum | Block *new* enrollees from starting group links; mid-flow enrollees can finish |
| List-fill group creation | Agent | Group creation form | Agent picks `Standard` or `ListBill` at creation; both are self-serve |
| List-fill group behavior | System | Always on list-bill groups | Vendor minimums skipped; individual products allowed; same billing/contributions |
| Type conversion | Agent → TenantAdmin | Request queue | Agent initiates conversion; TenantAdmin (of the agent's tenant) approves in a new tenant-admin queue. Tenant can opt in to auto-approval. Agent completes product selection + link resend wizard after approval. |
| Visual label | UI | List-fill groups everywhere | "List Bill" pill/badge on group name in all agent/admin views |

---

## 4. Data Model Changes

### 4.1 `oe.Vendors`

```sql
ALTER TABLE oe.Vendors
  ADD MinimumEmployeesPerGroup INT NULL;
-- NULL = no minimum enforced
```

Surface in **SysAdmin → Vendors → Integration Settings** (or a new "Enrollment Rules" tab) in `/frontend/src/pages/admin/Vendors.tsx`. Include in existing `PUT /api/vendors/:id` payload.

### 4.2 `oe.Groups`

```sql
ALTER TABLE oe.Groups
  ADD GroupType NVARCHAR(20) NOT NULL DEFAULT 'Standard';
-- Values: 'Standard' | 'ListBill'
```

All existing groups backfill to `Standard`. Agent creation form gets a radio picker with a disclaimer ("List Bill is for groups with fewer than N employees, where N is set per vendor"). The minimum value is pulled from the strictest vendor associated with the products the agent intends to add.

### 4.3 `oe.GroupTypeChangeRequests` (new)

```sql
CREATE TABLE oe.GroupTypeChangeRequests (
  RequestId        UNIQUEIDENTIFIER PRIMARY KEY,
  GroupId          UNIQUEIDENTIFIER NOT NULL,
  TenantId         UNIQUEIDENTIFIER NOT NULL,
  RequestedBy      UNIQUEIDENTIFIER NOT NULL,  -- Agent user id
  CurrentType      NVARCHAR(20) NOT NULL,
  RequestedType    NVARCHAR(20) NOT NULL,
  Status           NVARCHAR(20) NOT NULL,       -- Pending | Approved | Denied | Cancelled
  Reason           NVARCHAR(MAX) NULL,          -- Agent-supplied context
  ReviewedBy       UNIQUEIDENTIFIER NULL,
  ReviewedAt       DATETIME2 NULL,
  ReviewNotes      NVARCHAR(MAX) NULL,
  CreatedDate      DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  ModifiedDate     DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
```

### 4.4 Tenant settings (extend existing `advancedSettings` JSON)

```json
{
  "enrollment": {
    "belowMinimumAlertRecipients": ["joey@mightywell.us", "ops@tenant.com"],
    "autoApproveGroupTypeChanges": false
  }
}
```

- `belowMinimumAlertRecipients` — The agent assigned to the group is always included; this list adds ops/admin recipients.
- `autoApproveGroupTypeChanges` — When `true`, group type change requests from agents in this tenant are approved immediately on submission with no human review. The request is still logged to `oe.GroupTypeChangeRequests` (with `Status='Approved'`, `ReviewedBy=<system user>`, `ReviewNotes='Auto-approved per tenant setting'`) for audit. Defaults to `false`.

### 4.5 `oe.GroupProducts` — no schema change

List-fill groups use the same `oe.GroupProducts` table, but the products attached will have `SalesType IN ('Individual', 'Both')`. No structural change needed; enforcement lives in the product picker UI and a backend validation layer that reads `Groups.GroupType`.

---

## 5. Feature A — Vendor Minimum Enforcement

### 5.1 Minimum calculation ("strictest wins")

For a given group, compute:

```
applicableMinimum = MAX(
  vendor.MinimumEmployeesPerGroup
  FOR vendor IN DISTINCT vendors across the group's active, non-hidden GroupProducts
  WHERE vendor.MinimumEmployeesPerGroup IS NOT NULL
)
```

If no product's vendor has a minimum set, the group has no minimum — skip all checks.
If `Groups.GroupType = 'ListBill'`, skip all checks regardless.

### 5.2 Effective date resolution

The "1st" we are counting toward = the **earliest future effective date** that any pending or in-flight enrollment on the group would land on. In practice today this is next month's 1st. Post PR #90, this must read from Rich's `groupEnrollmentCutoff` utility, which already tells us which 1st-of-month is valid.

### 5.3 The scheduled job

**Location:** `enrollment-nightly-job/EnrollmentNightly` (existing Azure Function, 04:00 UTC daily). Add a new endpoint call:

```
POST /api/scheduled-jobs/below-minimum-check
```

**Backend service:** `services/belowMinimumCheckService.js` (new).

**Algorithm (daily):**

1. For each tenant, find all `Standard` groups with `applicableMinimum > 0`.
2. For each group, compute `effectiveDateTarget` (see 5.2).
3. Count primary members on the group with `Status = 'Active'` and `EffectiveDate = effectiveDateTarget`.
4. Compare to `applicableMinimum`. If below:
   - If `daysUntil(effectiveDateTarget) == 10` and no prior T-10 alert sent for this (group, effectiveDateTarget), send warning email.
   - If `daysUntil(effectiveDateTarget) <= 5`, set a lock flag (see 5.4) and send lock email if not yet sent.
5. Record emails sent in a small `oe.GroupMinimumAlerts` dedup table (`GroupId`, `EffectiveDate`, `AlertType`, `SentAt`) so we never double-send.

### 5.4 The lock

A group is "locked" when `daysUntil(effectiveDateTarget) <= 5` AND below minimum AND `GroupType = 'Standard'`.

**Implementation:** No new column. Derived at request time from the same calculation. The enrollment-link resolver and enrollment-wizard endpoints check this on every request. If locked:
- New members who haven't yet created an `Enrollment` row → blocked with a clear message ("Group enrollment is temporarily paused; please contact your agent")
- Members with an in-flight enrollment (row exists in `Enrollments` with `Status IN ('Pending', 'Pending Payment', 'PaymentHold')`) → allowed to finish

### 5.5 Email content

Two SendGrid templates added to `/backend/templates/emails/`:
- `group-below-minimum-warning.html` — T-10 ("hurry up, X members, need Y")
- `group-below-minimum-lock.html` — T-5 ("enrollment paused, convert to list bill or add members")

Recipients:
- The group's agent (always)
- All addresses in tenant `advancedSettings.enrollment.belowMinimumAlertRecipients`

### 5.6 Vendor admin UI

New field in `Vendors.tsx` (SysAdmin → Vendors → edit):
- Label: **Minimum employees per group**
- Control: number input, optional, min 0
- Help text: "Leave blank for no minimum. Example: Tall Tree = 5. Groups below this number will receive automated warnings and enrollment locks before their effective date."

---

## 6. Feature B — List-Bill Group Type

### 6.1 Creation (agent-initiated)

In `/frontend/src/pages/groups/GroupsAddGroup.tsx`, add a group-type selector near the top of the form:

```
Group Type:
  ( • ) Standard Group
  (   ) List Bill  — for groups with fewer than {N} employees, where {N} is the minimum
                     required by your selected vendor(s). List-fill groups enroll members
                     into individual products billed together.
```

The disclaimer's `{N}` updates as the agent selects products (pulled from the strictest vendor minimum among chosen products). If no products are selected yet, show a generic disclaimer.

On submit, write `GroupType` to `oe.Groups`. If `ListBill`, the product picker filters to `SalesType IN ('Individual', 'Both')` across the whole tenant (widest net — agent can swap across vendors).

### 6.2 Behavior differences (exhaustive list)

| Area | Standard | ListBill |
|---|---|---|
| Vendor minimum check | Enforced | Skipped |
| T-10 / T-5 emails & lock | Enforced | Skipped |
| Group products filter | `SalesType IN ('Group', 'Both')` | `SalesType IN ('Individual', 'Both')` |
| Billing | Group-level payment method, one monthly charge | Identical |
| Contributions | Employer contributions on group | Identical |
| Group admin access | Yes | Yes |
| Agent/tenant-admin views | Appears in groups list | Identical + "List Bill" badge |
| Enrollment links | Group + member links | Identical |
| Vendor eligibility export | Exports as group | Exports individuals (mechanics TBD with vendor) |

### 6.3 Visual label

A pill/badge with the text **"List Bill"** (simple, clear) rendered:
- Groups list rows (agent/tenant-admin/sysadmin)
- Group detail page header (all tabs)
- Enrollment link creation screens
- Anywhere the group name is shown with enough space

Uses existing Tailwind conventions (per `CLAUDE.md`): `bg-oe-light text-oe-dark` or similar small pill.

### 6.4 Exempt from minimums — enforcement

Every place that reads a vendor minimum gates on `Groups.GroupType = 'Standard'` first. Centralize this in a single helper:

```js
// services/vendorMinimumService.js
function computeApplicableMinimum(groupId) {
  const group = await fetchGroup(groupId);
  if (group.GroupType === 'ListBill') return null; // exempt
  // ... strictest-wins math
}
```

---

## 7. Type Conversion Flow (request queue)

### 7.1 Agent initiates

In the group detail page (probably `GroupSettingsTab.tsx` or a new "Group Type" section), the agent sees:

- Current group type
- Button: **Request type change**
- Modal collects: target type, reason (free text)

On submit → `POST /api/group-type-change-requests` creates a row in `oe.GroupTypeChangeRequests`. Behavior branches on the tenant's `advancedSettings.enrollment.autoApproveGroupTypeChanges`:

- **Auto-approve = false (default):** Row is created with `Status='Pending'`. Agent sees "Request pending tenant-admin approval" on the group. TenantAdmins of the agent's tenant receive an email notification with a link to the queue.
- **Auto-approve = true:** Row is created with `Status='Approved'`, `ReviewedBy=<system user id>`, `ReviewedAt=now()`, `ReviewNotes='Auto-approved per tenant setting'`. `Groups.GroupType` is updated immediately. Agent lands directly in the post-approval wizard (Section 7.3). Full audit trail preserved.

### 7.2 TenantAdmin reviews

New page surfaced in the **TenantAdmin** portal: `/tenant-admin/group-type-change-requests` (or a section in an existing tenant-admin settings area). Scope is tenant-isolated — a TenantAdmin only sees requests for groups in their own tenant, enforced by `requireTenantAccess` middleware.

Queue columns:
- Group name, current/requested type, requesting agent, reason, request date
- **Approve** and **Deny** buttons; deny requires notes

On **approve**:
1. Update `Groups.GroupType` to requested value.
2. Set request `Status = 'Approved'`, record `ReviewedBy`, `ReviewedAt`.
3. Email the agent: "Your request has been approved. Click here to finish the switch."
4. The link returns them to the post-approval wizard on the group.

**Tenant-admin setting surface:** The auto-approval toggle lives in the existing TenantAdmin settings UI (`UnifiedTenantSettingsModal.tsx` or similar), grouped under "Enrollment" with help text: *"When enabled, agents in this tenant can convert groups between Standard and List Bill without TenantAdmin review. Requests are still logged for audit."*

**SysAdmin override:** SysAdmins can view and act on requests across all tenants via a cross-tenant variant of the same page, but the primary actor is the TenantAdmin.

### 7.3 Post-approval wizard (agent)

Triggered when an approved request exists for a group. Steps:

**Step 1 — Review existing enrollments:**
- Show all members with existing enrollments.
- For each: identify whether the original group product has an individual-SKU equivalent available in the tenant. If yes, system suggests "keep" (no action needed); if no, mark "needs re-enrollment."
- Any enrollment with `EffectiveDate` already in the past / `Status = 'Active'` and coverage already started → flagged as **"let finish the month, then cancel"** (noted for future action, not cancelled now).
- Any enrollment with `EffectiveDate` in the future and no matching individual SKU → **cancel on completion** (via `cancelFutureEnrollment()`).

**Step 2 — Pick individual products:**
- Agent selects from `SalesType IN ('Individual', 'Both')` across the whole tenant.
- These become the new `GroupProducts` rows.
- Old group-only products become hidden (`GroupProducts.IsHidden = 1`), not deleted — preserves audit.

**Step 3 — Clear HouseholdMemberIds for affected members:**
- Tenants use a prefix-based HouseholdMemberId scheme (e.g., `MW` for group enrollments, `SW` for individual/list-bill enrollments) — see `backend/utils/householdMemberIdPrefix.js`.
- Members who had a group enrollment removed as part of the switch have a `MW`-prefixed HouseholdMemberId that is now wrong for their new list-bill context.
- On conversion, the wizard **nulls out `HouseholdMemberId` on every affected member record** so the correct prefix is regenerated on their next enrollment.
- This reuses the logic in `backend/routes/admin/update-member-household-id.js` — centralize in a helper (`services/householdMemberIdService.clearForMembers(memberIds)`) and call from the conversion wizard *and* from any cancellation path that might run outside the wizard.
- Scope: only members whose group-plan enrollment was actually removed. Members whose enrollments were preserved (because an individual-SKU equivalent existed) keep their IDs.

**Step 4 — Resend links:**
- For members flagged "needs re-enrollment" → system creates new member-scoped links via `EnrollmentLinkService.createEnrollmentLink()` and queues emails via `MessageQueueService`.
- Agent confirms the send.
- When the member completes enrollment via the new link, the HouseholdMemberId is regenerated with the correct `SW` prefix (because it was cleared in Step 3).

**Step 5 — Confirmation:**
- Summary of what happened: X enrollments preserved, Y cancelled, Z HouseholdMemberIds cleared, W links sent.

### 7.4 Converting ListBill → Standard

Same approval queue, same wizard skeleton. Post-approval:
- Verify the group meets the vendor minimum *now*; if not, warn the TenantAdmin before approval.
- Wizard prompts agent to pick group products (re-filter to `Group` / `Both`).
- Existing list-bill enrollments stay unless explicitly cancelled.
- Any member whose list-bill enrollment is cancelled as part of the switch back also has their HouseholdMemberId cleared, so the correct group prefix (e.g., `MW`) regenerates on their next enrollment. Same helper as Step 3 above.

---

## 8. Integration with PR #90

PR #90 adds a tenant-level day-of-month cutoff that answers "which 1st of the month is the valid effective date?" This directly feeds our `effectiveDateTarget` calculation.

**Recommendation:**
1. Merge PR #90 first.
2. Our service imports `parseGroupEnrollmentCutoffFromAdvancedSettings` and `adjustFixedDateForGroupEnrollmentCutoff` from `backend/utils/groupEnrollmentCutoff.js`.
3. Our T-10/T-5 math targets the adjusted date, never the raw "next month's 1st." This avoids double-counting and means a group pushed to the following month by the cutoff gets its warnings and lock calibrated correctly.

If PR #90 stalls, we can ship our feature with the naive "next month's 1st" assumption and layer in the cutoff later. But the correct end state is coordinated.

---

## 9. UI Inventory

### Frontend files to touch

| File | Change |
|---|---|
| `frontend/src/pages/admin/Vendors.tsx` | Add `minimumEmployeesPerGroup` field |
| `frontend/src/pages/groups/GroupsAddGroup.tsx` | Add GroupType picker + dynamic disclaimer |
| `frontend/src/pages/groups/GroupSettingsTab.tsx` | Add "Request type change" button & modal |
| `frontend/src/pages/groups/GroupsPage.tsx` (and admin equivalents) | Render "List Bill" badge |
| `frontend/src/pages/groups/GroupProductsTab.tsx` | Filter product picker by group type |
| `frontend/src/components/enrollment-wizard/EnrollmentWizard.tsx` | Enforce T-5 lock for new members; allow mid-flow |
| NEW `frontend/src/pages/tenant-admin/GroupTypeChangeRequests.tsx` | TenantAdmin approval queue (primary) |
| NEW `frontend/src/pages/admin/GroupTypeChangeRequests.tsx` | SysAdmin cross-tenant view of same queue (override) |
| `frontend/src/components/UnifiedTenantSettingsModal.tsx` | Add "Auto-approve group type changes" toggle under Enrollment section |
| NEW `frontend/src/pages/groups/GroupTypeChangeWizard.tsx` | Post-approval wizard (steps 1–4) |
| `frontend/src/components/branding/GroupBadge.tsx` (new small component) | Reusable "List Bill" pill |

### Backend files to touch

| File | Change |
|---|---|
| `backend/routes/vendors.js` | Accept `minimumEmployeesPerGroup` in PUT/GET |
| `backend/routes/agent/agent-groups.js` | Accept `GroupType` on create |
| `backend/routes/me/sysadmin/groups.js`, `tenant-admin/groups.js` | Return `GroupType` |
| NEW `backend/routes/group-type-change-requests.js` | CRUD for requests; approval scoped by `requireTenantAccess`; auto-approval branch reads tenant setting |
| NEW `backend/services/belowMinimumCheckService.js` | Daily check + email send |
| NEW `backend/services/vendorMinimumService.js` | `computeApplicableMinimum(groupId)` helper |
| NEW `backend/services/householdMemberIdService.js` | `clearForMembers(memberIds)` — nulls HouseholdMemberId so the correct prefix regenerates; wraps existing logic from `routes/admin/update-member-household-id.js` |
| `backend/routes/scheduled-jobs.js` | Add `/below-minimum-check` endpoint |
| `backend/routes/enrollment-links.js` | Enforce T-5 lock in link resolver |
| `backend/templates/emails/` | Add `group-below-minimum-warning.html`, `group-below-minimum-lock.html`, `group-type-change-approved.html` |
| `enrollment-nightly-job/EnrollmentNightly/index.js` | Add POST to new endpoint |

### Database migrations

| File | Change |
|---|---|
| `sql-changes/2026-XX-XX-vendor-minimum-employees-per-group.sql` | `oe.Vendors.MinimumEmployeesPerGroup` |
| `sql-changes/2026-XX-XX-groups-group-type.sql` | `oe.Groups.GroupType` default 'Standard' |
| `sql-changes/2026-XX-XX-group-type-change-requests.sql` | New table |
| `sql-changes/2026-XX-XX-group-minimum-alerts.sql` | Dedup table for sent alerts |

---

## 10. Phased Rollout

Recommended order — each phase is independently shippable:

**Phase 1 — Vendor setting + sysadmin UI (low risk)**
- Add `MinimumEmployeesPerGroup` column and vendor admin field.
- No enforcement yet. SysAdmins can enter values to prepare.

**Phase 2 — ListBill group type (medium)**
- Add `GroupType` column with default `Standard`.
- Creation form gets the picker; badge added everywhere.
- Product filter enforced.
- No conversion flow yet.

**Phase 3 — Type conversion request queue (medium)**
- Request table + agent UI + TenantAdmin approval queue (with SysAdmin cross-tenant override view).
- Tenant setting `autoApproveGroupTypeChanges` + toggle in tenant settings UI.
- Post-approval wizard for product selection and link resend.

**Phase 4 — T-10 warning (low-medium)**
- New scheduled job + warning email.
- Observe behavior for a cycle before adding the lock.

**Phase 5 — T-5 lock (medium-high, last)**
- Enforce lock in enrollment-link resolver and wizard.
- Add lock email.
- Coordinate with merge of PR #90.

**Phase 6 — Polish**
- Dashboards for sysadmin: groups approaching minimum thresholds this cycle.
- Vendor-level reporting on list-bill vs standard ratios.

---

## 11. Open Questions & Deferred Items

1. **Vendor eligibility export for list-bill groups.** The export currently groups members under a single vendor group ID. List-fill members buying individual SKUs may need to be exported differently (or not at all — they might be individual-policy exports). Needs a vendor-by-vendor confirmation.

2. **Refunds for pre-paid enrollments during conversion.** V1 assumes payment happens at/after effective date. If that assumption is ever wrong in practice, we'll need a refund workflow — out of scope now.

3. **Auto-promotion of list-bill → standard.** Deferred. A list-bill group that later exceeds the vendor minimum stays list-bill until sysadmin manually converts it, per this design. Revisit if that friction becomes a complaint.

4. **Mid-month effective dates (the 15th).** The user has flagged this as future work. The design assumes first-of-month only; all T-10/T-5 math uses that single anchor. When mid-month support lands, the anchor becomes per-enrollment and the deadline math needs a small generalization — but not a rewrite.

5. **What happens if a vendor's minimum is lowered mid-cycle?** If a group was previously locked and the minimum is lowered such that the group now qualifies, should the lock auto-release? Recommended: yes, since the lock is derived at request time, not persisted. But this should be explicitly tested.

6. **Does the "strictest wins" rule apply cross-tenant?** No — vendor minimums are global (per vendor), and the group-to-vendor link is via products. Each tenant's groups compute independently.

---

## 12. Success Criteria

- A vendor admin can set `minimumEmployeesPerGroup` and see it honored across agent flows.
- An agent creating a group can explicitly choose `Standard` or `List Bill`, and the UI clearly communicates what each means.
- A group about to miss its vendor's minimum receives an email at T-10 and is locked to new enrollments at T-5, automatically, with no human intervention.
- An agent can request a type change and see it resolved by their TenantAdmin (or auto-approved, if the tenant has opted in) without a manual support ticket.
- Post-approval, the agent can complete the switch (product swap, link resend) in a single guided wizard.
- No existing standard groups experience behavior changes until a vendor minimum is set and their group falls below it.
