# Agent Onboarding Links System - Requirements

## 📋 Overview

The Agent Onboarding Links system enables Tenants and Agencies to create secure, code-based onboarding links that automatically assign commission rates to new agents during the registration process. This system excludes Tier Level (FMO/MMO) hierarchies and focuses on simple flat rate or percentage-based commission structures.

## 🎯 Business Requirements

### Primary Goals
1. **Streamlined Agent Onboarding**: Allow Tenants/Agencies to onboard agents through branded links
2. **Automatic Commission Assignment**: Assign commission rates based on simple codes (e.g., "Apple", "Orange", "Peach")
3. **Secure Access Control**: Ensure only authorized entities can create and manage onboarding links
4. **Commission Rate Flexibility**: Support both flat rate and percentage-based commission structures
5. **Audit Trail**: Track all onboarding activities and commission assignments

### Exclusions
- **Tier Level Hierarchies**: FMO/MMO tier-based commission structures are not supported
- **Complex Commission Rules**: Only simple flat rate or percentage rules are supported
- **Multi-level Commission Calculations**: No hierarchical commission calculations

## 🏗️ System Architecture

### Database Schema

#### Onboarding Links Table
```sql
oe.AgentOnboardingLinks:
- LinkId (UUID) - Primary key
- TenantId (UUID) - Tenant who created the link (required)
- AgencyId (UUID) - Agency who created the link (nullable)
- AgentId (UUID) - Agent who created the link (nullable)
- LinkName (NVARCHAR) - Human-readable name for the link
- CommissionCode (NVARCHAR) - Unique code (e.g., "Apple", "Orange", "Peach")
- CommissionRuleId (UUID) - Reference to existing commission rule
- IsActive (BIT) - Whether the link is currently active
- CurrentUses (INT) - Current number of agents who have used this code
- CreatedBy (UUID) - User who created the link
- CreatedDate (DATETIME) - When the link was created
- ModifiedDate (DATETIME) - Last modification date
- RedirectUrl (NVARCHAR) - URL to redirect to after successful onboarding
- ContractDocumentId (UUID) - Reference to contract document for this link
- CustomFields (NVARCHAR) - JSON for additional custom data
```

#### Onboarding Sessions Table
```sql
oe.AgentOnboardingSessions:
- SessionId (UUID) - Primary key
- LinkId (UUID) - Reference to onboarding link
- SessionToken (NVARCHAR) - Unique session identifier
- AgentData (NVARCHAR) - JSON containing agent information
- CommissionRuleId (UUID) - Reference to created commission rule
- Status (NVARCHAR) - 'Pending', 'Completed', 'Expired', 'Failed'
- StartedDate (DATETIME) - When onboarding session started
- CompletedDate (DATETIME) - When onboarding was completed
- ExpiresDate (DATETIME) - When session expires
- IPAddress (NVARCHAR) - IP address of the user
- UserAgent (NVARCHAR) - Browser user agent
```

## 🔐 Security Requirements

### Access Control
1. **Tenant Isolation**: Tenants can only create/manage their own onboarding links
2. **Agency Scope**: Agencies can create links for their assigned Tenants
3. **Code Uniqueness**: Commission codes must be unique within a Tenant/Agency scope
4. **Session Security**: Onboarding sessions must be time-limited and token-based

### Data Protection
1. **Encrypted Storage**: Sensitive agent data must be encrypted at rest
2. **Secure Transmission**: All onboarding data must be transmitted over HTTPS
3. **Session Expiration**: Onboarding sessions expire after configurable time period
4. **Rate Limiting**: Prevent abuse through rate limiting on link access

## 📊 Functional Requirements

### 1. Link Creation and Management

#### For Tenants
- **Create Onboarding Links**: Generate branded onboarding URLs with custom codes
- **Set Commission Parameters**: Define flat rate or percentage commission values
- **Manage Link Settings**: Set expiration dates, usage limits, redirect URLs
- **Monitor Usage**: Track how many agents have used each code
- **Deactivate Links**: Disable links when no longer needed

