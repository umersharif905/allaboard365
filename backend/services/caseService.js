// services/caseService.js
// Cases — back-office, vendor-scoped. See sql-changes/2026-05-14-cases-tables.sql
// for the base schema and sql-changes/2026-05-19-support-ticket-taxonomy.sql
// for the vendor-customizable type/subcategory tables.

const { getPool, sql } = require('../config/database');
const TaxonomyService = require('./caseTaxonomyService');
// NOTE: caseForwardingService is require()'d lazily inside the functions that
// use it (not at top level). caseForwardingService also requires this module,
// so a top-level require here creates a circular dependency: if
// caseForwardingService loads first, this module would capture its *partial*
// (not-yet-populated) exports and `resolveTargetsForCases` would be undefined
// at call time. Requiring at call time always sees the fully-initialised module.

const CASE_STATUSES = [
    'Open',
    'In Progress',
    'Pending',
    'Closed'
];

const isValidStatus = (s) => typeof s === 'string' && CASE_STATUSES.includes(s);

// Type/subcategory validation now lives in caseTaxonomyService,
// querying the vendor-scoped lookup tables (oe.CaseTypes /
// oe.CaseSubcategories). Keep the export name for callers; just
// delegate.
const validateTicketTypeAndSubcategory = (vendorId, caseType, caseSubcategory) =>
    TaxonomyService.validateTicketTypeAndSubcategory(vendorId, caseType, caseSubcategory);

async function generateCaseNumber(pool, vendorId) {
    const year = new Date().getUTCFullYear();
    const prefix = `CASE-${year}-`;
    const r = await pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .input('prefix', sql.NVarChar, `${prefix}%`)
        .query(`
            SELECT COUNT(*) AS Count
            FROM oe.Cases
            WHERE VendorId = @vendorId AND CaseNumber LIKE @prefix
        `);
    const next = (r.recordset[0]?.Count || 0) + 1;
    return `${prefix}${String(next).padStart(4, '0')}`;
}

async function logEvent(pool, { caseId, noteType, message, previousValue, newValue, userId, userName }) {
    await pool.request()
        .input('caseId', sql.UniqueIdentifier, caseId)
        .input('noteType', sql.NVarChar, noteType)
        .input('note', sql.NVarChar, message)
        .input('previousValue', sql.NVarChar, previousValue ?? null)
        .input('newValue', sql.NVarChar, newValue ?? null)
        .input('createdBy', sql.UniqueIdentifier, userId ?? null)
        .input('createdByName', sql.NVarChar, userName ?? null)
        .query(`
            INSERT INTO oe.CaseNotes (CaseId, NoteType, Note, IsInternal, PreviousValue, NewValue, CreatedBy, CreatedByName)
            VALUES (@caseId, @noteType, @note, 1, @previousValue, @newValue, @createdBy, @createdByName)
        `);
}

async function getDashboardStats(vendorId) {
    const pool = await getPool();
    const r = await pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .query(`
            SELECT
                COUNT(*) AS Total,
                SUM(CASE WHEN ClaimedByUserId IS NULL THEN 1 ELSE 0 END) AS Unclaimed,
                SUM(CASE WHEN ClaimedByUserId IS NOT NULL THEN 1 ELSE 0 END) AS Claimed,
                SUM(CASE WHEN Status = 'Open' THEN 1 ELSE 0 END) AS OpenCount,
                SUM(CASE WHEN Status = 'In Progress' THEN 1 ELSE 0 END) AS InProgress,
                SUM(CASE WHEN Status = 'Pending' THEN 1 ELSE 0 END) AS Pending,
                SUM(CASE WHEN Status = 'Closed' THEN 1 ELSE 0 END) AS Closed
            FROM oe.Cases
            WHERE VendorId = @vendorId
        `);
    return r.recordset[0];
}

