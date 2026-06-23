# Group Enrollment Links — Master Guide

> Complete reference for how group enrollment links work after the `feature/group-enrollment-link-redesign` branch. Covers the problems solved, the new architecture, migration of existing data, and how every scenario is handled.

---

## Table of Contents

1. [The Problems](#1-the-problems)
2. [The Solution: Single Source of Truth](#2-the-solution-single-source-of-truth)
3. [How Group Enrollment Links Work Now](#3-how-group-enrollment-links-work-now)
4. [Template Lifecycle](#4-template-lifecycle)
5. [Sending Enrollment Links](#5-sending-enrollment-links)
6. [Product Visibility — The IsHidden Flag](#6-product-visibility--the-ishidden-flag)
7. [What Happens to Existing Templates](#7-what-happens-to-existing-templates)
8. [Database Schema Changes](#8-database-schema-changes)
9. [Backend API Changes](#9-backend-api-changes)
10. [Frontend UI Changes](#10-frontend-ui-changes)
11. [Migration Scripts](#11-migration-scripts)
12. [FAQ / Edge Cases](#12-faq--edge-cases)

---

## 1. The Problems

### Problem 1: Two Sources of Truth for Products

Before this branch, the system had **two independent places** that defined which products a group offers:

| Source | Where | Used By |
|--------|-------|---------|
| `oe.GroupProducts` | Database table | Group management, billing, reports |
| `EnrollmentLinkTemplates.LinkMetaData.products` | JSON blob inside the template | Enrollment wizard |

An agent could assign 6 products to a group in `oe.GroupProducts`, but the enrollment link template might list 4 different products in its `LinkMetaData.products` JSON. Members enrolling through the link would see a different set of products than what the group actually offered. These two lists could silently drift apart with no warning.

### Problem 2: Manual Template Management Was Error-Prone

Agents had to manually create and maintain Group enrollment link templates through the Enrollment Link Templates page. This required:
- Navigating to a separate page from the group
- Hand-picking products (duplicating what was already in GroupProducts)
- Remembering to update the template whenever group products changed
- Understanding the template form and its options

Most agents created a template once and never updated it, leading to stale product lists.

### Problem 3: No Safe Way to Retire Products

When an agent removed a product from a group (`oe.GroupProducts.IsActive = 0`), there was no middle ground:
- The product disappeared from **all** queries that check `IsActive = 1`
- Existing members enrolled in that product could lose access to their `CustomSettings` (configuration data stored on the GroupProducts row)
- The enrollment wizard would no longer show the product, even to members who were already enrolled
- There was no way to say "stop offering this to new members, but keep it working for existing ones"

---

## 2. The Solution: Single Source of Truth

### Core Principle

**`oe.GroupProducts` is now the single source of truth for which products a group offers.** The enrollment wizard fetches products from this table at runtime, not from the template's LinkMetaData JSON.

### What the Template Stores Now

A group enrollment link template is now a lightweight container holding only:

| Field | Purpose |
|-------|---------|
| `TemplateId` | Unique identifier |
| `TemplateName` | Display name (e.g., "Acme Corp Group Enrollment") |
| `TemplateType` | Always `'Group'` |
| `GroupId` | Links template to its group |
| `AgentId` / `TenantId` | Ownership |
| `LinkMetaData.household` | Household collection settings (collectSSN, collectDOB, etc.) |
| `IsActive` | Whether the template is active |

The `LinkMetaData.products` array, if present from an older template, is **ignored** for Group-type links. Products are always fetched fresh from `oe.GroupProducts`.

### The IsHidden Flag

A new `IsHidden` column on `oe.GroupProducts` enables three states:

| IsActive | IsHidden | Meaning |
|----------|----------|---------|
| 1 | 0 | **Available** — shown to new enrollees, fully functional |
| 1 | 1 | **Hidden** — not shown to new enrollees, but existing enrollments and their CustomSettings are preserved |
| 0 | any | **Removed** — only allowed when zero members have active/pending enrollments in this product |

---

## 3. How Group Enrollment Links Work Now

### The Flow (New Enrollment)

```
Agent assigns products to group (GroupProducts tab)
        |
        v
System auto-creates Group template if none exists
(stores household settings, NOT products)
        |
        v
Agent clicks "Send Links" on Members tab
        |
        v
System shows template name (read-only, no dropdown)
Agent selects members and delivery method
        |
        v
System creates individual EnrollmentLink tokens per member
Sends email/SMS with unique enrollment URL
        |
        v
Member opens enrollment URL
        |
        v
Enrollment wizard calls GET /:linkToken/enrollment-data
        |
        v
Backend detects TemplateType = 'Group' with TemplateGroupId
Fetches products from oe.GroupProducts WHERE IsActive=1 AND IsHidden=0
Groups by ProductType into sections
        |
        v
Member sees current group products and enrolls
```

### Key Point

Products are resolved **at the moment the member opens the link**, not when the link was created. If an agent adds or removes products from the group between sending the link and the member opening it, the member sees the updated list.

---

## 4. Template Lifecycle

### Auto-Creation

Templates are automatically created in two scenarios:

1. **Group creation with products** — When an agent creates a new group and assigns products via `POST /api/agents/groups`, the backend auto-creates a Group template with default household settings (all collection enabled).

2. **Product assignment to existing group** — When products are saved via `PUT /api/groups/:groupId/products` and no Group template exists yet, one is auto-created.

### No Manual Creation Needed

The Enrollment Link Templates page (`EnrollmentLinkTemplates.tsx`) now filters to `TemplateType = 'Individual'` only. Group templates are completely hidden from this UI. Agents never need to create, edit, or think about Group templates.

### Where Templates Are Visible

Agents interact with group templates implicitly through:
- **Group Products tab** — Shows the template name with a "Preview Enrollment" button
- **Send Links dialog** (Members tab) — Shows the template name (read-only) with a "View Details" button that opens the same enrollment preview modal

### Household Settings

Household collection settings (collectSSN, collectDOB, collectGender, collectAddress, collectPhone) are stored in the template's `LinkMetaData.household` JSON. These are configured:
- At group creation time (defaults to all enabled)
- Can be updated when saving group products if `householdCollection` is passed in the request body

---

## 5. Sending Enrollment Links

### From the Members Tab

1. Agent selects members on the group's Members tab
2. Clicks "Send Links"
3. The `SendEnrollmentDialog` opens showing:
   - **Enrollment Template** — Read-only display of the template name with a "View Details" button (no dropdown when there's exactly one template)
   - **Delivery Method** — Email and/or SMS checkboxes
   - **Member list** — Selected members with email/phone info
4. Agent clicks "Send X Links"
5. Backend creates individual `oe.EnrollmentLinks` rows (one per member) with unique tokens
6. Emails/SMS are sent with the enrollment URL

### View Details Button

The "View Details" button opens an enrollment preview modal that shows exactly the products members will see when they open the link. This fetches from `oe.GroupProducts` with the same filters as the enrollment wizard (`IsActive = 1`, `IsHidden = 0`), so what the agent sees matches what members will see.

### Legacy Multi-Template Case

If a group somehow has more than one active Group template (from legacy data), the dialog falls back to a dropdown with all templates pre-selecting the first one. This should only happen for the MightyWELL group (now resolved — the duplicate was deactivated).

---

## 6. Product Visibility — The IsHidden Flag

### The Problem It Solves

An agent needs to stop offering a product to new members, but existing members are already enrolled. Removing the product (`IsActive = 0`) would break their enrollment data. Keeping it active means new members can still select it.

### How It Works

**Hiding a product:**
- Agent clicks the eye-off icon on a product in the Group Products tab
- Calls `PATCH /api/groups/:groupId/products/:productId/visibility` with `{ isHidden: true }`
- Sets `oe.GroupProducts.IsHidden = 1`
- Product shows "Hidden" badge in the UI
- Product is excluded from enrollment wizard for new enrollees
- Product's `CustomSettings` remain accessible for existing enrollments

**Unhiding a product:**
- Agent clicks the eye icon (shown in green when product is hidden)
- Same endpoint with `{ isHidden: false }`
- Product reappears in enrollment wizard

**Removing a product:**
- Only allowed when zero members in the group have active/pending enrollments in that product
- If enrollments exist, the system returns: *"Cannot remove a product that members are enrolled in. Use the hide option to prevent new enrollments while keeping existing ones active."*

### Query Behavior

| Query | Sees hidden products? | Why |
|-------|----------------------|-----|
| Enrollment wizard (new enrollment) | No | New members shouldn't see retired products |
| CustomSettings fetch | Yes | Existing enrollments need their configuration |
| Group Products tab | Yes (with "Hidden" badge) | Agents need to see and manage all products |
| Member portal (already enrolled) | Yes | Members keep access to products they're enrolled in |
| Enrollment preview modal | No | Shows what new members will see |

---

## 7. What Happens to Existing Templates

### Category A: Manually-Created with Custom Household Settings (5 groups)

**Groups:** Keith McDonald Plumbing, Loiselle & Associates, AiOS Group, Neal's Heating & Cooling, HPH Mechanical

These templates were created by agents/admins who explicitly configured household collection. They set `collectSSN: true` but turned off DOB, gender, address, and phone collection.

**What happens:** Templates are preserved exactly as-is. Their household settings continue to be honored by the enrollment wizard. The `products` array in their LinkMetaData is ignored — products come from `oe.GroupProducts` at runtime. These templates have sent 7–60 links each and remain fully functional.

### Category B: Auto-Created with NULL Household Settings (13 groups)

**Groups:** Vision Eye Group, Hybrid Turf Care, Killgore & Associates, and 10 others

These were created by an earlier auto-create flow. Their LinkMetaData has product sections but NULL household settings, so the enrollment wizard uses its built-in defaults (collect everything).

**What happens:** Functionally identical to the new auto-created templates. No action needed. They've sent 2–14 links each.

### Category C: MightyWELL (1 group)

Had two active templates. The older one ("MightyWELL Group Master Link", 1 link sent) was deactivated. The active one ("New Plans Group Test Link", 14 links sent) remains.

### Category D: Auto-Created by Migration Script (21 groups)

These groups never had a Group template. The migration script `2026-04-10-auto-create-group-enrollment-templates.sql` created one for each with default household settings (all collection enabled) and no stored products.

**Groups include:** Cramerton Christian Academy (78 members, 289 enrollments — the largest group in the system), Springfield Lorton Dental, CH Roofing, Brian Robinson Coaching, and 17 others.

### Summary

- **0 templates deleted** — every existing template stays active
- **0 settings lost** — household configurations are preserved
- **21 templates created** — for groups that previously had none
- **1 duplicate deactivated** — MightyWELL's old template
- **Product lists in old templates are ignored** — products always come from GroupProducts

---

## 8. Database Schema Changes

### New Column: `oe.GroupProducts.IsHidden`

```sql
ALTER TABLE oe.GroupProducts
  ADD IsHidden BIT NOT NULL
    CONSTRAINT DF_GroupProducts_IsHidden DEFAULT (0);
```

Migration file: `sql-changes/2026-04-10-group-products-is-hidden.sql`

### Auto-Created Templates

Migration file: `sql-changes/2026-04-10-auto-create-group-enrollment-templates.sql`

Inserts a Group template for every active group missing one, using the group's AgentId, TenantId, and default household settings.

---

## 9. Backend API Changes

### Modified Endpoints

**`GET /api/groups/:groupId/products`**
- Now returns `GroupProductIsHidden` from `oe.GroupProducts.IsHidden`
- Response `IsHidden` field is now: `GroupProductIsHidden || Products.IsHidden || 0` (group-level flag takes precedence)

**`PUT /api/groups/:groupId/products`**
- Error message when trying to remove a product with active enrollments updated to suggest using the hide option

**`GET /api/enrollment-links/:linkToken/enrollment-data`**
- GroupProducts query now includes `AND (gp.IsHidden IS NULL OR gp.IsHidden = 0)` to exclude hidden products from the enrollment wizard
- CustomSettings query is unchanged — hidden products still return their configuration for existing enrollments

### New Endpoint

**`PATCH /api/groups/:groupId/products/:productId/visibility`**

Toggles the `IsHidden` flag on a group product.

- **Auth:** SysAdmin, TenantAdmin, Agent, GroupAdmin
- **Body:** `{ isHidden: boolean }`
- **Response:** `{ success: true, message: "Product hidden from new enrollments" | "Product visible for new enrollments" }`

---

## 10. Frontend UI Changes

### Enrollment Link Templates Page (`EnrollmentLinkTemplates.tsx`, `TenantAdminEnrollmentLinkTemplates.tsx`)
- Filters to `TemplateType = 'Individual'` only
- Group templates are completely hidden from this page

### Group Products Tab (`GroupProductsTab.tsx`)
- Shows enrollment template info with "Preview Enrollment" button
- Products table has a new hide/unhide toggle icon in the Actions column
- Hidden products display a "Hidden" badge
- Preview modal shows only non-hidden, active products (matching what the enrollment wizard shows)

### Group Members Tab — Send Links Dialog (`GroupMembersTab.tsx`)
- Template section is read-only (no dropdown) when there's one template
- Shows template name with "View Details" button
- View Details opens enrollment preview modal showing exact products members will see
- Falls back to dropdown only if multiple templates exist (legacy edge case)

### Group Creation (`GroupsAddGroup.tsx`)
- Product removal error message updated to guide toward hiding
- Auto-creates template on group creation with products

---

## 11. Migration Scripts

### Run Order

These must be run before deploying the branch:

1. `sql-changes/2026-04-10-group-products-is-hidden.sql` — Adds the IsHidden column
2. `sql-changes/2026-04-10-auto-create-group-enrollment-templates.sql` — Creates templates for groups without one

### Already Run On

- **Testing DB** (`allaboard-testing`) — both migrations applied 2026-04-10

### Not Yet Run On

- **Production DB** (`allaboard-prod`) — pending deployment

### One-Time Data Fix

- MightyWELL's duplicate template (`DF4F40D4-0DEE-4D00-A59E-85DEB31527DD`) was deactivated (`IsActive = 0`) on both testing and prod databases.

---

## 12. FAQ / Edge Cases

### Q: What if an agent adds a product to the group after sending enrollment links but before members open them?

The member will see the new product. Enrollment links resolve products at open time, not at send time.

### Q: What if an agent hides a product after sending links but before a member enrolls?

The member will NOT see the hidden product when they open the link. The link is still valid — it just won't show that product.

### Q: What if a member is already enrolled in a product and the agent hides it?

Nothing changes for the member. Their enrollment is active, their CustomSettings are preserved, and they can still view the product in their member portal. The product just won't appear for new enrollees.

### Q: Can an agent delete a product from a group if members are enrolled?

No. The system blocks removal with: *"Cannot remove a product that members are enrolled in. Use the hide option to prevent new enrollments while keeping existing ones active."*

### Q: What happens to the old product lists stored in template LinkMetaData?

They're ignored. The enrollment-data endpoint checks `TemplateType === 'Group' && TemplateGroupId` — when both are true, it fetches from `oe.GroupProducts` instead of reading `LinkMetaData.products`. The old data stays in the JSON harmlessly.

### Q: Can an agent still create Individual enrollment link templates?

Yes. Individual templates are completely unaffected by this change. They still store their own product lists in LinkMetaData and work exactly as before. Only Group-type templates use the new GroupProducts-based flow.

### Q: What if a group has no products assigned?

The enrollment preview will show "No active products assigned to this group." The agent can still send links, but members opening them will see no products to enroll in. The system doesn't block sending — the agent may be about to add products.

### Q: How do household collection settings get configured?

Currently through the backend when creating/updating group products (the `householdCollection` field in the PUT request body). There is no dedicated UI for editing household settings on existing groups yet — this is a future enhancement. Existing settings from manually-created templates are preserved.

### Q: What happens if the auto-create template migration is run twice?

Nothing. The INSERT uses `NOT EXISTS` to check for an existing active Group template, so it's idempotent.

---

## Files Changed on This Branch

### Backend
| File | Change |
|------|--------|
| `backend/routes/enrollment-links.js` | Fetch products from GroupProducts for group links; exclude hidden products |
| `backend/routes/groupProducts.js` | Return IsHidden; add visibility toggle endpoint; auto-create templates; update error messages |
| `backend/routes/agent/agent-groups.js` | Auto-create template on group creation |
| `backend/routes/groups.js` | Auto-create template on group product updates |

### Frontend
| File | Change |
|------|--------|
| `frontend/src/pages/groups/GroupProductsTab.tsx` | Hide/unhide toggle; enrollment preview; read-only template display |
| `frontend/src/pages/groups/GroupMembersTab.tsx` | Read-only template in send dialog; view details button; enrollment preview modal |
| `frontend/src/pages/groups/GroupEnrollmentLinksTab.tsx` | Token management and status display |
| `frontend/src/pages/groups/GroupsAddGroup.tsx` | Product assignment with auto-template; updated error messages |
| `frontend/src/pages/enrollment-links/EnrollmentLinkTemplates.tsx` | Filter to Individual templates only |
| `frontend/src/pages/tenant-admin/TenantAdminEnrollmentLinkTemplates.tsx` | Filter to Individual templates only |
| `frontend/src/services/group-products.service.ts` | Added toggleProductVisibility method |
| `frontend/src/components/enrollment-wizard/steps/BasicInfoStep.tsx` | Uses group ID for enrollment data |

### SQL Migrations
| File | Purpose |
|------|---------|
| `sql-changes/2026-04-10-group-products-is-hidden.sql` | Add IsHidden column to oe.GroupProducts |
| `sql-changes/2026-04-10-auto-create-group-enrollment-templates.sql` | Create templates for groups without one |
