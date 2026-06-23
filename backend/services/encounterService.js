// services/encounterService.js
// Encounters — back-office, vendor-scoped record of conversations the care
// team has with members. Mirrors the shape of caseService.js.
// Schema: sql-changes/2026-05-15-encounters-tables.sql.

const { getPool, sql } = require('../config/database');

const ENCOUNTER_CHANNELS   = ['phone', 'email', 'in_person', 'sms', 'video', 'other'];
const ENCOUNTER_DIRECTIONS = ['inbound', 'outbound', 'internal'];
const ENCOUNTER_SOURCES    = ['manual', 'zoom_phone', 'zoom_meeting', 'imported', 'email'];

const isValidChannel   = (v) => v == null || ENCOUNTER_CHANNELS.includes(v);
const isValidDirection = (v) => v == null || ENCOUNTER_DIRECTIONS.includes(v);

/**
 * Generate ENC-YYYY-NNNN where NNNN is the next sequence for this vendor in the
 * current calendar year. Race possible — unique constraint catches duplicates
 * and the caller retries.
 */
async function generateEncounterNumber(pool, vendorId) {
    const year = new Date().getUTCFullYear();
    const prefix = `ENC-${year}-`;
    const r = await pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .input('prefix', sql.NVarChar, `${prefix}%`)
        .query(`
            SELECT COUNT(*) AS Count
            FROM oe.Encounters
            WHERE VendorId = @vendorId AND EncounterNumber LIKE @prefix
        `);
    const next = (r.recordset[0]?.Count || 0) + 1;
    return `${prefix}${String(next).padStart(4, '0')}`;
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

async function getDashboardStats(vendorId, userId) {
    const pool = await getPool();
    const r = await pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .input('userId', sql.UniqueIdentifier, userId || null)
        .query(`
            DECLARE @startOfDay DATETIME2 = CAST(SYSUTCDATETIME() AS DATE);
            DECLARE @startOfNextWeek DATETIME2 = DATEADD(DAY, 7, @startOfDay);

            SELECT
                COUNT(*)                                                              AS Total,
                SUM(CASE WHEN MemberId IS NULL THEN 1 ELSE 0 END)                     AS NoMember,
                SUM(CASE WHEN CreatedBy = @userId THEN 1 ELSE 0 END)                  AS Mine,
                SUM(CASE WHEN FollowUpDueDate IS NOT NULL
                          AND FollowUpCompletedAt IS NULL THEN 1 ELSE 0 END)          AS FollowUpOpen,
                SUM(CASE WHEN FollowUpDueDate IS NOT NULL
                          AND FollowUpCompletedAt IS NULL
                          AND FollowUpDueDate < @startOfNextWeek THEN 1 ELSE 0 END)   AS FollowUpDueThisWeek,
                SUM(CASE WHEN CreatedDate >= @startOfDay THEN 1 ELSE 0 END)           AS Today,
                SUM(CASE WHEN Channel = 'phone'    THEN 1 ELSE 0 END)                 AS ChPhone,
                SUM(CASE WHEN Channel = 'email'    THEN 1 ELSE 0 END)                 AS ChEmail,
                SUM(CASE WHEN Channel = 'in_person'THEN 1 ELSE 0 END)                 AS ChInPerson,
                SUM(CASE WHEN Channel = 'sms'      THEN 1 ELSE 0 END)                 AS ChSms,
                SUM(CASE WHEN Channel = 'video'    THEN 1 ELSE 0 END)                 AS ChVideo,
                SUM(CASE WHEN Channel = 'other' OR Channel IS NULL THEN 1 ELSE 0 END) AS ChOther
            FROM oe.Encounters
            WHERE VendorId = @vendorId AND IsArchived = 0
        `);
    const row = r.recordset[0] || {};
    return {
        Total: row.Total || 0,
        NoMember: row.NoMember || 0,
        Mine: row.Mine || 0,
        FollowUpOpen: row.FollowUpOpen || 0,
        FollowUpDueThisWeek: row.FollowUpDueThisWeek || 0,
        Today: row.Today || 0,
        ByChannel: {
            phone: row.ChPhone || 0,
            email: row.ChEmail || 0,
            in_person: row.ChInPerson || 0,
            sms: row.ChSms || 0,
            video: row.ChVideo || 0,
            other: row.ChOther || 0
        }
    };
}

// ---------------------------------------------------------------------------
// List + read
// ---------------------------------------------------------------------------

const SELECT_COLUMNS = `
    e.EncounterId, e.VendorId, e.EncounterNumber, e.MemberId, e.CaseId, e.ShareRequestId,
    e.Summary, e.Notes, e.Channel, e.Direction, e.Source, e.ExternalRef, e.OccurredAt,
    e.DurationSeconds, e.RecordingUrl,
    e.AssignedToUserId, e.FollowUpDueDate, e.FollowUpCompletedAt,
    e.IsArchived, e.CreatedDate, e.CreatedBy, e.CreatedByName,
    e.ModifiedDate, e.ModifiedBy,
    mu.FirstName AS MemberFirstName, mu.LastName AS MemberLastName,
    mu.Email AS MemberEmail, mu.PhoneNumber AS MemberPhone,
    au.FirstName AS AssignedToFirstName, au.LastName AS AssignedToLastName,
    au.PreferredColor AS AssignedToColor,
    cb.FirstName AS CreatedByFirstName, cb.LastName AS CreatedByLastName,
    t.CaseNumber AS PinnedCaseNumber,
    sr.RequestNumber AS PinnedShareRequestNumber,
    e.EmailMessageId,
    em.ThreadId AS EmailThreadId
`;

const FROM_JOINS = `
    FROM oe.Encounters e
    LEFT JOIN oe.Members m ON m.MemberId = e.MemberId
    LEFT JOIN oe.Users mu ON mu.UserId = m.UserId
    LEFT JOIN oe.Users au ON au.UserId = e.AssignedToUserId
    LEFT JOIN oe.Users cb ON cb.UserId = e.CreatedBy
    LEFT JOIN oe.Cases t ON t.CaseId = e.CaseId
    LEFT JOIN oe.ShareRequests sr ON sr.ShareRequestId = e.ShareRequestId
    LEFT JOIN oe.EmailMessages em ON em.EmailMessageId = e.EmailMessageId
`;

async function listEncounters(vendorId, opts = {}) {
    const pool = await getPool();
    const page = Math.max(1, parseInt(opts.page || 1, 10));
    const limit = Math.min(100, Math.max(1, parseInt(opts.limit || 25, 10)));
    const offset = (page - 1) * limit;

    const where = ['e.VendorId = @vendorId'];
    const req = pool.request().input('vendorId', sql.UniqueIdentifier, vendorId);

    if (opts.archived === 'true' || opts.archived === true) {
        where.push('e.IsArchived = 1');
    } else {
        where.push('e.IsArchived = 0');
    }

    if (opts.noMember === 'true' || opts.noMember === true) {
        where.push('e.MemberId IS NULL');
    }
    if (opts.assignedToUserId) {
        where.push('e.AssignedToUserId = @assignedToUserId');
        req.input('assignedToUserId', sql.UniqueIdentifier, opts.assignedToUserId);
    }
    if (opts.createdByUserId) {
        where.push('e.CreatedBy = @createdByUserId');
        req.input('createdByUserId', sql.UniqueIdentifier, opts.createdByUserId);
    }
    if (opts.memberId) {
        where.push('e.MemberId = @memberId');
        req.input('memberId', sql.UniqueIdentifier, opts.memberId);
    }
    if (opts.caseId) {
        where.push('e.CaseId = @caseId');
        req.input('caseId', sql.UniqueIdentifier, opts.caseId);
    }
    if (opts.shareRequestId) {
        where.push('e.ShareRequestId = @shareRequestId');
        req.input('shareRequestId', sql.UniqueIdentifier, opts.shareRequestId);
    }
    if (opts.channel && ENCOUNTER_CHANNELS.includes(opts.channel)) {
        where.push('e.Channel = @channel');
        req.input('channel', sql.NVarChar, opts.channel);
    }
    if (opts.direction && ENCOUNTER_DIRECTIONS.includes(opts.direction)) {
        where.push('e.Direction = @direction');
        req.input('direction', sql.NVarChar, opts.direction);
    }
    if (opts.followUp === 'open') {
        where.push('e.FollowUpDueDate IS NOT NULL AND e.FollowUpCompletedAt IS NULL');
    } else if (opts.followUp === 'overdue') {
        where.push('e.FollowUpDueDate IS NOT NULL AND e.FollowUpCompletedAt IS NULL AND e.FollowUpDueDate < SYSUTCDATETIME()');
    } else if (opts.followUp === 'done') {
        where.push('e.FollowUpCompletedAt IS NOT NULL');
    }
    if (opts.q && opts.q.trim()) {
        where.push(`(e.EncounterNumber LIKE @q OR e.Summary LIKE @q OR mu.FirstName LIKE @q OR mu.LastName LIKE @q)`);
        req.input('q', sql.NVarChar, `%${opts.q.trim()}%`);
    }

    const whereClause = where.join(' AND ');
    req.input('offset', sql.Int, offset);
    req.input('limit', sql.Int, limit);

    const result = await req.query(`
        SELECT ${SELECT_COLUMNS}
        ${FROM_JOINS}
        WHERE ${whereClause}
        ORDER BY COALESCE(e.OccurredAt, e.CreatedDate) DESC
        OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;

        SELECT COUNT(*) AS Total
        ${FROM_JOINS}
        WHERE ${whereClause};
    `);

    const data = result.recordsets[0];
    const total = result.recordsets[1][0]?.Total || 0;
    return {
        data,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
    };
}

async function getEncounterById(vendorId, encounterId) {
    const pool = await getPool();
    const r = await pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .input('encounterId', sql.UniqueIdentifier, encounterId)
        .query(`
            SELECT ${SELECT_COLUMNS}, e.TranscriptText
            ${FROM_JOINS}
            WHERE e.EncounterId = @encounterId AND e.VendorId = @vendorId
        `);
    return r.recordset[0] || null;
}

// ---------------------------------------------------------------------------
// Create / update / archive
// ---------------------------------------------------------------------------

async function createEncounter(vendorId, body, ctx = {}) {
    const summary = body && typeof body.summary === 'string' ? body.summary.trim() : '';
    if (!summary) {
        const err = new Error('summary is required');
        err.statusCode = 400;
        throw err;
    }
    if (!isValidChannel(body.channel)) {
        const err = new Error('Invalid channel');
        err.statusCode = 400;
        throw err;
    }
    if (!isValidDirection(body.direction)) {
        const err = new Error('Invalid direction');
        err.statusCode = 400;
        throw err;
    }

    const pool = await getPool();

    // Retry on unique-constraint collision from concurrent inserts.
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
        const encounterNumber = await generateEncounterNumber(pool, vendorId);
        try {
            const r = await pool.request()
                .input('vendorId',         sql.UniqueIdentifier, vendorId)
                .input('encounterNumber',  sql.NVarChar,         encounterNumber)
                .input('memberId',         sql.UniqueIdentifier, body.memberId || null)
                .input('caseId',  sql.UniqueIdentifier, body.caseId || null)
                .input('shareRequestId',   sql.UniqueIdentifier, body.shareRequestId || null)
                .input('summary',          sql.NVarChar,         summary)
                .input('channel',          sql.NVarChar,         body.channel || null)
                .input('direction',        sql.NVarChar,         body.direction || null)
                .input('source',           sql.NVarChar,         body.source || 'manual')
                .input('externalRef',      sql.NVarChar,         body.externalRef || null)
                .input('occurredAt',       sql.DateTime2,        body.occurredAt ? new Date(body.occurredAt) : null)
                .input('durationSeconds',  sql.Int,              body.durationSeconds ?? null)
                .input('assignedToUserId', sql.UniqueIdentifier, body.assignedToUserId || null)
                .input('followUpDueDate',  sql.DateTime2,        body.followUpDueDate ? new Date(body.followUpDueDate) : null)
                .input('emailMessageId',   sql.UniqueIdentifier, body.emailMessageId || null)
                .input('createdBy',        sql.UniqueIdentifier, ctx.userId || null)
                .input('createdByName',    sql.NVarChar,         ctx.userName || null)
                .query(`
                    INSERT INTO oe.Encounters (
                        VendorId, EncounterNumber, MemberId, CaseId, ShareRequestId,
                        Summary, Channel, Direction, Source, ExternalRef, OccurredAt,
                        DurationSeconds, AssignedToUserId, FollowUpDueDate, EmailMessageId,
                        CreatedBy, CreatedByName
                    )
                    OUTPUT INSERTED.EncounterId
                    VALUES (
                        @vendorId, @encounterNumber, @memberId, @caseId, @shareRequestId,
                        @summary, @channel, @direction, @source, @externalRef, @occurredAt,
                        @durationSeconds, @assignedToUserId, @followUpDueDate, @emailMessageId,
                        @createdBy, @createdByName
                    );
                `);
            return await getEncounterById(vendorId, r.recordset[0].EncounterId);
        } catch (e) {
            lastErr = e;
            if (e.number === 2627 || e.number === 2601) continue; // unique violation, retry
            throw e;
        }
    }
    throw lastErr;
}