async function listCases(vendorId, opts = {}) {
    const pool = await getPool();
    const page = Math.max(1, parseInt(opts.page || 1, 10));
    const limit = Math.min(100, Math.max(1, parseInt(opts.limit || 25, 10)));
    const offset = (page - 1) * limit;

    const where = ['t.VendorId = @vendorId'];
    const req = pool.request().input('vendorId', sql.UniqueIdentifier, vendorId);

    if (opts.status && isValidStatus(opts.status)) {
        where.push('t.Status = @status');
        req.input('status', sql.NVarChar, opts.status);
    }
    if (opts.caseType) {
        // Filter is a free-form code now (vendors define their own); validation
        // happens on create/update, not on read filters.
        where.push('t.CaseType = @caseType');
        req.input('caseType', sql.NVarChar, opts.caseType);
    }
    if (opts.caseSubcategory) {
        where.push('t.CaseSubcategory = @caseSubcategory');
        req.input('caseSubcategory', sql.NVarChar, opts.caseSubcategory);
    }
    if (opts.claimed === 'true' || opts.claimed === true) {
        where.push('t.ClaimedByUserId IS NOT NULL');
    } else if (opts.claimed === 'false' || opts.claimed === false) {
        where.push('t.ClaimedByUserId IS NULL');
    }
    if (opts.claimedByUserId) {
        where.push('t.ClaimedByUserId = @claimedByUserId');
        req.input('claimedByUserId', sql.UniqueIdentifier, opts.claimedByUserId);
    }
    if (opts.memberId) {
        where.push('t.MemberId = @memberId');
        req.input('memberId', sql.UniqueIdentifier, opts.memberId);
    }
    if (opts.q && opts.q.trim()) {
        where.push(`(t.CaseNumber LIKE @q OR t.Title LIKE @q OR mu.FirstName LIKE @q OR mu.LastName LIKE @q)`);
        req.input('q', sql.NVarChar, `%${opts.q.trim()}%`);
    }

    const whereClause = where.join(' AND ');
    req.input('offset', sql.Int, offset);
    req.input('limit', sql.Int, limit);

    const result = await req.query(`
        SELECT
            t.CaseId, t.CaseNumber, t.VendorId, t.MemberId, t.Status,
            t.CaseType, t.CaseSubcategory, t.SubcategoryDetail,
            t.Title, t.Description, t.NeedsMemberMatch,
            t.SubmittedDate, t.CompletedDate, t.ClaimedByUserId, t.ClaimedAt,
            t.CreatedDate, t.ModifiedDate,
            mu.FirstName AS MemberFirstName, mu.LastName AS MemberLastName, mu.Email AS MemberEmail,
            cu.FirstName AS ClaimedByFirstName, cu.LastName AS ClaimedByLastName,
            cu.PreferredColor AS ClaimedByColor
        FROM oe.Cases t
        LEFT JOIN oe.Members m ON m.MemberId = t.MemberId
        LEFT JOIN oe.Users mu ON mu.UserId = m.UserId
        LEFT JOIN oe.Users cu ON cu.UserId = t.ClaimedByUserId
        WHERE ${whereClause}
        ORDER BY t.SubmittedDate DESC
        OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;

        SELECT COUNT(*) AS Total
        FROM oe.Cases t
        LEFT JOIN oe.Members m ON m.MemberId = t.MemberId
        LEFT JOIN oe.Users mu ON mu.UserId = m.UserId
        WHERE ${whereClause};
    `);

    const data = result.recordsets[0];
    const total = result.recordsets[1][0]?.Total || 0;

    // Attach TPA forwarding target (if any) for reimbursement cases on this page.
    // Lazy require — see the circular-dependency note at the top of this file.
    const CaseForwardingService = require('./caseForwardingService');
    const targets = await CaseForwardingService.resolveTargetsForCases(
        vendorId,
        data.map((row) => row.CaseId)
    );
    for (const row of data) {
        row.ForwardingTarget = targets[row.CaseId] || null;
    }

    return {
        data,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
    };
}

async function getCaseById(vendorId, caseId) {
    const pool = await getPool();
    const r = await pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .input('caseId', sql.UniqueIdentifier, caseId)
        .query(`
            SELECT
                t.*,
                mu.FirstName AS MemberFirstName, mu.LastName AS MemberLastName,
                mu.Email AS MemberEmail, mu.PhoneNumber AS MemberPhone,
                m.DateOfBirth AS MemberDOB, m.GroupId AS MemberGroupId,
                m.HouseholdMemberID AS MemberNumber,
                u.FirstName AS ClaimedByFirstName, u.LastName AS ClaimedByLastName,
                u.PreferredColor AS ClaimedByColor,
                cb.FirstName AS CreatedByFirstName, cb.LastName AS CreatedByLastName
            FROM oe.Cases t
            LEFT JOIN oe.Members m ON m.MemberId = t.MemberId
            LEFT JOIN oe.Users mu ON mu.UserId = m.UserId
            LEFT JOIN oe.Users u ON u.UserId = t.ClaimedByUserId
            LEFT JOIN oe.Users cb ON cb.UserId = t.CreatedBy
            WHERE t.CaseId = @caseId AND t.VendorId = @vendorId
        `);
    const row = r.recordset[0] || null;
    if (row) {
        // Attach the TPA forwarding target (if any) so the detail header can
        // show the "Generate Email Report" button without an extra round-trip.
        // Lazy require — see the circular-dependency note at the top of this file.
        const CaseForwardingService = require('./caseForwardingService');
        const targets = await CaseForwardingService.resolveTargetsForCases(vendorId, [row.CaseId]);
        row.ForwardingTarget = targets[row.CaseId] || null;
    }
    return row;
}

