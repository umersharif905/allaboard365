// services/emailThreadService.js
// The store-side of the Back Office inbox: upsert Graph messages into
// oe.EmailThreads / oe.EmailMessages, derive thread state (pills), list/read
// threads, and link a thread to a member / case / share request (which creates
// one encounter per message).
// Spec: docs/superpowers/specs/2026-06-02-back-office-email/design.md

const { getPool, sql } = require('../config/database');
const encounterService = require('./encounterService');
const emailAttachmentService = require('./emailAttachmentService');

const json = (v) => (v == null ? null : JSON.stringify(v));

// ---------------------------------------------------------------------------
// Thread upsert + derived state
// ---------------------------------------------------------------------------

const findThreadId = async (pool, vendorId, conversationId) => {
    const r = await pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .input('conversationId', sql.NVarChar, conversationId)
        .query(`SELECT ThreadId FROM oe.EmailThreads WHERE VendorId=@vendorId AND ConversationId=@conversationId`);
    return r.recordset[0]?.ThreadId || null;
};

/**
 * Find or create the thread for a conversation. Returns the ThreadId.
 * Idempotent under concurrency: webhook + manual sync (and dev double-requests)
 * can race the same new conversation, so a unique-key collision on INSERT is
 * resolved by re-reading the row instead of failing the whole sync.
 */
async function upsertThread(vendorId, { conversationId, subject }) {
    const pool = await getPool();
    const existing = await findThreadId(pool, vendorId, conversationId);
    if (existing) return existing;

    try {
        const ins = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('conversationId', sql.NVarChar, conversationId)
            .input('subject', sql.NVarChar, subject || null)
            .query(`
                INSERT INTO oe.EmailThreads (VendorId, ConversationId, Subject)
                OUTPUT INSERTED.ThreadId
                VALUES (@vendorId, @conversationId, @subject)
            `);
        return ins.recordset[0].ThreadId;
    } catch (e) {
        if (e.number === 2627 || e.number === 2601) {
            const again = await findThreadId(pool, vendorId, conversationId);
            if (again) return again;
        }
        throw e;
    }
}

/** Recompute cached counts / last-message / NeedsReply for a thread. */
async function recomputeThread(vendorId, threadId) {
    const pool = await getPool();
    await pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .input('threadId', sql.UniqueIdentifier, threadId)
        .query(`
            ;WITH agg AS (
                SELECT
                    COUNT(*) AS MessageCount,
                    SUM(CASE WHEN Direction='inbound' AND IsRead=0 THEN 1 ELSE 0 END) AS UnreadCount,
                    MAX(COALESCE(SentAt, ReceivedAt)) AS LastMessageAt,
                    MIN(COALESCE(ReceivedAt, SentAt)) AS FirstMessageAt
                FROM oe.EmailMessages WHERE ThreadId=@threadId
            ),
            last AS (
                SELECT TOP 1 Direction
                FROM oe.EmailMessages
                WHERE ThreadId=@threadId
                ORDER BY COALESCE(SentAt, ReceivedAt) DESC
            )
            UPDATE t SET
                MessageCount  = agg.MessageCount,
                UnreadCount   = ISNULL(agg.UnreadCount, 0),
                LastMessageAt = agg.LastMessageAt,
                FirstMessageAt = ISNULL(t.FirstMessageAt, agg.FirstMessageAt),
                LastDirection = last.Direction,
                NeedsReply    = CASE WHEN last.Direction='inbound' THEN 1 ELSE 0 END,
                ModifiedDate  = SYSUTCDATETIME()
            FROM oe.EmailThreads t CROSS JOIN agg CROSS JOIN last
            WHERE t.ThreadId=@threadId AND t.VendorId=@vendorId;
        `);
}

/**
 * Insert a message if new (idempotent on VendorId+GraphMessageId). Returns
 * { emailMessageId, isNew }.
 */
async function insertMessageIfNew(vendorId, m) {
    const pool = await getPool();
    const findMsg = async () => {
        // Dedupe on the immutable GraphMessageId, OR the RFC InternetMessageId when
        // present. The latter collapses a back-office send and the copy we later see
        // in the Sent Items folder into one row (and is globally unique per message,
        // so it never merges genuinely distinct messages).
        const r = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('graphMessageId', sql.NVarChar, m.graphMessageId)
            .input('internetMessageId', sql.NVarChar, m.internetMessageId || null)
            .query(`SELECT TOP 1 EmailMessageId FROM oe.EmailMessages
                    WHERE VendorId=@vendorId
                      AND (GraphMessageId=@graphMessageId
                           OR (@internetMessageId IS NOT NULL AND InternetMessageId=@internetMessageId))`);
        return r.recordset[0]?.EmailMessageId || null;
    };
    const existingId = await findMsg();
    if (existingId) return { emailMessageId: existingId, isNew: false };

    let ins;
    try {
        ins = await pool.request()
        .input('threadId', sql.UniqueIdentifier, m.threadId)
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .input('graphMessageId', sql.NVarChar, m.graphMessageId)
        .input('graphConversationId', sql.NVarChar, m.conversationId || null)
        .input('internetMessageId', sql.NVarChar, m.internetMessageId || null)
        .input('direction', sql.NVarChar, m.direction)
        .input('fromAddress', sql.NVarChar, m.fromAddress || null)
        .input('fromName', sql.NVarChar, m.fromName || null)
        .input('toAddresses', sql.NVarChar, json(m.toAddresses))
        .input('ccAddresses', sql.NVarChar, json(m.ccAddresses))
        .input('subject', sql.NVarChar, m.subject || null)
        .input('bodyHtml', sql.NVarChar(sql.MAX), m.bodyHtml || null)
        .input('bodyPreview', sql.NVarChar, m.bodyPreview || null)
        .input('receivedAt', sql.DateTime2, m.receivedAt ? new Date(m.receivedAt) : null)
        .input('sentAt', sql.DateTime2, m.sentAt ? new Date(m.sentAt) : null)
        .input('isRead', sql.Bit, m.isRead ? 1 : 0)
        .input('hasAttachments', sql.Bit, m.hasAttachments ? 1 : 0)
        .input('sentByUserId', sql.UniqueIdentifier, m.sentByUserId || null)
        .input('refStamp', sql.NVarChar, m.refStamp || null)
        .input('sendStatus', sql.NVarChar, m.sendStatus || null)
        .input('createdBy', sql.UniqueIdentifier, m.sentByUserId || null)
        .query(`
            INSERT INTO oe.EmailMessages (
                ThreadId, VendorId, GraphMessageId, GraphConversationId, InternetMessageId,
                Direction, FromAddress, FromName, ToAddresses, CcAddresses, Subject,
                BodyHtml, BodyPreview, ReceivedAt, SentAt, IsRead, HasAttachments,
                SentByUserId, RefStamp, SendStatus, CreatedBy
            )
            OUTPUT INSERTED.EmailMessageId
            VALUES (
                @threadId, @vendorId, @graphMessageId, @graphConversationId, @internetMessageId,
                @direction, @fromAddress, @fromName, @toAddresses, @ccAddresses, @subject,
                @bodyHtml, @bodyPreview, @receivedAt, @sentAt, @isRead, @hasAttachments,
                @sentByUserId, @refStamp, @sendStatus, @createdBy
            )
        `);
        return { emailMessageId: ins.recordset[0].EmailMessageId, isNew: true };
    } catch (e) {
        if (e.number === 2627 || e.number === 2601) {
            const again = await findMsg();
            if (again) return { emailMessageId: again, isNew: false };
        }
        throw e;
    }
}