async function updateEncounter(vendorId, encounterId, body, ctx = {}) {
    const before = await getEncounterById(vendorId, encounterId);
    if (!before) {
        const err = new Error('Encounter not found');
        err.statusCode = 404;
        throw err;
    }
    if (body.channel !== undefined && !isValidChannel(body.channel)) {
        const err = new Error('Invalid channel'); err.statusCode = 400; throw err;
    }
    if (body.direction !== undefined && !isValidDirection(body.direction)) {
        const err = new Error('Invalid direction'); err.statusCode = 400; throw err;
    }

    const pool = await getPool();
    const sets = ['ModifiedDate = SYSUTCDATETIME()', 'ModifiedBy = @userId'];
    const req = pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .input('encounterId', sql.UniqueIdentifier, encounterId)
        .input('userId', sql.UniqueIdentifier, ctx.userId || null);

    const setIf = (key, type, sqlCol) => {
        if (body[key] === undefined) return;
        sets.push(`${sqlCol} = @${key}`);
        const v = body[key];
        if (type === sql.UniqueIdentifier) req.input(key, type, v || null);
        else if (type === sql.DateTime2)   req.input(key, type, v ? new Date(v) : null);
        else if (type === sql.Int)         req.input(key, type, v ?? null);
        else                               req.input(key, type, v ?? null);
    };

    setIf('summary',          sql.NVarChar,         'Summary');
    setIf('channel',          sql.NVarChar,         'Channel');
    setIf('direction',        sql.NVarChar,         'Direction');
    setIf('occurredAt',       sql.DateTime2,        'OccurredAt');
    setIf('memberId',         sql.UniqueIdentifier, 'MemberId');
    setIf('caseId',  sql.UniqueIdentifier, 'CaseId');
    setIf('shareRequestId',   sql.UniqueIdentifier, 'ShareRequestId');
    setIf('assignedToUserId', sql.UniqueIdentifier, 'AssignedToUserId');
    setIf('followUpDueDate',  sql.DateTime2,        'FollowUpDueDate');
    setIf('externalRef',      sql.NVarChar,         'ExternalRef');
    setIf('durationSeconds',  sql.Int,              'DurationSeconds');
    setIf('recordingUrl',     sql.NVarChar,         'RecordingUrl');
    setIf('transcriptText',   sql.NVarChar,         'TranscriptText');
    setIf('notes',            sql.NVarChar(sql.MAX),'Notes');

    if (sets.length === 2) return before; // nothing to set besides Modified*

    const r = await req.query(`
        UPDATE oe.Encounters SET ${sets.join(', ')}
        WHERE EncounterId = @encounterId AND VendorId = @vendorId;
        SELECT @@ROWCOUNT AS Rows;
    `);
    if (r.recordset[0].Rows === 0) {
        const err = new Error('Encounter not found');
        err.statusCode = 404;
        throw err;
    }
    return await getEncounterById(vendorId, encounterId);
}

