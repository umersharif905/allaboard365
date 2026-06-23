# DIME Webhooks Implementation Guide

## 📋 Current Status

**⚠️ WEBHOOKS NOT YET IMPLEMENTED**

This document provides a complete guide to implementing DIME webhooks for payment event handling.

---

## 🎯 Supported Webhook Events

### Payment Events (One-Time)
1. **`payment.success`** - One-time payment completed successfully
2. **`payment.failed`** - One-time payment failed

### Recurring Payment Events (Monthly Subscriptions)
3. **`recurring_payment.success`** - Monthly recurring payment completed
4. **`recurring_payment.failed`** - Monthly recurring payment failed
5. **`recurring_payment.schedule_updated`** - Payment schedule was modified
6. **`recurring_payment.schedule_canceled`** - Payment schedule was canceled

### Payment Method Events
7. **`payment_method.updated`** - Customer updated their payment method
8. **`payment_method.deleted`** - Payment method was removed

---

## 🏗️ Implementation Steps

### **Step 1: Create Webhook Route**

Create `backend/routes/webhooks.js`:

```javascript
const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/database');
const crypto = require('crypto');

/**
 * Verify DIME webhook signature
 * DIME sends a signature in the x-dime-signature header
 */
function verifyWebhookSignature(signature, payload) {
  const webhookSecret = process.env.DIME_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.warn('⚠️ DIME_WEBHOOK_SECRET not configured');
    return false;
  }
  
  const hmac = crypto.createHmac('sha256', webhookSecret);
  const digest = hmac.update(payload).digest('hex');
  
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(digest)
  );
}

/**
 * Store webhook event for audit trail
 */
async function storeWebhookEvent(eventType, data) {
  const pool = await getPool();
  
  const result = await pool.request()
    .input('eventType', sql.NVarChar(100), eventType)
    .input('eventId', sql.NVarChar(255), data.event_id || data.id)
    .input('merchantId', sql.NVarChar(100), data.merchant_id)
    .input('payload', sql.NVarChar(sql.MAX), JSON.stringify(data))
    .input('transactionId', sql.NVarChar(255), data.transaction_id)
    .input('amount', sql.Decimal(10, 2), data.amount)
    .input('status', sql.NVarChar(50), data.status)
    .query(`
      INSERT INTO oe.DimeWebhookEvents (
        EventType, EventId, MerchantId, Payload, TransactionId, Amount, Status,
        Processed, CreatedDate, ModifiedDate
      ) VALUES (
        @eventType, @eventId, @merchantId, @payload, @transactionId, @amount, @status,
        0, GETUTCDATE(), GETUTCDATE()
      );
      SELECT SCOPE_IDENTITY() as WebhookEventId;
    `);
  
  return result.recordset[0].WebhookEventId;
}

/**
 * Mark webhook as processed
 */
async function markWebhookProcessed(webhookEventId, success, errorMessage = null) {
  const pool = await getPool();
  
  await pool.request()
    .input('webhookEventId', sql.Int, webhookEventId)
    .input('processed', sql.Bit, success ? 1 : 0)
    .input('errorMessage', sql.NVarChar(sql.MAX), errorMessage)
    .query(`
      UPDATE oe.DimeWebhookEvents
      SET Processed = @processed,
          ProcessedAt = GETUTCDATE(),
          ProcessingAttempts = ProcessingAttempts + 1,
          LastProcessingAttempt = GETUTCDATE(),
          ErrorMessage = @errorMessage,
          ModifiedDate = GETUTCDATE()
      WHERE WebhookEventId = @webhookEventId
    `);
}

// POST /api/webhooks/dime - Main webhook endpoint
router.post('/dime', async (req, res) => {
  let webhookEventId = null;
  
  try {
    const signature = req.headers['x-dime-signature'];
    const payload = JSON.stringify(req.body);
    
    // Verify webhook signature (security!)
    if (!verifyWebhookSignature(signature, payload)) {
      console.error('❌ Invalid webhook signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }
    
    const { event_type, data } = req.body;
    
    console.log('🔔 DIME Webhook received:', { event_type, data });
    
    // Store webhook event for audit trail
    webhookEventId = await storeWebhookEvent(event_type, data);
    
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
      case 'recurring_payment.schedule_canceled':
        await handleScheduleCanceled(data, webhookEventId);
        break;
      default:
        console.log('⚠️ Unknown webhook event type:', event_type);
    }
    
    // Mark as successfully processed
    await markWebhookProcessed(webhookEventId, true);
    
    // Always return 200 to acknowledge receipt
    res.status(200).json({ success: true });
    
  } catch (error) {
    console.error('❌ Webhook processing error:', error);
    
    if (webhookEventId) {
      await markWebhookProcessed(webhookEventId, false, error.message);
    }
    
    // Still return 200 to prevent DIME from retrying
    res.status(200).json({ success: false, error: error.message });
  }
});

/**
 * Handle one-time payment success
 */
async function handlePaymentSuccess(data, webhookEventId) {
  const pool = await getPool();
  
  console.log('✅ Processing payment success:', data.transaction_id);
  
  // Update payment record
  await pool.request()
    .input('transactionId', sql.NVarChar(255), data.transaction_id)
    .input('status', sql.NVarChar(50), 'Completed')
    .input('processedDate', sql.DateTime2, new Date())
    .query(`
      UPDATE oe.Payments 
      SET Status = @status, 
          ProcessedDate = @processedDate,
          ModifiedDate = GETUTCDATE()
      WHERE ProcessorTransactionId = @transactionId
    `);
  
  console.log('✅ Payment marked as completed');
}

/**
 * Handle one-time payment failure
 */
async function handlePaymentFailed(data, webhookEventId) {
  const pool = await getPool();
  
  console.log('❌ Processing payment failure:', data.transaction_id);
  
  // Update payment record with failure info
  await pool.request()
    .input('transactionId', sql.NVarChar(255), data.transaction_id)
    .input('status', sql.NVarChar(50), 'Failed')
    .input('failureReason', sql.NVarChar(sql.MAX), data.failure_reason || data.error_message)
    .query(`
      UPDATE oe.Payments 
      SET Status = @status, 
          FailureReason = @failureReason,
          ModifiedDate = GETUTCDATE()
      WHERE ProcessorTransactionId = @transactionId
    `);
  
  console.log('❌ Payment marked as failed');
  
  // TODO: Send failure notification email to member
}

/**
 * Handle recurring payment success
 * Routes to group or individual handler
 */
async function handleRecurringPaymentSuccess(data, webhookEventId) {
  const pool = await getPool();
  
  console.log('✅ Processing recurring payment success:', data.schedule_id);
  
  // Check if this is a group payment
  const groupCheck = await pool.request()
    .input('scheduleId', sql.NVarChar(255), data.schedule_id)
    .query(`
      SELECT GroupId 
      FROM oe.GroupRecurringPaymentPlans 
      WHERE DimeScheduleId = @scheduleId
    `);
  
  if (groupCheck.recordset.length > 0) {
    // Group payment
    await handleGroupRecurringPaymentSuccess(data, webhookEventId);
  } else {
    // Individual payment
    await handleIndividualRecurringPaymentSuccess(data, webhookEventId);
  }
}

/**
 * Handle group recurring payment success
 */
async function handleGroupRecurringPaymentSuccess(data, webhookEventId) {
  const pool = await getPool();
  
  console.log('✅ Processing group recurring payment success');
  
  // Record payment in GroupPayments table
  await pool.request()
    .input('scheduleId', sql.NVarChar(255), data.schedule_id)
    .input('transactionId', sql.NVarChar(255), data.transaction_id)
    .input('amount', sql.Decimal(10, 2), data.amount)
    .input('paymentDate', sql.DateTime2, new Date(data.payment_date))
    .input('status', sql.NVarChar(50), 'Completed')
    .query(`
      DECLARE @GroupId UNIQUEIDENTIFIER;
      
      SELECT @GroupId = GroupId 
      FROM oe.GroupRecurringPaymentPlans 
      WHERE DimeScheduleId = @scheduleId;
      
      IF @GroupId IS NOT NULL
      BEGIN
        INSERT INTO oe.GroupPayments (
          PaymentId, GroupId, Amount, PaymentDate, PaymentMethod, 
          ProcessorTransactionId, Status, CreatedDate, ModifiedDate
        ) VALUES (
          NEWID(), @GroupId, @amount, @paymentDate, 'CreditCard',
          @transactionId, @status, GETUTCDATE(), GETUTCDATE()
        );
        
        -- Update webhook event with group ID
        UPDATE oe.DimeWebhookEvents
        SET GroupId = @GroupId
        WHERE WebhookEventId = @webhookEventId;
      END
    `);
  
  console.log('✅ Group payment recorded');
}

/**
 * Handle individual recurring payment success
 */
async function handleIndividualRecurringPaymentSuccess(data, webhookEventId) {
  const pool = await getPool();
  
  console.log('✅ Processing individual recurring payment success');
  
  // Record payment in Payments table
  await pool.request()
    .input('scheduleId', sql.NVarChar(255), data.schedule_id)
    .input('transactionId', sql.NVarChar(255), data.transaction_id)
    .input('amount', sql.Decimal(10, 2), data.amount)
    .input('paymentDate', sql.DateTime2, new Date(data.payment_date))
    .input('status', sql.NVarChar(50), 'Completed')
    .query(`
      DECLARE @MemberId UNIQUEIDENTIFIER;
      DECLARE @EnrollmentId UNIQUEIDENTIFIER;
      
      -- Find member and enrollment from recurring schedule
      SELECT @MemberId = MemberId, @EnrollmentId = EnrollmentId
      FROM oe.MemberRecurringPayments 
      WHERE DimeScheduleId = @scheduleId;
      
      IF @MemberId IS NOT NULL
      BEGIN
        INSERT INTO oe.Payments (
          PaymentId, MemberId, EnrollmentId, Amount, PaymentDate, PaymentMethod,
          ProcessorTransactionId, Status, CreatedDate, ModifiedDate
        ) VALUES (
          NEWID(), @MemberId, @EnrollmentId, @amount, @paymentDate, 'CreditCard',
          @transactionId, @status, GETUTCDATE(), GETUTCDATE()
        );
        
        -- Update webhook event with member ID
        UPDATE oe.DimeWebhookEvents
        SET MemberId = @MemberId
        WHERE WebhookEventId = @webhookEventId;
      END
    `);
  
  console.log('✅ Individual payment recorded');
}

/**
 * Handle recurring payment failure
 */
async function handleRecurringPaymentFailed(data, webhookEventId) {
  const pool = await getPool();
  
  console.log('❌ Processing recurring payment failure:', data.schedule_id);
  
  // Check if group or individual
  const groupCheck = await pool.request()
    .input('scheduleId', sql.NVarChar(255), data.schedule_id)
    .query(`
      SELECT GroupId, g.Name as GroupName, g.PrimaryContact, g.ContactEmail
      FROM oe.GroupRecurringPaymentPlans grp
      INNER JOIN oe.Groups g ON grp.GroupId = g.GroupId
      WHERE grp.DimeScheduleId = @scheduleId
    `);
  
  if (groupCheck.recordset.length > 0) {
    // Group payment failure
    const group = groupCheck.recordset[0];
    
    // Record failure
    await pool.request()
      .input('groupId', sql.UniqueIdentifier, group.GroupId)
      .input('scheduleId', sql.NVarChar(255), data.schedule_id)
      .input('amount', sql.Decimal(10, 2), data.amount)
      .input('failureReason', sql.NVarChar(sql.MAX), data.failure_reason || data.error_message)
      .query(`
        INSERT INTO oe.GroupPaymentFailures (
          FailureId, GroupId, ScheduleId, Amount, FailureReason, FailureDate, CreatedDate
        ) VALUES (
          NEWID(), @groupId, @scheduleId, @amount, @failureReason, GETUTCDATE(), GETUTCDATE()
        )
      `);
    
    console.log(`❌ Group payment failure recorded for ${group.GroupName}`);
    
    // TODO: Send failure notification email to group admin
    
  } else {
    // Individual payment failure
    await pool.request()
      .input('scheduleId', sql.NVarChar(255), data.schedule_id)
      .input('amount', sql.Decimal(10, 2), data.amount)
      .input('failureReason', sql.NVarChar(sql.MAX), data.failure_reason || data.error_message)
      .input('paymentDate', sql.DateTime2, new Date())
      .query(`
        DECLARE @MemberId UNIQUEIDENTIFIER;
        DECLARE @EnrollmentId UNIQUEIDENTIFIER;
        
        SELECT @MemberId = MemberId, @EnrollmentId = EnrollmentId
        FROM oe.MemberRecurringPayments 
        WHERE DimeScheduleId = @scheduleId;
        
        IF @MemberId IS NOT NULL
        BEGIN
          INSERT INTO oe.Payments (
            PaymentId, MemberId, EnrollmentId, Amount, PaymentDate, PaymentMethod,
            Status, FailureReason, CreatedDate, ModifiedDate
          ) VALUES (
            NEWID(), @MemberId, @EnrollmentId, @amount, @paymentDate, 'CreditCard',
            'Failed', @failureReason, GETUTCDATE(), GETUTCDATE()
          );
        END
      `);
    
    console.log('❌ Individual payment failure recorded');
    
    // TODO: Send failure notification email to member
  }
}

/**
 * Handle schedule updated event
 */
async function handleScheduleUpdated(data, webhookEventId) {
  console.log('ℹ️ Recurring payment schedule updated:', data.schedule_id);
  // This is informational - our monthly scheduler handles updates
}

/**
 * Handle schedule canceled event
 */
async function handleScheduleCanceled(data, webhookEventId) {
  const pool = await getPool();
  
  console.log('⚠️ Recurring payment schedule canceled:', data.schedule_id);
  
  // Mark as inactive in our database
  await pool.request()
    .input('scheduleId', sql.NVarChar(255), data.schedule_id)
    .query(`
      -- Check if group payment
      UPDATE oe.GroupRecurringPaymentPlans
      SET IsActive = 0, ModifiedDate = GETUTCDATE()
      WHERE DimeScheduleId = @scheduleId;
      
      -- Check if individual payment
      UPDATE oe.MemberRecurringPayments
      SET IsActive = 0, ModifiedDate = GETUTCDATE()
      WHERE DimeScheduleId = @scheduleId;
    `);
}

module.exports = router;
```