/**
 * Public-form submissions that created/are linked to this case. A case can be
 * referenced via CaseId (manually linked) or LinkedCaseId (auto-spawned on
 * submit), so we match on COALESCE of both. Vendor-scoped via the case.
 */
async function listFormSubmissions(vendorId, caseId) {
    const pool = await getPool();
    const r = await pool.request()
        .input('caseId', sql.UniqueIdentifier, caseId)
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .query(`
            SELECT
                s.SubmissionId, s.FormTemplateId, s.MemberMatchStatus, s.MemberId, s.CreatedDate,
                t.Title AS FormTitle, t.FormKind
            FROM oe.PublicFormSubmissions s
            INNER JOIN oe.PublicFormTemplates t ON t.FormTemplateId = s.FormTemplateId
            INNER JOIN oe.Cases c ON c.CaseId = COALESCE(s.CaseId, s.LinkedCaseId)
            WHERE COALESCE(s.CaseId, s.LinkedCaseId) = @caseId
              AND c.VendorId = @vendorId
            ORDER BY s.CreatedDate DESC
        `);
    return r.recordset;
}

async function createCase(vendorId, { memberId, title, description, status, caseType, caseSubcategory, subcategoryDetail, userId, userName, createdVia = 'vendor', needsMemberMatch = false }) {
    // memberId may be NULL only for an "unmatched" shell case from a public-form
    // submission the resolver couldn't match (needsMemberMatch). Every other caller
    // passes a real member.
    if (!memberId && !needsMemberMatch) throw new Error('memberId is required');

    const finalType = caseType || 'reimbursement';
    await validateTicketTypeAndSubcategory(vendorId, finalType, caseSubcategory);

    const pool = await getPool();

    let householdId = null;
    if (memberId) {
        const memberRow = await pool.request()
            .input('memberId', sql.UniqueIdentifier, memberId)
            .query('SELECT MemberId, HouseholdId FROM oe.Members WHERE MemberId = @memberId');
        if (memberRow.recordset.length === 0) {
            const err = new Error('Member not found');
            err.statusCode = 404;
            throw err;
        }
        householdId = memberRow.recordset[0].HouseholdId || null;
    }

    const finalStatus = isValidStatus(status) ? status : 'Open';

    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
        const caseNumber = await generateCaseNumber(pool, vendorId);
        try {
            const r = await pool.request()
                .input('vendorId', sql.UniqueIdentifier, vendorId)
                .input('caseNumber', sql.NVarChar, caseNumber)
                .input('memberId', sql.UniqueIdentifier, memberId)
                .input('householdId', sql.UniqueIdentifier, householdId)
                .input('status', sql.NVarChar, finalStatus)
                .input('caseType', sql.NVarChar, finalType)
                .input('caseSubcategory', sql.NVarChar, caseSubcategory || null)
                .input('subcategoryDetail', sql.NVarChar, subcategoryDetail || null)
                .input('title', sql.NVarChar, title || null)
                .input('description', sql.NVarChar, description || null)
                .input('createdBy', sql.UniqueIdentifier, userId || null)
                .input('needsMemberMatch', sql.Bit, needsMemberMatch ? 1 : 0)
                .query(`
                    INSERT INTO oe.Cases
                        (VendorId, CaseNumber, MemberId, HouseholdId, Status,
                         CaseType, CaseSubcategory, SubcategoryDetail,
                         Title, Description, CreatedBy, NeedsMemberMatch)
                    OUTPUT INSERTED.CaseId
                    VALUES (@vendorId, @caseNumber, @memberId, @householdId, @status,
                            @caseType, @caseSubcategory, @subcategoryDetail,
                            @title, @description, @createdBy, @needsMemberMatch);
                `);
            const caseId = r.recordset[0].CaseId;
            // CreatedVia ('form'|'vendor'|'encounter') arrives with the
            // 2026-05-20 history-timeline migration; tolerate its absence so
            // case creation never breaks before the column exists.
            try {
                await pool.request()
                    .input('caseId', sql.UniqueIdentifier, caseId)
                    .input('createdVia', sql.NVarChar, createdVia)
                    .query('UPDATE oe.Cases SET CreatedVia = @createdVia WHERE CaseId = @caseId');
            } catch (e) {
                console.warn('[caseService] CreatedVia not set (column missing until migration):', e.message);
            }
            await logEvent(pool, {
                caseId,
                noteType: 'created',
                message: `Ticket ${caseNumber} created.`,
                newValue: caseNumber,
                userId,
                userName
            });
            return await getCaseById(vendorId, caseId);
        } catch (e) {
            lastErr = e;
            if (e.number === 2627 || e.number === 2601) {
                continue;
            }
            throw e;
        }
    }
    throw lastErr;
}

