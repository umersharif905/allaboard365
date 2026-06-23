# Group Products Hidden Flag Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `IsHidden` flag to `oe.GroupProducts` so agents can hide products from new enrollments without breaking existing enrollments, and add a migration to auto-create group enrollment link templates for groups that don't have one.

**Architecture:** Add `IsHidden BIT DEFAULT 0` column to `oe.GroupProducts`. Update backend queries to respect hidden state: hidden products are excluded from new enrollment links but their CustomSettings remain accessible. Frontend gets a hide/unhide toggle in the GroupProductsTab actions column. A one-time migration creates templates for the 21 groups currently missing them.

**Tech Stack:** SQL Server (Azure SQL), Node.js/Express, React/TypeScript/Tailwind

---

### Task 1: SQL Migration — Add IsHidden column to GroupProducts

**Files:**
- Create: `sql-changes/2026-04-10-group-products-is-hidden.sql`

- [ ] **Step 1: Create the migration file**

```sql
-- Add IsHidden flag to oe.GroupProducts
-- Allows agents to hide products from new enrollments without removing them.
-- Hidden products retain their CustomSettings so existing enrollments are unaffected.

IF COL_LENGTH('oe.GroupProducts', 'IsHidden') IS NULL
BEGIN
  ALTER TABLE oe.GroupProducts
    ADD IsHidden BIT NOT NULL
      CONSTRAINT DF_GroupProducts_IsHidden DEFAULT (0);
END;
```

- [ ] **Step 2: Run the migration against testing DB**

Run from `ai_scripts/`:
```bash
cd ai_scripts
./db-query.sh "$(cat ../sql-changes/2026-04-10-group-products-is-hidden.sql)" --testing
```

Verify:
```bash
./db-query.sh "SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='oe' AND TABLE_NAME='GroupProducts' AND COLUMN_NAME='IsHidden'" --testing
```

Expected: One row with `IsHidden | bit`

- [ ] **Step 3: Commit**

```bash
git add sql-changes/2026-04-10-group-products-is-hidden.sql
git commit -m "feat: add IsHidden column to oe.GroupProducts"
```

---

### Task 2: SQL Migration — Auto-create templates for groups without one

**Files:**
- Create: `sql-changes/2026-04-10-auto-create-group-enrollment-templates.sql`

- [ ] **Step 1: Create the migration file**

This creates a Group-type enrollment link template for every active group that doesn't already have one. Uses the group's AgentId and TenantId, with default household settings (all collection enabled).

```sql
-- Auto-create Group enrollment link templates for groups that don't have one.
-- Each group should have exactly one Group-type template for the simplified enrollment flow.

INSERT INTO oe.EnrollmentLinkTemplates (
  TemplateId, TemplateName, TemplateType, TenantId, AgentId, GroupId,
  LinkMetaData, IsActive, CreatedDate, ModifiedDate
)
SELECT
  NEWID(),
  g.Name + ' Group Enrollment',
  'Group',
  g.TenantId,
  g.AgentId,
  g.GroupId,
  '{"household":{"collectSSN":true,"collectDOB":true,"collectGender":true,"collectAddress":true,"collectPhone":true}}',
  1,
  GETDATE(),
  GETDATE()
FROM oe.Groups g
WHERE g.Status = 'Active'
  AND NOT EXISTS (
    SELECT 1 FROM oe.EnrollmentLinkTemplates elt
    WHERE elt.GroupId = g.GroupId
      AND elt.TemplateType = 'Group'
      AND elt.IsActive = 1
  );
```

- [ ] **Step 2: Run against testing DB and verify**

```bash
./db-query.sh "$(cat ../sql-changes/2026-04-10-auto-create-group-enrollment-templates.sql)" --testing
```

Verify all active groups now have a template:
```bash
./db-query.sh "SELECT g.Name, CASE WHEN elt.TemplateId IS NOT NULL THEN 'Yes' ELSE 'No' END as HasTemplate FROM oe.Groups g LEFT JOIN oe.EnrollmentLinkTemplates elt ON g.GroupId = elt.GroupId AND elt.TemplateType = 'Group' AND elt.IsActive = 1 WHERE g.Status = 'Active'" --testing
```

Expected: All rows show `Yes` for HasTemplate.

- [ ] **Step 3: Commit**

```bash
git add sql-changes/2026-04-10-auto-create-group-enrollment-templates.sql
git commit -m "feat: auto-create group enrollment templates for groups missing one"
```

---

### Task 3: Backend — Return IsHidden in GroupProducts GET response

**Files:**
- Modify: `backend/routes/groupProducts.js` (lines 207-265)

The GET endpoint query at line 225 already returns `p.IsHidden` from the `oe.Products` table. We need to also return `gp.IsHidden` from `oe.GroupProducts` (the new column). The response mapping at line 265 already normalizes `IsHidden`, but it uses the product-level value. We need to prefer the group-level hidden flag.

