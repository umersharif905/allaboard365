# Agent Onboarding Database Population Fix

## Problem Summary
Agent onboarding was only creating records in `oe.Users` and `oe.Agents` tables, but not populating the other agent-related tables needed for the Agent Portal Settings page.

## Tables Affected
- ✅ `oe.Users` - User account (NOW INCLUDES PASSWORD HASH)
- ✅ `oe.Agents` - Agent record (NOW INCLUDES ALL FIELDS)
- ✅ `oe.AgentBankInfo` - **NEW** Banking information
- ✅ `oe.AgentDocuments` - **NEW** Document URLs from Azure Blob Storage
- ✅ `oe.AgentLicenses` - **NEW** License information (NPN, state)

## Files Modified

### Backend Files
1. **`backend/routes/public/onboarding.js`**
   - Added password extraction from `agentData`
   - Enhanced `oe.Users` INSERT to include `PasswordHash`
   - Enhanced `oe.Agents` INSERT to include all available fields
   - Added `oe.AgentBankInfo` INSERT for banking details
   - Added `oe.AgentDocuments` INSERT for uploaded documents
   - Added `oe.AgentLicenses` INSERT for license information
   - Added tenant domain query for redirect URL

### Frontend Files
1. **`frontend/src/pages/public/AgentOnboarding.tsx`**
   - Fixed ContractStep to call `nextStep` instead of `completeOnboarding`
   - Fixed password data extraction (moved inside `agentData`)
   - Changed redirect from local route to tenant domain/production URL
   - Added password step properly in navigation flow

2. **`frontend/src/components/onboarding/PasswordStep.tsx`**
   - Created new password step component
   - Added password validation UI
   - Added real-time requirements checking
   - Added show/hide password functionality

## Database Changes

### oe.Users Table
```sql
-- Now includes PasswordHash column
INSERT INTO oe.Users (
    UserId, FirstName, LastName, Email, PhoneNumber, PasswordHash,
    UserType, TenantId, Status, CreatedDate, ModifiedDate, CreatedBy, ModifiedBy
) VALUES (...)
```

### oe.Agents Table
```sql
-- Now includes all personal and business information
INSERT INTO oe.Agents (
    AgentId, UserId, TenantId, Status, AgentType, NPN,
    Phone, Email, FirstName, LastName, Address1, Address2,
    City, State, ZipCode, SSNOrTaxID, BusinessName,
    CreatedDate, ModifiedDate, CreatedBy, ModifiedBy
) VALUES (...)
```

### oe.AgentBankInfo Table (NEW)
```sql
-- Banking information with encryption support
INSERT INTO oe.AgentBankInfo (
    BankInfoId, AgentId, BankName, AccountName, AccountType,
    RoutingNumber, AccountNumberEncrypted, AccountNumberLast4,
    Status, IsDefault, VerificationStatus, CreatedDate, ModifiedDate, CreatedBy, ModifiedBy
) VALUES (...)
```

### oe.AgentDocuments Table (NEW)
```sql
-- Document URLs from Azure Blob Storage
INSERT INTO oe.AgentDocuments (
    DocumentId, AgentId, DocumentType, FileName, FileUrl,
    FileSize, FileType, Description, Status, CreatedDate, ModifiedDate, CreatedBy, ModifiedBy
) VALUES (...)
```

### oe.AgentLicenses Table (NEW)
```sql
-- License information
INSERT INTO oe.AgentLicenses (
    LicenseId, AgentId, StateCode, LicenseNumber, LicenseType,
    Status, CreatedDate, ModifiedDate, CreatedBy, ModifiedBy
) VALUES (...)
```

## Data Mapping

### Personal Information → oe.Agents
- `firstName` → `FirstName`
- `lastName` → `LastName`
- `email` → `Email`
- `phone` → `Phone`
- `address` → `Address1`
- `address2` → `Address2`
- `city` → `City`
- `state` → `State`
- `zip` → `ZipCode`
- `npn` → `NPN`
- `taxId` → `SSNOrTaxID`
- `companyName` → `BusinessName`

### Banking Information → oe.AgentBankInfo
- `bankName` → `BankName`
- `accountNumber` → `AccountNumberEncrypted` + `AccountNumberLast4`
- `routingNumber` → `RoutingNumber`
- `accountType` → `AccountType`

### Documents → oe.AgentDocuments
- `documentUrls[]` → Multiple records in `oe.AgentDocuments`
- Each URL becomes a separate document record
- `FileUrl` stores the Azure Blob Storage URL

