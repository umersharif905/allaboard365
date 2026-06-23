# Claim Share Requests — Design Spec

**Date:** 2026-05-12
**Branch:** `feat/claim-share-requests`
**Status:** Draft, pending user review

## Goal

Let vendor users (`VendorAdmin` + `VendorAgent`) **claim** share requests so the team can coordinate who is working what. Claiming is a soft-ownership signal: it records the assignee, but does not lock the SR from other users editing it. The vendor portal's share request list rail gains an **Unclaimed / Claimed** tab selector so agents can self-serve their work queue.

## Non-goals (v1)

- No status transition on claim. The user has flagged a future "Acknowledged" status as someone else's task; this spec leaves a `TODO` placeholder at the exact hook point but does not change any status.
- No claim history / audit log. Only the current claimer is recorded. Past claimers are not preserved when reassignment happens.
- No notifications when an admin reassigns or unclaims another user's SR.
- No edit-locking. Once claimed, other vendor users can still open and edit the SR.
- No SLA/aging timer on unclaimed SRs.
- No bulk claim/unclaim.

## Data model

Add two nullable columns to `oe.ShareRequests`:

| Column | Type | Notes |
|---|---|---|
| `ClaimedByUserId` | `UNIQUEIDENTIFIER NULL` | FK to `oe.Users(UserId)`. Set on claim, cleared on unclaim. |
| `ClaimedAt` | `DATETIME2 NULL` | UTC timestamp when the current claim was set. Cleared on unclaim. |

Migration file: `sql-changes/2026-05-12-share-request-claim-columns.sql`. Per the project's shared-dev-database rule, the SQL file is committed but **not** applied by Claude — the user (or DBA) runs it.

Index: a non-clustered index on `(VendorId, ClaimedByUserId)` for the dropdown / list-filter queries (range-scans by vendor + filtering by claimer).

No new tables.

## API

All endpoints live under the existing router `backend/routes/me/vendor/share-requests.js` and inherit its `authorize(['VendorAdmin', 'VendorAgent'])` middleware. Vendor-scoping (`req.user.VendorId`) is enforced via `requireShareRequestAccess` exactly as the existing routes do.

### `POST /api/me/vendor/share-requests/:id/claim`

Claim an unclaimed share request for the authenticated user.

- **Auth:** VendorAgent or VendorAdmin.
- **Body:** none.
- **Behavior:**
  - 404 if SR not found in the user's vendor scope.
  - 409 if `ClaimedByUserId IS NOT NULL` and it's not the same user (idempotent re-claim by same user returns 200).
  - On success: sets `ClaimedByUserId = req.user.UserId`, `ClaimedAt = GETUTCDATE()`.
- **Status TODO:** comment block in the service method where the future `'New' → 'Acknowledged'` transition will live.
- **Response:** `{ success: true, data: { shareRequestId, claimedByUserId, claimedAt, claimedByName } }`.

### `DELETE /api/me/vendor/share-requests/:id/claim`

Release a claim.

- **Auth:** VendorAgent or VendorAdmin.
- **Authorization rule:**
  - Claimer can release their own claim.
  - VendorAdmin can release **any** claim within their vendor.
  - Any other user gets 403.
- **Behavior:** sets `ClaimedByUserId = NULL`, `ClaimedAt = NULL`. 404 if SR not found. 200 (no-op) if already unclaimed.
- **Response:** `{ success: true }`.

### `PUT /api/me/vendor/share-requests/:id/claim`

Assign or reassign a claim to a specific vendor user.

- **Auth:** VendorAdmin only (returns 403 for VendorAgent).
- **Body:** `{ userId: <uuid> }`.
- **Behavior:**
  - 400 if `userId` is missing or not a `VendorAdmin`/`VendorAgent` in the same `VendorId` as the SR.
  - Works whether the SR is currently claimed or not (admin can hand out a fresh assignment, or overwrite an existing claim).
  - Sets `ClaimedByUserId = userId`, `ClaimedAt = GETUTCDATE()`.
- **Response:** `{ success: true, data: { shareRequestId, claimedByUserId, claimedAt, claimedByName } }`.

