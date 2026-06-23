# ARM Group ID System Documentation

## Overview

The Group ID system is used to generate vendor-specific Group IDs for groups that have products associated with a particular vendor. Each vendor may have their own Group ID generation pattern. This document focuses on the ARM vendor implementation, but the system is designed to support vendor-specific patterns.

## Key Concepts

- **Group IDs are vendor-specific**: Each vendor may have their own Group ID generation process
- **Product-specific**: Group IDs are product-specific for each Group
- **Vendor-exclusive**: Group IDs are only needed for groups that have products for the selected Vendor
- **Prefix + Seed Pattern**: ARM uses a prefix (e.g., "90") combined with a seed number (e.g., 285) to generate sequential Group IDs

## ARM Group ID Pattern

### Pattern Structure

ARM Group IDs follow this pattern:
- **Prefix**: A string prefix (e.g., "90")
- **Seed Number**: Starting number for the first group (e.g., 285)
- **Result**: Combined prefix + seed = Group ID (e.g., 90285)

### ARM Examples

#### Existing Groups (Already Assigned)
**Cramerton Christian Academy**
- **Master Group ID**: 90285
- **CoPay Plan Group ID**: 90286
- **HSA Plan Group ID**: 90287

**Vision Eye Center**
- **Master Group ID**: 90290
- **CoPay Plan Group ID**: 90291
- **HSA Plan Group ID**: 90292

#### New Groups (Starting from Seed 90500)
**First New Group**
- **Master Group ID**: 90500
- **CoPay Plan Group ID**: 90501
- **HSA Plan Group ID**: 90502

**Second New Group**
- **Master Group ID**: 90505
- **CoPay Plan Group ID**: 90506
- **HSA Plan Group ID**: 90507

### Pattern Rules

1. **Master Group ID**: Each group starts with a Master Group ID
2. **Product Variants**: CoPay plans use Master + 1, HSA plans use Master + 2
3. **Existing Groups**: Already assigned (e.g., 90285, 90290) - these remain unchanged
4. **New Groups**: Starting from seed (90500), each new group's Master increments by 5
   - First new group: 90500
   - Second new group: 90505
   - Third new group: 90510
   - And so on...

### ARM Configuration

For the ARM vendor:
- **GroupIdPrefix**: `NULL` (optional - not used for ARM)
- **GroupIdSeedNumber**: `90500`

This configuration results in:
- First group: 90500 (Master), 90501 (CoPay), 90502 (HSA)
- Second group: 90505 (Master), 90506 (CoPay), 90507 (HSA)
- Third group: 90510 (Master), 90511 (CoPay), 90512 (HSA)

**Note**: ARM is the only vendor that uses the automatic numbering sequence. Other vendors can have Group IDs manually created. The prefix is optional and can be null.

## Database Schema

### Table: `oe.Vendors`

Two new columns were added to store Group ID settings:

#### `GroupIdPrefix`
- **Type**: `NVARCHAR(50)`
- **Nullable**: `YES`
- **Description**: Prefix string for Group ID generation (e.g., "90" for ARM)

#### `GroupIdSeedNumber`
- **Type**: `INT`
- **Nullable**: `YES`
- **Description**: Starting seed number for the first group (e.g., 90500 for ARM)

### Migration Script

The schema changes are implemented in:
```
Project Docs/vendor-groupid-settings-schema.sql
```

**To apply the migration:**
1. Run the SQL script against the `open-enroll` database
2. The script includes idempotent checks to prevent duplicate column creation
3. Both columns are nullable to support vendors that don't use this pattern

## Implementation Details

### Frontend Implementation

**File**: `frontend/src/pages/admin/Vendors.tsx`

#### Interface Definition
```typescript
interface Vendor {
  // ... other fields
  GroupIdPrefix?: string; // Prefix for Group IDs (e.g., "90")
  GroupIdSeedNumber?: number; // Starting seed number for first group (e.g., 285)
}
```

#### Form Fields
The Group IDs tab includes two input fields:
1. **Group ID Prefix**: Text input for the prefix string
2. **Seed Number**: Number input for the starting seed

#### Form Submission
When updating a vendor, the form sends:
```typescript
{
  groupIdPrefix: formData.GroupIdPrefix?.trim() || null,
  groupIdSeedNumber: formData.GroupIdSeedNumber || null,
  // ... other vendor fields
}
```

### Backend Implementation

**File**: `backend/routes/vendors.js`

#### CREATE Endpoint (`POST /api/vendors`)
- Extracts `groupIdPrefix` and `groupIdSeedNumber` from request body
- Inserts values into `oe.Vendors` table

#### UPDATE Endpoint (`PUT /api/vendors/:id`)
- Extracts `groupIdPrefix` and `groupIdSeedNumber` from request body
- Updates both fields in the SQL UPDATE query
- Fields are set to `NULL` if not provided or empty

#### SQL Query Example
```sql
UPDATE oe.Vendors
SET 
    -- ... other fields
    GroupIdPrefix = @groupIdPrefix,
    GroupIdSeedNumber = @groupIdSeedNumber,
    ModifiedBy = @userId,
    ModifiedDate = GETDATE()
WHERE VendorId = @vendorId
```

## Usage Instructions

### Setting Group ID Settings for ARM

1. Navigate to **SysAdmin → Vendors**
2. Click **Edit** on the ARM vendor
3. Go to the **Group IDs** tab
4. Enter:
   - **Group ID Prefix**: (leave empty/null - optional)
   - **Seed Number**: `90500`
5. Click **Update Vendor**