- [ ] **Step 1: Update the SQL query to include GroupProducts.IsHidden**

In the GET `/:groupId/products` endpoint (around line 225), add `gp.IsHidden as GroupProductIsHidden` to the SELECT:

Find in `backend/routes/groupProducts.js`:
```sql
gp.ModifiedBy,
```

Add after it:
```sql
gp.IsHidden as GroupProductIsHidden,
```

- [ ] **Step 2: Update the response mapping to use group-level IsHidden**

Find in `backend/routes/groupProducts.js` the response mapping (around line 265) where it sets:
```javascript
IsHidden: product.IsHidden || 0,
```

Change to:
```javascript
IsHidden: product.GroupProductIsHidden || product.IsHidden || 0,
```

This way if the product is hidden at the group level OR at the product level, IsHidden is truthy.

- [ ] **Step 3: Verify the backend returns the new field**

Restart backend and hit: `GET /api/groups/{groupId}/products`

Check that each product in the response has `IsHidden: 0` (since no products are hidden yet).

- [ ] **Step 4: Commit**

```bash
git add backend/routes/groupProducts.js
git commit -m "feat: return GroupProducts.IsHidden in group products response"
```

---

### Task 4: Backend — Add hide/unhide endpoint

**Files:**
- Modify: `backend/routes/groupProducts.js`

- [ ] **Step 1: Add PATCH endpoint for toggling IsHidden**

Add this new route after the DELETE endpoint (after line 937) in `backend/routes/groupProducts.js`:

```javascript
// Toggle IsHidden on a group product
router.patch('/:groupId/products/:productId/visibility', authorize(['SysAdmin', 'TenantAdmin', 'Agent', 'GroupAdmin']), requireTenantAccess, async (req, res) => {
    try {
        const { groupId, productId } = req.params;
        const { isHidden } = req.body;
        const pool = await getPool();

        if (typeof isHidden !== 'boolean') {
            return res.status(400).json({ success: false, message: 'isHidden (boolean) is required' });
        }

        const result = await pool.request()
            .input('groupId', sql.UniqueIdentifier, groupId)
            .input('productId', sql.UniqueIdentifier, productId)
            .input('isHidden', sql.Bit, isHidden ? 1 : 0)
            .input('modifiedBy', sql.UniqueIdentifier, req.user.UserId)
            .query(`
                UPDATE oe.GroupProducts
                SET IsHidden = @isHidden,
                    ModifiedDate = GETDATE(),
                    ModifiedBy = @modifiedBy
                WHERE GroupId = @groupId AND ProductId = @productId AND IsActive = 1
            `);

        if (result.rowsAffected[0] === 0) {
            return res.status(404).json({ success: false, message: 'Group product not found' });
        }

        res.json({ success: true, message: isHidden ? 'Product hidden from new enrollments' : 'Product visible for new enrollments' });
    } catch (error) {
        console.error('Error toggling product visibility:', error);
        res.status(500).json({ success: false, message: 'Failed to update product visibility' });
    }
});
```

- [ ] **Step 2: Commit**

```bash
git add backend/routes/groupProducts.js
git commit -m "feat: add PATCH endpoint to toggle group product visibility"
```

---

### Task 5: Backend — Update enrollment-data query to exclude hidden GroupProducts

**Files:**
- Modify: `backend/routes/enrollment-links.js` (lines 1288-1294)

- [ ] **Step 1: Add IsHidden filter to the GroupProducts query in enrollment-data**

Find in `backend/routes/enrollment-links.js` (around line 1293):
```sql
WHERE gp.GroupId = @groupId AND gp.IsActive = 1 AND p.Status = 'Active'
  AND (p.IsHidden IS NULL OR p.IsHidden = 0)
```

Change to:
```sql
WHERE gp.GroupId = @groupId AND gp.IsActive = 1 AND p.Status = 'Active'
  AND (p.IsHidden IS NULL OR p.IsHidden = 0)
  AND (gp.IsHidden IS NULL OR gp.IsHidden = 0)
```

- [ ] **Step 2: Do NOT change the CustomSettings query**

The CustomSettings query at line 9678 should continue to return settings for hidden products. Existing enrollments need their configuration. No change needed — it only filters on `IsActive = 1`, which is correct.

- [ ] **Step 3: Commit**

```bash
git add backend/routes/enrollment-links.js
git commit -m "feat: exclude hidden GroupProducts from enrollment wizard product list"
```

---

### Task 6: Backend — Block product removal when enrollments exist, allow hide instead

**Files:**
- Modify: `backend/routes/groupProducts.js` (PUT endpoint, lines 527-546)

- [ ] **Step 1: Update the enrollment validation in the PUT endpoint**

