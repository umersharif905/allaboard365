/**
 * Zoom Phone Service
 * Handles all Zoom Phone API interactions and call log management
 */

const { getPool, sql } = require('../config/database');
const crypto = require('crypto');
const encryptionService = require('./encryptionService');
const aiCallSummaryService = require('./aiCallSummaryService');

class ZoomPhoneService {
    
    /**
     * Get vendor's Zoom Phone configuration
     */
    static async getVendorConfig(vendorId) {
        const pool = await getPool();
        const result = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query(`
                SELECT 
                    PhoneProvider,
                    PhoneProviderEnabled,
                    ZoomAccountId,
                    ZoomClientId,
                    ZoomClientSecret,
                    ZoomWebhookSecretToken,
                    ZoomWebhookUrl,
                    PhoneAutoMatchEnabled,
                    PhonePopupEnabled,
                    PhoneRecordingsEnabled
                FROM oe.Vendors
                WHERE VendorId = @vendorId
            `);

        if (result.recordset.length === 0) {
            throw new Error('Vendor not found');
        }

        const config = result.recordset[0];
        
        if (!config.PhoneProviderEnabled || config.PhoneProvider !== 'ZoomPhone') {
            throw new Error('Zoom Phone not enabled for this vendor');
        }

        if (!config.ZoomAccountId || !config.ZoomClientId || !config.ZoomClientSecret) {
            throw new Error('Zoom Phone credentials not configured');
        }

        // The client secret is stored encrypted (AES-256-GCM via encryptionService).
        // Legacy rows may still hold plaintext, so only decrypt when it looks encrypted.
        const rawSecret = config.ZoomClientSecret;
        const clientSecret = encryptionService.isEncrypted(rawSecret)
            ? encryptionService.decrypt(rawSecret)
            : rawSecret;

        return {
            accountId: config.ZoomAccountId,
            clientId: config.ZoomClientId,
            clientSecret,
            webhookSecretToken: config.ZoomWebhookSecretToken,
            autoMatchEnabled: config.PhoneAutoMatchEnabled,
            popupEnabled: config.PhonePopupEnabled,
            recordingsEnabled: config.PhoneRecordingsEnabled
        };
    }