async function archiveEncounter(vendorId, encounterId, ctx = {}) {
    const pool = await getPool();
    const r = await pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .input('encounterId', sql.UniqueIdentifier, encounterId)
        .input('userId', sql.UniqueIdentifier, ctx.userId || null)
        .query(`
            UPDATE oe.Encounters
            SET IsArchived = 1, ModifiedDate = SYSUTCDATETIME(), ModifiedBy = @userId
            WHERE EncounterId = @encounterId AND VendorId = @vendorId;
            SELECT @@ROWCOUNT AS Rows;
        `);
    if (r.recordset[0].Rows === 0) {
        const err = new Error('Encounter not found');
        err.statusCode = 404;
        throw err;
    }
    return true;
}

async function assignEncounter(vendorId, encounterId, assignedToUserId, ctx = {}) {
    return await updateEncounter(vendorId, encounterId, { assignedToUserId }, ctx);
}

async function completeFollowUp(vendorId, encounterId, ctx = {}) {
    const pool = await getPool();
    const r = await pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .input('encounterId', sql.UniqueIdentifier, encounterId)
        .input('userId', sql.UniqueIdentifier, ctx.userId || null)
        .query(`
            UPDATE oe.Encounters
            SET FollowUpCompletedAt = SYSUTCDATETIME(),
                ModifiedDate = SYSUTCDATETIME(), ModifiedBy = @userId
            WHERE EncounterId = @encounterId
              AND VendorId = @vendorId
              AND FollowUpDueDate IS NOT NULL
              AND FollowUpCompletedAt IS NULL;
            SELECT @@ROWCOUNT AS Rows;
        `);
    if (r.recordset[0].Rows === 0) {
        const err = new Error('No open follow-up on this encounter');
        err.statusCode = 409;
        throw err;
    }
    return await getEncounterById(vendorId, encounterId);
}