The existing validation at lines 527-546 already blocks removal when enrollments exist with the message: `'You cannot remove a product members are already enrolled in, but you can remove from the enrollment link you send to new employees'`

Update the error message to guide agents toward the hide action:

Find:
```javascript
message: 'You cannot remove a product members are already enrolled in, but you can remove from the enrollment link you send to new employees'
```

Change to:
```javascript
message: 'Cannot remove a product that members are enrolled in. Use the hide option to prevent new enrollments while keeping existing ones active.'
```

- [ ] **Step 2: Commit**

```bash
git add backend/routes/groupProducts.js
git commit -m "fix: update product removal error message to suggest hiding"
```

---

### Task 7: Frontend — Add hide/unhide toggle to GroupProductsTab

**Files:**
- Modify: `frontend/src/pages/groups/GroupProductsTab.tsx` (actions column, lines 466-488)
- Modify: `frontend/src/services/group-products.service.ts` (add visibility toggle method)

- [ ] **Step 1: Add toggleProductVisibility method to the service**

In `frontend/src/services/group-products.service.ts`, add after the `updateGroupProducts` method:

```typescript
static async toggleProductVisibility(groupId: string, productId: string, isHidden: boolean): Promise<ApiResponse<any>> {
    try {
        return await apiService.patch<ApiResponse<any>>(
            `/api/groups/${groupId}/products/${productId}/visibility`,
            { isHidden }
        );
    } catch (error) {
        console.error(`Error toggling visibility for product ${productId} in group ${groupId}:`, error);
        return { success: false, data: null, message: 'Failed to update product visibility' };
    }
}
```

- [ ] **Step 2: Add the hide/unhide button to GroupProductsTab actions column**

In `frontend/src/pages/groups/GroupProductsTab.tsx`, find the actions column (around line 466-488). Add a hide/unhide button after the existing buttons. Import `EyeOff` from lucide-react at the top of the file.

Add to the imports:
```typescript
import { Eye, EyeOff, Settings, Package, LinkIcon, XCircle } from 'lucide-react';
```

In the actions `<td>` (after the Settings button, around line 487), add:

```tsx
<button
    onClick={async () => {
        const newHidden = !isProductHiddenForGroup(product);
        const response = await GroupProductsService.toggleProductVisibility(groupId, product.ProductId, newHidden);
        if (response.success) {
            refetch();
        }
    }}
    className={`${isProductHiddenForGroup(product) ? 'text-green-600 hover:text-green-700' : 'text-gray-400 hover:text-gray-600'}`}
    title={isProductHiddenForGroup(product) ? 'Show to new enrollees' : 'Hide from new enrollees'}
>
    {isProductHiddenForGroup(product) ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
</button>
```

- [ ] **Step 3: Import GroupProductsService if not already imported**

Check if `GroupProductsService` is imported in `GroupProductsTab.tsx`. If not, add:

```typescript
import { GroupProductsService } from '../../services/group-products.service';
```

- [ ] **Step 4: Verify in browser**

Navigate to a group's Products tab. Each product row should now show a hide/unhide icon button. Clicking it should toggle the hidden state and the "Hidden" badge should appear/disappear.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/services/group-products.service.ts frontend/src/pages/groups/GroupProductsTab.tsx
git commit -m "feat: add hide/unhide toggle for group products in UI"
```

---

### Task 8: Frontend — Update GroupsAddGroup removal validation message

**Files:**
- Modify: `frontend/src/pages/groups/GroupsAddGroup.tsx` (around line 925-934)

- [ ] **Step 1: Update the error message shown when trying to remove an enrolled product**

Find the `handleRemoveProduct` function (around line 925). Find the error message that matches:
```
You cannot remove a product members are already enrolled in
```

Change to match the backend message:
```
Cannot remove a product that members are enrolled in. Use the hide option on the Products tab to prevent new enrollments while keeping existing ones active.
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/pages/groups/GroupsAddGroup.tsx
git commit -m "fix: update product removal error to suggest hiding"
```

---

### Task 9: Verify end-to-end flow

- [ ] **Step 1: Test hide flow**
1. Go to a group with products and active enrollments
2. Click the hide (eye-off) icon on a product
3. Verify the "Hidden" badge appears
4. Open an enrollment link for that group
5. Verify the hidden product does NOT appear in the enrollment wizard
6. Verify existing members enrolled in that product can still view it in their plans

- [ ] **Step 2: Test removal block**
1. Try to remove a product with active enrollments via the GroupsAddGroup edit flow
2. Verify the error message appears guiding toward the hide option

- [ ] **Step 3: Test unhide flow**
1. Click the show (eye) icon on a hidden product
2. Verify the "Hidden" badge disappears
3. Open an enrollment link and verify the product reappears
