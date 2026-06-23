/**
 * Twilio SMS Webhook Handler
 * Receives incoming SMS messages and status updates from Twilio
 */

const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../../config/database');
const crypto = require('crypto');
const twilio = require('twilio');

/**
 * Verify Twilio webhook signature
 * @param {string} authToken - Twilio Auth Token
 * @param {string} signature - X-Twilio-Signature header
 * @param {string} url - Full webhook URL
 * @param {object} params - Request body parameters
 * @returns {boolean}
 */
function verifyTwilioSignature(authToken, signature, url, params) {
    try {
        // Twilio signature verification using their SDK
        return twilio.validateRequest(authToken, signature, url, params);
    } catch (error) {
        console.error('❌ Error verifying Twilio signature:', error.message);
        return false;
    }
}

/**
 * POST /api/webhooks/twilio-sms
 * Handle incoming SMS messages and status updates from Twilio
 * Twilio validates via signature - we verify using the vendor's auth token
 */
router.post('/', async (req, res) => {
    const requestId = require('crypto').randomUUID();
    console.log(`\n📱 [${requestId}] Received Twilio SMS webhook at ${new Date().toISOString()}`);
    console.log(`📱 [${requestId}] Headers:`, JSON.stringify(req.headers, null, 2));
    console.log(`📱 [${requestId}] Body:`, JSON.stringify(req.body, null, 2));
    console.log(`📱 [${requestId}] Message SID:`, req.body.MessageSid);
    console.log(`📱 [${requestId}] From:`, req.body.From);
    console.log(`📱 [${requestId}] To:`, req.body.To);
    console.log(`📱 [${requestId}] Body:`, req.body.Body);
    console.log(`📱 [${requestId}] MessageStatus:`, req.body.MessageStatus);
    console.log(`📱 [${requestId}] AccountSid:`, req.body.AccountSid);

    try {
        const pool = await getPool();
        
        const {
            MessageSid,
            AccountSid,
            From,
            To,
            Body,
            MessageStatus,
            NumMedia
        } = req.body;

        // Find vendor by Twilio Account SID (need to get auth token for signature verification)
        const vendorResult = await pool.request()
            .input('accountSid', sql.NVarChar, AccountSid)
            .query(`
                SELECT VendorId, TwilioAccountSid, TwilioAuthToken
                FROM oe.Vendors
                WHERE TwilioAccountSid = @accountSid
                  AND PhoneProviderEnabled = 1
            `);

        if (vendorResult.recordset.length === 0) {
            console.error(`❌ [${requestId}] No vendor found for Twilio Account SID:`, AccountSid);
            console.error(`❌ [${requestId}] Make sure:`);
            console.error(`   1. Vendor has TwilioAccountSid = ${AccountSid}`);
            console.error(`   2. Vendor has PhoneProviderEnabled = 1`);
            console.error(`❌ [${requestId}] Webhook will not process this message`);
            return res.status(200).type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
        }

        const vendor = vendorResult.recordset[0];

        // Verify Twilio signature if auth token is available
        const twilioSignature = req.headers['x-twilio-signature'];
        if (twilioSignature && vendor.TwilioAuthToken) {
            try {
                // Decrypt auth token if encryption service is available
                let authToken = vendor.TwilioAuthToken;
                try {
                    const encryptionService = require('../../services/encryptionService');
                    authToken = encryptionService.decrypt(authToken);
                } catch (e) {
                    // Token might not be encrypted, use as-is
                    console.log('ℹ️ Using Twilio auth token as-is (not encrypted or encryption service unavailable)');
                }

                // Build full URL for signature verification
                const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
                const host = req.headers['x-forwarded-host'] || req.get('host');
                const url = `${protocol}://${host}${req.originalUrl}`;

                // Verify signature
                const isValid = verifyTwilioSignature(authToken, twilioSignature, url, req.body);
                if (!isValid) {
                    console.error('❌ Invalid Twilio signature - potential security threat');
                    // Still respond with 200 to prevent Twilio retries, but log the issue
                    // In production, you may want to return 403 instead
                    return res.status(200).type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
                }
                console.log('✅ Twilio signature verified');
            } catch (error) {
                console.error('❌ Error during signature verification:', error.message);
                // Continue processing in case of verification errors (might be network issue)
                // In production, consider failing here for security
            }
        } else if (twilioSignature && !vendor.TwilioAuthToken) {
            console.warn('⚠️ Twilio signature present but vendor auth token not configured - skipping verification');
        }

        // Normalize phone numbers
        const normalizePhone = (phone) => {
            if (!phone) return phone;
            let cleaned = phone.replace(/[^\d+]/g, '');
            if (!cleaned.startsWith('+')) {
                if (cleaned.startsWith('1') && cleaned.length === 11) {
                    cleaned = '+' + cleaned;
                } else {
                    cleaned = '+1' + cleaned;
                }
            }
            return cleaned;
        };

        const normalizedFrom = normalizePhone(From);
        const normalizedTo = normalizePhone(To);

        // Check if this is a status update or an incoming message
        if (MessageStatus && !Body) {
            // Status update for outbound message
            console.log(`📱 [${requestId}] Status update for message:`, MessageSid, 'Status:', MessageStatus);
            
            // Check if TwilioMessageSid column exists before updating
            const statusColumnCheck = await pool.request()
                .query(`
                    SELECT COLUMN_NAME
                    FROM INFORMATION_SCHEMA.COLUMNS
                    WHERE TABLE_SCHEMA = 'oe' 
                    AND TABLE_NAME = 'VendorSmsMessages'
                    AND COLUMN_NAME = 'TwilioMessageSid'
                `);
            
            const hasTwilioColumn = statusColumnCheck.recordset.length > 0;
            const messageIdColumn = hasTwilioColumn ? 'TwilioMessageSid' : 'ZoomMessageId';
            
            // Update message status in database
            const updateResult = await pool.request()
                .input('messageSid', sql.NVarChar, MessageSid)
                .input('status', sql.NVarChar, MessageStatus)
                .query(`
                    UPDATE oe.VendorSmsMessages
                    SET MessageStatus = @status,
                        DeliveredAt = CASE WHEN @status = 'delivered' THEN GETDATE() ELSE DeliveredAt END,
                        ModifiedDate = GETDATE()
                    WHERE ${messageIdColumn} = @messageSid
                `);
            
            console.log(`✅ [${requestId}] Status updated using ${messageIdColumn} column`);
            return res.status(200).type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
        }

        // Incoming SMS message
        const messageBody = Body || '';
        const messageBodyUpper = messageBody.toUpperCase().trim();

        // Check if this is a STOP command
        const isStopCommand = messageBodyUpper === 'STOP' || 
                             messageBodyUpper === 'STOPALL' || 
                             messageBodyUpper === 'UNSUBSCRIBE' ||
                             messageBodyUpper === 'QUIT' ||
                             messageBodyUpper === 'END' ||
                             messageBodyUpper === 'CANCEL';

        // Try to find member by phone number
        // Phone numbers in database may be stored with or without +1 prefix
        // Try multiple formats: +19046379244, 19046379244, 9046379244
        const phoneVariants = [];
        if (normalizedFrom.startsWith('+1')) {
            phoneVariants.push(normalizedFrom); // +19046379244
            phoneVariants.push(normalizedFrom.substring(2)); // 9046379244 (remove +1)
            phoneVariants.push('1' + normalizedFrom.substring(2)); // 19046379244 (add 1 without +)
        } else if (normalizedFrom.startsWith('1') && normalizedFrom.length === 11) {
            phoneVariants.push('+' + normalizedFrom); // +19046379244
            phoneVariants.push(normalizedFrom); // 19046379244
            phoneVariants.push(normalizedFrom.substring(1)); // 9046379244 (remove leading 1)
        } else {
            phoneVariants.push(normalizedFrom); // as-is
            phoneVariants.push('+1' + normalizedFrom); // add +1
            phoneVariants.push('1' + normalizedFrom); // add 1
        }
        
        // Remove duplicates
        const uniquePhoneVariants = [...new Set(phoneVariants)];
        console.log(`🔍 [${requestId}] Trying phone number variants for matching:`, uniquePhoneVariants);
        
        // Build query to match any of the phone number variants
        const phoneConditions = uniquePhoneVariants.map((_, index) => `u.PhoneNumber = @phone${index}`).join(' OR ');
        const memberRequest = pool.request();
        uniquePhoneVariants.forEach((phone, index) => {
            memberRequest.input(`phone${index}`, sql.NVarChar, phone);
        });
        
        const memberResult = await memberRequest.query(`
            SELECT m.MemberId, m.UserId, u.FirstName, u.LastName, u.PhoneNumber
            FROM oe.Members m
            INNER JOIN oe.Users u ON m.UserId = u.UserId
            WHERE (${phoneConditions})
        `);

        let memberId = null;
        let shareRequestId = null;
        let matchedBy = 'Auto';

        if (memberResult.recordset.length > 0) {
            const matchedMember = memberResult.recordset[0];
            memberId = matchedMember.MemberId;
            console.log(`✅ [${requestId}] Member matched!`);
            console.log(`   MemberId: ${memberId}`);
            console.log(`   Name: ${matchedMember.FirstName} ${matchedMember.LastName}`);
            console.log(`   Phone in DB: ${matchedMember.PhoneNumber}`);
            console.log(`   Phone from Twilio: ${normalizedFrom}`);

            // Try to find share request by RequestNumber in message
            // Look for pattern like "Share Request: SR-2025-0002" or just "SR-2025-0002"
            const requestNumberMatch = messageBody.match(/(?:Share Request:\s*)?(SR-\d{4}-\d+)/i);
            if (requestNumberMatch) {
                const requestNumber = requestNumberMatch[1];
                const srResult = await pool.request()
                    .input('requestNumber', sql.NVarChar, requestNumber)
                    .input('memberId', sql.UniqueIdentifier, memberId)
                    .query(`
                        SELECT ShareRequestId
                        FROM oe.ShareRequests
                        WHERE RequestNumber = @requestNumber
                          AND MemberId = @memberId
                    `);

                if (srResult.recordset.length > 0) {
                    shareRequestId = srResult.recordset[0].ShareRequestId;
                }
            }

            // If no share request found by RequestNumber, try to find the most recent one for this member
            if (!shareRequestId) {
                const recentSrResult = await pool.request()
                    .input('memberId', sql.UniqueIdentifier, memberId)
                    .query(`
                        SELECT TOP 1 ShareRequestId
                        FROM oe.ShareRequests
                        WHERE MemberId = @memberId
                        ORDER BY CreatedDate DESC
                    `);

                if (recentSrResult.recordset.length > 0) {
                    shareRequestId = recentSrResult.recordset[0].ShareRequestId;
                    console.log(`✅ [${requestId}] Found ShareRequestId from most recent ShareRequest for member`);
                }
            }

            // Also try to find ShareRequestId from recent outbound SMS messages to this number
            // This helps link replies to the correct ShareRequest even if RequestNumber isn't in the reply
            if (!shareRequestId && normalizedFrom) {
                const recentSmsResult = await pool.request()
                    .input('toNumber', sql.NVarChar, normalizedFrom)
                    .input('vendorId', sql.UniqueIdentifier, vendor.VendorId)
                    .query(`
                        SELECT TOP 1 ShareRequestId
                        FROM oe.VendorSmsMessages
                        WHERE VendorId = @vendorId
                          AND ToNumber = @toNumber
                          AND Direction = 'Outbound'
                          AND ShareRequestId IS NOT NULL
                        ORDER BY SentAt DESC, CreatedDate DESC
                    `);

                if (recentSmsResult.recordset.length > 0) {
                    shareRequestId = recentSmsResult.recordset[0].ShareRequestId;
                    console.log(`✅ [${requestId}] Found ShareRequestId from recent outbound SMS to this number`);
                }
            }
        }

        // TCPA / marketing: opt out of platform marketing SMS when member matches (any STOP keyword)
        if (isStopCommand && memberId) {
            try {
                const { optOutSmsMarketingFromStop } = require('../../services/memberCommunicationPreferences.service');
                const tenantRow = await pool.request()
                    .input('memberId', sql.UniqueIdentifier, memberId)
                    .query(`SELECT TenantId FROM oe.Members WHERE MemberId = @memberId`);
                const tid = tenantRow.recordset[0]?.TenantId;
                if (tid) {
                    await optOutSmsMarketingFromStop(memberId, tid, 'STOP_keyword');
                    console.log(`✅ [${requestId}] Marketing SMS opt-out recorded for member ${memberId}`);
                }
            } catch (mktStopErr) {
                console.error(`❌ [${requestId}] Marketing SMS opt-out error:`, mktStopErr);
            }
        }

        // Handle STOP command (share request workflow)
        if (isStopCommand && shareRequestId && memberId) {
            console.log('🛑 STOP command received from member:', memberId, 'for share request:', shareRequestId);

            // Check if ShareRequestMembers table exists
            const tableCheck = await pool.request()
                .query(`
                    SELECT TABLE_NAME
                    FROM INFORMATION_SCHEMA.TABLES
                    WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = 'ShareRequestMembers'
                `);

            if (tableCheck.recordset.length > 0) {
                // Insert or update opt-out status
                await pool.request()
                    .input('shareRequestId', sql.UniqueIdentifier, shareRequestId)
                    .input('memberId', sql.UniqueIdentifier, memberId)
                    .query(`
                        MERGE oe.ShareRequestMembers AS target
                        USING (SELECT @shareRequestId AS ShareRequestId, @memberId AS MemberId) AS source
                        ON target.ShareRequestId = source.ShareRequestId AND target.MemberId = source.MemberId
                        WHEN MATCHED THEN
                            UPDATE SET 
                                OptedOutOfSms = 1,
                                OptedOutOfSmsDate = GETDATE(),
                                OptedOutOfSmsReason = 'STOP',
                                ModifiedDate = GETDATE()
                        WHEN NOT MATCHED THEN
                            INSERT (ShareRequestId, MemberId, OptedOutOfSms, OptedOutOfSmsDate, OptedOutOfSmsReason)
                            VALUES (source.ShareRequestId, source.MemberId, 1, GETDATE(), 'STOP');
                    `);
            }

            // Save incoming SMS message
            const smsId = require('uuid').v4();
            await pool.request()
                .input('smsMessageId', sql.UniqueIdentifier, smsId)
                .input('vendorId', sql.UniqueIdentifier, vendor.VendorId)
                .input('direction', sql.NVarChar, 'Inbound')
                .input('fromNumber', sql.NVarChar, normalizedFrom)
                .input('toNumber', sql.NVarChar, normalizedTo)
                .input('messageBody', sql.NVarChar, messageBody)
                .input('messageStatus', sql.NVarChar, 'Received')
                .input('memberId', sql.UniqueIdentifier, memberId)
                .input('shareRequestId', sql.UniqueIdentifier, shareRequestId)
                .input('externalMessageId', sql.NVarChar, MessageSid)
                .input('receivedAt', sql.DateTime2, new Date())
                .query(`
                    INSERT INTO oe.VendorSmsMessages (
                        SmsMessageId, VendorId, Direction, FromNumber, ToNumber, 
                        MessageBody, MessageStatus, MemberId, ShareRequestId,
                        TwilioMessageSid, ReceivedAt, MatchedBy
                    ) VALUES (
                        @smsMessageId, @vendorId, @direction, @fromNumber, @toNumber,
                        @messageBody, @messageStatus, @memberId, @shareRequestId,
                        @externalMessageId, @receivedAt, @matchedBy
                    )
                `);

            // Respond with confirmation
            const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Message>You have been unsubscribed from SMS messages for this share request. Reply START to opt back in.</Message>
</Response>`;
            return res.status(200).type('text/xml').send(twiml);
        }

        // STOP with matched member but no share request — still acknowledge marketing opt-out
        if (isStopCommand && memberId && !shareRequestId) {
            const smsIdStop = require('uuid').v4();
            await pool.request()
                .input('smsMessageId', sql.UniqueIdentifier, smsIdStop)
                .input('vendorId', sql.UniqueIdentifier, vendor.VendorId)
                .input('direction', sql.NVarChar, 'Inbound')
                .input('fromNumber', sql.NVarChar, normalizedFrom)
                .input('toNumber', sql.NVarChar, normalizedTo)
                .input('messageBody', sql.NVarChar, messageBody)
                .input('messageStatus', sql.NVarChar, 'Received')
                .input('memberId', sql.UniqueIdentifier, memberId)
                .input('shareRequestId', sql.UniqueIdentifier, null)
                .input('externalMessageId', sql.NVarChar, MessageSid)
                .input('receivedAt', sql.DateTime2, new Date())
                .query(`
                    INSERT INTO oe.VendorSmsMessages (
                        SmsMessageId, VendorId, Direction, FromNumber, ToNumber,
                        MessageBody, MessageStatus, MemberId, ShareRequestId,
                        TwilioMessageSid, ReceivedAt, MatchedBy
                    ) VALUES (
                        @smsMessageId, @vendorId, @direction, @fromNumber, @toNumber,
                        @messageBody, @messageStatus, @memberId, @shareRequestId,
                        @externalMessageId, @receivedAt, @matchedBy
                    )
                `);

            const twimlStopOnly = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Message>You have been unsubscribed from marketing SMS. Msg and data rates may apply.</Message>
</Response>`;
            return res.status(200).type('text/xml').send(twimlStopOnly);
        }

        // Handle START command (opt back in)
        const isStartCommand = messageBodyUpper === 'START' || 
                              messageBodyUpper === 'YES' || 
                              messageBodyUpper === 'SUBSCRIBE' ||
                              messageBodyUpper === 'UNSTOP';

        if (isStartCommand && shareRequestId && memberId) {
            console.log('✅ START command received from member:', memberId, 'for share request:', shareRequestId);

            const tableCheck = await pool.request()
                .query(`
                    SELECT TABLE_NAME
                    FROM INFORMATION_SCHEMA.TABLES
                    WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = 'ShareRequestMembers'
                `);

            if (tableCheck.recordset.length > 0) {
                await pool.request()
                    .input('shareRequestId', sql.UniqueIdentifier, shareRequestId)
                    .input('memberId', sql.UniqueIdentifier, memberId)
                    .query(`
                        MERGE oe.ShareRequestMembers AS target
                        USING (SELECT @shareRequestId AS ShareRequestId, @memberId AS MemberId) AS source
                        ON target.ShareRequestId = source.ShareRequestId AND target.MemberId = source.MemberId
                        WHEN MATCHED THEN
                            UPDATE SET 
                                OptedOutOfSms = 0,
                                OptedOutOfSmsDate = NULL,
                                OptedOutOfSmsReason = NULL,
                                ModifiedDate = GETDATE()
                        WHEN NOT MATCHED THEN
                            INSERT (ShareRequestId, MemberId, OptedOutOfSms)
                            VALUES (source.ShareRequestId, source.MemberId, 0);
                    `);
            }

            // Save incoming SMS message
            const smsId = require('uuid').v4();
            await pool.request()
                .input('smsMessageId', sql.UniqueIdentifier, smsId)
                .input('vendorId', sql.UniqueIdentifier, vendor.VendorId)
                .input('direction', sql.NVarChar, 'Inbound')
                .input('fromNumber', sql.NVarChar, normalizedFrom)
                .input('toNumber', sql.NVarChar, normalizedTo)
                .input('messageBody', sql.NVarChar, messageBody)
                .input('messageStatus', sql.NVarChar, 'Received')
                .input('memberId', sql.UniqueIdentifier, memberId)
                .input('shareRequestId', sql.UniqueIdentifier, shareRequestId)
                .input('externalMessageId', sql.NVarChar, MessageSid)
                .input('receivedAt', sql.DateTime2, new Date())
                .query(`
                    INSERT INTO oe.VendorSmsMessages (
                        SmsMessageId, VendorId, Direction, FromNumber, ToNumber, 
                        MessageBody, MessageStatus, MemberId, ShareRequestId,
                        TwilioMessageSid, ReceivedAt, MatchedBy
                    ) VALUES (
                        @smsMessageId, @vendorId, @direction, @fromNumber, @toNumber,
                        @messageBody, @messageStatus, @memberId, @shareRequestId,
                        @externalMessageId, @receivedAt, @matchedBy
                    )
                `);

            const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Message>You have been subscribed to SMS messages for this share request. Reply STOP to opt out.</Message>
</Response>`;
            return res.status(200).type('text/xml').send(twiml);
        }

        // Regular incoming message - save to database
        const smsId = require('uuid').v4();
        
        // Check if TwilioMessageSid column exists
        const columnCheck = await pool.request()
            .query(`
                SELECT COLUMN_NAME
                FROM INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_SCHEMA = 'oe' 
                AND TABLE_NAME = 'VendorSmsMessages'
                AND COLUMN_NAME = 'TwilioMessageSid'
            `);

        const hasTwilioMessageSid = columnCheck.recordset.length > 0;

        let insertQuery;
        if (hasTwilioMessageSid) {
            insertQuery = `
                INSERT INTO oe.VendorSmsMessages (
                    SmsMessageId, VendorId, Direction, FromNumber, ToNumber, 
                    MessageBody, MessageStatus, MemberId, ShareRequestId,
                    TwilioMessageSid, ReceivedAt, MatchedBy
                ) VALUES (
                    @smsMessageId, @vendorId, @direction, @fromNumber, @toNumber,
                    @messageBody, @messageStatus, @memberId, @shareRequestId,
                    @externalMessageId, @receivedAt, @matchedBy
                )
            `;
        } else {
            insertQuery = `
                INSERT INTO oe.VendorSmsMessages (
                    SmsMessageId, VendorId, Direction, FromNumber, ToNumber, 
                    MessageBody, MessageStatus, MemberId, ShareRequestId,
                    ZoomMessageId, ReceivedAt, MatchedBy
                ) VALUES (
                    @smsMessageId, @vendorId, @direction, @fromNumber, @toNumber,
                    @messageBody, @messageStatus, @memberId, @shareRequestId,
                    @externalMessageId, @receivedAt, @matchedBy
                )
            `;
        }

        await pool.request()
            .input('smsMessageId', sql.UniqueIdentifier, smsId)
            .input('vendorId', sql.UniqueIdentifier, vendor.VendorId)
            .input('direction', sql.NVarChar, 'Inbound')
            .input('fromNumber', sql.NVarChar, normalizedFrom)
            .input('toNumber', sql.NVarChar, normalizedTo)
            .input('messageBody', sql.NVarChar, messageBody)
            .input('messageStatus', sql.NVarChar, 'Received')
            .input('memberId', sql.UniqueIdentifier, memberId)
            .input('shareRequestId', sql.UniqueIdentifier, shareRequestId)
            .input('externalMessageId', sql.NVarChar, MessageSid)
            .input('receivedAt', sql.DateTime2, new Date())
            .input('matchedBy', sql.NVarChar, matchedBy)
            .query(insertQuery);

        // Log incoming SMS to activity history if share request is found
        if (shareRequestId) {
            try {
                console.log(`📝 [${requestId}] Logging incoming SMS to activity:`, { shareRequestId, from: normalizedFrom, preview: messageBody.substring(0, 50) });
                const ShareRequestService = require('../../services/shareRequestService');
                const smsPreview = messageBody.length > 50 ? messageBody.substring(0, 50) + '...' : messageBody;
                const result = await ShareRequestService.addNote(
                    shareRequestId,
                    'Communication',
                    `SMS received from ${normalizedFrom}: "${smsPreview}"`,
                    true,
                    null // System-generated, no user
                );
                console.log(`✅ [${requestId}] Incoming SMS activity logged successfully:`, result);
            } catch (activityError) {
                console.error(`❌ [${requestId}] Failed to log incoming SMS to activity:`, activityError);
                console.error(`❌ [${requestId}] Error details:`, {
                    message: activityError.message,
                    stack: activityError.stack,
                    shareRequestId: shareRequestId
                });
                // Don't fail if activity logging fails
            }
        } else {
            console.log(`⚠️ [${requestId}] Incoming SMS not logged to activity - no ShareRequestId found`, {
                memberId: memberId || 'Not matched',
                shareRequestId: shareRequestId || 'Not matched',
                from: normalizedFrom,
                messageBody: messageBody.substring(0, 50)
            });
        }

        console.log(`✅ [${requestId}] Incoming SMS saved successfully`);
        console.log(`✅ [${requestId}] SmsMessageId:`, smsId);
        console.log(`✅ [${requestId}] Message saved to database:`, {
            MessageSid,
            From: normalizedFrom,
            To: normalizedTo,
            Body: messageBody,
            MemberId: memberId || 'Not matched',
            ShareRequestId: shareRequestId || 'Not matched',
            MatchedBy: matchedBy
        });

        // Respond with empty TwiML (no auto-reply for regular messages)
        return res.status(200).type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');

    } catch (error) {
        console.error(`❌ [${requestId}] Error processing Twilio SMS webhook:`, error);
        console.error(`❌ [${requestId}] Error stack:`, error.stack);
        console.error(`❌ [${requestId}] Request body was:`, JSON.stringify(req.body, null, 2));
        // Always return 200 to Twilio to prevent retries, but log the error
        return res.status(200).type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    }
});

/**
 * GET /api/webhooks/twilio-sms/diagnostic
 * Diagnostic endpoint to check webhook status and recent messages
 * Useful for troubleshooting why messages aren't appearing
 */
router.get('/diagnostic', async (req, res) => {
    console.log('🔍 Diagnostic endpoint called');
    try {
        const pool = await getPool();
        
        // Check if TwilioMessageSid column exists
        const columnCheck = await pool.request()
            .query(`
                SELECT COLUMN_NAME
                FROM INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_SCHEMA = 'oe' 
                AND TABLE_NAME = 'VendorSmsMessages'
                AND COLUMN_NAME = 'TwilioMessageSid'
            `);
        
        const hasTwilioMessageSid = columnCheck.recordset.length > 0;
        
        // Get recent inbound messages (last 24 hours)
        // Use ZoomMessageId if TwilioMessageSid doesn't exist (backward compatibility)
        let recentMessages;
        if (hasTwilioMessageSid) {
            recentMessages = await pool.request().query(`
                SELECT TOP 10
                    SmsMessageId,
                    Direction,
                    FromNumber,
                    ToNumber,
                    MessageBody,
                    MessageStatus,
                    ReceivedAt,
                    MemberId,
                    ShareRequestId,
                    MatchedBy,
                    TwilioMessageSid AS ExternalMessageId,
                    CreatedDate
                FROM oe.VendorSmsMessages
                WHERE Direction = 'Inbound'
                ORDER BY ReceivedAt DESC, CreatedDate DESC
            `);
        } else {
            recentMessages = await pool.request().query(`
                SELECT TOP 10
                    SmsMessageId,
                    Direction,
                    FromNumber,
                    ToNumber,
                    MessageBody,
                    MessageStatus,
                    ReceivedAt,
                    MemberId,
                    ShareRequestId,
                    MatchedBy,
                    ZoomMessageId AS ExternalMessageId,
                    CreatedDate
                FROM oe.VendorSmsMessages
                WHERE Direction = 'Inbound'
                ORDER BY ReceivedAt DESC, CreatedDate DESC
            `);
        }
        
        // Get vendor configuration status
        // Use VendorName (common column name in Vendors table)
        const vendors = await pool.request().query(`
            SELECT 
                VendorId,
                ISNULL(VendorName, 'Unknown Vendor') AS VendorName,
                TwilioAccountSid,
                CASE 
                    WHEN TwilioAccountSid IS NOT NULL AND TwilioAccountSid != '' THEN 1 
                    ELSE 0 
                END AS HasTwilioAccountSid,
                CASE 
                    WHEN TwilioAuthToken IS NOT NULL AND TwilioAuthToken != '' THEN 1 
                    ELSE 0 
                END AS HasTwilioAuthToken,
                CASE 
                    WHEN TwilioPhoneNumber IS NOT NULL AND TwilioPhoneNumber != '' THEN 1 
                    ELSE 0 
                END AS HasTwilioPhoneNumber,
                PhoneProviderEnabled
            FROM oe.Vendors
            WHERE PhoneProviderEnabled = 1
        `);
        
        // Check if table exists
        const tableCheck = await pool.request().query(`
            SELECT TABLE_NAME
            FROM INFORMATION_SCHEMA.TABLES
            WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = 'VendorSmsMessages'
        `);
        
        res.json({
            success: true,
            diagnostic: {
                tableExists: tableCheck.recordset.length > 0,
                hasTwilioMessageSidColumn: hasTwilioMessageSid,
                recentMessagesCount: recentMessages.recordset.length,
                recentMessages: recentMessages.recordset,
                vendorConfiguration: vendors.recordset,
                webhookEndpoint: '/api/webhooks/twilio-sms',
                timestamp: new Date().toISOString(),
                note: hasTwilioMessageSid 
                    ? 'TwilioMessageSid column exists - ready for Twilio messages' 
                    : '⚠️ TwilioMessageSid column missing - need to run schema migration'
            }
        });
    } catch (error) {
        console.error('❌ Diagnostic error:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            stack: error.stack
        });
    }
});

module.exports = router;