async function updateCase(vendorId, caseId, { title, description, caseType, caseSubcategory, subcategoryDetail, userId, userName }) {
    const pool = await getPool();
    const before = await getCaseById(vendorId, caseId);
    if (!before) {
        const err = new Error('Ticket not found');
        err.statusCode = 404;
        throw err;
    }

    if (caseType !== undefined || caseSubcategory !== undefined) {
        const finalType = caseType !== undefined ? caseType : before.CaseType;
        const finalSub  = caseSubcategory !== undefined ? caseSubcategory : before.CaseSubcategory;
        await validateTicketTypeAndSubcategory(vendorId, finalType, finalSub);
    }

    const sets = ['ModifiedDate = SYSUTCDATETIME()', 'ModifiedBy = @userId'];
    const req = pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .input('caseId', sql.UniqueIdentifier, caseId)
        .input('userId', sql.UniqueIdentifier, userId || null);
    if (title !== undefined) {
        sets.push('Title = @title');
        req.input('title', sql.NVarChar, title);
    }
    if (description !== undefined) {
        sets.push('Description = @description');
        req.input('description', sql.NVarChar, description);
    }
    if (caseType !== undefined) {
        sets.push('CaseType = @caseType');
        req.input('caseType', sql.NVarChar, caseType);
    }
    if (caseSubcategory !== undefined) {
        sets.push('CaseSubcategory = @caseSubcategory');
        req.input('caseSubcategory', sql.NVarChar, caseSubcategory || null);
    }
    if (subcategoryDetail !== undefined) {
        sets.push('SubcategoryDetail = @subcategoryDetail');
        req.input('subcategoryDetail', sql.NVarChar, subcategoryDetail || null);
    }
    const r = await req.query(`
        UPDATE oe.Cases SET ${sets.join(', ')}
        WHERE CaseId = @caseId AND VendorId = @vendorId;
        SELECT @@ROWCOUNT AS Rows;
    `);
    if (r.recordset[0].Rows === 0) {
        const err = new Error('Ticket not found');
        err.statusCode = 404;
        throw err;
    }
    await logEvent(pool, {
        caseId,
        noteType: 'updated',
        message: `Ticket fields updated.`,
        userId,
        userName
    });
    return await getCaseById(vendorId, caseId);
}

async function updateStatus(vendorId, caseId, { status, userId, userName }) {
    if (!isValidStatus(status)) {
        const err = new Error('Invalid status');
        err.statusCode = 400;
        throw err;
    }
    const pool = await getPool();
    const before = await getCaseById(vendorId, caseId);
    if (!before) {
        const err = new Error('Ticket not found');
        err.statusCode = 404;
        throw err;
    }
    if (before.Status === status) {
        return before;
    }
    const completedClause = status === 'Closed' ? ', CompletedDate = SYSUTCDATETIME()' : '';
    await pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .input('caseId', sql.UniqueIdentifier, caseId)
        .input('status', sql.NVarChar, status)
        .input('userId', sql.UniqueIdentifier, userId || null)
        .query(`
            UPDATE oe.Cases
            SET Status = @status, ModifiedDate = SYSUTCDATETIME(), ModifiedBy = @userId${completedClause}
            WHERE CaseId = @caseId AND VendorId = @vendorId
        `);
    await logEvent(pool, {
        caseId,
        noteType: 'status_change',
        message: `Status changed from "${before.Status}" to "${status}".`,
        previousValue: before.Status,
        newValue: status,
        userId,
        userName
    });
    return await getCaseById(vendorId, caseId);
}

