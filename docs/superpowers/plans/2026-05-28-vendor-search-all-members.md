# Vendor Search: Show ALL Members (Terminated + Placeholders) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Vendor backoffice members tab returns every member their vendor has any enrollment with — including e123-migrated placeholders and terminated members — and the UI makes each non-active state visually unmistakable.

**Architecture:** Backend stops gating the list/search endpoints on `e.Status IN ('Active','Pending')`. A new derived `MemberStatus` field rolls up `oe.Members.IsPendingMigration`, `oe.Members.Status`, and the live enrollment mix into one of `Active | PendingMigration | Terminated | Inactive`. Frontend exposes a status filter (default **All**), row badges in the list rail, and a sticky banner + watermark above the workspace tabs whenever the selected member isn't Active.

**Tech Stack:** Node.js / Express + mssql (backend), React 18 + TypeScript + Tailwind + Lucide (frontend).

**Branch:** `fix/vendor-search-all-members` off `staging`.

---

## Production data context (verified)

`oe.Members.Status` values: `Active` (2799), `Declined` (84), `Inactive` (22), `Terminated` (22), `Pending Termination` (1).
`oe.Enrollments.Status` values: `Active` (3134), `Pending Payment` (2747), `Inactive` (572), `Terminated` (36).
`IsPendingMigration = 1`: 1502 rows, all `MigrationSourceSystem = 'e123'`.

Note: the existing vendor route uses `e.Status IN ('Active','Pending')`. Prod has no `'Pending'`, it's `'Pending Payment'` — another reason the current filter is wrong, not just restrictive.

---

## Derived `MemberStatus` rules (applied in SQL, returned to FE)

In priority order:
1. `IsPendingMigration = 1` → `'PendingMigration'`
2. `m.Status IN ('Terminated','Pending Termination')` → `'Terminated'`
3. No non-terminated enrollment on this vendor's products AND `m.Status` not Active → `'Terminated'` (covers members whose only vendor enrollment ended even if `m.Status` is stale)
4. `m.Status IN ('Inactive','Declined')` → `'Inactive'`
5. else → `'Active'`

---

## File Structure

**Modify:**
- `backend/routes/me/vendor/members.js` — list (lines 21–157), search (lines 165–220), detail (lines 1174–1225). Drop the enrollment-status gate, add `MemberStatus`/`IsPendingMigration`/`MigrationSourceSystem` to SELECT, add enrollment-status counts.
- `frontend/src/components/vendor/members/MemberListRail.tsx` — status filter dropdown, row badges, query param.
- `frontend/src/components/vendor/members/tabs/MemberDetailsTab.tsx` — extend `MemberDetail` interface (Status, IsPendingMigration, MigrationSourceSystem).
- `frontend/src/components/vendor/members/MemberWorkspaceTabs.tsx` — fetch member header once, render banner + watermark above tab nav so it spans every tab.

**Create:**
- `frontend/src/components/vendor/members/MemberStatusBanner.tsx` — small presentational component for the terminated / pending-migration banner with optional watermark prop.

---

### Task 1: Backend — vendor members list endpoint

**Files:**
- Modify: `backend/routes/me/vendor/members.js:21-157`

- [ ] **Step 1: Update list endpoint SQL + filter handling**

In the list route (`router.get('/')`):

- Remove the `else { whereConditions.push("e.Status IN ('Active', 'Pending')"); }` branch (lines 58–60). Default scope = all enrollment statuses.
- Add a new `memberStatus` query param accepting `Active | PendingMigration | Terminated | Inactive`. When provided, filter the outer query on the derived status (see CTE below). The `status` param (which currently maps to `e.Status`) stays for back-compat but moves into the where clause only when explicitly set.
- Add `m.Status AS MemberRawStatus`, `m.IsPendingMigration`, `m.MigrationSourceSystem` to the CTE SELECT.
- In the outer SELECT, compute `MemberStatus` using a `CASE` expression matching the priority rules above, plus subquery counts (`ActiveEnrollments` already exists — keep it but also add `TerminatedEnrollments`, `PendingPaymentEnrollments`).
- Apply `memberStatus` filter via an outer `HAVING`-equivalent: wrap the existing result in a subquery and filter, or compute `MemberStatus` in the CTE so it can be filtered in the outer `WHERE`. Use the second approach — simpler.
- Update `validSortColumns` to include `MemberStatus`.

Replacement query (verbatim):

