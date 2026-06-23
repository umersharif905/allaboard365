# Backend System Prompts

## 🏗️ API Endpoint Design Patterns

### Route Ordering (CRITICAL)
**Important:** Order of route definitions matters in Express!
- Always define specific routes (like `/me`) BEFORE parameterized routes (like `/:id`)
- Express evaluates routes in the order they are defined, and the first matching route wins
- If `/:id` is defined before `/me`, then `/me` will be treated as a parameter value and never reached

### Route Path Definitions (CRITICAL)
**Important:** Route paths depend on how they are mounted!

**When creating route files that will be mounted by other routers:**
- **Use `/` (root path)** in the route file itself
- **The mounting router adds the actual path segment**

**Example:**
```javascript
// ❌ WRONG - This creates /api/me/tenant-admin/groups/groups
// In backend/routes/me/tenant-admin/groups.js
router.get('/groups', handler);

// ✅ CORRECT - This creates /api/me/tenant-admin/groups
// In backend/routes/me/tenant-admin/groups.js
router.get('/', handler);

// The mounting router adds the path:
// In backend/routes/me/tenant-admin/index.js
router.use('/groups', groupsRoutes); // This adds /groups to the path
```

**Route Path Hierarchy:**
1. **Base mounting** (`app.js`): `/api/me` 
2. **Role mounting** (`/me/index.js`): `/tenant-admin`
3. **Resource mounting** (`/tenant-admin/index.js`): `/groups`
4. **Route definition** (`/groups.js`): `/` (root)

**Final URL:** `/api/me/tenant-admin/groups`

### Route Mounting Strategy (CRITICAL)
**Important:** Choose ONE consistent mounting strategy!

**Unified Approach (RECOMMENDED):**
```javascript
// In app.js - mount the unified router
app.use('/api/me', authenticate, meRoutes);

// In routes/me/index.js - mount role-specific sub-routers
router.use('/member', memberRoutes);
router.use('/agent', agentRoutes);

// In routes/me/agent/index.js - mount specific endpoints
router.use('/groups', agentGroupsRoutes);
```

**Direct Approach (NOT RECOMMENDED):**
```javascript
// In app.js - mount each route directly
app.use('/api/me/member', authenticate, memberRoutes);
app.use('/api/me/agent', authenticate, agentRoutes);
```

**⚠️ NEVER MIX BOTH APPROACHES** - This creates routing conflicts where routes are not found.

**Example (CORRECT Order):**
```javascript
// Specific routes first
router.get('/me', getProfileHandler);
// Parameterized routes after
router.get('/:id', getByIdHandler);
```

## 🏗️ API Endpoint Architecture Patterns

### Pattern 1: Role-Specific Endpoints (`/api/me/{role}/...`)
**Use for:** Role-specific business logic and data access patterns
**Security:** Single role authorization with `authorize(['SpecificRole'])`
**Pattern:** `GET /api/me/{role}/{resource}`

**Examples:**
- `GET /api/me/tenant-admin/members` - TenantAdmin-specific member management
- `GET /api/me/agent/groups` - Agent-specific group access
- `GET /api/me/member/profile` - Member-specific profile data

**Security Implementation:**
```javascript
// ✅ SIMPLE & SECURE - Single role, no validation needed
router.get('/', authorize(['TenantAdmin']), async (req, res) => {
  // Use req.user.currentRole directly - guaranteed to be 'TenantAdmin'
  const tenantId = req.user.TenantId;
  // Query logic specific to TenantAdmin role
});
```

### Pattern 2: Unified Multi-Role Endpoints (`/api/me/...`) - **USE SPARINGLY**
**Use for:** Shared resources accessed differently by multiple roles **ONLY when absolutely necessary**
**Security:** Multi-role authorization with `currentRole` validation (**HIGHER COMPLEXITY/RISK**)
**Pattern:** `GET /api/me/{resource}?currentRole={role}`

**⚠️ WARNING: This pattern has higher security complexity and should be avoided unless there's a compelling business need.**

**Examples:**
- `GET /api/me/reports?currentRole=Agent` - Shared reporting with role-based filtering
- `GET /api/me/analytics?currentRole=TenantAdmin` - Multi-role analytics dashboard

**Security Implementation:**
```javascript
// ⚠️ COMPLEX AND HIGHER RISK - Use only when Pattern 1 doesn't fit
router.get('/', authorize(['SysAdmin', 'TenantAdmin', 'Agent']), async (req, res) => {
  // CRITICAL: Validate currentRole against user's actual roles
  const effectiveRole = validateUserRole(req, req.query.currentRole);
  
  if (effectiveRole === 'Agent') {
    // Agent-specific filtering logic
  } else if (effectiveRole === 'TenantAdmin') {
    // TenantAdmin-specific filtering logic
  }
  // More complex validation logic = more potential security bugs
});
```

### 🤔 When to Use Each Pattern?

#### ✅ Use Pattern 1 (Role-Specific Backend + Unified Frontend) - **PREFERRED DEFAULT:**
- **Different business logic** for each role
- **Role-specific data models** or relationships
- **Simple, single-purpose** backend endpoints
- **High security requirements** (simpler = more secure)
- **Same UI workflow** across roles (just different data access)
- **Most CRUD operations** (create, read, update, delete)
- **When in doubt** - choose this pattern

**Frontend Implementation:**
- ✅ **Single UI Component** for all roles
- ✅ **Hook determines endpoint** based on `user.currentRole`
- ✅ **No duplicate frontend code**

**Example:** Enrollment link templates - same UI, role-specific backend endpoints

#### ⚠️ Use Pattern 2 (Unified Multi-Role) - **ONLY WHEN NECESSARY:**
- **Shared complex reporting** with identical logic but different data scoping
- **Real-time analytics dashboards** that must work across roles
- **Complex search/filtering** where UI and logic are truly identical
- **Proven business need** for unified interface

**Example:** Complex analytics dashboard with identical charts but role-filtered data

#### ❌ Anti-Patterns to Avoid:
- **Don't unify** endpoints with completely different business logic
- **Don't create role-specific** endpoints for identical resources
- **Don't trust frontend** `currentRole` without validation
- **Don't mix patterns** within the same feature area

### 🛡️ Security Comparison

| Pattern | Security Level | Complexity | Flexibility | Performance | **Recommendation** |
|---------|---------------|------------|-------------|-------------|-------------------|
| **Role-Specific** | 🟢 **High** | 🟢 **Low** | 🟡 **Medium** | 🟢 **Fast** | ✅ **PREFERRED** |
| **Unified Multi-Role** | 🔴 **Lower** | 🔴 **High** | 🟢 **High** | 🟡 **Medium** | ⚠️ **USE SPARINGLY** |

### 📋 **Decision Framework:**
1. **Start with Pattern 1** (Role-Specific Backend + Unified Frontend) by default
2. **Only consider Pattern 2** if you have a compelling business case
3. **Security always trumps convenience**
4. **When in doubt, choose the simpler, more secure option**

## 🎨 **Frontend Implementation Pattern**

### ✅ **Recommended: Unified Frontend + Role-Specific Backend**

**The Point of Hooks:** Frontend hooks should determine the appropriate backend endpoint based on the user's role. **No need for separate screen files.**

```typescript
// ✅ CORRECT - Single service, role-aware
export class UnifiedResourceService {
  private static getBaseUrl(currentRole: string): string {
    switch (currentRole) {
      case 'Agent': return '/api/me/agent/resources';
      case 'TenantAdmin': return '/api/me/tenant-admin/resources';
      case 'SysAdmin': return '/api/me/sysadmin/resources';
      default: throw new Error(`Unsupported role: ${currentRole}`);
    }
  }

  static async getResources(filters?: Filters, currentRole?: string) {
    const baseUrl = this.getBaseUrl(currentRole);
    return await apiService.get(`${baseUrl}?${queryParams}`);
  }
}

// ✅ CORRECT - Single hook, role-aware
export const useResources = (filters?: Filters) => {
  const { user } = useAuth();
  
  return useQuery({
    queryKey: ['resources', filters, user?.currentRole],
    queryFn: () => UnifiedResourceService.getResources(filters, user?.currentRole),
    enabled: !!user?.currentRole
  });
};

// ✅ CORRECT - Single component for all roles
const ResourcesPage: React.FC = () => {
  const { data, isLoading } = useResources(filters);
  // Same UI for all roles, different data based on backend endpoint
};
```

### ❌ **Avoid: Separate Frontend Files Per Role**