### License → oe.AgentLicenses
- `npn` → `LicenseNumber`
- `state` → `StateCode`
- `LicenseType` = 'Insurance Agent'

## Deployment Instructions

### Step 1: Deploy Backend Changes
```bash
cd backend
git pull origin master
npm install  # if package.json changed
node app.js  # or use your production startup script
```

### Step 2: Deploy Frontend Changes
```bash
cd frontend
git pull origin master
npm install  # if package.json changed
npm run build
# Deploy dist folder to production
```

### Step 3: Verify Deployment
1. Complete a new agent onboarding
2. Check all tables are populated:
   ```sql
   SELECT * FROM oe.Users WHERE Email = 'test@example.com';
   SELECT * FROM oe.Agents WHERE Email = 'test@example.com';
   SELECT * FROM oe.AgentBankInfo WHERE AgentId = '...';
   SELECT * FROM oe.AgentDocuments WHERE AgentId = '...';
   SELECT * FROM oe.AgentLicenses WHERE AgentId = '...';
   ```
3. Log in to Agent Portal
4. Go to Settings page
5. Verify all data displays correctly (no mock data)

## Security Notes

### Password Security
- Passwords are hashed using bcrypt with 12 salt rounds
- Stored in `oe.Users.PasswordHash` column
- Never stored in plain text

### Banking Security
- Account numbers should be encrypted before storage
- Currently stored as-is (TODO: Add encryption)
- Last 4 digits stored separately for display
- Verification status tracked

### Document Security
- Documents stored in Azure Blob Storage
- Only URLs stored in database
- Container name: `agents`
- Access controlled by Azure

## Testing Checklist

- [ ] New agent onboarding completes successfully
- [ ] `oe.Users` record created with PasswordHash
- [ ] `oe.Agents` record created with all fields
- [ ] `oe.AgentBankInfo` record created
- [ ] `oe.AgentDocuments` records created for uploaded files
- [ ] `oe.AgentLicenses` record created (if NPN provided)
- [ ] Agent can log in with created password
- [ ] Agent Portal Settings page shows real data
- [ ] Banking information displays correctly
- [ ] Documents are accessible via blob URLs
- [ ] License information displays correctly
- [ ] Redirect goes to tenant domain or app.open-enroll.com

## Rollback Plan

If issues occur, revert these files:
1. `backend/routes/public/onboarding.js`
2. `frontend/src/pages/public/AgentOnboarding.tsx`
3. `frontend/src/components/onboarding/PasswordStep.tsx`

Database records can be deleted manually if needed:
```sql
-- Find agent ID
SELECT AgentId FROM oe.Agents WHERE Email = 'problematic@email.com';

-- Delete in reverse order (foreign key constraints)
DELETE FROM oe.AgentLicenses WHERE AgentId = '...';
DELETE FROM oe.AgentDocuments WHERE AgentId = '...';
DELETE FROM oe.AgentBankInfo WHERE AgentId = '...';
DELETE FROM oe.Agents WHERE AgentId = '...';
DELETE FROM oe.Users WHERE UserId = '...';
```

## Future Enhancements

### TODO Items
1. **Account Number Encryption**: Implement proper encryption for `AccountNumberEncrypted` field
2. **Document Metadata**: Capture actual file names and sizes during upload
3. **Multi-State Licenses**: Support agents licensed in multiple states
4. **Agent Hierarchy**: Populate `oe.AgentHierarchy` during onboarding if upline specified
5. **Email Notifications**: Send welcome email with login instructions
6. **Password Reset**: Implement password reset flow for agents

### Known Limitations
- Account numbers are not encrypted (stored as-is)
- Document file names are generic (`document_1.pdf`)
- Only one license record created (primary state only)
- No agent hierarchy assignment during onboarding
- No automatic email notifications

## Support

If you encounter issues:
1. Check backend logs for detailed error messages
2. Verify database connection is working
3. Confirm all required fields are being sent from frontend
4. Check Azure Blob Storage permissions
5. Verify bcrypt is installed (`npm list bcrypt`)

## Related Documentation
- [Agent Onboarding Requirements](./Agent_Onboarding_Links_Requirements.md)
- [Agent Onboarding Development Plan](./Agent_Onboarding_Development_Plan.md)
- [Database Schema](./Agent_Onboarding_Database_Schema.sql)
- [Commission System](./Commission_System.md)

