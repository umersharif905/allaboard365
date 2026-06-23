# Twilio SMS Webhook Troubleshooting Guide

## 🔍 Quick Diagnostic Check

First, check the diagnostic endpoint:
```
GET https://devapi.open-enroll.com/api/webhooks/twilio-sms/diagnostic
```

This will show:
- Recent incoming messages in the database
- Vendor configuration status
- Whether the table exists

## 📋 Troubleshooting Checklist

### 1. **Check if Webhook is Being Called**

#### Check Server Logs
Look for these log messages in your backend logs:
```
📱 [request-id] Received Twilio SMS webhook at [timestamp]
```

If you don't see this log:
- ✅ **Webhook URL is wrong** - Check Twilio Console
- ✅ **Webhook not deployed** - Verify the route is deployed
- ✅ **CORS/Network issue** - Check Azure/Firewall settings

#### Check Twilio Logs
1. Go to Twilio Console → Monitor → Logs → Messaging
2. Find the message that was sent
3. Click on it to see webhook delivery status
4. Check if webhook was called and what response was received

### 2. **Verify Webhook URL Configuration**

❌ **WRONG URL:**
```
https://devapi.open-enroll.com/api/webhooks/twilio-sms.js
```

✅ **CORRECT URL:**
```
https://devapi.open-enroll.com/api/webhooks/twilio-sms
```

**To Fix:**
1. Go to Twilio Console → Phone Numbers → Manage → Active Numbers
2. Click on your Twilio phone number
3. Scroll to "Messaging" section
4. Under "A MESSAGE COMES IN", set to: `https://devapi.open-enroll.com/api/webhooks/twilio-sms`
5. Set HTTP method to: **POST**
6. Save

### 3. **Check Vendor Configuration**

The webhook needs to find your vendor by Twilio Account SID. Verify:

```sql
SELECT 
    VendorId,
    Name,
    TwilioAccountSid,
    PhoneProviderEnabled,
    CASE 
        WHEN TwilioAccountSid IS NOT NULL AND TwilioAccountSid != '' THEN '✅ Configured' 
        ELSE '❌ Missing' 
    END AS AccountSidStatus
FROM oe.Vendors
WHERE PhoneProviderEnabled = 1
```

**Required:**
- ✅ `TwilioAccountSid` must match the AccountSid from Twilio webhook
- ✅ `PhoneProviderEnabled` must be `1`

### 4. **Check Database for Stored Messages**

```sql
-- Check if any messages were received
SELECT TOP 20
    SmsMessageId,
    Direction,
    FromNumber,
    ToNumber,
    MessageBody,
    MessageStatus,
    ReceivedAt,
    TwilioMessageSid,
    MemberId,
    ShareRequestId,
    MatchedBy,
    CreatedDate
FROM oe.VendorSmsMessages
WHERE Direction = 'Inbound'
ORDER BY ReceivedAt DESC, CreatedDate DESC
```

If you see messages here but they're not showing in UI:
- ✅ Messages ARE being stored
- ✅ Problem is in UI/API retrieval logic

### 5. **Check for Signature Verification Issues**

If signature verification fails, messages will be rejected. Check logs for:
```
❌ [request-id] Invalid Twilio signature - potential security threat
```

**To temporarily disable signature verification for testing:**
- Comment out the signature verification code in `backend/routes/webhooks/twilio-sms.js`
- Or ensure `TwilioAuthToken` is properly configured and decrypted

### 6. **Common Issues**

#### Issue: "No vendor found for Twilio Account SID"
**Solution:**
1. Check that `TwilioAccountSid` in database matches the AccountSid from Twilio
2. Verify `PhoneProviderEnabled = 1`
3. Check for extra spaces or formatting differences

#### Issue: Messages saved but not showing in UI
**Possible causes:**
1. UI is querying wrong table or filtering incorrectly
2. UI is not refreshing/auto-updating
3. Vendor ID mismatch between stored messages and UI query

#### Issue: Signature verification failing
**Solution:**
1. Check that `TwilioAuthToken` is stored correctly (encrypted/decrypted)
2. Verify the full webhook URL matches exactly (protocol, host, path)
3. Check for proxy/load balancer modifying headers

### 7. **Test the Webhook Manually**

You can test the webhook endpoint directly:

```bash
curl -X POST https://devapi.open-enroll.com/api/webhooks/twilio-sms \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -H "X-Twilio-Signature: [optional]" \
  -d "MessageSid=SM1234567890" \
  -d "AccountSid=AC1234567890" \
  -d "From=%2B15551234567" \
  -d "To=%2B15559876543" \
  -d "Body=Test message"
```

Check server logs for the request processing.

### 8. **Check Twilio Message Status**

1. Go to Twilio Console → Monitor → Logs → Messaging
2. Find the message
3. Check webhook delivery:
   - ✅ Status 200 = Webhook received successfully
   - ❌ Status 404 = Webhook URL not found
   - ❌ Status 403 = Signature verification failed
   - ❌ Status 500 = Server error processing webhook

### 9. **Verify Database Table Exists**

```sql
SELECT TABLE_NAME
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = 'VendorSmsMessages'
```

If table doesn't exist, run the schema script:
```sql
-- Run: Project Docs/vendor-phone-system-schema.sql
```

### 10. **Check Phone Number Format**

The webhook normalizes phone numbers. Check logs for:
- Original: `+15551234567`
- Normalized: `+15551234567`

If matching fails, verify phone numbers in database match normalized format.

## 🔧 Debug Mode

Enable detailed logging by checking server logs for:
- `[request-id]` prefixes on all log messages
- Full request body and headers
- Database query results
- Error stack traces

## 📞 Next Steps

1. **Run diagnostic endpoint** - Check if messages are in database
2. **Check server logs** - See if webhook is being called
3. **Verify Twilio configuration** - Webhook URL and method
4. **Check vendor configuration** - Account SID and enabled status
5. **Query database directly** - Confirm messages are stored

If messages are in database but not in UI, that's a different issue (UI/API retrieval problem).