**Note**: The prefix is optional. For ARM, leave it empty and set the seed to 90500.

### Verifying Database Columns

To confirm the columns exist in the database:
```sql
SELECT 
    COLUMN_NAME,
    DATA_TYPE,
    CHARACTER_MAXIMUM_LENGTH,
    IS_NULLABLE
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = 'oe'
AND TABLE_NAME = 'Vendors'
AND COLUMN_NAME IN ('GroupIdPrefix', 'GroupIdSeedNumber')
ORDER BY COLUMN_NAME
```

## Important Notes

### Vendor-Specific Patterns

⚠️ **Important**: The Group ID pattern described in this document is specific to ARM. Other vendors may use completely different Group ID generation processes. The system is designed to be flexible and support vendor-specific implementations.

### Group ID Generation Logic

✅ **IMPLEMENTED**: The Group ID generation logic is now fully implemented and automatically generates vendor-specific Group IDs when products are assigned to groups.

#### Implementation Details

1. **Automatic Generation**: When a group is created with products for a vendor, Group IDs are automatically generated based on:
   - The vendor's `GroupIdPrefix` and `GroupIdSeedNumber`
   - The number of existing groups for that vendor
   - The product type (Master, CoPay, HSA) - auto-detected from product name

2. **Product-Specific IDs**: Each product type within a group gets its own Group ID:
   - Master products: Base Group ID (e.g., 90285)
   - CoPay products: Base Group ID + 1 (e.g., 90286)
   - HSA products: Base Group ID + 2 (e.g., 90287)

3. **Increment Pattern**: For ARM, each new group increments the Master Group ID by 5:
   - Group 1: 90500 (Master), 90501 (CoPay), 90502 (HSA)
   - Group 2: 90505 (Master), 90506 (CoPay), 90507 (HSA)
   - Group 3: 90510 (Master), 90511 (CoPay), 90512 (HSA)

4. **Storage**: Generated Group IDs are stored in `oe.GroupProductVendorGroupIds` table, linking:
   - `GroupProductId` (which product in which group)
   - `VendorId` (which vendor)
   - `VendorGroupId` (the Group ID like "90500" - can be auto-generated or manual)
   - `ProductType` (Master, CoPay, or HSA - for ARM pattern)
   - `IsAutoGenerated` (flag to distinguish auto-generated vs manual)

5. **Manual Creation**: Group IDs can be manually created for any vendor using the API endpoints:
   - `POST /api/vendor-group-ids` - Create a manual Group ID
   - `PUT /api/vendor-group-ids/group-product/:groupProductId/vendor/:vendorId` - Update a Group ID
   - `DELETE /api/vendor-group-ids/group-product/:groupProductId/vendor/:vendorId` - Delete a Group ID
   - `GET /api/vendor-group-ids/group/:groupId/vendor/:vendorId` - Get all Group IDs for a group

6. **Export Integration**: The ARM export view (`oe.v_ARM_Export_Data`) now uses the generated Group IDs instead of Group Name for the `[Group Number]` field.

## Related Files

- **Database Schema (Settings)**: `Project Docs/vendor-groupid-settings-schema.sql` - Adds GroupIdPrefix and GroupIdSeedNumber to Vendors table
- **Database Schema (Storage)**: `Project Docs/vendor-groupid-storage-schema.sql` - Creates GroupProductVendorGroupIds table
- **Frontend Component**: `frontend/src/pages/admin/Vendors.tsx` - UI for setting Group ID prefix and seed
- **Backend Routes**: `backend/routes/vendors.js` - Vendor CRUD with Group ID settings
- **Backend Routes**: `backend/routes/groups.js` - Group creation with automatic Group ID generation
- **Backend Service**: `backend/services/vendorGroupIdService.js` - Group ID generation logic
- **ARM Export View**: `Project Docs/arm-export-view.sql` - Uses generated Group IDs in exports

## Troubleshooting

### Columns Not Found

If you receive an error that `GroupIdPrefix` or `GroupIdSeedNumber` is not defined:

1. **Check if migration was run**: Query `INFORMATION_SCHEMA.COLUMNS` to verify columns exist
2. **Run migration script**: Execute `Project Docs/vendor-groupid-settings-schema.sql`
3. **Verify database**: Ensure you're connected to the correct database (`open-enroll`)

### Values Not Saving

If Group ID settings are not saving:

1. **Check frontend form**: Verify fields are included in form submission
2. **Check backend logs**: Look for SQL errors in the UPDATE query
3. **Verify permissions**: Ensure user has permission to update vendors
4. **Check data types**: Ensure `GroupIdSeedNumber` is a valid integer

## Change History

- **2026-01-11**: Initial implementation
  - Added `GroupIdPrefix` and `GroupIdSeedNumber` columns to `oe.Vendors` table
  - Added UI fields in Vendor edit form (Group IDs tab)
  - Updated backend CREATE and UPDATE endpoints
  - Created migration script

- **2026-01-12**: Group ID Generation Implementation
  - Created `oe.GroupProductVendorGroupIds` table to store Group IDs at GroupProduct level
  - Implemented `VendorGroupIdService` with ARM pattern logic (starting at 90500)
  - Integrated automatic Group ID generation into group creation/product assignment
  - Updated ARM export view to use generated Group IDs
  - Product type auto-detection (Master, CoPay, HSA) from product names
  - Added `IsAutoGenerated` flag to distinguish auto-generated vs manual Group IDs
  - Added API endpoints for manual Group ID creation/management (`/api/vendor-group-ids`)
  - Support for manual Group ID creation for any vendor (not just ARM)