#### For Agencies
- **Multi-Tenant Links**: Create links that work across multiple assigned Tenants
- **Bulk Link Creation**: Generate multiple links with different codes
- **Template System**: Save common link configurations as templates

### 2. Agent Onboarding Process

#### Public Onboarding Flow
1. **Access Link**: Agent visits the onboarding URL
2. **Code Entry**: Agent enters the commission code (e.g., "Apple")
3. **Code Validation**: System validates the code and retrieves commission rule
4. **Section 1 - Personal & Professional Information**:
   - Agent Name (First, Middle Initial, Last)
   - Company Name (Agency, if agency is not the owner of the link)
   - Contact Information (Email, Phone Number)
   - Address (Address, Address 2, City, State, Zip)
   - Tax ID Type (EIN or Social Security)
   - Tax ID or Social Security Number
   - NPN (National Producer Number)
   - Who Referred You?
5. **Section 2 - Banking Information**:
   - Bank Name
   - Business or Individual account type
   - Account Type (Savings or Checking)
   - Routing Number
   - Account Number
6. **Section 3 - Contract & Signature**:
   - Review Agent Contract (provided by Tenant/Agency)
   - Capture digital signature and date signed
   - Store signed contract securely
7. **Account Creation**: Agent account is created and activated
8. **Commission Assignment**: Agent is automatically assigned to the commission rule
9. **Confirmation**: Agent receives confirmation and access credentials

#### Session Management
- **Session Token**: Each onboarding session gets a unique token
- **Progress Saving**: Save partial progress to allow completion later
- **Session Expiration**: Sessions expire after 24 hours of inactivity
- **Resume Capability**: Allow agents to resume incomplete onboarding

### 3. Commission Rule Integration

#### Commission Rule Assignment
- **Existing Rule Reference**: Codes reference existing commission rules in the system
- **Tenant-Specific Rules**: All rules are tenant-specific and not available globally
- **One-to-One Mapping**: Each code maps to exactly one commission rule
- **Automatic Assignment**: Agents are automatically assigned to the commission rule based on their code
- **Commission Distribution**: 100% of commission must be distributed (e.g., if code = 50% to agent, remaining 50% goes to product-based commission following tier hierarchy, agency, or tenant)

#### Commission Types
- **Flat Rate**: Fixed dollar amount per enrollment (e.g., $50)
- **Percentage**: Percentage of premium (e.g., 5% of premium)
- **Validation**: Ensure commission values are within acceptable ranges
- **Distribution Validation**: Ensure total commission distribution equals 100%

## 🎨 User Interface Requirements

### 1. Tenant/Agency Dashboard

#### Link Management Interface
- **Link List**: Display all created onboarding links with status
- **Usage Statistics**: Show usage counts and success rates
- **Quick Actions**: Create new links, duplicate existing links, deactivate links
- **Search and Filter**: Find links by code, status, or creation date

#### Link Creation Wizard
- **Step 1**: Basic Information (Link name, description)
- **Step 2**: Commission Settings (Type, value, validation)
- **Step 3**: Usage Limits (Max uses, expiration date)
- **Step 4**: Customization (Redirect URL, custom fields)
- **Step 5**: Review and Generate (Preview link, generate URL)

### 2. Public Onboarding Interface

#### Mobile-Responsive Design
- **Progressive Steps**: Multi-step form with progress indicator
- **Field Validation**: Real-time validation with helpful error messages
- **File Upload**: Drag-and-drop file upload for documents
- **Save and Resume**: Option to save progress and return later

#### Branding Options
- **Custom Styling**: Allow Tenants/Agencies to customize colors and logos
- **White-label URLs**: Use custom domains for branded experience
- **Custom Fields**: Add tenant-specific fields to the onboarding form

## 🔄 API Requirements

### 1. Link Management APIs