// ---------------------------------------------------------------------------
// Convert to Case
// ---------------------------------------------------------------------------
// Lazy-required to avoid a circular import (caseService also lives in this dir).

async function convertToCase(vendorId, encounterId, caseInput = {}, ctx = {}) {
    const CaseService = require('./caseService');
    const enc = await getEncounterById(vendorId, encounterId);
    if (!enc) {
        const err = new Error('Encounter not found');
        err.statusCode = 404;
        throw err;
    }
    if (!enc.MemberId) {
        const err = new Error('Encounter must have a member before it can be converted to a case');
        err.statusCode = 409;
        throw err;
    }
    if (enc.CaseId) {
        const err = new Error('Encounter is already linked to a case');
        err.statusCode = 409;
        err.code = 'ALREADY_HAS_CASE';
        throw err;
    }

    const newCase = await CaseService.createCase(vendorId, {
        memberId: enc.MemberId,
        title: caseInput.title || null,
        description: caseInput.description || enc.Summary,
        caseType: caseInput.caseType,
        caseSubcategory: caseInput.caseSubcategory,
        subcategoryDetail: caseInput.subcategoryDetail,
        createdVia: 'encounter',
        userId: ctx.userId,
        userName: ctx.userName
    });

    await updateEncounter(vendorId, encounterId, { caseId: newCase.CaseId }, ctx);
    return {
        encounter: await getEncounterById(vendorId, encounterId),
        case: newCase
    };
}