---

### **Step 2: Register Webhook Route**

Update `backend/app.js`:

```javascript
// Add near other route imports
const webhooksRoutes = require('./routes/webhooks');

// Add after other route mounts
app.use('/api/webhooks', webhooksRoutes);
```

---

### **Step 3: Create Database Tables**

Run this SQL script:

```sql
-- Webhook Events Table (audit trail)
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'DimeWebhookEvents' AND schema_id = SCHEMA_ID('oe'))
BEGIN
    CREATE TABLE oe.DimeWebhookEvents (
        WebhookEventId INT IDENTITY(1,1) PRIMARY KEY,
        EventType NVARCHAR(100) NOT NULL,
        EventId NVARCHAR(255) UNIQUE NOT NULL,
        MerchantId NVARCHAR(100) NOT NULL,
        Payload NVARCHAR(MAX) NOT NULL, -- JSON payload
        
        -- Processing tracking
        Processed BIT DEFAULT 0,
        ProcessedAt DATETIME2 NULL,
        ProcessingAttempts INT DEFAULT 0,
        LastProcessingAttempt DATETIME2 NULL,
        ErrorMessage NVARCHAR(MAX) NULL,
        
        -- Linked entities
        GroupId UNIQUEIDENTIFIER NULL,
        MemberId UNIQUEIDENTIFIER NULL,
        TransactionId NVARCHAR(255) NULL,
        Amount DECIMAL(10,2) NULL,
        Status NVARCHAR(50) NULL,
        
        CreatedDate DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
        ModifiedDate DATETIME2 NOT NULL DEFAULT GETUTCDATE()
    );
    
    CREATE INDEX IX_DimeWebhookEvents_EventType ON oe.DimeWebhookEvents(EventType);
    CREATE INDEX IX_DimeWebhookEvents_Processed ON oe.DimeWebhookEvents(Processed);
    CREATE INDEX IX_DimeWebhookEvents_GroupId ON oe.DimeWebhookEvents(GroupId);
    CREATE INDEX IX_DimeWebhookEvents_MemberId ON oe.DimeWebhookEvents(MemberId);
    
    PRINT '✅ Created DimeWebhookEvents table';
END
GO

-- Group Payment Failures Table
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'GroupPaymentFailures' AND schema_id = SCHEMA_ID('oe'))
BEGIN
    CREATE TABLE oe.GroupPaymentFailures (
        FailureId UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
        GroupId UNIQUEIDENTIFIER NOT NULL,
        ScheduleId NVARCHAR(255) NOT NULL,
        Amount DECIMAL(10,2) NOT NULL,
        FailureReason NVARCHAR(MAX) NULL,
        FailureDate DATETIME2 NOT NULL,
        Resolved BIT DEFAULT 0,
        ResolvedDate DATETIME2 NULL,
        CreatedDate DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
        
        FOREIGN KEY (GroupId) REFERENCES oe.Groups(GroupId)
    );
    
    CREATE INDEX IX_GroupPaymentFailures_GroupId ON oe.GroupPaymentFailures(GroupId);
    CREATE INDEX IX_GroupPaymentFailures_Resolved ON oe.GroupPaymentFailures(Resolved);
    
    PRINT '✅ Created GroupPaymentFailures table';
END
GO
```