#### Create Onboarding Link
```
POST /api/tenant-admin/onboarding-links

Body:
{
  "linkName": "Q1 2024 Agent Recruitment",
  "commissionCode": "Apple",
  "commissionRuleId": "uuid-of-existing-commission-rule",
  "agencyId": "uuid-of-agency", // optional
  "agentId": "uuid-of-agent", // optional
  "redirectUrl": "https://agency.com/welcome",
  "contractDocumentId": "uuid-of-contract-document",
  "customFields": {
    "department": "Sales",
    "region": "West Coast"
  }
}
```

#### List Onboarding Links
```
GET /api/tenant-admin/onboarding-links

Response:
{
  "success": true,
  "links": [
    {
      "linkId": "uuid",
      "linkName": "Q1 2024 Agent Recruitment",
      "commissionCode": "Apple",
      "commissionRuleId": "uuid-of-commission-rule",
      "commissionRuleName": "Standard Agent Commission",
      "agencyId": "uuid-of-agency",
      "agencyName": "ABC Insurance Agency",
      "isActive": true,
      "currentUses": 23,
      "createdDate": "2024-01-01T00:00:00Z",
      "onboardingUrl": "https://app.openenroll.com/onboard/abc123"
    }
  ]
}
```

### 2. Public Onboarding APIs

#### Validate Commission Code
```
POST /api/public/onboarding/validate-code

Body:
{
  "commissionCode": "Apple"
}

Response:
{
  "success": true,
  "valid": true,
  "linkInfo": {
    "linkName": "Q1 2024 Agent Recruitment",
    "commissionRuleId": "uuid-of-commission-rule",
    "commissionRuleName": "Standard Agent Commission",
    "commissionType": "Percentage",
    "commissionValue": 0.05,
    "tenantName": "ABC Insurance Agency",
    "contractDocumentUrl": "https://app.openenroll.com/documents/contract.pdf"
  }
}
```

#### Start Onboarding Session
```
POST /api/public/onboarding/start-session

Body:
{
  "commissionCode": "Apple"
}

Response:
{
  "success": true,
  "sessionToken": "session_token_here",
  "sessionExpires": "2024-01-02T00:00:00Z"
}
```

#### Submit Agent Information
```
POST /api/public/onboarding/submit-agent

Headers:
{
  "Authorization": "Bearer session_token_here"
}

Body:
{
  "personalInfo": {
    "firstName": "John",
    "lastName": "Doe",
    "email": "john.doe@email.com",
    "phone": "+1234567890"
  },
  "professionalInfo": {
    "npn": "1234567890",
    "licenseStates": ["CA", "NY"],
    "licenseNumbers": {
      "CA": "CA123456",
      "NY": "NY789012"
    }
  },
  "bankingInfo": {
    "bankName": "Chase Bank",
    "accountType": "Checking",
    "routingNumber": "021000021",
    "accountNumber": "1234567890"
  }
}
```

## 📈 Reporting and Analytics

### 1. Onboarding Metrics
- **Link Usage Statistics**: Track how many agents used each code
- **Conversion Rates**: Measure completion rates for onboarding sessions
- **Time to Complete**: Average time for agents to complete onboarding
- **Geographic Distribution**: Where agents are located
- **Device Analytics**: Mobile vs desktop usage

### 2. Commission Tracking
- **Commission Rule Creation**: Track automatically created commission rules
- **Revenue Attribution**: Link commission earnings to specific onboarding codes
- **Performance Comparison**: Compare performance across different codes

## 🔧 Technical Implementation

### 1. Database Changes
- **New Tables**: `oe.AgentOnboardingLinks`, `oe.AgentOnboardingSessions`
- **Indexes**: Optimize queries on commission codes and session tokens
- **Constraints**: Ensure data integrity and referential integrity

### 2. Security Implementation
- **Token Generation**: Cryptographically secure session tokens
- **Rate Limiting**: Implement rate limiting on public endpoints
- **Input Validation**: Comprehensive validation of all input data
- **SQL Injection Prevention**: Parameterized queries and input sanitization

### 3. Frontend Components
- **React Components**: Reusable components for onboarding forms
- **Form Validation**: Client-side and server-side validation
- **File Upload**: Secure file upload with virus scanning
- **Progress Tracking**: Visual progress indicators

