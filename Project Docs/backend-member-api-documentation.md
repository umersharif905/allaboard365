# MEMBER PORTAL - BACKEND API ENDPOINTS
# Complete API specification for Member Portal functionality

## AUTHENTICATION ENDPOINTS
All Member API endpoints require valid JWT token with UserType = 'Member'

### Headers Required:
```
Authorization: Bearer <jwt_token>
Content-Type: application/json
X-Tenant-ID: <tenant_id> (optional, extracted from token)
```

## MEMBER PROFILE ENDPOINTS

### GET /api/members/profile
Get current member profile with relationships
**Response:**
```json
{
  "success": true,
  "data": {
    "memberId": "uuid",
    "userId": "uuid",
    "groupId": "uuid",
    "status": "Active",
    "dateOfBirth": "1990-01-01",
    "gender": "Male",
    "address": "123 Main St",
    "city": "Anytown",
    "state": "CA",
    "zip": "12345",
    "socialSecurityNumber": "XXX-XX-1234",
    "enrollmentType": "Group",
    "user": {
      "userId": "uuid",
      "email": "member@example.com",
      "firstName": "John",
      "lastName": "Doe",
      "phoneNumber": "555-1234",
      "userType": "Member"
    },
    "group": {
      "groupId": "uuid",
      "name": "Acme Corp",
      "tenantId": "uuid"
    },
    "dependents": [...],
    "enrollments": [...]
  }
}
```

### PUT /api/members/profile
Update member profile
**Request Body:**
```json
{
  "memberId": "uuid",
  "personalInfo": {
    "firstName": "John",
    "lastName": "Doe",
    "dateOfBirth": "1990-01-01",
    "gender": "Male",
    "socialSecurityNumber": "XXX-XX-1234"
  },
  "contactInfo": {
    "phoneNumber": "555-1234",
    "address": "123 Main St",
    "city": "Anytown",
    "state": "CA",
    "zip": "12345",
    "email": "member@example.com"
  }
}
```

### POST /api/members/password
Update password
**Request Body:**
```json
{
  "currentPassword": "current_password",
  "newPassword": "new_password"
}
```

## MEMBER DASHBOARD ENDPOINTS

### GET /api/members/dashboard
Get comprehensive dashboard data
**Response:**
```json
{
  "success": true,
  "data": {
    "member": {...},
    "activeEnrollments": [...],
    "dependents": [...],
    "recentActivity": [...],
    "importantNotices": [...],
    "upcomingDeadlines": [...],
    "utilizationSummary": {
      "memberId": "uuid",
      "year": 2025,
      "totalPremiumsPaid": 5000.00,
      "totalClaimsSubmitted": 3,
      "totalClaimsPaid": 2500.00,
      "utilizationRatio": 0.5,
      "memberSavings": 500.00
    },
    "quickActions": [...]
  }
}
```

### GET /api/members/activity?limit=10
Get member activity history
**Query Parameters:**
- limit: number (optional, default 50)

### GET /api/members/notices?includeRead=false
Get member notices
**Query Parameters:**
- includeRead: boolean (default false)

### POST /api/members/notices/{noticeId}/read
Mark notice as read

## DEPENDENT MANAGEMENT ENDPOINTS

### GET /api/members/dependents
Get member dependents with age calculations
**Response:**
```json
{
  "success": true,
  "data": [
    {
      "dependentId": "uuid",
      "memberId": "uuid",
      "firstName": "Jane",
      "lastName": "Doe",
      "dateOfBirth": "2010-05-15",
      "gender": "Female",
      "relationship": "Child",
      "socialSecurityNumber": "XXX-XX-5678",
      "status": "Active",
      "age": 15,
      "isEligible": true,
      "isAgedOut": false,
      "ageOutDate": "2036-05-15"
    }
  ]
}
```

### POST /api/members/dependents
Add new dependent
**Request Body:**
```json
{
  "firstName": "Jane",
  "lastName": "Doe",
  "dateOfBirth": "2010-05-15",
  "gender": "Female",
  "relationship": "Child",
  "socialSecurityNumber": "XXX-XX-5678",
  "status": "Active"
}
```

### PUT /api/members/dependents/{dependentId}
Update dependent
**Request Body:** Partial dependent object

### DELETE /api/members/dependents/{dependentId}
Remove dependent (soft delete, affects enrollments)

## ENROLLMENT ENDPOINTS

### GET /api/members/enrollments
Get member enrollments with dependent enrollments
**Response:**
```json
{
  "success": true,
  "data": [
    {
      "enrollmentId": "uuid",
      "memberId": "uuid",
      "productId": "uuid",
      "status": "Active",
      "effectiveDate": "2025-01-01",
      "terminationDate": null,
      "premium": 250.00,
      "paymentFrequency": "Monthly",
      "product": {...},
      "dependentEnrollments": [
        {
          "dependentEnrollmentId": "uuid",
          "enrollmentId": "uuid",
          "dependentId": "uuid",
          "effectiveDate": "2025-01-01",
          "premium": 100.00,
          "dependent": {...}
        }
      ]
    }
  ]
}
```

