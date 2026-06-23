# ARM Export Fixes - January 15, 2026

## Summary
Fixed ARM export to correctly set Location Number (blank) and Group Number (product-specific VendorGroupId), and exclude test group members.

## Changes Made

### 1. Location Number - Set to Blank
**File:** `Project Docs/arm-export-view.sql`

**Change:** Location Number is now always blank (empty string) per ARM requirements.

```sql
-- Before:
ISNULL(CAST(gl.LocationId AS NVARCHAR(50)), '') AS [Location Number],

-- After:
'' AS [Location Number],
```

**Also removed:** Unused `LEFT JOIN oe.GroupLocations gl` since Location Number is no longer used.

### 2. Group Number - Product-Specific VendorGroupId Only
**File:** `backend/services/vendorExportService.js`

**Change:** Group Number now uses ONLY the product-specific VendorGroupId that links directly to the productId. Removed fallback to Master Group ID.

**Key Points:**
- Group Number must link directly to the productId (e.g., 90291 for CoPay, 90292 for HSA)
- Each enrollment gets its own row with the Group ID matching that specific product
- If no product-specific VendorGroupId exists, Group Number will be blank (empty string)
- No fallback to Master Group ID or Group Name

**Query Logic:**
```sql
OUTER APPLY (
    -- Get product-specific Group ID for the enrollment's product
    -- This links directly to the productId through GroupProducts -> GroupProductVendorGroupIds
    SELECT TOP 1 vgi.VendorGroupId
    FROM oe.GroupProducts gp_gid 
    INNER JOIN oe.GroupProductVendorGroupIds vgi ON vgi.GroupProductId = gp_gid.GroupProductId
    WHERE gp_gid.ProductId = p.ProductId  -- Match the enrollment's product
      AND gp_gid.GroupId = m.GroupId
      AND vgi.VendorId = @vendorId
      AND vgi.IsActive = 1
      AND gp_gid.IsActive = 1
      AND vgi.GroupProductId IS NOT NULL -- Must be product-specific (not Master)
) vgi_export
```

### 3. Exclude Test Group Members
**Files:** 
- `Project Docs/arm-export-view.sql`
- `backend/services/vendorExportService.js`

**Change:** Added filter to exclude test group members (GroupId = '00000000-0000-0000-0000-000000000000').

**In View:**
```sql
WHERE m.Status IN ('Active', 'Terminated')
  AND m.GroupId != '00000000-0000-0000-0000-000000000000' -- Exclude test group members
```

**In Service:**
```sql
WHERE p.VendorId = @vendorId
  AND (e.Status = 'Active' OR e.Status = 'Terminated')
  AND m.GroupId != '00000000-0000-0000-0000-000000000000' -- Exclude test group members
```

## Database Schema Requirements

For Group Number to work correctly, ensure:
1. **GroupProducts** table has entries linking products to groups
2. **GroupProductVendorGroupIds** table has product-specific VendorGroupId entries:
   - `GroupProductId` must NOT be NULL (product-specific, not Master)
   - `VendorId` matches the vendor
   - `IsActive = 1`
   - `VendorGroupId` contains the Group Number (e.g., '90291', '90292')

## Example Data Structure

```
Group: MightyWELL (GroupId: 27335A80-6CB1-441E-AFE9-AE6C8B73745C)
├── Product: CoPay Essential (ProductId: 9ABA9433-6BD9-4C3C-A210-6AA56DBBC423)
│   └── VendorGroupId: '90291' (ProductType: 'CoPay')
└── Product: HSA Essential (ProductId: 762F9EC1-E61E-4F8E-9D9C-5A10FCD2976A)
    └── VendorGroupId: '90292' (ProductType: 'HSA')
```

## Testing

To verify the fixes:
1. Run the ARM export for a vendor
2. Check that Location Number is blank for all rows
3. Check that Group Number matches the product-specific VendorGroupId (e.g., 90291 for CoPay, 90292 for HSA)
4. Verify no test group members (GroupId = 00000) appear in the export

## Files Modified

1. `Project Docs/arm-export-view.sql` - Updated view to set Location Number to blank and exclude test group
2. `backend/services/vendorExportService.js` - Updated query to use product-specific VendorGroupId only and exclude test group

## Next Steps

1. **Update Database View:** Run the updated `arm-export-view.sql` script to update the view
2. **Test Export:** Generate a new ARM export and verify the changes
3. **Compare with Reference:** Compare the new export with the reference file "ARM Eligibility 1-5-2026.csv"
