# Group Products Simplification — Manual Test Walkthrough

**Branch:** `group-updates/hide-clearity`
**Spec:** [2026-04-29-group-products-simplification-design.md](../specs/2026-04-29-group-products-simplification-design.md)
**Plan:** [2026-04-29-group-products-simplification-plan.md](../plans/2026-04-29-group-products-simplification-plan.md)

This document walks through every behavior change introduced by the simplification, plus the bug fixes uncovered along the way. It uses a dedicated seeded test group so every scenario is reproducible without relying on production-shaped data.

---

## What changed

| Area | Before | After |
|------|--------|-------|
| Per-row ASA badge column | "Signed / Pending / No ASA Required" pill on each row + per-row "Sign Now" button | Removed |
| ASA signing | Buried in setup tab and per-row buttons | Single banner at top of Products tab, deduped by `documentId` |
| Hide / Show toggle | Per-row Eye / EyeOff button (Tenant + Agent) | Replaced by a small red trash icon labeled "Delete" (Agent + Tenant only) |
| "Show hidden products" checkbox | Visible to Tenant Admin only | Removed (audit section replaces it) |
| Hidden products that still have active enrollments | Mixed into the toggleable list | New read-only **Products with Active Enrollments** section below the active list |
| Re-add a deleted product | No path | Pick it from the existing Add Product flow → flips `IsHidden = 0` on the same row |
| Group Admin product visibility actions | Could toggle Hide/Show via the same UI | Locked out of all delete actions; banner is interactive (signing-enabled) for them |

---

## Bugs fixed during testing

These were uncovered while validating the seed data and aren't part of the original spec, but they shipped on the same branch:

1. **`fix(groups): hidden-with-enrollments query joins Users for member names`** — the new endpoint joined `m.FirstName` / `m.LastName`, but those columns live on `oe.Users`, not `oe.Members`. Added the `Users` join.
2. **`fix(groups): use only per-group GroupProducts.IsHidden as the deleted flag`** — the products-list endpoint was OR'ing `Products.IsHidden` (catalog-wide) with `GroupProducts.IsHidden` (per-group). Catalog-hidden products that were already attached to a group were being incorrectly excluded from the active list. Fixed to use only the per-group flag.
3. **`fix(enrollment-links): exclude per-group deleted products from product-pricing endpoint`** — `GET /api/enrollment-links/:linkToken/product-pricing` was filtering only `Products.IsHidden`, not `GroupProducts.IsHidden`. So a product "deleted" from the group could still appear in the pricing payload. Added the missing filter.

---

## Setup

### Prerequisites

- Backend running on **`http://localhost:3005`** (wt3 port)
- Frontend running on **`http://localhost:5173`**
- Database: `allaboard-testing` on `allboard-prod.database.windows.net` (configured in `backend/.env`)

### Seed the test group

```bash
node backend/scripts/seed-hide-clearity-test-group.js
```

The script is fully idempotent. Re-run it any time to wipe all test data and reseed. Each run prints the new GroupId at the bottom.

What it creates in the agent's tenant (`agent@allaboard365.com`):

| Product | Catalog ASA doc | Active enrollments | `gp.IsHidden` |
|---------|----------------|---------------------|---------------|
| MightyWELL CoPay Basic | HIPAA BAA | 0 | 0 |
| MightyWELL CoPay Gold | HIPAA BAA | 0 | 0 |
| MightyWELL Dental | HIPAA BAA | 1 (Dave) | 0 |
| Copay MEC (arm) | ARM ASA | 0 | 0 |
| Lyric | none | 0 | 0 |
| Essential (ShareWELL) | none | 1 (Alice) | 0 |
| MightyWELL Copay Silver | HIPAA BAA | 2 (Bob, Carol) | **1** (pre-deleted) |
| MightyWELL Vision | HIPAA BAA | 0 | **1** (pre-deleted) |

Plus a single pre-existing `SignedASAAgreements` row for the **HIPAA BAA** document (signed by groupadmin@allaboard365.com). The **ARM ASA** document is intentionally left unsigned so the banner has at least one row to display.

### Test users

| Email | Role | What you'll test as them |
|-------|------|---------------------------|
| `agent@allaboard365.com` | Agent | Banner read-only variant, Delete flow, audit section, re-add |
| `groupadmin@allaboard365.com` | Group Admin (linked to the test group) | Banner interactive variant (Sign button), permission gating |

### Test group URL

After running the seed, the script prints the URL. It looks like:

```
http://localhost:5173/agent/groups/<NEW_GROUP_ID>#products
```

The GroupId is regenerated on each seed run, so always copy it from the script's output.

For Group Admin testing, sign in as `groupadmin@allaboard365.com` and the test group will appear in their assigned groups list.

---

## Test scenarios

