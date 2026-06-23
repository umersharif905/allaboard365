// backend/routes/shared/asa-agreements.factory.js
//
// Signed-ASA agreement router factory. Produces an Express router with the
// "Signed ASAs" endpoints (list, download, send, bulk send) that both the
// vendor-portal (/api/me/vendor/asa-agreements) and the SysAdmin vendor
// detail page (/api/vendors/:id/asa-agreements) can mount. The only
// difference between the two mounts is how the VendorId is resolved per
// request.

const express = require('express');
const sql = require('mssql');
const { getPool } = require('../../config/database');
const { generateAuthenticatedUrl, isBlobUrl } = require('../uploads');
const { sendSignedAsaEmail, sendBatchedSignedAsaForVendorGroup, sendBulkSignedAsaForVendor } = require('../../services/asaSignedTriggerService');

async function loadAgreementForVendor(pool, signedAgreementId, vendorId) {
    const r = await pool.request()
        .input('id', sql.UniqueIdentifier, signedAgreementId)
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .query(`
            SELECT s.SignedAgreementId, s.VendorId, s.SignedDocumentUrl,
                   g.Name AS GroupName, v.VendorName
            FROM oe.SignedASAAgreements s
            INNER JOIN oe.Groups g ON g.GroupId = s.GroupId
            INNER JOIN oe.Vendors v ON v.VendorId = s.VendorId
            WHERE s.SignedAgreementId = @id AND s.VendorId = @vendorId
        `);
    return r.recordset[0] || null;
}

/**
 * @param {{ resolveVendorId: (req) => Promise<string|null> | string|null,
 *          authMiddlewares?: Array<Function> }} opts
 *   - resolveVendorId: async function that returns the VendorId for this request.
 *   - authMiddlewares: extra middleware chain applied before each handler
 *     (e.g. the me/vendor mount passes authorize(['VendorAdmin', ...]), the
 *     admin mount passes authorizeVendorDetail()).
 * @returns {express.Router}
 */