### GET /api/members/available-products
Get products available to member based on group subscriptions
**Response:** Array of products with pricing and features

### POST /api/members/calculate-premium
Calculate premium for product and dependents
**Request Body:**
```json
{
  "productId": "uuid",
  "dependentIds": ["uuid1", "uuid2"]
}
```
**Response:**
```json
{
  "success": true,
  "data": {
    "premium": 350.00,
    "breakdown": {
      "memberPremium": 250.00,
      "dependentPremiums": [
        {"dependentId": "uuid1", "premium": 50.00},
        {"dependentId": "uuid2", "premium": 50.00}
      ]
    }
  }
}
```

### POST /api/members/enroll
Submit enrollment request
**Request Body:**
```json
{
  "step": 5,
  "totalSteps": 5,
  "memberId": "uuid",
  "selectedProducts": [
    {
      "productId": "uuid",
      "selectedTier": "Standard",
      "selectedCoverage": "Family",
      "calculatedPremium": 350.00,
      "includeDependents": true,
      "dependentIds": ["uuid1", "uuid2"]
    }
  ],
  "paymentMethod": {
    "type": "Bank Account",
    "accountNumber": "****1234",
    "routingNumber": "****5678"
  }
}
```

### POST /api/members/enrollments/{enrollmentId}/change-request
Request plan change (for group members, requires Group Admin approval)
**Request Body:**
```json
{
  "newProductId": "uuid",
  "reason": "Life event - marriage"
}
```

## ENROLLMENT LINK ENDPOINTS

### GET /api/members/enrollment-links/validate/{linkToken}
Validate enrollment link
**Response:**
```json
{
  "success": true,
  "data": {
    "isValid": true,
    "expirationDate": "2025-12-31T23:59:59Z"
  }
}
```

### POST /api/members/enrollment-links/access
Access enrollment link and log usage
**Request Body:**
```json
{
  "linkToken": "encrypted_token"
}
```
**Response:**
```json
{
  "success": true,
  "data": {
    "linkId": "uuid",
    "groupId": "uuid",
    "linkUrl": "https://...",
    "expirationDate": "2025-12-31",
    "linkType": "Group",
    "isActive": true
  }
}
```

## EMERGENCY CONTACTS ENDPOINTS

### GET /api/members/emergency-contacts
Get emergency contacts

### PUT /api/members/emergency-contacts
Update emergency contacts list
**Request Body:**
```json
{
  "contacts": [
    {
      "contactId": "uuid",
      "name": "Jane Doe",
      "relationship": "Spouse",
      "phoneNumber": "555-1234",
      "email": "jane@example.com",
      "address": "123 Main St",
      "isPrimary": true
    }
  ]
}
```

## COMMUNICATION PREFERENCES ENDPOINTS

### GET /api/members/communication-preferences
Get communication preferences

### PUT /api/members/communication-preferences
Update communication preferences
**Request Body:**
```json
{
  "emailNotifications": true,
  "smsNotifications": false,
  "mailingAddress": true,
  "preferredLanguage": "English",
  "marketingOptIn": false
}
```

## UTILIZATION & REPORTING ENDPOINTS

### GET /api/members/utilization?year=2025
Get utilization summary for year
**Query Parameters:**
- year: number (optional, defaults to current year)

### GET /api/members/documents/{documentId}/download
Download member document (returns file blob)

## MOBILE APP SPECIFIC ENDPOINTS

### GET /api/members/mobile/config
Get mobile app configuration

### POST /api/members/mobile/register-device
Register device for push notifications
**Request Body:**
```json
{
  "deviceToken": "device_token",
  "platform": "ios" | "android"
}
```

## UTILITY ENDPOINTS

### GET /api/members/can-edit-plans
Check if member can edit plans (individual vs group member)
**Response:**
```json
{
  "success": true,
  "data": {
    "canEdit": false,
    "reason": "Group members require HR administrator approval for plan changes"
  }
}
```

### GET /api/members/help-resources
Get member help resources and documentation

## ERROR HANDLING
All endpoints return consistent error format:
```json
{
  "success": false,
  "error": "Error message",
  "validationErrors": [
    {
      "field": "firstName",
      "message": "First name is required",
      "code": "REQUIRED"
    }
  ]
}
```

## SECURITY CONSIDERATIONS
1. All PHI data must be encrypted at rest and in transit
2. Audit logging for all data access and modifications
3. Rate limiting on sensitive endpoints
4. Input validation and sanitization
5. SQL injection prevention
6. XSS protection for user-generated content

## DATABASE QUERIES OPTIMIZATION
1. Use proper indexes on frequently queried fields
2. Implement pagination for large result sets
3. Use database views for complex joins
4. Cache frequently accessed data
5. Implement connection pooling

## COMPLIANCE REQUIREMENTS
1. HIPAA compliance for health information
2. Audit trail for all data changes
3. Data retention policies
4. Secure data disposal
5. Access logging and monitoring
