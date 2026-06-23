# Vendor TPA Services Documentation

## Overview

The Vendor TPA (Third Party Administrator) Services feature allows vendors to provide tenant-specific TPA services. Each vendor-tenant relationship can have different TPA services configured, enabling flexible service offerings per tenant.

**Key Features:**
- Tenant-specific TPA service configurations
- Multiple TPA services per vendor-tenant pair
- ACH Account linking for Commissions Processing
- Tenant-specific contact information
- Unique constraint: One TPA service configuration per vendor-tenant pair

---

## Database Schema

### Table: `oe.VendorTenantTpaServices`

**Location:** `Project Docs/vendor-tenant-tpa-services-schema.sql`

#### Primary Key
- `VendorTenantTpaServiceId` (UNIQUEIDENTIFIER) - Primary key

#### Foreign Keys
- `VendorId` (UNIQUEIDENTIFIER) → `oe.Vendors.VendorId`
- `TenantId` (UNIQUEIDENTIFIER) → `oe.Tenants.TenantId`
- `TpaAchAccountId` (UNIQUEIDENTIFIER) → `oe.ACHAccounts.ACHAccountId`
- `CreatedBy` (UNIQUEIDENTIFIER) → `oe.Users.UserId`
- `ModifiedBy` (UNIQUEIDENTIFIER) → `oe.Users.UserId`

#### TPA Service Flags (BIT fields, default 0)
1. `TpaClaimsProcessing` - Claims processing services
2. `TpaEnrollmentManagement` - Enrollment management services
3. `TpaCustomerService` - Customer service support
4. `TpaMemberSupport` - Member support services
5. `TpaReporting` - Reporting & analytics services
6. `TpaCompliance` - Compliance services
7. `TpaBillingCollections` - Billing & collections services
8. `TpaCobraAdministration` - COBRA administration services
9. `TpaCommissionsProcessing` - **Commissions Processing** (requires ACH Account)

#### Contact Information
- `TpaContactName` (NVARCHAR(255)) - Contact person name
- `TpaContactEmail` (NVARCHAR(255)) - Contact email address
- `TpaContactPhone` (NVARCHAR(20)) - Contact phone number
- `TpaPortalUrl` (NVARCHAR(500)) - TPA portal URL
- `TpaNotes` (NVARCHAR(MAX)) - Additional notes

#### ACH Account
- `TpaAchAccountId` (UNIQUEIDENTIFIER) - **Required** when `TpaCommissionsProcessing = 1`

#### Audit Fields
- `CreatedBy` (UNIQUEIDENTIFIER) - User who created the record
- `CreatedDate` (DATETIME2) - Creation timestamp
- `ModifiedBy` (UNIQUEIDENTIFIER) - User who last modified the record
- `ModifiedDate` (DATETIME2) - Last modification timestamp

#### Constraints
- **Unique Constraint:** `UQ_VendorTenantTpaServices_VendorTenant` - Ensures one TPA service configuration per vendor-tenant pair
- **Foreign Key Constraints:** All foreign keys have referential integrity

#### Indexes
- `IX_VendorTenantTpaServices_VendorId` - Index on VendorId for fast vendor lookups
- `IX_VendorTenantTpaServices_TenantId` - Index on TenantId for fast tenant lookups
- `IX_VendorTenantTpaServices_TpaCommissionsProcessing` - Filtered index on TpaCommissionsProcessing (WHERE = 1)

---

## API Endpoints

### Base Path
All TPA services endpoints are under `/api/vendors/:id/tpa-services`

**Important Route Order:** These routes MUST be defined BEFORE the general `/:id` route to ensure proper matching:
1. `/:id/tpa-services/:tenantId` (most specific)
2. `/:id/tpa-services` (specific)
3. `/:id` (general)

### 1. GET `/api/vendors/:id/tpa-services/:tenantId`
Get TPA services for a specific vendor-tenant relationship.

**Authorization:** `SysAdmin`, `TenantAdmin`

