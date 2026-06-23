# Commission Rules Refactor Summary

## Overview
This refactor adds support for:
1. Split Commission Rules (Primary Agent + multiple agents splitting commission)
2. GroupId connection to commission rules
3. Enhanced CommissionJson with type field and product tiers (EE, ES, EC, EF)
4. Product and Tier Level configuration

## Database Changes

### Migration Script
- **File**: `Project Docs/commission-rules-refactor-migration.sql`
- Adds `GroupId` column to `oe.CommissionRules` table
- Adds foreign key constraint to `oe.Groups`
- Adds index on `GroupId` for performance

### Schema Updates
- `CommissionRules.GroupId` (uniqueidentifier, nullable) - Links commission rule to a specific group

## Backend Changes

### Updated Files

#### 1. `backend/routes/commissions.js`
- Added `GroupId` to SELECT queries (with LEFT JOIN to `oe.Groups`)
- Added `GroupId` to INSERT statement
- Added `GroupId` to UPDATE allowed fields
- Added `GroupName` to query results

#### 2. `backend/services/CommissionCalculatorService.js`
- Updated `calculateComplexTieredCommission()` to support:
  - `type` field ('flatrate' or 'percentage')
  - Product tiers (EE, ES, EC, EF) in `productTiers` object
  - Product tier filtering in tier levels
- Updated `applyRule()` to handle `Split` entity type:
  - Parses `splitCommission` from CommissionJson
  - Distributes commission to primary agent and other agents
  - Supports percentage-based splits

## Frontend Changes

### Updated Files

#### 1. `frontend/src/services/commissionRules.service.ts`
- Added `CommissionJsonConfig` interface with:
  - `type?: 'flatrate' | 'percentage'`
  - `splitCommission?: { primaryAgentId, agents[], ... }`
  - `productTiers?: { EE?, ES?, EC?, EF? }`
  - `tiers?: CommissionTier[]` with `productTiers?: ('EE' | 'ES' | 'EC' | 'EF')[]`
- Updated `CreateRuleDTO` to include `groupId?: string`
- Updated `CommissionRule` interface to include:
  - `EntityType: 'Agent' | 'Agency' | 'Tier' | 'Split'`
  - `CommissionType: 'Percentage' | 'Flat' | 'Tiered' | 'Split'`
  - `GroupId?: string`
  - `GroupName?: string`

#### 2. `frontend/src/components/commissions/CommissionRulesManager.tsx`
- Updated `CommissionRule` interface to match service
- Added 'Split' to `EntityType` union
- Added 'Split' badge styling (orange)
- Added `GroupName` to search filter
- Updated commission type display to show 'Split' for split commissions

## CommissionJson Structure

### New Structure
```json
{
  "description": "Tiered commission rule",
  "renewable": false,
  "type": "percentage",  // NEW: 'flatrate' or 'percentage'
  "tiers": [
    {
      "level": 0,
      "name": "Agent",
      "rate": 0.5,  // Percentage (0-1 decimal)
      "flatAmount": 50.00,  // Optional flat amount
      "productTiers": ["EE", "ES", "EC", "EF"]  // NEW: Product tier filter
    }
  ],
  "productTiers": {  // NEW: Product-tier specific rates
    "EE": { "rate": 0.05, "flatAmount": 25.00 },
    "ES": { "rate": 0.06, "flatAmount": 30.00 },
    "EC": { "rate": 0.07, "flatAmount": 35.00 },
    "EF": { "rate": 0.08, "flatAmount": 40.00 }
  },
  "splitCommission": {  // NEW: Split commission configuration
    "primaryAgentId": "uuid",
    "primaryAgentName": "Agent Name",
    "agents": [
      {
        "agentId": "uuid",
        "agentName": "Agent Name",
        "percentage": 0.4  // 40% of commission
      }
    ],
    "totalPercentage": 1.0  // Should sum to 1.0
  }
}
```

## Remaining Work

### Frontend Components (High Priority)

#### 1. `frontend/src/components/commissions/RuleCreationWizard.tsx`
**Status**: Needs update
**Required Changes**:
- Add 'Split' to `EntityType` options
- Add 'Split' to `CommissionType` options
- Add GroupId selection field
- Add split commission configuration UI:
  - Primary agent selector
  - Multiple agent selectors with percentage inputs
  - Validation to ensure percentages sum to 100%
- Add product tier configuration:
  - Type selector (flatrate/percentage)
  - Product tier options (EE, ES, EC, EF) with rate/amount inputs
- Add product tier filtering to tier levels

**Note**: This component currently uses Material-UI. Per repository rules, it should be refactored to use Tailwind CSS only. However, for immediate functionality, the new features can be added using Material-UI components, with a note that full refactoring is recommended.

#### 2. `frontend/src/components/commissions/CommissionRuleEditForm.tsx`
**Status**: Basic form - may need enhancement
**Current**: Simple form for basic rule editing
**Recommendation**: For complex rules (Split, Tiered with product tiers), users should use the full wizard

### Testing Required

1. **Split Commission Rules**:
   - Create split commission rule with primary agent and multiple agents
   - Verify commission distribution in calculations
   - Test with different percentage splits

2. **GroupId Assignment**:
   - Create commission rule linked to a group
   - Verify rule appears when filtering by group
   - Test group-specific rule application

3. **Product Tiers**:
   - Create rule with product tier configuration (EE, ES, EC, EF)
   - Test commission calculation with different product tiers
   - Verify tier-level product tier filtering

4. **Type Field**:
   - Test rules with `type: 'flatrate'`
   - Test rules with `type: 'percentage'`
   - Verify backward compatibility with existing rules

## Migration Steps

1. **Run Database Migration**:
   ```sql
   -- Execute: Project Docs/commission-rules-refactor-migration.sql
   ```

2. **Deploy Backend Changes**:
   - Backend routes and services are updated
   - No additional configuration needed

3. **Deploy Frontend Changes**:
   - Service interfaces updated
   - CommissionRulesManager updated
   - RuleCreationWizard needs updates (see above)

4. **Test**:
   - Create test split commission rules
   - Create test group-linked rules
   - Verify commission calculations

## Backward Compatibility

- Existing commission rules will continue to work
- Old CommissionJson structure is supported (without `type` field)
- Legacy `percentage` field in tiers is supported alongside new `rate` field
- Rules without GroupId will work as before

## Notes

- The `RuleCreationWizard` component uses Material-UI, which violates repository rules. A full refactor to Tailwind CSS is recommended but not required for initial functionality.
- The split commission feature requires careful validation to ensure percentages don't exceed 100%.
- Product tier configuration allows for flexible commission structures based on enrollment tier (Employee Only, Employee+Spouse, Employee+Children, Employee+Family).