/** Load minimal thread row + its SR/Case link. */
async function getThreadRow(vendorId, threadId) {
    const pool = await getPool();
    const r = await pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .input('threadId', sql.UniqueIdentifier, threadId)
        .query(`SELECT * FROM oe.EmailThreads WHERE ThreadId=@threadId AND VendorId=@vendorId`);
    return r.recordset[0] || null;
}

const SR_RE = /\b(SR-\d{4}-\d{4})\b/i;
const CASE_RE = /\b(CASE-\d{4}-\d{4})\b/i;
const PHONE_RE = /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;

// digits-only normalize of a stored phone column, for last-10 comparison
const PHONE_DIGITS_SQL = "RIGHT(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(u.PhoneNumber,' ',''),'(',''),')',''),'-',''),'+',''),'.',''),CHAR(9),''),10)";

const extractPhones = (text) =>
    [...new Set((String(text || '').match(PHONE_RE) || [])
        .map((p) => p.replace(/\D/g, ''))
        .map((d) => (d.length > 10 ? d.slice(-10) : d))
        .filter((d) => d.length === 10))].slice(0, 3);

// Member numbers (oe.Members.HouseholdMemberID) look like "MW15990740" — a short
// letter prefix + digits. We extract candidates loosely and confirm against the DB,
// so a loose regex is safe (non-member tokens simply won't match a row).
const MEMBERNO_RE = /\b([A-Za-z]{1,4}\d{5,12})\b/g;
const extractMemberNumbers = (text) =>
    [...new Set((String(text || '').match(MEMBERNO_RE) || []).map((s) => s.toUpperCase()))].slice(0, 5);

// Prefer a member already related to this vendor when several share an email/phone/name.
const VENDOR_REL_ORDER = `CASE WHEN EXISTS (SELECT 1 FROM oe.ShareRequests sr WHERE sr.MemberId=m.MemberId AND sr.VendorId=@vendorId)
    OR EXISTS (SELECT 1 FROM oe.Cases c WHERE c.MemberId=m.MemberId AND c.VendorId=@vendorId) THEN 0 ELSE 1 END`;

/**
 * Compute the best member/SR/case match for an inbound message WITHOUT linking.
 * Matching is suggestion-only (the care team accepts/denies on the reader panel) —
 * auto-linking proved too risky. Signals in priority order: an explicit SR-/CASE-
 * reference in the subject/body, the sender's email, a phone number in the email,
 * then the sender's display name. Returns null if nothing matched.
 */
async function computeThreadMatch(vendorId, { fromAddress, fromName, subject, bodyHtml }) {
    const pool = await getPool();
    const hay = `${subject || ''} ${bodyHtml || ''}`;
    const srNum = (hay.match(SR_RE) || [])[1] || null;
    const caseNum = (hay.match(CASE_RE) || [])[1] || null;

    let memberId = null, shareRequestId = null, caseId = null, reason = null;

    if (srNum) {
        const r = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId).input('num', sql.NVarChar, srNum)
            .query(`SELECT TOP 1 ShareRequestId, MemberId FROM oe.ShareRequests WHERE RequestNumber=@num AND VendorId=@vendorId`);
        if (r.recordset[0]) { shareRequestId = r.recordset[0].ShareRequestId; memberId = memberId || r.recordset[0].MemberId; reason = `Mentions ${srNum.toUpperCase()}`; }
    }
    if (caseNum && !shareRequestId) {
        const r = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId).input('num', sql.NVarChar, caseNum)
            .query(`SELECT TOP 1 CaseId, MemberId FROM oe.Cases WHERE CaseNumber=@num AND VendorId=@vendorId`);
        if (r.recordset[0]) { caseId = r.recordset[0].CaseId; memberId = memberId || r.recordset[0].MemberId; reason = reason || `Mentions ${caseNum.toUpperCase()}`; }
    }
    // Member ID (HouseholdMemberID) — members often quote it. High confidence.
    if (!memberId) {
        for (const num of extractMemberNumbers(hay)) {
            const r = await pool.request()
                .input('vendorId', sql.UniqueIdentifier, vendorId).input('num', sql.NVarChar, num)
                .query(`SELECT TOP 1 m.MemberId FROM oe.Members m WHERE m.HouseholdMemberID = @num ORDER BY ${VENDOR_REL_ORDER}`);
            if (r.recordset[0]) { memberId = r.recordset[0].MemberId; reason = reason || `Member ID ${num}`; break; }
        }
    }
    if (!memberId && fromAddress) {
        const r = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId).input('email', sql.NVarChar, fromAddress)
            .query(`SELECT TOP 1 m.MemberId FROM oe.Members m JOIN oe.Users u ON m.UserId = u.UserId WHERE u.Email = @email ORDER BY ${VENDOR_REL_ORDER}`);
        if (r.recordset[0]) { memberId = r.recordset[0].MemberId; reason = reason || 'Sender email matches a member'; }
    }
    if (!memberId) {
        for (const ph of extractPhones(hay)) {
            const r = await pool.request()
                .input('vendorId', sql.UniqueIdentifier, vendorId).input('ph', sql.NVarChar, ph)
                .query(`SELECT TOP 1 m.MemberId FROM oe.Members m JOIN oe.Users u ON m.UserId = u.UserId WHERE u.PhoneNumber IS NOT NULL AND ${PHONE_DIGITS_SQL} = @ph ORDER BY ${VENDOR_REL_ORDER}`);
            if (r.recordset[0]) { memberId = r.recordset[0].MemberId; reason = reason || 'Phone number matches a member'; break; }
        }
    }
    if (!memberId && fromName && fromName.trim().includes(' ')) {
        const r = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId).input('name', sql.NVarChar, fromName.trim())
            .query(`SELECT TOP 1 m.MemberId FROM oe.Members m JOIN oe.Users u ON m.UserId = u.UserId WHERE LOWER(LTRIM(RTRIM(CONCAT(u.FirstName, ' ', u.LastName)))) = LOWER(@name) ORDER BY ${VENDOR_REL_ORDER}`);
        if (r.recordset[0]) { memberId = r.recordset[0].MemberId; reason = reason || 'Sender name matches a member'; }
    }

    if (!memberId && !shareRequestId && !caseId) return null;
    return { memberId, shareRequestId, caseId, reason };
}

/**
 * Exact-email member match — the one signal we AUTO-link on, because an email
 * address is a secure 1:1 (emails are unique per user). All other signals (name,
 * phone, member-ID, SR-ID) stay suggestion-only via getThreadSuggestion.
 */
async function findMemberByExactEmail(vendorId, email) {
    if (!email) return null;
    const pool = await getPool();
    const r = await pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .input('email', sql.NVarChar, email)
        .query(`SELECT TOP 1 m.MemberId FROM oe.Members m JOIN oe.Users u ON m.UserId = u.UserId
                WHERE LOWER(u.Email) = LOWER(@email) ORDER BY ${VENDOR_REL_ORDER}`);
    return r.recordset[0]?.MemberId || null;
}

const relationshipLabel = (rt) =>
    rt === 'S' ? 'Spouse' : rt === 'C' ? 'Dependent' : rt === 'P' ? 'Primary' : 'Member';

/**
 * Email matching should always land on the household PRIMARY account holder. If the
 * matched member is a dependent/spouse, resolve up to the primary and return the
 * dependent's identity so the UI can note who on the plan the email actually named.
 * Returns { primaryMemberId, dependent: { FirstName, LastName, RelationshipType } | null }.
 */