**Why two endpoints (POST and PUT) instead of one:** POST is self-service (sets claimer = current user, fails if already claimed). PUT is admin override (sets claimer = specified user, always succeeds for admins). This keeps the conflict-on-duplicate-claim behavior tight for the common case while giving admins an explicit override path.

### `GET /api/me/vendor/share-requests/claimers`

Return the full roster for the dropdown and the workspace reassign picker: **every** `VendorAdmin` and `VendorAgent` in the current vendor, each annotated with how many SRs they currently have claimed (zero allowed).

- **Auth:** VendorAgent or VendorAdmin.
- **Response:** `{ success: true, data: [{ userId, firstName, lastName, role, claimedCount }] }`, sorted with the authenticated user first, then by `claimedCount DESC`, then `lastName ASC, firstName ASC`.
- Returning everyone keeps the rail dropdown and the workspace reassign picker symmetrical — same data source, same shape.

### Existing list endpoint extension

`GET /api/me/vendor/share-requests` (existing) gains two new optional query params:

- `claimed=true|false` — when `true`, only SRs with `ClaimedByUserId IS NOT NULL`; when `false`, only unclaimed SRs. Omitted = no filter (current behavior).
- `claimedByUserId=<uuid|me>` — only used when `claimed=true`. `me` is sugar for `req.user.UserId`.

Existing filters (search, status, determination, type, date range) continue to layer on top. Response shape unchanged except each SR row now includes `claimedByUserId`, `claimedAt`, `claimedByName` (computed via the existing user join pattern).

## Frontend

### Types

Extend `frontend/src/types/shareRequest.types.ts`:

```ts
interface ShareRequestSummary {
  // ...existing fields
  claimedByUserId?: string | null;
  claimedAt?: string | null;
  claimedByName?: string | null;
}

interface ClaimedUserOption {
  userId: string;
  firstName: string;
  lastName: string;
  role: 'VendorAdmin' | 'VendorAgent';
  claimedCount: number;
}

type ClaimTab = 'unclaimed' | 'claimed';
```

### Service

Extend `frontend/src/services/api.service.ts` (or co-locate in a new `claim.service.ts`) with thin wrappers:

- `claimShareRequest(id)` → `POST /api/me/vendor/share-requests/:id/claim`
- `unclaimShareRequest(id)` → `DELETE /api/me/vendor/share-requests/:id/claim`
- `reassignShareRequest(id, userId)` → `PUT /api/me/vendor/share-requests/:id/claim`
- `getClaimers()` → `GET /api/me/vendor/share-requests/claimers`

### `ShareRequestListRail.tsx` changes

The rail (`frontend/src/components/vendor/share-requests/ShareRequestListRail.tsx`) is the primary UI surface.

**New UI elements at the top of the rail, above the existing search/filters:**

1. **Segmented tab strip** (Tailwind, brand colors per project rules):
   - `Unclaimed` (default on first render — represents "the new-work bucket")
   - `Claimed`
2. **"Claimed by" dropdown** — visible only when the `Claimed` tab is active:
   - First item: `Me — (N)` where N is the current user's claim count, selected by default.
   - `Anyone` — second item, for browsing the whole vendor's claimed list.
   - Followed by every other `VendorAdmin`/`VendorAgent` in the vendor (from `GET /claimers`), each rendered as `Firstname L. — (N)`.
   - Users with `claimedCount === 0` are rendered in a muted color (e.g. `text-gray-400`) but remain selectable; selecting one shows the empty state.
3. **Existing search + filter chips** continue to work, layered on top of the tab + dropdown.

**Row rendering changes:**

- Each SR row gets a small "Claimed by Jane S." chip when claimed (subtle, not the same visual weight as the status badge).
- In the **Unclaimed** tab only, each row gets a compact "Claim" button (icon + label, or just icon on narrow rail). Clicking calls `claimShareRequest`, optimistically removes the row from the Unclaimed list, and refetches counts.

**Empty states:**

- Unclaimed tab: "No unclaimed share requests" with a quiet helper "All caught up — nice."
- Claimed tab (current user, empty): "You haven't claimed any share requests yet."
- Claimed tab (filtered to someone else, empty): "Nothing claimed by this user."

**Data fetching:** the rail already fetches via the existing list endpoint; we add `claimed` and `claimedByUserId` to its query state, debounce them with the other filters, and React Query keys include them.

