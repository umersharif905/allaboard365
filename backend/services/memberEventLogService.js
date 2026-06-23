// services/memberEventLogService.js
// Fire-and-forget writer for oe.MemberEventLog — records member-level
// lifecycle events (enrollment created, etc.) that feed the history timeline.
//
// CONTRACT: this must never throw into its callers. Core flows (enrollment)
// call it and must not depend on it. It runs on its own pooled connection,
// NOT the caller's transaction — so a logging failure cannot abort a caller's
// transaction, and a caller's rollback does not roll back the log row.
// Phantom rows on a rare rollback are acceptable for an audit timeline.

const { getPool, sql, rawSql } = require('../config/database');

// Cache whether oe.MemberEventLog.EventDetails exists (added by the
// 2026-05-20 history-timeline migration). undefined = not yet checked.
let _hasEventDetails;

/**
 * Append a member event. Never throws; not meant to be awaited by callers
 * on a critical path (though awaiting is harmless).
 *
 * @param {object} p
 * @param {string} p.memberId
 * @param {string} p.eventType   e.g. 'ENROLLMENT_CREATED'
 * @param {string} [p.eventDetails]  human-readable detail
 * @param {string} [p.userId]    actor (CreatedBy)
 */
async function logMemberEvent({ memberId, eventType, eventDetails = null, userId = null }) {
    try {
        if (!memberId || !eventType) return;
        const pool = await getPool();

        if (_hasEventDetails === undefined) {
            const c = await pool.request().query(
                `SELECT CASE WHEN COL_LENGTH('oe.MemberEventLog','EventDetails') IS NOT NULL
                             THEN 1 ELSE 0 END AS H`
            );
            _hasEventDetails = c.recordset[0].H === 1;
        }

        const req = pool.request();
        req.input('memberId', sql.UniqueIdentifier, memberId);
        req.input('eventType', sql.NVarChar(64), eventType);
        req.input('createdBy', sql.UniqueIdentifier, userId || null);

        if (_hasEventDetails) {
            req.input('eventDetails', rawSql.NVarChar(rawSql.MAX), eventDetails);
            await req.query(`
                IF OBJECT_ID('oe.MemberEventLog','U') IS NOT NULL
                INSERT INTO oe.MemberEventLog (MemberId, EventType, CreatedBy, EventDetails)
                VALUES (@memberId, @eventType, @createdBy, @eventDetails)
            `);
        } else {
            // Pre-migration fallback: stash a short detail in NewGroupName so
            // the event is still recorded and visible.
            req.input('newGroupName', sql.NVarChar(500),
                String(eventDetails || '').slice(0, 500) || null);
            await req.query(`
                IF OBJECT_ID('oe.MemberEventLog','U') IS NOT NULL
                INSERT INTO oe.MemberEventLog (MemberId, EventType, CreatedBy, NewGroupName)
                VALUES (@memberId, @eventType, @createdBy, @newGroupName)
            `);
        }
    } catch (err) {
        console.warn('[memberEventLogService] logMemberEvent failed (ignored):', err.message);
    }
}

module.exports = { logMemberEvent };