---

### **Step 4: Add Environment Variable**

Add to `.env`:

```env
# DIME Webhook Configuration
DIME_WEBHOOK_SECRET=your_webhook_secret_from_dime_dashboard
```

---

### **Step 5: Configure Webhook in DIME Dashboard**

1. **Log in to DIME Demo Dashboard**: https://demo.dimepayments.com
2. **Go to Settings → Webhooks**
3. **Add New Webhook**:
   - **URL**: `https://your-domain.com/api/webhooks/dime`
   - **For local testing**: Use ngrok (see testing section below)
   - **Events to Subscribe**:
     - ✅ `payment.success`
     - ✅ `payment.failed`
     - ✅ `recurring_payment.success`
     - ✅ `recurring_payment.failed`
     - ✅ `recurring_payment.schedule_updated`
     - ✅ `recurring_payment.schedule_canceled`
4. **Save** and copy the **Webhook Secret** to your `.env` file

---

## 🧪 Testing Webhooks Locally

### **Option 1: Using ngrok (Recommended)**

1. **Install ngrok**: https://ngrok.com/download

2. **Start your backend server**:
   ```bash
   cd backend
   npm start
   ```

3. **Start ngrok tunnel**:
   ```bash
   ngrok http 3000
   ```

4. **Copy the ngrok URL** (e.g., `https://abc123.ngrok.io`)