// ---------------------------------------------------------------------------
// Claimers (the team list, used by the assign-to picker)
// ---------------------------------------------------------------------------

async function getAssignees(vendorId, currentUserId) {
    const pool = await getPool();
    const r = await pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .query(`
            SELECT
                u.UserId, u.FirstName, u.LastName, u.Email, r.Name AS RoleName,
                (SELECT COUNT(*) FROM oe.Encounters e
                  WHERE e.VendorId = @vendorId AND e.AssignedToUserId = u.UserId AND e.IsArchived = 0) AS AssignedCount
            FROM oe.Users u
            INNER JOIN oe.UserRoles ur ON ur.UserId = u.UserId
            INNER JOIN oe.Roles r ON r.RoleId = ur.RoleId
            WHERE u.VendorId = @vendorId
              AND r.Name IN ('VendorAdmin','VendorAgent')
            ORDER BY u.LastName ASC, u.FirstName ASC
        `);
    const rows = r.recordset.map((row) => ({
        userId: row.UserId,
        firstName: row.FirstName,
        lastName: row.LastName,
        email: row.Email,
        role: row.RoleName,
        assignedCount: row.AssignedCount
    }));
    rows.sort((a, b) => {
        if (a.userId === currentUserId && b.userId !== currentUserId) return -1;
        if (b.userId === currentUserId && a.userId !== currentUserId) return 1;
        if (b.assignedCount !== a.assignedCount) return b.assignedCount - a.assignedCount;
        const lc = (a.lastName || '').localeCompare(b.lastName || '');
        if (lc !== 0) return lc;
        return (a.firstName || '').localeCompare(b.firstName || '');
    });
    return rows;
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

async function listAttachments(vendorId, encounterId) {
    const pool = await getPool();
    const enc = await getEncounterById(vendorId, encounterId);
    if (!enc) {
        const err = new Error('Encounter not found');
        err.statusCode = 404;
        throw err;
    }
    const r = await pool.request()
        .input('encounterId', sql.UniqueIdentifier, encounterId)
        .query(`
            SELECT AttachmentId, EncounterId, FileName, MimeType, FileSize,
                   BlobUrl, BlobPath, Description, UploadedBy, IsActive, CreatedDate
            FROM oe.EncounterAttachments
            WHERE EncounterId = @encounterId AND IsActive = 1
            ORDER BY CreatedDate DESC
        `);
    return r.recordset;
}

async function createAttachmentRecord(vendorId, encounterId, payload, ctx = {}) {
    const pool = await getPool();
    const enc = await getEncounterById(vendorId, encounterId);
    if (!enc) {
        const err = new Error('Encounter not found');
        err.statusCode = 404;
        throw err;
    }
    const r = await pool.request()
        .input('encounterId', sql.UniqueIdentifier, encounterId)
        .input('fileName',    sql.NVarChar, payload.fileName)
        .input('mimeType',    sql.NVarChar, payload.mimeType || null)
        .input('fileSize',    sql.BigInt,   payload.fileSize ?? null)
        .input('blobUrl',     sql.NVarChar, payload.blobUrl || null)
        .input('blobPath',    sql.NVarChar, payload.blobPath || null)
        .input('description', sql.NVarChar, payload.description || null)
        .input('uploadedBy',  sql.NVarChar, payload.uploadedBy || null)
        .input('createdBy',   sql.UniqueIdentifier, ctx.userId || null)
        .query(`
            INSERT INTO oe.EncounterAttachments
                (EncounterId, FileName, MimeType, FileSize, BlobUrl, BlobPath, Description, UploadedBy, CreatedBy)
            OUTPUT INSERTED.AttachmentId
            VALUES (@encounterId, @fileName, @mimeType, @fileSize, @blobUrl, @blobPath, @description, @uploadedBy, @createdBy)
        `);
    return { AttachmentId: r.recordset[0].AttachmentId };
}

async function softDeleteAttachment(vendorId, encounterId, attachmentId) {
    const pool = await getPool();
    const enc = await getEncounterById(vendorId, encounterId);
    if (!enc) {
        const err = new Error('Encounter not found');
        err.statusCode = 404;
        throw err;
    }
    const r = await pool.request()
        .input('encounterId', sql.UniqueIdentifier, encounterId)
        .input('attachmentId', sql.UniqueIdentifier, attachmentId)
        .query(`
            UPDATE oe.EncounterAttachments SET IsActive = 0
            WHERE AttachmentId = @attachmentId AND EncounterId = @encounterId;
            SELECT @@ROWCOUNT AS Rows;
        `);
    return r.recordset[0].Rows > 0;
}

// Convenience: lookup a member's HouseholdId for blob path scoping.
async function getMemberHousehold(memberId) {
    if (!memberId) return null;
    const pool = await getPool();
    const r = await pool.request()
        .input('memberId', sql.UniqueIdentifier, memberId)
        .query('SELECT HouseholdId FROM oe.Members WHERE MemberId = @memberId');
    return r.recordset[0]?.HouseholdId || null;
}

/**
 * Create an Encounter row from a VendorCallLogs row. Idempotent on
 * (VendorId, ExternalRef). Used by Zoom Phone webhook handlers to ensure
 * every call produces an Encounter.
 */
async function createFromCallLog(vendorId, callLogId, ctx = {}) {
    const pool = await getPool();

    // Idempotency: skip if encounter already exists for this CallLogId
    const dup = await pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .input('externalRef', sql.NVarChar, callLogId)
        .query(`SELECT TOP 1 EncounterId, CaseId, ShareRequestId FROM oe.Encounters WHERE VendorId=@vendorId AND Source='zoom_phone' AND ExternalRef=@externalRef`);
    if (dup.recordset.length > 0) {
        return dup.recordset[0];
    }

    // Load the call log row
    const clRes = await pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .input('callLogId', sql.UniqueIdentifier, callLogId)
        .query(`SELECT CallLogId, CallType, CallStatus, CallerName, CallerNumber, CalleeName, CalleeNumber,
                       CallStartTime, CallDurationSeconds, MemberId, AgentUserId, AnsweredBy,
                       HasRecording, RecordingUrl, TranscriptText, AISummary, ZoomAISummary
                FROM oe.VendorCallLogs
                WHERE VendorId=@vendorId AND CallLogId=@callLogId`);
    if (clRes.recordset.length === 0) return null;
    const cl = clRes.recordset[0];

    // User spec: only create encounters for human-to-human conversations.
    // Skip AR/queue/common-area, skip missed + voicemail (no live talking),
    // skip non-completed and very short calls (< 10s).
    const isHumanConversation =
        cl.AnsweredBy === 'User'
        && cl.CallStatus === 'Completed'
        && (cl.CallType === 'Inbound' || cl.CallType === 'Outbound')
        && (cl.CallDurationSeconds || 0) >= 10;
    if (!isHumanConversation) {
        return null;
    }

    // Map call type → encounter direction
    const direction =
        cl.CallType === 'Outbound' ? 'outbound' :
        cl.CallType === 'Inbound' ? 'inbound' :
        null;

    // Build initial Summary text (required NOT NULL).
    // At this point only Inbound/Outbound + AnsweredBy=User reaches here.
    const callerLabel = cl.CallerName || cl.CallerNumber || '(unknown caller)';
    const calleeLabel = cl.CalleeName || cl.CalleeNumber || '(unknown destination)';
    let summary;
    if (cl.CallType === 'Outbound') {
        summary = `Outbound call to ${calleeLabel} (${cl.CallDurationSeconds || 0}s).`;
    } else {
        summary = `Inbound call from ${callerLabel} to ${calleeLabel} (${cl.CallDurationSeconds || 0}s).`;
    }
    // If AI summary already on the call log, prefer it
    if (cl.AISummary) summary = cl.AISummary;
    else if (cl.ZoomAISummary) summary = cl.ZoomAISummary;

    return await createEncounter(vendorId, {
        memberId:         cl.MemberId,
        summary,
        channel:          'phone',
        direction,
        source:           'zoom_phone',
        externalRef:      cl.CallLogId,
        occurredAt:       cl.CallStartTime,
        durationSeconds:  cl.CallDurationSeconds,
        assignedToUserId: cl.AgentUserId,
    }, ctx);
}

/**
 * Create an Encounter row from an email message (oe.EmailMessages). Idempotent
 * on (VendorId, Source='email', ExternalRef=GraphMessageId). Called when an
 * email thread is linked to a member/case/share-request so every message lands
 * in the History timeline. See emailThreadService.ensureEncounterForMessage.
 */
async function createFromEmailMessage(vendorId, payload, ctx = {}) {
    const pool = await getPool();

    const dup = await pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .input('externalRef', sql.NVarChar, payload.graphMessageId)
        .query(`SELECT TOP 1 EncounterId, CaseId, ShareRequestId FROM oe.Encounters WHERE VendorId=@vendorId AND Source='email' AND ExternalRef=@externalRef`);
    if (dup.recordset.length > 0) return dup.recordset[0];

    const subject = (payload.subject || '(no subject)').trim();
    const preview = (payload.bodyPreview || '').trim();
    const verb = payload.direction === 'outbound' ? 'Sent email' : 'Received email';
    const summary = `${verb}: ${subject}${preview ? ` — ${preview}` : ''}`.slice(0, 4000);

    return await createEncounter(vendorId, {
        memberId:       payload.memberId || null,
        caseId:         payload.caseId || null,
        shareRequestId: payload.shareRequestId || null,
        summary,
        channel:        'email',
        direction:      payload.direction || null,
        source:         'email',
        externalRef:    payload.graphMessageId,
        emailMessageId: payload.emailMessageId,
        occurredAt:     payload.occurredAt || null,
    }, ctx);
}

module.exports = {
    ENCOUNTER_CHANNELS,
    ENCOUNTER_DIRECTIONS,
    ENCOUNTER_SOURCES,
    isValidChannel,
    isValidDirection,
    getDashboardStats,
    listEncounters,
    getEncounterById,
    createEncounter,
    updateEncounter,
    archiveEncounter,
    assignEncounter,
    completeFollowUp,
    convertToCase,
    getAssignees,
    listAttachments,
    createAttachmentRecord,
    softDeleteAttachment,
    getMemberHousehold,
    createFromCallLog,
    createFromEmailMessage
};
