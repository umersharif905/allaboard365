# Phase 2: Backend API Documentation - Agent Onboarding Links

## 🚀 **API Endpoints Overview**

The Agent Onboarding Links system provides two main API groups:

### **1. Tenant Admin APIs** (Authenticated)
- **Base Path**: `/api/me/tenant-admin/onboarding-links`
- **Authentication**: Required (Bearer token)
- **Authorization**: TenantAdmin role only
- **Purpose**: Manage onboarding links for the tenant

### **2. Public APIs** (No Authentication)
- **Base Path**: `/api/public/onboarding`
- **Authentication**: None required
- **Purpose**: Handle agent onboarding flow

---

## 📋 **Tenant Admin APIs**

### **GET /api/me/tenant-admin/onboarding-links**
Get all onboarding links for the current tenant.

**Headers:**
```
Authorization: Bearer <token>
Content-Type: application/json
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "LinkId": "uuid",
      "LinkName": "Q1 2024 Agent Recruitment",
      "CommissionCode": "APPLE",
      "CommissionRuleId": "uuid",
      "CommissionRuleName": "Standard Agent Commission",
      "CommissionType": "Percentage",
      "CommissionRate": 0.05,
      "FlatAmount": null,
      "IsActive": true,
      "CurrentUses": 15,
      "CreatedDate": "2024-01-15T10:30:00Z",
      "ModifiedDate": "2024-01-20T14:22:00Z",
      "RedirectUrl": "https://agency.com/welcome",
      "ContractDocumentId": "uuid",
      "ContractFileName": "agent-contract.pdf",
      "ContractDocumentUrl": "https://storage.blob.core.windows.net/agents/contract.pdf",
      "CustomFields": {
        "department": "Sales",
        "region": "West Coast"
      },
      "TotalSessions": 25,
      "CompletedSessions": 15,
      "CompletionRate": 60.0
    }
  ]
}
```

### **POST /api/me/tenant-admin/onboarding-links**
Create a new onboarding link.

**Request Body:**
```json
{
  "linkName": "Q2 2024 Agent Recruitment",
  "commissionCode": "ORANGE",
  "commissionRuleId": "uuid",
  "redirectUrl": "https://agency.com/welcome",
  "contractDocumentId": "uuid",
  "customFields": {
    "department": "Sales",
    "region": "East Coast"
  }
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "LinkId": "uuid",
    "LinkName": "Q2 2024 Agent Recruitment",
    "CommissionCode": "ORANGE",
    "CommissionRuleId": "uuid",
    "CommissionRuleName": "Standard Agent Commission",
    "CommissionType": "Percentage",
    "CommissionRate": 0.05,
    "IsActive": true,
    "CreatedDate": "2024-01-15T10:30:00Z",
    "RedirectUrl": "https://agency.com/welcome",
    "ContractDocumentId": "uuid",
    "ContractFileName": "agent-contract.pdf",
    "CustomFields": {
      "department": "Sales",
      "region": "East Coast"
    }
  },
  "message": "Onboarding link created successfully"
}
```

### **PUT /api/me/tenant-admin/onboarding-links/:id**
Update an onboarding link.

**Request Body:**
```json
{
  "linkName": "Updated Link Name",
  "isActive": false,
  "redirectUrl": "https://new-agency.com/welcome"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Onboarding link updated successfully"
}
```

### **DELETE /api/me/tenant-admin/onboarding-links/:id**
Deactivate an onboarding link (soft delete).

**Response:**
```json
{
  "success": true,
  "message": "Onboarding link deactivated successfully"
}
```

