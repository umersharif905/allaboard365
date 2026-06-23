# Commission Rules System Analysis

Based on investigation of the OpenEnroll codebase, here's a comprehensive overview of how the commission rules system works:

## 🏗️ Database Structure

The commission system is built around the **`oe.CommissionRules`** table with these key fields:

```sql
CommissionRules:
- RuleId (UUID) - Primary key
- RuleName (NVARCHAR) - Human-readable rule name
- ProductId (UUID) - Links to specific product
- EntityType (NVARCHAR) - 'Agent', 'Agency', or 'Tier'
- EntityId (UUID) - Specific agent/agency ID (nullable)
- TierLevel (INT) - Hierarchy level (0-5)
- CommissionType (NVARCHAR) - 'Percentage', 'Flat', or 'Tiered'
- CommissionRate (DECIMAL) - Percentage rate (e.g., 0.05 for 5%)
- FlatAmount (DECIMAL) - Fixed dollar amount
- CommissionJson (NVARCHAR) - Complex rule configuration
- PaymentTiming (NVARCHAR) - 'Initial', 'Renewal', etc.
- YearlySchedule (NVARCHAR) - JSON for renewal schedules
- MinimumPremium/MaximumPremium (DECIMAL) - Premium thresholds
- Priority (INT) - Rule precedence
- Status (NVARCHAR) - 'Active', 'Inactive', 'Pending', 'Deleted'
- TenantId (UUID) - Tenant isolation (NULL = Global)
- EffectiveDate/TerminationDate - Date ranges
```

## 🎯 Commission Rule Types

### 1. Entity Types
- **Agent**: Commission paid directly to individual agents
- **Agency**: Commission paid to agencies/organizations  
- **Tier**: Multi-level hierarchy-based commission structure

### 2. Commission Types

#### Percentage Rules
- **Purpose**: Commission calculated as percentage of premium
- **Fields**: `CommissionRate` (decimal, e.g., 0.05 = 5%)
- **Calculation**: `Premium × CommissionRate`
- **Example**: 5% of $100 premium = $5 commission

#### Flat Amount Rules
- **Purpose**: Fixed dollar amount per enrollment
- **Fields**: `FlatAmount` (decimal)
- **Calculation**: Fixed amount regardless of premium
- **Example**: $50 flat fee per enrollment

#### Tiered Rules
- **Purpose**: Multi-level commission structure based on hierarchy
- **Fields**: `CommissionJson` containing tier configuration
- **Calculation**: Different rates for each hierarchy level
- **Example**: Agent (5%), GA (2%), MGA (1%), FMO (0.5%)

## 📊 Rule Templates

The system includes pre-built templates for common scenarios:

### Medicare Advantage Template
```typescript
{
  name: 'Standard Medicare Advantage Commission',
  entityType: 'Tier',
  commissionType: 'Tiered',
  tiers: [
    { level: 0, name: 'Agent', rate: 0.05 },      // 5%
    { level: 1, name: 'GA', rate: 0.02 },         // 2%
    { level: 2, name: 'MGA', rate: 0.01 },        // 1%
    { level: 3, name: 'FMO', rate: 0.005 },       // 0.5%
    { level: 4, name: 'IMO', rate: 0.0025 },      // 0.25%
    { level: 5, name: 'NMO', rate: 0.001 },       // 0.1%
  ],
  renewable: true,
  yearlySchedule: [
    { year: 1, rate: 1.0 },    // 100% first year
    { year: 2, rate: 0.5 },    // 50% renewal
    { year: 3, rate: 0.5 },    // 50% renewal
    // ... continues
  ]
}
```

### Medicare Supplement Template
```typescript
{
  name: 'Medicare Supplement Commission',
  entityType: 'Tier',
  commissionType: 'Tiered',
  tiers: [
    { level: 0, name: 'Agent', rate: 0.10 },      // 10% (higher than MA)
    { level: 1, name: 'GA', rate: 0.015 },        // 1.5%
    { level: 2, name: 'MGA', rate: 0.0075 },      // 0.75%
    { level: 3, name: 'FMO', rate: 0.005 },       // 0.5%
  ],
  renewable: true,
  yearlySchedule: [
    { year: 1, rate: 1.0 },    // 100% first year
    { year: 2, rate: 0.05 },   // 5% renewal (much lower)
    // ... continues
  ]
}
```

### Ancillary Flat Rate Template
```typescript
{
  name: 'Ancillary Product Flat Rate',
  entityType: 'Tier',
  commissionType: 'Flat',
  tiers: [
    { level: 0, name: 'Agent', flatAmount: 50 },   // $50
    { level: 1, name: 'GA', flatAmount: 10 },      // $10
    { level: 2, name: 'MGA', flatAmount: 5 },      // $5
  ],
  renewable: false
}
```

### Volume-Based Bonus Template
```typescript
{
  name: 'Volume-Based Bonus Structure',
  entityType: 'Agent',
  commissionType: 'Tiered',
  bonusEligible: true,
  bonusThresholds: [
    { enrollments: 10, bonus: 100 },   // $100 bonus for 10 enrollments
    { enrollments: 25, bonus: 250 },   // $250 bonus for 25 enrollments
    { enrollments: 50, bonus: 500 },   // $500 bonus for 50 enrollments
    { enrollments: 100, bonus: 1000 }, // $1000 bonus for 100 enrollments
  ]
}
```