```js
        const memberStatusFilter = (req.query.memberStatus || '').toString();
        // Build query conditions
        let whereConditions = ['p.VendorId = @vendorId'];

        const request = pool.request();
        request.input('vendorId', sql.UniqueIdentifier, req.vendor.VendorId);
        request.input('offset', sql.Int, offset);
        request.input('limit', sql.Int, parseInt(limit));

        if (search) {
            whereConditions.push(`(
                u.FirstName LIKE @search
                OR u.LastName LIKE @search
                OR u.Email LIKE @search
                OR m.HouseholdMemberID LIKE @search
                OR (u.FirstName + ' ' + u.LastName) LIKE @search
            )`);
            request.input('search', sql.NVarChar, `%${search}%`);
        }

        // Note: legacy `status` param still filters on enrollment status when explicitly set.
        if (status) {
            whereConditions.push('e.Status = @status');
            request.input('status', sql.NVarChar, status);
        }

        if (productId) {
            whereConditions.push('e.ProductId = @productId');
            request.input('productId', sql.UniqueIdentifier, productId);
        }

        const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

        const validSortColumns = ['LastName', 'FirstName', 'Email', 'HouseholdMemberID', 'EnrollmentDate', 'Status', 'MemberStatus'];
        const safeSort = validSortColumns.includes(sortBy) ? sortBy : 'LastName';
        const safeSortOrder = sortOrder.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

        // Count + data share the same CTE shape. We derive MemberStatus inside the CTE so
        // the optional memberStatus filter and ORDER BY can both use it directly.
        const baseCte = `
            WITH MemberList AS (
                SELECT DISTINCT
                    m.MemberId,
                    m.HouseholdId,
                    m.HouseholdMemberID,
                    m.RelationshipType,
                    m.Address,
                    m.City,
                    m.State,
                    m.Zip,
                    m.DateOfBirth,
                    m.Status AS MemberRawStatus,
                    m.IsPendingMigration,
                    m.MigrationSourceSystem,
                    u.FirstName,
                    u.LastName,
                    u.Email,
                    u.PhoneNumber as Phone,
                    (
                        SELECT COUNT(*) FROM oe.Enrollments e2
                        INNER JOIN oe.Products p2 ON e2.ProductId = p2.ProductId
                        WHERE e2.MemberId = m.MemberId AND p2.VendorId = @vendorId
                          AND e2.Status NOT IN ('Terminated','Inactive')
                    ) AS LiveEnrollments,
                    (
                        SELECT COUNT(*) FROM oe.Enrollments e3
                        INNER JOIN oe.Products p3 ON e3.ProductId = p3.ProductId
                        WHERE e3.MemberId = m.MemberId AND p3.VendorId = @vendorId
                          AND e3.Status = 'Terminated'
                    ) AS TerminatedEnrollments,
                    (
                        SELECT COUNT(*) FROM oe.Enrollments e4
                        INNER JOIN oe.Products p4 ON e4.ProductId = p4.ProductId
                        WHERE e4.MemberId = m.MemberId AND p4.VendorId = @vendorId
                          AND e4.Status = 'Active'
                    ) AS ActiveEnrollments,
                    (
                        SELECT STRING_AGG(p5.Name, ', ') FROM oe.Enrollments e5
                        INNER JOIN oe.Products p5 ON e5.ProductId = p5.ProductId
                        WHERE e5.MemberId = m.MemberId AND p5.VendorId = @vendorId
                          AND e5.Status IN ('Active','Pending Payment')
                    ) AS ProductNames
                FROM oe.Members m
                INNER JOIN oe.Users u ON m.UserId = u.UserId
                INNER JOIN oe.Enrollments e ON m.MemberId = e.MemberId
                INNER JOIN oe.Products p ON e.ProductId = p.ProductId
                ${whereClause}
            ),
            MemberListWithStatus AS (
                SELECT
                    ml.*,
                    CASE
                        WHEN ml.IsPendingMigration = 1 THEN 'PendingMigration'
                        WHEN ml.MemberRawStatus IN ('Terminated','Pending Termination') THEN 'Terminated'
                        WHEN ml.LiveEnrollments = 0 THEN 'Terminated'
                        WHEN ml.MemberRawStatus IN ('Inactive','Declined') THEN 'Inactive'
                        ELSE 'Active'
                    END AS MemberStatus
                FROM MemberList ml
            )
        `;

        const memberStatusWhere = memberStatusFilter
            ? 'WHERE MemberStatus = @memberStatus'
            : '';
        if (memberStatusFilter) {
            request.input('memberStatus', sql.NVarChar, memberStatusFilter);
        }

        const countResult = await request.query(`
            ${baseCte}
            SELECT COUNT(*) AS total FROM MemberListWithStatus
            ${memberStatusWhere}
        `);
        const total = countResult.recordset[0].total;

        const dataReq = pool.request()
            .input('vendorId', sql.UniqueIdentifier, req.vendor.VendorId)
            .input('offset', sql.Int, offset)
            .input('limit', sql.Int, parseInt(limit));
        if (search) dataReq.input('search', sql.NVarChar, `%${search}%`);
        if (status) dataReq.input('status', sql.NVarChar, status);
        if (productId) dataReq.input('productId', sql.UniqueIdentifier, productId);
        if (memberStatusFilter) dataReq.input('memberStatus', sql.NVarChar, memberStatusFilter);

        const dataResult = await dataReq.query(`
            ${baseCte}
            SELECT * FROM MemberListWithStatus
            ${memberStatusWhere}
            ORDER BY ${safeSort} ${safeSortOrder}
            OFFSET @offset ROWS
            FETCH NEXT @limit ROWS ONLY
        `);
```