### **GET /api/me/tenant-admin/onboarding-links/:id/sessions**
Get onboarding sessions for a specific link.

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "SessionId": "uuid",
      "SessionToken": "abc123...",
      "Status": "Completed",
      "StartedDate": "2024-01-15T10:30:00Z",
      "CompletedDate": "2024-01-15T11:45:00Z",
      "ExpiresDate": "2024-01-16T10:30:00Z",
      "IPAddress": "192.168.1.100",
      "UserAgent": "Mozilla/5.0...",
      "AgentId": "uuid",
      "AgentName": "John Doe",
      "AgentEmail": "john.doe@example.com",
      "AgentData": {
        "firstName": "John",
        "lastName": "Doe",
        "email": "john.doe@example.com",
        "phone": "555-1234",
        "address": "123 Main St",
        "city": "Anytown",
        "state": "CA",
        "zip": "12345"
      }
    }
  ]
}
```

### **GET /api/me/tenant-admin/onboarding-links/stats**
Get overall onboarding statistics for the tenant.

**Response:**
```json
{
  "success": true,
  "data": {
    "TotalLinks": 5,
    "ActiveLinks": 3,
    "TotalUses": 45,
    "TotalSessions": 67,
    "CompletedSessions": 42,
    "InProgressSessions": 8,
    "PendingSessions": 12,
    "FailedSessions": 5,
    "OverallCompletionRate": 62.69
  }
}
```

---

## 🌐 **Public APIs**

### **POST /api/public/onboarding/validate-code**
Validate a commission code and return link details.

**Request Body:**
```json
{
  "commissionCode": "APPLE"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "linkId": "uuid",
    "linkName": "Q1 2024 Agent Recruitment",
    "commissionCode": "APPLE",
    "tenantName": "ABC Insurance Agency",
    "commissionRule": {
      "ruleId": "uuid",
      "ruleName": "Standard Agent Commission",
      "type": "Percentage",
      "rate": 0.05,
      "flatAmount": null
    },
    "contractDocumentUrl": "https://storage.blob.core.windows.net/agents/contract.pdf",
    "customFields": {
      "department": "Sales",
      "region": "West Coast"
    }
  }
}
```

### **POST /api/public/onboarding/start-session**
Start a new onboarding session.

**Request Body:**
```json
{
  "linkId": "uuid",
  "commissionCode": "APPLE"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "sessionId": "uuid",
    "sessionToken": "abc123def456...",
    "status": "Pending",
    "startedDate": "2024-01-15T10:30:00Z",
    "expiresDate": "2024-01-16T10:30:00Z"
  }
}
```

### **POST /api/public/onboarding/save-progress**
Save onboarding progress (partial data).

**Request Body:**
```json
{
  "sessionToken": "abc123def456...",
  "currentStep": 2,
  "agentData": {
    "firstName": "John",
    "lastName": "Doe",
    "email": "john.doe@example.com",
    "phone": "555-1234",
    "address": "123 Main St",
    "city": "Anytown",
    "state": "CA",
    "zip": "12345",
    "npn": "1234567890",
    "taxId": "12-3456789",
    "taxIdType": "EIN",
    "referredBy": "Jane Smith"
  }
}
```

**Response:**
```json
{
  "success": true,
  "message": "Progress saved successfully"
}
```

### **POST /api/public/onboarding/complete**
Complete the onboarding process and create agent account.

**Request Body:**
```json
{
  "sessionToken": "abc123def456...",
  "agentData": {
    "firstName": "John",
    "lastName": "Doe",
    "email": "john.doe@example.com",
    "phone": "555-1234",
    "address": "123 Main St",
    "city": "Anytown",
    "state": "CA",
    "zip": "12345",
    "npn": "1234567890",
    "taxId": "12-3456789",
    "taxIdType": "EIN",
    "referredBy": "Jane Smith",
    "bankName": "First National Bank",
    "accountType": "Checking",
    "routingNumber": "123456789",
    "accountNumber": "987654321"
  },
  "digitalSignature": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA...",
  "signatureDate": "2024-01-15T11:45:00Z"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "agentId": "uuid",
    "userId": "uuid",
    "email": "john.doe@example.com",
    "message": "Onboarding completed successfully"
  }
}
```

### **GET /api/public/onboarding/session/:token**
Get session details by token.

**Response:**
```json
{
  "success": true,
  "data": {
    "sessionId": "uuid",
    "status": "InProgress",
    "startedDate": "2024-01-15T10:30:00Z",
    "expiresDate": "2024-01-16T10:30:00Z",
    "agentData": {
      "firstName": "John",
      "lastName": "Doe",
      "email": "john.doe@example.com",
      "phone": "555-1234",
      "address": "123 Main St",
      "city": "Anytown",
      "state": "CA",
      "zip": "12345"
    },
    "linkName": "Q1 2024 Agent Recruitment",
    "commissionCode": "APPLE",
    "tenantName": "ABC Insurance Agency"
  }
}
```

---

## 🔒 **Security & Validation**

### **Tenant Admin APIs**
- **Authentication**: Bearer token required
- **Authorization**: TenantAdmin role only
- **Tenant Isolation**: All operations are scoped to the authenticated user's tenant
- **Input Validation**: All inputs are validated and sanitized

### **Public APIs**
- **Rate Limiting**: Implemented to prevent abuse
- **Session Security**: Cryptographically secure session tokens (32 bytes)
- **Session Expiration**: 24-hour session timeout
- **Input Validation**: Comprehensive validation of all inputs
- **SQL Injection Protection**: Parameterized queries only

### **Data Validation Rules**

#### **Commission Code**
- Length: 3-50 characters
- Format: Alphanumeric characters recommended
- Uniqueness: Must be unique within tenant

#### **Agent Data Validation**
- **Required Fields**: firstName, lastName, email, phone, address, city, state, zip
- **Email**: Must be unique across the system
- **Phone**: Valid phone number format
- **Address**: Complete address information required

#### **Session Management**
- **Token Security**: 32-byte cryptographically secure random tokens
- **Expiration**: 24-hour automatic expiration
- **Status Tracking**: Pending → InProgress → Completed/Failed/Expired

---

## 📊 **Error Handling**

### **Standard Error Response Format**
```json
{
  "success": false,
  "message": "Human-readable error message",
  "code": "ERROR_CODE",
  "details": "Additional error details (development only)"
}
```

### **Common Error Codes**

#### **Authentication Errors**
- `UNAUTHORIZED`: Missing or invalid authentication token
- `FORBIDDEN`: Insufficient permissions for the requested operation

#### **Validation Errors**
- `VALIDATION_ERROR`: Input validation failed
- `MISSING_FIELDS`: Required fields are missing
- `INVALID_FORMAT`: Data format is invalid

#### **Business Logic Errors**
- `COMMISSION_CODE_EXISTS`: Commission code already exists for tenant
- `COMMISSION_RULE_NOT_FOUND`: Commission rule not found or doesn't belong to tenant
- `SESSION_EXPIRED`: Onboarding session has expired
- `EMAIL_EXISTS`: Agent email already exists in system
- `INVALID_LINK`: Onboarding link is invalid or inactive

#### **System Errors**
- `DATABASE_ERROR`: Database operation failed
- `INTERNAL_ERROR`: Unexpected server error

---

## 🔄 **Integration Points**

### **Existing System Integration**
1. **Commission Rules**: Direct integration with `oe.CommissionRules` table
2. **Agent Hierarchy**: Integration with existing `oe.AgentHierarchy` system
3. **User Management**: Uses existing `oe.Users` and `oe.Agents` tables
4. **Document Management**: Integration with Azure Blob Storage via `oe.FileUploads` table
5. **Tenant Isolation**: Proper tenant-scoped design

### **Database Integration**
- **Stored Procedures**: Uses `sp_ValidateCommissionCode`, `sp_StartOnboardingSession`
- **Views**: Leverages `vw_ActiveOnboardingLinks`, `vw_OnboardingSessionStats`
- **Triggers**: Automatic timestamp updates via database triggers

---

## 🚀 **Usage Examples**

### **Complete Onboarding Flow**

1. **Validate Commission Code**
```bash
curl -X POST http://localhost:3000/api/public/onboarding/validate-code \
  -H "Content-Type: application/json" \
  -d '{"commissionCode": "APPLE"}'