```typescript
// ❌ WRONG - Don't create separate components
- AgentResourcesPage.tsx
- TenantAdminResourcesPage.tsx  
- SysAdminResourcesPage.tsx

// ❌ WRONG - Don't create separate services
- AgentResourcesService.ts
- TenantAdminResourcesService.ts
- SysAdminResourcesService.ts

// ❌ WRONG - Don't create separate hooks
- useAgentResources.ts
- useTenantAdminResources.ts
- useSysAdminResources.ts
```

### 🎯 **Key Principles:**

1. **One UI Component** - Same interface for all roles
2. **Role-Aware Hooks** - Hook determines which backend endpoint to call
3. **Backend Handles Security** - Each role gets its own secure endpoint
4. **Frontend Stays Simple** - No complex role logic in components

**Benefits:**
- 🛡️ **Security**: Role-specific backend endpoints
- 🎨 **Maintainability**: Single UI codebase
- ⚡ **Performance**: Backend optimized per role
- 🔧 **Simplicity**: Hooks handle the complexity

## 📁 **Frontend Service File Organization**

### ✅ **Recommended: One Service Per Resource**

**Pattern:** Create one service file per database table/resource, with role-aware endpoint selection.

```typescript
// ✅ CORRECT - Single service file per resource
// frontend/src/services/enrollment-link-templates.service.ts
export class EnrollmentLinkTemplatesService {
  private static getBaseUrl(currentRole: string): string {
    switch (currentRole) {
      case 'Agent': return '/api/me/agent/enrollment-link-templates';
      case 'TenantAdmin': return '/api/me/tenant-admin/enrollment-link-templates';
      case 'SysAdmin': return '/api/me/sysadmin/enrollment-link-templates';
    }
  }
  
  static async getTemplates(filters?: Filters, currentRole?: string) {
    const baseUrl = this.getBaseUrl(currentRole);
    return await apiService.get(`${baseUrl}?${queryParams}`);
  }
}
```

### ❌ **Avoid: Separate Service Files Per Role**

```typescript
// ❌ WRONG - Don't create separate service files per role
- services/agent/agent-enrollment-link-templates.service.ts
- services/tenant-admin/tenant-admin-enrollment-link-templates.service.ts
- services/sysadmin/sysadmin-enrollment-link-templates.service.ts
```

### 📋 **Service File Naming Convention:**

- ✅ `{resource}.service.ts` (e.g., `enrollment-link-templates.service.ts`)
- ❌ `unified-{resource}.service.ts` (redundant prefix)
- ❌ `{role}-{resource}.service.ts` (separate files per role)

### 🎯 **Key Principles:**

1. **One service per resource/table** - Not per role
2. **Role-aware endpoint selection** - Service determines the endpoint
3. **Consistent naming** - No "unified" prefix needed
4. **Single source of truth** - One place to manage all role logic

### Admin-Scoped Endpoints (`/api/{resource}/:id/...`)
**Use for:** Specific entities (higher-level access)
**Pattern:** `GET /api/{resource}/:{resourceId}/{sub-resource}`
**Examples:**
- `GET /api/agents/:agentId/groups` - View groups for specific agent
- `POST /api/groups/:groupId/members` - Add member to specific group

### Query Parameters for Filtering
**Use for:** Filtering lists of resources
**Pattern:** `GET /api/{resource}?{filter}={value}`
**Examples:**
- `GET /api/members?agentId=:agentId` - Filter members by agent
- `GET /api/groups?tenantId=:tenantId` - Filter groups by tenant

## 🔐 Authentication & Authorization

### Frontend Authentication Patterns

#### ✅ **CRITICAL: Public vs Authenticated Route Separation**

**Principle:** Public routes (like enrollment links) must be completely outside the authentication context to prevent unwanted redirects.

**Correct App Structure:**
```typescript
// ✅ CORRECT - App.tsx
function App() {
  return (
    <div className="min-h-screen bg-oe-neutral-light">
      <Router>
        <Routes>
          {/* PUBLIC ROUTES - NO AUTH PROVIDER */}
          <Route path="/enroll/*" element={<EnrollmentPage />} />
          <Route path="/group-onboarding/:linkToken" element={<GroupOnboardingWizard />} />
          <Route path="/setup-password/:token" element={<PasswordSetup />} />
          
          {/* AUTHENTICATED ROUTES - WRAPPED IN AUTH PROVIDER */}
          <Route path="/*" element={
            <AuthProvider>
              <AuthenticatedApp />
            </AuthProvider>
          } />
        </Routes>
      </Router>
    </div>
  );
}
```

**❌ WRONG - Don't Wrap Everything in AuthProvider:**
```typescript
// ❌ WRONG - main.tsx
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AuthProvider>  {/* This causes public routes to redirect! */}
      <App />
    </AuthProvider>
  </React.StrictMode>,
)
```

#### API Service Public Endpoint Handling:
```typescript
// ✅ CORRECT - Check auth requirement BEFORE getting tokens
async (config) => {
  // Check if this endpoint requires authentication
  if (!this.requiresAuth(config)) {
    console.log(`[ApiService] Public endpoint - skipping auth for URL: ${config.url}`);
    return config;
  }
  // Only get token for authenticated endpoints...
}
```

#### Public Endpoint Configuration:
```typescript
// ✅ CORRECT - Use startsWith for precise matching
private requiresAuth(config: AxiosRequestConfig): boolean {
  const publicEndpoints = [
    '/auth/login',
    '/auth/register',
    '/auth/forgot-password',
    '/auth/reset-password',
    '/health',
    '/public',
    '/api/public', // All /api/public/* endpoints are public
    '/api/enrollment-links' // All enrollment links endpoints are public
  ];

  const url = config.url || '';
  return !publicEndpoints.some(endpoint => url.startsWith(endpoint));
}
```

#### Public Upload Endpoints Pattern:
**CRITICAL:** The backend provides both authenticated and public versions of upload endpoints.

**Backend Route Mounting:**
```javascript
// In backend/app.js
// Authenticated uploads (requires authentication token)
app.use('/api/uploads', authenticateMiddleware, uploadsRoutes.router);

// Public uploads (no authentication required - for onboarding, etc.)
app.use('/api/public/uploads', uploadsRoutes.router);
```

**When to Use Each:**
- **`/api/uploads`** - Use for authenticated users (logged-in users uploading files)
- **`/api/public/uploads`** - Use for public contexts (group onboarding, agent onboarding, enrollment wizards)

**Frontend Implementation:**
```typescript
// ✅ CORRECT - Use public endpoint for onboarding
// In GroupOnboardingService.completeOnboarding()
const uploadResponse = await apiService.post<ApiResponse<any[]>>('/api/public/uploads', formData, {
  headers: { 'Content-Type': 'multipart/form-data' },
});

// ✅ CORRECT - Use authenticated endpoint for logged-in users
// In GroupsService.uploadGroupLogo()
return apiService.post('/api/uploads', formData, {
  headers: { 'Content-Type': 'multipart/form-data' },
});
```

**Key Points:**
- Both routes use the same `uploadsRoutes.router` handler
- The difference is authentication middleware on `/api/uploads`
- The `apiService` automatically treats `/api/public/*` as public (no auth token added)
- Always use `/api/public/uploads` for public onboarding flows

#### Common Frontend Authentication Pitfalls:
1. **Double AuthProvider wrapping** - Don't wrap in both `main.tsx` and `App.tsx`
2. **Using `includes()` instead of `startsWith()`** - Can cause false positives
3. **Getting tokens for public endpoints** - Check auth requirement first
4. **Not testing public routes** - Always verify public routes work without authentication

### Role Hierarchy
```
SysAdmin (Global Access)
    ↓
TenantAdmin (Tenant-wide Access)
    ↓
Agent (Multiple Groups)
    ↓
GroupAdmin (Single Group)
    ↓
Member (Personal Data Only)
```

### UserRoles Service (CRITICAL)
**Important:** Always use `UserRolesService` for role management operations!

**Service Location:** `backend/services/shared/user-roles.service.js`

**Key Functions:**
```javascript
const UserRolesService = require('../services/shared/user-roles.service');

// Get all role names for a user
const roles = await UserRolesService.getUserRoleNames(userId);
// Returns: ['TenantAdmin', 'Agent', 'Member']

// Assign a role to a user
await UserRolesService.assignRoleToUser(userId, 'Agent', createdByUserId);

// Remove a role from a user
await UserRolesService.removeRoleFromUser(userId, 'Agent', removedByUserId);

// Get all available system roles
const allRoles = await UserRolesService.getAllRoleNames();
// Returns: ['SysAdmin', 'TenantAdmin', 'Agent', 'GroupAdmin', 'Member']
```

**When Creating Users:**
```javascript
// ✅ CORRECT - Use UserRolesService to assign roles
const userId = newUser.UserId;
await UserRolesService.assignRoleToUser(userId, 'Agent', req.user.UserId);

// ❌ WRONG - Never insert directly into oe.Users.UserType or oe.Users.Roles
// These fields are DEPRECATED and should not be used
```

