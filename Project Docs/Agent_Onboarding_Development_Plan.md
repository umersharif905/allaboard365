# Agent Onboarding Links - Development Plan

## 🎯 Recommended Starting Point

Based on the requirements and existing codebase structure, I recommend starting with **Phase 0: Backend Compliance Fix** to address critical routing violations, then proceeding with **Phase 1: Database Foundation** to establish the core data structures before building the user interfaces.

## ⚠️ CRITICAL: Backend Compliance Issues

The existing codebase has **mixed routing strategies** that violate backend-system.md rules and must be fixed before implementing new features:

```javascript
// ❌ WRONG - Mixed approach (causes routing conflicts)
app.use('/api/me', authenticate, meRoutes);           // Unified approach
app.use('/api/tenant-admin', authenticate, tenantAdminRoutes); // Direct approach
```

**Backend-system.md Rule**: "⚠️ NEVER MIX BOTH APPROACHES - This creates routing conflicts"

## 📋 Development Phases

### Phase 0: Backend Compliance Fix (CRITICAL - Must Do First)
**Priority: CRITICAL | Estimated Time: 1-2 days**

#### 0.1 Audit Existing Routing Issues
- Identify all mixed routing strategy violations
- Document current route mounting patterns
- Plan unified approach implementation

#### 0.2 Fix Routing Strategy Violations
- Choose single approach (recommended: Unified approach)
- Refactor conflicting routes to follow single pattern
- Test all existing endpoints still work
- Update documentation

**Why This Phase is Critical:**
- Prevents routing conflicts in new features
- Ensures backend system compliance
- Required before implementing any new endpoints

### Phase 1: Database Foundation
**Priority: HIGH | Estimated Time: 2-3 days**

#### 1.1 Database Schema Creation
- Create `oe.AgentOnboardingLinks` table
- Create `oe.AgentOnboardingSessions` table  
- Add necessary indexes for performance
- Create foreign key relationships to existing tables
- Add database constraints and validation rules

#### 1.2 Database Migration Scripts
- Create migration scripts for production deployment
- Add rollback procedures
- Test migration on development database

**Why Start Here:**
- Foundation for all other components
- Enables backend API development
- Can be validated independently
- No dependencies on other systems

### Phase 2: Backend API Development
**Priority: HIGH | Estimated Time: 5-7 days**

#### 2.1 Core API Endpoints
- `POST /api/tenant-admin/onboarding-links` - Create onboarding link
- `GET /api/tenant-admin/onboarding-links` - List tenant's links
- `PUT /api/tenant-admin/onboarding-links/:id` - Update link
- `DELETE /api/tenant-admin/onboarding-links/:id` - Deactivate link

#### 2.2 Public Onboarding APIs
- `POST /api/public/onboarding/validate-code` - Validate commission code
- `POST /api/public/onboarding/start-session` - Start onboarding session
- `POST /api/public/onboarding/submit-agent` - Submit agent information
- `GET /api/public/onboarding/session/:token` - Get session status

#### 2.3 Security & Validation
- Input validation and sanitization
- Rate limiting on public endpoints
- Session token generation and management
- Commission rule validation

**Why This Phase:**
- Enables frontend development
- Can be tested with API tools
- Establishes data flow patterns

### Phase 3: Tenant Admin Interface
**Priority: MEDIUM | Estimated Time: 4-5 days**

#### 3.1 Link Management Dashboard
- List view of all onboarding links
- Create new link wizard
- Edit existing links
- View usage statistics

#### 3.2 Integration with Existing UI
- Add to tenant admin navigation
- Follow existing UI patterns and styling
- Responsive design for mobile/desktop

**Why This Phase:**
- Enables tenant admins to create links
- Can be tested with backend APIs
- Provides foundation for public interface

### Phase 4: Public Onboarding Interface
**Priority: HIGH | Estimated Time: 6-8 days**