### `ShareRequestWorkspace.tsx` / header

Inside the SR detail view, the header card surfaces the claim state:

- If unclaimed: a `Claim` button next to existing actions. Calls `claimShareRequest` and refetches the SR detail.
- If claimed by current user: `Claimed by you · Unclaim` link.
- If claimed by another user:
  - VendorAgent sees: `Claimed by Jane S.` (read-only chip).
  - VendorAdmin sees: `Claimed by Jane S. · Reassign…` (opens a small picker of vendor users) and `· Unclaim`.

Reassignment picker is a dropdown sourced from the same `/claimers` endpoint (which now returns the full vendor roster), so an admin can assign to anyone in the vendor regardless of current claim count. Counts render next to each name; zero-count users are visually muted but selectable.

## Permissions matrix

| Action | VendorAgent | VendorAdmin | Other vendor users |
|---|---|---|---|
| Claim an unclaimed SR | ✅ | ✅ | ❌ |
| Claim a claimed SR | ❌ (409) | ❌ (409 — use Reassign instead) | ❌ |
| Unclaim own claim | ✅ | ✅ | n/a |
| Unclaim someone else's claim | ❌ (403) | ✅ | ❌ |
| Reassign (PUT) | ❌ (403) | ✅ | ❌ |
| View claim state | ✅ | ✅ | ❌ (out of vendor scope) |
| See dropdown of claimers | ✅ | ✅ | ❌ |

Cross-vendor enforcement is via the existing `requireShareRequestAccess` / `req.user.VendorId` filter — no new middleware needed.

## Status placeholder

The user has flagged the "Acknowledged" status as a separate, future task. In the claim service method, we insert:

```js
// TODO(claim-status): when the new "Acknowledged" share request status lands,
// transition Status: 'New' -> 'Acknowledged' here.
// Tracked separately; not in this PR. See feat/claim-share-requests.
```

…placed where the UPDATE that sets `ClaimedByUserId` lives, so a future PR can extend the same UPDATE with `Status = 'Acknowledged'` without restructuring the call site.

## Testing

**No automated tests for this feature.** Manual testing only — fast iteration. No Jest, Vitest, or Cypress files will be added.

## Blockers / future work (tracked elsewhere)

- **Status transition (`New` → `Acknowledged`)** — owned by the share request status redesign work. This spec only inserts a `TODO(claim-status)` comment at the exact UPDATE site so that future work can extend the same statement.
- **Claim history table** — someone else is working on the tabs in the share request workspace (audit / activity log). When that lands, claim/unclaim/reassign events should be recorded. Not in scope here. Sketched shape if useful: `oe.ShareRequestClaimHistory(ShareRequestId, UserId, Action ENUM('claimed','unclaimed','reassigned'), ChangedByUserId, ChangedAt)`.
- **Completed-SR filtering in the Claimed tab** — the person wiring in the new statuses will add a filter to hide completed SRs from the active claim queue. Not handled here.

## Open questions / risks

- **Race on claim:** two agents simultaneously claiming the same SR. The UPDATE has a `WHERE ClaimedByUserId IS NULL` guard; the loser gets 409. Frontend handles by toasting "Already claimed by Jane S." and refetching.
- **Soft ownership ≠ exclusivity:** other vendor users can still edit a claimed SR. If this causes real-world confusion, future work can add a visual "edited by non-claimer" indicator, or escalate to a hard lock — out of scope here.

## Files touched

**Backend:**
- `sql-changes/2026-05-12-share-request-claim-columns.sql` (new — not auto-applied)
- `backend/services/shareRequestService.js` (extend with claim/unclaim/reassign/getClaimers; surface new columns in list+detail SELECTs)
- `backend/routes/me/vendor/share-requests.js` (4 new endpoints + list query params)

**Frontend:**
- `frontend/src/types/shareRequest.types.ts` (extend types)
- `frontend/src/services/api.service.ts` or new `frontend/src/services/share-request-claim.service.ts` (new wrappers)
- `frontend/src/components/vendor/share-requests/ShareRequestListRail.tsx` (tab strip + dropdown + claim button + claimed-by chip)
- `frontend/src/components/vendor/share-requests/ShareRequestHeaderCard.tsx` (claim/unclaim/reassign affordance)