async function claimCase(vendorId, caseId, { userId, userName }) {
    const pool = await getPool();
    const before = await getCaseById(vendorId, caseId);
    if (!before) {
        const err = new Error('Ticket not found');
        err.statusCode = 404;
        throw err;
    }
    if (before.ClaimedByUserId && String(before.ClaimedByUserId).toLowerCase() !== String(userId).toLowerCase()) {
        const err = new Error('Ticket is already assigned to another user');
        err.statusCode = 409;
        err.code = 'ALREADY_CLAIMED';
        throw err;
    }
    if (before.ClaimedByUserId) {
        return before;
    }
    await pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .input('caseId', sql.UniqueIdentifier, caseId)
        .input('userId', sql.UniqueIdentifier, userId)
        .query(`
            UPDATE oe.Cases
            SET ClaimedByUserId = @userId, ClaimedAt = SYSUTCDATETIME(),
                ModifiedDate = SYSUTCDATETIME(), ModifiedBy = @userId
            WHERE CaseId = @caseId AND VendorId = @vendorId
        `);
    await logEvent(pool, {
        caseId,
        noteType: 'claimed',
        message: `Assigned to ${userName || userId}.`,
        newValue: userName || userId,
        userId,
        userName
    });
    return await getCaseById(vendorId, caseId);
}

async function unclaimCase(vendorId, caseId, { userId, userName }) {
    const pool = await getPool();
    const before = await getCaseById(vendorId, caseId);
    if (!before) {
        const err = new Error('Ticket not found');
        err.statusCode = 404;
        throw err;
    }
    if (!before.ClaimedByUserId) {
        return before;
    }
    await pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .input('caseId', sql.UniqueIdentifier, caseId)
        .input('userId', sql.UniqueIdentifier, userId || null)
        .query(`
            UPDATE oe.Cases
            SET ClaimedByUserId = NULL, ClaimedAt = NULL,
                ModifiedDate = SYSUTCDATETIME(), ModifiedBy = @userId
            WHERE CaseId = @caseId AND VendorId = @vendorId
        `);
    await logEvent(pool, {
        caseId,
        noteType: 'unclaimed',
        message: `Unassigned.`,
        previousValue: `${before.ClaimedByFirstName || ''} ${before.ClaimedByLastName || ''}`.trim() || String(before.ClaimedByUserId),
        userId,
        userName
    });
    return await getCaseById(vendorId, caseId);
}

async function reassignCase(vendorId, caseId, { newUserId, userId, userName }) {
    const pool = await getPool();
    const before = await getCaseById(vendorId, caseId);
    if (!before) {
        const err = new Error('Ticket not found');
        err.statusCode = 404;
        throw err;
    }
    await pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .input('caseId', sql.UniqueIdentifier, caseId)
        .input('newUserId', sql.UniqueIdentifier, newUserId)
        .input('userId', sql.UniqueIdentifier, userId || null)
        .query(`
            UPDATE oe.Cases
            SET ClaimedByUserId = @newUserId, ClaimedAt = SYSUTCDATETIME(),
                ModifiedDate = SYSUTCDATETIME(), ModifiedBy = @userId
            WHERE CaseId = @caseId AND VendorId = @vendorId
        `);
    await logEvent(pool, {
        caseId,
        noteType: 'reassigned',
        message: `Reassigned to user ${newUserId}.`,
        previousValue: before.ClaimedByUserId ? String(before.ClaimedByUserId) : null,
        newValue: String(newUserId),
        userId,
        userName
    });
    return await getCaseById(vendorId, caseId);
}