#### 4.1 Three-Section Onboarding Form
- Section 1: Personal & Professional Information
- Section 2: Banking Information  
- Section 3: Contract & Signature
- Progress indicator and navigation

#### 4.2 Session Management
- Save and resume functionality
- Session expiration handling
- Form validation and error handling

#### 4.3 Mobile-Responsive Design
- Optimize for mobile devices
- Touch-friendly interface
- File upload capabilities

**Why This Phase:**
- Core user experience
- Most complex frontend component
- Requires all backend APIs

### Phase 5: Integration & Testing
**Priority: HIGH | Estimated Time: 3-4 days**

#### 5.1 Commission Rule Integration
- Link creation with existing commission rules
- Automatic agent assignment to rules
- Commission distribution validation (100% distribution requirement)

#### 5.2 Agent Hierarchy Integration
- **Leverage Existing System**: Use the completed `oe.AgentHierarchy` table (already implemented)
- **Automatic Assignment**: Onboarded agents automatically assigned to proper hierarchy
- **Upline/Downline Establishment**: Integration with existing hierarchy service functions
- **Status Management**: Agent status flow (Pending → Active) with hierarchy activation

#### 5.3 Integration with Existing Agent Onboarding System
- **Extend Current System**: Build upon existing agent onboarding infrastructure
- **Upline Selection**: Integrate with existing upline selection components
- **Status Tracking**: Use existing agent status management patterns
- **Onboarding Tokens**: Leverage existing token-based onboarding flow

#### 5.4 End-to-End Testing
- Complete onboarding flow testing
- Error scenario testing
- Performance testing

### Phase 6: Security & Production Readiness
**Priority: HIGH | Estimated Time: 2-3 days**

#### 6.1 Security Hardening
- Input sanitization and validation
- SQL injection prevention
- XSS protection
- Rate limiting implementation

#### 6.2 Production Deployment
- Environment configuration
- Database migration execution
- Monitoring and logging setup

## 🛠️ Technical Implementation Strategy

### Backend Architecture (Following Existing Patterns)
```
backend/
├── routes/
│   ├── me/
│   │   └── tenant-admin/
│   │       └── onboarding-links.js  # Tenant admin link management (unified approach)
│   └── public/
│       └── onboarding.js           # Public onboarding endpoints (no auth)
├── services/
│   ├── onboardingLinkService.js    # Business logic for links
│   ├── onboardingSessionService.js # Session management
│   └── agentOnboardingService.js   # Agent creation logic (extends existing)
└── middleware/
    ├── onboardingValidation.js     # Input validation
    └── onboardingSecurity.js       # Security middleware
```

**Route Mounting (backend/app.js):**
```javascript
// Following unified approach (after compliance fix)
app.use('/api/me/tenant-admin/onboarding-links', authenticate, authorize(['TenantAdmin']), onboardingLinksRoutes);
app.use('/api/public/onboarding', onboardingRoutes); // No auth required
```

### Frontend Architecture
```
frontend/src/
├── pages/
│   ├── tenant-admin/
│   │   └── OnboardingLinks.tsx     # Admin dashboard
│   └── public/
│       └── AgentOnboarding.tsx     # Public onboarding form
├── components/
│   ├── onboarding/
│   │   ├── LinkManagement.tsx      # Link CRUD operations
│   │   ├── OnboardingWizard.tsx    # Multi-step form
│   │   ├── PersonalInfoForm.tsx    # Section 1 form
│   │   ├── BankingInfoForm.tsx     # Section 2 form
│   │   └── ContractSignatureForm.tsx # Section 3 form
│   └── shared/
│       └── DigitalSignature.tsx    # Signature capture
├── services/
│   ├── onboardingLinks.service.ts  # API service
│   └── onboardingSession.service.ts # Session management
└── types/
    └── onboarding.types.ts         # TypeScript interfaces
```

## 🔧 Development Environment Setup