Run each section in order. Refresh between scenarios to ensure stale React Query state isn't leaking.

### 1. ASA banner — agent variant (read-only)

**As `agent@allaboard365.com`**, navigate to the test group → Products tab.

Expected:

- A light-blue banner at the top reading **"Awaiting group admin signature on:"**
- Underneath, exactly **one row**: `ARM ASA 2026 BLANK.pdf`
- **No Sign button** (read-only for agents)
- HIPAA BAA does NOT appear in the banner — already signed by the group admin during seeding, and the banner only shows unsigned docs
- No per-row ASA badges, no per-row "Sign Now" buttons anywhere in the products table

**Why one row even though several products require ASAs:** The banner dedupes by `documentId`. MightyWELL CoPay Basic, Gold, Dental, and the pre-deleted Silver / Vision all reference the same HIPAA BAA document — and that document is signed, so it's filtered out. Only the ARM ASA (used by Copay MEC) remains unsigned.

### 2. ASA banner — group admin variant (interactive)

**Sign out, sign in as `groupadmin@allaboard365.com`**, navigate to the same group → Products tab.

Expected:

- Same banner, same one row for ARM ASA — but now the row has a blue **"Sign"** button on the right
- Click **Sign** → the existing `ASASigningModal` opens for the ARM ASA document
- Complete the signing flow → banner disappears entirely (no unsigned docs left)
- After signing, log back in as Agent → banner is gone

**Reset for this section:** to test signing again, re-run the seed script.

### 3. Active products list

**As `agent@allaboard365.com`**.

Expected:

- Six rows (in the active "Assigned Products" section):
  - Copay MEC (arm)
  - Essential (ShareWELL)
  - Lyric
  - MightyWELL CoPay Basic
  - MightyWELL CoPay Gold
  - MightyWELL Dental
- The two pre-deleted products (Copay Silver, Vision) do NOT appear in this list
- No "Show hidden products" checkbox above the table — it's been removed

**Note:** before the IsHidden bug fix, only Essential and Dental appeared (most catalog-hidden products were silently excluded). If you only see two products, the backend is running stale code — restart it.

### 4. Delete with no active enrollments — Lyric

Click the small **red trash icon** (matches the size of the green Settings icon next to it) on the **Lyric** row.

Expected modal copy:

> Remove **Lyric** from this group?
>
> It will no longer appear in enrollment links. You can re-add it anytime from the Add Product menu.
>
> [ Cancel ] [ Remove ]

- No "currently enrolled" warning
- Click **Cancel** → modal closes, Lyric still in active list
- Reopen modal, click **Remove** → modal closes, Lyric vanishes from active list, audit section unchanged (Lyric had 0 enrollments)

Verify in DB:

```bash
node backend/scripts/check-mightywell-copay-base-delete.js
```

(adapt the script or use ad-hoc query) — the Lyric `GroupProducts` row now has `IsHidden = 1`, `IsActive = 1`.

### 5. Delete with one active enrollment — Essential (ShareWELL)

Click the trash icon on the **Essential (ShareWELL)** row.

Expected modal copy:

> Remove **Essential (ShareWELL)** from this group?
>
> **1 member is currently enrolled — their enrollments will continue unchanged.**
>
> The product will not appear in new enrollment links. You can re-add it anytime from the Add Product menu.
>
> [ Cancel ] [ Remove ]

- Note "1 member is" (singular) — verify the copy adapts
- Confirm **Remove** → row moves out of the active list and into the **Products with Active Enrollments** section below

### 6. Delete with two active enrollments — re-test by deleting MightyWELL Dental

Click the trash icon on **MightyWELL Dental**.

Expected modal copy: "**1 member is currently enrolled**" (Dave).

This is here mostly to confirm the singular form. To exercise the plural form ("2 members are currently enrolled"), the seed already pre-deletes MightyWELL Copay Silver with 2 enrollments — you can re-add it (section 8 below), then re-delete to see the plural copy. Alternatively, re-seed and assign 2 members manually to a non-Silver product.

### 7. Audit section — "Products with Active Enrollments"

Below the active list, this section should already exist on first page load.

Expected:

- Section header: **"Products with Active Enrollments"**
- Helper paragraph: "These products were removed from this group but still have enrolled members. They are not available in new enrollment links."
- Initially, one row: **MightyWELL Copay Silver** | "2 members enrolled"
- After scenarios 5 + 6, also: **Essential (ShareWELL)** | "1 member enrolled" and **MightyWELL Dental** | "1 member enrolled"
- **MightyWELL Vision** is hidden but has 0 enrollments — does NOT appear here (clean delete is invisible)

Click any row's chevron to expand:

- For Copay Silver: shows "Bob TestSilverHidden" and "Carol TestSilverHidden" with their enrollment dates
- For the others: shows the corresponding test member name

