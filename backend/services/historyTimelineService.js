// services/historyTimelineService.js
// Read-only aggregator that builds a unified, time-ordered history timeline
// for a Case or a Share Request. It reads already-recorded history from the
// domain tables at request time — there is no separate event store.
//
// Approach C (hybrid): aggregate what is already recorded; targeted
// instrumentation for the genuine gaps (creation source, plan changes,
// outreach) is added in later phases.
//
// Each source is collected defensively: a failing collector logs and yields
// an empty list rather than breaking the whole timeline.
//
// Each event carries optional `meta` (label/value detail pairs shown in the
// click-through modal) and `ref` ({ kind, id } identifying the underlying
// record so the UI can deep-link to it).

const { getPool, sql } = require('../config/database');

// NoteType → timeline category. Cases and Share Requests use different
// NoteType vocabularies; map both. Anything unmapped falls back to 'system'.
const CASE_NOTE_CATEGORY = {
    user_note: 'note',
    created: 'creation',
    updated: 'system',
    status_change: 'status',
    claimed: 'assignment',
    unclaimed: 'assignment',
    reassigned: 'assignment',
    finance: 'system',
};

const SR_NOTE_CATEGORY = {
    Note: 'note',
    StatusChange: 'status',
    SystemActivity: 'system',
    Communication: 'communication',
    Call: 'communication',
    Email: 'communication',
    PushNotification: 'communication',
};

// Build a display name from joined oe.Users columns, preferring the
// denormalized CreatedByName when present.
function personName(row, denormField = 'CreatedByName') {
    const denorm = row[denormField];
    if (denorm && String(denorm).trim()) return String(denorm).trim();
    const full = `${row.FirstName || ''} ${row.LastName || ''}`.trim();
    return full || null;
}

function fmtDate(v) {
    if (!v) return null;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit',
    });
}

function fmtSize(bytes) {
    if (!bytes || bytes <= 0) return null;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtDuration(seconds) {
    if (!seconds || seconds <= 0) return null;
    const m = Math.round(seconds / 60);
    return m < 1 ? `${seconds}s` : `${m} min`;
}

// Turn [label, value] pairs into the meta array, dropping empty values.
function metaPairs(pairs) {
    const out = [];
    for (const [label, value] of pairs) {
        if (value === null || value === undefined || value === '') continue;
        out.push({ label, value: String(value) });
    }
    return out;
}

// Normalize one event and push it onto the accumulator. Rows with no usable
// timestamp are dropped (they cannot be placed on a timeline).
function pushEvent(arr, e) {
    if (!e.occurredAt) return;
    const d = e.occurredAt instanceof Date ? e.occurredAt : new Date(e.occurredAt);
    if (Number.isNaN(d.getTime())) return;
    arr.push({
        id: String(e.id),
        category: e.category,
        occurredAt: d.toISOString(),
        actorName: e.actorName || null,
        title: e.title,
        detail: e.detail || null,
        before: e.before || null,
        after: e.after || null,
        meta: e.meta && e.meta.length ? e.meta : null,
        ref: e.ref || null,
    });
}

async function safe(label, fn) {
    try {
        return await fn();
    } catch (err) {
        console.error(`[historyTimeline] collector "${label}" failed:`, err.message);
        return [];
    }
}

function mergeSort(groups) {
    const all = groups.flat();
    all.sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime());
    return all;
}

// ---------------------------------------------------------------------------
// Shared collectors — parameterized by the link column so Cases and Share
// Requests reuse the exact same query.
// linkColumn values are hardcoded literals, never user input.
// ---------------------------------------------------------------------------