**When Querying Users by Role:**
```javascript
// ✅ CORRECT - Join oe.UserRoles and oe.Roles tables
const query = `
  SELECT u.*, r.Name as RoleName
  FROM oe.Users u
  INNER JOIN oe.UserRoles ur ON u.UserId = ur.UserId
  INNER JOIN oe.Roles r ON ur.RoleId = r.RoleId
  WHERE r.Name = @roleName
`;

// ❌ WRONG - Never query oe.Users.UserType or oe.Users.Roles
// These are deprecated fields
```

**Deprecated Fields - DO NOT USE:**
- ❌ `oe.Users.UserType` - Deprecated single-role field
- ❌ `oe.Users.Roles` - Deprecated JSON string field
- ✅ Use `oe.UserRoles` table with `UserRolesService` instead

**Acting context vs role membership (read this first):**

| Question | Use |
|----------|-----|
| **Which hat is the user wearing right now?** (Agent portal vs Group Admin context) | **`req.user.currentRole`** (from JWT after auth — do not trust raw client body without validation) |
| **Does this account actually have role X in `oe.UserRoles`?** | **`getUserRoles(req.user)`** and check membership (e.g. `.includes('Agent')`) — or equivalent from DB |

- **Branch business rules** (tenant-wide vs agent-assigned vs group-admin row): prefer **`currentRole`** so Agent+GroupAdmin users are not forced down the wrong path (e.g. requiring `oe.GroupAdmins` when they are acting as **Agent**).
- **`.includes` on the role array** is still correct for **“is this user allowed to hold this role?”** — including when validating a **requested** `currentRole` from the body/query against their real roles. It is **not** a substitute for `currentRole` when deciding **context** for multi-role users.
- **Anti-pattern:** `if (userRoles.includes('GroupAdmin')) { require GroupAdmins row }` **without** also checking `req.user.currentRole === 'GroupAdmin'` — users with both Agent and GroupAdmin roles will break when acting as Agent.

**Backend Implementation:**
```javascript
// ❌ SECURITY VULNERABILITY - Trusts client-supplied role without validation
const effectiveRole = req.body.currentRole || req.user.currentRole; // DANGEROUS!

// ✅ CORRECT - Default to JWT currentRole; if client sends a role switch, verify membership first
const { currentRole: requestedRole } = req.body; // or req.query for GET
const userRoles = getUserRoles(req.user); // from JWT / UserRoles — not deprecated

let effectiveRole = req.user.currentRole;

if (requestedRole) {
  if (userRoles.includes(requestedRole)) {
    effectiveRole = requestedRole;
  } else {
    console.log('⚠️ SECURITY WARNING: Unauthorized role attempt:', requestedRole);
    // Keep effectiveRole = req.user.currentRole
  }
}

// Branch data access by acting context (after authorize() allowed the route)
if (effectiveRole === 'Agent') {
  // Agent-scoped logic (e.g. tenant + assignment), not "only if includes Agent" alone for context
}
```

**Note:** Endpoints that **only** check `userRoles.includes('TenantAdmin')` and ignore users who are **acting as Agent** can wrongly deny **TenantAdmin+Agent** accounts. Prefer **`currentRole`** (validated) for **which** scoped logic runs; use **membership** checks to ensure they may use that role.

### 🚨 CRITICAL SECURITY WARNING: Role Validation

**NEVER TRUST FRONTEND ROLE DATA WITHOUT VALIDATION!**

**The Vulnerability:**
```javascript
// ❌ EXTREMELY DANGEROUS - Privilege Escalation Attack Vector
const effectiveRole = req.body.currentRole || req.user.currentRole;
// Attacker can send: { currentRole: 'SysAdmin' } and gain admin access!
```

**The Attack:**
A malicious user can send any role in their request:
```javascript
// Attacker's request (even if they're just a Member)
POST /api/sensitive-endpoint
{
  "data": "...",
  "currentRole": "SysAdmin"  // FAKE ROLE - GRANTS ADMIN ACCESS!
}
```

**The Secure Solution:**
```javascript
// ✅ SECURE - JWT currentRole is the default acting context; optional client role must match UserRoles
const { currentRole: requestedRole } = req.body;
let effectiveRole = req.user.currentRole;

if (requestedRole) {
  const userRoles = getUserRoles(req.user); // or req.user?.roles per your auth payload

  if (userRoles.includes(requestedRole)) {
    effectiveRole = requestedRole;
    console.log('✅ Role validated:', requestedRole);
  } else {
    console.log('🚨 SECURITY ALERT: Privilege escalation attempt!', {
      userId: req.user.UserId,
      attemptedRole: requestedRole,
      actualRoles: userRoles
    });
  }
}
```

**Security Checklist:**
- [ ] ✅ Use **`req.user.currentRole`** (from JWT) as the default **acting context** for multi-role branching
- [ ] ✅ Validate any **client-supplied** role switch with **`userRoles.includes(requestedRole)`** (or `getUserRoles`)
- [ ] ✅ Default to `req.user.currentRole` if validation fails
- [ ] ✅ Log security incidents for monitoring
- [ ] ✅ Never trust frontend role data directly
- [ ] ✅ Consider additional security measures (rate limiting, alerts)

**Multi-Role Patterns:**
- **TenantAdmin + Agent**: Can manage tenant AND act as agent
- **SysAdmin + TenantAdmin**: Can access all tenants AND manage specific tenant
- **Agent + GroupAdmin**: Can manage multiple groups AND act as group admin

**Frontend Role Switching:**
```javascript
// User navigates to /agent/dashboard
user.currentRole = 'Agent'; // Set in useAuth

// User navigates to /tenant-admin/dashboard  
user.currentRole = 'TenantAdmin'; // Set in useAuth
```

**Frontend UI branching:** Prefer **`user.currentRole`** (acting context from the JWT / `useAuth`) for visible features, route guards, and filters — **not** `user.roles.includes(...)` alone. Membership in `roles[]` is still used on the client only when validating an explicit role **switch** or when the backend requires it; day-to-day UI matches the portal the user selected.

### Middleware Usage
```javascript
const { authorize } = require('../middleware/auth');
const requireTenantAccess = require('../middleware/requireTenantAccess');

// Route with authorization + tenant context (switching)
router.get('/:id', authenticate, authorize(['SysAdmin', 'TenantAdmin', 'Agent']), requireTenantAccess, async (req, res) => {
  // Route logic here
});
```

### Multi-tenant context (tenant switching) — **REQUIRED for list/write APIs**

**Goal:** The **active tenant** is the one the user selected in the UI (SysAdmin / multi-tenant users), not necessarily the user’s **primary** `Users.TenantId`. All tenant-scoped data must use that context unless an explicit admin “all tenants” mode is used.

#### Backend: `requireTenantAccess` (`backend/middleware/requireTenantAccess.js`)

- Runs **after** `authenticate` (and usually `authorize` when needed).
- Resolves **active tenant** in order: `x-current-tenant-id` header → `currentTenantId` / `tenantId` in query/body → else **primary** DB tenant.
- Validates access: **primary tenant**, **AdditionalTenants** JSON array, or **SysAdmin** (any active tenant).
- Sets **`req.tenantId`** and **`req.user.TenantId`** to the **active** tenant for the request (overwrites primary for downstream handlers).

**Do not** assume `req.user.TenantId` from JWT alone is the active tenant; after this middleware it is aligned with the switch.

#### SysAdmin list routes: `wantsAllTenants` / `effectiveListTenantId` (`messageCenter.js`, `proposal-documents.js`, `campaigns.js`, etc.)

Use small helpers so SysAdmin defaults to **scoped** lists:

- **`wantsAllTenants(req)`** — `true` only when `SysAdmin` **and** `?allTenants=true` (or `1`). Use for a deliberate cross-tenant admin view.
- **`effectiveListTenantId(req)`** — For SysAdmin, if `?tenantId=` is present, use it; otherwise use **`req.tenantId`** (from middleware). For others, `req.tenantId`.

**Default:** If `allTenants` is not set, lists filter to the **current** tenant (from header), not “every tenant” and not only the user’s primary.

#### Global rows (`TenantId IS NULL`)

- **Do not** use `(TenantId = @scope OR TenantId IS NULL)` for normal tenant-scoped lists — globals appear under **every** tenant and look like cross-tenant data leaks (e.g. branded templates).
- **Scoped list:** `TenantId = @tenantId` only.
- **Globals only:** e.g. `?globalOnly=true` (SysAdmin) or full catalog with `?allTenants=true`, depending on the feature.

#### Frontend (`api.service.ts`, `AuthContext.tsx`)