Notes for the implementer:
- `e.Status IN ('Active','Pending')` is GONE from default scope. Every member with *any* enrollment of any status on a vendor product is returned.
- `Pending Payment` is the real enrollment status (not `Pending`) — `LiveEnrollments` counts both Active and Pending Payment via `NOT IN ('Terminated','Inactive')`.

---

### Task 2: Backend — vendor members search endpoint

**Files:**
- Modify: `backend/routes/me/vendor/members.js:165-220`

- [ ] **Step 1: Drop enrollment-status gate, add status/migration fields**

Replace the SQL block in `router.get('/search')` with:

```js
        const result = await request.query(`
            SELECT DISTINCT TOP (@limit)
                m.MemberId,
                u.FirstName,
                u.LastName,
                u.Email,
                u.PhoneNumber as Phone,
                m.HouseholdId,
                m.HouseholdMemberID,
                m.Status AS MemberRawStatus,
                m.IsPendingMigration,
                m.MigrationSourceSystem,
                CASE
                    WHEN m.IsPendingMigration = 1 THEN 'PendingMigration'
                    WHEN m.Status IN ('Terminated','Pending Termination') THEN 'Terminated'
                    WHEN NOT EXISTS (
                        SELECT 1 FROM oe.Enrollments ex
                        INNER JOIN oe.Products px ON ex.ProductId = px.ProductId
                        WHERE ex.MemberId = m.MemberId AND px.VendorId = @vendorId
                          AND ex.Status NOT IN ('Terminated','Inactive')
                    ) THEN 'Terminated'
                    WHEN m.Status IN ('Inactive','Declined') THEN 'Inactive'
                    ELSE 'Active'
                END AS MemberStatus
            FROM oe.Members m
            INNER JOIN oe.Users u ON m.UserId = u.UserId
            INNER JOIN oe.Enrollments e ON m.MemberId = e.MemberId
            INNER JOIN oe.Products p ON e.ProductId = p.ProductId
            WHERE p.VendorId = @vendorId
            AND (
                u.FirstName LIKE @search
                OR u.LastName LIKE @search
                OR u.Email LIKE @search
                OR m.HouseholdMemberID LIKE @search
                OR (u.FirstName + ' ' + u.LastName) LIKE @search
            )
            ORDER BY u.LastName, u.FirstName
        `);
```

Note: `e.Status IN ('Active','Pending')` removed. The vendor still scopes via `p.VendorId = @vendorId`, so cross-vendor leakage is impossible.

---

### Task 3: Backend — vendor member detail endpoint

**Files:**
- Modify: `backend/routes/me/vendor/members.js:1174-1225`

- [ ] **Step 1: Add Status + migration fields to detail SELECT**

Replace the query with:

```js
        const result = await request.query(`
            SELECT DISTINCT
                m.MemberId,
                m.HouseholdId,
                m.HouseholdMemberID,
                m.RelationshipType,
                m.Gender,
                u.FirstName,
                u.LastName,
                u.Email,
                u.PhoneNumber as Phone,
                m.Address,
                m.City,
                m.State,
                m.Zip as ZipCode,
                FORMAT(m.DateOfBirth, 'yyyy-MM-dd') as DateOfBirth,
                m.Status AS MemberRawStatus,
                m.IsPendingMigration,
                m.MigrationSourceSystem,
                CASE
                    WHEN m.IsPendingMigration = 1 THEN 'PendingMigration'
                    WHEN m.Status IN ('Terminated','Pending Termination') THEN 'Terminated'
                    WHEN NOT EXISTS (
                        SELECT 1 FROM oe.Enrollments ex
                        INNER JOIN oe.Products px ON ex.ProductId = px.ProductId
                        WHERE ex.MemberId = m.MemberId AND px.VendorId = @vendorId
                          AND ex.Status NOT IN ('Terminated','Inactive')
                    ) THEN 'Terminated'
                    WHEN m.Status IN ('Inactive','Declined') THEN 'Inactive'
                    ELSE 'Active'
                END AS MemberStatus
            FROM oe.Members m
            INNER JOIN oe.Users u ON m.UserId = u.UserId
            INNER JOIN oe.Enrollments e ON m.MemberId = e.MemberId
            INNER JOIN oe.Products p ON e.ProductId = p.ProductId
            WHERE m.MemberId = @memberId
            AND p.VendorId = @vendorId
        `);
```