### Prerequisites
1. **Database Access**: Access to development database for schema creation
2. **API Testing**: Postman or similar for API endpoint testing
3. **Frontend Build**: Existing React/TypeScript build system
4. **Code Review**: Git workflow for code review and testing

### Recommended Tools
- **Database**: SQL Server Management Studio for schema development
- **API Testing**: Postman collections for endpoint testing
- **Frontend**: Existing Vite/React development environment
- **Documentation**: Continue using existing documentation patterns

## 🏗️ Leveraging Existing Infrastructure

### ✅ Already Implemented (From College Notes)
- **AgentHierarchy Table**: Completely redesigned and implemented with clean 8-field structure
- **Hierarchy Service Functions**: Core hierarchy management logic ready
- **Agent Onboarding Infrastructure**: Token-based onboarding system exists
- **Commission Rules Integration**: Existing CommissionRules table supports tiered commissions
- **Status Management**: Agent status flow (Pending → Active → Suspended/Terminated)

### 🔄 Integration Points
- **Extend Existing Onboarding**: Build upon current agent creation process
- **Use Existing Hierarchy**: Leverage completed AgentHierarchy table structure
- **Commission Integration**: Connect with existing CommissionRules system
- **UI Patterns**: Follow existing TenantAgents.tsx patterns for consistency

## 🚀 Getting Started Steps

### Step 0: Backend Compliance Audit (CRITICAL)
```bash
# Audit existing routing violations
grep -r "app.use.*api" backend/app.js
grep -r "router.use.*authenticate" backend/routes/
```

### Step 1: Database Schema (Start Here)
```sql
-- Create AgentOnboardingLinks table
CREATE TABLE oe.AgentOnboardingLinks (
    LinkId UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
    TenantId UNIQUEIDENTIFIER NOT NULL,
    AgencyId UNIQUEIDENTIFIER NULL,
    AgentId UNIQUEIDENTIFIER NULL,
    LinkName NVARCHAR(100) NOT NULL,
    CommissionCode NVARCHAR(50) NOT NULL,
    CommissionRuleId UNIQUEIDENTIFIER NOT NULL,
    IsActive BIT NOT NULL DEFAULT 1,
    CurrentUses INT NOT NULL DEFAULT 0,
    CreatedBy UNIQUEIDENTIFIER NOT NULL,
    CreatedDate DATETIME2 NOT NULL DEFAULT GETDATE(),
    ModifiedDate DATETIME2 NOT NULL DEFAULT GETDATE(),
    RedirectUrl NVARCHAR(500) NULL,
    ContractDocumentId UNIQUEIDENTIFIER NULL,
    CustomFields NVARCHAR(MAX) NULL,
    
    CONSTRAINT FK_AgentOnboardingLinks_TenantId 
        FOREIGN KEY (TenantId) REFERENCES oe.Tenants(TenantId),
    CONSTRAINT FK_AgentOnboardingLinks_CommissionRuleId 
        FOREIGN KEY (CommissionRuleId) REFERENCES oe.CommissionRules(RuleId),
    CONSTRAINT UQ_AgentOnboardingLinks_TenantId_CommissionCode 
        UNIQUE (TenantId, CommissionCode)
);

-- Create AgentOnboardingSessions table
CREATE TABLE oe.AgentOnboardingSessions (
    SessionId UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
    LinkId UNIQUEIDENTIFIER NOT NULL,
    SessionToken NVARCHAR(100) NOT NULL UNIQUE,
    AgentData NVARCHAR(MAX) NULL,
    CommissionRuleId UNIQUEIDENTIFIER NULL,
    Status NVARCHAR(20) NOT NULL DEFAULT 'Pending',
    StartedDate DATETIME2 NOT NULL DEFAULT GETDATE(),
    CompletedDate DATETIME2 NULL,
    ExpiresDate DATETIME2 NOT NULL DEFAULT DATEADD(HOUR, 24, GETDATE()),
    IPAddress NVARCHAR(45) NULL,
    UserAgent NVARCHAR(500) NULL,
    
    CONSTRAINT FK_AgentOnboardingSessions_LinkId 
        FOREIGN KEY (LinkId) REFERENCES oe.AgentOnboardingLinks(LinkId)
);
```