async function resolveToHouseholdPrimary(pool, memberId) {
    if (!memberId) return { primaryMemberId: memberId, dependent: null };
    const r = await pool.request().input('id', sql.UniqueIdentifier, memberId)
        .query(`SELECT m.HouseholdId, m.RelationshipType, u.FirstName, u.LastName
                FROM oe.Members m JOIN oe.Users u ON m.UserId = u.UserId WHERE m.MemberId = @id`);
    const row = r.recordset[0];
    if (!row || !row.HouseholdId || (row.RelationshipType !== 'S' && row.RelationshipType !== 'C')) {
        return { primaryMemberId: memberId, dependent: null };
    }
    const p = await pool.request().input('hh', sql.UniqueIdentifier, row.HouseholdId)
        .query(`SELECT TOP 1 MemberId FROM oe.Members WHERE HouseholdId = @hh AND RelationshipType = 'P'`);
    if (!p.recordset[0]) return { primaryMemberId: memberId, dependent: null };
    return {
        primaryMemberId: p.recordset[0].MemberId,
        dependent: { FirstName: row.FirstName, LastName: row.LastName, RelationshipType: row.RelationshipType },
    };
}

/**
 * A pending match suggestion for an unmatched, non-dismissed thread — member +
 * how it matched + any SR/Case. The care team accepts (link) or denies (dismiss)
 * on the reader's right panel. Returns null if already matched/dismissed/no match.
 */
async function getThreadSuggestion(vendorId, threadId) {
    const pool = await getPool();
    const thread = await getThreadRow(vendorId, threadId);
    if (!thread) return null;
    if (thread.MemberId || thread.CaseId || thread.ShareRequestId) return null;
    if (thread.MatchSuggestionDismissed) return null;

    const msg = await pool.request()
        .input('threadId', sql.UniqueIdentifier, threadId)
        .query(`SELECT TOP 1 FromAddress, FromName, Subject, BodyHtml FROM oe.EmailMessages WHERE ThreadId=@threadId AND Direction='inbound' ORDER BY COALESCE(ReceivedAt, SentAt) ASC`);
    const m = msg.recordset[0];
    if (!m) return null;

    const match = await computeThreadMatch(vendorId, { fromAddress: m.FromAddress, fromName: m.FromName, subject: m.Subject, bodyHtml: m.BodyHtml });
    if (!match) return null;

    let member = null, planMember = null;
    if (match.memberId) {
        // Always suggest the household primary; if the email named a dependent,
        // keep that person as a note ("Jill Smith is on this plan").
        const resolved = await resolveToHouseholdPrimary(pool, match.memberId);
        if (resolved.dependent) {
            planMember = { ...resolved.dependent, Relationship: relationshipLabel(resolved.dependent.RelationshipType) };
        }
        const r = await pool.request().input('id', sql.UniqueIdentifier, resolved.primaryMemberId)
            .query(`SELECT m.MemberId, u.FirstName, u.LastName, u.Email, u.PhoneNumber AS Phone FROM oe.Members m JOIN oe.Users u ON m.UserId=u.UserId WHERE m.MemberId=@id`);
        member = r.recordset[0] || null;
    }
    let shareRequestNumber = null, caseNumber = null;
    if (match.shareRequestId) {
        const r = await pool.request().input('id', sql.UniqueIdentifier, match.shareRequestId).query(`SELECT RequestNumber FROM oe.ShareRequests WHERE ShareRequestId=@id`);
        shareRequestNumber = r.recordset[0]?.RequestNumber || null;
    }
    if (match.caseId) {
        const r = await pool.request().input('id', sql.UniqueIdentifier, match.caseId).query(`SELECT CaseNumber FROM oe.Cases WHERE CaseId=@id`);
        caseNumber = r.recordset[0]?.CaseNumber || null;
    }
    return { member, planMember, shareRequestId: match.shareRequestId, shareRequestNumber, caseId: match.caseId, caseNumber, reason: match.reason };
}

async function dismissSuggestion(vendorId, threadId) {
    const pool = await getPool();
    await pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId).input('threadId', sql.UniqueIdentifier, threadId)
        .query(`UPDATE oe.EmailThreads SET MatchSuggestionDismissed=1, ModifiedDate=SYSUTCDATETIME() WHERE ThreadId=@threadId AND VendorId=@vendorId`);
    return true;
}

// ---------------------------------------------------------------------------
// Collision presence — who is viewing / replying to a thread (advisory,
// auto-expiring). One row per (thread,user) in oe.EmailThreadPresence.
// ---------------------------------------------------------------------------
const PRESENCE_STALE_SECONDS = 90; // tolerates background-tab timer throttling

/** Upsert my presence on a thread. state = 'viewing' | 'replying'. */
async function heartbeatPresence(vendorId, threadId, userId, userName, state) {
    const pool = await getPool();
    const st = state === 'replying' ? 'replying' : 'viewing';
    await pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .input('threadId', sql.UniqueIdentifier, threadId)
        .input('userId', sql.UniqueIdentifier, userId)
        .input('userName', sql.NVarChar, userName || null)
        .input('state', sql.NVarChar, st)
        .query(`
            MERGE oe.EmailThreadPresence AS t
            USING (SELECT @threadId AS ThreadId, @userId AS UserId) AS s
            ON (t.ThreadId = s.ThreadId AND t.UserId = s.UserId)
            WHEN MATCHED THEN UPDATE SET State=@state, UserName=@userName, LastSeenAt=SYSUTCDATETIME(), VendorId=@vendorId
            WHEN NOT MATCHED THEN INSERT (ThreadId, UserId, VendorId, UserName, State, LastSeenAt)
                VALUES (@threadId, @userId, @vendorId, @userName, @state, SYSUTCDATETIME());
        `);
    return getPresence(vendorId, threadId);
}

/** Active (non-stale) presence on a thread, split into viewers + repliers. */
async function getPresence(vendorId, threadId) {
    const pool = await getPool();
    const r = await pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .input('threadId', sql.UniqueIdentifier, threadId)
        .query(`
            SELECT UserId, UserName, State FROM oe.EmailThreadPresence
            WHERE ThreadId=@threadId AND VendorId=@vendorId
              AND LastSeenAt >= DATEADD(SECOND, -${PRESENCE_STALE_SECONDS}, SYSUTCDATETIME())
        `);
    const viewers = [], repliers = [];
    for (const row of r.recordset) {
        const entry = { userId: row.UserId, name: row.UserName };
        (row.State === 'replying' ? repliers : viewers).push(entry);
    }
    return { viewers, repliers };
}

/** Remove my presence on a thread (on leave/send). */
async function clearPresence(vendorId, threadId, userId) {
    const pool = await getPool();
    await pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .input('threadId', sql.UniqueIdentifier, threadId)
        .input('userId', sql.UniqueIdentifier, userId)
        .query(`DELETE FROM oe.EmailThreadPresence WHERE ThreadId=@threadId AND VendorId=@vendorId AND UserId=@userId`);
    return true;
}

