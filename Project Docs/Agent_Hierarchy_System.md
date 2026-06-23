# Agent Upline/Downline Hierarchy System

Based on analysis of the OpenEnroll codebase, here's a comprehensive overview of how the agent upline/downline hierarchy system works:

## 🏗️ Database Structure

The hierarchy is built around the **`oe.AgentHierarchy`** table with these key fields:

```sql
AgentHierarchy:
- AgentId (UUID) - The agent being referenced
- ParentId (UUID) - The parent agent/agency ID
- ParentType (NVARCHAR) - Either 'Agent' or 'Agency'
- ChildId (UUID) - The child agent ID
- ChildType (NVARCHAR) - Always 'Agent' for agent relationships
- TierLevel (INT) - The hierarchy level (1, 2, 3, etc.)
- OverridePercentage (DECIMAL) - Commission override percentage
- Status (NVARCHAR) - 'Active' or 'Inactive'
- EffectiveDate (DATE) - When relationship becomes effective
- TerminationDate (DATE) - When relationship ends (nullable)
```

## 🔄 Hierarchy Direction

### Upline
**Upline** = Who reports TO this agent (parents/supervisors)
- Shows the chain of command above the agent
- Used for commission overrides and management structure
- Retrieved via `oe.fn_GetAgentUpline()` stored procedure

### Downline
**Downline** = Who reports TO this agent (children/subordinates)
- Shows all agents under this agent's supervision
- Used for management oversight and commission tracking
- Retrieved via recursive CTE queries

## 📊 API Endpoints

### Downline Retrieval
**Endpoint**: `GET /api/tenant-admin/agents/:id/downline`
**Access**: TenantAdmin, SysAdmin

```sql
-- Recursive CTE that finds all agents reporting to a given agent
WITH AgentHierarchy AS (
  -- Direct reports (Level 1)
  SELECT 
    ah.ChildId as AgentId, 
    ah.ParentId, 
    ah.ParentType, 
    ah.TierLevel, 
    ah.OverridePercentage, 
    u.FirstName + ' ' + u.LastName as AgentName,
    u.Email, 
    ISNULL(a.CommissionRole, 'Standard') as CommissionRole, 
    1 as Level
  FROM oe.AgentHierarchy ah
  JOIN oe.Agents a ON ah.ChildId = a.AgentId AND ah.ChildType = 'Agent'
  JOIN oe.Users u ON a.UserId = u.UserId
  WHERE ah.ParentId = @AgentId 
    AND ah.ParentType = 'Agent'
    AND ah.Status = 'Active'
    AND ah.EffectiveDate <= GETDATE()
    AND (ah.TerminationDate IS NULL OR ah.TerminationDate >= GETDATE())
  
  UNION ALL
  
  -- Recursive: children of children (Level 2+)
  SELECT 
    ah.ChildId as AgentId, 
    ah.ParentId, 
    ah.ParentType, 
    ah.TierLevel,
    ah.OverridePercentage, 
    u.FirstName + ' ' + u.LastName as AgentName,
    u.Email, 
    ISNULL(a.CommissionRole, 'Standard') as CommissionRole, 
    h.Level + 1
  FROM oe.AgentHierarchy ah
  JOIN oe.Agents a ON ah.ChildId = a.AgentId AND ah.ChildType = 'Agent'
  JOIN oe.Users u ON a.UserId = u.UserId
  JOIN AgentHierarchy h ON ah.ParentId = h.AgentId AND ah.ParentType = 'Agent'
  WHERE h.Level < 10  -- Prevents infinite recursion
    AND ah.Status = 'Active'
    AND ah.EffectiveDate <= GETDATE()
    AND (ah.TerminationDate IS NULL OR ah.TerminationDate >= GETDATE())
)
SELECT 
  AgentId, ParentId, ParentType, TierLevel, OverridePercentage,
  AgentName, Email, CommissionRole, Level
FROM AgentHierarchy
ORDER BY Level, AgentName
```

### Upline Retrieval
**Endpoint**: `GET /api/tenant-admin/agents/:id/upline`
**Access**: TenantAdmin, SysAdmin

```sql
-- Uses a database function to get upline hierarchy
SELECT 
  EntityId as AgentId, 
  EntityType, 
  EntityCode, 
  EntityName,
  TierLevel, 
  RelationshipType, 
  OverridePercentage
FROM oe.fn_GetAgentUpline(@AgentId, NULL)
ORDER BY TierLevel
```

## 🎯 Key Features

### Multi-Level Hierarchy
- **Unlimited Levels**: Supports complex organizational structures
- **Recursion Limit**: Capped at 10 levels for performance
- **Visual Depth**: Each level shows indentation and hierarchy depth

### Active Status Filtering
- **Status Filtering**: Only shows active relationships
- **Date Range Validation**: Checks effective and termination dates
- **Real-time Updates**: Reflects current organizational structure

### Commission Integration
- **Override Percentages**: Each relationship can have custom commission rates
- **Commission Roles**: Tracks agent roles (Standard, Manager, etc.)
- **Hierarchy-Based Calculations**: Commission flows through hierarchy levels

### Mixed Parent Types
- **Agent-to-Agent**: Direct agent supervision relationships
- **Agency-to-Agent**: Agents can report to agencies
- **Flexible Structure**: Supports various organizational models

## 🖥️ Frontend Implementation

### Service Layer (`TenantAdminAgentsService`)
```typescript
// Get agent downline hierarchy
static async getAgentDownline(agentId: string): Promise<ApiResponse<AgentHierarchy[]>>

// Get agent upline hierarchy  
static async getAgentUpline(agentId: string): Promise<ApiResponse<AgentHierarchy[]>>
```