async function collectEncounters(pool, linkColumn, entityId) {
    const r = await pool.request()
        .input('id', sql.UniqueIdentifier, entityId)
        .query(`
            SELECT EncounterId, EncounterNumber, Summary, Channel, Direction,
                   OccurredAt, CreatedDate, CreatedByName, DurationSeconds, FollowUpDueDate
            FROM oe.Encounters
            WHERE ${linkColumn} = @id AND (IsArchived = 0 OR IsArchived IS NULL)
        `);
    const out = [];
    for (const row of r.recordset) {
        // Email encounters read as "Email sent/received" (clearer than the generic
        // "Encounter logged · email"); other channels keep the generic title.
        const isEmail = row.Channel === 'email';
        const title = isEmail
            ? `Email ${row.Direction === 'outbound' ? 'sent' : 'received'}`
            : `Encounter logged${row.Channel ? ` · ${row.Channel}` : ''}`;
        // The stored summary already starts with "Sent email:"/"Received email:";
        // drop that prefix in the detail since the title now conveys direction.
        const detail = isEmail && row.Summary
            ? row.Summary.replace(/^(Sent|Received) email:\s*/i, '')
            : (row.Summary || null);
        pushEvent(out, {
            id: `enc-${row.EncounterId}`,
            category: 'encounter',
            occurredAt: row.OccurredAt || row.CreatedDate,
            actorName: row.CreatedByName || null,
            title,
            detail,
            meta: metaPairs([
                ['Encounter #', row.EncounterNumber],
                ['Channel', row.Channel],
                ['Direction', row.Direction],
                ['Duration', fmtDuration(row.DurationSeconds)],
                ['Follow-up due', fmtDate(row.FollowUpDueDate)],
            ]),
            ref: { kind: 'encounter', id: String(row.EncounterId) },
        });
    }
    return out;
}

async function collectFormSubmissions(pool, linkColumn, entityId) {
    const r = await pool.request()
        .input('id', sql.UniqueIdentifier, entityId)
        .query(`
            SELECT s.SubmissionId, s.FormKind, s.CreatedDate, s.MemberMatchStatus,
                   s.PayloadFirstName, s.PayloadLastName,
                   t.Title AS FormTitle, t.KindLabel
            FROM oe.PublicFormSubmissions s
            LEFT JOIN oe.PublicFormTemplates t ON t.FormTemplateId = s.FormTemplateId
            WHERE s.${linkColumn} = @id
        `);
    // Note: form-OPEN events were intentionally dropped — the platform records
    // no "form opened to be filled" timestamp (the AnonymousLinkFirstViewedAt /
    // RoutingEmailFirstOpenedAt columns are post-submit link/email opens, only
    // for anonymous forms). See docs/backoffice/case-history-implementation.md.
    const out = [];
    for (const row of r.recordset) {
        const formName = row.FormTitle || row.KindLabel || row.FormKind || 'form';
        const submitter = `${row.PayloadFirstName || ''} ${row.PayloadLastName || ''}`.trim();
        pushEvent(out, {
            id: `formsub-${row.SubmissionId}`,
            category: 'form',
            occurredAt: row.CreatedDate,
            actorName: submitter || null,
            title: `Form submitted: ${formName}`,
            meta: metaPairs([
                ['Form', formName],
                ['Kind', row.FormKind],
                ['Member match', row.MemberMatchStatus],
            ]),
            ref: { kind: 'form-submission', id: String(row.SubmissionId) },
        });
    }
    return out;
}

async function collectFormInvitations(pool, linkColumn, entityId) {
    const r = await pool.request()
        .input('id', sql.UniqueIdentifier, entityId)
        .query(`
            SELECT i.InvitationId, i.SentToEmail, i.DeliveryMethod, i.CreatedDate,
                   i.ExpiresAt, i.FirstUsedAt, i.FormTemplateId, i.Mode,
                   t.Title AS FormTitle, t.KindLabel, t.FormKind,
                   u.FirstName, u.LastName
            FROM oe.PublicFormInvitations i
            LEFT JOIN oe.PublicFormTemplates t ON t.FormTemplateId = i.FormTemplateId
            LEFT JOIN oe.Users u ON u.UserId = i.SentByUserId
            WHERE i.${linkColumn} = @id
        `);
    const out = [];
    for (const row of r.recordset) {
        const formName = row.FormTitle || row.KindLabel || row.FormKind || 'form';
        pushEvent(out, {
            id: `forminv-${row.InvitationId}`,
            category: 'form',
            occurredAt: row.CreatedDate,
            actorName: personName(row, '_none'),
            title: `Form sent: ${formName}`,
            detail: row.SentToEmail ? `Sent to ${row.SentToEmail}` : null,
            meta: metaPairs([
                ['Form', formName],
                ['Sent to', row.SentToEmail],
                ['Delivery', row.DeliveryMethod],
                ['Mode', row.Mode],
                ['Expires', fmtDate(row.ExpiresAt)],
                ['First used', fmtDate(row.FirstUsedAt)],
            ]),
            ref: row.FormTemplateId
                ? { kind: 'form-template', id: String(row.FormTemplateId) }
                : null,
        });
    }
    return out;
}

