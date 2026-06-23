# OpenEnroll System Details

## Table of Contents
1. [System Overview](#system-overview)
2. [Architecture](#architecture)
3. [Authentication & Authorization](#authentication--authorization)
4. [Portal Structure](#portal-structure)
   - [System Admin Portal](#system-admin-portal)
   - [Tenant Admin Portal](#tenant-admin-portal)
   - [Agent Portal](#agent-portal)
   - [Group Admin Portal](#group-admin-portal)
   - [Member Portal](#member-portal)
5. [Database Schema](#database-schema)
6. [API Structure](#api-structure)
7. [Key Features](#key-features)
8. [Integration Points](#integration-points)

---

## System Overview

OpenEnroll is a comprehensive insurance enrollment and management platform designed to handle the complete lifecycle of insurance products, from product creation to member enrollment and ongoing management. The system supports multiple user types with distinct roles and responsibilities, providing a multi-tenant architecture with white-labeling capabilities.

### Core Capabilities
- **Multi-Tenant Architecture**: Complete tenant isolation with custom branding
- **Product Management**: Full lifecycle management of insurance products
- **Agent Onboarding**: Streamlined agent recruitment and onboarding process
- **Member Enrollment**: Self-service and assisted enrollment workflows
- **Commission Management**: Complex hierarchical commission structures
- **Group Management**: Corporate and group enrollment capabilities
- **White-Labeling**: Custom domains and branding for tenants
- **Message Center**: Integrated communication and notification system

---

## Architecture

### Technology Stack
- **Frontend**: React 18 with TypeScript, Tailwind CSS, React Router
- **Backend**: Node.js with Express.js
- **Database**: Microsoft SQL Server
- **Authentication**: OAuth 2.0 with JWT tokens
- **File Storage**: Azure Blob Storage
- **Email**: SendGrid integration
- **Domain Management**: Azure Front Door for custom domains

### System Components
```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Frontend      │    │   Backend       │    │   Database      │
│   (React)       │◄──►│   (Node.js)     │◄──►│   (SQL Server)  │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │                       │                       │
         │                       │                       │
         ▼                       ▼                       ▼
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Azure Blob    │    │   SendGrid      │    │   Azure Front   │
│   Storage       │    │   Email         │    │   Door          │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

---

## Authentication & Authorization

### Authentication Flow
1. **Login**: Users authenticate via OAuth 2.0 endpoint
2. **Token Management**: JWT tokens stored in localStorage
3. **Role-Based Access**: Multiple roles supported per user
4. **Session Management**: Automatic token refresh and logout

### User Roles & Permissions

#### System Admin (SysAdmin)
- **Access**: Full system access across all tenants
- **Capabilities**: 
  - Global product management
  - Tenant management
  - System-wide commission rules
  - Global marketplace
  - System settings and configuration

#### Tenant Admin (TenantAdmin)
- **Access**: Limited to their tenant's data
- **Capabilities**:
  - Tenant-specific product management
  - Agent management and onboarding
  - Group management
  - Commission rules for their tenant
  - Custom domain configuration

#### Agent
- **Access**: Limited to their assigned groups and members
- **Capabilities**:
  - Member management
  - Product sales and enrollment
  - Commission tracking
  - Group management (if assigned)

#### Group Admin (GroupAdmin)
- **Access**: Limited to their assigned groups
- **Capabilities**:
  - Group member management
  - Group enrollment management
  - Limited product access

#### Member
- **Access**: Self-service portal
- **Capabilities**:
  - View and manage their coverage
  - Dependent management
  - Payment management
  - Document access

---

## Portal Structure

## System Admin Portal

### Dashboard (`/admin/dashboard`)
- **Overview**: System-wide metrics and statistics
- **Key Metrics**: 
  - Total tenants
  - Active products
  - System-wide enrollments
  - Revenue tracking
- **Quick Actions**: Access to major system functions

### Product Marketplace (`/admin/marketplace`)
- **Product Management**: Create, edit, and manage insurance products
- **Product Wizard**: 11-step product creation process
  - Step 1: Vendor Selection
  - Step 2: Basic Details
  - Step 3: Configuration Fields
  - Step 4: Pricing Tiers
  - Step 5: Acknowledgement Questions
  - Step 6: Media & Documents
  - Step 7: ID Card Design
  - Step 8: Plan Details
  - Step 9: AI Chunks
  - Step 10: ASA Requirements
  - Step 11: Review & Publish
- **Product Bundles**: Create and manage product collections
- **Vendor Management**: Manage insurance carriers and vendors

### Tenant Management (`/admin/tenants`)
- **Tenant Overview**: List all tenants in the system
- **Tenant Details**: View and manage individual tenant settings
- **Custom Domains**: Manage white-label domain configurations
- **Tenant Settings**: Global tenant configuration

### Commission System (`/admin/commissions`)
- **Commission Rules**: Create and manage global commission rules
- **Rule Templates**: Pre-built templates for common scenarios
- **Hierarchy Management**: Manage agent upline/downline structures
- **Commission Tracking**: Monitor commission payments and calculations

### Accounting (`/admin/accounting`)
- **Revenue Tracking**: System-wide revenue and financial metrics
- **Payment Processing**: Monitor payment transactions
- **Financial Reports**: Generate accounting reports

### Message Center (`/admin/message-center`)
- **Message Templates**: Create and manage email templates
- **Scheduled Messages**: Set up automated message campaigns
- **Message Queue**: Monitor message processing
- **Message History**: Track sent messages
- **Analytics**: Message performance metrics

---

## Tenant Admin Portal

### Dashboard (`/tenant-admin/dashboard`)
- **Tenant Overview**: Tenant-specific metrics and statistics
- **Key Metrics**:
  - Active agents
  - Group enrollments
  - Commission tracking
  - Product performance
- **Quick Actions**: Access to tenant-specific functions

### Product Management (`/tenant-admin/products`)
- **My Products**: Manage tenant-owned products
- **Subscribed Products**: View and manage subscribed products
- **Marketplace**: Browse and subscribe to available products
- **Product Creation**: Create new products for the tenant
- **Product Bundles**: Create and manage product collections

### Agent Management (`/tenant-admin/agents`)
- **Agent Directory**: View all agents in the tenant
- **Agent Details**: Individual agent management
- **Agent Hierarchy**: View upline/downline relationships
- **Agent Onboarding**: Manage onboarding links and process
- **Commission Tracking**: Monitor agent commissions

### Group Management (`/tenant-admin/groups`)
- **Group Directory**: Manage all groups in the tenant
- **Group Details**: Individual group management
- **Group Enrollment**: Manage group enrollment processes
- **Group Billing**: Handle group billing and payments
- **Group Documents**: Manage group-specific documents

### Member Management (`/tenant-admin/members`)
- **Member Directory**: View all members in the tenant
- **Member Details**: Individual member management
- **Enrollment Tracking**: Monitor member enrollments
- **Dependent Management**: Manage member dependents

### Onboarding Links (`/tenant-admin/onboarding-links`)
- **Link Management**: Create and manage agent onboarding links
- **Commission Codes**: Generate unique commission codes
- **Session Tracking**: Monitor onboarding sessions
- **Document Management**: Manage onboarding documents

### Settings (`/tenant-admin/settings`)
- **Organization Settings**: Basic tenant information
- **Branding**: Logo, colors, and custom styling
- **Custom Domain**: White-label domain configuration
- **Agent Onboarding**: Onboarding document management
- **Advanced Configuration**: Advanced tenant settings

### User Management (`/tenant-admin/users`)
- **User Directory**: Manage tenant users
- **Role Assignment**: Assign roles to users
- **User Creation**: Create new tenant users
- **Access Control**: Manage user permissions

---

## Agent Portal

### Dashboard (`/agent/dashboard`)
- **Agent Overview**: Personal metrics and statistics
- **Key Metrics**:
  - Active members
  - Commission earnings
  - Enrollment performance
  - Group management
- **Quick Actions**: Access to agent functions

### Member Management (`/agent/members`)
- **Member Directory**: View assigned members
- **Member Details**: Individual member management
- **Enrollment Management**: Process member enrollments
- **Dependent Management**: Manage member dependents

### Group Management (`/agent/groups`)
- **Group Directory**: View assigned groups
- **Group Details**: Individual group management
- **Group Enrollment**: Process group enrollments
- **Group Billing**: Handle group billing

### Product Management (`/agent/products`)
- **Available Products**: View products available for sale
- **Product Details**: Detailed product information
- **Pricing Information**: Commission and pricing details
- **Product Comparison**: Compare different products

### Sales Pipeline (`/agent/pipeline`)
- **Lead Management**: Track potential enrollments
- **Sales Activities**: Log sales activities
- **Follow-up Tracking**: Manage follow-up tasks
- **Performance Metrics**: Track sales performance

### Commissions (`/agent/commissions`)
- **Commission Statement**: View commission earnings
- **Commission History**: Historical commission data
- **Hierarchy View**: View upline/downline structure
- **Payment Tracking**: Monitor commission payments

### Activities (`/agent/activities`)
- **Activity Log**: Track all agent activities
- **Enrollment History**: Historical enrollment data
- **Member Interactions**: Log member interactions
- **Performance Tracking**: Monitor performance metrics

### Reports (`/agent/reports`)
- **Performance Reports**: Generate performance reports
- **Commission Reports**: Detailed commission reports
- **Enrollment Reports**: Enrollment statistics
- **Custom Reports**: Create custom reports

### Settings (`/agent/settings`)
- **Profile Management**: Update personal information
- **Banking Information**: Manage banking details
- **License Information**: Manage insurance licenses
- **Notification Preferences**: Configure notifications

---

## Group Admin Portal

### Dashboard (`/group-admin/dashboard`)
- **Group Overview**: Group-specific metrics and statistics
- **Key Metrics**:
  - Group members
  - Enrollment status
  - Billing information
  - Product coverage
- **Quick Actions**: Access to group functions

### Member Management (`/group-admin/members`)
- **Member Directory**: View all group members
- **Member Details**: Individual member management
- **Enrollment Management**: Process member enrollments
- **Dependent Management**: Manage member dependents

### Group Management (`/group-admin/groups`)
- **Group Details**: Manage group information
- **Group Settings**: Configure group settings
- **Billing Management**: Handle group billing
- **Document Management**: Manage group documents

### User Management (`/group-admin/users`)
- **User Directory**: Manage group users
- **Role Assignment**: Assign roles to users
- **Access Control**: Manage user permissions

---

## Member Portal

### Dashboard (`/member/dashboard`)
- **Member Overview**: Personal coverage and account information
- **Key Information**:
  - Current coverage
  - Premium information
  - Payment status
  - Upcoming renewals
- **Quick Actions**: Access to member functions

### Plans & ID Cards (`/member/plans-id-cards`)
- **Coverage Details**: View current coverage information
- **ID Card Management**: Access and download ID cards
- **Plan Information**: Detailed plan information
- **Coverage History**: Historical coverage data

### Payments (`/member/payments`)
- **Payment History**: View payment history
- **Payment Methods**: Manage payment methods
- **Billing Information**: View billing details
- **Payment Processing**: Process payments

### Product Changes (`/member/product-change`)
- **Available Products**: Browse available products
- **Product Comparison**: Compare different products
- **Change Requests**: Submit product change requests
- **Change History**: Track product changes

### Dependents (`/member/dependents`)
- **Dependent Management**: Add, edit, and remove dependents
- **Dependent Coverage**: Manage dependent coverage
- **Dependent Documents**: Manage dependent documents
- **Dependent Billing**: Handle dependent billing

### Documents (`/member/documents`)
- **Document Library**: Access all member documents
- **Document Categories**: Organize documents by category
- **Document Sharing**: Share documents with others
- **Document History**: Track document access

### Settings (`/member/settings`)
- **Profile Management**: Update personal information
- **Contact Information**: Manage contact details
- **Notification Preferences**: Configure notifications
- **Account Security**: Manage account security

---

## Database Schema

### Core Tables

#### Users & Authentication
- **`oe.Users`**: User accounts and authentication
- **`oe.Tenants`**: Tenant information and settings
- **`oe.Agents`**: Agent-specific information
- **`oe.Members`**: Member information

#### Products & Marketplace
- **`oe.Products`**: Insurance product definitions
- **`oe.ProductBundles`**: Product bundle collections
- **`oe.Vendors`**: Insurance carriers and vendors
- **`oe.ProductPricing`**: Product pricing tiers

#### Commissions & Hierarchy
- **`oe.CommissionRules`**: Commission rule definitions
- **`oe.AgentHierarchy`**: Agent upline/downline relationships
- **`oe.CommissionPayments`**: Commission payment tracking

#### Groups & Enrollments
- **`oe.Groups`**: Group definitions
- **`oe.GroupMembers`**: Group membership
- **`oe.Enrollments`**: Member enrollments
- **`oe.EnrollmentLinks`**: Enrollment link management

#### Onboarding
- **`oe.AgentOnboardingLinks`**: Agent onboarding links
- **`oe.OnboardingSessions`**: Onboarding session tracking
- **`oe.AgentBankInfo`**: Agent banking information
- **`oe.AgentLicenses`**: Agent license information

#### File Management
- **`oe.FileUploads`**: File upload tracking
- **`oe.DocumentCategories`**: Document categorization
- **`oe.DocumentAccess`**: Document access control

### Key Relationships
- Users belong to Tenants
- Agents belong to Tenants and have hierarchy relationships
- Members belong to Groups
- Products can be owned by Tenants or be global
- Commissions flow through hierarchy relationships
- Groups can have multiple Members
- Enrollments link Members to Products

---

## API Structure

### Authentication Endpoints
- **`POST /api/auth/login`**: User authentication
- **`POST /api/auth/logout`**: User logout
- **`POST /api/auth/refresh`**: Token refresh
- **`GET /api/auth/me`**: Get current user info

### Product Management
- **`GET /api/products`**: List products
- **`POST /api/products`**: Create product
- **`PUT /api/products/:id`**: Update product
- **`DELETE /api/products/:id`**: Delete product

### Agent Management
- **`GET /api/agents`**: List agents
- **`POST /api/agents`**: Create agent
- **`PUT /api/agents/:id`**: Update agent
- **`GET /api/agents/:id/downline`**: Get agent downline
- **`GET /api/agents/:id/upline`**: Get agent upline

### Commission Management
- **`GET /api/commissions/rules`**: List commission rules
- **`POST /api/commissions/rules`**: Create commission rule
- **`PUT /api/commissions/rules/:id`**: Update commission rule
- **`POST /api/commissions/simulate`**: Simulate commission calculation

### Group Management
- **`GET /api/groups`**: List groups
- **`POST /api/groups`**: Create group
- **`PUT /api/groups/:id`**: Update group
- **`GET /api/groups/:id/members`**: Get group members

### Member Management
- **`GET /api/members`**: List members
- **`POST /api/members`**: Create member
- **`PUT /api/members/:id`**: Update member
- **`GET /api/members/:id/enrollments`**: Get member enrollments

### Onboarding
- **`POST /api/public/onboarding/validate-code`**: Validate commission code
- **`POST /api/public/onboarding/start-session`**: Start onboarding session
- **`POST /api/public/onboarding/save-progress`**: Save onboarding progress
- **`POST /api/public/onboarding/complete`**: Complete onboarding

### File Management
- **`POST /api/uploads`**: Upload files
- **`GET /api/uploads/:id`**: Get file information
- **`DELETE /api/uploads/:id`**: Delete file

---

## Key Features

### Multi-Tenant Architecture
- **Tenant Isolation**: Complete data separation between tenants
- **Custom Branding**: Logo, colors, and styling per tenant
- **Custom Domains**: White-label domain support
- **Tenant-Specific Settings**: Configurable settings per tenant

### Product Management
- **Product Lifecycle**: Complete product management from creation to retirement
- **Product Bundles**: Group related products together
- **Pricing Tiers**: Complex pricing structures with age bands
- **Media Management**: Product images, logos, and documents
- **Configuration Fields**: Customizable product configuration

### Agent Onboarding
- **Commission Codes**: Unique codes for agent recruitment
- **Session Management**: Track onboarding progress
- **Document Management**: Required documents and contracts
- **Hierarchy Integration**: Automatic hierarchy setup
- **Banking Integration**: Secure banking information collection

### Commission System
- **Hierarchical Structure**: Multi-level commission hierarchy
- **Rule Templates**: Pre-built commission rule templates
- **Percentage & Flat Rate**: Support for both commission types
- **Renewal Tracking**: Automatic renewal commission processing
- **Override Management**: Custom commission overrides

### Group Management
- **Group Enrollment**: Streamlined group enrollment process
- **Member Management**: Comprehensive member management
- **Billing Integration**: Group billing and payment processing
- **Document Management**: Group-specific document handling
- **ASA Integration**: Agent Service Agreement management

### Message Center
- **Template Management**: Email and SMS templates
- **Scheduled Messages**: Automated message campaigns
- **Message Queue**: Reliable message processing
- **Analytics**: Message performance tracking
- **Multi-Channel**: Email, SMS, and push notifications

### White-Labeling
- **Custom Domains**: Tenant-specific domain names
- **DNS Management**: Automated DNS configuration
- **SSL Certificates**: Automatic SSL certificate management
- **Branding**: Complete visual customization
- **Custom URLs**: Tenant-specific URL structures

---

## Integration Points

### External Services
- **OAuth 2.0**: Authentication service integration
- **SendGrid**: Email service integration
- **Azure Blob Storage**: File storage integration
- **Azure Front Door**: CDN and domain management
- **SQL Server**: Database integration

### Internal Integrations
- **Commission Engine**: Integrated commission calculations
- **File Management**: Centralized file handling
- **Message Queue**: Asynchronous message processing
- **Audit Logging**: Comprehensive audit trail
- **Error Handling**: Centralized error management

### API Integrations
- **RESTful APIs**: Standard REST API endpoints
- **Webhook Support**: Event-driven integrations
- **Rate Limiting**: API rate limiting and throttling
- **Authentication**: JWT-based authentication
- **Versioning**: API version management

---

## Detailed Workflows & Processes

### Member Plan Change Process

#### 1. Member Initiates Plan Change
**Location**: `/member/product-change`
**Process**:
1. Member navigates to "Product Change" in member portal
2. System displays current coverage and available alternatives
3. Member can compare different products side-by-side
4. Member selects new product and initiates change request

#### 2. Product Comparison Interface
**Features**:
- **Side-by-side comparison**: Premiums, benefits, coverage details
- **Filtering options**: By product type, premium range, benefits
- **Detailed product information**: Full benefit summaries and exclusions
- **Eligibility checking**: Automatic eligibility verification
- **Effective date selection**: Choose when change takes effect

#### 3. Change Request Submission
**Data Collected**:
- Current product information
- Selected new product
- Requested effective date
- Reason for change (optional)
- Additional information if required

#### 4. Agent/Admin Review Process
**Agent Portal** (`/agent/members/:id/product-changes`):
- Agent receives notification of change request
- Agent can review and approve/deny request
- Agent can request additional information
- Agent can schedule follow-up call

**Tenant Admin Portal** (`/tenant-admin/members/:id/product-changes`):
- Admin can review all change requests
- Bulk approval/denial capabilities
- Override agent decisions if needed
- Generate reports on change requests

#### 5. Change Processing
**Backend Process**:
1. Validate eligibility for new product
2. Check for any waiting periods
3. Calculate prorated premiums
4. Update member enrollment record
5. Generate new ID cards
6. Send confirmation notifications

#### 6. Post-Change Actions
**Automatic Processes**:
- Update member dashboard with new coverage
- Generate new ID cards
- Send confirmation emails
- Update billing system
- Notify relevant parties (agent, group admin)

---

### Commission Rule Setup Process

#### 1. Access Commission Rules
**System Admin**: `/admin/commissions`
**Tenant Admin**: `/tenant-admin/commissions`

#### 2. Rule Creation Wizard
**Step 1: Rule Type Selection**
- **Agent Rule**: Commission for specific agent
- **Agency Rule**: Commission for agency/organization
- **Tier Rule**: Multi-level hierarchy commission
- **Product Rule**: Commission for specific product
- **Global Rule**: System-wide commission rule

**Step 2: Entity Configuration**
- **Agent Selection**: Choose specific agent (if Agent Rule)
- **Agency Selection**: Choose specific agency (if Agency Rule)
- **Tier Configuration**: Set up hierarchy levels (if Tier Rule)
- **Product Selection**: Choose specific product (if Product Rule)

**Step 3: Commission Structure**
- **Percentage Commission**: Set percentage rate (e.g., 5%)
- **Flat Rate Commission**: Set fixed dollar amount
- **Tiered Commission**: Configure multi-level rates
- **Hybrid Commission**: Combination of percentage and flat rate

**Step 4: Payment Configuration**
- **Payment Timing**: Initial, Renewal, or Both
- **Renewal Schedule**: Year-over-year renewal rates
- **Payment Frequency**: Monthly, Quarterly, Annually
- **Minimum/Maximum Thresholds**: Set premium limits

**Step 5: Advanced Settings**
- **Priority Level**: Rule precedence (1-100)
- **Effective Dates**: Start and end dates
- **Premium Thresholds**: Minimum/maximum premium requirements
- **Stacking Rules**: Whether rules can combine
- **Override Capabilities**: Allow manual overrides

#### 3. Rule Templates
**Pre-built Templates**:
- **Medicare Advantage Standard**: 5% agent, 2% GA, 1% MGA
- **Medicare Supplement**: 10% agent, 1.5% GA, 0.75% MGA
- **Ancillary Products**: $50 agent, $10 GA, $5 MGA
- **Volume Bonus**: Tiered bonuses based on enrollment count
- **Renewal Structure**: Decreasing renewal rates

#### 4. Rule Validation
**System Checks**:
- Duplicate rule detection
- Hierarchy validation
- Date range validation
- Premium threshold validation
- Priority conflict resolution

#### 5. Rule Testing
**Simulation Engine**:
- Test commission calculations
- Preview hierarchy payouts
- Validate renewal schedules
- Check for conflicts with existing rules

#### 6. Rule Activation
**Deployment Process**:
1. Save rule configuration
2. Run validation checks
3. Test with sample data
4. Activate rule
5. Notify affected parties
6. Monitor for issues

---

### White-Label Domain Configuration

#### 1. Access Domain Settings
**Location**: `/tenant-admin/settings` → "Custom Domain" tab
**Prerequisites**: Tenant must have valid subscription

#### 2. Domain Configuration Process

**Step 1: Domain Input**
- Enter desired custom domain (e.g., `portal.agency.com`)
- System validates domain format
- Check domain availability
- Verify domain ownership

**Step 2: DNS Configuration**
**Azure Front Door Integration**:
- System generates CNAME record
- Provides DNS instructions
- Creates Azure Front Door endpoint
- Configures SSL certificate

**DNS Records Required**:
```
Type: CNAME
Name: portal (or subdomain)
Value: [Azure Front Door endpoint]
TTL: 300 seconds
```

**Step 3: Domain Verification**
- **TXT Record Verification**: Verify domain ownership
- **CNAME Validation**: Confirm DNS propagation
- **SSL Certificate**: Automatic SSL certificate generation
- **Health Check**: Verify domain accessibility

**Step 4: Azure Front Door Setup**
**Backend Process**:
1. Create Azure Front Door profile
2. Configure custom domain
3. Set up SSL certificate
4. Configure routing rules
5. Associate domain with endpoint
6. Test domain functionality

**Step 5: Domain Association**
**API Endpoints**:
- `POST /api/custom-domains/configure`: Create domain configuration
- `POST /api/custom-domains/verify`: Verify domain setup
- `GET /api/custom-domains/status`: Check domain status
- `DELETE /api/custom-domains`: Remove domain configuration

#### 3. Domain Management Features

**Status Monitoring**:
- **Domain Status**: Active, Pending, Failed, Expired
- **SSL Status**: Valid, Pending, Expired, Invalid
- **DNS Status**: Configured, Pending, Failed
- **Health Check**: Online, Offline, Degraded

**Configuration Options**:
- **Custom Logo**: Upload tenant-specific logo
- **Custom Colors**: Set primary and secondary colors
- **Custom CSS**: Advanced styling options
- **Favicon**: Custom favicon for domain

#### 4. Troubleshooting Common Issues

**DNS Propagation Issues**:
- Check DNS record configuration
- Verify TTL settings
- Wait for propagation (up to 48 hours)
- Use DNS propagation checker tools

**SSL Certificate Issues**:
- Verify domain ownership
- Check CNAME record configuration
- Ensure domain is accessible
- Contact support for manual certificate

**Azure Front Door Issues**:
- Check endpoint configuration
- Verify routing rules
- Test domain accessibility
- Review Azure Front Door logs

---

### Agent Onboarding Process

#### 1. Onboarding Link Creation
**Tenant Admin Process** (`/tenant-admin/onboarding-links`):

**Step 1: Create Onboarding Link**
- **Link Name**: Descriptive name for the link
- **Commission Code**: Unique code for tracking
- **Commission Rule**: Select applicable commission rule
- **Redirect URL**: Post-onboarding redirect destination
- **Custom Fields**: Additional data collection fields

**Step 2: Document Management**
- **Contract Documents**: Upload required contracts
- **Training Materials**: Add training documents
- **Compliance Forms**: Include compliance requirements
- **Branding Materials**: Add agency-specific materials

**Step 3: Link Configuration**
- **Expiration Settings**: Set link expiration (optional)
- **Usage Limits**: Maximum number of uses
- **Geographic Restrictions**: Limit by location
- **Custom Styling**: Agency-specific branding

#### 2. Public Onboarding Flow
**Agent Access**: `https://domain.com/agent-onboarding/{linkToken}`

**Step 1: Code Validation**
- Agent enters commission code
- System validates code and returns link details
- Display agency information and requirements
- Show required documents and information

**Step 2: Session Creation**
- Create secure onboarding session
- Generate session token
- Set session expiration (24 hours)
- Initialize progress tracking

**Step 3: Information Collection**
**Personal Information**:
- First name, last name, email, phone
- Address information (street, city, state, zip)
- Date of birth, SSN (encrypted)
- Emergency contact information

**Professional Information**:
- Insurance license number (NPN)
- License state and expiration
- Professional experience
- Referral source information

**Banking Information**:
- Bank name and routing number
- Account number (encrypted)
- Account type (checking/savings)
- Tax ID information (EIN/SSN)

**Step 4: Document Upload**
- **License Documents**: Upload insurance licenses
- **Tax Documents**: W-9 or W-8 forms
- **Banking Documents**: Voided check or bank statement
- **Contract Documents**: Sign required contracts
- **Digital Signature**: Capture electronic signature

**Step 5: Agreement Signing**
- **Contract Review**: Display all contract terms
- **Digital Signature**: Capture electronic signature
- **Signature Date**: Record signing date/time
- **IP Address**: Log signature location
- **User Agent**: Record browser information

**Step 6: Onboarding Completion**
**Backend Processing**:
1. Validate all required information
2. Create user account
3. Create agent record
4. Set up hierarchy relationships
5. Configure commission rules
6. Send welcome email
7. Redirect to success page

#### 3. Session Management
**Session Tracking**:
- **Session Status**: Pending, InProgress, Completed, Failed, Expired
- **Progress Tracking**: Current step and completion percentage
- **Data Persistence**: Save progress at each step
- **Session Recovery**: Resume incomplete sessions

**Security Features**:
- **Session Tokens**: Cryptographically secure tokens
- **Session Expiration**: 24-hour automatic expiration
- **IP Tracking**: Log IP addresses for security
- **Rate Limiting**: Prevent abuse and spam

---

### Group Enrollment Process

#### 1. Group Creation
**Tenant Admin Process** (`/tenant-admin/groups`):

**Step 1: Group Information**
- **Group Name**: Company or organization name
- **Group Type**: Corporate, Association, Union, etc.
- **Contact Information**: Primary contact details
- **Billing Information**: Payment and billing setup
- **Effective Date**: When coverage begins

**Step 2: Product Selection**
- **Available Products**: Browse marketplace products
- **Product Comparison**: Compare different options
- **Pricing Information**: Review pricing tiers
- **Coverage Details**: Understand benefits and limitations

**Step 3: Group Configuration**
- **Enrollment Period**: Open enrollment dates
- **Eligibility Rules**: Who can enroll
- **Contribution Structure**: Employer/employee contributions
- **Waiting Periods**: Any applicable waiting periods

#### 2. Group Onboarding
**Group Admin Access**: `https://domain.com/group-onboarding/{linkToken}`

**Step 1: Group Information Collection**
- **Company Details**: Legal name, address, tax ID
- **Contact Information**: Primary and secondary contacts
- **Billing Information**: Payment methods and billing cycles
- **Employee Information**: Number of employees, locations

**Step 2: Product Configuration**
- **Product Selection**: Choose products for the group
- **Pricing Tiers**: Set up age-based pricing
- **Contribution Levels**: Define contribution amounts
- **Coverage Options**: Select coverage levels

**Step 3: Enrollment Setup**
- **Enrollment Period**: Set open enrollment dates
- **Eligibility Rules**: Define eligibility criteria
- **Communication Plan**: Set up member communications
- **Training Materials**: Provide enrollment training

#### 3. Member Enrollment
**Member Access**: `https://domain.com/enroll/{enrollmentToken}`

**Step 1: Eligibility Verification**
- **Personal Information**: Name, DOB, SSN
- **Employment Verification**: Confirm employment status
- **Dependent Information**: Spouse and children details
- **Eligibility Check**: Verify eligibility requirements

**Step 2: Product Selection**
- **Available Products**: View eligible products
- **Product Comparison**: Compare different options
- **Pricing Information**: See contribution amounts
- **Coverage Selection**: Choose coverage levels

**Step 3: Enrollment Completion**
- **Personal Information**: Complete personal details
- **Dependent Information**: Add spouse and children
- **Beneficiary Information**: Designate beneficiaries
- **Payment Information**: Set up payment methods
- **Document Review**: Review all enrollment documents

**Step 4: Confirmation**
- **Enrollment Summary**: Review all selections
- **Payment Confirmation**: Confirm payment setup
- **Effective Date**: Confirm coverage start date
- **Next Steps**: Information about next steps

---

### Product Creation Workflow

#### 1. Product Wizard Overview
**Access**: System Admin (`/admin/marketplace`) or Tenant Admin (`/tenant-admin/products`)
**Process**: 11-step comprehensive product creation wizard

#### 2. Step-by-Step Process

**Step 1: Vendor Selection**
- **Vendor Search**: Browse available vendors
- **Vendor Details**: Review vendor information
- **Product Categories**: Select product categories
- **Vendor Agreement**: Review vendor terms

**Step 2: Basic Details**
- **Product Name**: Descriptive product name
- **Product Description**: Detailed product description
- **Product Type**: Medicare Advantage, Supplement, Ancillary, etc.
- **Sales Type**: Individual, Group, or Both
- **Age Requirements**: Minimum and maximum age limits
- **State Restrictions**: Allowed states for sale

**Step 3: Configuration Fields**
- **Custom Fields**: Add product-specific fields
- **Field Types**: Text, Number, Date, Dropdown, Checkbox
- **Required Fields**: Mark fields as required
- **Validation Rules**: Set field validation
- **Field Ordering**: Arrange field display order

**Step 4: Pricing Configuration**
- **Pricing Tiers**: Set up age-based pricing
- **Commission Structure**: Define commission rates
- **Renewal Pricing**: Set renewal rate schedules
- **Premium Thresholds**: Set minimum/maximum premiums
- **Pricing Rules**: Define pricing logic

**Step 5: Acknowledgement Questions**
- **Question Types**: Yes/No, Multiple Choice, Text
- **Required Questions**: Mark questions as required
- **Question Ordering**: Arrange question sequence
- **Conditional Logic**: Show/hide questions based on answers
- **Legal Requirements**: Include required legal questions

**Step 6: Media & Documents**
- **Product Images**: Upload product images
- **Product Logo**: Upload product logo
- **Product Documents**: Upload product documents (PDFs)
- **Document Metadata**: Set document properties
- **File Management**: Organize uploaded files

**Step 7: ID Card Design**
- **Card Layout**: Design front and back of ID cards
- **Logo Placement**: Position logos and branding
- **Information Fields**: Add member information fields
- **QR Codes**: Include QR codes for digital access
- **Print Specifications**: Set print requirements

**Step 8: Plan Details**
- **Plan Information**: Detailed plan information
- **Coverage Details**: Benefits and coverage information
- **Network Information**: Provider network details
- **Formulary Information**: Prescription drug coverage
- **Additional Benefits**: Extra benefits and services

**Step 9: AI Chunks**
- **AI Training Data**: Prepare data for AI training
- **Question Patterns**: Common questions and answers
- **Response Templates**: Standard response templates
- **Knowledge Base**: Build product knowledge base
- **AI Integration**: Connect to AI services

**Step 10: ASA Requirements**
- **Agent Service Agreement**: Define ASA requirements
- **Required Documents**: Specify required documents
- **Signature Requirements**: Digital signature setup
- **Compliance Rules**: Set compliance requirements
- **Training Requirements**: Define training needs

**Step 11: Review & Publish**
- **Product Summary**: Review all product information
- **Validation Check**: Verify all required fields
- **Preview Mode**: Test product display
- **Publish Settings**: Set publication options
- **Go Live**: Activate product for enrollment

---

### Commission Calculation Process

#### 1. Commission Trigger Events
**Enrollment Events**:
- New member enrollment
- Product change
- Renewal enrollment
- Dependent addition
- Coverage modification

#### 2. Commission Calculation Engine
**Step 1: Rule Retrieval**
- Get applicable commission rules
- Filter by product, agent, and hierarchy
- Sort by priority and effective dates
- Validate rule conditions

**Step 2: Hierarchy Processing**
- Determine agent hierarchy levels
- Calculate upline relationships
- Apply hierarchy-based rates
- Process override percentages

**Step 3: Commission Calculation**
**Percentage Calculations**:
```
Base Commission = Premium × Commission Rate
Hierarchy Commission = Base Commission × Hierarchy Rate
Override Commission = Base Commission × Override Rate
Total Commission = Base + Hierarchy + Override
```

**Flat Rate Calculations**:
```
Base Commission = Flat Rate Amount
Hierarchy Commission = Flat Rate × Hierarchy Multiplier
Total Commission = Base + Hierarchy
```

**Step 4: Renewal Processing**
- Apply renewal rate schedules
- Calculate year-over-year rates
- Process renewal commissions
- Track renewal history

#### 3. Commission Payment Process
**Payment Generation**:
- Calculate commission amounts
- Generate payment records
- Apply payment timing rules
- Process payment schedules

**Payment Distribution**:
- Agent payments
- Hierarchy payments
- Override payments
- Bonus payments

---

### Message Center Workflow

#### 1. Message Template Creation
**Access**: `/admin/message-center/templates` or `/tenant-admin/message-center/templates`

**Step 1: Template Setup**
- **Template Name**: Descriptive template name
- **Message Type**: Email, SMS, Push notification
- **Category**: Enrollment, Commission, System, etc.
- **Language**: Template language
- **Tenant Scope**: Global or tenant-specific

**Step 2: Content Creation**
- **Subject Line**: Email subject or SMS header
- **Message Body**: Main message content
- **Variables**: Dynamic content placeholders
- **Formatting**: HTML formatting for emails
- **Attachments**: Include file attachments

**Step 3: Template Testing**
- **Preview Mode**: Test template appearance
- **Variable Testing**: Test dynamic content
- **Send Test**: Send test message
- **Device Testing**: Test on different devices
- **Browser Testing**: Test email clients

#### 2. Message Scheduling
**Scheduled Messages** (`/admin/message-center/scheduled`):

**Step 1: Message Configuration**
- **Recipient Selection**: Choose target audience
- **Message Template**: Select template
- **Scheduling**: Set send date and time
- **Frequency**: One-time or recurring
- **Conditions**: Trigger conditions

**Step 2: Audience Targeting**
- **Role-based**: Target by user role
- **Tenant-based**: Target by tenant
- **Group-based**: Target by group
- **Custom Criteria**: Custom targeting rules
- **Exclusion Rules**: Exclude specific users

**Step 3: Message Delivery**
- **Queue Processing**: Add to message queue
- **Rate Limiting**: Control send rate
- **Delivery Tracking**: Track delivery status
- **Error Handling**: Handle delivery failures
- **Retry Logic**: Retry failed deliveries

#### 3. Message Analytics
**Analytics Dashboard** (`/admin/message-center/analytics`):

**Key Metrics**:
- **Delivery Rate**: Percentage of successful deliveries
- **Open Rate**: Email open rates
- **Click Rate**: Link click rates
- **Response Rate**: User response rates
- **Error Rate**: Delivery failure rates

**Reporting Features**:
- **Time-based Reports**: Daily, weekly, monthly
- **Audience Reports**: Performance by audience
- **Template Reports**: Performance by template
- **Trend Analysis**: Performance trends
- **Export Options**: Export data for analysis

---

### File Management System

#### 1. File Upload Process
**Upload Endpoints**:
- `POST /api/uploads`: General file upload
- `POST /api/uploads/product`: Product-specific uploads
- `POST /api/uploads/agent`: Agent document uploads
- `POST /api/uploads/group`: Group document uploads

**Step 1: File Selection**
- **File Types**: PDF, DOC, DOCX, JPG, PNG, etc.
- **Size Limits**: Maximum file size restrictions
- **Security Scanning**: Virus and malware scanning
- **Content Validation**: File content verification

**Step 2: File Processing**
- **Metadata Extraction**: Extract file properties
- **Thumbnail Generation**: Create image thumbnails
- **Text Extraction**: Extract text from documents
- **OCR Processing**: Optical character recognition

**Step 3: Storage Management**
- **Azure Blob Storage**: Store files in Azure
- **Container Organization**: Organize by file type
- **Access Control**: Set file permissions
- **Backup Strategy**: Implement backup procedures

#### 2. File Access Control
**Permission Levels**:
- **Public Access**: Available to all users
- **Tenant Access**: Available to tenant users
- **Role-based Access**: Available by user role
- **Private Access**: Available to specific users
- **Time-based Access**: Access with expiration

**Security Features**:
- **Encryption**: Encrypt sensitive files
- **Access Logging**: Log file access
- **Download Limits**: Limit download frequency
- **Watermarking**: Add watermarks to documents
- **Expiration**: Set file expiration dates

---

### Audit and Compliance

#### 1. Audit Logging
**System Events**:
- **User Actions**: Login, logout, profile changes
- **Data Changes**: Create, update, delete operations
- **File Access**: Document access and downloads
- **System Changes**: Configuration changes
- **Security Events**: Failed logins, permission changes

**Audit Trail Features**:
- **Comprehensive Logging**: Log all system activities
- **User Attribution**: Track who performed actions
- **Timestamp Recording**: Record exact timestamps
- **IP Address Tracking**: Log IP addresses
- **Change History**: Track data changes over time

#### 2. Compliance Reporting
**Report Types**:
- **User Activity Reports**: User action summaries
- **Data Change Reports**: Data modification reports
- **Access Reports**: File and data access reports
- **Security Reports**: Security event reports
- **Compliance Reports**: Regulatory compliance reports

**Export Options**:
- **PDF Reports**: Generate PDF reports
- **Excel Export**: Export to Excel format
- **CSV Export**: Export to CSV format
- **API Access**: Programmatic report access
- **Scheduled Reports**: Automated report generation

---

This comprehensive system provides a complete insurance enrollment and management platform with multi-tenant architecture, sophisticated commission management, and extensive customization capabilities. The system is designed to scale and adapt to various insurance industry needs while maintaining security, performance, and user experience standards.