- **Active tenant id:** `user.currentTenantId || user.tenantId` for UI and payloads when a single tenant is implied.
- **Axios:** `applyActiveTenantHeader()` sets **`x-current-tenant-id`** from `localStorage.currentTenantId` (then legacy `tenantId`) so middleware sees the switch even when `user` is not in scope.
- Keep **`localStorage.currentTenantId`** in sync with profile / tenant switcher.

#### Quick checklist for new endpoints

1. Mount **`requireTenantAccess`** on routes that return or mutate tenant-owned rows.
2. For **SysAdmin** list endpoints, use **`wantsAllTenants`** + **`effectiveListTenantId`** (or the same idea) — never default to unfiltered cross-tenant rows.
3. For **nullable `TenantId`** resources, decide explicitly: scoped-only vs global-only vs `allTenants` — avoid implicit “globals in every tenant view.”
4. **Frontend** lists/forms: use **active** tenant id, not primary `tenantId` alone.

### Role-Based Access Control
- **SysAdmin**: Can access all tenants and data
- **TenantAdmin**: Can only access their tenant's data
- **Agent**: Can only access assigned groups and members
- **GroupAdmin**: Can only access their specific group
- **Member**: Can only access their own data

### 🛡️ Multi-Role Security Validation
**CRITICAL:** For **which scoped logic runs** (Agent vs TenantAdmin vs GroupAdmin context), rely on **`req.user.currentRole`** after `authorize()` has allowed the route. For **optional role switches** from the client, always validate with **role membership** (`includes` / `getUserRoles`) — never trust the body alone.

```javascript
// ✅ SECURE PATTERN - Requested role is optional; default is JWT currentRole (acting context)
const validateUserRole = (req, requestedRole) => {
  const userRoles = getUserRoles(req.user);

  if (!requestedRole) {
    return req.user.currentRole;
  }

  if (userRoles.includes(requestedRole)) {
    return requestedRole;
  }

  console.log('🚨 PRIVILEGE ESCALATION ATTEMPT:', {
    userId: req.user.UserId,
    attemptedRole: requestedRole,
    actualRoles: userRoles,
    endpoint: req.path
  });

  return req.user.currentRole;
};

// Usage when body may request a role switch:
const effectiveRole = validateUserRole(req, req.body.currentRole);
```

**Why This Matters:**
- **`currentRole`** picks the correct branch for users with multiple roles (e.g. Agent+GroupAdmin).
- **`includes` / `getUserRoles`** proves they may assume that role — stops privilege escalation from forged `currentRole` in the body.
- Together: acting context + membership, not one or the other in isolation.

## 📊 Database Patterns

### Direct Database Access for Development

**CRITICAL:** I have direct read-only database access for real-time schema discovery and data verification during development.

**Connection Details:**
- **Server**: `pvt-sql-server.database.windows.net`
- **Database**: `allaboard-prod`
- **User**: `readonly_user`
- **Password**: `Read_Only_AI735!?@`
- **Access Level**: Read-only (SELECT permissions only)
- **Connection**: Encrypted, real-time access

**Database Schema Script:**
- **Script**: `./ai_scripts/db-schema.sh` - Complete database schema extraction
- **Usage**: `./ai_scripts/db-schema.sh` (all tables) or `./ai_scripts/db-schema.sh TableName` (specific table)
- **Output**: Detailed schema with columns, data types, foreign keys, and stored procedures
- **Efficiency**: Use specific table name for faster, focused schema discovery

**Usage for Development:**
- **Schema Discovery**: Query INFORMATION_SCHEMA for real-time column information
- **Data Verification**: Test queries with actual data before implementation
- **Relationship Mapping**: Discover foreign keys and table relationships
- **Field Name Verification**: Confirm exact column names and data types
- **Query Testing**: Validate SQL queries before implementing in code

**Example Usage:**
```bash
# Get complete database schema
./ai_scripts/db-schema.sh

# Get specific table schema (faster)
./ai_scripts/db-schema.sh Users
./ai_scripts/db-schema.sh Groups
./ai_scripts/db-schema.sh Members
```

```javascript
// Real-time schema discovery
const schemaQuery = `
  SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT
  FROM INFORMATION_SCHEMA.COLUMNS 
  WHERE TABLE_NAME = 'Users' AND TABLE_SCHEMA = 'oe'
  ORDER BY ORDINAL_POSITION
`;

// Test with actual data
const testQuery = `
  SELECT TOP 5 * FROM oe.Users WHERE Status = 'Active'
`;
```

### SQL Column Naming Convention (CRITICAL)
**Important:** SQL column names use PascalCase in this system!
- Column names use PascalCase (e.g., `FirstName`, `LastName`, `UserId`)
- JavaScript/TypeScript properties often use camelCase (e.g., `firstName`, `lastName`, `userId`)
- Be careful when mapping between database fields and API responses/requests
- When in doubt, console.log the response to verify field casing

**Example:**
```javascript
// INCORRECT - using camelCase for SQL columns
request.input('firstName', sql.NVarChar, firstName);
const query = `SELECT * FROM oe.Users WHERE firstName = @firstName`;

// CORRECT - using PascalCase for SQL columns
request.input('firstName', sql.NVarChar, firstName);
const query = `SELECT * FROM oe.Users WHERE FirstName = @firstName`;
```

### Determining Field Names (CRITICAL)
**Never assume field names!** Instead:
- **Use direct database access** to query schema information in real-time
- Look for existing queries in similar files to determine correct field names
- Check table schema definitions in the codebase or documentation
- If field names are uncertain, DO NOT GUESS! Instead:
  1. **Query the live database schema** using INFORMATION_SCHEMA
  2. **Test queries with actual data** to verify field names
  3. First search the codebase for similar queries to infer field names

**Direct Database Access:**
- **Server**: `pvt-sql-server.database.windows.net`
- **Database**: `allaboard-prod`
- **User**: `readonly_user` (read-only access)
- **Connection**: Encrypted, real-time access

```javascript
// Sample query to get column names for a table
const schemaQuery = `
  SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT
  FROM INFORMATION_SCHEMA.COLUMNS 
  WHERE TABLE_NAME = 'Users' AND TABLE_SCHEMA = 'oe'
  ORDER BY ORDINAL_POSITION
`;

// Test with actual data to verify field names
const testQuery = `
  SELECT TOP 1 * FROM oe.Users
`;
```

### Connection Setup
```javascript
const { getPool, sql } = require('../config/database');
const pool = await getPool();
```

### Parameter Binding
```javascript
const request = pool.request();
request.input('userId', sql.UniqueIdentifier, userId);
request.input('name', sql.NVarChar, name);
request.input('amount', sql.Decimal(18,2), amount);
request.input('isActive', sql.Bit, isActive);
```

### Transaction Handling (ACID Compliance)
**CRITICAL:** Use transactions for all multi-step operations to ensure ACID compliance (Atomicity, Consistency, Isolation, Durability). If ANY step fails, ALL changes must be rolled back.

```javascript
const transaction = pool.transaction();
await transaction.begin();
try {
  // All database operations use transaction.request() instead of pool.request()
  const result = await transaction.request()
    .input('id', sql.UniqueIdentifier, id)
    .query('INSERT INTO...');
  
  // More operations...
  
  await transaction.commit(); // Only commit if ALL steps succeed
} catch (error) {
  await transaction.rollback(); // Rollback on ANY failure
  throw error;
}
```