// Human phrasing for the CreatedVia source ('form' | 'vendor' | 'encounter').
const CREATED_VIA_LABEL = {
    form: 'a public form',
    vendor: 'the vendor portal',
    encounter: 'an encounter',
};

// The single "created" event, synthesized from the entity row so it can carry
// the CreatedVia source label. `table`/`idColumn` are hardcoded literals.
async function collectCreation(pool, table, idColumn, entityId, label) {
    // CreatedVia arrives with the 2026-05-20 migration; query defensively so
    // the timeline still works before the column exists.
    const baseQuery = (withVia) => `
        SELECT TOP 1 c.CreatedDate, c.CreatedBy${withVia ? ', c.CreatedVia' : ''},
               u.FirstName, u.LastName
        FROM oe.${table} c
        LEFT JOIN oe.Users u ON u.UserId = c.CreatedBy
        WHERE c.${idColumn} = @id
    `;
    let row;
    try {
        const r = await pool.request()
            .input('id', sql.UniqueIdentifier, entityId)
            .query(baseQuery(true));
        row = r.recordset[0];
    } catch (e) {
        const r = await pool.request()
            .input('id', sql.UniqueIdentifier, entityId)
            .query(baseQuery(false));
        row = r.recordset[0];
    }
    if (!row) return [];
    const via = row.CreatedVia
        ? (CREATED_VIA_LABEL[row.CreatedVia] || row.CreatedVia)
        : null;
    const out = [];
    pushEvent(out, {
        id: `creation-${entityId}`,
        category: 'creation',
        occurredAt: row.CreatedDate,
        actorName: personName(row, '_none'),
        title: via ? `${label} created via ${via}` : `${label} created`,
        meta: row.CreatedVia ? metaPairs([['Created via', row.CreatedVia]]) : null,
    });
    return out;
}

// MemberEventLog.EventType → timeline title.
const PLAN_EVENT_TITLE = {
    ENROLLMENT_CREATED: 'Plan enrolled',
    ENROLLMENT_TERMINATED: 'Plan terminated',
    PLAN_MODIFICATION_APPLIED: 'Plan modified',
    GROUP_CHANGED: 'Group changed',
};

// Plan / membership changes for the entity's member, limited to the window
// the case/share request was open. Reads oe.MemberEventLog — surfaces events
// already logged by the admin plan-modification and group-change flows, plus
// ENROLLMENT_CREATED from memberEventLogService.
async function collectPlanChanges(pool, memberId, windowStart, windowEnd) {
    if (!memberId || !windowStart) return [];
    // EventDetails arrives with the 2026-05-20 migration; query defensively.
    const buildQuery = (withDetails) => `
        SELECT el.EventId, el.EventType, el.CreatedDate,
               el.OldGroupName, el.NewGroupName${withDetails ? ', el.EventDetails' : ''},
               u.FirstName, u.LastName
        FROM oe.MemberEventLog el
        LEFT JOIN oe.Users u ON u.UserId = el.CreatedBy
        WHERE el.MemberId = @memberId
          AND el.CreatedDate >= @start AND el.CreatedDate <= @end
    `;
    const run = (withDetails) => pool.request()
        .input('memberId', sql.UniqueIdentifier, memberId)
        .input('start', sql.DateTime2, windowStart)
        .input('end', sql.DateTime2, windowEnd)
        .query(buildQuery(withDetails));
    let rows;
    try {
        rows = (await run(true)).recordset;
    } catch (e) {
        rows = (await run(false)).recordset;
    }
    const out = [];
    for (const row of rows) {
        const detail = row.EventDetails
            || ((row.OldGroupName || row.NewGroupName)
                ? `${row.OldGroupName || '—'} → ${row.NewGroupName || '—'}`
                : null);
        pushEvent(out, {
            id: `member-event-${row.EventId}`,
            category: 'plan',
            occurredAt: row.CreatedDate,
            actorName: personName(row, '_none'),
            title: PLAN_EVENT_TITLE[row.EventType] || 'Plan / membership change',
            detail,
            before: row.EventType === 'GROUP_CHANGED' ? row.OldGroupName : null,
            after: row.EventType === 'GROUP_CHANGED' ? row.NewGroupName : null,
        });
    }
    return out;
}