async function getClaimers(vendorId, currentUserId) {
    const pool = await getPool();
    const r = await pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .query(`
            SELECT
                u.UserId, u.FirstName, u.LastName, u.Email, r.Name AS RoleName,
                (SELECT COUNT(*) FROM oe.Cases t
                  WHERE t.VendorId = @vendorId AND t.ClaimedByUserId = u.UserId) AS ClaimedCount
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
        claimedCount: row.ClaimedCount
    }));
    rows.sort((a, b) => {
        if (a.userId === currentUserId && b.userId !== currentUserId) return -1;
        if (b.userId === currentUserId && a.userId !== currentUserId) return 1;
        if (b.claimedCount !== a.claimedCount) return b.claimedCount - a.claimedCount;
        const lc = (a.lastName || '').localeCompare(b.lastName || '');
        if (lc !== 0) return lc;
        return (a.firstName || '').localeCompare(b.firstName || '');
    });
    return rows;
}

async function listNotes(vendorId, caseId, { includeAuditEvents = false } = {}) {
    const pool = await getPool();
    const owns = await getCaseById(vendorId, caseId);
    if (!owns) {
        const err = new Error('Ticket not found');
        err.statusCode = 404;
        throw err;
    }
    const filter = includeAuditEvents ? '' : `AND NoteType = 'user_note'`;
    const r = await pool.request()
        .input('caseId', sql.UniqueIdentifier, caseId)
        .query(`
            SELECT NoteId, NoteType, Note, IsInternal, PreviousValue, NewValue,
                   CreatedDate, CreatedBy, CreatedByName
            FROM oe.CaseNotes
            WHERE CaseId = @caseId ${filter}
            ORDER BY CreatedDate DESC
        `);
    return r.recordset;
}

async function addNote(vendorId, caseId, { note, isInternal = true, userId, userName }) {
    if (!note || !String(note).trim()) {
        const err = new Error('Note text is required');
        err.statusCode = 400;
        throw err;
    }
    const pool = await getPool();
    const owns = await getCaseById(vendorId, caseId);
    if (!owns) {
        const err = new Error('Ticket not found');
        err.statusCode = 404;
        throw err;
    }
    const r = await pool.request()
        .input('caseId', sql.UniqueIdentifier, caseId)
        .input('note', sql.NVarChar, String(note).trim())
        .input('isInternal', sql.Bit, isInternal ? 1 : 0)
        .input('createdBy', sql.UniqueIdentifier, userId || null)
        .input('createdByName', sql.NVarChar, userName || null)
        .query(`
            INSERT INTO oe.CaseNotes (CaseId, NoteType, Note, IsInternal, CreatedBy, CreatedByName)
            OUTPUT INSERTED.NoteId, INSERTED.NoteType, INSERTED.Note, INSERTED.IsInternal,
                   INSERTED.CreatedDate, INSERTED.CreatedBy, INSERTED.CreatedByName
            VALUES (@caseId, 'user_note', @note, @isInternal, @createdBy, @createdByName)
        `);
    return r.recordset[0];
}

async function listProviders(vendorId, caseId) {
    const pool = await getPool();
    const owns = await getCaseById(vendorId, caseId);
    if (!owns) {
        const err = new Error('Ticket not found');
        err.statusCode = 404;
        throw err;
    }
    const r = await pool.request()
        .input('caseId', sql.UniqueIdentifier, caseId)
        .query(`
            SELECT tp.CaseProviderId, tp.CaseId, tp.ProviderId, tp.ProviderRole, tp.Notes,
                   tp.CreatedDate, p.ProviderName, p.NPI, p.Phone, p.Address1, p.City, p.State
            FROM oe.CaseProviders tp
            LEFT JOIN oe.Providers p ON p.ProviderId = tp.ProviderId
            WHERE tp.CaseId = @caseId
            ORDER BY tp.CreatedDate DESC
        `);
    return r.recordset;
}

async function addProvider(vendorId, caseId, { providerId, providerRole, notes, userId }) {
    if (!providerId) {
        const err = new Error('providerId is required');
        err.statusCode = 400;
        throw err;
    }
    const pool = await getPool();
    const owns = await getCaseById(vendorId, caseId);
    if (!owns) {
        const err = new Error('Ticket not found');
        err.statusCode = 404;
        throw err;
    }
    const r = await pool.request()
        .input('caseId', sql.UniqueIdentifier, caseId)
        .input('providerId', sql.UniqueIdentifier, providerId)
        .input('providerRole', sql.NVarChar, providerRole || null)
        .input('notes', sql.NVarChar, notes || null)
        .input('createdBy', sql.UniqueIdentifier, userId || null)
        .query(`
            INSERT INTO oe.CaseProviders (CaseId, ProviderId, ProviderRole, Notes, CreatedBy)
            OUTPUT INSERTED.CaseProviderId
            VALUES (@caseId, @providerId, @providerRole, @notes, @createdBy)
        `);
    return r.recordset[0];
}

async function removeProvider(vendorId, caseId, caseProviderId) {
    const pool = await getPool();
    const owns = await getCaseById(vendorId, caseId);
    if (!owns) {
        const err = new Error('Ticket not found');
        err.statusCode = 404;
        throw err;
    }
    const r = await pool.request()
        .input('caseId', sql.UniqueIdentifier, caseId)
        .input('caseProviderId', sql.UniqueIdentifier, caseProviderId)
        .query(`
            DELETE FROM oe.CaseProviders
            WHERE CaseProviderId = @caseProviderId AND CaseId = @caseId;
            SELECT @@ROWCOUNT AS Rows;
        `);
    return r.recordset[0].Rows > 0;
}

async function listDocuments(vendorId, caseId) {
    const pool = await getPool();
    const owns = await getCaseById(vendorId, caseId);
    if (!owns) {
        const err = new Error('Ticket not found');
        err.statusCode = 404;
        throw err;
    }
    const r = await pool.request()
        .input('caseId', sql.UniqueIdentifier, caseId)
        .query(`
            SELECT DocumentId, CaseId, DocumentName, DocumentType, FileName, FileSize,
                   MimeType, BlobUrl, BlobPath, Description, UploadedBy, IsActive, CreatedDate
            FROM oe.CaseDocuments
            WHERE CaseId = @caseId AND IsActive = 1
            ORDER BY CreatedDate DESC
        `);
    return r.recordset;
}

async function createDocumentRecord(vendorId, caseId, { documentName, documentType, fileName, fileSize, mimeType, blobUrl, blobPath, description, uploadedBy, userId }) {
    const pool = await getPool();
    const owns = await getCaseById(vendorId, caseId);
    if (!owns) {
        const err = new Error('Ticket not found');
        err.statusCode = 404;
        throw err;
    }
    const r = await pool.request()
        .input('caseId', sql.UniqueIdentifier, caseId)
        .input('documentName', sql.NVarChar, documentName || fileName)
        .input('documentType', sql.NVarChar, documentType || null)
        .input('fileName', sql.NVarChar, fileName)
        .input('fileSize', sql.BigInt, fileSize || null)
        .input('mimeType', sql.NVarChar, mimeType || null)
        .input('blobUrl', sql.NVarChar, blobUrl || null)
        .input('blobPath', sql.NVarChar, blobPath || null)
        .input('description', sql.NVarChar, description || null)
        .input('uploadedBy', sql.NVarChar, uploadedBy || null)
        .input('createdBy', sql.UniqueIdentifier, userId || null)
        .query(`
            INSERT INTO oe.CaseDocuments
                (CaseId, DocumentName, DocumentType, FileName, FileSize, MimeType, BlobUrl, BlobPath, Description, UploadedBy, CreatedBy)
            OUTPUT INSERTED.DocumentId
            VALUES (@caseId, @documentName, @documentType, @fileName, @fileSize, @mimeType, @blobUrl, @blobPath, @description, @uploadedBy, @createdBy)
        `);
    return r.recordset[0];
}

async function softDeleteDocument(vendorId, caseId, documentId) {
    const pool = await getPool();
    const owns = await getCaseById(vendorId, caseId);
    if (!owns) {
        const err = new Error('Ticket not found');
        err.statusCode = 404;
        throw err;
    }
    const r = await pool.request()
        .input('caseId', sql.UniqueIdentifier, caseId)
        .input('documentId', sql.UniqueIdentifier, documentId)
        .query(`
            UPDATE oe.CaseDocuments SET IsActive = 0
            WHERE DocumentId = @documentId AND CaseId = @caseId;
            SELECT @@ROWCOUNT AS Rows;
        `);
    return r.recordset[0].Rows > 0;
}

module.exports = {
    CASE_STATUSES,
    isValidStatus,
    validateTicketTypeAndSubcategory,
    getDashboardStats,
    listCases,
    getCaseById,
    listFormSubmissions,
    createCase,
    updateCase,
    updateStatus,
    claimCase,
    unclaimCase,
    reassignCase,
    getClaimers,
    listNotes,
    addNote,
    listProviders,
    addProvider,
    removeProvider,
    listDocuments,
    createDocumentRecord,
    softDeleteDocument
};