**Response:**
```json
{
  "success": true,
  "data": {
    "VendorTenantTpaServiceId": "uuid",
    "VendorId": "uuid",
    "TenantId": "uuid",
    "TenantName": "Tenant Name",
    "TpaClaimsProcessing": true,
    "TpaEnrollmentManagement": false,
    "TpaCustomerService": true,
    "TpaMemberSupport": false,
    "TpaReporting": true,
    "TpaCompliance": false,
    "TpaBillingCollections": false,
    "TpaCobraAdministration": false,
    "TpaCommissionsProcessing": true,
    "TpaContactName": "John Doe",
    "TpaContactEmail": "john@example.com",
    "TpaContactPhone": "555-1234",
    "TpaPortalUrl": "https://portal.example.com",
    "TpaNotes": "Additional notes",
    "TpaAchAccountId": "uuid",
    "AchAccountHolderName": "ARM (TPA Account)",
    "AchBankName": "Bank Name",
    "AchAccountNumberLast4": "9719",
    "AchAccountType": "Checking",
    "CreatedDate": "2026-01-13T19:58:47.976Z",
    "ModifiedDate": "2026-01-13T20:01:22.523Z"
  }
}
```

**Error Responses:**
- `404` - TPA services configuration not found
- `500` - Server error

---

### 2. GET `/api/vendors/:id/tpa-services`
Get all tenant-specific TPA services for a vendor.

**Authorization:** `SysAdmin`, `TenantAdmin`

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "VendorTenantTpaServiceId": "uuid",
      "VendorId": "uuid",
      "TenantId": "uuid",
      "TenantName": "Tenant Name",
      // ... same fields as above
    }
  ]
}
```

**Error Responses:**
- `500` - Server error

---

### 3. POST `/api/vendors/:id/tpa-services`
Create or update TPA services for a vendor-tenant relationship.

**Authorization:** `SysAdmin`, `TenantAdmin`

**Request Body:**
```json
{
  "tenantId": "uuid",
  "tpaClaimsProcessing": true,
  "tpaEnrollmentManagement": false,
  "tpaCustomerService": true,
  "tpaMemberSupport": false,
  "tpaReporting": true,
  "tpaCompliance": false,
  "tpaBillingCollections": false,
  "tpaCobraAdministration": false,
  "tpaCommissionsProcessing": true,
  "tpaContactName": "John Doe",
  "tpaContactEmail": "john@example.com",
  "tpaContactPhone": "555-1234",
  "tpaPortalUrl": "https://portal.example.com",
  "tpaNotes": "Additional notes",
  "tpaAchAccountId": "uuid"  // Required if tpaCommissionsProcessing is true
}
```

**Validation Rules:**
- `tenantId` is required
- If `tpaCommissionsProcessing` is `true`, `tpaAchAccountId` is required
- Vendor must exist
- Tenant must exist
- ACH Account (if provided) must exist and belong to the vendor

**Response:**
```json
{
  "success": true,
  "message": "TPA services configuration created successfully" // or "updated successfully"
}
```

**Error Responses:**
- `400` - Validation error (missing tenantId, missing ACH account when required, etc.)
- `404` - Vendor or Tenant not found
- `500` - Server error

**Behavior:**
- If a configuration exists for the vendor-tenant pair, it performs an UPDATE
- If no configuration exists, it performs an INSERT
- Uses a database transaction to ensure data consistency

---

### 4. DELETE `/api/vendors/:id/tpa-services/:tenantId`
Delete TPA services configuration for a vendor-tenant relationship.

**Authorization:** `SysAdmin` only

**Response:**
```json
{
  "success": true,
  "message": "TPA services configuration deleted successfully"
}
```

**Error Responses:**
- `404` - TPA services configuration not found
- `500` - Server error

---

### 5. GET `/api/tenants/:id/vendor-tpa-services` (Tenant-Facing)
Get all TPA services provided to a tenant by all vendors.

**Authorization:** `SysAdmin`, `TenantAdmin`

**Location:** `backend/routes/tenants.js`

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "VendorTenantTpaServiceId": "uuid",
      "VendorId": "uuid",
      "VendorName": "Vendor Name",
      "TenantId": "uuid",
      // ... TPA service fields
    }
  ]
}
```

---

## Frontend Implementation

### Location
`frontend/src/pages/admin/Vendors.tsx`

### TPA Services Tab
The TPA Services tab is accessible from the "Edit Vendor" modal.

**UI Components:**
1. **Table View** - Lists all configured tenant TPA services
   - Columns: Tenant, Services (badges), Contact, ACH Account, Actions
   - Empty state message when no services are configured

2. **Add/Edit Modal** - `TpaServicesModal`
   - Tenant selection dropdown
   - TPA service switches (9 services)
   - ACH Account dropdown (conditionally required for Commissions Processing)
   - Contact information fields
   - Portal URL and Notes fields