## 🔄 Rule Processing Logic

### Rule Application Process
1. **Rule Retrieval**: Get applicable rules for product/agent combination
2. **Priority Sorting**: Rules sorted by `Priority` field (lower = higher priority)
3. **Date Validation**: Check `EffectiveDate` and `TerminationDate`
4. **Entity Matching**: Match by `EntityType`, `EntityId`, or `TierLevel`
5. **Premium Validation**: Check `MinimumPremium`/`MaximumPremium` thresholds
6. **Calculation**: Apply rule-specific calculation logic
7. **Aggregation**: Sum applicable rules (unless stacking disabled)

### Hierarchy Levels
```
Level 0: Agent (Direct sales)
Level 1: Field Training Agent (GA)
Level 2: District Sales Manager (MGA) 
Level 3: Regional Manager (FMO)
Level 4: National Sales Director (IMO)
Level 5: National Marketing Organization (NMO)
```

## 💰 Commission Calculation Engine

### Simulation Process (`oe.CalculateCommissionSimulation`)
```sql
-- Stored procedure handles complex commission calculations
-- Input: ProductId, PremiumAmount, AgentId
-- Output: Commission breakdown by hierarchy level
```

### Rule Application Logic
```javascript
// From ContributionCalculator.js
switch (rule.ContributionType) {
  case 'flat_rate':
    return Number(rule.FlatRateAmount) || 0;
    
  case 'percentage':
    const percentage = Number(rule.PercentageAmount) || 0;
    return product.monthlyPremium * (percentage / 100);
    
  case 'tier_based':
    return this.getTierContribution(rule, memberCriteria.tier);
    
  case 'role_based':
    return this.getRoleContribution(rule, memberCriteria);
    
  case 'override':
    if (rule.OverrideType === 'full_premium') {
      return product.monthlyPremium;
    }
    return Number(rule.OverrideAmount) || 0;
}
```

## 🎨 Frontend Management

### Rule Creation Wizard
- **Step 1**: Rule Type Selection (Agent/Agency/Tier)
- **Step 2**: Commission Configuration (Percentage/Flat/Tiered)
- **Step 3**: Payment Timing & Schedule
- **Step 4**: Premium Thresholds & Validation
- **Step 5**: Review & Confirmation

### Rule Management Interface
- **DataGrid**: Shows all rules with filtering/sorting
- **Status Management**: Active/Inactive/Pending/Deleted
- **Tenant Isolation**: Global vs Tenant-specific rules
- **Priority Management**: Drag-and-drop priority ordering
- **Template System**: Quick creation from pre-built templates

## 🔐 Authorization & Access

- **SysAdmin**: Can create global rules affecting all tenants
- **TenantAdmin**: Can create tenant-specific rules
- **Agents**: Can view their own applicable rules
- **Tenant Isolation**: Rules are filtered by tenant context

## 📈 Advanced Features

### Renewal Schedules
- **Yearly Schedule**: Different rates for renewal years
- **Payment Timing**: Initial vs Renewal payments
- **Automatic Processing**: Batch processing for renewals

### Premium Thresholds
- **Minimum Premium**: Rule only applies above threshold
- **Maximum Premium**: Rule caps at maximum amount
- **Range Validation**: Ensures rules apply to appropriate premium ranges

### Rule Stacking
- **Cumulative**: Rules can stack (add together)
- **Exclusive**: Rules stop processing after first match
- **Priority-Based**: Lower priority numbers execute first

## 🛠️ API Endpoints

### Commission Rules Management
- `GET /api/commissions/rules` - List commission rules
- `POST /api/commissions/rules` - Create new rule
- `PUT /api/commissions/rules/:id` - Update existing rule
- `DELETE /api/commissions/rules/:id` - Delete rule

### Commission Simulation
- `POST /api/commissions/simulate` - Simulate commission calculation
- `GET /api/commissions/hierarchy/:agentId` - Get agent hierarchy

### Agent-Specific Rules
- `GET /api/agents/commissions/agent-rules` - Get rules for authenticated agent
- `GET /api/agents/commissions/statement` - Get commission statement

## 📋 Key Files

### Backend
- `backend/routes/commissions.js` - Main commission API routes
- `backend/routes/agent/agent-commissions.js` - Agent-specific commission routes
- `backend/services/commissionService.js` - Commission calculation service
- `backend/services/pricing/ContributionCalculator.js` - Rule application logic

### Frontend
- `frontend/src/services/commissionRules.service.ts` - Commission rules API service
- `frontend/src/components/commissions/CommissionRulesManager.tsx` - Rule management UI
- `frontend/src/components/commissions/RuleCreationWizard.tsx` - Rule creation wizard
- `frontend/src/utils/ruleTemplates.ts` - Pre-built rule templates

## 🔍 Database Functions

### Stored Procedures
- `oe.CalculateCommissionSimulation` - Main commission calculation logic
- `oe.fn_GetAgentUpline` - Get agent upline hierarchy

### Key Tables
- `oe.CommissionRules` - Commission rule definitions
- `oe.AgentHierarchy` - Agent upline/downline relationships
- `oe.Products` - Product definitions
- `oe.Tenants` - Tenant isolation

---

This commission system provides a flexible, hierarchical structure that can handle complex insurance industry commission scenarios while maintaining tenant isolation and providing comprehensive rule management capabilities.