/** If the thread is linked to a member/case/SR, ensure an encounter exists for this message. */
async function ensureEncounterForMessage(vendorId, thread, msgRow, ctx = {}) {
    if (!thread || (!thread.CaseId && !thread.ShareRequestId && !thread.MemberId)) return null;
    return encounterService.createFromEmailMessage(vendorId, {
        emailMessageId: msgRow.EmailMessageId,
        graphMessageId: msgRow.GraphMessageId,
        memberId: thread.MemberId || null,
        caseId: thread.CaseId || null,
        shareRequestId: thread.ShareRequestId || null,
        direction: msgRow.Direction,
        subject: msgRow.Subject,
        bodyPreview: msgRow.BodyPreview,
        occurredAt: msgRow.ReceivedAt || msgRow.SentAt,
    }, ctx);
}

// ---------------------------------------------------------------------------
// Inbound / outbound recording (called by sync + send)
// ---------------------------------------------------------------------------

/**
 * Match an inbound sender against the vendor's care-team roster — active
 * VendorAdmin/VendorAgent users for this vendor. Returns their UserId, or null.
 * Used to recognise a care-team member's own reply (sent from their personal
 * mailbox and copied into the shared Inbox by an Outlook rule) as outbound.
 */
async function matchCareTeamSender(vendorId, fromAddress) {
    if (!fromAddress) return null;
    const pool = await getPool();
    const r = await pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .input('email', sql.NVarChar, fromAddress)
        .query(`
            SELECT TOP 1 u.UserId
            FROM oe.Users u
            INNER JOIN oe.UserRoles ur ON ur.UserId = u.UserId
            INNER JOIN oe.Roles r ON r.RoleId = ur.RoleId
            WHERE u.VendorId = @vendorId
              AND u.Status = 'Active'
              AND r.Name IN ('VendorAdmin', 'VendorAgent')
              AND LOWER(u.Email) = LOWER(@email)`);
    return r.recordset[0]?.UserId || null;
}

/** True when the address IS the vendor's own shared mailbox (e.g. membersuccess@…). */
async function isVendorSharedMailbox(vendorId, address) {
    if (!address) return false;
    const pool = await getPool();
    const r = await pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .input('addr', sql.NVarChar, address)
        .query(`SELECT 1 FROM oe.Vendors WHERE VendorId=@vendorId AND LOWER(Office365SharedMailbox)=LOWER(@addr)`);
    return r.recordset.length > 0;
}

/** Record (idempotently) an inbound Graph message. Returns { emailMessageId, isNew, threadId }. */
async function recordInboundMessage(vendorId, parsed) {
    // A message in the shared Inbox that was actually sent by us is really outbound:
    //  - a care-team member replying from their own mailbox (copied in by an Outlook
    //    rule) → attribute to them; or
    //  - the shared mailbox's OWN address (it sent to itself / reply-all incl. the box).
    // Record those as outbound so the thread reads correctly and isn't "needs reply".
    const careTeamUserId = await matchCareTeamSender(vendorId, parsed.fromAddress);
    if (careTeamUserId || await isVendorSharedMailbox(vendorId, parsed.fromAddress)) {
        return recordOutboundFromSync(vendorId, parsed, { sentByUserId: careTeamUserId || null });
    }
    const threadId = await upsertThread(vendorId, { conversationId: parsed.conversationId, subject: parsed.subject });
    const { emailMessageId, isNew } = await insertMessageIfNew(vendorId, { ...parsed, threadId, direction: 'inbound' });
    await recomputeThread(vendorId, threadId);
    if (isNew) {
        // A new inbound from the customer reopens a thread that was marked "handled".
        const pool = await getPool();
        await pool.request().input('t', sql.UniqueIdentifier, threadId)
            .query(`UPDATE oe.EmailThreads SET ResolvedAt=NULL, ResolvedByUserId=NULL WHERE ThreadId=@t AND ResolvedAt IS NOT NULL`);
        // Auto-link the member ONLY on a secure exact-email match (1:1), if the thread
        // isn't already linked. Every other signal (name / phone / member-ID / SR-ID)
        // stays suggestion-only (getThreadSuggestion → accept/deny on the reader).
        const before = await getThreadRow(vendorId, threadId);
        if (before && !before.MemberId && !before.CaseId && !before.ShareRequestId) {
            const exactMemberId = await findMemberByExactEmail(vendorId, parsed.fromAddress);
            if (exactMemberId) {
                // Link the household primary, not a matched dependent/spouse.
                const { primaryMemberId } = await resolveToHouseholdPrimary(pool, exactMemberId);
                await pool.request()
                    .input('t', sql.UniqueIdentifier, threadId)
                    .input('m', sql.UniqueIdentifier, primaryMemberId)
                    .query(`UPDATE oe.EmailThreads SET MemberId=@m, ModifiedDate=SYSUTCDATETIME() WHERE ThreadId=@t AND MemberId IS NULL`);
            }
        }
        const thread = await getThreadRow(vendorId, threadId);
        const msgRow = { EmailMessageId: emailMessageId, GraphMessageId: parsed.graphMessageId, Direction: 'inbound', Subject: parsed.subject, BodyPreview: parsed.bodyPreview, ReceivedAt: parsed.receivedAt, SentAt: null };
        await ensureEncounterForMessage(vendorId, thread, msgRow);
        // Pull + persist attachment bytes so we retain the files independently of Graph.
        // Ingest when Graph flags attachments OR the body embeds inline images via
        // cid: — Graph's hasAttachments is false for inline-only messages.
        if (parsed.hasAttachments || emailAttachmentService.bodyHasInlineCids(parsed.bodyHtml)) {
            try { await emailAttachmentService.ingestAttachments(vendorId, emailMessageId, parsed.graphMessageId); }
            catch (e) { console.warn('email attachment ingest error:', e.message); }
        }
    }
    return { emailMessageId, isNew, threadId };
}

/** Record an outbound message we just sent. Returns the stored row. */
async function recordOutboundMessage(vendorId, m, ctx = {}) {
    const { emailMessageId } = await insertMessageIfNew(vendorId, {
        ...m,
        direction: 'outbound',
        isRead: true,
        sentAt: new Date().toISOString(),
        sendStatus: 'sent',
    });
    await recomputeThread(vendorId, m.threadId);
    // First-touch ownership: whoever sends first "owns" the thread (soft — the
    // customer's reply lands in that person's personal inbox too). Never steals an
    // existing owner; reassignment is manual.
    await claimThreadIfUnassigned(vendorId, m.threadId, ctx.userId);
    const thread = await getThreadRow(vendorId, m.threadId);
    const msgRow = { EmailMessageId: emailMessageId, GraphMessageId: m.graphMessageId, Direction: 'outbound', Subject: m.subject, BodyPreview: m.bodyPreview, ReceivedAt: null, SentAt: new Date() };
    await ensureEncounterForMessage(vendorId, thread, msgRow, ctx);
    return getMessageById(vendorId, emailMessageId);
}

/**
 * Record (idempotently) an outbound message discovered by syncing the shared
 * mailbox's Sent Items folder — a reply someone sent directly from Outlook
 * rather than the back office. Deduped against back-office sends (immutable
 * GraphMessageId / InternetMessageId) so our own sends never double-record.
 * Logs an encounter on linked threads, mirroring recordOutboundMessage; there
 * is no sending user (sent outside the app), so ownership isn't auto-claimed.
 */