The detail endpoint already had no enrollment-status gate — only additions here.

---

### Task 4: Frontend — MemberListRail status filter + row badges

**Files:**
- Modify: `frontend/src/components/vendor/members/MemberListRail.tsx`

- [ ] **Step 1: Extend RailMember type**

Replace the interface (lines 7–13):

```ts
export interface RailMember {
  MemberId: string;
  HouseholdMemberID: string;
  RelationshipType: string;
  FirstName: string;
  LastName: string;
  MemberStatus?: 'Active' | 'Terminated' | 'PendingMigration' | 'Inactive';
  MigrationSourceSystem?: string | null;
}
```

- [ ] **Step 2: Add status filter state and dropdown**

Add a `statusFilter` state (default `'All'`) above `loadMembers`. Include it in the URL params:

```ts
const [statusFilter, setStatusFilter] = useState<'All' | 'Active' | 'Terminated' | 'PendingMigration' | 'Inactive'>('All');
```

In the `useEffect` that resets to page 1, depend on both `debouncedSearch` and `statusFilter`.

In the params builder, add:
```ts
...(statusFilter !== 'All' && { memberStatus: statusFilter }),
```

Render a `<select>` directly below the search input, inside the same `border-b` panel:

```tsx
<div className="mt-2">
  <select
    value={statusFilter}
    onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
    className="w-full text-xs border border-gray-300 rounded-md px-2 py-1.5 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
    aria-label="Filter by member status"
  >
    <option value="All">All members</option>
    <option value="Active">Active</option>
    <option value="Terminated">Terminated</option>
    <option value="PendingMigration">Pending migration (e123)</option>
    <option value="Inactive">Inactive</option>
  </select>
</div>
```

- [ ] **Step 3: Render status chip on each row**

Inside the `<li>` block, after the existing relationship badge, append:

```tsx
{member.MemberStatus === 'Terminated' && (
  <span className="ml-1 inline-flex px-1.5 py-0.5 text-[10px] font-medium rounded bg-red-100 text-red-700">
    Terminated
  </span>
)}
{member.MemberStatus === 'PendingMigration' && (
  <span className="ml-1 inline-flex px-1.5 py-0.5 text-[10px] font-medium rounded bg-amber-100 text-amber-800">
    Pending migration
  </span>
)}
{member.MemberStatus === 'Inactive' && (
  <span className="ml-1 inline-flex px-1.5 py-0.5 text-[10px] font-medium rounded bg-gray-200 text-gray-700">
    Inactive
  </span>
)}
```

---

### Task 5: Frontend — MemberStatusBanner component

**Files:**
- Create: `frontend/src/components/vendor/members/MemberStatusBanner.tsx`

- [ ] **Step 1: Create the banner**

```tsx
import { AlertTriangle, ArrowUpRight, Info } from 'lucide-react';

export type MemberStatus = 'Active' | 'Terminated' | 'PendingMigration' | 'Inactive';

interface MemberStatusBannerProps {
  status: MemberStatus | string | undefined;
  migrationSource?: string | null;
  rawStatus?: string | null;
}

const MemberStatusBanner = ({ status, migrationSource, rawStatus }: MemberStatusBannerProps) => {
  if (!status || status === 'Active') return null;

  if (status === 'Terminated') {
    return (
      <div className="relative border-b border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 flex items-start gap-2">
        <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="font-semibold uppercase tracking-wide">Terminated member</div>
          <div className="text-red-700/90 text-xs mt-0.5">
            This member's coverage has ended. Details remain visible for reference.
            {rawStatus && rawStatus !== 'Terminated' ? ` (Status: ${rawStatus})` : ''}
          </div>
        </div>
        <span
          aria-hidden="true"
          className="pointer-events-none select-none absolute inset-0 flex items-center justify-end pr-6 text-red-200/80 font-extrabold text-3xl tracking-widest opacity-60"
        >
          TERMINATED
        </span>
      </div>
    );
  }

  if (status === 'PendingMigration') {
    return (
      <div className="border-b border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 flex items-start gap-2">
        <ArrowUpRight className="h-4 w-4 mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="font-semibold">Pending migration{migrationSource ? ` from ${migrationSource}` : ''}</div>
          <div className="text-amber-800/90 text-xs mt-0.5">
            This member was imported as a placeholder and has not yet activated on AllAboard365. Available
            data is shown below; some fields may be empty until migration completes.
          </div>
        </div>
      </div>
    );
  }

  if (status === 'Inactive') {
    return (
      <div className="border-b border-gray-200 bg-gray-50 px-4 py-2 text-xs text-gray-700 flex items-center gap-2">
        <Info className="h-3.5 w-3.5 shrink-0" />
        <span>Inactive member{rawStatus && rawStatus !== 'Inactive' ? ` (${rawStatus})` : ''}</span>
      </div>
    );
  }

  return null;
};

export default MemberStatusBanner;
```

