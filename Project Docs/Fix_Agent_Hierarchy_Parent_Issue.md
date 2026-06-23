# Fix Agent Hierarchy Parent Issue

## 🔍 **Problem Identified**

The `oe.AgentHierarchy` table is creating records with incorrect `ParentId` values:

**Current (Incorrect) Data:**
```
HierarchyId: E706B854-7581-4E74-97D5-51149369C6D8
Type: Agent
TenantId: 1CD92AF7-B6F2-4E48-A8F3-EC6316158826
AgencyId: NULL
AgentId: A23D0B1D-06F5-4033-8C64-3E7E4DD7A7C0 (new agent - correct)
ParentId: 1CD92AF7-B6F2-4E48-A8F3-EC6316158826 (this is TenantId - incorrect)
```

**Expected (Correct) Data:**
```
ParentId: [AgentId from the onboarding link] (referring agent)
```

## 🔧 **Root Cause Analysis**

1. **Onboarding Link Data:**
   ```
   LinkId: B0AE0A22-23E7-4C44-AF28-93F6C51BC3F8
   TenantId: 1CD92AF7-B6F2-4E48-A8F3-EC6316158826
   AgencyId: NULL
   AgentId: NULL  ← This is the problem!
   ```

2. **Hierarchy Creation Logic:**
   ```javascript
   const parentId = session.LinkAgentId || session.TenantId;
   ```
   - `session.LinkAgentId` is `NULL` (because onboarding link has `AgentId: NULL`)
   - Falls back to `session.TenantId`
   - Results in `ParentId = TenantId` instead of `AgentId`

## ✅ **Solutions Implemented**

### 1. **Backend Fix - Enhanced Logging**
Added detailed logging to identify the issue:

```javascript
console.log('🏢 [HIERARCHY] Creating agent hierarchy record:', {
    hierarchyId,
    agentId: agentId,
    agencyId: session.AgencyId || null,
    parentId: parentId,
    linkAgentId: session.LinkAgentId || null,
    tenantId: session.TenantId,
    type: hierarchyType,
    linkId: session.LinkId,
    hasLinkAgent: !!session.LinkAgentId,
    usingTenantAsParent: !session.LinkAgentId
});
```

### 2. **Frontend Fix - Agency/Agent Selection**
Fixed the onboarding link creation to properly save `AgencyId` and `AgentId`:

```javascript
// Backend now includes both fields in INSERT statement
const insertQuery = `
    INSERT INTO oe.AgentOnboardingLinks (
        LinkId, TenantId, AgencyId, AgentId, LinkName, LinkToken, CreatedBy, ContractDocumentId
    ) VALUES (
        @linkId, @tenantId, @agencyId, @agentId, @linkName, @linkToken, @createdBy, @contractDocumentId
    )
`;
```

### 3. **Agent Filtering Fix**
Fixed agent dropdown to filter by selected agency:

```typescript
// Filter agents when agency changes
useEffect(() => {
  if (formData.agencyId) {
    const filtered = allAgents.filter(agent => agent.AgencyId === formData.agencyId);
    setFilteredAgents(filtered);
  } else {
    setFilteredAgents(allAgents);
  }
}, [formData.agencyId, allAgents]);
```

## 🎯 **How to Fix the Current Issue**

### **Option 1: Update Existing Onboarding Link**
If you want to fix the existing onboarding link:

```sql
-- Update the existing onboarding link to have an AgentId
UPDATE oe.AgentOnboardingLinks 
SET AgentId = '[SELECTED_AGENT_ID]'
WHERE LinkId = 'B0AE0A22-23E7-4C44-AF28-93F6C51BC3F8';
```

### **Option 2: Create New Onboarding Link**
1. Go to Tenant Admin → Onboarding Links
2. Create a new onboarding link
3. **Select an Agency** (required)
4. **Select an Agent** from that agency (required)
5. The new link will have the correct `AgentId` set

### **Option 3: Fix Existing Hierarchy Record**
If you want to fix the existing hierarchy record:

```sql
-- Update the hierarchy record to use the correct parent
UPDATE oe.AgentHierarchy 
SET ParentId = '[CORRECT_AGENT_ID]'
WHERE HierarchyId = 'E706B854-7581-4E74-97D5-51149369C6D8';
```

## 🔍 **Verification Steps**

1. **Check Onboarding Link:**
   ```sql
   SELECT LinkId, TenantId, AgencyId, AgentId, LinkName 
   FROM oe.AgentOnboardingLinks 
   WHERE LinkId = 'B0AE0A22-23E7-4C44-AF28-93F6C51BC3F8';
   ```

2. **Check Hierarchy Record:**
   ```sql
   SELECT HierarchyId, Type, TenantId, AgencyId, AgentId, ParentId 
   FROM oe.AgentHierarchy 
   WHERE HierarchyId = 'E706B854-7581-4E74-97D5-51149369C6D8';
   ```

3. **Test New Onboarding:**
   - Create a new onboarding link with an AgentId
   - Complete the onboarding process
   - Verify the hierarchy record has the correct ParentId

## 📋 **Summary**

The issue was that the onboarding link was created without an `AgentId`, so the hierarchy creation correctly fell back to using the `TenantId` as the parent. The fixes ensure that:

1. **Onboarding links can have AgentId set** (frontend form fixed)
2. **AgentId is properly saved** (backend API fixed)
3. **Agents are filtered by agency** (better UX)
4. **Hierarchy uses the correct parent** (AgentId from link, not TenantId)

The hierarchy creation logic is actually correct - it's the onboarding link data that was incomplete.
