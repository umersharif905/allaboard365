# Vendor Minimums & List-Bill Groups — Ops Guide

**Feature area:** Enrollment management  
**Affected roles:** SysAdmin, TenantAdmin, Agent  
**Related spec:** `docs/superpowers/specs/2026-04-23-vendor-minimums-and-list-bill-groups-design.md`

---

## Overview

Two coupled features protect against submitting under-enrolled groups to carriers:

1. **Vendor minimums** — Each vendor can require a minimum number of enrolled employees per group. Groups that fall short receive an automated warning email 10 days before their effective date (T-10) and are locked to new enrollees 5 days before (T-5).

2. **List-Bill groups** — A group type that exempts a group from vendor minimums by using individual-SKU products instead of group products. Billing, contributions, group admin access, and reporting work identically to standard groups. This is the primary recovery path when a group cannot reach the vendor minimum.

---

## 1. Vendor Minimum Setting

### What it does

The `minimumEmployeesPerGroup` setting on a vendor defines the smallest number of active primary members that a Standard group must have enrolled before its effective date. If a group's active enrollment count falls below this threshold in the 10-day window before the effective date, automated warnings and locks kick in.

The strictest rule across all vendors associated with a group's products applies ("strictest wins"). If two vendors are attached to a group's products and Vendor A requires 3 and Vendor B requires 5, the group must reach 5.

List-Bill groups are always exempt from the minimum check, regardless of vendor settings.

### How to set it (SysAdmin)

1. Navigate to **SysAdmin → Vendors**.
2. Open the vendor you want to configure.
3. Find the **Minimum employees per group** field (under Integration Settings or Enrollment Rules).
4. Enter a non-negative integer. Leave blank (null) for no minimum.
5. Save. The change takes effect on the next nightly check run.

**Example:** Tall Tree requires 5 employees per group → set `minimumEmployeesPerGroup = 5` on the Tall Tree vendor record.

---

## 2. Automated Warnings and Locks (T-10 / T-5)

### What triggers them

The **`BillingNightly`** Azure Function (`billing-nightly-job/BillingNightly`, 04:15 UTC, after enrollment cleanup) calls `POST /api/scheduled-jobs/below-minimum-check` when `BELOW_MINIMUM_CHECK_ENDPOINT_URL` is configured. For every Standard group with at least one vendor minimum set, the job:

1. Resolves the group's upcoming effective date (next valid 1st of month, accounting for any tenant-level enrollment cutoff date).
2. Counts primary members with `Status = Active` on that effective date.
3. Compares the count to the strictest applicable vendor minimum.

If the group is below the minimum, the job evaluates which alerts to send based on days remaining.

### T-10 warning email

**Trigger:** Exactly 10 days before the effective date and the group is below the minimum. Sent once per (group, effective date) pair.

**Recipients:** The agent assigned to the group, plus any addresses configured in the tenant's `enrollment.belowMinimumAlertRecipients` setting.

**Content summary:**
- Group name and the effective date at risk.
- Current enrollment count vs. required minimum.
- A direct link to the group page.
- Encouragement to recruit more members or convert to List Bill.

### T-5 lock email

**Trigger:** 5 or fewer days before the effective date and the group is still below the minimum. Sent once per (group, effective date) pair.

**Recipients:** Same as T-10.

**Content summary:**
- Confirmation that new enrollments are now paused for the group.
- Members already mid-enrollment (an Enrollment row exists in Pending/Pending Payment/PaymentHold status) can finish; no new members can start.
- Options: reach the minimum, or convert to List Bill.
- Links to the group page and to request a List Bill conversion.

### The lock behavior

The lock is derived at request time — there is no stored lock flag. When a member attempts to open a group enrollment link:

- If the group is Standard, below minimum, and within 5 days of its effective date: the link displays a message that enrollment is paused ("Group enrollment is temporarily paused; please contact your agent"). No new enrollment row is created.
- Members who already have an in-flight Enrollment row (Pending, Pending Payment, or PaymentHold) can complete their enrollment normally.

If the vendor minimum is later lowered such that the group now qualifies, the lock releases automatically on the next request — it is not a stored state.

---

## 3. List-Bill Group Type

### What it is

A List-Bill group uses individual-SKU products (products with `SalesType = Individual` or `Both`) instead of the group products used by Standard groups. From the member's perspective, the enrollment experience is the same. Billing, employer contributions, group admin access, and agent views are all identical.

**Key difference:** Vendor minimums and T-10/T-5 alerts do not apply to List-Bill groups.

### Creating a List-Bill group (Agent)

On the **Create Group** form (`/agent/groups/add`):

1. A **Group Type** radio appears near the top: **Standard Group** (default) or **List Bill**.
2. Selecting **List Bill** shows a disclaimer explaining it is for groups with fewer employees than the vendor minimum requires, and that individual products will be used.
3. The disclaimer updates dynamically as products are selected to show the strictest vendor minimum across chosen products.
4. On submit, the group is created with `GroupType = 'ListBill'`.
5. The product picker in a List-Bill group filters to `SalesType IN ('Individual', 'Both')` only.