### Step 2: Backend API Structure (Following Existing Patterns)
```javascript
// backend/routes/me/tenant-admin/onboarding-links.js
const express = require('express');
const router = express.Router();
const onboardingLinkService = require('../../../services/onboardingLinkService');

// Create onboarding link (extends existing agent creation pattern)
router.post('/', async (req, res) => {
  try {
    const link = await onboardingLinkService.createLink(req.body, req.user);
    res.json({ success: true, data: link });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// List tenant's onboarding links
router.get('/', async (req, res) => {
  try {
    const links = await onboardingLinkService.getTenantLinks(req.user.TenantId);
    res.json({ success: true, data: links });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Public onboarding endpoints (no auth required)
router.post('/validate-code', async (req, res) => {
  try {
    const result = await onboardingLinkService.validateCommissionCode(req.body.commissionCode);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

module.exports = router;
```

### Step 3: Frontend Service Layer (Following Existing Patterns)
```typescript
// frontend/src/services/onboardingLinks.service.ts
import { apiService } from './api.service';

export interface OnboardingLink {
  linkId: string;
  linkName: string;
  commissionCode: string;
  commissionRuleId: string;
  isActive: boolean;
  currentUses: number;
  createdDate: string;
  onboardingUrl: string;
}

export class OnboardingLinksService {
  // Following existing TenantAdminAgentsService pattern
  static async createLink(linkData: CreateLinkRequest): Promise<ApiResponse<OnboardingLink>> {
    return apiService.post('/api/me/tenant-admin/onboarding-links', linkData);
  }

  static async getTenantLinks(): Promise<ApiResponse<OnboardingLink[]>> {
    return apiService.get('/api/me/tenant-admin/onboarding-links');
  }

  // Public endpoints (no auth required)
  static async validateCommissionCode(commissionCode: string): Promise<ApiResponse<any>> {
    return apiService.post('/api/public/onboarding/validate-code', { commissionCode });
  }

  static async startOnboardingSession(commissionCode: string): Promise<ApiResponse<any>> {
    return apiService.post('/api/public/onboarding/start-session', { commissionCode });
  }
}
```

## 📊 Success Metrics

### Phase 1 Success Criteria
- [ ] Database tables created successfully
- [ ] Foreign key relationships established
- [ ] Indexes created for performance
- [ ] Migration scripts tested

### Phase 2 Success Criteria
- [ ] All API endpoints responding correctly
- [ ] Input validation working
- [ ] Security middleware functional
- [ ] API documentation complete

### Phase 3 Success Criteria
- [ ] Admin interface fully functional
- [ ] Link CRUD operations working
- [ ] Integration with existing UI patterns
- [ ] Mobile responsive design

### Phase 4 Success Criteria
- [ ] Three-section onboarding form complete
- [ ] Session management working
- [ ] Form validation and error handling
- [ ] Mobile optimization complete

### Phase 5 Success Criteria
- [ ] Commission rule integration working
- [ ] Agent hierarchy assignment working
- [ ] End-to-end flow tested
- [ ] Performance requirements met

### Phase 6 Success Criteria
- [ ] Security audit passed
- [ ] Production deployment successful
- [ ] Monitoring and logging active
- [ ] User acceptance testing complete

## 🔄 Next Steps

1. **Start with Database Schema** - Create the foundation tables
2. **Build Backend APIs** - Establish the data layer
3. **Create Admin Interface** - Enable link management
4. **Build Public Interface** - Complete the user experience
5. **Integration Testing** - Ensure everything works together
6. **Production Deployment** - Launch the feature

This phased approach ensures each component can be built and tested independently while maintaining the overall system integrity.