5. **Configure webhook in DIME**:
   - URL: `https://abc123.ngrok.io/api/webhooks/dime`

6. **Test by triggering a payment in DIME demo**

7. **View webhook logs** in your terminal

### **Option 2: Manual Testing with curl**

Create test webhook payloads and send them to your local server:

```bash
# Test payment success
curl -X POST http://localhost:3000/api/webhooks/dime \
  -H "Content-Type: application/json" \
  -H "x-dime-signature: test_signature_here" \
  -d '{
    "event_type": "payment.success",
    "data": {
      "event_id": "evt_test_123",
      "merchant_id": "00119",
      "transaction_id": "txn_test_456",
      "amount": 250.00,
      "status": "completed",
      "payment_date": "2025-10-07T12:00:00Z"
    }
  }'

# Test recurring payment success
curl -X POST http://localhost:3000/api/webhooks/dime \
  -H "Content-Type: application/json" \
  -H "x-dime-signature: test_signature_here" \
  -d '{
    "event_type": "recurring_payment.success",
    "data": {
      "event_id": "evt_test_789",
      "merchant_id": "00119",
      "schedule_id": "17",
      "transaction_id": "txn_test_101112",
      "amount": 2954.00,
      "status": "completed",
      "payment_date": "2025-11-05T12:00:00Z"
    }
  }'

# Test payment failure
curl -X POST http://localhost:3000/api/webhooks/dime \
  -H "Content-Type: application/json" \
  -H "x-dime-signature: test_signature_here" \
  -d '{
    "event_type": "recurring_payment.failed",
    "data": {
      "event_id": "evt_test_999",
      "merchant_id": "00119",
      "schedule_id": "17",
      "transaction_id": "txn_test_failed",
      "amount": 2954.00,
      "status": "failed",
      "failure_reason": "Insufficient funds",
      "payment_date": "2025-11-05T12:00:00Z"
    }
  }'
```

