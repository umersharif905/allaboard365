# Insurance License Types and Tracking Documentation

## Overview

This document provides comprehensive information about insurance license types that need to be tracked in the OpenEnroll system, along with a comparison between the recommended schema and the existing `oe.AgentLicenses` table structure.

---

## Core License Categories

| License Type                                      | Description                                                                                   | Common Product Associations                   |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------- |
| **Life Insurance**                                | Permits sale of life insurance, annuities, and related products.                              | Life, Term Life, Whole Life, Final Expense    |
| **Accident & Health (A&H)**                       | Required for all health-related coverage including MEC, Health Share, and Supplemental Plans. | Health Share, MEC, Critical Illness, Accident |
| **Property**                                      | Covers personal/commercial property insurance lines.                                          | Property, Homeowners, Renters                 |
| **Casualty**                                      | For liability and commercial risks.                                                           | Auto, Workers Comp, General Liability         |
| **Personal Lines**                                | Simplified license for property/casualty in some states.                                      | Auto, Renters                                 |
| **Variable Contracts**                            | For variable annuities or products tied to market performance.                                | Variable Life, Indexed Annuities              |
| **Limited Lines**                                 | For niche products like travel or discount programs.                                          | Travel, Credit, Dental/Vision Discount        |
| **Surplus Lines**                                 | For non-standard risks placed through excess markets.                                         | Non-admitted or specialty markets             |
| **Navigator / Exchange License**                  | Required for ACA marketplace enrollments.                                                     | ACA Health, Marketplace Plans                 |
| **Medicare Advantage / Supplement Certification** | Carrier-specific, renewed annually.                                                           | Medicare Advantage, Part D, Med Supp          |

---

## Current vs Recommended Table Structure

### Current `oe.AgentLicenses` Table Structure

Based on the existing codebase analysis, the current table includes these columns:

| Column                | Data Type          | Description                                         |
| --------------------- | ------------------ | --------------------------------------------------- |
| **LicenseId**         | `uniqueidentifier` | Primary key                                         |
| **AgentId**           | `uniqueidentifier` | FK to `oe.Agents`                                   |
| **StateCode**         | `nvarchar(2)`      | License jurisdiction (e.g., FL, TX)                 |
| **LicenseNumber**     | `nvarchar(50)`     | State-issued license number                         |
| **LicenseType**       | `nvarchar(100)`    | License type (optional)                             |
| **ExpirationDate**    | `date`             | License expiration date                             |
| **IssueDate**         | `date`             | License start/issue date                            |
| **Status**            | `nvarchar(20)`     | License status (Active, Expired, etc.)              |
| **UploadedDocumentUrl**| `nvarchar(500)`   | File reference to license document                  |
| **CreatedDate**       | `datetime2(7)`     | Audit field                                         |
| **ModifiedDate**      | `datetime2(7)`     | Audit field                                         |
| **CreatedBy**         | `uniqueidentifier` | Audit field                                         |
| **ModifiedBy**        | `uniqueidentifier` | Audit field                                         |

### Recommended Enhanced Schema

| Column                   | Data Type          | Description                                         | Status |
| ------------------------ | ------------------ | --------------------------------------------------- | ------ |
| **AgentLicenseId**       | `uniqueidentifier` | Primary key                                         | ✅ **Current: LicenseId** |
| **AgentId**              | `uniqueidentifier` | FK to `oe.Agents`                                   | ✅ **Current** |
| **LicenseNumber**        | `nvarchar(50)`     | State-issued license number                         | ✅ **Current** |
| **State**                | `nvarchar(2)`      | License jurisdiction (e.g., FL, TX)                 | ✅ **Current: StateCode** |
| **LicenseType**          | `nvarchar(100)`    | One of the defined license categories above         | ✅ **Current** |
| **EffectiveDate**        | `date`             | License start/issue date                            | ✅ **Current: IssueDate** |
| **ExpirationDate**       | `date`             | License expiration date                             | ✅ **Current** |
| **Status**               | `nvarchar(20)`     | Active, Expired, Suspended, Pending                 | ✅ **Current** |
| **NPN**                  | `nvarchar(20)`     | National Producer Number from NIPR                  | ❌ **Missing** |
| **AppointmentCarrierId** | `uniqueidentifier` | Optional FK to carrier/partner table                | ❌ **Missing** |
| **AppointmentName**      | `nvarchar(100)`    | Carrier name or appointment name                    | ❌ **Missing** |
| **LicenseDocumentUrl**   | `nvarchar(500)`    | File reference to license proof in `oe.FileUploads` | ✅ **Current: UploadedDocumentUrl** |
| **RenewalReminderDate**  | `date`             | System-calculated date for renewal notifications    | ❌ **Missing** |
| **CreatedDate**          | `datetime2(7)`     | Audit field                                         | ✅ **Current** |
| **ModifiedDate**         | `datetime2(7)`     | Audit field                                         | ✅ **Current** |
| **CreatedBy**            | `uniqueidentifier` | Audit field                                         | ✅ **Current** |
| **ModifiedBy**           | `uniqueidentifier` | Audit field                                         | ✅ **Current** |

---

## Missing Fields Analysis

### Critical Missing Fields

1. **NPN (National Producer Number)**
   - **Purpose**: Unique identifier from NIPR for license verification
   - **Impact**: Cannot integrate with national license databases
   - **Recommendation**: Add as required field for compliance

2. **AppointmentCarrierId & AppointmentName**
   - **Purpose**: Track carrier appointments and partnerships
   - **Impact**: Cannot validate agent-carrier relationships
   - **Recommendation**: Add for commission and product validation

3. **RenewalReminderDate**
   - **Purpose**: Automated renewal notifications
   - **Impact**: Manual renewal tracking only
   - **Recommendation**: Add with calculated field based on expiration date

