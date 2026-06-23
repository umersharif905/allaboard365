# Group Products Deductible Filter - Production Review

## Overview
This document reviews the implementation of the deductible/unshared amount filtering feature for group products and identifies potential production issues.

## Implementation Summary

### Database Storage
- **Table**: `oe.GroupProducts`
- **Column**: `CustomSettings` (NVARCHAR/JSON)
- **Structure**: 
  ```json
  {
    "allowedDeductibleOptions": {
      "Unshared Amount $": ["1500", "3000"],
      "Deductible": ["500", "1000"]
    }
  }
  ```

### Key Components

1. **Backend Route**: `PUT /api/groups/:groupId/products/:productId/deductible-config`
   - Location: `backend/routes/groupProducts.js` (lines 630-742)
   - Saves configuration to `CustomSettings.allowedDeductibleOptions`

2. **Backend GET Route**: `GET /api/groups/:groupId/products`
   - Location: `backend/routes/groupProducts.js` (lines 8-202)
   - Returns `RequiredDataFields` and `DeductibleFields` for each product

3. **Enrollment Filtering**: `GET /api/enrollment-links/:linkToken/product-pricing`
   - Location: `backend/routes/enrollment-links.js` (lines 6283-6346)
   - Filters `requiredDataFields` based on group `CustomSettings`

4. **Frontend UI**: `GroupProductsTab.tsx`
   - Modal for configuring deductible options
   - Validation requiring at least one option per field

## Potential Production Issues & Fixes

### Issue 1: ProductId Key Mismatch (FIXED)
**Problem**: ProductId from database (GUID object) might not match productId from PricingEngine (string) when used as object keys.

**Fix Applied**: Normalized ProductId to string on both sides:
- When storing: `String(row.ProductId)`
- When looking up: `String(product.productId)`

**Location**: `backend/routes/enrollment-links.js` lines 6301, 6318

### Issue 2: Route Registration Order (FIXED)
**Problem**: `groupsRoutes` was mounted before `groupProductsRoutes`, causing `/:id` route to catch `/:groupId/products` requests.

**Fix Applied**: Reordered route mounting in `app.js` so `groupProductsRoutes` mounts first.

**Location**: `backend/app.js` lines 519-524

### Issue 3: GroupAdmin Access Control (FIXED)
**Problem**: GroupAdmin users were being checked for tenant access instead of group-specific admin access.

**Fix Applied**: Added GroupAdmin-specific check using `oe.GroupAdmins` table.

**Location**: `backend/routes/groupProducts.js` lines 645-672

### Issue 4: TypeScript Syntax in JavaScript (FIXED)
**Problem**: Type annotations `(field: any)` caused "Unexpected token ':'" errors.

**Fix Applied**: Removed all TypeScript type annotations from JavaScript files.

**Locations**: 
- `backend/routes/groupProducts.js` line 162
- `backend/routes/enrollment-links.js` lines 6296, 6310, 6324

## Production Debugging Checklist

### 1. Verify Route Registration
Check server startup logs for:
```
✅ Group Products routes imported successfully
✅ Mounted /api/groups (products)
```

### 2. Verify Database Schema
Ensure `oe.GroupProducts` table has `CustomSettings` column:
```sql
SELECT COLUMN_NAME, DATA_TYPE 
FROM INFORMATION_SCHEMA.COLUMNS 
WHERE TABLE_SCHEMA = 'oe' 
  AND TABLE_NAME = 'GroupProducts' 
  AND COLUMN_NAME = 'CustomSettings'
```

### 3. Check ProductId Format
Verify ProductId consistency between:
- Database: `row.ProductId` (UniqueIdentifier)
- PricingEngine: `product.productId` (string)
- Both should be normalized to strings for object key matching

### 4. Verify RequiredDataFields Structure
Check that products have `RequiredDataFields` in correct format:
```sql
SELECT ProductId, Name, RequiredDataFields
FROM oe.Products
WHERE ProductId = 'your-product-id'
```

Expected format:
```json
[
  {
    "fieldName": "Unshared Amount $",
    "fieldOptions": ["1500", "3000", "6000"],
    "isDeductible": true,
    "markAsDeductible": true
  }
]
```

### 5. Check CustomSettings Storage
Verify configuration is being saved:
```sql
SELECT GroupId, ProductId, CustomSettings
FROM oe.GroupProducts
WHERE GroupId = 'your-group-id'
  AND ProductId = 'your-product-id'
  AND IsActive = 1
```

### 6. Enable Debug Logging
The code includes debug logs. Check for:
- `🔍 DEBUG: Loaded group product settings for X products`
- `🔍 DEBUG: Filtered deductible options for product...`
- `🔍 DEBUG: Product IDs in settings: [...]`

## Common Production Issues

### Issue: Settings Not Loading
**Symptoms**: No deductible options filtered during enrollment
**Possible Causes**:
1. `CustomSettings` column doesn't exist
2. JSON parsing errors
3. ProductId key mismatch
4. GroupId not matching

**Debug Steps**:
1. Check server logs for parsing errors
2. Verify ProductId format matches between storage and lookup
3. Check that `enrollmentLink.GroupId` is not null

### Issue: Settings Not Saving
**Symptoms**: Configuration modal saves but changes don't persist
**Possible Causes**:
1. `CustomSettings` column is NULL or wrong type
2. JSON stringify errors
3. Transaction rollback
4. Permission issues

**Debug Steps**:
1. Check for SQL errors in server logs
2. Verify `CustomSettings` column accepts JSON
3. Check user permissions for UPDATE on `oe.GroupProducts`

### Issue: Filtering Not Working
**Symptoms**: All options still show in enrollment wizard
**Possible Causes**:
1. `groupProductSettings` object is empty
2. ProductId key mismatch
3. Field name mismatch (case sensitivity)
4. `requiredDataFields` not present in product object

**Debug Steps**:
1. Check debug logs for "Loaded group product settings"
2. Verify ProductId keys match exactly
3. Check field name matching (case-sensitive)
4. Verify `product.requiredDataFields` exists

## Field Name Matching

The filtering uses **exact case-sensitive matching** for field names:
- Stored: `"Unshared Amount $"` 
- Must match exactly: `"Unshared Amount $"` (not `"unshared amount $"` or `"Unshared Amount"`)

This is intentional for insurance compliance - field names must match exactly.

## Testing Checklist

1. ✅ Save configuration with selected options
2. ✅ Verify `CustomSettings` is updated in database
3. ✅ Load group products and verify `DeductibleFields` are identified
4. ✅ Test enrollment wizard shows only selected options
5. ✅ Verify filtering works for multiple products
6. ✅ Test with GroupAdmin user
7. ✅ Verify validation (at least one option required)

## Next Steps for Production

1. **Restart backend server** to load route changes
2. **Check server logs** for route registration messages
3. **Test with a known product** that has deductible fields
4. **Verify database** has `CustomSettings` column
5. **Check browser console** for any frontend errors
6. **Review debug logs** during enrollment to see filtering in action