```

2. **Start Session**
```bash
curl -X POST http://localhost:3000/api/public/onboarding/start-session \
  -H "Content-Type: application/json" \
  -d '{"linkId": "uuid", "commissionCode": "APPLE"}'
```

3. **Save Progress (Section 1)**
```bash
curl -X POST http://localhost:3000/api/public/onboarding/save-progress \
  -H "Content-Type: application/json" \
  -d '{
    "sessionToken": "abc123...",
    "currentStep": 1,
    "agentData": {"firstName": "John", "lastName": "Doe", "email": "john@example.com"}
  }'
```

4. **Complete Onboarding**
```bash
curl -X POST http://localhost:3000/api/public/onboarding/complete \
  -H "Content-Type: application/json" \
  -d '{
    "sessionToken": "abc123...",
    "agentData": {"firstName": "John", "lastName": "Doe", "email": "john@example.com", ...},
    "digitalSignature": "data:image/png;base64,...",
    "signatureDate": "2024-01-15T11:45:00Z"
  }'
```

### **Tenant Admin Management**

1. **Get All Links**
```bash
curl -X GET http://localhost:3000/api/me/tenant-admin/onboarding-links \
  -H "Authorization: Bearer <token>"
```

2. **Create New Link**
```bash
curl -X POST http://localhost:3000/api/me/tenant-admin/onboarding-links \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "linkName": "Q2 2024 Recruitment",
    "commissionCode": "ORANGE",
    "commissionRuleId": "uuid",
    "redirectUrl": "https://agency.com/welcome"
  }'
```

---

## ✅ **Phase 2 Completion Status**

- ✅ **Tenant Admin APIs**: Complete with full CRUD operations
- ✅ **Public Onboarding APIs**: Complete with session management
- ✅ **Service Layer**: Business logic abstraction
- ✅ **Route Mounting**: Integrated with existing backend architecture
- ✅ **Error Handling**: Comprehensive error responses
- ✅ **Security**: Authentication, authorization, and input validation
- ✅ **Documentation**: Complete API documentation

**Ready for Phase 3: Frontend Development**


