### Data Structure
```typescript
interface AgentHierarchy {
  AgentId: string;           // Agent's unique ID
  ParentId?: string;         // Parent agent/agency ID
  ParentType?: string;       // 'Agent' or 'Agency'
  TierLevel?: number;        // Hierarchy level (1, 2, 3...)
  OverridePercentage?: number; // Commission override %
  AgentName: string;         // Display name
  Email: string;            // Contact email
  CommissionRole?: string;   // Role (Standard, Manager, etc.)
  Level: number;            // Calculated hierarchy depth
}
```

### UI Display (`TenantAgentDetails.tsx`)
- **Tab-based Interface**: Dedicated "Downline" tab for hierarchy view
- **Visual Hierarchy**: Indented display with chevron icons
- **Level Indicators**: Shows "Level 1", "Level 2", etc.
- **Role Badges**: Displays commission roles and override percentages
- **Empty States**: Helpful messages when no downline exists
- **Responsive Design**: Works on mobile and desktop

### Visual Hierarchy Example
```typescript
// UI rendering with indentation
{member.Level > 0 && (
  <div className="flex items-center text-gray-400">
    {Array.from({ length: member.Level }).map((_, i) => (
      <ChevronRight key={i} className="h-4 w-4" />
    ))}
  </div>
)}
```

## 🔐 Authorization & Access Control

### Role-Based Access
- **TenantAdmin** and **SysAdmin**: Can view any agent's hierarchy
- **Agents**: Can only view their own hierarchy (via commission endpoints)
- **Tenant Isolation**: Hierarchy data is filtered by tenant context

### Commission Endpoints
- **Agent Access**: `GET /api/commissions/agents/:agentId/downline`
- **Authorization Check**: Agents can only see their own downline
- **Hierarchy Restriction**: Limited to agent's scope of authority

## 💼 Business Logic

### Hierarchy Management
- **Dynamic Structure**: Relationships can be added/removed over time
- **Historical Tracking**: Maintains audit trail of organizational changes
- **Effective Dating**: Relationships have start and end dates
- **Status Management**: Active/Inactive relationship states

### Commission Integration
- **Override Calculations**: Custom commission rates per relationship
- **Hierarchy-Based Payouts**: Commission flows through organizational levels
- **Role-Based Rates**: Different rates for different agent roles
- **Volume Tracking**: Aggregate performance across hierarchy levels

## 📋 Example Hierarchy Structure

```
Agency ABC (Parent Agency)
├── Agent John (Manager, 5% override)
│   ├── Agent Sarah (Level 1, Standard)
│   ├── Agent Mike (Level 1, Standard)
│   └── Agent Lisa (Level 1, 3% override)
│       └── Agent Tom (Level 2, Standard)
└── Agent Jane (Manager, 4% override)
    └── Agent Bob (Level 1, Standard)
```

### Hierarchy Levels Explained
- **Level 0**: The root agent being viewed
- **Level 1**: Direct reports (immediate subordinates)
- **Level 2**: Reports of reports (second-level subordinates)
- **Level 3+**: Deeper organizational levels

## 🛠️ API Endpoints Summary

### Tenant Admin Endpoints
- `GET /api/tenant-admin/agents/:id/downline` - Get agent downline
- `GET /api/tenant-admin/agents/:id/upline` - Get agent upline

### Commission Endpoints
- `GET /api/commissions/hierarchy/:agentId` - Get commission hierarchy
- `GET /api/commissions/agents/:agentId/downline` - Agent's downline structure

### Agent Endpoints
- `GET /api/agents/commissions/agent-rules` - Agent-specific commission rules
- `GET /api/agents/commissions/statement` - Commission statement

## 📁 Key Files

### Backend
- `backend/routes/tenant-admin-agents.js` - Tenant admin agent management
- `backend/routes/commissions.js` - Commission hierarchy endpoints
- `backend/services/commissionService.js` - Commission calculation service

### Frontend
- `frontend/src/services/tenant-admin/agents.service.ts` - Agent hierarchy API service
- `frontend/src/pages/tenant-admin/TenantAgentDetails.tsx` - Agent details with hierarchy view
- `frontend/src/pages/tenant-admin/TenantAgentDetailsModal.tsx` - Modal with hierarchy tabs

### Database
- `oe.AgentHierarchy` - Hierarchy relationship table
- `oe.fn_GetAgentUpline()` - Stored procedure for upline retrieval
- `oe.Agents` - Agent master data
- `oe.Users` - User information linked to agents

## 🔍 Performance Considerations

### Query Optimization
- **Recursion Limits**: Maximum 10 levels to prevent infinite loops
- **Index Usage**: Proper indexing on ParentId, ChildId, and Status fields
- **Date Filtering**: Efficient filtering on EffectiveDate/TerminationDate
- **Selective Joins**: Only joins necessary tables for performance

### Caching Strategy
- **Hierarchy Caching**: Cache frequently accessed hierarchy structures
- **Real-time Updates**: Invalidate cache when relationships change
- **Tenant Isolation**: Cache scoped by tenant for security

## 🚀 Future Enhancements

### Potential Improvements
- **Bulk Operations**: Mass hierarchy updates for organizational changes
- **Visual Hierarchy Editor**: Drag-and-drop hierarchy management
- **Advanced Filtering**: Filter by commission role, performance metrics
- **Export Capabilities**: Export hierarchy structures to various formats
- **Audit Trail**: Detailed history of hierarchy changes
- **Mobile Optimization**: Enhanced mobile hierarchy viewing

---

This hierarchy system provides a robust foundation for managing complex agent organizational structures while maintaining performance, security, and user experience standards.