// Outreach (email/SMS) sent in the context of this case/share request.
// MessageHistory.CaseId / ShareRequestId arrive with the 2026-05-20 migration;
// until a sender stamps them this yields nothing. `linkColumn` is a literal.
async function collectOutreach(pool, linkColumn, entityId) {
    let rows;
    try {
        const r = await pool.request()
            .input('id', sql.UniqueIdentifier, entityId)
            .query(`
                SELECT HistoryId, MessageType, RecipientAddress, Subject, Status, SentDate
                FROM oe.MessageHistory
                WHERE ${linkColumn} = @id
            `);
        rows = r.recordset;
    } catch (e) {
        return []; // CaseId / ShareRequestId columns not present yet
    }
    const out = [];
    for (const row of rows) {
        pushEvent(out, {
            id: `msg-${row.HistoryId}`,
            category: 'communication',
            occurredAt: row.SentDate,
            actorName: null,
            title: `${row.MessageType || 'Message'} sent${row.Subject ? `: ${row.Subject}` : ''}`,
            detail: row.RecipientAddress ? `To ${row.RecipientAddress}` : null,
            meta: metaPairs([
                ['To', row.RecipientAddress],
                ['Status', row.Status],
            ]),
        });
    }
    return out;
}

// Internal notes left on an email thread linked to this Case / Share Request —
// surfaces inbox-side status (e.g. "sent ACH form, handled") in the entity history,
// so teammates working the case/SR see it without opening the inbox. linkColumn is
// a hardcoded literal ('CaseId' | 'ShareRequestId').
async function collectEmailThreadNotes(pool, linkColumn, entityId) {
    const r = await pool.request()
        .input('id', sql.UniqueIdentifier, entityId)
        .query(`
            SELECT n.NoteId, n.Note, n.CreatedDate, n.CreatedByName, t.Subject
            FROM oe.EmailThreadNotes n
            JOIN oe.EmailThreads t ON t.ThreadId = n.ThreadId
            WHERE t.${linkColumn} = @id
        `);
    const out = [];
    for (const row of r.recordset) {
        pushEvent(out, {
            id: `email-note-${row.NoteId}`,
            category: 'note',
            occurredAt: row.CreatedDate,
            actorName: row.CreatedByName || null,
            title: 'Internal note (email)',
            detail: row.Note || null,
            meta: metaPairs([['Email thread', row.Subject]]),
            ref: { kind: 'email-note', id: String(row.NoteId) },
        });
    }
    return out;
}

// ---------------------------------------------------------------------------
// Case timeline
// ---------------------------------------------------------------------------

async function collectCaseNotes(pool, caseId) {
    const r = await pool.request()
        .input('id', sql.UniqueIdentifier, caseId)
        .query(`
            SELECT n.NoteId, n.NoteType, n.Note, n.PreviousValue, n.NewValue,
                   n.CreatedDate, n.CreatedByName, u.FirstName, u.LastName
            FROM oe.CaseNotes n
            LEFT JOIN oe.Users u ON u.UserId = n.CreatedBy
            WHERE n.CaseId = @id
        `);
    const out = [];
    for (const row of r.recordset) {
        // collectCreation emits the creation event with its source label;
        // skip the redundant 'created' audit note.
        if (row.NoteType === 'created') continue;
        const category = CASE_NOTE_CATEGORY[row.NoteType] || 'system';
        const isUserNote = row.NoteType === 'user_note';
        pushEvent(out, {
            id: `note-${row.NoteId}`,
            category,
            occurredAt: row.CreatedDate,
            actorName: personName(row),
            title: isUserNote ? 'Note added' : (row.Note || 'Activity'),
            detail: isUserNote ? row.Note : null,
            before: row.PreviousValue,
            after: row.NewValue,
        });
    }
    return out;
}

async function collectCaseDocuments(pool, caseId) {
    const r = await pool.request()
        .input('id', sql.UniqueIdentifier, caseId)
        .query(`
            SELECT d.DocumentId, d.DocumentName, d.FileName, d.DocumentType,
                   d.FileSize, d.MimeType, d.Description, d.CreatedDate,
                   d.UploadedBy, u.FirstName, u.LastName
            FROM oe.CaseDocuments d
            LEFT JOIN oe.Users u ON u.UserId = d.CreatedBy
            WHERE d.CaseId = @id AND d.IsActive = 1
        `);
    const out = [];
    for (const row of r.recordset) {
        pushEvent(out, {
            id: `doc-${row.DocumentId}`,
            category: 'document',
            occurredAt: row.CreatedDate,
            actorName: personName(row, '_none') || row.UploadedBy || null,
            title: `Document added: ${row.DocumentName || row.FileName || 'file'}`,
            meta: metaPairs([
                ['File', row.FileName],
                ['Type', row.DocumentType || row.MimeType],
                ['Size', fmtSize(row.FileSize)],
                ['Description', row.Description],
            ]),
        });
    }
    return out;
}