## 🚀 Future Enhancements

### Phase 2 Features
1. **Bulk Import**: Import multiple agents via CSV/Excel files
2. **Email Templates**: Customizable email notifications
3. **Integration APIs**: Webhook support for external systems
4. **Advanced Analytics**: Detailed reporting dashboard
5. **Multi-language Support**: Support for multiple languages

### Phase 3 Features
1. **Mobile App**: Native mobile app for agent onboarding
2. **Biometric Verification**: Identity verification using biometrics
3. **Automated Compliance**: Automatic compliance checking
4. **AI-Powered Matching**: Match agents to optimal commission structures

## 📝 Clarified Requirements

### 1. Link Access Control
- **Public URLs**: All onboarding URLs are public and can be published on websites or emailed to agents
- **No Authentication Required**: Agents can access onboarding links without pre-authentication
- **Direct Access**: Links can be shared via email, website, or any other communication method

### 2. Commission Code System
- **User-Created Codes**: Codes are created by Tenant/Agency/Agent administrators
- **URL-Specific Codes**: Each code is specific to a particular onboarding URL
- **Unlimited Usage**: No limit on the number of agents that can enroll using the same code
- **Custom Naming**: Codes can be custom names like "Apple", "Orange", "Peach" or any other identifier

### 3. Agent Registration Process

#### Section 1: Personal & Professional Information
- **Agent Name**: First Name, Middle Initial, Last Name
- **Company Name**: Agency name (if agency is not the owner of the link)
- **Contact Information**: Email address, Phone Number
- **Address**: Address Line 1, Address Line 2, City, State, Zip Code
- **Tax Information**: Tax ID Type (EIN or Social Security), Tax ID or Social Security Number
- **Professional**: NPN (National Producer Number)
- **Referral**: Who Referred You? (optional field)

#### Section 2: Banking Information
- **Bank Name**: Financial institution name
- **Account Type**: Business or Individual account
- **Account Details**: Savings or Checking account type
- **Banking Numbers**: Routing Number, Account Number

#### Section 3: Contract & Signature
- **Agent Contract**: Contract document provided by Tenant/Agency
- **Digital Signature**: Capture signature and date signed
- **Contract Storage**: Secure storage of signed contract documents

#### Account Creation & Verification
- **Self-Registration**: Agents create their own accounts during onboarding
- **Identity Verification**: Identity and licensing verification required during onboarding
- **Account Activation**: Accounts are activated upon successful completion of all steps

### 4. Commission Rule Assignment
- **Tenant-Specific Rules**: Codes are tenant-specific and not available on global commission rules
- **One-to-One Mapping**: Each code maps to exactly one commission rule
- **Automatic Assignment**: Agents are automatically assigned to the commission rule based on their code
- **No Expiration**: Onboarding codes do not have expiration dates
- **Commission Distribution**: 100% of commission must be distributed (e.g., if code = 50% to agent, remaining 50% goes to product-based commission following tier hierarchy, agency, or tenant)

### 5. Access Control
- **Tenant Scope**: Tenants can only create codes for their own agents
- **Tenant-Specific Rules**: All rules are tenant-specific in the current architecture
- **Agency Limitation**: Agencies and Agents are specific to tenants (no cross-tenant functionality)
- **Management Access**: Only TenantAdmin can manage and view onboarding codes and their usage

### 6. Integration Points
- **Hierarchy Independence**: Codes do not impact the existing agent hierarchy system
- **Tier Separation**: Upline/downline hierarchy is specific to products with tier-based commission structures
- **Automatic Assignment**: Onboarded agents are automatically assigned to the proper Tenant/Agency/Agent hierarchy based on the URL
- **URL Hierarchy**: URLs are specific to Tenant, Agency, or Agent to establish proper upline/downline relationships

---

This document outlines the comprehensive requirements for the Agent Onboarding Links system. Please review and provide clarification on any points that need adjustment or additional detail.