**Note**: For local testing without signature verification, temporarily comment out the signature check in the webhook handler.

---

## 🔍 Monitoring Webhooks

### **View Webhook Events**

```sql
-- Recent webhook events
SELECT TOP 20
    EventType,
    EventId,
    TransactionId,
    Amount,
    Status,
    Processed,
    ProcessedAt,
    ErrorMessage,
    CreatedDate
FROM oe.DimeWebhookEvents
ORDER BY CreatedDate DESC;

-- Failed webhook processing
SELECT *
FROM oe.DimeWebhookEvents
WHERE Processed = 0 OR ErrorMessage IS NOT NULL
ORDER BY CreatedDate DESC;

-- Group payment failures
SELECT 
    g.Name as GroupName,
    gpf.Amount,
    gpf.FailureReason,
    gpf.FailureDate,
    gpf.Resolved
FROM oe.GroupPaymentFailures gpf
INNER JOIN oe.Groups g ON gpf.GroupId = g.GroupId
WHERE gpf.Resolved = 0
ORDER BY gpf.FailureDate DESC;
```

---

## 🚨 Important Notes

1. **Always return 200 status** - Even if processing fails, return 200 to prevent DIME from retrying
2. **Idempotency** - Use `EventId` to prevent duplicate processing
3. **Signature verification** - Always verify webhook signatures in production
4. **Audit trail** - Store all webhook events for debugging
5. **Error handling** - Gracefully handle errors and log them
6. **Notification emails** - Implement email notifications for payment failures