**Key Rules:**
- ✅ Use `transaction.request()` for all queries within transaction
- ✅ Commit only after ALL operations succeed
- ✅ Rollback on ANY failure (don't return partial success)
- ✅ Pass transaction to service methods that need DB access

### Payment method encryption (member, group, agent ACH)

**One stack:** `encryptionService.encryptPaymentData` / `decryptPaymentData` in `backend/services/encryptionService.js`. PAN, account number, routing → `*Encrypted` columns; plaintext routing may remain on the row for display/backfill.

**Member vs group vs agent bank:** Different tables (`oe.MemberPaymentMethods`, `oe.GroupPaymentMethods`, agent/agency ACH storage) — **same** crypto helpers; follow `PaymentMethodService` where applicable.

**Decrypting SQL rows:** Columns are PascalCase (`RoutingNumberEncrypted`, …); pass objects with **camel or Pascal** — `decryptPaymentData` resolves both.

**ACH outbound (DIME, retries, invoice charge):** use `resolveAchRoutingForCharge` from `backend/utils/achRouting.js` when assembling routing digits so an ABA-checksum-good plaintext column is not overwritten by a bad ciphertext decrypt.

## 📝 API Response Standards

### Success Response
```javascript
res.json({
  success: true,
  data: resultData,
  message: 'Optional success message'
});
```

### Error Response
```javascript
res.status(400).json({
  success: false,
  message: 'Error description',
  error: {
    message: 'Detailed error message',
    code: 'ERROR_CODE'
  }
});
```

## 🛡️ Security Patterns

### Tenant Isolation
**Prefer** `requireTenantAccess` + `req.tenantId` (active tenant after switch) for `WHERE TenantId = @tenantId`.

Legacy pattern (role check only) is **not** sufficient when SysAdmin switches tenants or when `req.user.TenantId` must reflect the active context:

```javascript
// ⚠️ Incomplete — does not handle tenant switching; use requireTenantAccess + req.tenantId
if (req.user.currentRole !== 'SysAdmin') {
  query += ' AND TenantId = @userTenantId';
  request.input('userTenantId', sql.UniqueIdentifier, req.user.tenantId);
}
```

### Input Validation
```javascript
// Validate required fields
if (!name || !email) {
  return res.status(400).json({
    success: false,
    message: 'Name and email are required'
  });
}

// Validate data types
if (typeof amount !== 'number' || amount < 0) {
  return res.status(400).json({
    success: false,
    message: 'Amount must be a positive number'
  });
}
```

## 🔍 Error Handling Patterns

### Try-Catch Structure
```javascript
try {
  // Database operations
  const result = await request.query(query);
  
  if (result.recordset.length === 0) {
    return res.status(404).json({
      success: false,
      message: 'Resource not found or access denied'
    });
  }
  
  res.json({
    success: true,
    data: result.recordset
  });
  
} catch (error) {
  console.error('❌ Error:', error);
  res.status(500).json({
    success: false,
    message: 'Server error while processing request'
  });
}
```

### Common Error Messages
- **404**: "Resource not found or access denied"
- **400**: "Invalid {field} provided"
- **401**: "Authentication required"
- **403**: "Insufficient permissions"
- **500**: "Server error while {action}"

### Verification link 404 vs 400 (not a timezone issue)
For agent email verification (`/api/public/onboarding/verify-email`):
- **404** "Invalid or expired verification token" = **no session row** found for that token (wrong token, different env, session status not `PendingVerification`, or session purged). This is **not** caused by link expiration or timezone.
- **400** "Verification token has expired" = a session **was** found but `VerificationTokenExpiry` is in the past (actual expiration). Expiry is compared in server time.
If a user verified ~20 minutes after onboarding, a 404 means the session was not found (e.g. wrong link or environment), not that the link expired.

### Delete vs Deactivate Pattern
**Important:** Distinguish between permanent deletion and deactivation:

```javascript
// ✅ PERMANENT DELETE - Remove from database entirely
DELETE /api/resource/:id
// SQL: DELETE FROM table WHERE id = @id

// ✅ DEACTIVATE - Set IsActive = false (editable field)
PUT /api/resource/:id
{ "isActive": false }
// SQL: UPDATE table SET IsActive = 0 WHERE id = @id
```

**When to Use Each:**
- **DELETE**: User explicitly deletes the resource (trash/delete button)
- **PUT with isActive**: User wants to temporarily disable/enable (toggle switch/checkbox)

**Benefits:**
- Clear user intent (delete vs disable)
- Permanent deletion frees up database space
- IsActive allows temporary disabling without data loss

## 📋 Route Creation Template

### Basic Route Structure
```javascript
const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/database');
const { authorize, requireTenantAccess } = require('../middleware/auth');

// GET endpoint
router.get('/:id', authorize(['SysAdmin', 'TenantAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { id } = req.params;
    const pool = await getPool();
    
    // Verify access and get data
    let query = `
      SELECT * FROM oe.TableName 
      WHERE Id = @id AND Status = 'Active'
    `;
    
    const request = pool.request();
    request.input('id', sql.UniqueIdentifier, id);
    
    // Add tenant filtering for non-SysAdmin users
    if (req.user.currentRole !== 'SysAdmin') {
      query += ' AND TenantId = @userTenantId';
      request.input('userTenantId', sql.UniqueIdentifier, req.user.tenantId);
    }
    
    const result = await request.query(query);
    
    if (result.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Resource not found or access denied'
      });
    }
    
    res.json({
      success: true,
      data: result.recordset[0]
    });
    
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching resource'
    });
  }
});

module.exports = router;
```

## 🧪 Testing Patterns

### Playwright MCP Testing Protocol

#### ✅ **CRITICAL: Use Playwright MCP for ALL Frontend Testing**

**Instead of writing Cypress tests, use Playwright MCP commands like:**
- **"Navigate to the login page and test the login flow"**
- **"Fill out the enrollment form and verify it submits successfully"**
- **"Create a new user and verify they appear in the user list"**
- **"Test the agent dashboard by logging in as an agent"**
- **"Verify data persistence by checking the database after operations"**

#### Test Account Credentials
When testing with Playwright MCP, use these login credentials:
- **System Admin Portal**: `sysadmin@allaboard365.com` / `testpass`
- **Tenant Admin Portal**: `tenant@allaboard365.com` / `testpass`
- **Agent Portal**: `agent@allaboard365.com` / `testpass`
- **Group Admin Portal**: `groupadmin@allaboard365.com` / `testpass`
- **Member Portal**: `member@allaboard365.com` / `testpass`

#### Playwright MCP Testing Examples
```markdown
## Example Testing Commands:

1. **"Navigate to http://localhost:5173 and test the login flow"**
2. **"Login as tenant@allaboard365.com and navigate to the user management page"**
3. **"Fill out the user creation form and verify the user is created"**
4. **"Test the enrollment wizard by completing a full enrollment"**
5. **"Verify the agent dashboard loads all member data correctly"**
6. **"Test error handling by submitting invalid form data"**
7. **"Take a screenshot of the completed feature for documentation"**
```

#### Frontend Testing Checklist
1. **Public Routes**: Verify public routes (enrollment links) work without authentication
2. **Authentication**: Verify user is logged in for protected routes
3. **Authorization**: Check role permissions work correctly
4. **API Integration**: Verify API calls work with proper authentication
5. **Error Handling**: Test error states and user feedback
6. **Data Persistence**: Verify data is saved and retrieved correctly

### Manual Testing Checklist
1. **Authentication**: Verify user is logged in
2. **Authorization**: Check role permissions
3. **Tenant Access**: Confirm tenant isolation
4. **Input Validation**: Test with invalid data
5. **Error Handling**: Verify proper error responses
6. **Data Integrity**: Check returned data format

### Debugging Steps
1. Check `req.user` object for authentication
2. Verify role permissions with `authorize` middleware
3. Confirm tenant access with `requireTenantAccess`
4. Review SQL query and parameters
5. Check database connection and results
6. Validate response format

### SQL Lock Timeout Debugging (1222 / "Lock request time out period exceeded")
If a route "hangs" then times out (especially on `UPDATE`/`INSERT`) it may be SQL locking, not Node.

1. **Log SPID** right after `transaction.begin()`:
   ```js
   const spidResult = await transaction.request().query('SELECT @@SPID as spid');
   console.log('🔍 DEBUG: SQL SPID:', spidResult.recordset?.[0]?.spid);
   ```
2. **While it’s stuck**, query the request + blocker:
   ```sql
   SELECT session_id, blocking_session_id, wait_type, wait_time, wait_resource
   FROM sys.dm_exec_requests
   WHERE session_id = <SPID>;
   ```
3. **Find/clear open transactions** (often a sleeping session from tests):
   ```sql
   SELECT session_id, status, open_transaction_count, host_name, program_name, login_name
   FROM sys.dm_exec_sessions
   WHERE is_user_process = 1 AND open_transaction_count > 0;
   ```
   Then `ROLLBACK;` in that session, or `KILL <session_id>` if appropriate.

### Route Not Found Debugging (404 Errors)
When getting 404 errors for routes that should exist:

1. **Check route mounting strategy** - Ensure unified vs direct approach is consistent
2. **Verify route registration** - Use `/api/debug/routes` endpoint to see registered routes
3. **Check file structure** - Ensure route files match the mounting strategy
4. **Restart server** - Route changes require server restart
5. **Check for typos** - Verify exact path matching in route definitions
6. **Review middleware order** - Ensure authentication middleware is applied correctly
7. **Verify route path definitions** - Ensure mounted routes use `/` not the full path
8. **Static syntax check (fast)** - Run:
   ```bash
   node -c backend/routes/commissions.js
   ```
   to catch syntax errors (e.g., duplicate `let` declarations) that prevent the router from loading and surface as 404s at runtime.

**CRITICAL DEBUGGING TECHNIQUE:**
When routes return 404, use this command to inspect all registered routes:
```bash
curl -s http://localhost:3001/api/debug/routes | jq '.routes[] | select(.path | contains("me")) | {path, methods}'
```
Or for all routes:
```bash
curl -s http://localhost:3001/api/debug/routes
```

**Mixed Routing Strategy Detection:**
Look for duplicate route patterns in the debug output. If you see multiple similar paths like:
- `/me` (from unified approach)
- `/agent/groups` (from direct approach)
This indicates MIXED routing strategies causing conflicts.

**Common 404 Causes:**
- **Mixed routing strategies** (unified + direct mounting) - THE MOST COMMON CAUSE
- **Incorrect route paths** in mounted routers (using `/groups` instead of `/`) - NEW CRITICAL RULE
- Missing `module.exports = router` in route files
- Incorrect path patterns in route mounting
- Server not restarted after route changes
- Route order conflicts (specific routes defined after general ones)

## 📁 File Organization

### Route Files Structure
```
backend/routes/
├── me/
│   ├── agent/
│   ├── tenant-admin/
│   ├── group-admin/
│   └── member/
├── agents.js
├── groups.js
├── members.js
├── products.js
└── tenants.js
```

### Service Files Structure
```
backend/services/
├── auditService.js
├── emailService.js
├── commissionService.js
└── uploadService.js
```

## 🚀 Best Practices

### Performance
- Use parameterized queries to prevent SQL injection
- Implement proper indexing on frequently queried columns
- Use transactions for multi-step operations
- Add appropriate caching where needed

### Security
- Always validate and sanitize input
- Use proper authentication and authorization
- Implement tenant isolation for multi-tenant data
- Log security-relevant events

### Maintainability
- Use consistent naming conventions
- Add comprehensive error handling
- Include detailed logging for debugging
- Follow the established patterns in existing code

## 📝 Logging Guidelines

### Debug Logging
```javascript
console.log(`🔍 DEBUG: User role: ${req.user?.currentRole}, tenantId: ${req.user?.tenantId}`);
console.log(`📊 DEBUG: Query result: ${JSON.stringify(result.recordset)}`);
```

### Error Logging
```javascript
console.error('❌ Error fetching data:', error);
console.error('❌ Error details:', {
  userId: req.user?.userId,
  userRole: req.user?.currentRole,
  endpoint: req.path,
  error: error.message
});
```

### Success Logging
```javascript
console.log(`✅ Successfully fetched ${result.recordset.length} records`);
console.log(`✅ Created new resource: ${resourceId}`);
```

## 📁 **File Handling & Blob Storage Authentication**

### ✅ **IMPORTANT: Selective Authentication Based on File Type**

**Principle:** As of the latest update, **image URLs** (logos, product images) no longer require SAS token authentication and can be used directly. However, **document URLs** (PDFs, Word docs, etc.) still require authentication for security reasons.

### 🔐 **Authentication Pattern**

**Backend Implementation:**
```javascript
// ✅ CORRECT - Authenticate only document URLs, not image URLs
const { authenticateUrls } = require('../routes/uploads');

// For simple objects - only authenticate document URLs
const authenticatedData = await authenticateUrls(data, ['documentUrl', 'pdfUrl', 'uploadedDocumentUrl']);

// For nested objects (like enrollments with product data)
const authenticatedEnrollments = await Promise.all(
    enrollments.map(async (enrollment) => {
        if (enrollment.product) {
            // Only authenticate document URLs, skip image URLs
            enrollment.product = await authenticateUrls(enrollment.product, ['productDocumentUrl', 'pdfUrl']);
        }
        return enrollment;
    })
);
```

**Frontend Implementation:**
```typescript
// ✅ CORRECT - Use authenticated URLs directly
<img src={product.productImageUrl} alt="Product" />
<a href={product.productDocumentUrl} target="_blank">View Document</a>

// ❌ WRONG - Don't try to authenticate on frontend
// The backend should handle all authentication
```

### 🎯 **URL Field Naming Convention**

**Image URL Fields (No Authentication Required):**
- `productImageUrl` - Product images
- `productLogoUrl` - Product logos  
- `logoUrl` - General logos
- `imageUrl` - General images

**Document URL Fields (Authentication Required):**
- `productDocumentUrl` - Product documents
- `fileUrl` - General files
- `uploadedDocumentUrl` - Uploaded documents
- `pdfUrl` - PDF files

### 🔧 **Authentication Function Usage**

**For Simple Objects:**
```javascript
// Authenticate top-level URL fields
const authenticatedData = await authenticateUrls(data, ['imageUrl', 'logoUrl']);
```

**For Nested Objects:**
```javascript
// Authenticate nested object URL fields
const authenticatedData = await Promise.all(
    data.map(async (item) => {
        if (item.product) {
            item.product = await authenticateUrls(item.product, ['productImageUrl', 'productLogoUrl']);
        }
        return item;
    })
);
```

**⚠️ CRITICAL: Dot Notation Limitation**
The `authenticateUrls` function does **NOT** support dot notation for nested fields like `branding.logoUrl`. 

**❌ WRONG - This will NOT work:**
```javascript
const authenticatedData = await authenticateUrls(settings, ['branding.logoUrl']);
// This fails because authenticateUrls looks for obj['branding.logoUrl'] which is undefined
```

**✅ CORRECT - Handle nested fields manually:**
```javascript
// For nested fields, authenticate them directly
if (settings.branding.logoUrl && settings.branding.logoUrl.includes('blob.core.windows.net')) {
  try {
    const { generateAuthenticatedUrl, isBlobUrl } = require('./uploads');
    if (isBlobUrl(settings.branding.logoUrl)) {
      settings.branding.logoUrl = await generateAuthenticatedUrl(settings.branding.logoUrl);
      console.log('✅ Authenticated branding.logoUrl:', settings.branding.logoUrl);
    }
  } catch (error) {
    console.warn('❌ Failed to authenticate branding.logoUrl:', error.message);
  }
}
```

**Alternative: Flatten the object before authentication:**
```javascript
// Flatten nested fields to top level
const flattenedSettings = {
  ...settings,
  brandingLogoUrl: settings.branding.logoUrl
};

// Authenticate flattened fields
const authenticatedSettings = await authenticateUrls(flattenedSettings, ['brandingLogoUrl']);

// Restore to nested structure
authenticatedSettings.branding.logoUrl = authenticatedSettings.brandingLogoUrl;
delete authenticatedSettings.brandingLogoUrl;
```

### 🚨 **Common Issues & Solutions**

**Issue 1: Nested Object Authentication**
```javascript
// ❌ WRONG - Won't authenticate nested URLs
const authenticated = await authenticateUrls(enrollment, ['productImageUrl']);

// ✅ CORRECT - Authenticate nested product URLs
if (enrollment.product) {
    enrollment.product = await authenticateUrls(enrollment.product, ['productImageUrl']);
}
```

**Issue 2: Field Name Variations**
```javascript
// ✅ CORRECT - Handle both camelCase and PascalCase
const authenticated = await authenticateUrls(data, ['productImageUrl', 'ProductImageUrl']);
```

**Issue 3: Missing URL Fields**
```javascript
// ✅ CORRECT - Check if URL exists before authenticating
if (data.productImageUrl && isBlobUrl(data.productImageUrl)) {
    data.productImageUrl = await generateAuthenticatedUrl(data.productImageUrl);
}
```

**Issue 4: Double URL Encoding**
```javascript
// ⚠️ PROBLEM: When FilePath is already URL-encoded in database
// Parsing and re-encoding causes double-encoding: %20 → %2520

// ❌ WRONG - For oe.FileUploads table
const authenticated = await authenticateUrls(doc, ['FilePath']);

// ✅ CORRECT - Use StoredFileName to avoid double-encoding
const { generateSASUrl } = require('../uploads');
const blobName = `path/to/${doc.StoredFileName}`; // Use unencoded filename
const authenticatedUrl = generateSASUrl(containerName, blobName, 'r', 60);
```

### 📋 **Implementation Checklist**

**For Each Endpoint That Returns Blob URLs:**
- [ ] ✅ Import `authenticateUrls` from `../routes/uploads`
- [ ] ✅ Identify all URL fields in the response
- [ ] ✅ **Skip authentication for image URLs** (productImageUrl, productLogoUrl, logoUrl, imageUrl)
- [ ] ✅ **Apply authentication only to document URLs** (productDocumentUrl, pdfUrl, uploadedDocumentUrl, fileUrl)
- [ ] ✅ Apply authentication to nested objects (document URLs only)
- [ ] ✅ Handle both camelCase and PascalCase field names
- [ ] ✅ Test that URLs work in browser
- [ ] ✅ Verify SAS tokens are present in document URLs only

### 🎯 **Document Viewing Solution**

**Problem:** Users can't view documents because URLs aren't authenticated.

**Solution:** Ensure all document URLs are authenticated in the backend before sending to frontend.

```javascript
// ✅ CORRECT - Authenticate document URLs
const authenticatedProduct = await authenticateUrls(product, ['productDocumentUrl']);

// Frontend can then use direct links
<a href={product.productDocumentUrl} target="_blank">View Document</a>
```

### 🎯 **Complete Logo Upload & Display Flow**

#### Frontend Implementation Checklist
- [ ] Use `FileReader` to create preview URL from selected file
- [ ] Store both `File` object and preview URL in separate state
- [ ] Handle both new file selection and existing logo display
- [ ] Use correct `uploadType` that matches backend container mapping
- [ ] Access response URL as `data[0].url` (array, not object)
- [ ] Upload file FIRST, then save URL to database
- [ ] Only include `logoFile` if new file selected
- [ ] Only include `existingLogoUrl` if no new file selected

#### Backend Implementation Checklist
- [ ] Return `data` as array: `[{ url: "...", filename: "..." }]`
- [ ] Map uploadType to correct Azure Blob container
- [ ] Generate authenticated Azure Blob URLs
- [ ] Map `logoUrl` field to `LogoUrl` column in entity table
- [ ] Include `LogoUrl` in SQL UPDATE statement
- [ ] Handle `logoUrl` in allowed fields mapping
- [ ] Import `authenticateUrls` from correct path
- [ ] Call `authenticateUrls(result.recordset[0], ['LogoUrl'])` before response
- [ ] Apply to all entity detail endpoints

#### Common Pitfalls & Solutions
- [ ] Don't use wrong uploadType (check container mapping)
- [ ] Don't access `data.url` (use `data[0].url`)
- [ ] Don't upload logo after database update
- [ ] Don't forget URL authentication on entity endpoints
- [ ] Don't mix up `logoFile` (File object) with `logoUrl` (string)
- [ ] Don't forget to handle both create and edit modes
- [ ] Don't forget `oe.{Entity}.LogoUrl` column exists (NVARCHAR(MAX) NULL)

#### Frontend Implementation Pattern
```typescript
// File Selection & State Management
const [logoFile, setLogoFile] = useState<File | null>(null);
const [logoPreview, setLogoPreview] = useState<string>('');
const [existingLogoUrl, setExistingLogoUrl] = useState<string>('');

const handleLogoUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
  const file = event.target.files?.[0];
  if (file) {
    setLogoFile(file);
    const reader = new FileReader();
    reader.onload = (e) => setLogoPreview(e.target?.result as string);
    reader.readAsDataURL(file);
  }
};

// Upload Service
static async uploadEntityLogo(entityId: string, logoFile: File) {
  const formData = new FormData();
  formData.append('files', logoFile);
  formData.append('uploadType', 'logos'); // ✅ Must match backend container mapping
  formData.append('entityId', entityId);
  return apiService.post('/api/uploads', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
}

// Two-Step Process: Upload First, Then Save
if (entityData.logoFile) {
  const uploadResponse = await EntityService.uploadEntityLogo(entityId, entityData.logoFile);
  if (uploadResponse.success && uploadResponse.data?.[0]?.url) { // ✅ Array access
    logoUrl = uploadResponse.data[0].url;
  }
}
// Then create/update entity with logoUrl

// Submit Logic
const entityData = {
  ...formData,
  logoFile: logoFile || undefined,
  existingLogoUrl: !logoFile ? existingLogoUrl : undefined,
};
```

#### Backend Implementation Pattern
```javascript
// Upload Endpoint Response
return res.json({
  success: true,
  data: [{ url: uploadedFiles[0].url, filename: uploadedFiles[0].storedFileName }]
});

// Container Mapping
const containerMapping = {
  'logos': 'logos', // ✅ Entity logos
  'products': 'products',
  // ... other types
};

// Database Field Mapping
const allowedFields = {
  'logoUrl': 'LogoUrl', // ✅ Maps to DB column
  // ... other fields
};

// URL Authentication
const { authenticateUrls } = require('../../uploads');
const authenticatedResult = authenticateUrls(result.recordset[0], ['LogoUrl']);
res.json({ success: true, data: authenticatedResult });
```

## 📚 Reference Documentation

### Existing Endpoints
- **API Endpoints**: See `docs/api-endpoints.md` for complete list of existing endpoints
- **Database Schema**: See `docs/database-schema.md` for table structures
- **Frontend Integration**: See `prompts/frontend-integration.md` for consumption patterns

### Before Creating New Endpoints
1. **Check existing endpoints** in `docs/api-endpoints.md` to avoid duplication
2. **Review similar endpoints** to follow established patterns
3. **Verify database schema** in `docs/database-schema.md` for correct table/column names
4. **Test with frontend** using patterns from `prompts/frontend-integration.md`
5. **Authenticate all blob URLs** before sending to frontend

---

## 🔄 **Endpoint Reuse Strategy**

### ✅ **Reuse Existing Endpoints When Possible**

**Principle:** Before creating new specialized endpoints, check if existing unified endpoints can serve the purpose.

**Example - Agent Dropdowns:**
```typescript
// ❌ BAD - Creating specialized dropdown endpoints
static async getAgents(currentRole: string) {
  return await apiService.get('/api/me/tenant-admin/templates/dropdown-data/agents');
}

// ✅ GOOD - Reusing existing unified endpoint
static async getAgents(currentRole: string) {
  switch (currentRole) {
    case 'TenantAdmin':
      // Reuse existing tenant-admin agents endpoint with filtering
      return await apiService.get('/api/tenant-admin/agents?status=Active');
    case 'SysAdmin':
      // Use specialized endpoint only when cross-tenant access is needed
      return await apiService.get('/api/me/sysadmin/templates/dropdown-data/agents');
  }
}
```

**Benefits:**
- 🔄 **Less duplication**: Reuse existing tested endpoints
- 🛡️ **Consistent security**: Leverage existing authorization logic  
- 🎯 **Single source of truth**: One endpoint for agent data across features
- 🚀 **Faster development**: No need to create/maintain specialized endpoints

**When to Create New Endpoints:**
- ✅ Cross-tenant access needed (SysAdmin scenarios)
- ✅ Significantly different data structure required
- ✅ Complex business logic that doesn't fit existing endpoints
- ❌ Simple filtering or formatting differences (handle in frontend) 

---

## 🎯 **TypeScript Interface Strategy for SQL-Based Projects**

### ✅ **RECOMMENDED: Single Source of Truth Approach**

**Principle:** Create one comprehensive interface per database table that matches the SQL schema exactly.

**Implementation Pattern:**
```typescript
// frontend/src/types/member.types.ts - ONE source of truth
export interface Member {
  // Core identification fields
  MemberId: string;
  UserId: string;
  GroupId?: string;
  
  // Personal information
  FirstName: string;
  LastName: string;
  Email: string;
  PhoneNumber?: string;
  DateOfBirth?: string;
  Gender?: string;
  
  // Address information
  Address?: string;
  City?: string;
  State?: string;
  Zip?: string;
  
  // ... all other fields from SQL schema
}

// Use utility types for different views
export type MemberSummary = Pick<Member, 'MemberId' | 'FirstName' | 'LastName' | 'Email' | 'Status'>;
export type MemberEnrollment = Pick<Member, 'MemberId' | 'FirstName' | 'LastName' | 'Email'>;
export type MemberHousehold = Pick<Member, 'MemberId' | 'FirstName' | 'LastName' | 'RelationshipType'>;
```

### ❌ **AVOID: Multiple Interface Approach**

**Problems with multiple interfaces:**
- **High maintenance overhead** - Update 5+ files when schema changes
- **Inconsistency risk** - Interfaces get out of sync
- **Developer confusion** - Which interface to use where?
- **Bug breeding ground** - Type mismatches between components

**Example of what NOT to do:**
```typescript
// ❌ WRONG - Multiple Member interfaces in different files
// frontend/src/pages/admin/members.tsx
interface Member { /* local definition */ }

// frontend/src/pages/tenant-admin/TenantMembers.tsx  
interface Member { /* another local definition */ }

// frontend/src/types/member.types.ts
interface Member { /* main definition */ }
```

### 🎯 **Key Benefits of Single Interface Approach**

1. **Easier Maintenance** - One place to update when schema changes
2. **Better Developer Experience** - Clear which interface to use
3. **Reduced Bugs** - No type mismatches between components
4. **Faster Development** - No time wasted finding interfaces
5. **Schema Consistency** - Frontend always matches database structure

### 🔧 **Implementation Guidelines**

1. **Match SQL Schema Exactly** - Use PascalCase field names (e.g., `FirstName`, `LastName`)
2. **Use TypeScript Utility Types** - `Pick`, `Partial`, `Omit` for different views
3. **Centralize in Types Directory** - `frontend/src/types/{resource}.types.ts`
4. **Export from Index** - Re-export all types from `frontend/src/types/index.ts`
5. **Remove Duplicates** - Delete local interface definitions from component files

### 📁 **File Organization**

```
frontend/src/types/
├── index.ts                    # Re-exports all types
├── member.types.ts            # Single Member interface + utility types
├── tenant.types.ts            # Single Tenant interface + utility types
├── product.types.ts           # Single Product interface + utility types
└── api.types.ts               # Common API response types
```

### 🚨 **Migration Strategy**

**When consolidating existing interfaces:**

1. **Audit current interfaces** - Find all duplicate definitions
2. **Enhance main interface** - Add missing fields from SQL schema
3. **Create utility types** - For different use cases (summary, enrollment, etc.)
4. **Update imports** - Change components to use centralized types
5. **Remove duplicates** - Delete local interface definitions
6. **Test thoroughly** - Ensure no breaking changes

**Example migration:**
```typescript
// ❌ BEFORE - Multiple interfaces
// frontend/src/pages/admin/members.tsx
interface Member { /* local definition */ }

// ✅ AFTER - Single import
import { Member, MemberSummary } from '../../types/member.types';
```

### 🎯 **When to Break the Rule**

**Only create separate interfaces when:**
- ✅ **Completely different data models** (e.g., API response vs database entity)
- ✅ **Different validation rules** (e.g., create form vs update form)
- ✅ **External API integration** (e.g., third-party service response)

**Example of acceptable separation:**
```typescript
// Database entity
export interface Member { /* full database fields */ }

// API response wrapper
export interface MemberResponse {
  success: boolean;
  data: Member;
  message?: string;
}

// Form data (subset for creation)
export interface CreateMemberData {
  firstName: string;
  lastName: string;
  email: string;
  // ... only fields needed for creation
}
```

### 📊 **Maintenance Complexity Assessment**

| Approach | Maintenance Overhead | Consistency Risk | Developer Experience | **Recommendation** |
|----------|---------------------|------------------|---------------------|-------------------|
| **Single Interface** | 🟢 **Low** | 🟢 **None** | 🟢 **Excellent** | ✅ **PREFERRED** |
| **Multiple Interfaces** | 🔴 **High** | 🔴 **High** | 🔴 **Poor** | ❌ **AVOID** |

**The maintenance overhead of multiple interfaces is NOT worth it** - it creates more problems than it solves, especially in growing projects.

---

## 🔄 **API Data Format Consistency**

### ✅ **CRITICAL: Maintain Existing Data Formats**

**Principle:** Once an API endpoint is established and consumed by frontend code, **NEVER change the data format** of the response.

**Why This Matters:**
- **Frontend code depends** on specific field names and data structures
- **Changing formats breaks** existing functionality without warning
- **TypeScript interfaces** must match the actual API responses
- **Database schema changes** should NOT affect API response formats

### 🚨 **What NOT to Do**

```javascript
// ❌ WRONG - Changing API response format
// BEFORE: { firstName: "John", lastName: "Doe" }
// AFTER:  { FirstName: "John", LastName: "Doe" }

// This breaks ALL existing frontend code that expects camelCase
```

### ✅ **What TO Do Instead**

**Option 1: Keep Existing Format (RECOMMENDED)**
```javascript
// ✅ CORRECT - Maintain existing API format
// Database: FirstName, LastName (PascalCase)
// API Response: firstName, lastName (camelCase)

const result = await request.query(query);
const members = result.recordset.map(member => ({
  firstName: member.FirstName,        // Transform database → API
  lastName: member.LastName,          // Transform database → API
  email: member.Email,                // Transform database → API
  // ... other fields
}));

res.json({ success: true, data: members });
```

**Option 2: Version the API (Advanced)**
```javascript
// ✅ CORRECT - Versioned API for major changes
// /api/v1/members - Returns camelCase
// /api/v2/members - Returns PascalCase (new version)

const apiVersion = req.headers['api-version'] || 'v1';
if (apiVersion === 'v1') {
  // Return camelCase (existing format)
} else if (apiVersion === 'v2') {
  // Return PascalCase (new format)
}
```

### 📋 **Implementation Guidelines**

1. **Database Schema**: Use PascalCase (FirstName, LastName)
2. **API Responses**: Transform to camelCase (firstName, lastName)
3. **Frontend Interfaces**: Match the API response format (camelCase)
4. **Never Change**: Existing API response formats without versioning

### 🔧 **Transformation Pattern**

```javascript
// ✅ RECOMMENDED PATTERN - Transform in backend
const transformMemberForAPI = (dbMember) => ({
  memberId: dbMember.MemberId,
  firstName: dbMember.FirstName,
  lastName: dbMember.LastName,
  email: dbMember.Email,
  phoneNumber: dbMember.PhoneNumber,
  dateOfBirth: dbMember.DateOfBirth,
  // ... transform all fields
});

// Usage in endpoints:
const result = await request.query(query);
const members = result.recordset.map(transformMemberForAPI);
res.json({ success: true, data: members });
```

### 🎯 **When This Rule Applies**

- ✅ **All existing endpoints** - Never change response format
- ✅ **New endpoints** - Follow established format patterns
- ✅ **Database schema updates** - Transform data, don't change API
- ❌ **Breaking changes** - Use API versioning instead

### 🚨 **Breaking Change Scenarios**

**If you MUST change an API response format:**

1. **Create new versioned endpoint** (`/api/v2/members`)
2. **Keep old endpoint working** (`/api/v1/members`)
3. **Update frontend gradually** to use new version
4. **Deprecate old version** after migration period
5. **Document the change** clearly for developers

**Example:**
```javascript
// OLD (keep working)
router.get('/v1/members', async (req, res) => {
  // Return camelCase format
});

// NEW (new format)
router.get('/v2/members', async (req, res) => {
  // Return PascalCase format
});
```

---

## 🔄 Unified Functions Management

### **CRITICAL: Always Check for Existing Unified Functions**

**Before creating ANY business logic, the AI MUST:**

1. **Check `/backend/services/shared/` directory** for existing functions
2. **Search existing routes** for similar logic using `grep -r "functionName" backend/routes/`
3. **Show unified function warning** if similar logic is found
4. **Ask user permission** before proceeding

### **AI Warning System**

**When similar logic is found, show this warning:**
```
🚨 UNIFIED FUNCTION WARNING 🚨

Found similar logic in existing endpoints:
- /api/endpoint1 (uses SharedService.functionName)
- /api/endpoint2 (uses SharedService.functionName)

RECOMMENDATION: Use existing unified function instead of duplicating logic.

Should I:
1. ✅ Use existing SharedService.functionName
2. ❌ Create new separate logic (not recommended)
3. 🔄 Refactor existing endpoints to use new unified approach (requires permission)
```

**If refactoring is needed, ask permission:**
```
⚠️ REFACTORING REQUIRED ⚠️

To use unified approach, I need to refactor existing endpoint: /api/existing-endpoint
This will modify existing working code.

Do you want me to proceed with refactoring? (Y/N)
```

### **File Structure**
```
backend/services/shared/
├── pricing.service.js      # Pricing calculations
├── member.service.js       # Member operations  
├── enrollment.service.js   # Enrollment operations
└── index.js               # Export all services
```

### **Function Documentation Requirements**
All unified functions MUST include:
```javascript
/**
 * UNIFIED FUNCTION - Used by multiple endpoints
 * 
 * Endpoints using this function:
 * - /api/me/member/pricing (Member role)
 * - /api/members/:memberId/pricing (Admin roles)
 */
```

---

## 📅 Date Display (use UTC)

**Problem:** Server returns UTC dates (e.g., `"2025-11-05T00:00:00Z"`), but `new Date()` converts to user's timezone, showing wrong day.  
**Solution:** For calendar dates (billing, DOB, hire dates), parse date parts separately: `const [y,m,d] = dateString.split('T')[0].split('-'); new Date(y, m-1, d)`.  
**Timestamps:** Use standard `new Date(dateString)` with timezone conversion.

### Vendor scheduled export times (wall clock, single zone)

- **`oe.VendorScheduledJobs.ExportScheduleTime`** is stored as **`HH:mm` wall-clock time** (not UTC) in one IANA timezone: **`VENDOR_EXPORT_SCHEDULE_TIMEZONE`** (default **`America/Chicago`**). The vendor-exports scheduler evaluates “due” jobs using that same clock.
- **`GET /api/vendors/:id/scheduled-jobs`** includes **`scheduleTimezone`** (same env default) so the admin UI can translate between the user’s browser-local time and the stored value. Do not assume the browser and server zone match without conversion.

---