function createAsaAgreementsRouter({ resolveVendorId, authMiddlewares = [] }) {
    const router = express.Router({ mergeParams: true });
    const mw = Array.isArray(authMiddlewares) ? authMiddlewares : [authMiddlewares];

    router.get('/', ...mw, async (req, res) => {
        try {
            const pool = await getPool();
            const vendorId = await resolveVendorId(req);
            if (!vendorId) return res.status(404).json({ success: false, message: 'Vendor not found' });

            const statusFilter = String(req.query.status || 'all').toLowerCase();
            const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
            const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
            const search = (req.query.search || '').toString().trim();
            // active-enrollment filter: 'all' (default) | 'active' | 'inactive'
            // Drives both the SQL filter and a per-row badge in the UI.
            const enrollmentFilter = String(req.query.enrollmentFilter || 'all').toLowerCase();

            // Subquery that resolves to 1 when the group has at least one
            // currently-active enrollment. Reused for SELECT (badge) and WHERE
            // (filter) so both share the same definition the rest of the
            // codebase uses for "active" enrollments.
            const ACTIVE_ENROLLMENTS_SUBQUERY = `(
                CASE WHEN EXISTS (
                    SELECT 1
                    FROM oe.Enrollments e
                    INNER JOIN oe.Members m ON m.MemberId = e.MemberId
                    WHERE m.GroupId = s.GroupId
                      AND e.Status = N'Active'
                      AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
                ) THEN 1 ELSE 0 END
            )`;

            const whereParts = [`s.VendorId = @vendorId`, `s.Status = N'Completed'`];
            if (statusFilter === 'unsent') whereParts.push(`s.LastEmailedDate IS NULL`);
            else if (statusFilter === 'sent') whereParts.push(`s.LastEmailedDate IS NOT NULL`);
            if (search) whereParts.push(`g.Name LIKE @search`);
            if (enrollmentFilter === 'active') whereParts.push(`${ACTIVE_ENROLLMENTS_SUBQUERY} = 1`);
            else if (enrollmentFilter === 'inactive') whereParts.push(`${ACTIVE_ENROLLMENTS_SUBQUERY} = 0`);
            const whereSql = `WHERE ${whereParts.join(' AND ')}`;

            const req1 = pool.request();
            req1.input('vendorId', sql.UniqueIdentifier, vendorId);
            if (search) req1.input('search', sql.NVarChar, `%${search}%`);

            let rows = [];
            let total = 0;
            try {
                const dataResult = await req1.query(`
                    SELECT
                        s.SignedAgreementId, s.GroupId, s.ProductId,
                        s.SignedByName, s.SignedByEmail, s.SignedDate, s.SignedDocumentUrl,
                        s.LastEmailedDate, s.LastEmailedTo, s.EmailSendCount,
                        s.LastEmailAttemptDate, s.LastEmailError,
                        g.Name AS GroupName,
                        p.Name AS ProductName,
                        ${ACTIVE_ENROLLMENTS_SUBQUERY} AS GroupHasActiveEnrollments
                    FROM oe.SignedASAAgreements s
                    INNER JOIN oe.Groups g ON g.GroupId = s.GroupId
                    INNER JOIN oe.Products p ON p.ProductId = s.ProductId
                    ${whereSql}
                    ORDER BY
                        CASE WHEN s.LastEmailedDate IS NULL THEN 0 ELSE 1 END,
                        s.SignedDate DESC
                    OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY
                `);
                rows = dataResult.recordset;

                const req2 = pool.request();
                req2.input('vendorId', sql.UniqueIdentifier, vendorId);
                if (search) req2.input('search', sql.NVarChar, `%${search}%`);
                const countResult = await req2.query(`
                    SELECT COUNT(*) AS Total
                    FROM oe.SignedASAAgreements s
                    INNER JOIN oe.Groups g ON g.GroupId = s.GroupId
                    INNER JOIN oe.Products p ON p.ProductId = s.ProductId
                    ${whereSql}
                `);
                total = countResult.recordset[0]?.Total || 0;
            } catch (colErr) {
                const msg = (colErr && colErr.message) || '';
                if (msg.includes('Invalid column')) {
                    console.warn('⚠️ asa-agreements list: tracking columns missing; using legacy query');
                    const baseLegacyWhere = [`s.VendorId = @vendorId`, `s.Status = N'Completed'`];
                    if (enrollmentFilter === 'active') baseLegacyWhere.push(`${ACTIVE_ENROLLMENTS_SUBQUERY} = 1`);
                    else if (enrollmentFilter === 'inactive') baseLegacyWhere.push(`${ACTIVE_ENROLLMENTS_SUBQUERY} = 0`);
                    const legacyWhere = baseLegacyWhere.join(' AND ');
                    const legacyData = await pool.request()
                        .input('vendorId', sql.UniqueIdentifier, vendorId)
                        .query(`
                            SELECT
                                s.SignedAgreementId, s.GroupId, s.ProductId,
                                s.SignedByName, s.SignedByEmail, s.SignedDate, s.SignedDocumentUrl,
                                CAST(NULL AS DATETIME2) AS LastEmailedDate,
                                CAST(NULL AS NVARCHAR(2000)) AS LastEmailedTo,
                                0 AS EmailSendCount,
                                CAST(NULL AS DATETIME2) AS LastEmailAttemptDate,
                                CAST(NULL AS NVARCHAR(2000)) AS LastEmailError,
                                g.Name AS GroupName,
                                p.Name AS ProductName,
                                ${ACTIVE_ENROLLMENTS_SUBQUERY} AS GroupHasActiveEnrollments
                            FROM oe.SignedASAAgreements s
                            INNER JOIN oe.Groups g ON g.GroupId = s.GroupId
                            INNER JOIN oe.Products p ON p.ProductId = s.ProductId
                            WHERE ${legacyWhere}
                            ORDER BY s.SignedDate DESC
                            OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY
                        `);
                    rows = legacyData.recordset;
                    const legacyCount = await pool.request()
                        .input('vendorId', sql.UniqueIdentifier, vendorId)
                        .query(`
                            SELECT COUNT(*) AS Total
                            FROM oe.SignedASAAgreements s
                            INNER JOIN oe.Groups g ON g.GroupId = s.GroupId
                            INNER JOIN oe.Products p ON p.ProductId = s.ProductId
                            WHERE ${legacyWhere}
                        `);
                    total = Number(legacyCount.recordset[0]?.Total) || 0;
                } else {
                    throw colErr;
                }
            }

            res.json({
                success: true,
                data: {
                    total,
                    limit,
                    offset,
                    items: rows.map((r) => ({
                        signedAgreementId: String(r.SignedAgreementId),
                        groupId: String(r.GroupId),
                        groupName: r.GroupName || '',
                        productId: String(r.ProductId),
                        productName: r.ProductName || '',
                        signedByName: r.SignedByName || '',
                        signedByEmail: r.SignedByEmail || '',
                        signedDate: r.SignedDate ? new Date(r.SignedDate).toISOString() : null,
                        hasSignedPdf: !!r.SignedDocumentUrl,
                        lastEmailedDate: r.LastEmailedDate ? new Date(r.LastEmailedDate).toISOString() : null,
                        lastEmailedTo: r.LastEmailedTo || null,
                        emailSendCount: r.EmailSendCount || 0,
                        lastEmailAttemptDate: r.LastEmailAttemptDate ? new Date(r.LastEmailAttemptDate).toISOString() : null,
                        lastEmailError: r.LastEmailError || null,
                        groupHasActiveEnrollments: Number(r.GroupHasActiveEnrollments) === 1
                    }))
                }
            });
        } catch (error) {
            console.error('Error listing signed ASAs:', error);
            res.status(500).json({ success: false, message: 'Failed to list signed ASAs', error: error.message });
        }
    });

    router.get('/:signedAgreementId/download', ...mw, async (req, res) => {
        try {
            const pool = await getPool();
            const vendorId = await resolveVendorId(req);
            if (!vendorId) return res.status(404).json({ success: false, message: 'Vendor not found' });

            const ag = await loadAgreementForVendor(pool, req.params.signedAgreementId, vendorId);
            if (!ag) return res.status(404).json({ success: false, message: 'Signed ASA not found' });
            if (!ag.SignedDocumentUrl) {
                return res.status(404).json({ success: false, message: 'No signed PDF attached to this agreement' });
            }

            let url = ag.SignedDocumentUrl;
            if (isBlobUrl(url)) {
                try {
                    url = await generateAuthenticatedUrl(url);
                } catch (e) {
                    console.warn('⚠️ asa-agreements download: failed to authenticate URL:', e.message);
                }
            }

            const safeGroup = (ag.GroupName || 'Group').replace(/[^a-zA-Z0-9-_]/g, '_');
            const safeVendor = (ag.VendorName || 'Vendor').replace(/[^a-zA-Z0-9-_]/g, '_');
            const filename = `ASA-${safeVendor}-${safeGroup}.pdf`;

            res.json({ success: true, data: { url, filename } });
        } catch (error) {
            console.error('Error generating signed ASA download URL:', error);
            res.status(500).json({ success: false, message: 'Failed to generate download URL', error: error.message });
        }
    });

    router.post('/:signedAgreementId/send', ...mw, async (req, res) => {
        try {
            const pool = await getPool();
            const vendorId = await resolveVendorId(req);
            if (!vendorId) return res.status(404).json({ success: false, message: 'Vendor not found' });

            const ag = await loadAgreementForVendor(pool, req.params.signedAgreementId, vendorId);
            if (!ag) return res.status(404).json({ success: false, message: 'Signed ASA not found' });

            const userId = req.user?.UserId || req.user?.userId;
            const result = await sendSignedAsaEmail({
                signedAgreementId: ag.SignedAgreementId,
                recipients: req.body?.recipients,
                userId
            });
            res.status(result.success ? 200 : 400).json(result);
        } catch (error) {
            console.error('Error sending signed ASA:', error);
            res.status(500).json({ success: false, message: 'Failed to send signed ASA', error: error.message });
        }
    });

    router.post('/send-bulk', ...mw, async (req, res) => {
        try {
            const pool = await getPool();
            const vendorId = await resolveVendorId(req);
            if (!vendorId) return res.status(404).json({ success: false, message: 'Vendor not found' });

            const mode = (req.body?.mode === 'all') ? 'all' : 'unsent';
            const explicitIds = Array.isArray(req.body?.ids)
                ? req.body.ids.map((s) => String(s).trim()).filter(Boolean)
                : null;

            const whereParts = [`VendorId = @vendorId`, `Status = N'Completed'`];
            if (mode === 'unsent') whereParts.push(`LastEmailedDate IS NULL`);
            if (explicitIds && explicitIds.length > 0) {
                const paramNames = [];
                explicitIds.forEach((_id, i) => {
                    paramNames.push(`@id_${i}`);
                });
                whereParts.push(`SignedAgreementId IN (${paramNames.join(',')})`);
            }

            const listReq = pool.request();
            listReq.input('vendorId', sql.UniqueIdentifier, vendorId);
            if (explicitIds) {
                explicitIds.forEach((id, i) => {
                    try { listReq.input(`id_${i}`, sql.UniqueIdentifier, id); } catch (_) { /* invalid guid — skip */ }
                });
            }

            // Collect every matching SignedAgreementId. We deliberately do NOT
            // group by GroupId here — bulk send produces ONE email containing
            // every agreement (across every group) so the vendor doesn't get
            // a flood of per-group emails.
            const allIds = [];
            const groupIds = new Set();
            try {
                const r = await listReq.query(`
                    SELECT SignedAgreementId, GroupId
                    FROM oe.SignedASAAgreements
                    WHERE ${whereParts.join(' AND ')}
                `);
                for (const row of r.recordset || []) {
                    allIds.push(String(row.SignedAgreementId));
                    groupIds.add(String(row.GroupId));
                }
            } catch (colErr) {
                const msg = (colErr && colErr.message) || '';
                if (msg.includes('Invalid column') && mode === 'unsent') {
                    console.warn('⚠️ asa-agreements send-bulk: tracking columns missing; treating as mode=all');
                    const fallbackWhere = whereParts.filter((p) => !p.includes('LastEmailedDate'));
                    const r = await listReq.query(`
                        SELECT SignedAgreementId, GroupId
                        FROM oe.SignedASAAgreements
                        WHERE ${fallbackWhere.join(' AND ')}
                    `);
                    for (const row of r.recordset || []) {
                        allIds.push(String(row.SignedAgreementId));
                        groupIds.add(String(row.GroupId));
                    }
                } else {
                    throw colErr;
                }
            }

            const agreementCount = allIds.length;
            const groupCount = groupIds.size;
            const userId = req.user?.UserId || req.user?.userId;

            if (allIds.length === 0) {
                return res.json({
                    success: true,
                    data: { mode, agreementCount: 0, groupCount: 0, emailsSent: 0, emailsFailed: 0, results: [] },
                    message: 'No signed ASAs matched — nothing to send.'
                });
            }

            const r = await sendBulkSignedAsaForVendor({
                vendorId,
                signedAgreementIds: allIds,
                recipients: req.body?.recipients,
                userId
            });

            const skipped = Number(r.skippedNoActiveEnrollmentCount || 0);
            const sentCount = Math.max(0, agreementCount - skipped);
            res.json({
                success: r.success,
                data: {
                    mode,
                    agreementCount,
                    groupCount,
                    emailsSent: r.success ? 1 : 0,
                    emailsFailed: r.success ? 0 : 1,
                    skippedNoActiveEnrollmentCount: skipped,
                    results: [{ success: r.success, message: r.message, signedAgreementIds: r.signedAgreementIds || allIds }]
                },
                message: r.success
                    ? (sentCount === 0
                        ? `Nothing sent — ${skipped} ASA(s) skipped because their group has no active enrollments.`
                        : `Bulk send (${mode}): 1 email with ${sentCount} signed ASA(s) across ${(r.groupCount || groupCount)} group(s) to ${(r.recipients || []).length} address(es)${skipped > 0 ? ` · skipped ${skipped} ASA(s) for inactive groups` : ''}.`)
                    : (r.message || 'Bulk send failed')
            });
        } catch (error) {
            console.error('Error bulk sending signed ASAs:', error);
            res.status(500).json({ success: false, message: 'Failed to bulk send signed ASAs', error: error.message });
        }
    });

    return router;
}

module.exports = { createAsaAgreementsRouter };