### Key Functions

#### `fetchVendorTenantTpaServices`
Fetches all TPA services for the selected vendor.

**API Call:**
```typescript
GET /api/vendors/:vendorId/tpa-services
```

#### `fetchSingleVendorTenantTpaService`
Fetches a specific vendor-tenant TPA service configuration.

**API Call:**
```typescript
GET /api/vendors/:vendorId/tpa-services/:tenantId
```

#### `handleSaveTpaServices`
Creates or updates a TPA service configuration.

**API Call:**
```typescript
POST /api/vendors/:vendorId/tpa-services
```

**Validation:**
- Validates that `TpaCommissionsProcessing` requires `TpaAchAccountId`
- Shows error messages for validation failures

#### `handleDeleteTpaServices`
Deletes a TPA service configuration.

**API Call:**
```typescript
DELETE /api/vendors/:vendorId/tpa-services/:tenantId
```

### State Management

```typescript
// TPA Services state
const [tpaServices, setTpaServices] = useState<any[]>([]);
const [tpaLoading, setTpaLoading] = useState(false);
const [tpaError, setTpaError] = useState<string | null>(null);
const [tpaModalOpen, setTpaModalOpen] = useState(false);
const [tpaModalMode, setTpaModalMode] = useState<'add' | 'edit'>('add');
const [tpaFormData, setTpaFormData] = useState({...});
const [tpaModalFieldErrors, setTpaModalFieldErrors] = useState({...});
const [availableTenants, setAvailableTenants] = useState<any[]>([]);
const [availableAchAccounts, setAvailableAchAccounts] = useState<any[]>([]);
```

### UI Styling
- Uses Tailwind CSS classes
- "Add Tenant TPA Services" button uses `bg-oe-primary hover:bg-oe-primary-dark`
- Follows OpenEnroll UI consistency rules (no Material-UI components, Lucide React icons only)

---

## Usage Instructions

### For System Administrators

1. **Navigate to Vendors:**
   - Go to SysAdmin → Vendors
   - Click "Edit" on a vendor

2. **Access TPA Services Tab:**
   - Click the "TPA Services" tab in the Edit Vendor modal

3. **Add Tenant TPA Services:**
   - Click "+ Add Tenant TPA Services" button
   - Select a tenant from the dropdown
   - Enable/disable TPA services using the switches
   - If "Commissions Processing" is enabled, select an ACH Account
   - Fill in contact information (optional)
   - Add portal URL and notes (optional)
   - Click "Save TPA Services"

4. **Edit Tenant TPA Services:**
   - Click the edit icon (pencil) next to a tenant in the table
   - Modify the services and information
   - Click "Save TPA Services"

5. **Delete Tenant TPA Services:**
   - Click the delete icon (trash) next to a tenant in the table
   - Confirm deletion

### For Tenant Administrators

1. **View TPA Services:**
   - Navigate to your tenant settings
   - View which vendors provide TPA services to your tenant
   - Access via: `GET /api/tenants/:id/vendor-tpa-services`

---

## Important Notes

### Commissions Processing
- **Requires ACH Account:** When `TpaCommissionsProcessing` is enabled, an ACH Account must be selected
- **Validation:** Backend validates that `tpaAchAccountId` is provided when `tpaCommissionsProcessing` is `true`
- **ACH Account Ownership:** The ACH Account must belong to the vendor (`EntityType = 'Vendor'` and `EntityId = VendorId`)

### Unique Constraint
- Only **one** TPA service configuration can exist per vendor-tenant pair
- Attempting to create a duplicate will result in an UPDATE instead of an INSERT
- The unique constraint is enforced at the database level

### Route Order
- **Critical:** TPA services routes MUST be defined before the general `/:id` route
- Order: `/:id/tpa-services/:tenantId` → `/:id/tpa-services` → `/:id`
- This ensures Express matches the correct route

### Transaction Safety
- All CREATE/UPDATE operations use database transactions
- If any part of the operation fails, the entire transaction is rolled back
- Ensures data consistency

### Separation from Vendor Table
- TPA services are **NOT** stored in the `oe.Vendors` table
- They are stored in the separate `oe.VendorTenantTpaServices` table
- The vendor CREATE/UPDATE endpoints do NOT handle TPA service fields
- TPA services must be managed through the dedicated TPA services endpoints

---

## Database Migration