Click again to collapse.

### 8. Re-add via Add Product flow

Click the **Add Product** button (existing UI — same flow as adding a fresh product).

Expected:

- The available-products picker should include MightyWELL Copay Silver (the deleted one), and any others you removed in the prior steps
- Tick MightyWELL Copay Silver and save
- Active list now includes it again
- Audit section no longer shows it
- Verify in DB: same `GroupProducts` row, `IsHidden` flipped from 1 → 0 (no duplicate row)

This validates Task 3 of the plan: the existing UPDATE branch flips `IsHidden = 0` on re-add, so the agent never has to think about un-hiding separately.

### 9. Group Admin permissions

**As `groupadmin@allaboard365.com`**, navigate to the same group → Products tab.

Expected:

- Banner is visible (interactive, with Sign button if any unsigned ASAs remain — see scenario 2)
- Active products list is visible (read-only)
- **No** trash icons on any row
- **No** "Products with Active Enrollments" section anywhere on the page
- **No** "Show hidden products" checkbox anywhere on the page

To verify the audit endpoint is never called as Group Admin: open browser DevTools → Network tab → filter for `hidden-with-enrollments`. The request should never fire while logged in as Group Admin. (The hook is gated by the `canEditProducts` flag, which is false for Group Admins.)

### 10. Enrollment links exclude deleted products

This validates the audit results from the latest commits.

In the test group, hide one product (or use an already-deleted one) and verify it doesn't appear in any enrollment-link product list.

Quick way: pick the test group's existing enrollment link template (auto-created by the system) and visit:

```
GET /api/enrollment-links/<linkToken>
```

via DevTools Network tab when an enrollee starts the wizard. The response's `productSections[].products[]` should never include any product whose `GroupProducts.IsHidden = 1`.

Two queries in `backend/routes/enrollment-links.js` enforce this:

1. Line 1349 — `(gp.IsHidden IS NULL OR gp.IsHidden = 0)` — main wizard product fetch
2. Line 10125 — same filter — added in the recent fix to the `/product-pricing` endpoint

### 11. Bundle and standalone are independent

The seed doesn't yet include both a standalone product and a bundle that includes the same product, so this is a manual ad-hoc check. To verify:

- If you have a tenant where ShareWELL exists both as a standalone product and inside a bundle, attach both to a group, then:
  - Hide the standalone → bundle still shows ShareWELL as a sub-product (because `oe.ProductBundles` is queried independently of `GroupProducts.IsHidden` — see `enrollment-links.js:1617`)
  - Hide the bundle → standalone still shows
  - Hide both → both disappear, but the catalog-level bundle definition is untouched

The relevant code paths:

- Bundle expansion at `enrollment-links.js:1617` joins `oe.ProductBundles → oe.Products` directly. There is no `GroupProducts` join, so per-group hide doesn't cascade into bundle internals.
- The per-row delete UI never modifies `oe.ProductBundles` — only the per-group `GroupProducts.IsHidden` flag.

---

## Resetting between runs

```bash
node backend/scripts/seed-hide-clearity-test-group.js
```

This:

1. Looks up any existing group named `Hide Clearity Test` in the tenant
2. Deletes all enrollments, members (and their auto-created Users), signed agreements, group admins, GroupProducts rows, and the group itself
3. Recreates the group with a fresh GroupId, links the group admin, inserts 8 GroupProducts, 4 test members + their User rows, 4 enrollments, and one signed HIPAA BAA agreement
4. Prints the new URL

The script only deletes test users with the `*hideclearity@example.com` email pattern — it never touches real users.

---

## DB inspection helpers

Lightweight scripts in `backend/scripts/` for poking at state during testing:

- `check-mightywell-copay-base-delete.js` — inspects MightyWELL group `GroupProducts` and recent modifications
- `check-mightywell-copay-enrollments.js` — quick enrollment count for a specific row
- `check-test-group-products.js` — full state of the seeded test group (GroupProducts, ASA join, signed agreements)
- `inspect-seed-context.js` — used to design the seed; lists schemas + product candidates

All scripts read `backend/.env` automatically.

---

## Known gaps (out of scope for this branch)

- Bundle/standalone interaction (scenario 11) is verified by code inspection but does not yet have a Cypress spec. The four committed Cypress specs cover delete (no enrollments), delete (with enrollments), ASA banner, and group admin permissions.
- Backend Jest coverage is 23/23 passing across 4 suites (`enrollmentCount`, `hiddenWithEnrollments`, `readdUnhides`, `toggleHidden`). Frontend Vitest coverage is 32/32 passing across 5 suites including the three new component test files.
- Cypress specs are stub-driven and can be run via `npx cypress run --spec "cypress/e2e/groups/group-products-*.cy.ts"`. They do not require the dev server to be live but do require Cypress to be installed.