List-Bill groups are visually marked with a **"List Bill"** badge everywhere the group name appears (groups list, group detail header, enrollment link screens).

---

## 4. Converting Between Group Types

### Agent: requesting a conversion

An agent can request a Standard → ListBill (or ListBill → Standard) conversion from the **Group Settings** tab of any group they manage:

1. Open the group → **Settings** tab.
2. Click **Request type change**.
3. Choose the target type and enter a reason (free text).
4. Submit. The request is logged in `oe.GroupTypeChangeRequests`.

What happens next depends on the tenant's auto-approve setting (see below).

### TenantAdmin: approval queue

TenantAdmins review pending requests at `/tenant-admin/group-type-change-requests`.

Each request shows: group name, current and requested type, requesting agent, agent-supplied reason, and the request date.

**To approve:** Click **Approve**. This updates the group type and emails the agent with a link to the post-approval wizard.

**To deny:** Click **Deny** and enter review notes. The agent is notified and the request is closed.

Scope is tenant-isolated: a TenantAdmin only sees requests for groups in their own tenant.

### Auto-approve setting

TenantAdmins can enable **"Auto-approve group type changes"** in the tenant settings modal (Enrollment section). When enabled:

- Requests are approved immediately on submission with no human review.
- The group type updates instantly; the agent lands directly in the post-approval wizard.
- The request is still logged with `Status = Approved`, `ReviewedBy = <system>`, and `ReviewNotes = 'Auto-approved per tenant setting'` for audit purposes.

Default: off.

### SysAdmin: cross-tenant view

SysAdmins can view and act on group type change requests across all tenants at `/admin/group-type-change-requests`. The behavior is the same as the TenantAdmin queue but unscoped by tenant.

---

## 5. Post-Approval Conversion Wizard

After a request is approved (or auto-approved), the agent completes the conversion through a guided wizard accessible from the group page or the link in the approval email.

### Step 1 — Review existing enrollments

The wizard lists all members with existing enrollments and identifies:

- **Keep (no action):** The original group product has an individual-SKU equivalent. The enrollment is preserved as-is.
- **Needs re-enrollment:** No individual-SKU equivalent exists. The enrollment will be cancelled on wizard completion.
- **Let finish the month:** The enrollment is already active (coverage started). It is flagged for future cancellation but not cancelled now.

### Step 2 — Pick individual products

The agent selects individual-SKU products (`SalesType = Individual` or `Both`) to attach to the group. Old group products are hidden (not deleted), preserving the audit trail.

For a ListBill → Standard conversion, the agent picks group products instead (`SalesType = Group` or `Both`). The wizard also warns if the group does not currently meet the vendor minimum before allowing the switch.

### Step 3 — Confirm (clears HouseholdMemberIds)

On confirmation, for every member whose group-plan enrollment was removed:

- The member's `HouseholdMemberId` is set to null.
- On the member's next enrollment, the correct prefix for the new group type is regenerated automatically (e.g., `SW` for individual/list-bill, `MW` for group enrollments — prefix scheme is tenant-configured).

Members whose enrollments were preserved keep their existing HouseholdMemberIds.

### Step 4 — Resend links

For members flagged "needs re-enrollment," the wizard creates new member-scoped enrollment links and queues emails. The agent confirms the send.

When a member completes enrollment via the new link, their HouseholdMemberId regenerates with the correct prefix.

### Step 5 — Summary

A confirmation screen shows: X enrollments preserved, Y enrollments cancelled, Z HouseholdMemberIds cleared, W links sent.

---

## 6. Tenant Settings Reference

The following settings live in the tenant's `advancedSettings.enrollment` JSON block:

| Setting | Type | Default | Description |
|---|---|---|---|
| `belowMinimumAlertRecipients` | string array | `[]` | Additional email addresses to receive T-10/T-5 alerts. The group's agent is always included. |
| `autoApproveGroupTypeChanges` | boolean | `false` | When true, conversion requests from agents are auto-approved with no TenantAdmin review. |

Admins can configure these via the **TenantAdmin Settings** modal (Enrollment section).

---

## 7. Frequently Asked Questions

**Q: Does a List-Bill group still bill through the group?**  
A: Yes. Billing, employer contributions, payment method management, and the group admin experience are identical to a Standard group.

**Q: Can an agent convert a group without TenantAdmin review?**  
A: Only if the TenantAdmin has enabled "Auto-approve group type changes" for the tenant. Otherwise every conversion request goes through the TenantAdmin approval queue.

**Q: What if the vendor minimum is lowered after a group is locked?**  
A: The lock is derived at request time. If the vendor's minimum is reduced so the group now qualifies, the lock releases immediately on the next enrollment link attempt — no manual intervention needed.

**Q: Are cancelled enrollments during a conversion refunded?**  
A: V1 assumes payment happens at or after the effective date. Retroactive refunds for pre-paid enrollments are out of scope for this release.

**Q: Can a List-Bill group automatically become Standard if it later reaches the minimum?**  
A: No. Auto-promotion is deferred. A List-Bill group stays List-Bill until a conversion is explicitly requested and approved.