### Running the Migration

1. **Execute the SQL script:**
   ```sql
   -- Run: Project Docs/vendor-tenant-tpa-services-schema.sql
   ```

2. **Verify the table was created:**
   ```sql
   SELECT * FROM INFORMATION_SCHEMA.TABLES 
   WHERE TABLE_SCHEMA = 'oe' 
   AND TABLE_NAME = 'VendorTenantTpaServices'
   ```

3. **Verify columns exist:**
   ```sql
   SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE 
   FROM INFORMATION_SCHEMA.COLUMNS 
   WHERE TABLE_SCHEMA = 'oe' 
   AND TABLE_NAME = 'VendorTenantTpaServices'
   ORDER BY ORDINAL_POSITION
   ```

### Backward Compatibility
The migration script includes checks to add missing columns:
- `TpaCommissionsProcessing` - Added if missing
- `TpaAchAccountId` - Added if missing (with foreign key constraint)

---

## Example Use Cases

### Example 1: ARM Vendor with Commissions Processing
```json
{
  "vendorId": "406B4EEA-F334-4EFC-82D5-89545E55CC01",
  "tenantId": "tenant-uuid",
  "tpaCommissionsProcessing": true,
  "tpaAchAccountId": "315E2D5F-6569-4EA2-A841-6C39259AEFFF",
  "tpaContactName": "ARM TPA Team",
  "tpaContactEmail": "tpa@arm.com",
  "tpaContactPhone": "555-1234",
  "tpaPortalUrl": "https://portal.arm.com",
  "tpaNotes": "Commissions processed monthly"
}
```

### Example 2: Multiple TPA Services
```json
{
  "vendorId": "vendor-uuid",
  "tenantId": "tenant-uuid",
  "tpaClaimsProcessing": true,
  "tpaEnrollmentManagement": true,
  "tpaCustomerService": true,
  "tpaMemberSupport": true,
  "tpaReporting": true,
  "tpaCompliance": false,
  "tpaBillingCollections": false,
  "tpaCobraAdministration": false,
  "tpaCommissionsProcessing": false,
  "tpaContactName": "TPA Support Team",
  "tpaContactEmail": "support@tpa.com"
}
```

---

## Troubleshooting

### Error: "Invalid column name 'TpaNotes'"
**Cause:** TPA service fields are being sent to the vendor UPDATE endpoint  
**Solution:** TPA services are managed separately. Remove TPA service fields from vendor CREATE/UPDATE requests.

### Error: "ACH Account is required when Commissions Processing is enabled"
**Cause:** `tpaCommissionsProcessing` is `true` but `tpaAchAccountId` is missing  
**Solution:** Select an ACH Account when enabling Commissions Processing.

### Error: "The parameter name exportMethod has already been declared"
**Cause:** Duplicate parameter declarations in SQL request  
**Solution:** Ensure each parameter is declared only once per SQL request.

### Error: "TPA services configuration not found"
**Cause:** No TPA service configuration exists for the vendor-tenant pair  
**Solution:** Create a new TPA service configuration using the POST endpoint.

### Error: 404 on GET `/api/vendors/:id/tpa-services`
**Cause:** Route order issue - `/:id` route is matching before `/:id/tpa-services`  
**Solution:** Ensure TPA services routes are defined BEFORE the `/:id` route in `backend/routes/vendors.js`.

---

## Related Files

### Backend
- `backend/routes/vendors.js` - TPA services endpoints (lines 985-1415)
- `backend/routes/tenants.js` - Tenant-facing TPA services endpoint
- `Project Docs/vendor-tenant-tpa-services-schema.sql` - Database schema

### Frontend
- `frontend/src/pages/admin/Vendors.tsx` - TPA services UI implementation
- `frontend/src/styles/theme.css` - Primary color definitions

---

## Change History

### 2026-01-13
- Initial implementation of tenant-specific TPA services
- Created `oe.VendorTenantTpaServices` table
- Implemented CRUD endpoints
- Added Commissions Processing service with ACH Account requirement
- Separated TPA services from vendor table
- Fixed route order issues
- Fixed duplicate parameter declaration errors
- Added tenant-facing endpoint for viewing TPA services

---

## Future Enhancements

Potential improvements:
- Bulk import/export of TPA service configurations
- TPA service templates
- Service-level permissions
- Audit trail for TPA service changes
- Integration with commission processing workflows
- Automated ACH account validation