async function collectCaseProviders(pool, caseId) {
    const r = await pool.request()
        .input('id', sql.UniqueIdentifier, caseId)
        .query(`
            SELECT cp.CaseProviderId, cp.ProviderRole, cp.Notes, cp.CreatedDate,
                   p.ProviderName, p.NPI, p.Phone, u.FirstName, u.LastName
            FROM oe.CaseProviders cp
            LEFT JOIN oe.Providers p ON p.ProviderId = cp.ProviderId
            LEFT JOIN oe.Users u ON u.UserId = cp.CreatedBy
            WHERE cp.CaseId = @id
        `);
    const out = [];
    for (const row of r.recordset) {
        pushEvent(out, {
            id: `prov-${row.CaseProviderId}`,
            category: 'provider',
            occurredAt: row.CreatedDate,
            actorName: personName(row, '_none'),
            title: `Provider linked: ${row.ProviderName || 'provider'}`,
            detail: row.ProviderRole || null,
            meta: metaPairs([
                ['Provider', row.ProviderName],
                ['Role', row.ProviderRole],
                ['NPI', row.NPI],
                ['Phone', row.Phone],
                ['Notes', row.Notes],
            ]),
        });
    }
    return out;
}

async function getCaseTimeline(caseId, vendorId) {
    const pool = await getPool();
    const owns = await pool.request()
        .input('id', sql.UniqueIdentifier, caseId)
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .query(`SELECT CaseId, MemberId, CreatedDate, CompletedDate
                FROM oe.Cases WHERE CaseId = @id AND VendorId = @vendorId`);
    if (!owns.recordset.length) {
        const err = new Error('Ticket not found');
        err.statusCode = 404;
        throw err;
    }
    const { MemberId, CreatedDate, CompletedDate } = owns.recordset[0];
    const windowEnd = CompletedDate || new Date();

    const groups = await Promise.all([
        safe('case-creation', () => collectCreation(pool, 'Cases', 'CaseId', caseId, 'Ticket')),
        safe('case-notes', () => collectCaseNotes(pool, caseId)),
        safe('case-documents', () => collectCaseDocuments(pool, caseId)),
        safe('case-providers', () => collectCaseProviders(pool, caseId)),
        safe('case-encounters', () => collectEncounters(pool, 'CaseId', caseId)),
        safe('case-email-notes', () => collectEmailThreadNotes(pool, 'CaseId', caseId)),
        safe('case-form-submissions', () => collectFormSubmissions(pool, 'CaseId', caseId)),
        safe('case-form-invitations', () => collectFormInvitations(pool, 'LinkedCaseId', caseId)),
        safe('case-plan-changes', () => collectPlanChanges(pool, MemberId, CreatedDate, windowEnd)),
        safe('case-outreach', () => collectOutreach(pool, 'CaseId', caseId)),
    ]);
    return mergeSort(groups);
}

// ---------------------------------------------------------------------------
// Share Request timeline
// ---------------------------------------------------------------------------

async function collectShareRequestStatusHistory(pool, shareRequestId) {
    const r = await pool.request()
        .input('id', sql.UniqueIdentifier, shareRequestId)
        .query(`
            SELECT sh.StatusHistoryId, sh.PreviousStatus, sh.NewStatus,
                   sh.PreviousDetermination, sh.NewDetermination, sh.Reason,
                   sh.CreatedDate, u.FirstName, u.LastName
            FROM oe.ShareRequestStatusHistory sh
            LEFT JOIN oe.Users u ON u.UserId = sh.CreatedBy
            WHERE sh.ShareRequestId = @id
        `);
    const out = [];
    for (const row of r.recordset) {
        const statusChanged = row.PreviousStatus !== row.NewStatus;
        const detChanged = row.PreviousDetermination !== row.NewDetermination;
        const detail = [];
        if (detChanged) {
            detail.push(row.PreviousDetermination
                ? `Determination: ${row.PreviousDetermination} → ${row.NewDetermination}`
                : `Determination set to ${row.NewDetermination}`);
        }
        if (row.Reason) detail.push(row.Reason);
        pushEvent(out, {
            id: `status-${row.StatusHistoryId}`,
            category: 'status',
            occurredAt: row.CreatedDate,
            actorName: personName(row, '_none'),
            title: statusChanged ? 'Status updated' : 'Determination updated',
            detail: detail.join(' · ') || null,
            before: statusChanged ? row.PreviousStatus : null,
            after: statusChanged ? row.NewStatus : null,
        });
    }
    return out;
}