---

### Task 6: Frontend — Mount banner in MemberWorkspaceTabs

**Files:**
- Modify: `frontend/src/components/vendor/members/MemberWorkspaceTabs.tsx`

- [ ] **Step 1: Fetch member header info and render banner above tab nav**

Add fetch alongside the existing `shareRequestEnabled` effect:

```ts
import MemberStatusBanner, { type MemberStatus } from './MemberStatusBanner';

// ...inside component:
const [memberHeader, setMemberHeader] = useState<{
  MemberStatus?: MemberStatus | string;
  MigrationSourceSystem?: string | null;
  MemberRawStatus?: string | null;
} | null>(null);

useEffect(() => {
  let cancelled = false;
  setMemberHeader(null);
  (async () => {
    try {
      const r = await apiService.get<{ success: boolean; data: any }>(
        `/api/me/vendor/members/${memberId}`
      );
      if (!cancelled && r.success) {
        setMemberHeader({
          MemberStatus: r.data?.MemberStatus,
          MigrationSourceSystem: r.data?.MigrationSourceSystem,
          MemberRawStatus: r.data?.MemberRawStatus,
        });
      }
    } catch {
      /* banner is non-critical; swallow */
    }
  })();
  return () => { cancelled = true; };
}, [memberId]);
```

Render banner above the tab nav (right before the `<div className="border-b border-gray-200 bg-white">`):

```tsx
{memberHeader?.MemberStatus && memberHeader.MemberStatus !== 'Active' && (
  <MemberStatusBanner
    status={memberHeader.MemberStatus}
    migrationSource={memberHeader.MigrationSourceSystem}
    rawStatus={memberHeader.MemberRawStatus}
  />
)}
```

---

### Task 7: Frontend — Extend MemberDetailsTab interface

**Files:**
- Modify: `frontend/src/components/vendor/members/tabs/MemberDetailsTab.tsx`

- [ ] **Step 1: Extend MemberDetail interface (no UI changes needed; banner lives in workspace)**

Add to the `MemberDetail` interface:

```ts
  MemberStatus?: 'Active' | 'Terminated' | 'PendingMigration' | 'Inactive';
  MemberRawStatus?: string | null;
  IsPendingMigration?: boolean;
  MigrationSourceSystem?: string | null;
```

No further UI changes — workspace-level banner covers the visual treatment.

---

### Task 8: Validate + commit

- [ ] **Step 1: Frontend typecheck**

```bash
cd frontend && npx tsc --noEmit
```
Expected: no new errors related to our touched files.

- [ ] **Step 2: Backend lint (touched file only)**

```bash
cd backend && npx eslint routes/me/vendor/members.js
```
Expected: clean (or pre-existing warnings only).

- [ ] **Step 3: Commit**

```bash
git add backend/routes/me/vendor/members.js \
        frontend/src/components/vendor/members/MemberListRail.tsx \
        frontend/src/components/vendor/members/MemberWorkspaceTabs.tsx \
        frontend/src/components/vendor/members/MemberStatusBanner.tsx \
        frontend/src/components/vendor/members/tabs/MemberDetailsTab.tsx \
        docs/superpowers/plans/2026-05-28-vendor-search-all-members.md
git commit -m "$(cat <<'EOF'
feat(vendor): show all members in search incl. terminated and e123 placeholders

Vendor backoffice members tab no longer hides terminated members or
silently lumps in e123 migration placeholders. Search now returns every
member with any enrollment on the vendor's products and surfaces a
derived MemberStatus the UI can branch on.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Out of scope (intentionally)
- Locking down edit actions on terminated members
- Tenant-admin parity changes
- Banner treatment on household/plans/encounters tab *bodies* (workspace-level banner already covers them visually)
- Backend tests — no existing test file for `routes/me/vendor/members.js`; adding one is a separate effort