async function recordOutboundFromSync(vendorId, parsed, opts = {}) {
    const threadId = await upsertThread(vendorId, { conversationId: parsed.conversationId, subject: parsed.subject });
    const { emailMessageId, isNew } = await insertMessageIfNew(vendorId, {
        ...parsed,
        threadId,
        direction: 'outbound',
        receivedAt: null,        // outbound — keep SentAt only, like recordOutboundMessage
        isRead: true,
        sendStatus: 'sent',
        sentByUserId: opts.sentByUserId || null,
    });
    await recomputeThread(vendorId, threadId);
    // When we can attribute the reply to a specific care-team member, give them
    // first-touch ownership (soft — never steals an existing owner).
    if (opts.sentByUserId) await claimThreadIfUnassigned(vendorId, threadId, opts.sentByUserId);
    if (isNew) {
        const thread = await getThreadRow(vendorId, threadId);
        const msgRow = { EmailMessageId: emailMessageId, GraphMessageId: parsed.graphMessageId, Direction: 'outbound', Subject: parsed.subject, BodyPreview: parsed.bodyPreview, ReceivedAt: null, SentAt: parsed.sentAt };
        await ensureEncounterForMessage(vendorId, thread, msgRow);
        // Ingest when Graph flags attachments OR the body embeds inline images via
        // cid: — Graph's hasAttachments is false for inline-only messages.
        if (parsed.hasAttachments || emailAttachmentService.bodyHasInlineCids(parsed.bodyHtml)) {
            try { await emailAttachmentService.ingestAttachments(vendorId, emailMessageId, parsed.graphMessageId); }
            catch (e) { console.warn('email sent-item attachment ingest error:', e.message); }
        }

    }
    return { emailMessageId, isNew, threadId };
}

/** Distinct lowercased addresses ever seen on a thread (From + To + Cc), for reply-all. */
async function getThreadParticipants(vendorId, threadId) {
    const pool = await getPool();
    const r = await pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .input('threadId', sql.UniqueIdentifier, threadId)
        .query(`SELECT FromAddress, ToAddresses, CcAddresses FROM oe.EmailMessages WHERE ThreadId=@threadId AND VendorId=@vendorId`);
    const set = new Set();
    for (const row of r.recordset) {
        if (row.FromAddress) set.add(String(row.FromAddress).toLowerCase());
        for (const col of ['ToAddresses', 'CcAddresses']) {
            try { (JSON.parse(row[col] || '[]') || []).forEach((a) => a && set.add(String(a).toLowerCase())); }
            catch { /* malformed json — skip */ }
        }
    }
    return [...set];
}

/** Soft-assign a thread's owner (null to unassign). Not a lock — just for sort/filter. */
async function assignThread(vendorId, threadId, ownerUserId) {
    const pool = await getPool();
    await pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .input('threadId', sql.UniqueIdentifier, threadId)
        .input('owner', sql.UniqueIdentifier, ownerUserId || null)
        .query('UPDATE oe.EmailThreads SET AssignedToUserId=@owner WHERE ThreadId=@threadId AND VendorId=@vendorId');
    return getThread(vendorId, threadId);
}

/** Claim a thread only if it has no owner yet (used on first send). */
async function claimThreadIfUnassigned(vendorId, threadId, userId) {
    if (!userId) return;
    const pool = await getPool();
    await pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .input('threadId', sql.UniqueIdentifier, threadId)
        .input('owner', sql.UniqueIdentifier, userId)
        .query('UPDATE oe.EmailThreads SET AssignedToUserId=@owner WHERE ThreadId=@threadId AND VendorId=@vendorId AND AssignedToUserId IS NULL');
}

async function getMessageById(vendorId, emailMessageId) {
    const pool = await getPool();
    const r = await pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .input('id', sql.UniqueIdentifier, emailMessageId)
        .query(`SELECT * FROM oe.EmailMessages WHERE EmailMessageId=@id AND VendorId=@vendorId`);
    return r.recordset[0] || null;
}

// ---------------------------------------------------------------------------
// Read APIs (inbox UI)
// ---------------------------------------------------------------------------

