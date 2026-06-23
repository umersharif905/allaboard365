# Multiple Commission Codes Per Onboarding URL - System Design

## **🎯 Requirements**
- Single onboarding URL can have multiple commission codes
- Each commission code maps to a specific commission rule
- Examples:
  - Apple → Flat Rate Rule 1 (50%)
  - Peach → Percentage Rule 1A (25%)
  - Lemon → Tier Rate Rule 2F (Variable)
  - Orange → Flat Rate Rule 3 (100%)

## **🗄️ Database Schema Changes**

### **Option 1: Commission Codes Table (Recommended)**
```sql
-- New table for commission codes associated with onboarding links
CREATE TABLE [oe].[OnboardingLinkCommissionCodes] (
    [CodeId] uniqueidentifier NOT NULL PRIMARY KEY DEFAULT NEWID(),
    [LinkId] uniqueidentifier NOT NULL,
    [CommissionCode] nvarchar(50) NOT NULL,
    [CommissionRuleId] uniqueidentifier NOT NULL,
    [IsActive] bit NOT NULL DEFAULT 1,
    [CreatedBy] uniqueidentifier NOT NULL,
    [CreatedDate] datetime2 NOT NULL DEFAULT GETDATE(),
    [ModifiedDate] datetime2 NOT NULL DEFAULT GETDATE(),
    
    -- Constraints
    CONSTRAINT [FK_OnboardingLinkCommissionCodes_LinkId] 
        FOREIGN KEY ([LinkId]) REFERENCES [oe].[AgentOnboardingLinks]([LinkId]),
    CONSTRAINT [FK_OnboardingLinkCommissionCodes_CommissionRuleId] 
        FOREIGN KEY ([CommissionRuleId]) REFERENCES [oe].[CommissionRules]([RuleId]),
    CONSTRAINT [FK_OnboardingLinkCommissionCodes_CreatedBy] 
        FOREIGN KEY ([CreatedBy]) REFERENCES [oe].[Users]([UserId]),
    
    -- Unique constraints
    CONSTRAINT [UQ_OnboardingLinkCommissionCodes_LinkId_CommissionCode] 
        UNIQUE ([LinkId], [CommissionCode])
);

-- Remove CommissionCode and CommissionRuleId from AgentOnboardingLinks
-- These will be managed through the new table
ALTER TABLE [oe].[AgentOnboardingLinks] DROP COLUMN [CommissionCode];
ALTER TABLE [oe].[AgentOnboardingLinks] DROP COLUMN [CommissionRuleId];
```

### **Option 2: JSON Field (Simpler but less flexible)**
```sql
-- Add JSON field to store multiple codes
ALTER TABLE [oe].[AgentOnboardingLinks] ADD [CommissionCodes] nvarchar(MAX) NULL;

-- Example JSON structure:
{
  "codes": [
    {
      "code": "APPLE",
      "ruleId": "uuid-1",
      "ruleName": "Flat Rate Rule 1",
      "active": true
    },
    {
      "code": "PEACH", 
      "ruleId": "uuid-2",
      "ruleName": "Percentage Rule 1A",
      "active": true
    }
  ]
}
```

## **🔧 Implementation Approach**

### **Phase 1: Database Migration**
1. Create `OnboardingLinkCommissionCodes` table
2. Migrate existing single codes to new table
3. Remove old columns from `AgentOnboardingLinks`

### **Phase 2: Backend API Updates**
1. Update create/update endpoints to handle multiple codes
2. Add endpoints for managing individual codes within a link
3. Update validation logic

### **Phase 3: Frontend UI Updates**
1. Replace single commission code input with multi-code management
2. Add ability to add/remove/edit codes per link
3. Update link details modal to show all codes

### **Phase 4: Public Onboarding Flow**
1. Update public API to validate codes against specific links
2. Return appropriate commission rule based on entered code
3. Update onboarding form to show available codes

## **🎨 UI/UX Design**

### **Create/Edit Onboarding Link Modal**
```
┌─────────────────────────────────────────┐
│ Create Onboarding Link                  │
├─────────────────────────────────────────┤
│ Link Name: [________________]           │
│                                         │
│ Commission Codes:                       │
│ ┌─────────────────────────────────────┐ │
│ │ + Add Commission Code               │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ ┌─────────────────────────────────────┐ │
│ │ Code: [APPLE]  Rule: [Flat Rate 1] │ │
│ │ Code: [PEACH]  Rule: [Percentage 1A]│ │
│ │ Code: [LEMON]  Rule: [Tier Rate 2F]│ │
│ └─────────────────────────────────────┘ │
│                                         │
│ Contract Document: [Upload File]        │
│                                         │
│ [Cancel]                    [Create]    │
└─────────────────────────────────────────┘
```

### **Link Details Modal**
```
┌─────────────────────────────────────────┐
│ Link Details                            │
├─────────────────────────────────────────┤
│ Link Name: test                         │
│ Status: Active                          │
│                                         │
│ Commission Codes:                       │
│ ┌─────────────────────────────────────┐ │
│ │ APPLE → Flat Rate Rule 1 (50%)     │ │
│ │ PEACH → Percentage Rule 1A (25%)   │ │
│ │ LEMON → Tier Rate Rule 2F (Variable)│ │
│ └─────────────────────────────────────┘ │
│                                         │
│ Onboarding URL:                         │
│ https://domain.com/agent-onboarding/abc │
│                                         │
│ Available Codes: APPLE, PEACH, LEMON    │
└─────────────────────────────────────────┘
```

## **🔄 Migration Strategy**

### **Step 1: Backup Current Data**
```sql
-- Backup existing onboarding links
SELECT * INTO oe.AgentOnboardingLinks_Backup 
FROM oe.AgentOnboardingLinks;
```

### **Step 2: Create New Table**
```sql
-- Create commission codes table
CREATE TABLE [oe].[OnboardingLinkCommissionCodes] (
    -- ... (as defined above)
);
```

### **Step 3: Migrate Existing Data**
```sql
-- Migrate existing single codes to new table
INSERT INTO oe.OnboardingLinkCommissionCodes (
    LinkId, CommissionCode, CommissionRuleId, CreatedBy
)
SELECT 
    LinkId, 
    CommissionCode, 
    CommissionRuleId, 
    CreatedBy
FROM oe.AgentOnboardingLinks_Backup
WHERE CommissionCode IS NOT NULL;
```

### **Step 4: Update Schema**
```sql
-- Remove old columns
ALTER TABLE oe.AgentOnboardingLinks DROP CONSTRAINT FK_AgentOnboardingLinks_CommissionRuleId;
ALTER TABLE oe.AgentOnboardingLinks DROP COLUMN CommissionCode;
ALTER TABLE oe.AgentOnboardingLinks DROP COLUMN CommissionRuleId;
```

## **🚀 Benefits of This Approach**

1. **Scalability**: Can add unlimited codes per link
2. **Flexibility**: Each code can have different commission rules
3. **Maintainability**: Clean separation of concerns
4. **Backwards Compatibility**: Can migrate existing data
5. **Performance**: Proper indexing and relationships

## **⚠️ Considerations**

1. **Complexity**: More complex than single code approach
2. **Migration**: Need to carefully migrate existing data
3. **Validation**: Must ensure no duplicate codes per link
4. **UI/UX**: Need intuitive interface for managing multiple codes

## **🎯 Next Steps**

1. **Choose Implementation Approach** (Option 1 recommended)
2. **Create Migration Scripts**
3. **Update Backend APIs**
4. **Redesign Frontend Components**
5. **Test with Existing Data**
6. **Deploy Gradually**


































