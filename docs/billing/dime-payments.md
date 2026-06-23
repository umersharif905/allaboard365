# DIME Payments Integration

This document provides comprehensive guidance on working with DIME payment processing in the OpenEnroll codebase.

## ✅ CORRECT DIME API IMPLEMENTATION

**We have successfully implemented the correct DIME API flow that achieves PCI compliance for credit cards.**

### The Solution
DIME's API requires a **two-step process** for PCI-compliant credit card processing:

1. **Create Payment Method** → `/api/payment-method/create` (returns raw card number as "token")
2. **Tokenize Card** → `/api/transaction/tokenize-card` (converts raw card number to proper token)
3. **Store Token** → Database (store the real token for future use)
4. **Charge with Token** → `/api/transaction/charge-card` (use stored token, no raw data)

### What Works
- ✅ **Credit Cards**: Full PCI compliance with proper tokenization flow
- ✅ **Customer Creation**: Works perfectly
- ✅ **Payment Method Storage**: Works (stores payment methods in DIME vault)
- ✅ **Tokenization**: Converts raw card numbers to secure tokens
- ✅ **Token Storage**: Store real tokens in database for future use
- ✅ **Charging with Tokens**: No raw card data needed for future charges
- ✅ **ACH One-Time Payments**: Works with raw data (DIME limitation, not PCI compliant)
- ✅ **Product Change Payments**: Successfully implemented with payment method selection
- ✅ **Group Onboarding Payments**: Successfully implemented with unified payment method creation

### What Still Needs Work
- ⚠️ **ACH One-Time Payments**: Requires raw data (DIME limitation, not PCI compliant)
- ✅ **ACH Recurring Payments**: DIME can charge stored ACH methods for recurring transactions

## Table of Contents