async function listThreads(vendorId, opts = {}) {
    const pool = await getPool();
    const page = Math.max(1, parseInt(opts.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(opts.limit, 10) || 25));
    const offset = (page - 1) * limit;

    const where = ['t.VendorId=@vendorId', 't.IsArchived=0'];
    const req = pool.request().input('vendorId', sql.UniqueIdentifier, vendorId);

    if (opts.needsReply === 'true' || opts.needsReply === '1') where.push('t.NeedsReply=1 AND t.ResolvedAt IS NULL');
    if (opts.unlinked === 'true' || opts.unlinked === '1') where.push('t.CaseId IS NULL AND t.ShareRequestId IS NULL');
    // "Members" — real member conversations only (linked to a member, or an inbound
    // from a known member's email). Cuts out vendor/partner/system noise.
    if (opts.members === 'true' || opts.members === '1' || opts.members === true) {
        where.push(`(t.MemberId IS NOT NULL OR EXISTS (
            SELECT 1 FROM oe.EmailMessages mm
            JOIN oe.Users uu ON LOWER(uu.Email) = LOWER(mm.FromAddress)
            JOIN oe.Members me ON me.UserId = uu.UserId
            WHERE mm.ThreadId = t.ThreadId AND mm.Direction = 'inbound'))`);
    }
    if (opts.shareRequestId) { where.push('t.ShareRequestId=@shareRequestId'); req.input('shareRequestId', sql.UniqueIdentifier, opts.shareRequestId); }
    if (opts.caseId) { where.push('t.CaseId=@caseId'); req.input('caseId', sql.UniqueIdentifier, opts.caseId); }
    if (opts.memberId) { where.push('t.MemberId=@memberId'); req.input('memberId', sql.UniqueIdentifier, opts.memberId); }
    if (opts.q) {
        // Search subject + any message's sender/recipient/preview + the linked member's name.
        where.push(`(
            t.Subject LIKE @q
            OR EXISTS (SELECT 1 FROM oe.EmailMessages mq WHERE mq.ThreadId = t.ThreadId
                       AND (mq.FromName LIKE @q OR mq.FromAddress LIKE @q OR mq.ToAddresses LIKE @q OR mq.BodyPreview LIKE @q))
            OR EXISTS (SELECT 1 FROM oe.Members mem2 JOIN oe.Users mu2 ON mem2.UserId = mu2.UserId
                       WHERE mem2.MemberId = t.MemberId AND LTRIM(RTRIM(CONCAT(mu2.FirstName, ' ', mu2.LastName))) LIKE @q)
        )`);
        req.input('q', sql.NVarChar, `%${opts.q}%`);
    }
    // Soft ownership filter: "mine" (assigned to me) / "unassigned" / all (default).
    if (opts.owner === 'mine' && opts.currentUserId) {
        where.push('t.AssignedToUserId=@currentUserId');
        req.input('currentUserId', sql.UniqueIdentifier, opts.currentUserId);
    } else if (opts.owner === 'unassigned') {
        where.push('t.AssignedToUserId IS NULL');
    }

    const whereSql = where.join(' AND ');
    const totalR = await req.query(`SELECT COUNT(*) AS Total FROM oe.EmailThreads t WHERE ${whereSql}`);
    const total = totalR.recordset[0].Total;

    const dataR = await req
        .input('offset', sql.Int, offset)
        .input('limit', sql.Int, limit)
        .query(`
            SELECT t.*,
                sr.RequestNumber AS LinkedShareRequestNumber,
                c.CaseNumber     AS LinkedCaseNumber,
                inb.FromName     AS CounterpartyName,
                COALESCE(inb.FromAddress, JSON_VALUE(outb.ToAddresses, '$[0]')) AS CounterpartyAddress,
                LTRIM(RTRIM(CONCAT(mu.FirstName, ' ', mu.LastName))) AS LinkedMemberName,
                LTRIM(RTRIM(CONCAT(au.FirstName, ' ', au.LastName))) AS OwnerName,
                au.PreferredColor AS OwnerColor,
                lastmsg.BodyPreview AS LastPreview
            FROM oe.EmailThreads t
            LEFT JOIN oe.ShareRequests sr ON t.ShareRequestId = sr.ShareRequestId
            LEFT JOIN oe.Cases c ON t.CaseId = c.CaseId
            LEFT JOIN oe.Members mem ON t.MemberId = mem.MemberId
            LEFT JOIN oe.Users mu ON mem.UserId = mu.UserId
            LEFT JOIN oe.Users au ON t.AssignedToUserId = au.UserId
            OUTER APPLY (
                -- Latest message's preview — the inbox row's third line (Outlook-style snippet).
                SELECT TOP 1 m.BodyPreview FROM oe.EmailMessages m
                WHERE m.ThreadId = t.ThreadId
                ORDER BY COALESCE(m.SentAt, m.ReceivedAt) DESC
            ) lastmsg
            OUTER APPLY (
                SELECT TOP 1 m.FromName, m.FromAddress FROM oe.EmailMessages m
                WHERE m.ThreadId = t.ThreadId AND m.Direction = 'inbound'
                ORDER BY COALESCE(m.ReceivedAt, m.SentAt) DESC
            ) inb
            OUTER APPLY (
                -- EARLIEST outbound (ASC) = the original recipient (real customer);
                -- immune to any previously mis-sent reply. Matches getThreadSendContext.
                SELECT TOP 1 m.ToAddresses FROM oe.EmailMessages m
                WHERE m.ThreadId = t.ThreadId AND m.Direction = 'outbound'
                ORDER BY COALESCE(m.SentAt, m.ReceivedAt) ASC
            ) outb
            WHERE ${whereSql}
            ORDER BY t.LastMessageAt DESC
            OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
        `);
    return {
        data: dataR.recordset,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
}

async function getThread(vendorId, threadId) {
    const pool = await getPool();
    const tr = await pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .input('threadId', sql.UniqueIdentifier, threadId)
        .query(`
            SELECT t.*,
                sr.RequestNumber AS LinkedShareRequestNumber,
                c.CaseNumber     AS LinkedCaseNumber,
                mu.FirstName AS MemberFirstName, mu.LastName AS MemberLastName,
                mu.Email AS MemberEmail, mu.PhoneNumber AS MemberPhone,
                LTRIM(RTRIM(CONCAT(au.FirstName, ' ', au.LastName))) AS OwnerName,
                au.PreferredColor AS OwnerColor,
                LTRIM(RTRIM(CONCAT(ru.FirstName, ' ', ru.LastName))) AS ResolvedByName
            FROM oe.EmailThreads t
            LEFT JOIN oe.ShareRequests sr ON t.ShareRequestId = sr.ShareRequestId
            LEFT JOIN oe.Cases c ON t.CaseId = c.CaseId
            LEFT JOIN oe.Members mem ON t.MemberId = mem.MemberId
            LEFT JOIN oe.Users mu ON mem.UserId = mu.UserId
            LEFT JOIN oe.Users au ON t.AssignedToUserId = au.UserId
            LEFT JOIN oe.Users ru ON t.ResolvedByUserId = ru.UserId
            WHERE t.ThreadId = @threadId AND t.VendorId = @vendorId
        `);
    const thread = tr.recordset[0];
    if (!thread) return null;
    const msgs = await pool.request()
        .input('threadId', sql.UniqueIdentifier, threadId)
        .query(`
            SELECT m.*, u.FirstName AS SentByFirstName, u.LastName AS SentByLastName
            FROM oe.EmailMessages m
            LEFT JOIN oe.Users u ON m.SentByUserId = u.UserId
            WHERE m.ThreadId=@threadId
            ORDER BY COALESCE(m.ReceivedAt, m.SentAt) ASC
        `);
    // Resolve inline images: rewrite each body's <img src="cid:..."> to the stored
    // inline attachment's SAS URL so embedded pictures render (browsers can't load
    // cid: refs). One map per thread, applied to every message body.
    const inlineMap = await emailAttachmentService.inlineUrlMapForThread(vendorId, threadId);
    const messages = msgs.recordset.map((m) => ({
        ...m,
        BodyHtml: emailAttachmentService.rewriteCidReferences(m.BodyHtml, inlineMap),
    }));
    return { ...thread, messages };
}

/**
 * All email history for a customer — every thread for the given member and/or
 * counterparty address, grouped by conversation (read-only "Show history" modal).
 * `scope` = 'member' | 'address' | 'both' (default). When a caseId/shareRequestId
 * is passed, each thread is flagged isCurrentContext if it's linked to it (so the
 * UI can highlight the conversations that belong to the case/SR being worked).
 */
async function getCustomerHistory(vendorId, { memberId, address, scope = 'both', caseId, shareRequestId } = {}) {
    const pool = await getPool();
    const useMember = (scope === 'member' || scope === 'both') && memberId;
    const useAddress = (scope === 'address' || scope === 'both') && address;
    if (!useMember && !useAddress) return { threads: [] };

    const req = pool.request().input('vendorId', sql.UniqueIdentifier, vendorId);
    const conds = [];
    if (useMember) { req.input('memberId', sql.UniqueIdentifier, memberId); conds.push('t.MemberId = @memberId'); }
    if (useAddress) {
        req.input('address', sql.NVarChar, String(address).toLowerCase());
        conds.push(`EXISTS (SELECT 1 FROM oe.EmailMessages mx WHERE mx.ThreadId = t.ThreadId
                     AND (LOWER(mx.FromAddress) = @address OR LOWER(mx.ToAddresses) LIKE '%' + @address + '%'))`);
    }

    const threadsR = await req.query(`
        SELECT t.ThreadId, t.Subject, t.LastMessageAt, t.FirstMessageAt, t.MemberId, t.CaseId, t.ShareRequestId,
               t.MessageCount, t.LastDirection, t.NeedsReply,
               sr.RequestNumber AS LinkedShareRequestNumber,
               c.CaseNumber     AS LinkedCaseNumber,
               inb.FromName     AS CounterpartyName,
               COALESCE(inb.FromAddress, JSON_VALUE(outb.ToAddresses, '$[0]')) AS CounterpartyAddress
        FROM oe.EmailThreads t
        LEFT JOIN oe.ShareRequests sr ON t.ShareRequestId = sr.ShareRequestId
        LEFT JOIN oe.Cases c ON t.CaseId = c.CaseId
        OUTER APPLY (
            SELECT TOP 1 m.FromName, m.FromAddress FROM oe.EmailMessages m
            WHERE m.ThreadId = t.ThreadId AND m.Direction = 'inbound'
            ORDER BY COALESCE(m.ReceivedAt, m.SentAt) DESC
        ) inb
        OUTER APPLY (
            SELECT TOP 1 m.ToAddresses FROM oe.EmailMessages m
            WHERE m.ThreadId = t.ThreadId AND m.Direction = 'outbound'
            ORDER BY COALESCE(m.SentAt, m.ReceivedAt) ASC
        ) outb
        WHERE t.VendorId = @vendorId AND t.IsArchived = 0 AND (${conds.join(' OR ')})
        ORDER BY t.LastMessageAt DESC
    `);
    const threads = threadsR.recordset;
    if (!threads.length) return { threads: [] };

    // Fetch every message for these threads in one query, then group in JS.
    const msgReq = pool.request();
    const idParams = threads.map((t, i) => { msgReq.input(`t${i}`, sql.UniqueIdentifier, t.ThreadId); return `@t${i}`; });
    const msgsR = await msgReq.query(`
        SELECT m.EmailMessageId, m.ThreadId, m.Direction, m.FromAddress, m.FromName, m.ToAddresses, m.CcAddresses,
               m.Subject, m.BodyPreview, m.ReceivedAt, m.SentAt, m.IsRead, m.HasAttachments,
               m.SentByUserId, u.FirstName AS SentByFirstName, u.LastName AS SentByLastName
        FROM oe.EmailMessages m
        LEFT JOIN oe.Users u ON m.SentByUserId = u.UserId
        WHERE m.ThreadId IN (${idParams.join(', ')})
        ORDER BY COALESCE(m.ReceivedAt, m.SentAt) ASC
    `);
    const byThread = {};
    for (const m of msgsR.recordset) (byThread[m.ThreadId] ||= []).push(m);

    const lc = (v) => (v == null ? null : String(v).toLowerCase());
    const caseLc = lc(caseId);
    const srLc = lc(shareRequestId);
    return {
        threads: threads.map((t) => ({
            ...t,
            isCurrentContext: !!((caseLc && lc(t.CaseId) === caseLc) || (srLc && lc(t.ShareRequestId) === srLc)),
            messages: byThread[t.ThreadId] || [],
        })),
    };
}

// ---------------------------------------------------------------------------
// Internal notes + "Handled" resolution (team-only; never sent to the customer)
// ---------------------------------------------------------------------------

async function listThreadNotes(vendorId, threadId) {
    const pool = await getPool();
    if (!(await getThreadRow(vendorId, threadId))) { const e = new Error('Thread not found'); e.statusCode = 404; throw e; }
    const r = await pool.request()
        .input('threadId', sql.UniqueIdentifier, threadId)
        .query(`SELECT NoteId, Note, IsInternal, CreatedDate, CreatedBy, CreatedByName
                FROM oe.EmailThreadNotes WHERE ThreadId=@threadId ORDER BY CreatedDate ASC`);
    return r.recordset;
}

async function addThreadNote(vendorId, threadId, { note, userId, userName }) {
    if (!note || !String(note).trim()) { const e = new Error('Note text is required'); e.statusCode = 400; throw e; }
    const pool = await getPool();
    if (!(await getThreadRow(vendorId, threadId))) { const e = new Error('Thread not found'); e.statusCode = 404; throw e; }
    const r = await pool.request()
        .input('threadId', sql.UniqueIdentifier, threadId)
        .input('note', sql.NVarChar(sql.MAX), String(note).trim())
        .input('createdBy', sql.UniqueIdentifier, userId || null)
        .input('createdByName', sql.NVarChar, userName || null)
        .query(`INSERT INTO oe.EmailThreadNotes (ThreadId, Note, CreatedBy, CreatedByName)
                OUTPUT INSERTED.NoteId, INSERTED.Note, INSERTED.IsInternal, INSERTED.CreatedDate, INSERTED.CreatedBy, INSERTED.CreatedByName
                VALUES (@threadId, @note, @createdBy, @createdByName)`);
    return r.recordset[0];
}

/** Mark a thread handled (resolved=true) or reopen it (resolved=false). Returns the thread. */
async function setThreadResolved(vendorId, threadId, userId, resolved) {
    const pool = await getPool();
    if (!(await getThreadRow(vendorId, threadId))) { const e = new Error('Thread not found'); e.statusCode = 404; throw e; }
    await pool.request()
        .input('threadId', sql.UniqueIdentifier, threadId)
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .input('userId', sql.UniqueIdentifier, resolved ? (userId || null) : null)
        .query(`UPDATE oe.EmailThreads
                SET ResolvedAt=${resolved ? 'SYSUTCDATETIME()' : 'NULL'}, ResolvedByUserId=@userId, ModifiedDate=SYSUTCDATETIME()
                WHERE ThreadId=@threadId AND VendorId=@vendorId`);
    return getThread(vendorId, threadId);
}

/** Context for sending a reply: thread, the message to reply to, ref, vendor name. */
async function getThreadSendContext(vendorId, threadId) {
    const pool = await getPool();
    const r = await pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .input('threadId', sql.UniqueIdentifier, threadId)
        .query(`
            SELECT t.*, sr.RequestNumber, c.CaseNumber, v.VendorName,
                inb.FromName AS CounterpartyName,
                COALESCE(inb.FromAddress, JSON_VALUE(outb.ToAddresses, '$[0]')) AS CounterpartyAddress
            FROM oe.EmailThreads t
            LEFT JOIN oe.ShareRequests sr ON t.ShareRequestId=sr.ShareRequestId
            LEFT JOIN oe.Cases c ON t.CaseId=c.CaseId
            LEFT JOIN oe.Vendors v ON t.VendorId=v.VendorId
            OUTER APPLY (
                SELECT TOP 1 m.FromName, m.FromAddress FROM oe.EmailMessages m
                WHERE m.ThreadId = t.ThreadId AND m.Direction='inbound'
                ORDER BY COALESCE(m.ReceivedAt, m.SentAt) DESC
            ) inb
            OUTER APPLY (
                -- EARLIEST outbound (ASC): the original recipient, which is always the
                -- real customer. Using the latest outbound would re-derive a wrong
                -- counterparty from a previously mis-sent reply and perpetuate the loop.
                SELECT TOP 1 m.ToAddresses FROM oe.EmailMessages m
                WHERE m.ThreadId = t.ThreadId AND m.Direction='outbound'
                ORDER BY COALESCE(m.SentAt, m.ReceivedAt) ASC
            ) outb
            WHERE t.ThreadId=@threadId AND t.VendorId=@vendorId
        `);
    const thread = r.recordset[0];
    if (!thread) return { thread: null };

    const lastR = await pool.request()
        .input('threadId', sql.UniqueIdentifier, threadId)
        .query(`
            SELECT TOP 1 GraphMessageId
            FROM oe.EmailMessages
            WHERE ThreadId=@threadId
            ORDER BY COALESCE(SentAt, ReceivedAt) DESC
        `);
    return {
        thread,
        lastMessage: lastR.recordset[0] || null, // latest message overall (used to thread the reply)
        // The customer side of the conversation — the latest inbound sender, or
        // (if they haven't replied) the recipient of our latest outbound. A reply
        // must always go HERE, never back to the sender of the last message.
        counterpartyAddress: thread.CounterpartyAddress || null,
        counterpartyName: thread.CounterpartyName || null,
        ref: thread.RequestNumber || thread.CaseNumber || null,
        vendorName: thread.VendorName || null,
    };
}

// ---------------------------------------------------------------------------
// Linking
// ---------------------------------------------------------------------------

/** Link a thread to a member / case / SR, then backfill an encounter per message. */
async function linkThread(vendorId, threadId, { memberId, caseId, shareRequestId }, ctx = {}) {
    const pool = await getPool();
    await pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .input('threadId', sql.UniqueIdentifier, threadId)
        .input('memberId', sql.UniqueIdentifier, memberId || null)
        .input('caseId', sql.UniqueIdentifier, caseId || null)
        .input('shareRequestId', sql.UniqueIdentifier, shareRequestId || null)
        .input('modifiedBy', sql.UniqueIdentifier, ctx.userId || null)
        .query(`
            UPDATE oe.EmailThreads
            SET MemberId=@memberId, CaseId=@caseId, ShareRequestId=@shareRequestId,
                ModifiedDate=SYSUTCDATETIME(), ModifiedBy=@modifiedBy
            WHERE ThreadId=@threadId AND VendorId=@vendorId
        `);

    // Keep this thread's auto email-encounters in sync with the (re)link so they
    // never stay attached to a previous member/case/SR.
    const isLinked = !!(memberId || caseId || shareRequestId);
    if (isLinked) {
        // Re-link: re-point existing email encounters to the new entity (and
        // un-archive any that were archived by a prior unlink). The backfill below
        // then creates encounters for any messages that don't have one yet.
        await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('threadId', sql.UniqueIdentifier, threadId)
            .input('memberId', sql.UniqueIdentifier, memberId || null)
            .input('caseId', sql.UniqueIdentifier, caseId || null)
            .input('shareRequestId', sql.UniqueIdentifier, shareRequestId || null)
            .query(`
                UPDATE e SET e.MemberId=@memberId, e.CaseId=@caseId, e.ShareRequestId=@shareRequestId,
                    e.IsArchived=0, e.ModifiedDate=SYSUTCDATETIME()
                FROM oe.Encounters e
                JOIN oe.EmailMessages m ON e.EmailMessageId = m.EmailMessageId
                WHERE m.ThreadId=@threadId AND e.VendorId=@vendorId AND e.Source='email'
            `);
    } else {
        // Unlink: the thread's auto email encounters no longer have a home — archive them.
        await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('threadId', sql.UniqueIdentifier, threadId)
            .query(`
                UPDATE e SET e.IsArchived=1, e.ModifiedDate=SYSUTCDATETIME()
                FROM oe.Encounters e
                JOIN oe.EmailMessages m ON e.EmailMessageId = m.EmailMessageId
                WHERE m.ThreadId=@threadId AND e.VendorId=@vendorId AND e.Source='email'
            `);
    }

    const thread = await getThreadRow(vendorId, threadId);
    const msgs = await pool.request()
        .input('threadId', sql.UniqueIdentifier, threadId)
        .query(`SELECT EmailMessageId, GraphMessageId, Direction, Subject, BodyPreview, ReceivedAt, SentAt
                FROM oe.EmailMessages WHERE ThreadId=@threadId`);
    for (const msgRow of msgs.recordset) {
        await ensureEncounterForMessage(vendorId, thread, msgRow, ctx);
    }
    return getThread(vendorId, threadId);
}

/** Suggest link targets by matching the inbound sender to a member + their open SR/cases. */
async function suggestLinks(vendorId, threadId) {
    const pool = await getPool();
    const fromR = await pool.request()
        .input('threadId', sql.UniqueIdentifier, threadId)
        .query(`SELECT TOP 1 FromAddress FROM oe.EmailMessages WHERE ThreadId=@threadId AND Direction='inbound' ORDER BY COALESCE(ReceivedAt,SentAt) ASC`);
    const fromAddress = fromR.recordset[0]?.FromAddress;
    if (!fromAddress) return { members: [], shareRequests: [], cases: [] };

    const memberR = await pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .input('email', sql.NVarChar, fromAddress)
        .query(`
            SELECT TOP 5 m.MemberId, u.FirstName, u.LastName, u.Email
            FROM oe.Members m
            JOIN oe.Users u ON m.UserId = u.UserId
            WHERE u.Email = @email
        `);
    const members = memberR.recordset;
    if (!members.length) return { members: [], shareRequests: [], cases: [] };

    const memberIds = members.map((m) => m.MemberId);
    const srReq = pool.request().input('vendorId', sql.UniqueIdentifier, vendorId);
    memberIds.forEach((id, i) => srReq.input(`m${i}`, sql.UniqueIdentifier, id));
    const inClause = memberIds.map((_, i) => `@m${i}`).join(',');

    const srR = await srReq.query(`
        SELECT TOP 10 ShareRequestId, RequestNumber, Status
        FROM oe.ShareRequests
        WHERE VendorId=@vendorId AND MemberId IN (${inClause})
        ORDER BY SubmittedDate DESC
    `);
    const caseR = await srReq.query(`
        SELECT TOP 10 CaseId, CaseNumber, Status
        FROM oe.Cases
        WHERE VendorId=@vendorId AND MemberId IN (${inClause})
        ORDER BY SubmittedDate DESC
    `);
    return { members, shareRequests: srR.recordset, cases: caseR.recordset };
}

/** Open share requests + cases for a member — used by the compose-new link pickers. */
async function getMemberLinkOptions(vendorId, memberId) {
    const pool = await getPool();
    const sr = await pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .input('memberId', sql.UniqueIdentifier, memberId)
        .query(`SELECT TOP 20 ShareRequestId, RequestNumber, Status FROM oe.ShareRequests
                WHERE VendorId=@vendorId AND MemberId=@memberId ORDER BY SubmittedDate DESC`);
    const cs = await pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .input('memberId', sql.UniqueIdentifier, memberId)
        .query(`SELECT TOP 20 CaseId, CaseNumber, Status FROM oe.Cases
                WHERE VendorId=@vendorId AND MemberId=@memberId ORDER BY SubmittedDate DESC`);
    return { shareRequests: sr.recordset, cases: cs.recordset };
}

/** Resolve the customer-facing ref (SR-/CASE- number) + vendor name for a compose. */
async function getComposeContext(vendorId, { caseId, shareRequestId } = {}) {
    const pool = await getPool();
    const r = await pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .input('cid', sql.UniqueIdentifier, caseId || null)
        .input('sid', sql.UniqueIdentifier, shareRequestId || null)
        .query(`
            SELECT v.VendorName,
                (SELECT RequestNumber FROM oe.ShareRequests WHERE ShareRequestId=@sid AND VendorId=@vendorId) AS RequestNumber,
                (SELECT CaseNumber FROM oe.Cases WHERE CaseId=@cid AND VendorId=@vendorId) AS CaseNumber
            FROM oe.Vendors v WHERE v.VendorId=@vendorId
        `);
    const row = r.recordset[0] || {};
    return { ref: row.RequestNumber || row.CaseNumber || null, vendorName: row.VendorName || null };
}

async function markThreadRead(vendorId, threadId) {
    const pool = await getPool();
    await pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .input('threadId', sql.UniqueIdentifier, threadId)
        .query(`UPDATE oe.EmailMessages SET IsRead=1 WHERE ThreadId=@threadId AND VendorId=@vendorId AND Direction='inbound'`);
    await recomputeThread(vendorId, threadId);
    return getThread(vendorId, threadId);
}

module.exports = {
    upsertThread,
    recomputeThread,
    insertMessageIfNew,
    recordInboundMessage,
    recordOutboundMessage,
    recordOutboundFromSync,
    getCustomerHistory,
    listThreadNotes,
    addThreadNote,
    setThreadResolved,
    listThreads,
    getThread,
    getThreadRow,
    getThreadSendContext,
    getThreadParticipants,
    assignThread,
    linkThread,
    unlinkThread: (vendorId, threadId, ctx) => linkThread(vendorId, threadId, {}, ctx),
    suggestLinks,
    getMemberLinkOptions,
    getComposeContext,
    getThreadSuggestion,
    dismissSuggestion,
    heartbeatPresence,
    getPresence,
    clearPresence,
    markThreadRead,
};