    /**
     * Get Zoom access token using Server-to-Server OAuth
     */
    static async getAccessToken(config) {
        const response = await fetch('https://zoom.us/oauth/token', {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({
                grant_type: 'account_credentials',
                account_id: config.accountId
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('❌ Zoom token error:', errorText);
            throw new Error('Failed to get Zoom access token');
        }

        const data = await response.json();
        return data.access_token;
    }

    /**
     * Fetch call logs from Zoom Phone API
     */
    static async fetchCallLogs(vendorId, options = {}) {
        const config = await this.getVendorConfig(vendorId);
        const accessToken = await this.getAccessToken(config);

        const params = new URLSearchParams({
            page_size: options.pageSize || 100,
            from: options.from || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0],
            to: options.to || new Date().toISOString().split('T')[0]
        });

        if (options.nextPageToken) {
            params.append('next_page_token', options.nextPageToken);
        }

        const response = await fetch(`https://api.zoom.us/v2/phone/call_history?${params}`, {
            headers: {
                'Authorization': `Bearer ${accessToken}`
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('❌ Zoom call history error:', errorText);
            throw new Error('Failed to fetch call history from Zoom');
        }

        return await response.json();
    }

    /**
     * Get phone users from Zoom
     */
    static async getPhoneUsers(vendorId) {
        const config = await this.getVendorConfig(vendorId);
        const accessToken = await this.getAccessToken(config);

        const response = await fetch('https://api.zoom.us/v2/phone/users?page_size=100', {
            headers: {
                'Authorization': `Bearer ${accessToken}`
            }
        });

        if (!response.ok) {
            throw new Error('Failed to fetch phone users from Zoom');
        }

        return await response.json();
    }

    /**
     * Record a call log in the database
     */
    static async recordCallLog(vendorId, callData, userId = null) {
        const pool = await getPool();
        const callLogId = crypto.randomUUID();

        await pool.request()
            .input('callLogId', sql.UniqueIdentifier, callLogId)
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('callType', sql.NVarChar, callData.callType || 'Inbound')
            .input('callStatus', sql.NVarChar, callData.callStatus || 'Completed')
            .input('callerNumber', sql.NVarChar, callData.callerNumber)
            .input('callerName', sql.NVarChar, callData.callerName)
            .input('calleeNumber', sql.NVarChar, callData.calleeNumber)
            .input('calleeName', sql.NVarChar, callData.calleeName)
            .input('callStartTime', sql.DateTime2, callData.callStartTime)
            .input('callEndTime', sql.DateTime2, callData.callEndTime)
            .input('callDurationSeconds', sql.Int, callData.callDurationSeconds)
            .input('memberId', sql.UniqueIdentifier, callData.memberId)
            .input('shareRequestId', sql.UniqueIdentifier, callData.shareRequestId)
            .input('matchedBy', sql.NVarChar, callData.matchedBy)
            .input('agentUserId', sql.UniqueIdentifier, callData.agentUserId)
            .input('agentExtension', sql.NVarChar, callData.agentExtension)
            .input('zoomUserId', sql.NVarChar, callData.zoomUserId)
            .input('agentEmail', sql.NVarChar, callData.agentEmail)
            .input('answeredBy', sql.NVarChar, callData.answeredBy || null)
            .input('callNotes', sql.NVarChar, callData.callNotes)
            .input('callSummary', sql.NVarChar, callData.callSummary)
            .input('source', sql.NVarChar, callData.source || 'Manual')
            .input('externalCallId', sql.NVarChar, callData.externalCallId)
            .input('externalCallUUID', sql.NVarChar, callData.externalCallUUID)
            .input('hasRecording', sql.Bit, callData.hasRecording || false)
            .input('recordingUrl', sql.NVarChar, callData.recordingUrl)
            .input('recordingDurationSeconds', sql.Int, callData.recordingDurationSeconds)
            .input('rawEventData', sql.NVarChar, callData.rawEventData ? JSON.stringify(callData.rawEventData) : null)
            .input('createdBy', sql.UniqueIdentifier, userId)
            .query(`
                INSERT INTO oe.VendorCallLogs (
                    CallLogId, VendorId, CallType, CallStatus,
                    CallerNumber, CallerName, CalleeNumber, CalleeName,
                    CallStartTime, CallEndTime, CallDurationSeconds,
                    MemberId, ShareRequestId, MatchedBy,
                    AgentUserId, AgentExtension, ZoomUserId, AgentEmail, AnsweredBy,
                    CallNotes, CallSummary,
                    Source, ExternalCallId, ExternalCallUUID,
                    HasRecording, RecordingUrl, RecordingDurationSeconds,
                    RawEventData, CreatedDate, CreatedBy, IsActive
                ) VALUES (
                    @callLogId, @vendorId, @callType, @callStatus,
                    @callerNumber, @callerName, @calleeNumber, @calleeName,
                    @callStartTime, @callEndTime, @callDurationSeconds,
                    @memberId, @shareRequestId, @matchedBy,
                    @agentUserId, @agentExtension, @zoomUserId, @agentEmail, @answeredBy,
                    @callNotes, @callSummary,
                    @source, @externalCallId, @externalCallUUID,
                    @hasRecording, @recordingUrl, @recordingDurationSeconds,
                    @rawEventData, GETDATE(), @createdBy, 1
                )
            `);

        console.log(`✅ Recorded call log ${callLogId}`);
        return callLogId;
    }

    /**
     * Race-safe upsert keyed on (VendorId, ExternalCallId). Used by recording
     * and transcript handlers that may fire before call_ended writes the row.
     * Returns the CallLogId (existing or new).
     */
    static async upsertCallLogByExternalCallId(vendorId, externalCallId, fields = {}) {
        if (!externalCallId) return null;
        const pool = await getPool();
        const existing = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('externalCallId', sql.NVarChar, externalCallId)
            .query(`SELECT CallLogId FROM oe.VendorCallLogs WHERE VendorId = @vendorId AND ExternalCallId = @externalCallId`);
        if (existing.recordset.length > 0) return existing.recordset[0].CallLogId;

        const newId = crypto.randomUUID();
        await pool.request()
            .input('callLogId', sql.UniqueIdentifier, newId)
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('callType', sql.NVarChar, fields.callType || 'Unknown')
            .input('callStatus', sql.NVarChar, fields.callStatus || 'Pending')
            .input('externalCallId', sql.NVarChar, externalCallId)
            .input('source', sql.NVarChar, 'ZoomPhone')
            .input('callStartTime', sql.DateTime2, fields.callStartTime || new Date())
            .query(`
                INSERT INTO oe.VendorCallLogs (
                    CallLogId, VendorId, CallType, CallStatus,
                    ExternalCallId, Source, CallStartTime,
                    CreatedDate, IsActive
                ) VALUES (
                    @callLogId, @vendorId, @callType, @callStatus,
                    @externalCallId, @source, @callStartTime,
                    GETDATE(), 1
                )
            `);
        console.log(`📞 Created placeholder call log for early webhook: ${externalCallId} → ${newId}`);
        return newId;
    }

    /**
     * Match a phone number to a member
     */
    static async matchPhoneToMember(vendorId, phoneNumber) {
        if (!phoneNumber) return null;

        // Normalize phone number (remove non-digits)
        const normalizedPhone = phoneNumber.replace(/\D/g, '');
        
        // Try last 10 digits for matching
        const last10 = normalizedPhone.slice(-10);

        if (last10.length < 10) return null;

        // Member identity (name/phone/email) lives on oe.Users, joined via
        // m.UserId. Vendor scope is established through active enrollments in the
        // vendor's products (same proven approach as matchPhoneToMemberForSync).
        const pool = await getPool();
        const result = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('phone', sql.NVarChar, `%${last10}`)
            .query(`
                SELECT DISTINCT TOP 1
                    m.MemberId,
                    u.FirstName,
                    u.LastName,
                    u.PhoneNumber AS Phone,
                    u.Email
                FROM oe.Members m
                INNER JOIN oe.Users u ON m.UserId = u.UserId
                INNER JOIN oe.Enrollments e ON m.MemberId = e.MemberId
                INNER JOIN oe.Products p ON e.ProductId = p.ProductId
                WHERE p.VendorId = @vendorId
                AND e.Status = 'Active'
                AND REPLACE(REPLACE(REPLACE(REPLACE(u.PhoneNumber, '-', ''), '(', ''), ')', ''), ' ', '') LIKE @phone
            `);

        if (result.recordset.length > 0) {
            return result.recordset[0];
        }

        return null;
    }

    /**
     * Match a phone number to share requests
     */
    static async matchPhoneToShareRequests(vendorId, phoneNumber, memberId = null) {
        const pool = await getPool();

        let query = `
            SELECT TOP 10
                sr.ShareRequestId,
                sr.RequestNumber,
                sr.Status,
                sr.TotalBilled,
                m.FirstName as MemberFirstName,
                m.LastName as MemberLastName,
                m.Phone as MemberPhone
            FROM oe.ShareRequests sr
            INNER JOIN oe.Members m ON sr.MemberId = m.MemberId
            WHERE sr.VendorId = @vendorId
            AND sr.IsActive = 1
        `;

        const request = pool.request();
        request.input('vendorId', sql.UniqueIdentifier, vendorId);

        if (memberId) {
            query += ` AND sr.MemberId = @memberId`;
            request.input('memberId', sql.UniqueIdentifier, memberId);
        } else if (phoneNumber) {
            const normalizedPhone = phoneNumber.replace(/\D/g, '');
            const last10 = normalizedPhone.slice(-10);
            query += ` AND REPLACE(REPLACE(REPLACE(REPLACE(m.Phone, '-', ''), '(', ''), ')', ''), ' ', '') LIKE @phone`;
            request.input('phone', sql.NVarChar, `%${last10}`);
        }

        query += ` ORDER BY sr.CreatedDate DESC`;

        const result = await request.query(query);
        return result.recordset;
    }

    /**
     * Get call logs for a vendor
     */
    static async getCallLogs(vendorId, options = {}) {
        const pool = await getPool();
        
        let query = `
            SELECT 
                cl.*,
                m.FirstName as MemberFirstName,
                m.LastName as MemberLastName,
                sr.RequestNumber,
                u.FirstName as AgentFirstName,
                u.LastName as AgentLastName,
                cu.FirstName as CreatedByFirstName,
                cu.LastName as CreatedByLastName
            FROM oe.VendorCallLogs cl
            LEFT JOIN oe.Members m ON cl.MemberId = m.MemberId
            LEFT JOIN oe.ShareRequests sr ON cl.ShareRequestId = sr.ShareRequestId
            LEFT JOIN oe.Users u ON cl.AgentUserId = u.UserId
            LEFT JOIN oe.Users cu ON cl.CreatedBy = cu.UserId
            WHERE cl.VendorId = @vendorId
            AND cl.IsActive = 1
        `;

        const request = pool.request();
        request.input('vendorId', sql.UniqueIdentifier, vendorId);

        if (options.shareRequestId) {
            query += ` AND cl.ShareRequestId = @shareRequestId`;
            request.input('shareRequestId', sql.UniqueIdentifier, options.shareRequestId);
        }

        if (options.memberId) {
            query += ` AND cl.MemberId = @memberId`;
            request.input('memberId', sql.UniqueIdentifier, options.memberId);
        }

        if (options.fromDate) {
            query += ` AND cl.CallStartTime >= @fromDate`;
            request.input('fromDate', sql.DateTime2, options.fromDate);
        }

        if (options.toDate) {
            query += ` AND cl.CallStartTime <= @toDate`;
            request.input('toDate', sql.DateTime2, options.toDate);
        }

        query += ` ORDER BY cl.CallStartTime DESC`;

        if (options.limit) {
            query += ` OFFSET 0 ROWS FETCH NEXT @limit ROWS ONLY`;
            request.input('limit', sql.Int, options.limit);
        }

        const result = await request.query(query);
        return result.recordset;
    }

    /**
     * Get call logs for a specific share request
     */
    static async getShareRequestCallLogs(shareRequestId) {
        const pool = await getPool();
        const result = await pool.request()
            .input('shareRequestId', sql.UniqueIdentifier, shareRequestId)
            .query(`
                SELECT 
                    cl.*,
                    mu.FirstName as MemberFirstName,
                    mu.LastName as MemberLastName,
                    u.FirstName as AgentFirstName,
                    u.LastName as AgentLastName,
                    cu.FirstName as CreatedByFirstName,
                    cu.LastName as CreatedByLastName
                FROM oe.VendorCallLogs cl
                LEFT JOIN oe.Members m ON cl.MemberId = m.MemberId
                LEFT JOIN oe.Users mu ON m.UserId = mu.UserId
                LEFT JOIN oe.Users u ON cl.AgentUserId = u.UserId
                LEFT JOIN oe.Users cu ON cl.CreatedBy = cu.UserId
                WHERE cl.ShareRequestId = @shareRequestId
                AND cl.IsActive = 1
                ORDER BY cl.CallStartTime DESC
            `);

        return result.recordset;
    }

    /**
     * Update call log (add notes, link to share request, etc.)
     */
    static async updateCallLog(callLogId, updates, userId) {
        const pool = await getPool();
        const request = pool.request();
        request.input('callLogId', sql.UniqueIdentifier, callLogId);
        request.input('userId', sql.UniqueIdentifier, userId);

        let updateFields = ['ModifiedDate = GETDATE()', 'ModifiedBy = @userId'];

        if (updates.callNotes !== undefined) {
            updateFields.push('CallNotes = @callNotes');
            request.input('callNotes', sql.NVarChar, updates.callNotes);
        }

        if (updates.callSummary !== undefined) {
            updateFields.push('CallSummary = @callSummary');
            request.input('callSummary', sql.NVarChar, updates.callSummary);
        }

        if (updates.shareRequestId !== undefined) {
            updateFields.push('ShareRequestId = @shareRequestId');
            updateFields.push("MatchedBy = 'Manual'");
            request.input('shareRequestId', sql.UniqueIdentifier, updates.shareRequestId);
        }

        if (updates.memberId !== undefined) {
            updateFields.push('MemberId = @memberId');
            request.input('memberId', sql.UniqueIdentifier, updates.memberId);
        }

        await request.query(`
            UPDATE oe.VendorCallLogs
            SET ${updateFields.join(', ')}
            WHERE CallLogId = @callLogId
        `);

        if (updates.callNotes !== undefined) {
            await this.mirrorCallLogToEncounter(callLogId, { notes: updates.callNotes })
                .catch(e => console.error('⚠ notes mirror to encounter failed:', e.message));
        }

        return true;
    }

    /**
     * Process Zoom Phone webhook event
     */
    static async processWebhookEvent(vendorId, event) {
        console.log(`📞 Processing Zoom Phone event: ${event.event}`);

        const eventType = event.event;
        const payload = event.payload;

        try {
            switch (eventType) {
                // Call started: Zoom's real events are phone.{caller,callee}_ringing.
                // The *_call_started names are never emitted by Zoom — kept as
                // harmless aliases in case of future/legacy payloads.
                case 'phone.callee_ringing':
                case 'phone.caller_ringing':
                case 'phone.callee_call_started':
                case 'phone.caller_call_started':
                    return await this.handleCallStarted(vendorId, payload, eventType);

                // Call ended: Zoom emits phone.{caller,callee}_ended (no _call_).
                case 'phone.callee_ended':
                case 'phone.caller_ended':
                case 'phone.callee_call_ended':
                case 'phone.caller_call_ended':
                    return await this.handleCallEnded(vendorId, payload, eventType);

                // Missed: Zoom emits phone.callee_missed (no _call_).
                case 'phone.callee_missed':
                case 'phone.callee_call_missed':
                    return await this.handleCallMissed(vendorId, payload);

                case 'phone.voicemail_received':
                    return await this.handleVoicemail(vendorId, payload);

                // Zoom's current event name is phone.recording_completed; the older
                // phone.call_recording_completed is kept for backward compatibility.
                case 'phone.recording_completed':
                case 'phone.call_recording_completed':
                    return await this.handleRecordingCompleted(vendorId, payload);

                // Recording transcription is ready — fetch it and kick off the summary.
                case 'phone.recording_transcript_completed':
                    return await this.handleTranscriptCompleted(vendorId, payload);

                case 'phone.ai_call_summary_changed':
                case 'phone.ai_call_summary_completed':
                    return await this.handleAiCallSummaryChanged(vendorId, payload);

                default:
                    console.log(`⚠️ Unhandled Zoom Phone event: ${eventType}`);
                    return { handled: false, eventType };
            }
        } catch (error) {
            console.error(`❌ Error processing Zoom event ${eventType}:`, error);
            throw error;
        }
    }

    /**
     * Handle call started event
     */
    static async handleCallStarted(vendorId, payload, eventType) {
        // callee_* events are inbound (someone calling our line); caller_* are outbound.
        const isInbound = eventType.includes('callee');
        const c = this.extractWebhookCall(payload.object, isInbound);

        const config = await this.getVendorConfig(vendorId);

        // Match the *external* party (the member) to a member record.
        let matchedMember = null;
        if (config.autoMatchEnabled) {
            const phoneToMatch = isInbound ? c.callerNumber : c.calleeNumber;
            matchedMember = await this.matchPhoneToMember(vendorId, phoneToMatch);
        }

        // Attribute the call to an internal vendor agent (the Zoom user on our side).
        const agentUserId = await this.resolveAgentUserId(vendorId, c.agent);
        const agentName = await this.lookupUserName(agentUserId) || c.agent.name || null;

        // Upsert the active call (a single Zoom call can fire multiple started
        // events; key on ExternalCallId so we don't create duplicate live rows).
        const pool = await getPool();
        const existing = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('externalCallId', sql.NVarChar, c.callId)
            .query(`SELECT ActiveCallId FROM oe.VendorActiveCalls WHERE VendorId = @vendorId AND ExternalCallId = @externalCallId`);

        const activeCallId = existing.recordset[0]?.ActiveCallId || crypto.randomUUID();

        if (existing.recordset.length === 0) {
            await pool.request()
                .input('activeCallId', sql.UniqueIdentifier, activeCallId)
                .input('vendorId', sql.UniqueIdentifier, vendorId)
                .input('callType', sql.NVarChar, isInbound ? 'Inbound' : 'Outbound')
                .input('callStatus', sql.NVarChar, 'Ringing')
                .input('callerNumber', sql.NVarChar, c.callerNumber)
                .input('callerName', sql.NVarChar, c.callerName)
                .input('calleeNumber', sql.NVarChar, c.calleeNumber)
                .input('calleeName', sql.NVarChar, c.calleeName)
                .input('callStartTime', sql.DateTime2, new Date())
                .input('agentUserId', sql.UniqueIdentifier, agentUserId)
                .input('agentName', sql.NVarChar, agentName)
                .input('agentExtension', sql.NVarChar, c.agent.extension)
                .input('memberId', sql.UniqueIdentifier, matchedMember?.MemberId)
                .input('memberName', sql.NVarChar, matchedMember ? `${matchedMember.FirstName} ${matchedMember.LastName}` : null)
                .input('externalCallId', sql.NVarChar, c.callId)
                .query(`
                    INSERT INTO oe.VendorActiveCalls (
                        ActiveCallId, VendorId, CallType, CallStatus,
                        CallerNumber, CallerName, CalleeNumber, CalleeName,
                        CallStartTime, AgentUserId, AgentName, AgentExtension,
                        MemberId, MemberName, ExternalCallId,
                        CreatedDate, LastUpdated
                    ) VALUES (
                        @activeCallId, @vendorId, @callType, @callStatus,
                        @callerNumber, @callerName, @calleeNumber, @calleeName,
                        @callStartTime, @agentUserId, @agentName, @agentExtension,
                        @memberId, @memberName, @externalCallId,
                        GETDATE(), GETDATE()
                    )
                `);
        } else {
            // Second leg of the same call — refine status/attribution.
            // If the prior leg marked this 'Ended' (transfer), revive to 'Ringing'.
            await pool.request()
                .input('activeCallId', sql.UniqueIdentifier, activeCallId)
                .input('agentUserId', sql.UniqueIdentifier, agentUserId)
                .input('agentName', sql.NVarChar, agentName)
                .input('memberId', sql.UniqueIdentifier, matchedMember?.MemberId)
                .query(`
                    UPDATE oe.VendorActiveCalls
                    SET AgentUserId = COALESCE(AgentUserId, @agentUserId),
                        AgentName = COALESCE(AgentName, @agentName),
                        MemberId = COALESCE(MemberId, @memberId),
                        CallStatus = CASE WHEN CallStatus = 'Ended' THEN 'Ringing' ELSE CallStatus END,
                        LastUpdated = GETDATE()
                    WHERE ActiveCallId = @activeCallId
                `);
        }

        // Opportunistic cleanup of stale live rows (runs on each call-started
        // event for this vendor). Three cases:
        //   1. Normal: 'Ended' rows older than 5 min (the Live-tab 60s grace
        //      window has long passed).
        //   2. Orphaned-but-resolved: the call already has a terminal log yet
        //      its live row never closed (e.g. an out-of-order webhook where
        //      *_ended arrived before *_ringing). The 10-min guard keeps this
        //      from touching an in-progress queue transfer — a transfer's
        //      revival bumps LastUpdated to now (see handleCallStarted upsert).
        //   3. Last-resort: any row stuck 6h+ (a dropped terminal webhook with
        //      no log). Well beyond any real call, so it won't reap a live one.
        await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query(`DELETE FROM oe.VendorActiveCalls
                    WHERE VendorId = @vendorId
                      AND (
                        (CallStatus = 'Ended' AND LastUpdated < DATEADD(MINUTE, -5, GETDATE()))
                        OR (LastUpdated < DATEADD(MINUTE, -10, GETDATE())
                            AND EXISTS (SELECT 1 FROM oe.VendorCallLogs l
                                        WHERE l.VendorId = oe.VendorActiveCalls.VendorId
                                          AND l.ExternalCallId = oe.VendorActiveCalls.ExternalCallId))
                        OR LastUpdated < DATEADD(HOUR, -6, GETDATE())
                      )`)
            .catch(() => {});

        console.log(`📞 Call started: ${c.callId} (${isInbound ? 'Inbound' : 'Outbound'})`);

        return {
            handled: true,
            activeCallId,
            matchedMember,
            callId: c.callId
        };
    }

    /**
     * Handle call ended event
     */
    static async handleCallEnded(vendorId, payload, eventType) {
        const isInbound = eventType.includes('callee');
        const c = this.extractWebhookCall(payload.object, isInbound);
        const answeredBy = this.classifyAnsweredBy(payload.object, isInbound);
        const pool = await getPool();

        // De-dupe: a single call can produce both caller_ and callee_ ended events.
        // If we already logged this external call id, skip.
        const existingLog = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('externalCallId', sql.NVarChar, c.callId)
            .query(`SELECT CallLogId FROM oe.VendorCallLogs WHERE VendorId = @vendorId AND ExternalCallId = @externalCallId`);

        // Find the active call (for start time / prior attribution)
        const activeCallResult = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('externalCallId', sql.NVarChar, c.callId)
            .query(`SELECT * FROM oe.VendorActiveCalls WHERE VendorId = @vendorId AND ExternalCallId = @externalCallId`);
        const activeCall = activeCallResult.recordset[0];

        if (existingLog.recordset.length > 0) {
            const existingId = existingLog.recordset[0].CallLogId;
            // If this is a placeholder created by an earlier recording/transcript webhook,
            // backfill its fields now that we have full call details.
            const callStatus = c.handupResult === 'Voicemail'
                ? 'Voicemail'
                : (c.handupResult === 'Call Canceled' ? 'Missed' : 'Completed');
            const memberId = activeCall?.MemberId || null;
            const agentUserId = activeCall?.AgentUserId || await this.resolveAgentUserId(vendorId, c.agent);
            await pool.request()
                .input('callLogId', sql.UniqueIdentifier, existingId)
                .input('callType', sql.NVarChar, isInbound ? 'Inbound' : 'Outbound')
                .input('callStatus', sql.NVarChar, callStatus)
                .input('callerNumber', sql.NVarChar, c.callerNumber)
                .input('callerName', sql.NVarChar, c.callerName)
                .input('calleeNumber', sql.NVarChar, c.calleeNumber)
                .input('calleeName', sql.NVarChar, c.calleeName)
                .input('callDurationSeconds', sql.Int, c.durationSeconds || 0)
                .input('memberId', sql.UniqueIdentifier, memberId)
                .input('agentUserId', sql.UniqueIdentifier, agentUserId)
                .input('zoomUserId', sql.NVarChar, c.agent.userId)
                .input('agentEmail', sql.NVarChar, c.agent.email)
                .input('agentExtension', sql.NVarChar, c.agent.extension)
                .input('answeredBy', sql.NVarChar, answeredBy)
                .query(`
                    UPDATE oe.VendorCallLogs
                    SET CallType = COALESCE(NULLIF(@callType,''), CallType),
                        CallStatus = COALESCE(NULLIF(@callStatus,''), CallStatus),
                        CallerNumber = COALESCE(@callerNumber, CallerNumber),
                        CallerName = COALESCE(@callerName, CallerName),
                        CalleeNumber = COALESCE(@calleeNumber, CalleeNumber),
                        CalleeName = COALESCE(@calleeName, CalleeName),
                        CallDurationSeconds = COALESCE(NULLIF(@callDurationSeconds, 0), CallDurationSeconds),
                        MemberId = COALESCE(@memberId, MemberId),
                        AgentUserId = COALESCE(@agentUserId, AgentUserId),
                        ZoomUserId = COALESCE(@zoomUserId, ZoomUserId),
                        AgentEmail = COALESCE(@agentEmail, AgentEmail),
                        AgentExtension = COALESCE(@agentExtension, AgentExtension),
                        AnsweredBy = COALESCE(@answeredBy, AnsweredBy),
                        ModifiedDate = GETDATE()
                    WHERE CallLogId = @callLogId
                `);
            if (activeCall) {
                // Mark active call as Ended (don't DELETE — Zoom fires callee_ended
                // per leg; if a queue transfer is in progress, another callee_ringing
                // is about to revive this row. The Live tab filters on
                // (CallStatus != 'Ended' OR LastUpdated > NOW() - 60s) so the agent
                // can still see the call for a minute after the final hangup.
                await pool.request()
                    .input('activeCallId', sql.UniqueIdentifier, activeCall.ActiveCallId)
                    .query(`UPDATE oe.VendorActiveCalls
                            SET CallStatus = 'Ended', LastUpdated = GETDATE()
                            WHERE ActiveCallId = @activeCallId`);
            }
            // Now create the encounter if it doesn't exist
            await this.ensureEncounterForCallLog(vendorId, existingId).catch(e => console.error('⚠ encounter create failed:', e.message));
            return { handled: true, callLogId: existingId, mergedPlaceholder: true };
        }

        // Calculate duration
        const startTime = activeCall?.CallStartTime || new Date();
        const endTime = new Date();
        const durationSeconds = c.durationSeconds != null
            ? c.durationSeconds
            : Math.round((endTime - new Date(startTime)) / 1000);

        // Member attribution (reuse the live match if present)
        const config = await this.getVendorConfig(vendorId);
        let memberId = activeCall?.MemberId;
        let matchedBy = memberId ? 'Auto' : null;
        if (!memberId && config.autoMatchEnabled) {
            const phoneToMatch = isInbound ? c.callerNumber : c.calleeNumber;
            const matchedMember = await this.matchPhoneToMember(vendorId, phoneToMatch);
            if (matchedMember) {
                memberId = matchedMember.MemberId;
                matchedBy = 'Auto';
            }
        }

        // Agent attribution (reuse the live row if it captured it)
        const agentUserId = activeCall?.AgentUserId || await this.resolveAgentUserId(vendorId, c.agent);

        // Map Zoom's hang-up result to a call status when present.
        const callStatus = c.handupResult === 'Voicemail'
            ? 'Voicemail'
            : (c.handupResult === 'Call Canceled' ? 'Missed' : 'Completed');

        const callLogId = await this.recordCallLog(vendorId, {
            callType: isInbound ? 'Inbound' : 'Outbound',
            callStatus,
            callerNumber: c.callerNumber,
            callerName: c.callerName,
            calleeNumber: c.calleeNumber,
            calleeName: c.calleeName,
            callStartTime: startTime,
            callEndTime: endTime,
            callDurationSeconds: durationSeconds,
            memberId,
            shareRequestId: activeCall?.ShareRequestId,
            matchedBy,
            agentUserId,
            agentExtension: activeCall?.AgentExtension || c.agent.extension,
            zoomUserId: c.agent.userId,
            agentEmail: c.agent.email,
            answeredBy,
            source: 'ZoomPhone',
            externalCallId: c.callId,
            rawEventData: payload
        });

        // Mark active call as Ended (see comment above — don't DELETE).
        if (activeCall) {
            await pool.request()
                .input('activeCallId', sql.UniqueIdentifier, activeCall.ActiveCallId)
                .query(`UPDATE oe.VendorActiveCalls
                        SET CallStatus = 'Ended', LastUpdated = GETDATE()
                        WHERE ActiveCallId = @activeCallId`);
        }

        await this.ensureEncounterForCallLog(vendorId, callLogId).catch(() => {});

        console.log(`📞 Call ended: ${c.callId} (Duration: ${durationSeconds}s)`);

        return { handled: true, callLogId, durationSeconds };
    }

    /**
     * Handle missed call event (phone.callee_missed).
     * Reads the nested caller{}/callee{} shape (real Zoom payload), resolves
     * the internal agent, and de-duplicates against existing rows on
     * ExternalCallId so per-queue-member miss events don't produce N rows.
     */
    static async handleCallMissed(vendorId, payload) {
        const c = this.extractWebhookCall(payload.object, /* isInbound */ true);
        const answeredBy = this.classifyAnsweredBy(payload.object, true);

        const pool = await getPool();
        const existing = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('externalCallId', sql.NVarChar, c.callId)
            .query(`SELECT CallLogId FROM oe.VendorCallLogs WHERE VendorId = @vendorId AND ExternalCallId = @externalCallId`);

        // Clear the live row. Zoom fires no *_ended for a missed call, so the
        // 'Ringing' row inserted by handleCallStarted would otherwise linger on
        // the call center forever. Mark Ended (not DELETE — consistent with
        // handleCallEnded) so the Live tab's 60s grace window still applies and
        // the opportunistic cleanup reaps it. Run before the de-dupe return so
        // every missed leg keeps the row clean.
        await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('externalCallId', sql.NVarChar, c.callId)
            .query(`UPDATE oe.VendorActiveCalls
                    SET CallStatus = 'Ended', LastUpdated = GETDATE()
                    WHERE VendorId = @vendorId AND ExternalCallId = @externalCallId`)
            .catch(() => {});

        // De-dupe: phone.callee_missed fires once per ringing queue member, so
        // a single call_id can produce multiple events. Keep the first row.
        if (existing.recordset.length > 0) {
            return { handled: true, callLogId: existing.recordset[0].CallLogId, deduped: true };
        }

        const config = await this.getVendorConfig(vendorId);

        let memberId = null;
        let matchedBy = null;
        if (config.autoMatchEnabled && c.callerNumber) {
            const matchedMember = await this.matchPhoneToMember(vendorId, c.callerNumber);
            if (matchedMember) {
                memberId = matchedMember.MemberId;
                matchedBy = 'Auto';
            }
        }

        const agentUserId = await this.resolveAgentUserId(vendorId, c.agent);

        const callLogId = await this.recordCallLog(vendorId, {
            callType: 'Missed',
            callStatus: 'Missed',
            callerNumber: c.callerNumber,
            callerName: c.callerName,
            calleeNumber: c.calleeNumber,
            calleeName: c.calleeName,
            callStartTime: new Date(),
            callDurationSeconds: 0,
            memberId,
            matchedBy,
            agentUserId,
            agentExtension: c.agent.extension,
            zoomUserId: c.agent.userId,
            agentEmail: c.agent.email,
            answeredBy,
            source: 'ZoomPhone',
            externalCallId: c.callId,
            rawEventData: payload,
        });

        await this.ensureEncounterForCallLog(vendorId, callLogId).catch(() => {});

        console.log(`📞 Missed call from: ${c.callerNumber || '(unknown)'} → ${answeredBy || 'unknown'}`);
        return { handled: true, callLogId };
    }

    /**
     * Handle voicemail received event
     */
    static async handleVoicemail(vendorId, payload) {
        const callData = payload.object;
        const answeredBy = this.classifyAnsweredBy(payload.object, true);
        const config = await this.getVendorConfig(vendorId);

        let memberId = null;
        if (config.autoMatchEnabled) {
            const matchedMember = await this.matchPhoneToMember(vendorId, callData.caller_number);
            if (matchedMember) {
                memberId = matchedMember.MemberId;
            }
        }

        // Voicemails carry the audio URL in `download_url` (fetched via the
        // recording-proxy with the vendor's Zoom token). Only flag HasRecording
        // when we actually have a URL, otherwise the player shows "unavailable".
        const voicemailUrl = callData.download_url || null;

        // Attribute the voicemail to the internal agent who owns the mailbox.
        const agentUserId = await this.resolveAgentUserId(vendorId, {
            userId: callData.callee_user_id,
            extension: callData.callee_number,
            name: callData.callee_name,
        });

        const callLogId = await this.recordCallLog(vendorId, {
            callType: 'Voicemail',
            callStatus: 'Voicemail',
            callerNumber: callData.caller_number,
            callerName: callData.caller_name,
            calleeNumber: callData.callee_number,
            calleeName: callData.callee_name,
            agentUserId,
            zoomUserId: callData.callee_user_id || null,
            agentExtension: callData.callee_number || null,
            answeredBy,
            callStartTime: new Date(),
            callDurationSeconds: callData.duration || 0,
            memberId: memberId,
            matchedBy: memberId ? 'Auto' : null,
            source: 'ZoomPhone',
            externalCallId: callData.id,
            hasRecording: !!voicemailUrl,
            recordingUrl: voicemailUrl,
            recordingDurationSeconds: callData.duration,
            rawEventData: payload
        });

        await this.ensureEncounterForCallLog(vendorId, callLogId).catch(() => {});

        console.log(`📞 Voicemail from: ${callData.caller_number}`);

        return { handled: true, callLogId };
    }

    /**
     * Handle phone.recording_completed webhook.
     * Zoom sends recordings under `payload.object.recordings[]` (array — Zoom
     * Phone supports multi-segment recordings). Older / voicemail shape has
     * a flat `download_url` at object level. Support both.
     */
    static async handleRecordingCompleted(vendorId, payload) {
        const obj = payload?.object || {};
        const first = Array.isArray(obj.recordings) && obj.recordings.length > 0 ? obj.recordings[0] : {};
        const callId = this.normalizeExternalCallId(obj.call_id || obj.call_log_id || obj.id || first.call_id || first.call_log_id || null);
        const downloadUrl = first.download_url || obj.download_url || obj.recording_url || first.recording_url || null;
        const duration = first.duration ?? obj.duration ?? null;

        const pool = await getPool();
        const result = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('externalCallId', sql.NVarChar, callId)
            .input('recordingUrl', sql.NVarChar, downloadUrl)
            .input('duration', sql.Int, duration)
            .query(`
                UPDATE oe.VendorCallLogs
                SET HasRecording = CASE WHEN @recordingUrl IS NOT NULL THEN 1 ELSE HasRecording END,
                    RecordingUrl = COALESCE(@recordingUrl, RecordingUrl),
                    RecordingDurationSeconds = COALESCE(@duration, RecordingDurationSeconds),
                    ModifiedDate = GETDATE()
                OUTPUT INSERTED.CallLogId
                WHERE VendorId = @vendorId AND ExternalCallId = @externalCallId
            `);

        if (result.recordset.length > 0) {
            const callLogId = result.recordset[0].CallLogId;
            console.log(`📞 Recording added to call: ${callId}`);
            await this.mirrorCallLogToEncounter(callLogId, { recordingUrl: downloadUrl })
                .catch(e => console.error('⚠ encounter mirror failed:', e.message));
            return { handled: true, callLogId };
        }
        // Race: webhook arrived before call_ended. Upsert a placeholder so we don't lose the data.
        const placeholderId = await this.upsertCallLogByExternalCallId(vendorId, callId, { callType: 'Inbound', callStatus: 'Pending' });
        if (placeholderId) {
            await pool.request()
                .input('callLogId', sql.UniqueIdentifier, placeholderId)
                .input('recordingUrl', sql.NVarChar, downloadUrl)
                .input('duration', sql.Int, duration)
                .query(`UPDATE oe.VendorCallLogs SET HasRecording=1, RecordingUrl=@recordingUrl, RecordingDurationSeconds=@duration, ModifiedDate=GETDATE() WHERE CallLogId=@callLogId`);
            console.log(`📞 Recording attached to placeholder ${placeholderId} for early call ${callId}`);
            return { handled: true, callLogId: placeholderId, placeholder: true };
        }
        return { handled: false, callLogId: null };
    }

    /**
     * Patch the linked encounter (found by ExternalRef=CallLogId) with late-
     * arriving call data: RecordingUrl, TranscriptText, summary fields.
     *
     * AI summary updates *replace* the encounter's Summary field, but only
     * when no human has edited the encounter (ModifiedBy IS NULL). This
     * preserves agent notes while still showing the auto-generated summary
     * on untouched encounters.
     */
    static async mirrorCallLogToEncounter(callLogId, patch = {}) {
        if (!callLogId) return;
        const pool = await getPool();

        // Find the linked encounter
        const r = await pool.request()
            .input('externalRef', sql.NVarChar, callLogId)
            .query(`SELECT TOP 1 EncounterId, ModifiedBy FROM oe.Encounters WHERE Source='zoom_phone' AND ExternalRef=@externalRef`);
        if (r.recordset.length === 0) return;
        const enc = r.recordset[0];

        const sets = ['ModifiedDate = SYSUTCDATETIME()'];
        const req = pool.request().input('encounterId', sql.UniqueIdentifier, enc.EncounterId);

        if (patch.recordingUrl !== undefined) {
            sets.push('RecordingUrl = COALESCE(@recordingUrl, RecordingUrl)');
            req.input('recordingUrl', sql.NVarChar, patch.recordingUrl);
        }
        if (patch.transcriptText !== undefined) {
            sets.push('TranscriptText = COALESCE(@transcriptText, TranscriptText)');
            req.input('transcriptText', sql.NVarChar(sql.MAX), patch.transcriptText);
        }
        if (patch.notes !== undefined) {
            sets.push('Notes = @notes');
            req.input('notes', sql.NVarChar(sql.MAX), patch.notes);
        }
        // Summary replacement: only if human hasn't touched the encounter
        const newSummary = patch.aiSummary || patch.zoomAISummary;
        if (newSummary && enc.ModifiedBy == null) {
            sets.push('Summary = @summary');
            req.input('summary', sql.NVarChar(sql.MAX), newSummary);
        }

        if (sets.length === 1) return; // nothing meaningful to update

        await req.query(`UPDATE oe.Encounters SET ${sets.join(', ')} WHERE EncounterId = @encounterId`);
    }

    /**
     * Best-effort auto-create an Encounter row for a finished call.
     * Idempotent on (VendorId, ExternalRef=CallLogId). Logs and swallows errors.
     */
    static async ensureEncounterForCallLog(vendorId, callLogId) {
        if (!callLogId) return null;
        const EncounterService = require('./encounterService');
        try {
            return await EncounterService.createFromCallLog(vendorId, callLogId, {
                userId: null,
                userName: 'system:zoom_phone',
            });
        } catch (e) {
            console.error(`⚠ ensureEncounterForCallLog(${callLogId}) failed:`, e.message);
            return null;
        }
    }

    /**
     * Verify Zoom webhook signature
     */
    static verifyWebhookSignature(payload, signature, timestamp, secretToken) {
        const message = `v0:${timestamp}:${JSON.stringify(payload)}`;
        const hashForVerify = crypto.createHmac('sha256', secretToken)
            .update(message)
            .digest('hex');
        
        const expectedSignature = `v0=${hashForVerify}`;
        return signature === expectedSignature;
    }

    /**
     * Get active calls for a vendor
     */
    static async getActiveCalls(vendorId) {
        const pool = await getPool();
        const result = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query(`
                SELECT *
                FROM oe.VendorActiveCalls
                WHERE VendorId = @vendorId
                  AND (CallStatus <> 'Ended' OR LastUpdated > DATEADD(SECOND, -60, GETDATE()))
                ORDER BY CallStartTime DESC
            `);

        return result.recordset;
    }

    /**
     * Search members by phone number
     */
    static async searchMembersByPhone(vendorId, phone) {
        const normalizedPhone = (phone || '').replace(/\D/g, '');
        if (!normalizedPhone) return [];

        const pool = await getPool();
        const result = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('phone', sql.NVarChar, `%${normalizedPhone}%`)
            .query(`
                SELECT DISTINCT TOP 20
                    m.MemberId,
                    m.HouseholdId,
                    u.FirstName,
                    u.LastName,
                    u.PhoneNumber AS Phone,
                    u.Email
                FROM oe.Members m
                INNER JOIN oe.Users u ON m.UserId = u.UserId
                INNER JOIN oe.Enrollments e ON m.MemberId = e.MemberId
                INNER JOIN oe.Products p ON e.ProductId = p.ProductId
                WHERE p.VendorId = @vendorId
                AND REPLACE(REPLACE(REPLACE(REPLACE(u.PhoneNumber, '-', ''), '(', ''), ')', ''), ' ', '') LIKE @phone
                ORDER BY u.LastName, u.FirstName
            `);

        return result.recordset;
    }

    /**
     * Search share requests by phone or member name
     */
    static async searchShareRequests(vendorId, searchTerm) {
        const pool = await getPool();
        const result = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('search', sql.NVarChar, `%${searchTerm}%`)
            .query(`
                SELECT TOP 20
                    sr.ShareRequestId,
                    sr.RequestNumber,
                    sr.Status,
                    sr.TotalBilled,
                    sr.CreatedDate,
                    m.MemberId,
                    u.FirstName as MemberFirstName,
                    u.LastName as MemberLastName,
                    u.PhoneNumber as MemberPhone
                FROM oe.ShareRequests sr
                INNER JOIN oe.Members m ON sr.MemberId = m.MemberId
                LEFT JOIN oe.Users u ON m.UserId = u.UserId
                WHERE sr.VendorId = @vendorId
                AND sr.IsActive = 1
                AND (
                    sr.RequestNumber LIKE @search
                    OR u.FirstName LIKE @search
                    OR u.LastName LIKE @search
                    OR REPLACE(REPLACE(REPLACE(REPLACE(u.PhoneNumber, '-', ''), '(', ''), ')', ''), ' ', '') LIKE @search
                )
                ORDER BY sr.CreatedDate DESC
            `);

        return result.recordset;
    }

    /**
     * Sync call history from Zoom Phone API
     * Fetches recent calls and imports them into our database
     * Uses GET /phone/call_logs endpoint
     * See: https://developers.zoom.us/docs/api/rest/reference/phone/methods/#operation/getPhoneCallLogs
     */
    static async syncCallHistory(vendorId, options = {}) {
        console.log(`📞 Starting Zoom call history sync for vendor ${vendorId}`);
        
        const config = await this.getVendorConfig(vendorId);
        const accessToken = await this.getAccessToken(config);
        const pool = await getPool();

        // Default to last 7 days if not specified
        // Format: YYYY-MM-DD (Zoom requires this format)
        const fromDate = options.fromDate || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        const toDate = options.toDate || new Date().toISOString().split('T')[0];

        let totalFetched = 0;
        let totalImported = 0;
        let totalSkipped = 0;
        let totalMatched = 0;
        let nextPageToken = null;
        const maxPages = 50; // Limit to prevent infinite loops
        let pageCount = 0;

        // Prefer Zoom's modern Call History API. The legacy Call Logs API is
        // deprecated (Zoom sunset ~2026), so we only fall back to it if Call
        // History isn't available for this account/scope.
        let endpoint = 'call_history';

        do {
            // Safety check to prevent infinite loops
            if (pageCount >= maxPages) {
                console.log(`⚠️ Reached maximum page limit (${maxPages}), stopping sync`);
                break;
            }
            pageCount++;

            // Fetch call logs from Zoom using the correct endpoint
            // GET /phone/call_logs - requires phone:read:admin or phone_call_log:read:admin scope
            const params = new URLSearchParams({
                page_size: '100',
                from: fromDate,
                to: toDate
            });
            // The legacy call_logs endpoint wants an explicit type filter.
            if (endpoint === 'call_logs') {
                params.append('type', 'all');
            }

            if (nextPageToken) {
                params.append('next_page_token', nextPageToken);
            }

            console.log(`📞 Fetching Zoom /phone/${endpoint} (page ${pageCount}): from=${fromDate} to=${toDate}`);

            // Add timeout to fetch request
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 25000); // 25 second timeout per request

            let response;
            try {
                response = await fetch(`https://api.zoom.us/v2/phone/${endpoint}?${params}`, {
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json'
                    },
                    signal: controller.signal
                });
                clearTimeout(timeoutId);
            } catch (fetchError) {
                clearTimeout(timeoutId);
                if (fetchError.name === 'AbortError') {
                    throw new Error('Zoom API request timed out. Please try again with a smaller date range.');
                }
                throw fetchError;
            }

            if (!response.ok) {
                const errorText = await response.text();
                console.error(`❌ Zoom /phone/${endpoint} failed:`, response.status, errorText);
                // Auto-fall back from the modern API to the legacy one once.
                if (endpoint === 'call_history') {
                    console.log('📞 Falling back to deprecated /phone/call_logs endpoint');
                    endpoint = 'call_logs';
                    pageCount--; // don't count the failed attempt against the page cap
                    continue;
                }
                throw new Error(`Failed to fetch call logs from Zoom: ${response.status}`);
            }

            const data = await response.json();
            // Call History and Call Logs both return the rows under call_logs;
            // tolerate a call_history key just in case.
            const callLogs = data.call_logs || data.call_history || [];
            nextPageToken = data.next_page_token;

            console.log(`📞 Retrieved ${callLogs.length} calls from Zoom`);
            
            // Log first call to see full data structure
            if (callLogs.length > 0 && totalFetched === 0) {
                const firstCall = callLogs[0];
                console.log('📞 ====== SAMPLE CALL DATA FROM ZOOM /phone/call_logs ======');
                console.log('📞 Full data:', JSON.stringify(firstCall, null, 2));
                console.log('📞 Key fields:');
                console.log('  - date_time:', firstCall.date_time);
                console.log('  - caller_number:', firstCall.caller_number);
                console.log('  - caller_name:', firstCall.caller_name);
                console.log('  - callee_number:', firstCall.callee_number);
                console.log('  - callee_did_number:', firstCall.callee_did_number);
                console.log('  - callee_name:', firstCall.callee_name);
                console.log('  - direction:', firstCall.direction);
                console.log('  - duration:', firstCall.duration);
                console.log('📞 =========================================================');
            }
            
            totalFetched += callLogs.length;

            // Process each call through the shared importer (dedup + member match
            // + agent attribution + new-column population).
            for (const call of callLogs) {
                try {
                    const r = await this.storeSyncedCall(vendorId, call, config);
                    if (r.skipped) {
                        totalSkipped++;
                    } else if (r.imported) {
                        totalImported++;
                        if (r.matched) totalMatched++;
                    }
                } catch (callError) {
                    console.error(`❌ Error importing call ${call.id}:`, callError.message);
                }
            }

        } while (nextPageToken);

        console.log(`✅ Zoom sync complete: ${totalFetched} fetched, ${totalImported} imported, ${totalSkipped} skipped, ${totalMatched} matched`);

        return {
            success: true,
            totalFetched,
            totalImported,
            totalSkipped,
            totalMatched,
            fromDate,
            toDate
        };
    }

    /**
     * Alternate sync method: fetch call logs per user
     * Uses GET /phone/users/{userId}/call_logs endpoint
     * This works when account-level endpoint isn't available
     */
    static async syncCallHistoryViaUsers(vendorId, config, accessToken, pool, fromDate, toDate) {
        console.log(`📞 Using per-user call log sync approach`);
        
        let totalFetched = 0;
        let totalImported = 0;
        let totalSkipped = 0;
        let totalMatched = 0;

        // First, try to get list of phone users using different endpoints
        let usersResponse = await fetch('https://api.zoom.us/v2/phone/users?page_size=100', {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            }
        });

        // If /phone/users fails, try /users endpoint and filter for phone users
        if (!usersResponse.ok) {
            console.log('📞 /phone/users failed, trying /users endpoint...');
            usersResponse = await fetch('https://api.zoom.us/v2/users?page_size=100&status=active', {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            });
        }

        if (!usersResponse.ok) {
            const errorText = await usersResponse.text();
            console.error('❌ Failed to get users:', errorText);
            
            // Last resort: try to get call logs for the current user only
            console.log('📞 Trying to get calls for authenticated user only...');
            return await this.syncCallHistoryForCurrentUser(vendorId, config, accessToken, pool, fromDate, toDate);
        }

        const usersData = await usersResponse.json();
        const phoneUsers = usersData.users || [];
        
        console.log(`📞 Found ${phoneUsers.length} phone users`);

        // Fetch call logs for each user
        for (const user of phoneUsers) {
            try {
                console.log(`📞 Fetching calls for user: ${user.email || user.id}`);
                
                let nextPageToken = null;
                do {
                    const params = new URLSearchParams({
                        page_size: '100',
                        from: fromDate,
                        to: toDate
                    });

                    if (nextPageToken) {
                        params.append('next_page_token', nextPageToken);
                    }

                    const callsResponse = await fetch(
                        `https://api.zoom.us/v2/phone/users/${user.id}/call_logs?${params}`,
                        {
                            headers: {
                                'Authorization': `Bearer ${accessToken}`,
                                'Content-Type': 'application/json'
                            }
                        }
                    );

                    if (!callsResponse.ok) {
                        console.error(`❌ Failed to get calls for user ${user.id}:`, await callsResponse.text());
                        break;
                    }

                    const callsData = await callsResponse.json();
                    const callLogs = callsData.call_logs || [];
                    nextPageToken = callsData.next_page_token;

                    totalFetched += callLogs.length;

                    // Process each call
                    for (const call of callLogs) {
                        try {
                            const r = await this.storeSyncedCall(vendorId, call, config);
                            if (r.skipped) totalSkipped++;
                            if (r.imported) {
                                totalImported++;
                                if (r.matched) totalMatched++;
                            }
                        } catch (callError) {
                            console.error(`❌ Error importing call ${call.id}:`, callError.message);
                        }
                    }

                } while (nextPageToken);

            } catch (userError) {
                console.error(`❌ Error processing user ${user.id}:`, userError.message);
            }
        }

        console.log(`✅ Zoom sync complete: ${totalFetched} fetched, ${totalImported} imported, ${totalSkipped} skipped, ${totalMatched} matched`);

        return {
            success: true,
            totalFetched,
            totalImported,
            totalSkipped,
            totalMatched,
            fromDate,
            toDate
        };
    }

    /**
     * Sync call history for the current authenticated user only
     * Uses 'me' as user ID - works with basic phone:read:call:admin scope
     */
    static async syncCallHistoryForCurrentUser(vendorId, config, accessToken, pool, fromDate, toDate) {
        console.log(`📞 Fetching call logs for authenticated user ('me')`);
        
        let totalFetched = 0;
        let totalImported = 0;
        let totalSkipped = 0;
        let totalMatched = 0;

        let nextPageToken = null;
        do {
            const params = new URLSearchParams({
                page_size: '100',
                from: fromDate,
                to: toDate
            });

            if (nextPageToken) {
                params.append('next_page_token', nextPageToken);
            }

            // Try to get call logs for 'me' (authenticated user)
            const response = await fetch(
                `https://api.zoom.us/v2/phone/users/me/call_logs?${params}`,
                {
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            if (!response.ok) {
                const errorText = await response.text();
                console.error('❌ Failed to get calls for me:', response.status, errorText);
                throw new Error(`Cannot access call logs. Please add scope: phone:read:list_call_logs:admin or phone:read:call_log:admin`);
            }

            const data = await response.json();
            const callLogs = data.call_logs || [];
            nextPageToken = data.next_page_token;

            console.log(`📞 Retrieved ${callLogs.length} calls`);
            totalFetched += callLogs.length;

            // Process each call
            for (const call of callLogs) {
                try {
                    const r = await this.storeSyncedCall(vendorId, call, config);
                    if (r.skipped) totalSkipped++;
                    if (r.imported) {
                        totalImported++;
                        if (r.matched) totalMatched++;
                    }
                } catch (callError) {
                    console.error(`❌ Error importing call ${call.id}:`, callError.message);
                }
            }

        } while (nextPageToken);

        console.log(`✅ Zoom sync complete: ${totalFetched} fetched, ${totalImported} imported, ${totalSkipped} skipped, ${totalMatched} matched`);

        return {
            success: true,
            totalFetched,
            totalImported,
            totalSkipped,
            totalMatched,
            fromDate,
            toDate
        };
    }

    /**
     * Match phone to member for sync (uses vendor enrollments)
     */
    static async matchPhoneToMemberForSync(vendorId, phoneNumber) {
        if (!phoneNumber) return null;

        // Normalize phone number (remove non-digits)
        const normalizedPhone = phoneNumber.replace(/\D/g, '');
        const last10 = normalizedPhone.slice(-10);

        if (last10.length < 10) return null;

        const pool = await getPool();
        const result = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('phone', sql.NVarChar, `%${last10}`)
            .query(`
                SELECT DISTINCT TOP 1 m.MemberId
                FROM oe.Members m
                INNER JOIN oe.Users u ON m.UserId = u.UserId
                INNER JOIN oe.Enrollments e ON m.MemberId = e.MemberId
                INNER JOIN oe.Products p ON e.ProductId = p.ProductId
                WHERE p.VendorId = @vendorId
                AND e.Status = 'Active'
                AND REPLACE(REPLACE(REPLACE(REPLACE(u.PhoneNumber, '-', ''), '(', ''), ')', ''), ' ', '') LIKE @phone
            `);

        return result.recordset.length > 0 ? result.recordset[0] : null;
    }

    // =========================================================================
    // Normalization helpers
    // =========================================================================

    /**
     * Normalize a Zoom Phone *webhook* call object into a flat shape, tolerating
     * both the nested (caller/callee objects) and legacy flat field layouts.
     * `isInbound` decides which party is our internal agent.
     */
    static extractWebhookCall(obj = {}, isInbound = true) {
        const caller = obj.caller || {};
        const callee = obj.callee || {};

        // Pick the best phone-number-like value for a party. For off-net PSTN legs
        // Zoom puts a junk value (e.g. "FreeSWITCH") in `phone_number` and the real
        // external number in `extension_number`, so prefer whichever actually looks
        // like a phone number (>= 10 digits). Falls back to phone_number otherwise
        // (e.g. internal users whose extension_number is a short extension).
        const bestNumber = (party = {}, ...extra) => {
            const candidates = [party.phone_number, party.extension_number, ...extra];
            const phoneLike = candidates.find(
                (v) => String(v ?? '').replace(/\D/g, '').length >= 10
            );
            return phoneLike != null
                ? String(phoneLike)
                : (party.phone_number || extra.find(Boolean) || null);
        };

        const callerNumber = bestNumber(caller, obj.caller_number);
        const callerName = caller.name || obj.caller_name || null;
        const calleeNumber = bestNumber(callee, obj.callee_did_number, obj.callee_number);
        const calleeName = callee.name || obj.callee_name || null;

        // Our internal agent is the callee on inbound calls, the caller on outbound.
        const agentParty = isInbound ? callee : caller;

        return {
            callId: obj.call_id || obj.id || obj.call_log_id || null,
            callerNumber,
            callerName,
            calleeNumber,
            calleeName,
            durationSeconds: typeof obj.duration === 'number' ? obj.duration : null,
            handupResult: obj.handup_result || obj.hangup_result || null,
            agent: {
                userId: agentParty.user_id || obj.user_id || null,
                email: agentParty.email || null,
                extension: agentParty.extension_number != null
                    ? String(agentParty.extension_number)
                    : ((isInbound ? obj.callee_number : null) || null),
                name: agentParty.name || null,
            },
        };
    }

    /**
     * Classify *who answered* (or *who is the internal party on*) a Zoom call.
     * Reads the same payload shape as extractWebhookCall — supports both nested
     * (webhook lifecycle) and flat (voicemail / older call_logs) layouts.
     * Returns one of: 'User', 'AutoReceptionist', 'CallQueue', 'CommonArea',
     * 'SharedLineGroup', or null when undetermined.
     *
     * NOTE: lifecycle webhooks use camelCase ('autoReceptionist'), the
     * call_logs REST API uses snake_case ('auto_receptionist'). Normalize both.
     */
    /**
     * Strip the recording-segment suffix that Zoom appends to call_id in
     * recording/transcript webhooks (e.g. "7644329230366045762_1" → "7644329230366045762").
     * Lifecycle events (callee_ringing, callee_ended) use the bare id, so lookups
     * must normalise before hitting the DB.
     */
    static normalizeExternalCallId(callId) {
        if (callId == null) return null;
        return String(callId).replace(/_\d+$/, '');
    }

    static classifyAnsweredBy(obj = {}, isInbound = true) {
        const party = isInbound ? (obj.callee || {}) : (obj.caller || {});
        const rawType =
            party.extension_type
            || (isInbound ? obj.callee_extension_type : obj.caller_extension_type)
            || (isInbound ? obj.callee_ext_type : obj.caller_ext_type)
            || obj.path
            || null;

        if (!rawType) {
            // Voicemail-style flat payload sometimes has callee_user_id without an explicit type
            if (isInbound && obj.callee_user_id) return 'User';
            return null;
        }

        const t = String(rawType).toLowerCase().replace(/_/g, '');
        if (t === 'user' || t === 'extension') return 'User';
        if (t === 'autoreceptionist') return 'AutoReceptionist';
        if (t === 'callqueue') return 'CallQueue';
        if (t === 'commonarea' || t === 'commonareaphone') return 'CommonArea';
        if (t === 'sharedlinegroup') return 'SharedLineGroup';
        return null;
    }

    /**
     * Resolve an internal vendor-agent UserId from a Zoom identity, first via the
     * VendorPhoneAgentMap, then falling back to matching the Zoom email to a
     * vendor user's email.
     */
    static async resolveAgentUserId(vendorId, identity = {}) {
        const { userId: zoomUserId, email, extension } = identity;
        if (!zoomUserId && !email && !extension) return null;

        const pool = await getPool();
        const mapRes = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('zoomUserId', sql.NVarChar, zoomUserId || null)
            .input('email', sql.NVarChar, email || null)
            .input('extension', sql.NVarChar, extension || null)
            .query(`
                SELECT TOP 1 UserId
                FROM oe.VendorPhoneAgentMap
                WHERE VendorId = @vendorId AND IsActive = 1 AND UserId IS NOT NULL
                  AND (
                    (@zoomUserId IS NOT NULL AND ZoomUserId = @zoomUserId)
                    OR (@email IS NOT NULL AND ZoomEmail = @email)
                    OR (@extension IS NOT NULL AND ZoomExtension = @extension)
                  )
                ORDER BY CASE
                    WHEN ZoomUserId = @zoomUserId THEN 0
                    WHEN ZoomEmail = @email THEN 1
                    ELSE 2 END
            `);
        if (mapRes.recordset.length > 0) return mapRes.recordset[0].UserId;

        if (email) {
            const uRes = await pool.request()
                .input('vendorId', sql.UniqueIdentifier, vendorId)
                .input('email', sql.NVarChar, email)
                .query(`SELECT TOP 1 UserId FROM oe.Users WHERE VendorId = @vendorId AND Email = @email`);
            if (uRes.recordset.length > 0) return uRes.recordset[0].UserId;
        }
        return null;
    }

    static async lookupUserName(userId) {
        if (!userId) return null;
        const pool = await getPool();
        const r = await pool.request()
            .input('userId', sql.UniqueIdentifier, userId)
            .query(`SELECT FirstName, LastName FROM oe.Users WHERE UserId = @userId`);
        if (!r.recordset.length) return null;
        const u = r.recordset[0];
        return `${u.FirstName || ''} ${u.LastName || ''}`.trim() || null;
    }

    /**
     * Import a single call row returned by the sync (call_history / call_logs).
     * Handles dedup, member match, and agent attribution.
     * @returns {Promise<{skipped?:boolean, imported?:boolean, matched?:boolean}>}
     */
    static async storeSyncedCall(vendorId, call, config) {
        const pool = await getPool();
        const externalId = call.id || call.call_id;

        const existingCheck = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('externalCallId', sql.NVarChar, externalId)
            .query(`SELECT CallLogId FROM oe.VendorCallLogs WHERE VendorId = @vendorId AND ExternalCallId = @externalCallId`);
        if (existingCheck.recordset.length > 0) {
            return { skipped: true };
        }

        const direction = (call.direction || '').toLowerCase();
        const callType = direction === 'outbound' ? 'Outbound' : 'Inbound';
        const callerNumber = call.caller_number || call.caller?.phone_number || null;
        const calleeNumber = call.callee_did_number || call.callee_number || call.callee?.phone_number || null;

        // Member match against the external party
        let memberId = null;
        let matchedBy = null;
        const phoneToMatch = callType === 'Inbound' ? callerNumber : calleeNumber;
        if (phoneToMatch && config.autoMatchEnabled) {
            const m = await this.matchPhoneToMemberForSync(vendorId, phoneToMatch);
            if (m) { memberId = m.MemberId; matchedBy = 'Auto'; }
        }

        // Agent attribution (internal party)
        const agentParty = callType === 'Inbound' ? (call.callee || {}) : (call.caller || {});
        const zoomUserId = agentParty.user_id || call.user_id || null;
        const agentEmail = agentParty.email || null;
        const agentExtension = agentParty.extension_number || (callType === 'Inbound' ? call.callee_number : null) || null;
        const agentUserId = await this.resolveAgentUserId(vendorId, { userId: zoomUserId, email: agentEmail, extension: agentExtension });
        const answeredBy = this.classifyAnsweredBy(call, callType === 'Inbound');

        const durationSeconds = call.duration || 0;
        const callDateTime = call.date_time ? new Date(call.date_time) : null;
        const callEndDateTime = callDateTime && durationSeconds
            ? new Date(callDateTime.getTime() + durationSeconds * 1000)
            : null;
        const hasRecording = call.has_recording || !!call.recording_url || false;

        const callLogId = crypto.randomUUID();
        await pool.request()
            .input('callLogId', sql.UniqueIdentifier, callLogId)
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('callType', sql.NVarChar, callType)
            .input('callStatus', sql.NVarChar, call.result || call.call_result || 'Completed')
            .input('callerNumber', sql.NVarChar, callerNumber)
            .input('callerName', sql.NVarChar, call.caller_name || call.caller?.name || null)
            .input('calleeNumber', sql.NVarChar, calleeNumber)
            .input('calleeName', sql.NVarChar, call.callee_name || call.callee?.name || null)
            .input('callStartTime', sql.DateTime2, callDateTime)
            .input('callEndTime', sql.DateTime2, callEndDateTime)
            .input('callDurationSeconds', sql.Int, durationSeconds)
            .input('memberId', sql.UniqueIdentifier, memberId)
            .input('matchedBy', sql.NVarChar, matchedBy)
            .input('agentUserId', sql.UniqueIdentifier, agentUserId)
            .input('agentExtension', sql.NVarChar, agentExtension)
            .input('zoomUserId', sql.NVarChar, zoomUserId)
            .input('agentEmail', sql.NVarChar, agentEmail)
            .input('answeredBy', sql.NVarChar, answeredBy)
            .input('source', sql.NVarChar, 'ZoomPhone')
            .input('externalCallId', sql.NVarChar, externalId)
            .input('hasRecording', sql.Bit, hasRecording)
            .input('recordingUrl', sql.NVarChar, call.recording_url || null)
            .input('rawEventData', sql.NVarChar, JSON.stringify(call))
            .query(`
                INSERT INTO oe.VendorCallLogs (
                    CallLogId, VendorId, CallType, CallStatus,
                    CallerNumber, CallerName, CalleeNumber, CalleeName,
                    CallStartTime, CallEndTime, CallDurationSeconds,
                    MemberId, MatchedBy,
                    AgentUserId, AgentExtension, ZoomUserId, AgentEmail, AnsweredBy,
                    Source, ExternalCallId,
                    HasRecording, RecordingUrl,
                    TranscriptStatus, AISummaryStatus,
                    RawEventData, CreatedDate, IsActive
                ) VALUES (
                    @callLogId, @vendorId, @callType, @callStatus,
                    @callerNumber, @callerName, @calleeNumber, @calleeName,
                    @callStartTime, @callEndTime, @callDurationSeconds,
                    @memberId, @matchedBy,
                    @agentUserId, @agentExtension, @zoomUserId, @agentEmail, @answeredBy,
                    @source, @externalCallId,
                    @hasRecording, @recordingUrl,
                    'None', 'None',
                    @rawEventData, GETDATE(), 1
                )
            `);

        return { imported: true, matched: !!memberId };
    }

    // =========================================================================
    // Transcripts & AI summaries
    // =========================================================================

    /**
     * Download text content from a Zoom URL, trying the documented access_token
     * query-param style first then falling back to a Bearer header.
     */
    static async downloadZoomText(url, accessToken) {
        if (!url) return null;
        const withToken = `${url}${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(accessToken)}`;
        let resp = await fetch(withToken);
        if (!resp.ok) {
            resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
        }
        if (!resp.ok) {
            throw new Error(`Failed to download from Zoom (${resp.status})`);
        }
        return await resp.text();
    }

    /**
     * Handle phone.recording_transcript_completed: download the transcript,
     * store it, then generate an AI summary.
     */
    static async handleTranscriptCompleted(vendorId, payload) {
        const obj = payload?.object || {};
        const first = Array.isArray(obj.recordings) && obj.recordings.length > 0 ? obj.recordings[0] : {};
        const transcriptUrl = first.transcript_download_url || obj.transcript_download_url || obj.download_url || first.download_url || null;
        let callId = obj.call_id || obj.call_log_id || obj.id || first.call_id || first.call_log_id || null;
        callId = this.normalizeExternalCallId(callId);

        const pool = await getPool();
        const found = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('externalCallId', sql.NVarChar, callId)
            .query(`SELECT TOP 1 CallLogId FROM oe.VendorCallLogs WHERE VendorId = @vendorId AND ExternalCallId = @externalCallId`);
        let callLogId = found.recordset[0]?.CallLogId;
        if (!callLogId) {
            // Race: transcript arrived before call_ended. Create placeholder.
            console.log(`⚠️ Transcript for unknown call ${callId} — creating placeholder`);
            callLogId = await this.upsertCallLogByExternalCallId(vendorId, callId, { callType: 'Inbound', callStatus: 'Pending' });
            if (!callLogId) {
                return { handled: false, message: 'Call log not found and could not create placeholder' };
            }
        }

        let transcriptText = null;
        try {
            const config = await this.getVendorConfig(vendorId);
            const accessToken = await this.getAccessToken(config);
            transcriptText = await this.downloadZoomText(transcriptUrl, accessToken);
        } catch (err) {
            console.error('❌ Transcript download failed:', err.message);
            await pool.request()
                .input('callLogId', sql.UniqueIdentifier, callLogId)
                .query(`UPDATE oe.VendorCallLogs SET TranscriptStatus='Failed', ModifiedDate=GETDATE() WHERE CallLogId=@callLogId`);
            return { handled: false, callLogId, message: 'Transcript download failed' };
        }

        await pool.request()
            .input('callLogId', sql.UniqueIdentifier, callLogId)
            .input('transcript', sql.NVarChar(sql.MAX), transcriptText)
            .query(`
                UPDATE oe.VendorCallLogs
                SET TranscriptText = @transcript,
                    TranscriptStatus = 'Available',
                    TranscriptSource = 'Zoom',
                    TranscriptFetchedAt = GETDATE(),
                    ModifiedDate = GETDATE()
                WHERE CallLogId = @callLogId
            `);

        // Mirror transcript into the linked encounter (best-effort, no throw).
        await this.mirrorCallLogToEncounter(callLogId, { transcriptText: transcriptText })
            .catch(e => console.error('⚠ encounter mirror failed:', e.message));

        // Fire-and-forget summary generation (don't block the webhook response).
        this.generateSummaryForCall(callLogId).catch(err =>
            console.error('❌ Auto summary failed:', err.message));

        console.log(`📝 Transcript stored for call ${callId}`);
        return { handled: true, callLogId };
    }

    /**
     * Handle Zoom's native AI Call Summary webhook (April 2025 changelog).
     * Stored in ZoomAISummary — distinct from our OpenAI summary in AISummary.
     */
    static async handleAiCallSummaryChanged(vendorId, payload) {
        const obj = payload?.object || {};
        const callId = this.normalizeExternalCallId(obj.call_id || obj.call_log_id || obj.id || null);
        // Zoom may deliver summary as object { summary, next_steps[] } or as flat string
        let summary = null;
        if (typeof obj.ai_summary === 'string') summary = obj.ai_summary;
        else if (obj.ai_summary && typeof obj.ai_summary === 'object') {
            const parts = [];
            if (obj.ai_summary.summary) parts.push(obj.ai_summary.summary);
            if (Array.isArray(obj.ai_summary.next_steps) && obj.ai_summary.next_steps.length > 0) {
                parts.push('Next steps:\n' + obj.ai_summary.next_steps.map(s => `- ${s}`).join('\n'));
            }
            summary = parts.join('\n\n') || null;
        } else if (typeof obj.summary === 'string') {
            summary = obj.summary;
        }

        if (!callId || !summary) {
            return { handled: false, reason: 'missing_call_id_or_summary' };
        }

        const pool = await getPool();
        const result = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('externalCallId', sql.NVarChar, callId)
            .input('zoomAISummary', sql.NVarChar(sql.MAX), summary)
            .query(`
                UPDATE oe.VendorCallLogs
                SET ZoomAISummary = @zoomAISummary,
                    ZoomAISummaryReceivedAt = GETDATE(),
                    ModifiedDate = GETDATE()
                OUTPUT INSERTED.CallLogId
                WHERE VendorId = @vendorId AND ExternalCallId = @externalCallId
            `);

        if (result.recordset.length > 0) {
            const callLogId = result.recordset[0].CallLogId;
            await this.mirrorCallLogToEncounter(callLogId, { zoomAISummary: summary })
                .catch(e => console.error('⚠ encounter mirror failed:', e.message));
            return { handled: true, callLogId };
        }
        // Race: AI summary arrived before call_ended
        const placeholderId = await this.upsertCallLogByExternalCallId(vendorId, callId, { callType: 'Inbound', callStatus: 'Pending' });
        if (placeholderId) {
            await pool.request()
                .input('callLogId', sql.UniqueIdentifier, placeholderId)
                .input('zoomAISummary', sql.NVarChar(sql.MAX), summary)
                .query(`UPDATE oe.VendorCallLogs SET ZoomAISummary=@zoomAISummary, ZoomAISummaryReceivedAt=GETDATE(), ModifiedDate=GETDATE() WHERE CallLogId=@callLogId`);
            return { handled: true, callLogId: placeholderId, placeholder: true };
        }
        return { handled: false };
    }

    /**
     * Generate (or regenerate) an AI summary for a call that has a transcript.
     */
    static async generateSummaryForCall(callLogId, options = {}) {
        const pool = await getPool();
        const r = await pool.request()
            .input('callLogId', sql.UniqueIdentifier, callLogId)
            .query(`
                SELECT cl.CallLogId, cl.TranscriptText, cl.AISummary, cl.CallType,
                       cl.CallDurationSeconds, cl.CallerName,
                       mu.FirstName AS MemberFirst, mu.LastName AS MemberLast,
                       au.FirstName AS AgentFirst, au.LastName AS AgentLast
                FROM oe.VendorCallLogs cl
                LEFT JOIN oe.Members m ON cl.MemberId = m.MemberId
                LEFT JOIN oe.Users mu ON m.UserId = mu.UserId
                LEFT JOIN oe.Users au ON cl.AgentUserId = au.UserId
                WHERE cl.CallLogId = @callLogId
            `);
        if (!r.recordset.length) throw new Error('Call log not found');
        const row = r.recordset[0];

        if (!row.TranscriptText || !row.TranscriptText.trim()) {
            return { summarized: false, reason: 'no_transcript' };
        }
        if (row.AISummary && !options.force) {
            return { summarized: false, reason: 'already_summarized', summary: row.AISummary };
        }

        await pool.request()
            .input('callLogId', sql.UniqueIdentifier, callLogId)
            .query(`UPDATE oe.VendorCallLogs SET AISummaryStatus='Pending', ModifiedDate=GETDATE() WHERE CallLogId=@callLogId`);

        const context = {
            direction: row.CallType,
            callerName: row.CallerName,
            memberName: `${row.MemberFirst || ''} ${row.MemberLast || ''}`.trim() || null,
            agentName: `${row.AgentFirst || ''} ${row.AgentLast || ''}`.trim() || null,
            durationSeconds: row.CallDurationSeconds,
        };

        try {
            const result = await aiCallSummaryService.summarizeTranscript(row.TranscriptText, context);
            if (!result) {
                await pool.request()
                    .input('callLogId', sql.UniqueIdentifier, callLogId)
                    .query(`UPDATE oe.VendorCallLogs SET AISummaryStatus='None', ModifiedDate=GETDATE() WHERE CallLogId=@callLogId`);
                return { summarized: false, reason: 'nothing_to_summarize' };
            }
            await pool.request()
                .input('callLogId', sql.UniqueIdentifier, callLogId)
                .input('summary', sql.NVarChar(sql.MAX), result.summary)
                .input('model', sql.NVarChar, result.model)
                .query(`
                    UPDATE oe.VendorCallLogs
                    SET AISummary = @summary,
                        AISummaryStatus = 'Available',
                        AISummaryGeneratedAt = GETDATE(),
                        AISummaryModel = @model,
                        ModifiedDate = GETDATE()
                    WHERE CallLogId = @callLogId
                `);
            await this.mirrorCallLogToEncounter(callLogId, { aiSummary: result.summary })
                .catch(e => console.error('⚠ encounter mirror failed:', e.message));
            return { summarized: true, summary: result.summary, model: result.model };
        } catch (err) {
            await pool.request()
                .input('callLogId', sql.UniqueIdentifier, callLogId)
                .query(`UPDATE oe.VendorCallLogs SET AISummaryStatus='Failed', ModifiedDate=GETDATE() WHERE CallLogId=@callLogId`);
            throw err;
        }
    }

    // =========================================================================
    // Live calls / "who's on the line"
    // =========================================================================

    /**
     * Active calls with enriched member + agent context for the live view.
     */
    static async getActiveCallsDetailed(vendorId) {
        const pool = await getPool();
        const result = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query(`
                SELECT
                    ac.ActiveCallId, ac.CallType, ac.CallStatus,
                    ac.CallerNumber, ac.CallerName, ac.CalleeNumber, ac.CalleeName,
                    ac.CallStartTime, ac.ExternalCallId,
                    ac.AgentUserId, ac.AgentName, ac.AgentExtension,
                    ac.MemberId,
                    mu.FirstName AS MemberFirstName, mu.LastName AS MemberLastName,
                    mu.Email AS MemberEmail, mu.PhoneNumber AS MemberPhone,
                    m.HouseholdId,
                    (SELECT COUNT(*) FROM oe.Cases ca
                       WHERE ca.MemberId = ac.MemberId AND ca.VendorId = @vendorId
                         AND ca.Status NOT IN ('Closed')) AS OpenCaseCount,
                    (SELECT COUNT(*) FROM oe.ShareRequests sr
                       WHERE sr.MemberId = ac.MemberId AND sr.VendorId = @vendorId
                         AND sr.Status NOT IN ('Completed','Denied','Withdrawn')) AS OpenShareRequestCount
                FROM oe.VendorActiveCalls ac
                LEFT JOIN oe.Members m ON ac.MemberId = m.MemberId
                LEFT JOIN oe.Users mu ON m.UserId = mu.UserId
                WHERE ac.VendorId = @vendorId
                  AND (ac.CallStatus <> 'Ended' OR ac.LastUpdated > DATEADD(SECOND, -60, GETDATE()))
                ORDER BY ac.CallStartTime DESC
            `);
        return result.recordset;
    }

    /**
     * Full member context for a "who's on the line" pop-up: identity + open
     * cases + open share requests, all vendor-scoped.
     */
    static async getMemberCallContext(vendorId, memberId) {
        const pool = await getPool();
        const memberRes = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('memberId', sql.UniqueIdentifier, memberId)
            .query(`
                SELECT TOP 1
                    m.MemberId, m.HouseholdId, FORMAT(m.DateOfBirth,'yyyy-MM-dd') AS DateOfBirth,
                    u.FirstName, u.LastName, u.Email, u.PhoneNumber AS Phone
                FROM oe.Members m
                INNER JOIN oe.Users u ON m.UserId = u.UserId
                WHERE m.MemberId = @memberId
            `);
        if (!memberRes.recordset.length) return null;

        const cases = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('memberId', sql.UniqueIdentifier, memberId)
            .query(`
                SELECT ca.CaseId, ca.CaseNumber, ca.Title, ca.Status, ca.ClaimedByUserId,
                       ca.CreatedDate, ca.SubmittedDate,
                       cu.FirstName AS ClaimedByFirst, cu.LastName AS ClaimedByLast
                FROM oe.Cases ca
                LEFT JOIN oe.Users cu ON ca.ClaimedByUserId = cu.UserId
                WHERE ca.MemberId = @memberId AND ca.VendorId = @vendorId
                  AND ca.Status NOT IN ('Closed')
                ORDER BY ca.CreatedDate DESC
            `);

        const shareRequests = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('memberId', sql.UniqueIdentifier, memberId)
            .query(`
                SELECT sr.ShareRequestId, sr.RequestNumber, sr.Status,
                       sr.TotalBilledAmount, sr.Balance, sr.SubmittedDate, sr.CreatedDate,
                       sr.ClaimedByUserId,
                       srt.Name AS RequestTypeName
                FROM oe.ShareRequests sr
                LEFT JOIN oe.VendorShareRequestTypes srt ON sr.RequestTypeId = srt.TypeId
                WHERE sr.MemberId = @memberId AND sr.VendorId = @vendorId
                  AND sr.Status NOT IN ('Completed','Denied','Withdrawn')
                ORDER BY sr.CreatedDate DESC
            `);

        return {
            member: memberRes.recordset[0],
            openCases: cases.recordset,
            openShareRequests: shareRequests.recordset,
        };
    }

    // =========================================================================
    // Call history list & detail
    // =========================================================================

    static async getCallsList(vendorId, options = {}) {
        const pool = await getPool();
        const request = pool.request();
        request.input('vendorId', sql.UniqueIdentifier, vendorId);

        const where = ['cl.VendorId = @vendorId', 'cl.IsActive = 1'];

        if (options.agentUserId) {
            where.push('cl.AgentUserId = @agentUserId');
            request.input('agentUserId', sql.UniqueIdentifier, options.agentUserId);
        }
        if (options.direction) {
            where.push('cl.CallType = @direction');
            request.input('direction', sql.NVarChar, options.direction);
        }
        if (options.matched === true) where.push('cl.MemberId IS NOT NULL');
        if (options.matched === false) where.push('cl.MemberId IS NULL');
        if (options.hasRecording === true) where.push('cl.HasRecording = 1');
        if (options.hasTranscript === true) where.push('cl.TranscriptText IS NOT NULL');
        if (options.fromDate) {
            where.push('cl.CallStartTime >= @fromDate');
            request.input('fromDate', sql.DateTime2, options.fromDate);
        }
        if (options.toDate) {
            where.push('cl.CallStartTime <= @toDate');
            request.input('toDate', sql.DateTime2, options.toDate);
        }
        if (options.search) {
            where.push(`(
                cl.CallerNumber LIKE @search OR cl.CalleeNumber LIKE @search
                OR cl.CallerName LIKE @search OR cl.CalleeName LIKE @search
                OR mu.FirstName LIKE @search OR mu.LastName LIKE @search
                OR au.FirstName LIKE @search OR au.LastName LIKE @search
                OR sr.RequestNumber LIKE @search
            )`);
            request.input('search', sql.NVarChar, `%${options.search}%`);
        }

        const limit = Math.min(parseInt(options.limit, 10) || 50, 200);
        const offset = parseInt(options.offset, 10) || 0;
        request.input('limit', sql.Int, limit);
        request.input('offset', sql.Int, offset);

        const whereSql = where.join(' AND ');

        const countRes = await request.query(`
            SELECT COUNT(*) AS Total
            FROM oe.VendorCallLogs cl
            LEFT JOIN oe.Members m ON cl.MemberId = m.MemberId
            LEFT JOIN oe.Users mu ON m.UserId = mu.UserId
            LEFT JOIN oe.Users au ON cl.AgentUserId = au.UserId
            LEFT JOIN oe.ShareRequests sr ON cl.ShareRequestId = sr.ShareRequestId
            WHERE ${whereSql}
        `);
        const total = countRes.recordset[0]?.Total || 0;

        const dataRes = await request.query(`
            SELECT
                cl.CallLogId, cl.CallType, cl.CallStatus,
                cl.CallerNumber, cl.CallerName, cl.CalleeNumber, cl.CalleeName,
                cl.CallStartTime, cl.CallEndTime, cl.CallDurationSeconds,
                cl.MemberId, cl.ShareRequestId, cl.MatchedBy,
                cl.AgentUserId, cl.AgentExtension, cl.AnsweredBy,
                cl.HasRecording, cl.RecordingUrl,
                cl.CallNotes, cl.AISummary, cl.AISummaryStatus,
                cl.TranscriptStatus,
                CAST(CASE WHEN cl.TranscriptText IS NOT NULL THEN 1 ELSE 0 END AS BIT) AS HasTranscript,
                cl.Source, cl.CreatedDate,
                mu.FirstName AS MemberFirstName, mu.LastName AS MemberLastName,
                au.FirstName AS AgentFirstName, au.LastName AS AgentLastName,
                sr.RequestNumber
            FROM oe.VendorCallLogs cl
            LEFT JOIN oe.Members m ON cl.MemberId = m.MemberId
            LEFT JOIN oe.Users mu ON m.UserId = mu.UserId
            LEFT JOIN oe.Users au ON cl.AgentUserId = au.UserId
            LEFT JOIN oe.ShareRequests sr ON cl.ShareRequestId = sr.ShareRequestId
            WHERE ${whereSql}
            ORDER BY cl.CallStartTime DESC, cl.CallLogId
            OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
        `);

        return { total, limit, offset, calls: dataRes.recordset };
    }

    static async getCallDetail(vendorId, callLogId) {
        const pool = await getPool();
        const r = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('callLogId', sql.UniqueIdentifier, callLogId)
            .query(`
                SELECT
                    cl.*,
                    mu.FirstName AS MemberFirstName, mu.LastName AS MemberLastName,
                    mu.Email AS MemberEmail, mu.PhoneNumber AS MemberPhone,
                    au.FirstName AS AgentFirstName, au.LastName AS AgentLastName,
                    sr.RequestNumber,
                    enc.EncounterId AS EncounterId,
                    enc.EncounterNumber AS EncounterNumber,
                    enc.CaseId AS EncounterCaseId,
                    enc.ShareRequestId AS EncounterShareRequestId
                FROM oe.VendorCallLogs cl
                LEFT JOIN oe.Members m ON cl.MemberId = m.MemberId
                LEFT JOIN oe.Users mu ON m.UserId = mu.UserId
                LEFT JOIN oe.Users au ON cl.AgentUserId = au.UserId
                LEFT JOIN oe.ShareRequests sr ON cl.ShareRequestId = sr.ShareRequestId
                LEFT JOIN oe.Encounters enc
                    ON enc.VendorId = cl.VendorId
                   AND enc.Source = 'zoom_phone'
                   AND enc.ExternalRef = CAST(cl.CallLogId AS NVARCHAR(200))
                WHERE cl.VendorId = @vendorId AND cl.CallLogId = @callLogId
            `);
        return r.recordset[0] || null;
    }

    // =========================================================================
    // Stats & reports
    // =========================================================================

    /**
     * Aggregate call stats for a vendor, optionally scoped to a single agent
     * (used by VendorAgents to see only their own numbers).
     */
    static async getStats(vendorId, options = {}) {
        const pool = await getPool();
        const request = pool.request();
        request.input('vendorId', sql.UniqueIdentifier, vendorId);
        const where = ['cl.VendorId = @vendorId', 'cl.IsActive = 1'];
        if (options.agentUserId) {
            where.push('cl.AgentUserId = @agentUserId');
            request.input('agentUserId', sql.UniqueIdentifier, options.agentUserId);
        }
        if (options.fromDate) {
            where.push('cl.CallStartTime >= @fromDate');
            request.input('fromDate', sql.DateTime2, options.fromDate);
        }
        if (options.toDate) {
            where.push('cl.CallStartTime <= @toDate');
            request.input('toDate', sql.DateTime2, options.toDate);
        }
        const r = await request.query(`
            SELECT
                COUNT(*) AS TotalCalls,
                SUM(CASE WHEN cl.CallType='Inbound' THEN 1 ELSE 0 END) AS Inbound,
                SUM(CASE WHEN cl.CallType='Outbound' THEN 1 ELSE 0 END) AS Outbound,
                SUM(CASE WHEN cl.CallType='Missed' OR cl.CallStatus='Missed' THEN 1 ELSE 0 END) AS Missed,
                SUM(CASE WHEN cl.CallStatus='Voicemail' THEN 1 ELSE 0 END) AS Voicemail,
                SUM(CASE WHEN cl.MemberId IS NOT NULL THEN 1 ELSE 0 END) AS MatchedToMember,
                SUM(CASE WHEN cl.HasRecording=1 THEN 1 ELSE 0 END) AS WithRecording,
                SUM(CASE WHEN cl.TranscriptText IS NOT NULL THEN 1 ELSE 0 END) AS WithTranscript,
                SUM(CASE WHEN cl.AISummary IS NOT NULL THEN 1 ELSE 0 END) AS WithSummary,
                COALESCE(SUM(cl.CallDurationSeconds),0) AS TotalDurationSeconds,
                COALESCE(AVG(CAST(cl.CallDurationSeconds AS FLOAT)),0) AS AvgDurationSeconds,
                COUNT(DISTINCT cl.MemberId) AS UniqueMembers
            FROM oe.VendorCallLogs cl
            WHERE ${where.join(' AND ')}
        `);
        return r.recordset[0];
    }

    /**
     * Per-agent breakdown for the admin reports tab over a date range.
     */
    static async getAgentReport(vendorId, options = {}) {
        const pool = await getPool();
        const request = pool.request();
        request.input('vendorId', sql.UniqueIdentifier, vendorId);
        const where = ['cl.VendorId = @vendorId', 'cl.IsActive = 1'];
        if (options.fromDate) {
            where.push('cl.CallStartTime >= @fromDate');
            request.input('fromDate', sql.DateTime2, options.fromDate);
        }
        if (options.toDate) {
            where.push('cl.CallStartTime <= @toDate');
            request.input('toDate', sql.DateTime2, options.toDate);
        }
        const r = await request.query(`
            SELECT
                cl.AgentUserId,
                au.FirstName AS AgentFirstName, au.LastName AS AgentLastName,
                COUNT(*) AS TotalCalls,
                SUM(CASE WHEN cl.CallType='Inbound' THEN 1 ELSE 0 END) AS Inbound,
                SUM(CASE WHEN cl.CallType='Outbound' THEN 1 ELSE 0 END) AS Outbound,
                SUM(CASE WHEN cl.CallType='Missed' OR cl.CallStatus='Missed' THEN 1 ELSE 0 END) AS Missed,
                COALESCE(SUM(cl.CallDurationSeconds),0) AS TotalDurationSeconds,
                COALESCE(AVG(CAST(cl.CallDurationSeconds AS FLOAT)),0) AS AvgDurationSeconds,
                COUNT(DISTINCT cl.MemberId) AS UniqueMembers
            FROM oe.VendorCallLogs cl
            LEFT JOIN oe.Users au ON cl.AgentUserId = au.UserId
            WHERE ${where.join(' AND ')}
            GROUP BY cl.AgentUserId, au.FirstName, au.LastName
            ORDER BY TotalCalls DESC
        `);
        return r.recordset;
    }

    // =========================================================================
    // Zoom-user ↔ internal-agent mapping
    // =========================================================================

    /** Internal vendor users available to map Zoom phone users to. */
    static async getVendorUsers(vendorId) {
        const pool = await getPool();
        const r = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query(`
                SELECT UserId, FirstName, LastName, Email
                FROM oe.Users
                WHERE VendorId = @vendorId AND (Status = 'Active' OR Status IS NULL)
                ORDER BY LastName, FirstName
            `);
        return r.recordset;
    }

    static async getAgentMap(vendorId) {
        const pool = await getPool();
        const r = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query(`
                SELECT pam.MapId, pam.ZoomUserId, pam.ZoomEmail, pam.ZoomExtension,
                       pam.ZoomDisplayName, pam.UserId, pam.IsActive,
                       u.FirstName, u.LastName, u.Email AS UserEmail
                FROM oe.VendorPhoneAgentMap pam
                LEFT JOIN oe.Users u ON pam.UserId = u.UserId
                WHERE pam.VendorId = @vendorId
                ORDER BY pam.ZoomDisplayName
            `);
        return r.recordset;
    }

    /**
     * Upsert a single Zoom-user → internal-user mapping (keyed on ZoomUserId).
     */
    static async upsertAgentMap(vendorId, entry, actorUserId) {
        const pool = await getPool();
        await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('zoomUserId', sql.NVarChar, entry.zoomUserId || null)
            .input('zoomEmail', sql.NVarChar, entry.zoomEmail || null)
            .input('zoomExtension', sql.NVarChar, entry.zoomExtension || null)
            .input('zoomDisplayName', sql.NVarChar, entry.zoomDisplayName || null)
            .input('userId', sql.UniqueIdentifier, entry.userId || null)
            .input('actor', sql.UniqueIdentifier, actorUserId || null)
            .query(`
                MERGE oe.VendorPhoneAgentMap AS target
                USING (SELECT @vendorId AS VendorId, @zoomUserId AS ZoomUserId) AS src
                  ON target.VendorId = src.VendorId AND target.ZoomUserId = src.ZoomUserId
                WHEN MATCHED THEN UPDATE SET
                    ZoomEmail = @zoomEmail, ZoomExtension = @zoomExtension,
                    ZoomDisplayName = @zoomDisplayName, UserId = @userId,
                    IsActive = 1, ModifiedDate = GETDATE(), ModifiedBy = @actor
                WHEN NOT MATCHED THEN INSERT
                    (VendorId, ZoomUserId, ZoomEmail, ZoomExtension, ZoomDisplayName, UserId, CreatedBy)
                    VALUES (@vendorId, @zoomUserId, @zoomEmail, @zoomExtension, @zoomDisplayName, @userId, @actor);
            `);
        return true;
    }

    /**
     * List Zoom phone users merged with their current internal mapping +
     * a suggested internal user (matched by email).
     */
    static async listZoomUsersForMapping(vendorId) {
        const [zoomData, currentMap, vendorUsers] = await Promise.all([
            this.getPhoneUsers(vendorId),
            this.getAgentMap(vendorId),
            this.getVendorUsers(vendorId),
        ]);

        const zoomUsers = zoomData.users || [];
        const mapByZoomId = new Map(currentMap.map(m => [m.ZoomUserId, m]));
        const userByEmail = new Map(
            vendorUsers.filter(u => u.Email).map(u => [u.Email.toLowerCase(), u])
        );

        const merged = zoomUsers.map(zu => {
            const existing = mapByZoomId.get(zu.id);
            const suggested = zu.email ? userByEmail.get(zu.email.toLowerCase()) : null;
            return {
                zoomUserId: zu.id,
                zoomEmail: zu.email || null,
                zoomDisplayName: zu.name
                    || [zu.first_name, zu.last_name].filter(Boolean).join(' ')
                    || zu.email || zu.id,
                zoomExtension: zu.extension_number ? String(zu.extension_number) : null,
                mappedUserId: existing?.UserId || null,
                suggestedUserId: !existing?.UserId && suggested ? suggested.UserId : null,
            };
        });

        return { zoomUsers: merged, vendorUsers };
    }
}

module.exports = ZoomPhoneService;

