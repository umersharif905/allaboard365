# Testing Twilio SMS Webhook with Postman

## Quick Test Instructions

### 1. Basic Test (No Signature Verification)

**Method:** `POST`  
**URL:** `https://devapi.open-enroll.com/api/webhooks/twilio-sms`

**Headers:**
```
Content-Type: application/x-www-form-urlencoded
```

**Body (x-www-form-urlencoded):**
```
MessageSid: SM1234567890abcdef1234567890abcdef
AccountSid: AC1234567890abcdef1234567890abcdef
From: +19046379244
To: +18889720474
Body: Test message from Postman
MessageStatus: 
NumMedia: 0
```

**Expected Response:**
- Status: `200 OK`
- Content-Type: `text/xml`
- Body: `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`

**What to Check in Logs:**
```
🔔 [WEBHOOK] POST / - IP: [your-ip] - [timestamp]
📱 [request-id] Received Twilio SMS webhook at [timestamp]
📱 [request-id] Message SID: SM1234567890abcdef1234567890abcdef
📱 [request-id] From: +19046379244
📱 [request-id] To: +18889720474
📱 [request-id] Body: Test message from Postman
```

---

## 2. Test with Real Twilio Account SID

**Important:** Use your actual `AccountSid` from Twilio Console so the webhook can find your vendor.

**Body (x-www-form-urlencoded):**
```
MessageSid: SM1234567890abcdef1234567890abcdef
AccountSid: AC_YOUR_ACTUAL_TWILIO_ACCOUNT_SID
From: +19046379244
To: +18889720474
Body: Test message with real Account SID
MessageStatus: 
NumMedia: 0
```

**Replace:**
- `AC_YOUR_ACTUAL_TWILIO_ACCOUNT_SID` with your real Twilio Account SID (found in Twilio Console)

---

## 3. Test STOP Command

**Body (x-www-form-urlencoded):**
```
MessageSid: SM1234567890abcdef1234567890abcdef
AccountSid: AC_YOUR_ACTUAL_TWILIO_ACCOUNT_SID
From: +19046379244
To: +18889720474
Body: STOP
MessageStatus: 
NumMedia: 0
```

**Expected Response:**
- Status: `200 OK`
- Content-Type: `text/xml`
- Body contains: `<Message>You have been unsubscribed from SMS messages...</Message>`

---

## 4. Test Status Update (Outbound Message Status)

**Body (x-www-form-urlencoded):**
```
MessageSid: SM1234567890abcdef1234567890abcdef
AccountSid: AC_YOUR_ACTUAL_TWILIO_ACCOUNT_SID
From: +19046379244
To: +18889720474
Body: 
MessageStatus: delivered
NumMedia: 0
```

**Note:** Empty `Body` + `MessageStatus` = status update callback

---

## Postman Collection Setup

### Step 1: Create New Request
1. Open Postman
2. Click "New" → "HTTP Request"
3. Set method to `POST`
4. Enter URL: `https://devapi.open-enroll.com/api/webhooks/twilio-sms`

### Step 2: Set Headers
1. Click "Headers" tab
2. Add header:
   - Key: `Content-Type`
   - Value: `application/x-www-form-urlencoded`

### Step 3: Set Body
1. Click "Body" tab
2. Select "x-www-form-urlencoded"
3. Add these key-value pairs:

| Key | Value |
|-----|-------|
| MessageSid | SM1234567890abcdef1234567890abcdef |
| AccountSid | AC_YOUR_ACTUAL_TWILIO_ACCOUNT_SID |
| From | +19046379244 |
| To | +18889720474 |
| Body | Test message from Postman |
| MessageStatus | *(leave empty)* |
| NumMedia | 0 |

### Step 4: Send Request
Click "Send" and check:
- Response status should be `200 OK`
- Response body should be TwiML XML
- Check backend logs for the webhook logs

---

## Troubleshooting

### Error: "No vendor found for Twilio Account SID"
- Make sure `AccountSid` matches your vendor's `TwilioAccountSid` in database
- Check that `PhoneProviderEnabled = 1` for your vendor

### Error: "Invalid signature"
- Signature verification is optional (will log warning but continue)
- To test with signature, you'd need to generate proper Twilio signature (complex)

### No logs appearing
- Check you're hitting the correct URL: `/api/webhooks/twilio-sms`
- Check backend is running and deployed
- Verify network/firewall allows the request

### Success Indicators
✅ Response status `200 OK`  
✅ Response is TwiML XML  
✅ Backend logs show `📱 [request-id] Received Twilio SMS webhook`  
✅ Message appears in database (check diagnostic endpoint)

---

## Check Database After Test

Run the diagnostic endpoint to see if message was saved:
```
GET https://devapi.open-enroll.com/api/webhooks/twilio-sms/diagnostic
```

Look for:
- `recentMessagesCount > 0`
- Your test message in `recentMessages` array
- Message should have `Direction: 'Inbound'`