async function collectShareRequestNotes(pool, shareRequestId) {
    const r = await pool.request()
        .input('id', sql.UniqueIdentifier, shareRequestId)
        .query(`
            SELECT n.NoteId, n.NoteType, n.Note, n.PreviousValue, n.NewValue,
                   n.CreatedDate, n.CreatedByName, u.FirstName, u.LastName
            FROM oe.ShareRequestNotes n
            LEFT JOIN oe.Users u ON u.UserId = n.CreatedBy
            WHERE n.ShareRequestId = @id
        `);
    const out = [];
    for (const row of r.recordset) {
        // collectCreation emits the creation event; skip the redundant note.
        if (row.NoteType === 'SystemActivity' && row.Note === 'Share request created') continue;
        let category = SR_NOTE_CATEGORY[row.NoteType] || 'system';
        // Finance activity (bills / ledger transactions) is logged as
        // SystemActivity; surface it under its own "Finances" category instead of
        // the generic "System" bucket. Detected by note-text prefix so existing
        // history reclassifies too (no schema change).
        if (category === 'system' && /^(Bill|Transaction)\b/.test(row.Note || '')) {
            category = 'finance';
        }
        const isUserNote = row.NoteType === 'Note';
        pushEvent(out, {
            id: `note-${row.NoteId}`,
            category,
            occurredAt: row.CreatedDate,
            actorName: personName(row),
            title: isUserNote ? 'Note added' : (row.Note || 'Activity'),
            detail: isUserNote ? row.Note : null,
            before: row.PreviousValue,
            after: row.NewValue,
        });
    }
    return out;
}

async function getShareRequestTimeline(shareRequestId, vendorId) {
    const pool = await getPool();
    const owns = await pool.request()
        .input('id', sql.UniqueIdentifier, shareRequestId)
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .query(`SELECT ShareRequestId, MemberId, CreatedDate, CompletedDate
                FROM oe.ShareRequests WHERE ShareRequestId = @id AND VendorId = @vendorId`);
    if (!owns.recordset.length) {
        const err = new Error('Share request not found');
        err.statusCode = 404;
        throw err;
    }
    const { MemberId, CreatedDate, CompletedDate } = owns.recordset[0];
    const windowEnd = CompletedDate || new Date();

    const groups = await Promise.all([
        safe('sr-creation', () => collectCreation(pool, 'ShareRequests', 'ShareRequestId', shareRequestId, 'Share request')),
        safe('sr-status-history', () => collectShareRequestStatusHistory(pool, shareRequestId)),
        safe('sr-notes', () => collectShareRequestNotes(pool, shareRequestId)),
        // Email now flows through encounters (Channel='email'); see sr-encounters below.
        // The old oe.ShareRequestEmails collector was retired with the Back Office inbox.
        safe('sr-encounters', () => collectEncounters(pool, 'ShareRequestId', shareRequestId)),
        safe('sr-email-notes', () => collectEmailThreadNotes(pool, 'ShareRequestId', shareRequestId)),
        safe('sr-form-submissions', () => collectFormSubmissions(pool, 'ShareRequestId', shareRequestId)),
        safe('sr-form-invitations', () => collectFormInvitations(pool, 'LinkedShareRequestId', shareRequestId)),
        safe('sr-plan-changes', () => collectPlanChanges(pool, MemberId, CreatedDate, windowEnd)),
        safe('sr-outreach', () => collectOutreach(pool, 'ShareRequestId', shareRequestId)),
    ]);
    return mergeSort(groups);
}

/**
 * Build the unified history timeline for a Case or Share Request.
 *
 * @param {'case'|'share-request'} entityType
 * @param {string} entityId
 * @param {string} vendorId  — caller's vendor; enforces ownership
 * @returns {Promise<TimelineEvent[]>} newest first
 */
async function getTimeline(entityType, entityId, vendorId) {
    if (entityType === 'case') return getCaseTimeline(entityId, vendorId);
    if (entityType === 'share-request') return getShareRequestTimeline(entityId, vendorId);
    const err = new Error(`Unknown entity type: ${entityType}`);
    err.statusCode = 400;
    throw err;
}

module.exports = { getTimeline };