---

## 📧 Next Steps: Email Notifications

After webhooks are working, implement email notifications:

1. **Payment failure emails** to members
2. **Group payment failure emails** to group admins
3. **Payment success confirmations**
4. **Recurring payment reminders** before charge date

---

## ✅ Testing Checklist

- [ ] Webhook route created and registered
- [ ] Database tables created
- [ ] Environment variable set
- [ ] DIME webhook configured
- [ ] Signature verification working
- [ ] Test payment.success event
- [ ] Test payment.failed event
- [ ] Test recurring_payment.success event
- [ ] Test recurring_payment.failed event
- [ ] Group payments recorded correctly
- [ ] Individual payments recorded correctly
- [ ] Audit trail working
- [ ] Error handling working
- [ ] Monitoring queries working

---

## 🎯 Implementation Priority

**Phase 1 (Critical):**
- ✅ Create webhook route
- ✅ Database tables
- ✅ Signature verification
- ✅ Handle `recurring_payment.success`
- ✅ Handle `recurring_payment.failed`

**Phase 2 (Important):**
- ✅ Handle `payment.success`
- ✅ Handle `payment.failed`
- ✅ Email notifications for failures
- ✅ Monitoring dashboard

**Phase 3 (Nice to have):**
- ✅ Handle schedule updates
- ✅ Handle payment method changes
- ✅ Advanced analytics