### Optional Enhancements

1. **License Sub-types**
   - Current `LicenseType` field could be enhanced with more specific categories
   - Consider adding a `LicenseSubType` field for granular tracking

2. **Compliance Tracking**
   - Add fields for continuing education requirements
   - Track compliance violations or sanctions

---

## Integration Points

### 1. Product-Level License Validation

Each product's `RequiredLicenses` field in `oe.Products` should store an array:

```json
["Accident & Health", "Life"]
```

During enrollment or assignment, the system checks that the agent's active licenses include all items in this array.

### 2. Compliance Enforcement

- Validate license status in enrollment workflows (`AgentId` vs `RequiredLicenses`)
- Block commission payments if a required license is expired
- Audit all changes in `oe.AuditLogs`

### 3. Automation & Sync

Integrate with APIs like **NIPR** or **Sircon** for automatic license verification and renewal tracking.

---

## Validation Function Example

**Function:** `oe.fn_ValidateAgentLicenseForProduct`

```sql
CREATE FUNCTION [oe].[fn_ValidateAgentLicenseForProduct]
(
    @AgentId UNIQUEIDENTIFIER,
    @ProductId UNIQUEIDENTIFIER
)
RETURNS BIT
AS
BEGIN
    DECLARE @IsValid BIT = 0;
    IF EXISTS (
        SELECT 1
        FROM oe.AgentLicenses al
        CROSS APPLY OPENJSON((SELECT RequiredLicenses FROM oe.Products WHERE ProductId = @ProductId)) WITH (LicenseType NVARCHAR(100) '$') rl
        WHERE al.AgentId = @AgentId
          AND al.LicenseType = rl.LicenseType
          AND al.Status = 'Active'
          AND al.ExpirationDate >= GETDATE()
    )
        SET @IsValid = 1;
    RETURN @IsValid;
END;
```

---

## Recommended Database Schema Updates

### Migration Script for Missing Fields

```sql
-- Add missing columns to oe.AgentLicenses table
ALTER TABLE [oe].[AgentLicenses]
ADD 
    [NPN] nvarchar(20) NULL,
    [AppointmentCarrierId] uniqueidentifier NULL,
    [AppointmentName] nvarchar(100) NULL,
    [RenewalReminderDate] date NULL;

-- Add foreign key constraint for carrier appointments (if carriers table exists)
IF EXISTS (SELECT 1 FROM sys.tables WHERE name = 'Carriers' AND schema_id = SCHEMA_ID('oe'))
BEGIN
    ALTER TABLE [oe].[AgentLicenses]
    ADD CONSTRAINT [FK_AgentLicenses_AppointmentCarrierId] 
        FOREIGN KEY ([AppointmentCarrierId]) REFERENCES [oe].[Carriers]([CarrierId]);
END;

-- Create index on NPN for faster lookups
CREATE NONCLUSTERED INDEX [IX_AgentLicenses_NPN] 
    ON [oe].[AgentLicenses] ([NPN]) 
    WHERE [NPN] IS NOT NULL;

-- Create index on AppointmentCarrierId for carrier lookups
CREATE NONCLUSTERED INDEX [IX_AgentLicenses_AppointmentCarrierId] 
    ON [oe].[AgentLicenses] ([AppointmentCarrierId]) 
    WHERE [AppointmentCarrierId] IS NOT NULL;
```

### Trigger for Renewal Reminder Date

```sql
-- Create trigger to automatically calculate renewal reminder date
CREATE TRIGGER [oe].[TR_AgentLicenses_CalculateRenewalReminder]
    ON [oe].[AgentLicenses]
    AFTER INSERT, UPDATE
AS
BEGIN
    SET NOCOUNT ON;
    
    -- Calculate renewal reminder date (30 days before expiration)
    UPDATE al
    SET RenewalReminderDate = DATEADD(DAY, -30, al.ExpirationDate)
    FROM oe.AgentLicenses al
    INNER JOIN inserted i ON al.LicenseId = i.LicenseId
    WHERE al.ExpirationDate IS NOT NULL;
END;
```

---

## Frontend Interface Updates

### TypeScript Interface Updates

```typescript
export interface AgentLicense {
  LicenseId: string;
  AgentId: string;
  StateCode: string;
  LicenseNumber: string;
  LicenseType?: string;
  ExpirationDate?: string;
  IssueDate?: string;
  Status: string;
  UploadedDocumentUrl?: string;
  NPN?: string;                    // NEW
  AppointmentCarrierId?: string;   // NEW
  AppointmentName?: string;        // NEW
  RenewalReminderDate?: string;    // NEW
  CreatedDate: string;
  ModifiedDate: string;
  CreatedBy: string;
  ModifiedBy: string;
}
```

---

## Implementation Priority

### Phase 1: Critical Fields (High Priority)
1. **NPN Field** - Required for compliance and NIPR integration
2. **RenewalReminderDate** - Essential for automated notifications
3. **AppointmentName** - Basic carrier tracking

### Phase 2: Enhanced Features (Medium Priority)
1. **AppointmentCarrierId** - Full carrier relationship tracking
2. **Enhanced validation functions**
3. **NIPR/Sircon API integration**

### Phase 3: Advanced Features (Low Priority)
1. **License sub-types**
2. **Continuing education tracking**
3. **Compliance violation tracking**

---

## Summary

The current `oe.AgentLicenses` table provides a solid foundation for license tracking but is missing several critical fields for comprehensive insurance license management. The recommended enhancements focus on:

- **NPN tracking** for national compliance
- **Carrier appointment management** for product validation
- **Automated renewal reminders** for proactive license management
- **Enhanced validation functions** for product-agent compatibility

These improvements will enable better compliance tracking, automated workflows, and integration with national license databases while maintaining the existing functionality.