- [Overview](#overview)
- [Critical API Correction](#critical-api-correction)
- [Environment Setup](#environment-setup)
- [Database Schema](#database-schema)
- [Backend Service](#backend-service)
- [API Endpoints](#api-endpoints)
- [Frontend Integration](#frontend-integration)
- [Phone Number Handling](#phone-number-handling)
- [Error Handling](#error-handling)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)

## Overview

DIME (Digital Insurance Management Engine) is our payment processor for handling:
- Customer management
- Payment method creation and storage
- Payment processing
- Default payment method management

### Key Features
- ✅ Credit card and ACH payment methods
- ✅ Customer creation and management
- ✅ Payment method validation
- ✅ Default payment method handling
- ✅ Test number detection and replacement
- ✅ Comprehensive error handling
- ✅ PCI-compliant token storage

### Credit card `cc_brand` (DIME request/response)

When creating or updating a card, DIME expects `cc_brand` to be one of the following **exact** strings (OpenEnroll derives these from the PAN via `card-validator` in `backend/services/dimeCardBrand.js`):

| `cc_brand` value | Notes |
|------------------|--------|
| `Visa` | |
| `MasterCard` | |
| `Amex` | **Not** `"American Express"` — UI may show “American Express” but DIME’s API expects the exact string `Amex`. |
| `Discover` | |
| `JCB` | |
| `Diners` | From `diners-club` in card-validator. |

Unsupported networks (e.g. some UnionPay) are rejected with a clear validation error instead of defaulting to `Visa`.

## Critical API Correction

### 🔑 Key Authentication Fix (January 2025)

**CRITICAL DISCOVERY**: The main issue causing "Unauthenticated" errors was using the wrong header format.

#### Wrong Approach ❌
```javascript
// This was causing 401 Unauthenticated errors
headers: {
  'client_key': apiToken,
  'Content-Type': 'application/json',
  'Accept': 'application/json'
}
```

#### Correct Approach ✅
```javascript
// This works perfectly
headers: {
  'Authorization': `Bearer ${apiToken}`,
  'Content-Type': 'application/json',
  'Accept': 'application/json'
}
```

**Key Learning**: DIME's `/api/transaction/charge-ach` endpoint requires `Authorization: Bearer` headers, not `client_key` headers.

### What Was Wrong
Our current implementation incorrectly uses:
- `/api/transaction/tokenize-card` - For creating reusable payment methods ❌
- `/api/transaction/tokenize-bank` - For creating reusable payment methods ❌

These endpoints are designed for **one-time tokenization** only, not for storing reusable payment methods.

### What's Correct
DIME provides separate endpoints for different purposes:

#### 1. Payment Method Management (Reusable Storage)
- **Credit Cards**: `/api/payment-method/create` with `type: "cc"`
- **ACH/Bank**: `/api/payment-method/create` with `type: "ach"`
- **Purpose**: Store payment methods in DIME's vault for future use
- **Returns**: Payment method ID that can be used for future charges

#### 2. Payment Processing (Charging)
- **Credit Cards**: `/api/transaction/charge-card`
- **ACH/Bank**: `/api/transaction/charge-ach`
- **Purpose**: Process actual payments using either:
  - Raw payment data (one-time)
  - Stored payment method tokens (reusable)

### New DIME API Flow

#### For Creating Credit Card Payment Methods:

**⚠️ CRITICAL: Two-Step Process Required - Confirmed via Testing November 10, 2025**

1. **Create Customer** → `/api/customer/create` (first-time only, reuse for subsequent cards)

2. **Create Payment Method** → `/api/payment-method/create`
   - **Purpose**: Stores card in DIME vault for **recurring payments**
   - **Request**:
     ```json
     {
       "data": {
         "sid": "00119",
         "cardholder_name": "John Doe",
         "card_number": "4111111111111111",
         "expiration_date": "12/2025",
         "cvv": "123",
         "billing_address": { "addr1": "123 Main St", "city": "Anytown", "state": "CA", "zip": "12345" }
       }
     }
     ```
   - **Response**:
     ```json
     {
       "data": {
         "id": 177,
         "token": "4111111111111111",  ❌ This is the INPUT card number ECHOED BACK (NOT tokenized!)
         "cc_last_four": "1111",
         "cc_brand": "Visa"
       }
     }
     ```
   - **⚠️ CRITICAL**: The `token` field is the RAW card number (PCI violation if stored!)
   - **What to Store**: `ProcessorPaymentMethodId = "177"` (for recurring payments)
   - **What NOT to Store**: The `token` field value

3. **Tokenize Card** → `/api/transaction/tokenize-card`
   - **Purpose**: Generate secure PCI-compliant token for **one-time charges**
   - **Request**:
     ```json
     {
       "data": {
         "sid": "00119",
         "cardholder_name": "John Doe",
         "card_number": "4111111111111111",
         "expiration_date": "01/2025",
         "cvv": "123",
         "billing_address": { "addr1": "123 Main St", "city": "Anytown", "state": "NY", "zip": "10001" }
       }
     }
     ```
   - **Response**:
     ```json
     {
       "data": {
         "token": "6bfUm91a0WdW6eRKLXVC1111"  ✅ REAL TOKENIZED TOKEN!
       }
     }
     ```
   - **✅ THIS IS PCI COMPLIANT** - store this token
   - **What to Store**: `ProcessorToken = "6bfUm91a0WdW6eRKLXVC1111"` (for one-time charges)

4. **Store BOTH in Database** → `oe.MemberPaymentMethods` or `oe.GroupPaymentMethods`
   ```sql
   ProcessorToken = '6bfUm91a0WdW6eRKLXVC1111'  -- Tokenized token for one-time charges
   ProcessorPaymentMethodId = '177'              -- Payment method ID for recurring
   ProcessorCustomerId = 'customer-uuid'         -- DIME customer ID
   CardLast4 = '1111'                           -- For display only
   CardBrand = 'Visa'                           -- For display only
   ExpiryMonth = 12                             -- For validation only
   ExpiryYear = 2025                            -- For validation only
   ```

#### For Processing Payments:

1. **One-Time Charges (Immediate Payments)** - `/api/transaction/charge-card`:
   
   **Required Fields**: `sid`, `amount`, `customer_uuid`, `cardholder_name`
   
   **Token-Based (PCI Compliant - Recommended)**:
   ```javascript
   POST /api/transaction/charge-card
   {
     "data": {
       "sid": "00119",                                    // Required: Merchant ID
       "amount": 380.00,                                  // Required: Amount to charge
       "customer_uuid": "a4855dc5-0acb-33c3-b921-...",   // Required: DIME customer UUID
       "cardholder_name": "John Doe",                    // Required: Name on card
       "token": "6bfUm91a0WdW6eRKLXVC1111",              // Use ProcessorToken from database
       "billing_address": {
         "first_name": "John",
         "last_name": "Doe",
         "addr1": "123 Main St",
         "addr2": "Suite 100",
         "city": "Anytown",
         "state": "CA",
         "zip": "12345"
       }
     }
   }
   ```
   
   **Raw Card Data (Not Recommended - Use Only If Token Unavailable)**:
   ```javascript
   POST /api/transaction/charge-card
   {
     "data": {
       "sid": "00119",
       "amount": 380.00,
       "customer_uuid": "a4855dc5-0acb-33c3-b921-...",
       "cardholder_name": "John Doe",
       "card_number": "4111111111111111",                // Raw card number
       "expiration_date": "12/2025",                      // MM/YYYY format
       "cvv": "123",
       "billing_address": { ... }
     }
   }
   ```

2. **Recurring Payments (Monthly Billing)** - `/api/recurring-payment/create`:
   ```javascript
   POST /api/recurring-payment/create
   {
     "data": {
       "sid": "00119",
       "payment_method": "177",  // ← Use ProcessorPaymentMethodId from database
       "amount": "380.00",
       "customer_uuid": "customer-uuid",
       "next_run_date": "2025-12-01"
     }
   }
   ```

### Payment method changes never fix recurring payments

DIME does **not** support editing an existing recurring payment schedule via API (as of June 2026). A recurring schedule is permanently bound to the `payment_method` ID it was created with. Updating a payment method in DIME or setting a new default in OpenEnroll does **not** change which card/bank an existing schedule charges, and does **not** stop DIME auto-retries on the old payment method.

**Required pattern** (implemented as `recreateRecurringForPaymentMethodChange` in `backend/services/invoiceService.js`, modeled on `rescheduleDimeRecurringAfterAccountingPaymentRetry`):

1. Only after the new payment method is **successfully vaulted** in DIME (`ProcessorPaymentMethodId` present).
2. **Create** a new recurring schedule with the new `ProcessorPaymentMethodId`, starting on the next future billing date (preserve a future `NextBillingDate` when the first charge has not run yet).
3. **Cancel** the old recurring schedule (create-then-cancel so a failed create does not leave the household with no schedule).
4. Offer the member (or admin) an immediate one-time charge for any outstanding invoice on the current period — recurring intentionally skips that period to avoid double billing.

> **DIME Payments Team (June 2026):** *"Each customer can have multiple payment methods. A payment method is assigned to a recurring payment upon creation. If you want to edit the recurring payment, it is not currently supported via API, but it will be added this week. I would suggest, upon completing the payment workflow, and only upon success, create the recurring payment starting on the next scheduled charge date, either with the successful payment method id. Creating it before you successfully validate the payment method, is why the recurring payment is failing on a bad payment method. Until the edit functionality is deployed, you should delete the existing recurring payment and recreate it with the successful payment method."*

**Trigger points** (individual billing only; group schedules use `groupPaymentScheduler.js`):

- Member: `POST /api/me/member/payment-methods`, `PUT .../set-default`
- Admin: `POST /api/members/:id/payment-methods` (when `isDefault`), vault replace at processor

See also [next-billing-date-flow.md](./next-billing-date-flow.md) for failed recurring + payment-method update flow.

### PCI Compliance Benefits
- ✅ No raw payment data stored in our database
- ✅ DIME handles all sensitive payment information securely
- ✅ Only tokenized tokens stored (from `/api/transaction/tokenize-card`)
- ✅ Fully compliant with PCI DSS standards

### ⚠️ CRITICAL: Token Storage Requirements

**NEVER store raw payment data. DIME's `/api/payment-method/create` response INCORRECTLY returns the raw card number in the `token` field. You MUST use `/api/transaction/tokenize-card` to get the real tokenized token.**

#### Database Storage Pattern:
```sql
-- CORRECT Storage (after two-step tokenization process)
ProcessorToken = '6bfUm91a0WdW6eRKLXVC1111'  -- From /api/transaction/tokenize-card ✅
ProcessorPaymentMethodId = '177'              -- From /api/payment-method/create ✅
ProcessorCustomerId = 'customer-uuid'         -- From /api/customer/create ✅
CardLast4 = '1111'                           -- Display only
CardBrand = 'Visa'                           -- Display only

-- INCORRECT Storage (storing raw card number - PCI VIOLATION!)
ProcessorToken = '4111111111111111'  -- ❌ RAW CARD NUMBER - NEVER STORE THIS!
```

#### Verified Test Results (November 10, 2025):
```javascript
// Database shows our fix is working:
{
  ProcessorToken: "6bfUm91a0WdW6eRKLXVC1111",  // ✅ Tokenized (after fix)
  ProcessorPaymentMethodId: "178",             // ✅ Correct
  CardLast4: "1111"                           // ✅ Display only
}

// Old records show what was wrong:
{
  ProcessorToken: "4111111111111111",  // ❌ Raw card number (before fix)
  ProcessorPaymentMethodId: "177",     // ✅ Correct
  CardLast4: "1111"                   // ✅ Display only
}
```

#### What NOT to Store:
- ❌ **Raw Card Numbers**: Never store `"4111111111111111"` (PCI violation!)
- ❌ **CVV Codes**: Never store CVV (PCI violation!)
- ❌ **The `token` field from `/api/payment-method/create`**: It's the raw card number echoed back!
- ❌ **Bank Account Numbers**: Never store raw account numbers (ACH)
- ❌ **Routing Numbers**: Never store raw routing numbers (ACH)

#### Database Storage Pattern:
```sql
-- Store in MemberPaymentMethods or GroupPaymentMethods
ProcessorToken = '6bfUm91a0WdW6eRKLXVC1111'  -- Token from /api/payment-method/create response
ProcessorPaymentMethodId = '172'             -- ID from /api/payment-method/create response
ProcessorCustomerId = 'uuid-customer-id'     -- DIME customer UUID
-- NO raw payment data stored
```

### ⚠️ Payment Method Usage Restrictions

**DIME has different capabilities for different payment types:**

#### Credit Cards ✅
- **One-Time Payments**: Requires tokenized token from `/api/transaction/tokenize-card`
- **Recurring Payments**: Uses payment method ID from `/api/payment-method/create`
- **Tokenization**: Full tokenization support

#### ACH/Bank Accounts ⚠️
- **One-Time Payments**: ❌ Requires raw bank data (not PCI compliant)
- **Recurring Payments**: ✅ DIME can charge stored ACH methods
- **Tokenization**: ❌ No tokenization support

#### Implementation Strategy
1. **For One-Time Transactions**: Only allow credit cards with tokenization
2. **For Recurring Payments**: Allow both credit cards and ACH
3. **For Product Changes**: Require credit card for initial charge, ACH for ongoing billing
4. **For Group Onboarding**: Both credit cards and ACH supported

### 🎯 Product Change Payment Strategy

**For ProductChangePage.tsx specifically:**

#### ✅ Successfully Implemented Features
- **Payment Method Selection**: Dropdown with existing credit cards + "Add New Payment Method"
- **ACH Support**: New ACH payment methods work for one-time payments (with raw data)
- **Auto-Selection**: Newly added payment methods are automatically selected
- **Raw Data Handling**: ACH raw data is temporarily stored in frontend for one-time transactions
- **UI Integration**: Payment method step integrated into EnrollmentCompletionWizard
- **Validation**: Proper form validation and error handling
- **Test Data**: Prefill button with DIME test data for development

#### Implementation Details
```typescript
// Raw ACH data is temporarily stored for one-time transactions
const [rawPaymentData, setRawPaymentData] = useState(null);

// ACH methods without raw data are filtered out
const availablePaymentMethods = allPaymentMethods.filter(pm => {
  if (pm.paymentMethodType === 'ACH') {
    return rawPaymentData && rawPaymentData.paymentMethodId === pm.paymentMethodId;
  }
  return true; // Credit cards are always available
});
```

#### Payment Method Selection
- **Initial Payment**: Credit cards preferred, ACH allowed with raw data
- **Payment Method Dropdown**: Show existing credit cards + "Add New Payment Method" option
- **New Payment Method**: Becomes the new default payment method
- **ACH Support**: ACH methods work for one-time payments when raw data is available

#### User Experience Flow
1. User selects products to add/modify
2. System shows payment method dropdown (credit cards + ACH with raw data)
3. If no suitable payment methods exist, show "Add New Payment Method" option
4. New payment method is saved and set as default
5. Initial charge processed with selected payment method
6. Future recurring payments can use any stored payment method (CC or ACH)

## Environment Setup

### Required Environment Variables

Add these to your `backend/.env` file:

```env
# DIME Payments Configuration
# Demo/Testing Environment
DIME_DEMO_API_TOKEN=qhY88wIHiYeAAiHnnI5Glo4s5lmtIsNAZeuhd834bc8c
DIME_DEMO_SID=00119
DIME_DEMO_BASE_URL=https://demo.dimepayments.com

# Production Environment
DIME_PROD_API_TOKEN=your_prod_api_token_here
DIME_PROD_SID=your_prod_sid_here
DIME_PROD_BASE_URL=https://dimepayments.com
```

### Environment Detection

The system automatically detects the environment:
- **Development/Testing**: Uses `DIME_DEMO_*` variables
- **Production**: Uses `DIME_PROD_*` variables (when `NODE_ENV=production`)

## Database Schema

### Required Tables and Columns

#### 1. Members Table (`oe.Members`)
```sql
ALTER TABLE [oe].[Members]
ADD ProcessorCustomerId NVARCHAR(255) NULL;

CREATE INDEX IX_Members_ProcessorCustomerId ON [oe].[Members] (ProcessorCustomerId);
```

#### 2. Groups Table (`oe.Groups`)
```sql
ALTER TABLE [oe].[Groups]
ADD ProcessorCustomerId NVARCHAR(255) NULL;

CREATE INDEX IX_Groups_ProcessorCustomerId ON [oe].[Groups] (ProcessorCustomerId);
```

#### 3. MemberPaymentMethods Table (`oe.MemberPaymentMethods`)
```sql
-- Already includes these DIME-related columns:
ProcessorToken NVARCHAR(255) NULL
ProcessorCustomerId NVARCHAR(255) NULL
ProcessorPaymentMethodId NVARCHAR(255) NULL
```

#### 4. GroupPaymentMethods Table (`oe.GroupPaymentMethods`)
```sql
ALTER TABLE [oe].[GroupPaymentMethods]
ADD ProcessorToken NVARCHAR(255) NULL;

CREATE INDEX IX_GroupPaymentMethods_ProcessorToken ON [oe].[GroupPaymentMethods] (ProcessorToken);
```

## Backend Service

### DimeService (`backend/services/dimeService.js`)

The central service for all DIME API interactions. **UPDATED** to use correct DIME endpoints.

#### Key Methods

##### Customer Management
```javascript
// Create a new DIME customer
const result = await DimeService.createCustomer({
  firstName: 'John',
  lastName: 'Doe',
  email: 'john@example.com',
  phone: '7707892072', // 10-digit format
  billingAddress: '123 Main St',
  billingCity: 'Anytown',
  billingState: 'CA',
  billingZip: '12345',
  billingCountry: 'US'
});

// Get existing customer by email
const customer = await DimeService.getCustomerByEmail('john@example.com');
```

##### Payment Method Creation (CORRECTED - TWO-STEP PROCESS REQUIRED!)
```javascript
// Create Credit Card Payment Method (TWO-STEP Process - Both Required!)
// Step 1: Create payment method in DIME vault (for recurring payments)
const cardResult = await DimeService.createCreditCardPaymentMethod({
  number: '4111111111111111',
  expiryMonth: 12,
  expiryYear: 2025,
  cvv: '123',
  cardholderName: 'John Doe',
  billingAddress: {
    address: '123 Main St',
    address2: '',
    city: 'Anytown',
    state: 'CA',
    zip: '12345',
    country: 'US'
  },
  customerId: 'dime-customer-uuid' // Required
});

// Step 1 Response from DIME:
// {
//   data: {
//     id: 177,
//     token: "4111111111111111"  ❌ RAW CARD NUMBER (not tokenized!)
//   }
// }

// Step 2: Tokenize card (for one-time payments - PCI compliance)
const tokenizeResult = await DimeService.tokenizeCreditCard({
  cardNumber: '4111111111111111',
  expiryMonth: 12,
  expiryYear: 2025,
  cvv: '123',
  cardholderName: 'John Doe',
  customerId: 'dime-customer-uuid',
  billingAddress: {
    firstName: 'John',
    lastName: 'Doe',
    address: '123 Main St',
    address2: '',
    city: 'Anytown',
    state: 'CA',
    zip: '12345'
  }
});

// Step 2 Response from DIME:
// {
//   data: {
//     token: "6bfUm91a0WdW6eRKLXVC1111"  ✅ TOKENIZED (PCI compliant!)
//   }
// }

// Store in database (use tokens from BOTH steps):
ProcessorToken = tokenizeResult.token;               // "6bfUm91a0WdW6eRKLXVC1111" (for one-time charges)
ProcessorPaymentMethodId = cardResult.paymentMethodId; // "177" (for recurring payments)
ProcessorCustomerId = cardResult.customerId;          // "uuid..."

// Create ACH Payment Method (Still requires raw data for one-time charging)
const achResult = await DimeService.createBankAccountPaymentMethod({
  routingNumber: '021000021',
  accountNumber: '1234567890',
  accountType: 'Checking',
  accountHolderName: 'John Doe',
  bankName: 'Test Bank',
  billingAddress: {
    address: '123 Main St',
    address2: '',
    city: 'Anytown',
    state: 'CA',
    zip: '12345',
    country: 'US'
  },
  customerId: 'dime-customer-uuid' // Required
});

// ACH Response:
// {
//   success: true,
//   token: "172",  // Same as payment method ID (no separate token for ACH)
//   paymentMethodId: "172",
//   customerId: "uuid..."
// }
```

##### Payment Processing (CORRECTED)
```javascript
// Process payment using stored REAL token (PCI Compliant)
const paymentResult = await DimeService.processPayment({
  paymentMethodId: 'dime-payment-method-id', // From createCreditCardPaymentMethod
  paymentMethodToken: '6bfUm91a0WdW6eRKLXVC1111', // REAL tokenized token from database
  customerId: 'dime-customer-id',
  amount: 15000, // Amount in cents
  description: 'Monthly premium payment',
  paymentMethodType: 'Card' // or 'ACH'
});

// The processPayment method automatically:
// 1. Detects if paymentMethodToken is a raw card number (16 digits)
// 2. If so, calls tokenizeCreditCard() to get proper token
// 3. Uses the tokenized token for charging (no raw data sent)
// 4. For ACH, still requires raw data (DIME limitation)
```

##### Payment Method Management
```javascript
// Validate payment method
const validation = await DimeService.validatePaymentMethod(
  'payment-method-id',
  'customer-id'
);

// Update default status
await DimeService.updatePaymentMethodDefault(
  'payment-method-id',
  true // isDefault
);

// Delete payment method
await DimeService.deletePaymentMethod('payment-method-id');
```

## Required Changes

### 1. Update DimeService (`backend/services/dimeService.js`)
- ✅ **Keep**: `createCustomer()`, `getCustomerByEmail()`, `updateCustomer()`
- ❌ **Remove**: `tokenizeCreditCard()` and `tokenizeBankAccount()` methods
- ✅ **Add**: `createCreditCardPaymentMethod()` using `/api/payment-method/create`
- ✅ **Add**: `createBankAccountPaymentMethod()` using `/api/payment-method/create`
- ✅ **Update**: `processPayment()` to use stored payment method tokens

### 2. Update PaymentMethodService (`backend/services/PaymentMethodService.js`)
- ✅ **Modify**: `tokenizePaymentMethod()` to use new DimeService methods
- ✅ **Modify**: `insertPaymentMethod()` to store only DIME tokens
- ❌ **Remove**: All raw payment data storage (card numbers, routing numbers, account numbers)

### 3. Update All Payment Processing
- ✅ **Modify**: All endpoints that process payments to use stored tokens
- ✅ **Update**: Payment processing to use `/api/transaction/charge-card` or `/api/transaction/charge-ach`

### 4. Database Schema Changes
- ❌ **Remove**: `AccountNumber` column from `MemberPaymentMethods` and `GroupPaymentMethods` tables
- ✅ **Keep**: Only DIME token fields (`ProcessorToken`, `ProcessorCustomerId`, `ProcessorPaymentMethodId`)

### 5. Files That Need Updates
- `backend/services/dimeService.js` - Complete rewrite of payment method methods
- `backend/services/PaymentMethodService.js` - Update to use new DIME endpoints
- `backend/routes/me/member/payment-methods.js` - Update to use new service methods
- `backend/routes/groupBilling.js` - Update to use new service methods
- `backend/routes/group-onboarding.js` - Update to use new service methods
- `backend/routes/me/member/product-changes-complete.js` - Update payment processing

## API Endpoints

### Member Payment Methods

#### POST `/api/me/member/payment-methods`
Add a new payment method for a member.

**Request Body:**
```json
{
  "paymentMethodType": "CreditCard",
  "phoneNumber": "7707892072",
  "cardNumber": "4111111111111111",
  "expiryMonth": 12,
  "expiryYear": 2025,
  "cvv": "123",
  "cardholderName": "John Doe",
  "billingAddress": "123 Main St",
  "billingCity": "Anytown",
  "billingState": "CA",
  "billingZip": "12345",
  "billingCountry": "US",
  "isDefault": true
}
```

**Response:**
```json
{
  "success": true,
  "message": "Payment method added successfully",
  "data": {
    "paymentMethodType": "CreditCard",
    "isDefault": true,
    "processorToken": "dime-token",
    "processorCustomerId": "dime-customer-id",
    "processorPaymentMethodId": "dime-payment-method-id"
  }
}
```

#### PUT `/api/me/member/payment-methods/:id/set-default`
Set a payment method as default.

#### GET `/api/me/member/payment-methods`
Get all payment methods for the member.

#### DELETE `/api/me/member/payment-methods/:id`
Delete a payment method.

### Group Payment Methods

#### POST `/api/groups/:groupId/payment-method`
Add a new payment method for a group.

**Request Body:**
```json
{
  "type": "ACH",
  "phoneNumber": "7707892072",
  "bankName": "Test Bank",
  "accountType": "Checking",
  "routingNumber": "021000021",
  "accountNumber": "1234567890",
  "billingAddress": "123 Main St",
  "billingCity": "Anytown",
  "billingState": "CA",
  "billingZip": "12345"
}
```

#### PUT `/api/groups/:groupId/payment-method/:paymentMethodId/set-default`
Set a group payment method as default.

#### DELETE `/api/groups/:groupId/payment-method/:paymentMethodId`
Delete a group payment method.

### Enrollment Endpoints

#### POST `/api/enrollment-links/:linkToken/complete-enrollment`
Complete individual member enrollment with payment method.

#### POST `/api/group-onboarding/:linkToken/complete`
Complete group onboarding with payment method.

## Frontend Integration

### Group Billing Tab (`frontend/src/pages/groups/GroupBillingTab.tsx`)

#### Key Features
- ✅ Conditional phone number field (only when no DIME customer ID)
- ✅ Real-time form validation
- ✅ Button state management
- ✅ Test data prefill for development
- ✅ Comprehensive error handling

#### Phone Number Field
```tsx
{/* Phone Number Field - Only show if we don't have a DIME customer ID yet */}
{!hasDimeCustomerId && (
  <div className="mt-6">
    <label className="block text-sm font-medium text-gray-700 mb-1">
      Phone Number <span className="text-red-500">*</span>
    </label>
    <input
      type="tel"
      value={formData.phoneNumber}
      onChange={(e) => handleInputChange('phoneNumber', e.target.value)}
      placeholder="(555) 123-4567"
      className={`w-full px-3 py-2 border ${errors.phoneNumber ? 'border-red-500' : 'border-gray-300'} rounded-md focus:ring-oe-primary focus:border-oe-primary`}
    />
    {errors.phoneNumber && <p className="text-red-500 text-xs mt-1">{errors.phoneNumber}</p>}
    <p className="text-xs text-gray-500 mt-1">
      Required for payment processing setup
    </p>
  </div>
)}
```

#### Form Validation
```tsx
const isFormValid = (): boolean => {
  // Check common required fields
  if (!formData.billingAddress || !formData.billingCity || !formData.billingState || !formData.billingZip) {
    return false;
  }
  
  // Check phone number (only if we don't have a DIME customer ID)
  if (!hasDimeCustomerId) {
    if (!formData.phoneNumber) return false;
    const phoneDigits = formData.phoneNumber.replace(/\D/g, '');
    if (phoneDigits.length < 10) return false;
  }
  
  // Check payment type specific fields
  if (paymentType === 'ACH') {
    return !!(formData.bankName && formData.routingNumber && formData.accountNumber && 
              validateRoutingNumber(formData.routingNumber));
  } else {
    const cleanNumber = formData.cardNumber.replace(/\s/g, '');
    return !!(formData.cardNumber && formData.cardholderName && formData.expiryMonth && formData.expiryYear && formData.cvv &&
              cleanNumber.length >= 13 && validateCardNumber(cleanNumber) && /^\d{3,4}$/.test(formData.cvv));
  }
};
```

### Member Settings (`frontend/src/pages/member/Settings.tsx`)

#### Key Features
- ✅ Phone number prefilled from user profile
- ✅ Real-time validation
- ✅ Test data prefill button (localhost only)
- ✅ Confirmation dialog for setting default
- ✅ Comprehensive error handling

### Enrollment Wizard (`frontend/src/components/enrollment-wizard/EnrollmentWizard.tsx`)

#### Key Features
- ✅ Phone number required for individual enrollments only
- ✅ Prefilled from member info
- ✅ Real-time validation
- ✅ CVV field included

#### Validation Logic
```tsx
const validatePaymentMethod = () => {
  if (!enrollmentData || enrollmentData.enrollmentLink.templateType === 'Group') {
    return true; // No payment method required for group enrollments
  }

  if (!paymentMethodData.paymentMethodType) {
    return false;
  }

  // Validate phone number (required for DIME)
  if (!paymentMethodData.phoneNumber) {
    return false;
  }
  const phoneDigits = paymentMethodData.phoneNumber.replace(/\D/g, '');
  if (phoneDigits.length < 10) {
    return false;
  }

  // ... rest of validation
};
```

### Group Onboarding Wizard (`frontend/src/components/group-onboarding/GroupOnboardingWizard.tsx`)

#### Key Features
- ✅ Optional payment method section
- ✅ Phone number prefilled from group contact
- ✅ Real-time validation
- ✅ Comprehensive field validation

## Phone Number Handling

### Format Requirements

DIME requires phone numbers in **10-digit format** without country code:
- ✅ **Valid**: `7707892072`
- ❌ **Invalid**: `+17707892072`, `(770) 789-2072`, `5551234567`

### Test Number Detection

The system automatically detects and replaces test phone numbers:

```javascript
// Check if this is a test number that DIME might reject
if (finalPhone.startsWith('555') || finalPhone === '1234567890' || finalPhone === '0000000000') {
  console.log('⚠️ Detected test phone number, using realistic default');
  finalPhone = '7707892072'; // Use a realistic phone number that works with DIME
}
```

### Phone Number Validation

#### Frontend Validation
```tsx
// Basic phone number validation (10+ digits)
const phoneDigits = formData.phoneNumber.replace(/\D/g, '');
if (phoneDigits.length < 10) {
  newErrors.phoneNumber = 'Phone number must be at least 10 digits';
} else if (phoneDigits === '5555555555') {
  newErrors.phoneNumber = 'Please enter a valid phone number';
}
```

#### Backend Formatting
```javascript
static formatPhoneNumber(phone) {
  if (!phone || phone.trim() === '') {
    return null;
  }
  
  // Remove all non-digit characters
  const digits = phone.replace(/\D/g, '');
  
  // If it's a US number (10 digits), add +1
  if (digits.length === 10) {
    return `+1${digits}`;
  }
  
  // If it's already 11 digits and starts with 1, add +
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+${digits}`;
  }
  
  // If it's a 7-digit number (local number), treat as invalid and return null
  // This will trigger the default phone number logic
  if (digits.length === 7) {
    console.log('⚠️ Invalid phone number format (7 digits):', phone);
    return null;
  }
  
  // If it already has +, return as is (assuming it's already E.164)
  if (phone.startsWith('+')) {
    return phone;
  }
  
  // For other international numbers, add + prefix
  return `+${digits}`;
}
```

## Error Handling

### Payment Method Failure Classification Policy (April 2026)

> This section supersedes the earlier ad-hoc handling documented below. The short version:
> **bank declines, validation errors, and "upstream unverified" responses stop the enrollment (no PM row saved); only real DIME-infrastructure outages (5xx, gateway timeouts) or opaque unclassified 4xx proceed with a `PendingProcessorVault` payment method so ops can retry.**

#### Why we did this

DIME's sandbox vaulting is permissive — the probe at `ai_scripts/dime-error-probe/` confirmed that Luhn-fail cards, expired cards, and HPS "decline" test cards all return HTTP 200 at `/api/payment-method/create`. Real declines surface at charge time, not vault time. The failures we _do_ see at vault time fall into three buckets:

1. **Validation errors** — DIME returns `{ errors: { "data.xxx": [...] } }` with a 400. Always user-fixable (bad routing number, missing name on account, etc.).
2. **Known declines** — 400 with a free-text message like `insufficient funds`, `invalid account`, `do not honor`, etc. User-fixable (bank rejected the instrument).
3. **Upstream-unverified** — HTTP 400 with body `Invalid response from upstream API` (or similar "upstream" wording). Per DIME support (Apr 2026), the bank didn't confirm the card during vaulting — usually wrong card details, occasionally a transient bank blip. Treated as user-fixable so enrollment blocks rather than silently completing with no billing schedule. Historical rationale: Dawn Taylor's April 2026 incident produced stranded `Active` enrollments + orphan PendingProcessorVault rows because we used to bucket this as transient.
4. **Opaque unclassified 4xx** — 400 with no validation body and no recognizable decline/upstream wording. Still treated as transient — DIME gave us nothing actionable.
5. **Infrastructure outages** — 5xx, gateway timeouts, ECONNRESET. Not user-fixable.

Before this policy, every DIME failure was surfaced to the enrollee as "We couldn't save your payment method" regardless of cause, _and_ the enrollment had already been marked `Active` at that point so failed vaulting left orphan active enrollments with no billing. Dawn Taylor (March 2026) is the canonical example.

#### Sequencing (deferred-charge path)

```
enrollment complete-enrollment request
        │
        ▼
oe.Members row, enrollments created with Status=PaymentHold
        │
        ▼
DIME customer create  ─────────────┐  (retries existing customer on dup email)
        │                          │
        ▼                          │
DIME payment-method/create         │
        │                          │
        ├── success ───────────────┤
        ├── transient / 5xx ───────┤
        └── known failure ─────────┤
                                   │
                            classify result
                                   │
        ┌──────────────────────────┼───────────────────────────────┐
        ▼                          ▼                               ▼
   success                    transient                        known failure
        │                          │                       (validation / decline /
        │                          │                        upstream-unverified)
        │                          │                               │
 Members → Active            Members → Active                 delete PaymentHold
 enrollments → Active        enrollments → Active             rows, delete orphan
 PM row: Status=Active       PM row (upsert on                member/user if any,
                             MemberId+type+last4):            NO PM row saved,
                             Status=PendingProcessorVault     return 400 to wizard
                             recordIntegrationError(          with friendly.body so
                             priority:'high')                 EnrollmentWizard shows
                             (ops retries via                 the real reason.
                             MemberManagementModal →
                             "Add to Processor" or
                             the 15-min digest)
```

#### Classification inputs

`backend/services/dimeService.js` returns a structured error from both `createCreditCardPaymentMethod` and `tokenizeBankAccount`:

```js
{
  success: false,
  error: {
    message,          // user-facing string
    rawMessage,       // unsanitized DIME body / nested .message — used by classifier
    code,             // defaults to PAYMENT_METHOD_CREATION_ERROR
    status,           // HTTP status
    isUserActionable, // true = validation or looksLikeDecline matched
    details           // DIME .errors object (validation) if present
  }
}
```

`backend/services/individualEnrollmentRecurringSetup.js` converts that into one of three `recurringSkipReason` values:

| skip reason                        | trigger                                                             | downstream effect                                              |
| ---------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------- |
| `processor_payment_method_failed`  | `isUserActionable === true` (validation, known decline, or upstream-unverified) | Enrollment rolled back, wizard shows `friendly.body`, 400 response. **No PM row saved** — nothing usable to persist. |
| `processor_unavailable`            | 5xx, `ECONNRESET`, `ETIMEDOUT`, DNS failure, or message matches `isDimeServerError` | Enrollment proceeds; PM upserted with `PendingProcessorVault` (dedupe on `MemberId + PaymentMethodType + last4`). Integration error recorded with `priority='high'`. |
| `processor_unclassified`           | 4xx with no validation errors, no decline-phrase match, and no upstream-unverified match | Same as `processor_unavailable` — treat as transient, record with `priority='high'`. |

`DEFERRED_TRANSIENT_SKIP_REASONS` in `enrollment-links.js` whitelists both transient reasons so they hit the activate-anyway branch.

#### Known-failure catalog with user copy

Built from DIME API docs + the test CSVs + the empirical probe run. The decline regex lives at `backend/services/dimeService.js` (both `createCreditCardPaymentMethod` and `buildFriendlyDimeVaultError` use the same pattern):

```
// credit cards — DIME-native wording + HMS (Heartland Gift/Loyalty) status names
/decline|do not honor|not approved|insufficient|insufficient(activation|load)amount|expired|restricted|cvv|invalid card|invalid number|invalid ?payment ?type|invalid ?pin|avs|profile(closed|frozen|notfound|authorizationfailed)|accountnotactivated|registrationrequired|serviceunavailable/i

// ACH (tokenizeBankAccount)
/invalid routing|invalid account|nsf|insufficient|r\d{2}|closed account|no account|unable to locate/i
```

| DIME signal                                                                  | kind                 | user sees                                                                        |
| ---------------------------------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------- |
| `errors: { "data.cc_number": [...] }`                                        | validation           | "DIME Payment Processor Validation Error: cc number: …"                          |
| `errors: { "data.cc_expiration_date": [...] }`                               | validation           | Same pattern, field-specific message                                             |
| `errors: { "data.ach_routing_number": ["… must be 9 digits."] }`             | validation           | "DIME Payment Processor Validation Error: ach routing number: …"                 |
| `errors: { "data.ach_bank_account_name": ["… field is required"] }`          | validation           | "DIME Payment Processor Validation Error: ach bank account name: …"              |
| `message: "Card declined: do not honor"`                                     | decline              | Raw DIME message surfaced; wizard titles it with the failure reason              |
| `message: "Insufficient funds"`                                              | decline              | Raw DIME message                                                                 |
| `message: "Invalid routing number"`                                          | decline              | Raw DIME message                                                                 |
| `message: "Unable to locate account"`                                        | decline              | Raw DIME message                                                                 |
| `message: "Invalid response from upstream API"`                              | upstream-unverified  | Title: "We couldn't verify this card with your bank". Body: "Your bank didn't confirm this card when we tried to save it. Please double-check the card number, expiration date, and billing ZIP code, then try again — or use a different card." **Enrollment is rolled back.** (`declineReasonCode: 'UPSTREAM_UNVERIFIED'`). |
| Empty / opaque 4xx body                                                      | unclassified         | Generic "couldn't save" copy. PM upserted as `PendingProcessorVault`; ops retries from MemberManagementModal. |
| HTTP 5xx, ECONNRESET, ETIMEDOUT                                              | transient            | Same as above                                                                    |

#### Sandbox test-card catalog (for vaulting)

Source: `DP_Test_Card_Information.csv` (Heartland DP program). These are the only card numbers DIME sandbox considers "real" test PANs. They all return **HTTP 200** at `/api/payment-method/create` and can be safely vaulted during dev/testing.

| Brand      | PAN                | Exp MM/YYYY | CVV  | Billing Street   | Billing Zip |
| ---------- | ------------------ | ----------- | ---- | ---------------- | ----------- |
| Visa       | `4012002000060016` | 12/2030     | 123  | 6860 Dallas Pkwy | 75024-1234  |
| MasterCard | `2223000010005780` | 12/2030     | 900  | 6860 Dallas Pkwy | 75024       |
| MasterCard | `5473500000000014` | 12/2030     | 123  | 6860 Dallas Pkwy | 75024       |
| Discover   | `6011000990156527` | 12/2030     | 123  | 6860             | 75024-1234  |
| Amex       | `372700699251018`  | 12/2030     | 1234 | 6860             | 75024       |
| JCB        | `3566007770007321` | 12/2030     | 123  | 6860             | 75024       |

**Note:** Vaulting these cards does NOT trigger decline error codes — the sandbox's `/api/payment-method/create` is permissive. It accepts Luhn-fail PANs, expired dates, and cards designed to decline at auth. Decline codes only surface at **charge** time, per the HMS catalog below.

Sandbox ACH test values (same CSV):

| Field           | Value         |
| --------------- | ------------- |
| Routing Number  | `122000030`   |
| Account Number  | `1357902468`  |

ACH validation at vault time IS stricter than credit card — empty account name, wrong-length routing number, and similar shape errors return 400 with `errors: { "data.ach_…": [...] }`. See the validation rows in the known-failure table above.

#### Sandbox charge-time error catalog (HMS amount triggers)

Source: `HPS+TEST+Hardcode+Values+v04212016.csv` (Heartland HMS Gift/Loyalty). When charging a vaulted card in the sandbox, the **dollar amount** of the transaction — not the card number — determines the response. All **whole-dollar** amounts up to $10 return HTTP 200 "Okay". Any non-whole-dollar amount returns one of the rows below. Amounts over $10 return a partial approval.

Preconditions for triggering these: account number in range `6277200000000001`–`6277200000000099`, and phone alias in range `XXX5550100`–`XXX5550199`.

| Amount | HTTP Status | Status Name                        | Category                         | User-fixable?      | Wizard/UI treatment                                                                                             |
| ------ | ----------- | ---------------------------------- | -------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------- |
| $1.01  | 503         | `ServiceUnavailable`               | **Transient** (DIME/gateway down) | No                 | Charge retried by scheduler; if persistent, `priority='high'` system error + digest email.                      |
| $2.01  | 403         | `ProfileAuthorizationFailed`       | Known decline (account locked)   | Partial (call bank) | Decline modal with "contact your bank or use a different card" copy. Not a system error.                        |
| $2.02  | 403         | `ProfileClosed`                    | Known decline (account closed)   | Yes (use diff card) | Same as above.                                                                                                  |
| $2.03  | 403         | `ProfileNotFound`                  | Known decline                    | Yes                | Same as above.                                                                                                  |
| $2.04  | 403         | `ProfileFrozen`                    | Known decline                    | Partial             | Same as above.                                                                                                  |
| $3.01  | 400         | `InsufficientFunds`                | Known decline (NSF)              | Yes                 | Decline modal copy for NSF. Not a system error. Recurring run retries on next cycle.                            |
| $3.02  | 400         | `InsufficientActivationAmount`     | Known decline                    | Yes                 | Same decline handling.                                                                                          |
| $3.03  | 400         | `InsufficientLoadAmount`           | Known decline                    | Yes                 | Same.                                                                                                           |
| $3.04  | 400         | `InvalidPaymentType`               | Validation / setup error         | Yes                 | Surface "payment type not supported" copy, suggest different card.                                              |
| $3.05  | 400         | `InvalidPin`                       | Validation (debit PIN — N/A for us) | Yes             | Shouldn't occur; if it does, treat as validation.                                                                |
| $3.06  | 400         | `InvalidSellerProfileId`           | **Config error (our side)**      | No — engineering    | Treat as `priority='critical'` system error. Almost certainly a bad tenant-level DIME credential.                |
| $3.07  | 400         | `OrderExists`                      | Idempotency collision            | No                 | Recurring scheduler treats as success (duplicate submission).                                                   |
| $3.08  | 400         | `RegistrationRequired`             | Known decline                    | Yes                 | Decline modal.                                                                                                  |
| $3.09  | 400         | `AccountNotActivated`              | Known decline                    | Yes                 | Decline modal.                                                                                                  |
| $5.00  | 200         | `Okay` — but `order.id = "TooLateToVoid"` | Success with side-effect   | —                  | Blocks voids for this order; handle by issuing refund instead.                                                  |
| $6.00  | 200         | `Okay` — but `order.id = "OrderNotFound"` | Success with side-effect    | —                  | Blocks subsequent lookups by order id; only relevant for void/refund testing.                                    |

**Implementation notes:**

- The `looksLikeDecline` regex above matches every HMS status name in the "Known decline" rows so if DIME ever bubbles them up verbatim on a 4xx vault call we classify them as user-fixable instead of unclassified-transient.
- We don't currently exercise the HMS catalog programmatically — the probe at `ai_scripts/dime-error-probe/` only hits `/api/payment-method/create` (vault), not `/api/transaction/charge-card`. Adding a charge-phase to the probe is a future extension if we need to validate real decline wording end-to-end.
- `$3.06 InvalidSellerProfileId` and `$1.01 ServiceUnavailable` are the two rows that should _always_ be reported as system errors. Every other row in the "Known decline" category is treated as a user outcome and NOT recorded in `oe.SystemIntegrationErrors`.

#### Not recorded as system errors

Known user-fixable failures (validation, known declines, upstream-unverified) are intentionally **not** written to `oe.SystemIntegrationErrors`. They're expected outcomes of enrollees entering wrong data or their bank declining/not confirming the card — ops shouldn't get an email every time that happens.

Transient and unclassified failures DO record with `priority='high'` and feed the every-15-minute digest job (`integration-error-digest-job/IntegrationErrorDigest/`) which emails the recipients configured at `oe.SystemSettings.system.integration_error_notification_emails`.

#### Save-on-failure policy

`savePaymentMethodLocally()` in `backend/services/individualEnrollmentRecurringSetup.js` follows these rules:

| Outcome                                            | oe.MemberPaymentMethods row? | Status                   | Dedupe?                                       |
| -------------------------------------------------- | ---------------------------- | ------------------------ | --------------------------------------------- |
| DIME vault success                                 | INSERT                       | `Active`                 | Skipped if a row already exists for the same `ProcessorPaymentMethodId`. |
| Transient / unclassified (`processor_unavailable`, `processor_unclassified`) | UPSERT                       | `PendingProcessorVault`  | Yes — updates the newest existing `PendingProcessorVault` row for `(MemberId, PaymentMethodType, last4)`. |
| Known failure (`processor_payment_method_failed` — validation, decline, or upstream-unverified) | **No row saved**             | —                        | N/A                                           |
| No DIME customer (`missing_processor_customer`)    | INSERT                       | `Active`                 | — (no processor tokens; relies on audit report to catch.) |

Not persisting bad-card ciphertext aligns with PCI DSS's data-minimization principle and keeps member records clean. The dedupe on the transient path is what prevents the "stranded rows" class of bugs (e.g. Dawn Taylor, Apr 2026) where repeated DIME 400s stacked multiple orphan `PendingProcessorVault` entries per member.

#### Ops visibility

- **MemberManagementModal → Payments tab**: shows all PMs including `PendingProcessorVault`. The "Add to Processor" button remains enabled since there's no `processorPaymentMethodId` yet.
- **TenantBilling → Audit → Missing recurring**: rows where the member has a `PendingProcessorVault` PM and no `Active` PM are flagged with `reasonCode='pending_processor_vault'`, an amber highlight on the `paymentMethods` cell, and a "• N pending vault" appendix to the summary line.
- **SysAdmin → Integration Errors**: filter by `Priority = high/critical` to see only the actionable rows; the digest job stamps `NotificationSentAt` so you can see which have already been emailed.

#### PCI compliance note

`CvvEncrypted` used to live on both `oe.MemberPaymentMethods` and `oe.GroupPaymentMethods`. Storing CVV — even encrypted — violates PCI DSS 3.3.1 (sensitive authentication data MUST NOT be stored after authorization). As of `sql-changes/2026-04-21-null-all-cvv-encrypted.sql`:

- All code writes to `CvvEncrypted` have been removed.
- `encryptionService.encryptPaymentData` / `decryptPaymentData` intentionally drop any CVV fed to them.
- Existing rows have been nulled. The column itself stays for now to avoid coordinating a destructive schema change; it can be dropped in a follow-up once we confirm nothing is reading it.

Card number (PAN) stays encrypted at rest by design — it's required for the "Add to Processor" manual retry flow and for a future processor migration. PAN encryption is PCI-allowed (3.4) as long as it's strongly encrypted and keys are managed, which `encryptionService` (AES-256-GCM, env-supplied key) satisfies.

### Common DIME Errors

#### 1. Phone Number Validation Error
```
❌ DIME Validation Errors: {
  "data.phone": [
    "validation.phone"
  ]
}
```

**Solution**: Ensure phone number is in 10-digit format and not a test number (555 prefix).

#### 2. Email Already Exists
```
❌ DIME Validation Errors: {
  "data.email": [
    "The data.email has already been taken."
  ]
}
```

**Solution**: System automatically attempts to get existing customer by email.

#### 3. Phone Number Already Exists
```
❌ DIME Validation Errors: {
  "data.phone": [
    "This phone number already exists"
  ]
}
```

**Solution**: System automatically attempts to get existing customer by email.

### Error Response Structure

```json
{
  "success": false,
  "message": "Phone number is already in use by another customer. Please use a different phone number.",
  "error": {
    "message": "Phone number already exists",
    "code": "PHONE_NUMBER_CONFLICT",
    "status": 400,
    "details": {
      "data.phone": ["This phone number already exists"]
    }
  }
}
```

### Frontend Error Handling

```tsx
} else {
  const error = await response.json();
  // Show detailed error message from backend
  const errorMessage = error.error?.message || error.message || 'Failed to update payment method';
  showSnackbar(errorMessage, 'error');
  console.error('Payment method error:', error);
  // Keep modal open for any error so user can see error message and fix issues
}
```

## Webhook Integration

### Overview

DIME webhooks provide real-time notifications for payment events. The same webhook handler processes events for both individual and group payments, automatically routing them to the appropriate processing logic.

### Webhook Events

#### Supported Events
- `payment.success` - One-time payment completed
- `payment.failed` - One-time payment failed
- `recurring_payment.success` - Monthly recurring payment completed
- `recurring_payment.failed` - Monthly recurring payment failed
- `recurring_payment.schedule_updated` - Recurring payment plan modified
- `payment_method.updated` - Payment method changed
- `payment_method.deleted` - Payment method removed

### Webhook Handler

#### Route Setup
```javascript
// backend/routes/webhooks.js
const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/database');
const crypto = require('crypto');

// POST /api/webhooks/dime - Handle DIME webhook events
router.post('/dime', async (req, res) => {
  try {
    const signature = req.headers['x-dime-signature'];
    const payload = JSON.stringify(req.body);
    
    // Verify webhook signature
    if (!verifyWebhookSignature(signature, payload)) {
      console.error('❌ Invalid webhook signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }
    
    const { event_type, data } = req.body;
    
    console.log('🔔 DIME Webhook received:', { event_type, data });
    
    // Store webhook event
    const webhookEventId = await storeWebhookEvent(event_type, data);
    
    // Process based on event type
    switch (event_type) {
      case 'payment.success':
        await handlePaymentSuccess(data, webhookEventId);
        break;
      case 'payment.failed':
        await handlePaymentFailed(data, webhookEventId);
        break;
      case 'recurring_payment.success':
        await handleRecurringPaymentSuccess(data, webhookEventId);
        break;
      case 'recurring_payment.failed':
        await handleRecurringPaymentFailed(data, webhookEventId);
        break;
      case 'recurring_payment.schedule_updated':
        await handleScheduleUpdated(data, webhookEventId);
        break;
      default:
        console.log('⚠️ Unknown webhook event type:', event_type);
    }
    
    res.status(200).json({ success: true });
    
  } catch (error) {
    console.error('❌ Webhook processing error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});
```

#### Individual vs Group Payment Routing
```javascript
async function handleRecurringPaymentSuccess(data, webhookEventId) {
  // Check if this is a group or individual payment
  const isGroupPayment = data.schedule_id && data.schedule_id.includes('group');
  
  if (isGroupPayment) {
    await handleGroupRecurringPaymentSuccess(data, webhookEventId);
  } else {
    await handleIndividualRecurringPaymentSuccess(data, webhookEventId);
  }
}
```

#### Group Payment Processing
```javascript
async function handleGroupRecurringPaymentSuccess(data, webhookEventId) {
  const pool = await getPool();
  
  // Find group by recurring payment plan ID
  const groupQuery = `
    SELECT GroupId FROM oe.Groups 
    WHERE RecurringPaymentPlanId = @scheduleId
  `;
  
  const groupResult = await pool.request()
    .input('scheduleId', sql.NVarChar(255), data.schedule_id)
    .query(groupQuery);
  
  if (groupResult.recordset.length === 0) {
    console.error('❌ Group not found for schedule ID:', data.schedule_id);
    return;
  }
  
  const groupId = groupResult.recordset[0].GroupId;
  
  // Update group payment status
  await pool.request()
    .input('groupId', sql.UniqueIdentifier, groupId)
    .input('transactionId', sql.NVarChar(255), data.transaction_id)
    .input('status', sql.NVarChar(50), 'Completed')
    .input('amount', sql.Decimal(10,2), data.amount)
    .input('webhookEventId', sql.UniqueIdentifier, webhookEventId)
    .execute('oe.sp_UpdateGroupPaymentStatus');
  
  // Update next billing date (5th of next month)
  const nextBillingDate = new Date();
  nextBillingDate.setMonth(nextBillingDate.getMonth() + 1);
  nextBillingDate.setDate(5);
  
  await pool.request()
    .input('groupId', sql.UniqueIdentifier, groupId)
    .input('nextBillingDate', sql.Date, nextBillingDate)
    .query(`
      UPDATE oe.Groups 
      SET NextBillingDate = @nextBillingDate,
          LastSuccessfulPaymentDate = GETUTCDATE(),
          PaymentFailureCount = 0,
          ModifiedDate = GETUTCDATE()
      WHERE GroupId = @groupId
    `);
  
  console.log(`✅ Group ${groupId} recurring payment processed successfully`);
}
```

#### Individual Payment Processing
```javascript
async function handleIndividualRecurringPaymentSuccess(data, webhookEventId) {
  const pool = await getPool();
  
  // Find household by recurring payment plan ID or transaction ID
  const householdQuery = `
    SELECT h.HouseholdId FROM oe.Households h
    INNER JOIN oe.Members m ON h.HouseholdId = m.HouseholdId
    INNER JOIN oe.Payments p ON p.HouseholdId = h.HouseholdId
    WHERE p.RecurringScheduleId = @scheduleId
       OR p.ProcessorTransactionId = @transactionId
  `;
  
  const householdResult = await pool.request()
    .input('scheduleId', sql.NVarChar(255), data.schedule_id)
    .input('transactionId', sql.NVarChar(255), data.transaction_id)
    .query(householdQuery);
  
  if (householdResult.recordset.length === 0) {
    console.error('❌ Household not found for schedule ID:', data.schedule_id);
    return;
  }
  
  const householdId = householdResult.recordset[0].HouseholdId;
  
  // Update individual payment status
  await pool.request()
    .input('householdId', sql.UniqueIdentifier, householdId)
    .input('transactionId', sql.NVarChar(255), data.transaction_id)
    .input('status', sql.NVarChar(50), 'Completed')
    .input('webhookEventId', sql.UniqueIdentifier, webhookEventId)
    .query(`
      UPDATE oe.Payments 
      SET Status = @status,
          WebhookEventId = @webhookEventId,
          ModifiedDate = GETUTCDATE()
      WHERE ProcessorTransactionId = @transactionId
        AND HouseholdId = @householdId
    `);
  
  console.log(`✅ Household ${householdId} recurring payment processed successfully`);
}
```

### Webhook Security

#### Signature Verification
```javascript
function verifyWebhookSignature(signature, payload) {
  const expectedSignature = crypto
    .createHmac('sha256', process.env.DIME_WEBHOOK_SECRET)
    .update(payload)
    .digest('hex');
  
  return signature === `sha256=${expectedSignature}`;
}
```

#### Environment Variables
```env
# DIME Webhook Configuration
DIME_WEBHOOK_SECRET=your_webhook_secret_from_dime_dashboard
DIME_WEBHOOK_URL=https://your-domain.com/api/webhooks/dime
```

### Database Schema for Webhooks

#### Webhook Events Table
```sql
CREATE TABLE oe.DimeWebhookEvents (
    WebhookEventId UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
    EventType NVARCHAR(100) NOT NULL,
    EventId NVARCHAR(255) UNIQUE NOT NULL,
    MerchantId NVARCHAR(100) NOT NULL,
    CreatedAt DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
    Payload NVARCHAR(MAX) NOT NULL, -- JSON payload
    Processed BIT DEFAULT 0,
    ProcessedAt DATETIME2 NULL,
    ProcessingAttempts INT DEFAULT 0,
    LastProcessingAttempt DATETIME2 NULL,
    ErrorMessage NVARCHAR(MAX) NULL,
    -- Metadata
    GroupId UNIQUEIDENTIFIER NULL, -- Link to group if applicable
    MemberId UNIQUEIDENTIFIER NULL, -- Link to member if applicable
    TransactionId NVARCHAR(255) NULL, -- DIME transaction ID
    Amount DECIMAL(10,2) NULL, -- Payment amount
    Status NVARCHAR(50) NULL, -- Payment status
    CreatedDate DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
    ModifiedDate DATETIME2 NOT NULL DEFAULT GETUTCDATE()
);
```

### Webhook Monitoring

#### Failed Payment Handling
```javascript
async function handleRecurringPaymentFailed(data, webhookEventId) {
  const pool = await getPool();
  
  // Find group by recurring payment plan ID
  const groupQuery = `
    SELECT GroupId FROM oe.Groups 
    WHERE RecurringPaymentPlanId = @scheduleId
  `;
  
  const groupResult = await pool.request()
    .input('scheduleId', sql.NVarChar(255), data.schedule_id)
    .query(groupQuery);
  
  if (groupResult.recordset.length === 0) {
    console.error('❌ Group not found for schedule ID:', data.schedule_id);
    return;
  }
  
  const groupId = groupResult.recordset[0].GroupId;
  
  // Update payment status
  await pool.request()
    .input('groupId', sql.UniqueIdentifier, groupId)
    .input('transactionId', sql.NVarChar(255), data.transaction_id)
    .input('status', sql.NVarChar(50), 'Failed')
    .input('failureReason', sql.NVarChar(500), data.failure_reason || 'Payment failed')
    .input('webhookEventId', sql.UniqueIdentifier, webhookEventId)
    .execute('oe.sp_UpdateGroupPaymentStatus');
  
  // Log failure for retry logic
  await pool.request()
    .input('groupId', sql.UniqueIdentifier, groupId)
    .input('failureReason', sql.NVarChar(500), data.failure_reason || 'Payment failed')
    .input('failureCode', sql.NVarChar(100), data.error_code)
    .input('retryScheduledDate', sql.DateTime2, new Date(Date.now() + 24 * 60 * 60 * 1000)) // Retry in 24 hours
    .query(`
      INSERT INTO oe.GroupPaymentFailures (
        GroupId, FailureDate, FailureReason, FailureCode, RetryScheduledDate
      ) VALUES (
        @groupId, GETUTCDATE(), @failureReason, @failureCode, @retryScheduledDate
      )
    `);
  
  console.log(`❌ Group ${groupId} recurring payment failed:`, data.failure_reason);
}
```

## Testing

### Test Data

#### Valid Test Phone Numbers
- `7707892072` - Realistic phone number that works with DIME
- Any 10-digit number not starting with 555

#### Invalid Test Phone Numbers
- `5551234567` - DIME rejects 555 prefix
- `1234567890` - Common test pattern
- `0000000000` - All zeros
- `5555555555` - Repeated digits

### Development Features

#### Prefill Test Data Button
Available on localhost for testing:

```tsx
{isDevMode && (
  <button
    onClick={prefillTestData}
    className="px-3 py-1 text-xs bg-blue-100 text-blue-800 rounded hover:bg-blue-200"
  >
    Prefill Test Data
  </button>
)}
```

#### Test Data Prefill
```tsx
const prefillTestData = () => {
  const currentType = formData.paymentMethodType;
  if (currentType === 'ACH') {
    setFormData(prev => ({
      ...prev,
      bankName: 'Test Bank',
      accountType: 'Checking',
      routingNumber: '021000021',
      accountNumber: '1234567890',
      accountHolderName: 'John Doe',
      billingAddress: '123 Main Street',
      billingAddress2: '',
      billingCity: 'Anytown',
      billingState: 'CA',
      billingZip: '12345',
      billingCountry: 'US',
      phoneNumber: '7707892072'
    }));
  } else { // CreditCard
    setFormData(prev => ({
      ...prev,
      cardBrand: 'Visa',
      cardNumber: '4111111111111111',
      expiryMonth: 12,
      expiryYear: 2025,
      cardholderName: 'John Doe',
      billingAddress: '123 Main Street',
      billingAddress2: '',
      billingCity: 'Anytown',
      billingState: 'CA',
      billingZip: '12345',
      billingCountry: 'US',
      phoneNumber: '7707892072'
    }));
  }
  setErrors({});
};
```

### Webhook Testing

#### Test Webhook Events
Use tools like ngrok to test webhook events locally:

```bash
# Install ngrok
npm install -g ngrok

# Expose local server
ngrok http 3000

# Use the ngrok URL as your webhook endpoint in DIME dashboard
# https://abc123.ngrok.io/api/webhooks/dime
```

#### Webhook Event Simulation
```javascript
// Test webhook endpoint locally
const testWebhookEvent = {
  event_type: 'recurring_payment.success',
  data: {
    schedule_id: 'group-test-schedule-123',
    transaction_id: 'test-txn-456',
    amount: 150.00,
    status: 'completed'
  }
};

// POST to http://localhost:3000/api/webhooks/dime
```

## Troubleshooting

### Common Issues

#### 1. "Using wrong DIME endpoints" ⚠️ **CRITICAL**
**Cause**: Using tokenization endpoints for reusable payment method storage.

**Solution**: 
- Use `/api/payment-method/create` for storing payment methods
- Use `/api/transaction/charge-card` or `/api/transaction/charge-ach` for processing payments
- Update all payment method creation to use the correct endpoints

#### 2. "Invalid column name 'ProcessorToken'"
**Cause**: Missing database columns for DIME integration.

**Solution**: Run the database update scripts:
```sql
-- For GroupPaymentMethods
ALTER TABLE [oe].[GroupPaymentMethods]
ADD ProcessorToken NVARCHAR(255) NULL;

-- For Members and Groups
ALTER TABLE [oe].[Members]
ADD ProcessorCustomerId NVARCHAR(255) NULL;

ALTER TABLE [oe].[Groups]
ADD ProcessorCustomerId NVARCHAR(255) NULL;
```

#### 3. "Phone number validation failed"
**Cause**: Using test phone numbers or wrong format.

**Solution**: 
- Use 10-digit format without country code
- Avoid 555 prefix
- Use realistic phone numbers like `7707892072`

#### 4. "Customer creation failed"
**Cause**: Missing required fields or validation errors.

**Solution**:
- Ensure all required fields are provided
- Check phone number format
- Verify email format
- Check billing address completeness

#### 5. "Payment method creation failed"
**Cause**: Using wrong endpoint or missing customer ID.

**Solution**:
- Use `/api/payment-method/create` instead of tokenization endpoints
- Ensure customer exists in DIME first (customer ID required)
- Validate card number with Luhn algorithm
- Check expiry date format (MM/YYYY)
- Verify CVV is 3-4 digits

#### 6. "Payment processing errors"
**Cause**: Using wrong payment processing approach.

**Solution**:
- Use stored payment method tokens for recurring payments
- Use `/api/transaction/charge-card` or `/api/transaction/charge-ach` endpoints
- Ensure payment method ID is valid and active

#### 7. "401 Unauthenticated" errors
**Cause**: Using wrong header format for DIME API calls.

**Solution**:
- Use `Authorization: Bearer ${apiToken}` instead of `client_key: ${apiToken}`
- Ensure you're using `getHeaders()` method, not `getJWTHeaders()`
- Verify API token is correctly loaded from environment variables

```javascript
// ❌ Wrong - causes 401 errors
headers: {
  'client_key': apiToken,
  'Content-Type': 'application/json'
}

// ✅ Correct - works perfectly
headers: {
  'Authorization': `Bearer ${apiToken}`,
  'Content-Type': 'application/json'
}
```

### Debug Logging

Enable debug logging by checking the console for these messages:

```
🔍 DEBUG: Phone formatting: { original: '7707892072', formatted: '+17707892072', willUseDefault: false }
🔍 DEBUG: Final phone number for DIME: 7707892072
🔍 DEBUG: Creating customer with DIME: { ... }
✅ DIME Customer Creation Success: { success: true, customerId: '...' }
```

### Environment Variables Check

Verify your environment variables are loaded:

```javascript
console.log('DIME Config:', {
  apiToken: process.env.DIME_DEMO_API_TOKEN ? 'Set' : 'Missing',
  sid: process.env.DIME_DEMO_SID ? 'Set' : 'Missing',
  baseUrl: process.env.DIME_DEMO_BASE_URL ? 'Set' : 'Missing'
});
```

## Best Practices

### 1. Always Validate Phone Numbers
```tsx
// Frontend validation
const phoneDigits = phoneNumber.replace(/\D/g, '');
if (phoneDigits.length < 10) {
  // Show error
}
```

### 2. Handle Customer Creation Gracefully
```javascript
// Backend - Check for existing customer first
let dimeCustomerId = existingCustomerResult.recordset[0]?.ProcessorCustomerId;
if (!dimeCustomerId) {
  const customerResult = await DimeService.createCustomer(customerData);
  if (!customerResult.success) {
    // Handle error gracefully
    return res.status(500).json({
      success: false,
      message: 'Failed to create customer in payment processor',
      error: customerResult.error
    });
  }
  dimeCustomerId = customerResult.customerId;
}
```

### 3. Store DIME IDs Immediately
```javascript
// Store DIME customer ID as soon as it's created
await pool.request()
  .input('groupId', sql.UniqueIdentifier, groupId)
  .input('customerId', sql.NVarChar(255), dimeCustomerId)
  .query(`
    UPDATE oe.Groups 
    SET ProcessorCustomerId = @customerId, ModifiedDate = GETUTCDATE()
    WHERE GroupId = @groupId
  `);
```

### 4. Validate Payment Methods on Load
```javascript
// Validate DIME payment methods when loading
for (const paymentMethod of paymentMethodResult.recordset) {
  if (paymentMethod.ProcessorToken && paymentMethod.ProcessorCustomerId) {
    try {
      const validation = await DimeService.validatePaymentMethod(
        paymentMethod.ProcessorToken, 
        paymentMethod.ProcessorCustomerId
      );
      
      if (!validation.isValid) {
        // Mark as inactive in database
        await updateRequest.query(updateQuery);
        continue; // Skip adding to results
      }
    } catch (validationError) {
      console.error('Error validating payment method:', validationError);
    }
  }
}
```

### 5. Use Realistic Test Data
```javascript
// Use realistic phone numbers for testing
const testPhoneNumbers = [
  '7707892072',  // Atlanta area
  '4155551234',  // San Francisco area
  '2125551234'   // New York area
];
```

---

## Support

For issues or questions about DIME integration:

1. Check the console logs for debug information
2. Verify environment variables are set correctly
3. Ensure database schema is up to date
4. Test with realistic phone numbers
5. Check DIME API documentation for latest changes

## Action Plan & Next Steps

### Immediate Actions Required

1. **Update DimeService** - Replace tokenization methods with payment method creation methods
2. **Update PaymentMethodService** - Modify to use new DimeService methods
3. **Remove Sensitive Data Storage** - Stop storing raw payment data in database
4. **Update Payment Processing** - Use stored tokens for all payment processing
5. **Test All Payment Flows** - Ensure everything works with correct endpoints

### Why This Matters

The reason we've been having issues is because we've been trying to use one-time tokenization endpoints for reusable payment method storage. DIME's `/api/payment-method/create` endpoint is specifically designed for storing reusable payment methods, while the tokenization endpoints are for immediate one-time use.

This explains why we've been getting errors and why the payment processing hasn't been working correctly - we've been using the wrong DIME API endpoints entirely.

### Expected Benefits After Fix

- ✅ Proper PCI compliance (no raw payment data stored)
- ✅ Reliable payment method storage and retrieval
- ✅ Correct recurring payment processing
- ✅ Better error handling and debugging
- ✅ Full DIME API feature utilization

## Group Recurring Payment Management - Scheduled Job Approach

### Overview

Group recurring payments use a **scheduled job** that runs on the **1st of each month** to calculate and sync payment amounts to DIME for the upcoming billing cycle (5th of the month).

### Why Scheduled Jobs?

**Problems with Real-Time Updates:**
- Race conditions when multiple enrollments complete simultaneously
- DIME API has no direct update endpoint (must cancel/recreate)
- Concurrent API calls could create conflicting schedules

**Benefits:**
- Single atomic operation processes all groups sequentially
- No race conditions
- Billing integrity - changes only affect next cycle
- Predictable behavior

### Business Logic

```
During Month:
  Member enrolls → Database MonthlyAmount updated → DIME unchanged

1st of Month:
  Scheduled job runs:
  ├─ Calculate premium for 5th (using sp_CalculateGroupTotalPremium)
  ├─ Cancel old DIME schedule
  ├─ Create new DIME schedule (start_date = 5th, updated amount)
  └─ Update database with new schedule ID

5th of Month:
  DIME automatically charges groups with updated amounts
```

### Stored Procedure Date Filtering

The `sp_CalculateGroupTotalPremium` filters enrollments by billing date:

```sql
WHERE e.EffectiveDate <= @BillingDate
  AND (e.TerminationDate IS NULL OR e.TerminationDate > @BillingDate)
  AND e.Status = 'Active'
```

**Examples (Billing Date = Nov 5):**
- EffectiveDate = Nov 1 → ✅ Included
- EffectiveDate = Nov 10 → ❌ Excluded (not effective yet)
- TerminationDate = Nov 3 → ❌ Excluded (already terminated)

### DIME Recurring Payment Update

**DIME has no update endpoint.** Solution: Cancel and recreate.

```javascript
// Step 1: Cancel old schedule
POST /api/recurring-payment/{scheduleId}/cancel
{
  "data": { "sid": "00119" }
}

// Step 2: Create new schedule
POST /api/recurring-payment/create
{
  "data": {
    "sid": "00119",
    "amount": 3154.00,  // Updated amount
    "start_date": "2025-11-05 00:00:00",  // Billing date (5th)
    "end_date": "2025-12-01 00:00:00",    // End on 1st of next month (25-day window)
    "recurrence_schedule": "Monthly",
    "payment_method": "120",
    "customer_uuid": "customer-uuid"
  }
}

// Note: end_date is set to 1st of next month (25-day window)
// This prevents accidental double-runs and allows time to verify charge succeeded
// Scheduler cancels ALL existing schedules before creating new one
```

### Scheduled Job Setup

**⚠️ IMPORTANT: Use Azure Logic App in production, NOT node-cron**

Node-cron is unreliable in Azure App Service (restarts lose cron jobs). Use Azure Logic App for guaranteed execution.

**Endpoint:** `POST /api/scheduled-jobs/monthly-recurring-payments`

**Schedule:** 1st of every month at 6:00 AM

**Azure Logic App (Required for Production):**
- See [`azure-scheduler-setup.md`](../deployment/azure-scheduler-setup.md) for complete setup instructions
- Monthly recurrence trigger on 1st at 6:00 AM
- HTTP POST to backend scheduler endpoint
- Built-in monitoring and failure alerts
- Cost: ~$0.01/month

**Node-Cron (Development Only):**
```javascript
// Only for local development - DO NOT use in production
const cron = require('node-cron');
cron.schedule('0 6 1 * *', async () => {
  await groupPaymentScheduler.calculateMonthlyRecurringPayments();
});
```

### Manual Execution (Testing/Debugging)

**Run the scheduler manually:**
```bash
cd backend
node run-payment-scheduler.cjs
```

**Or via API:**
```bash
curl -X POST http://localhost:3000/api/scheduled-jobs/monthly-recurring-payments
```

**Check if job is due:**
```bash
curl http://localhost:3000/api/scheduled-jobs/monthly-recurring-payments/status
```

### Implementation Files

- `backend/services/groupPaymentScheduler.js` - Monthly calculation logic
- `backend/routes/scheduled-jobs.js` - API endpoint for scheduler
- `backend/services/groupPaymentService.js` - Enrollment completion (database update only)
- `backend/run-payment-scheduler.cjs` - Manual execution script

---

