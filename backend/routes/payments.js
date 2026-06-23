// routes/payments.js - Payment Processing Routes
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { getPool, sql } = require('../config/database');
const { authenticate, authorize, requireTenantAccess } = require('../middleware/auth');
const DimeService = require('../services/dimeService');
const PaymentDatabaseService = require('../services/paymentDatabaseService');
const posthog = require('../config/posthog');
const invoiceService = require('../services/invoiceService');
const {
    getPaymentStatusInvoiceAdjustmentPlan,
    applyPaymentStatusInvoiceAdjustmentInTxn
} = require('../services/paymentAdminPatch.service');
const { generateInvoicePdf, prepareTenantLogoBufferForPdf } = require('../services/invoicePdfService');
const { requireShared } = require('../config/shared-modules');
const { isSuccessfulPaymentRecordStatus } = requireShared('payment-status');

/** Compare UUIDs from SQL (Buffer/string) safely — mirrors invoices route helper */
function uuidStringsEqual(a, b) {
    if (a == null || b == null) return false;
    const norm = (x) => String(x).replace(/-/g, '').toLowerCase();
    return norm(a) === norm(b);
}

/**
 * Member portal + staff: payment receipt PDF access (stricter than assertPaymentRowAccess for Members).
 */
async function assertPaymentReceiptPdfAccess(pool, paymentRow, req) {
    const role = req.user?.currentRole;

    if (role === 'SysAdmin') {
        return true;
    }

    if (
        !paymentRow.TenantId ||
        String(paymentRow.TenantId).toLowerCase() !== String(req.user.TenantId).toLowerCase()
    ) {
        return false;
    }

    if (role === 'TenantAdmin' || role === 'AgencyOwner') {
        return true;
    }

    if (role === 'Member') {
        const userId = req.user?.UserId || req.user?.userId;
        if (!userId || !paymentRow.HouseholdId) return false;
        const memberResult = await pool.request()
            .input('userId', sql.UniqueIdentifier, userId)
            .query(`SELECT HouseholdId FROM oe.Members WHERE UserId = @userId AND RelationshipType = N'P'`);
        const householdId = memberResult.recordset[0]?.HouseholdId;
        return !!(householdId && uuidStringsEqual(householdId, paymentRow.HouseholdId));
    }

    if (role === 'Agent') {
        const userId = req.user?.UserId || req.user?.userId;
        if (!userId) return false;
        const agentResult = await pool.request()
            .input('userId', sql.UniqueIdentifier, userId)
            .query(`SELECT AgentId FROM oe.Agents WHERE UserId = @userId AND Status = N'Active'`);
        const agentId = agentResult.recordset[0]?.AgentId;
        if (!agentId) return false;
        if (paymentRow.HouseholdId) {
            const enrRes = await pool.request()
                .input('householdId', sql.UniqueIdentifier, paymentRow.HouseholdId)
                .input('agentId', sql.UniqueIdentifier, agentId)
                .query(`
                    SELECT 1 AS ok FROM oe.Enrollments e
                    WHERE e.HouseholdId = @householdId AND e.AgentId = @agentId
                `);
            if (enrRes.recordset.length > 0) return true;
        }
        if (paymentRow.GroupId) {
            const grpRes = await pool.request()
                .input('groupId', sql.UniqueIdentifier, paymentRow.GroupId)
                .input('agentId', sql.UniqueIdentifier, agentId)
                .query(`
                    SELECT 1 AS ok FROM oe.Groups ag
                    WHERE ag.GroupId = @groupId AND ag.AgentId = @agentId
                `);
            return grpRes.recordset.length > 0;
        }
        return false;
    }

    if (role === 'GroupAdmin') {
        let userGroupId = req.user.GroupId || req.user.groupId;
        if (!userGroupId) {
            const gidReq = pool.request();
            gidReq.input('userId', sql.UniqueIdentifier, req.user.UserId);
            const gidRes = await gidReq.query(`
                SELECT TOP 1 GroupId FROM oe.GroupAdmins
                WHERE UserId = @userId AND Status = 'Active'
            `);
            if (gidRes.recordset && gidRes.recordset.length > 0) {
                userGroupId = gidRes.recordset[0].GroupId;
            }
        }
        if (!userGroupId) {
            return false;
        }
        const uid = String(userGroupId).toLowerCase();
        if (paymentRow.GroupId && String(paymentRow.GroupId).toLowerCase() === uid) {
            return true;
        }
        if (!paymentRow.HouseholdId) {
            return false;
        }
        const mReq = pool.request();
        mReq.input('householdId', sql.UniqueIdentifier, paymentRow.HouseholdId);
        mReq.input('userGroupId', sql.UniqueIdentifier, userGroupId);
        const mRes = await mReq.query(`
            SELECT 1 AS Ok FROM oe.Members m
            WHERE m.HouseholdId = @householdId AND m.GroupId = @userGroupId
        `);
        return !!(mRes.recordset && mRes.recordset.length > 0);
    }

    return false;
}

function buildPaymentReceiptMethodSummary(paymentRow) {
    const raw = String(paymentRow.PaymentMethod || '').trim();
    return raw || '';
}

/**
 * @param {unknown} v
 * @param {boolean} [defaultVal]
 */
function readBodyBool(v, defaultVal = false) {
    if (v === undefined || v === null) return defaultVal;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string') return v === 'true' || v === '1';
    return Boolean(v);
}

// Format date as YYYY-MM-DD (calendar date) so frontend can display without UTC timezone shifting the day
function toDateOnly(val) {
    if (val == null) return null;
    const d = val instanceof Date ? val : new Date(val);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
}

/** Admin manual corrections to oe.Payments.Status (must stay in sync with UI dropdown). */
const SETTABLE_PAYMENT_STATUSES = new Set([
    'Completed', 'Failed', 'Pending', 'Refunded', 'Voided', 'Canceled', 'Processing', 'Unknown',
    'APPROVAL', 'SUCCESS', 'COMPLETED', 'succeeded', 'Approved', 'PAID', 'Declined'
]);

/**
 * Ensure the caller may read/update/delete this payment row (same scope as GET /api/payments?memberId).
 * @returns {Promise<{ row: object } | { error: string, status?: number }>}
 */
async function assertPaymentRowAccess(pool, paymentId, req) {
    const request = pool.request();
    request.input('paymentId', sql.UniqueIdentifier, paymentId);
    const result = await request.query(`
        SELECT p.PaymentId, p.TenantId, p.HouseholdId, p.GroupId
        FROM oe.Payments p
        WHERE p.PaymentId = @paymentId
    `);
    if (!result.recordset || result.recordset.length === 0) {
        return { error: 'not_found', status: 404 };
    }
    const row = result.recordset[0];
    const role = req.user.currentRole;

    if (role === 'SysAdmin') {
        return { row };
    }

    if (!row.TenantId || String(row.TenantId).toLowerCase() !== String(req.user.TenantId).toLowerCase()) {
        return { error: 'forbidden', status: 403 };
    }

    if (role === 'GroupAdmin') {
        let userGroupId = req.user.GroupId || req.user.groupId;
        if (!userGroupId) {
            const gidReq = pool.request();
            gidReq.input('userId', sql.UniqueIdentifier, req.user.UserId);
            const gidRes = await gidReq.query(`
                SELECT TOP 1 GroupId FROM oe.GroupAdmins
                WHERE UserId = @userId AND Status = 'Active'
            `);
            if (gidRes.recordset && gidRes.recordset.length > 0) {
                userGroupId = gidRes.recordset[0].GroupId;
            }
        }
        if (!userGroupId) {
            return { error: 'forbidden', status: 403 };
        }
        const uid = String(userGroupId).toLowerCase();
        if (row.GroupId && String(row.GroupId).toLowerCase() === uid) {
            return { row };
        }
        if (!row.HouseholdId) {
            return { error: 'forbidden', status: 403 };
        }
        const mReq = pool.request();
        mReq.input('householdId', sql.UniqueIdentifier, row.HouseholdId);
        mReq.input('userGroupId', sql.UniqueIdentifier, userGroupId);
        const mRes = await mReq.query(`
            SELECT 1 AS Ok FROM oe.Members m
            WHERE m.HouseholdId = @householdId AND m.GroupId = @userGroupId
        `);
        if (!mRes.recordset || mRes.recordset.length === 0) {
            return { error: 'forbidden', status: 403 };
        }
    }

    return { row };
}

/**
 * GET /api/payments?memberId=xxx
 * Get payments for a specific member (Admin access).
 * Excludes Status = RecurringScheduled — those rows are schedule placeholders (see recurring-schedules / Recurring payments tab), not settled charges.
 */
router.get('/', authorize(['SysAdmin', 'TenantAdmin', 'Agent', 'AgencyOwner', 'GroupAdmin']), async (req, res) => {
    try {
        const { memberId } = req.query;
        
        if (!memberId) {
            return res.status(400).json({
                success: false,
                message: 'memberId query parameter is required'
            });
        }
        
        const pool = await getPool();
        
        // Get member's payment history
        // Updated to join via HouseholdId since payments are now household-based
        const paymentsQuery = `
            SELECT 
                p.PaymentId,
                p.InvoiceId,
                i.InvoiceNumber AS InvoiceNumber,
                i.BillingPeriodStart AS InvoiceBillingPeriodStart,
                i.BillingPeriodEnd AS InvoiceBillingPeriodEnd,
                i.Status AS InvoiceLinkedStatus,
                p.Amount,
                p.PaymentDate,
                p.Status,
                CASE
                  WHEN LOWER(LTRIM(ISNULL(p.PaymentMethod, ''))) = 'dime' AND mpm.PaymentMethodType IS NOT NULL
                    THEN mpm.PaymentMethodType
                  ELSE p.PaymentMethod
                END AS PaymentMethod,
                mpm.PaymentMethodType AS HouseholdPaymentMethodType,
                p.TransactionType,
                p.EnrollmentId,
                p.RecurringScheduleId,
                p.CreatedBy,
                LTRIM(RTRIM(ISNULL(ucb.FirstName, '') + ' ' + ISNULL(ucb.LastName, ''))) AS CreatedByName,
                p.NextBillingDate,
                p.ProcessorTransactionId,
                p.Processor,
                p.FailureReason,
                p.AttemptNumber,
                p.ConsecutiveFailureCount,
                p.ACHReturnCode,
                p.ACHReturnReason,
                p.ChargebackReason,
                p.OriginalPaymentId,
                -- Get product names from household enrollments that were active at payment time
                STUFF((
                    SELECT ', ' + pr.Name
                    FROM oe.Enrollments e
                    INNER JOIN oe.Products pr ON e.ProductId = pr.ProductId
                    WHERE e.HouseholdId = p.HouseholdId 
                      AND (
                        e.CreatedDate <= p.PaymentDate
                        AND (e.Status = 'Active' OR 
                             (e.EffectiveDate <= p.PaymentDate AND 
                              (e.TerminationDate IS NULL OR e.TerminationDate >= p.PaymentDate)))
                      )
                    FOR XML PATH(''), TYPE
                ).value('.', 'NVARCHAR(MAX)'), 1, 2, '') as ProductName,
                'Active' as EnrollmentStatus
            FROM oe.Payments p
            INNER JOIN oe.Members m ON p.HouseholdId = m.HouseholdId
            LEFT JOIN oe.Members mPrim ON mPrim.HouseholdId = p.HouseholdId AND mPrim.RelationshipType = 'P'
            LEFT JOIN oe.Users u ON m.UserId = u.UserId
            LEFT JOIN oe.MemberPaymentMethods mpm ON mpm.MemberId = mPrim.MemberId AND mpm.IsDefault = 1 AND mpm.Status = 'Active'
            LEFT JOIN oe.Users ucb ON ucb.UserId = p.CreatedBy
            LEFT JOIN oe.Invoices i ON i.InvoiceId = p.InvoiceId
            WHERE m.MemberId = @memberId
              AND (p.Status IS NULL OR p.Status <> N'RecurringScheduled')
        `;
        
        const request = pool.request();
        request.input('memberId', sql.UniqueIdentifier, memberId);
        
        // Add tenant filtering for non-SysAdmin users
        let finalQuery = paymentsQuery;
        if (req.user.currentRole !== 'SysAdmin') {
            finalQuery += ' AND u.TenantId = @tenantId';
            request.input('tenantId', sql.UniqueIdentifier, req.user.TenantId);
        }
        
        // Add group filtering for GroupAdmin users
        if (req.user.currentRole === 'GroupAdmin') {
            // Get GroupAdmin's group ID
            let userGroupId = req.user.GroupId || req.user.groupId;
            
            // If GroupId not in JWT, query from GroupAdmins table
            if (!userGroupId) {
                const groupIdQuery = `
                    SELECT GroupId 
                    FROM oe.GroupAdmins 
                    WHERE UserId = @userId AND Status = 'Active'
                `;
                const groupIdRequest = pool.request();
                groupIdRequest.input('userId', sql.UniqueIdentifier, req.user.UserId);
                const groupIdResult = await groupIdRequest.query(groupIdQuery);
                
                if (groupIdResult.recordset.length > 0 && groupIdResult.recordset[0].GroupId) {
                    userGroupId = groupIdResult.recordset[0].GroupId;
                }
            }
            
            if (userGroupId) {
                // Verify the member belongs to the GroupAdmin's group
                finalQuery += ' AND m.GroupId = @userGroupId';
                request.input('userGroupId', sql.UniqueIdentifier, userGroupId);
            } else {
                // GroupAdmin has no group assigned - deny access
                return res.status(403).json({
                    success: false,
                    message: 'Access denied: No group assigned',
                    code: 'NO_GROUP_ASSIGNED'
                });
            }
        }
        
        finalQuery += ' ORDER BY p.PaymentDate DESC';
        
        const result = await request.query(finalQuery);
        
        res.json({
            success: true,
            data: result.recordset
        });
        
    } catch (error) {
        console.error('❌ Error fetching member payments:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch payments',
            error: {
                message: error.message,
                code: 'PAYMENTS_FETCH_ERROR'
            }
        });
    }
});

/**
 * GET /api/payments/group/:groupId
 * Get payments for a specific group (Admin access)
 */
router.get('/group/:groupId', authorize(['SysAdmin', 'TenantAdmin', 'Agent']), async (req, res) => {
    try {
        const { groupId } = req.params;
        
        const pool = await getPool();
        
        // Get group's payment history
        const request = pool.request();
        request.input('groupId', sql.UniqueIdentifier, groupId);
        
        // Build query with optional tenant filtering for non-SysAdmin users
        let whereClause = `WHERE p.GroupId = @groupId
            AND (p.Status IS NULL OR p.Status <> N'RecurringScheduled')`;
        if (req.user.currentRole !== 'SysAdmin') {
            whereClause += ' AND p.TenantId = @tenantId';
            request.input('tenantId', sql.UniqueIdentifier, req.user.TenantId);
        }
        
        const paymentsQuery = `
            SELECT 
                p.PaymentId,
                p.Amount,
                p.PaymentDate,
                p.Status,
                p.PaymentMethod,
                p.TransactionType,
                p.ProcessorTransactionId,
                p.FailureReason,
                p.ACHReturnCode,
                p.ACHReturnReason,
                p.ChargebackReason,
                p.OriginalPaymentId,
                p.GroupId,
                p.TenantId,
                p.CreatedDate,
                p.ModifiedDate
            FROM oe.Payments p
            ${whereClause}
            ORDER BY p.PaymentDate DESC
        `;
        
        const payments = await request.query(paymentsQuery);
        
        res.json({
            success: true,
            data: payments.recordset
        });
    } catch (error) {
        console.error('Error fetching group payments:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch group payments',
            error: error.message
        });
    }
});

/**
 * GET /api/payments/recurring-schedules?memberId=xxx
 * Get recurring payment schedules for a member. If member is in a group, returns group schedules; if individual, returns their household schedules from oe.Payments. TenantAdmin/SysAdmin only.
 */
router.get('/recurring-schedules', authorize(['SysAdmin', 'TenantAdmin']), async (req, res) => {
    try {
        const { memberId } = req.query;
        if (!memberId) {
            return res.status(400).json({
                success: false,
                message: 'memberId query parameter is required'
            });
        }

        const pool = await getPool();
        const request = pool.request();
        request.input('memberId', sql.UniqueIdentifier, memberId);

        // Get member GroupId and HouseholdId (with tenant/auth)
        let memberQuery = `
            SELECT m.MemberId, m.GroupId, m.HouseholdId
            FROM oe.Members m
            INNER JOIN oe.Users u ON m.UserId = u.UserId
            WHERE m.MemberId = @memberId
        `;
        if (req.user.currentRole !== 'SysAdmin') {
            memberQuery += ' AND u.TenantId = @tenantId';
            request.input('tenantId', sql.UniqueIdentifier, req.user.TenantId);
        }
        const memberResult = await request.query(memberQuery);
        if (!memberResult.recordset || memberResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Member not found'
            });
        }
        const member = memberResult.recordset[0];
        const groupId = member.GroupId;
        const householdId = member.HouseholdId;

        if (groupId) {
            // Group member: return group recurring schedules (same shape as group billing)
            const scheduledPaymentsResult = await pool.request()
                .input('groupId', sql.UniqueIdentifier, groupId)
                .query(`
                    SELECT 
                        grp.DimeScheduleId as scheduleId,
                        grp.LocationId,
                        gl.Name as LocationName,
                        grp.NextBillingDate,
                        grp.MonthlyAmount,
                        grp.IsActive,
                        grp.ModifiedDate as CancelledDate
                    FROM oe.GroupRecurringPaymentPlans grp
                    LEFT JOIN oe.GroupLocations gl ON grp.LocationId = gl.LocationId
                    WHERE grp.GroupId = @groupId 
                      AND grp.DimeScheduleId IS NOT NULL
                    ORDER BY grp.IsActive DESC, gl.IsPrimary DESC, gl.Name
                `);
            const scheduledPayments = (scheduledPaymentsResult.recordset || []).map(r => ({
                scheduleId: String(r.scheduleId),
                locationId: r.LocationId,
                locationName: r.LocationName || 'Primary',
                nextBillingDate: toDateOnly(r.NextBillingDate),
                monthlyAmount: parseFloat(r.MonthlyAmount || 0),
                isActive: r.IsActive === 1 || r.IsActive === true,
                cancelledDate: r.IsActive === 0 || r.IsActive === false ? toDateOnly(r.CancelledDate) : null,
                processor: 'DIME'
            }));
            return res.json({
                success: true,
                data: {
                    scheduledPayments,
                    context: 'group',
                    groupId: groupId ? String(groupId) : null
                }
            });
        }

        // Individual (no group): canonical schedule rows = oe.IndividualRecurringSchedules; oe.Payments is charge history + legacy denormalization.
        // Lazy-sync missing IRS rows from Payments so older data appears without a one-off DBA script per household.
        if (!householdId) {
            return res.json({
                success: true,
                data: {
                    scheduledPayments: [],
                    context: 'individual'
                }
            });
        }

        await PaymentDatabaseService.syncMissingIndividualRecurringSchedulesForHousehold(householdId);

        let scheduledPayments = [];
        try {
            const tableResult = await pool.request()
                .input('householdId', sql.UniqueIdentifier, householdId)
                .query(`
                    SELECT DimeScheduleId as scheduleId, MonthlyAmount, NextBillingDate, IsActive, CancelledDate
                    FROM oe.IndividualRecurringSchedules
                    WHERE HouseholdId = @householdId
                    ORDER BY IsActive DESC, CreatedDate DESC
                `);
            scheduledPayments = (tableResult.recordset || []).map(r => ({
                scheduleId: String(r.scheduleId),
                locationId: null,
                locationName: 'Individual',
                nextBillingDate: toDateOnly(r.NextBillingDate),
                monthlyAmount: parseFloat(r.MonthlyAmount || 0),
                isActive: r.IsActive === 1 || r.IsActive === true,
                cancelledDate: (r.IsActive === 0 || r.IsActive === false) ? toDateOnly(r.CancelledDate) : null,
                processor: 'DIME'
            }));
        } catch (tableErr) {
            if (!String(tableErr.message || '').includes('IndividualRecurringSchedules')) throw tableErr;
        }
        // Also merge in active schedules from oe.Payments that aren't in IndividualRecurringSchedules
        // (e.g. when insert failed or table didn't exist yet)
        const legacyQuery = `
            SELECT p.RecurringScheduleId as scheduleId, p.Amount as MonthlyAmount, p.NextBillingDate
            FROM (
                SELECT p.RecurringScheduleId, p.Amount, p.NextBillingDate,
                       ROW_NUMBER() OVER (PARTITION BY p.RecurringScheduleId ORDER BY p.PaymentDate DESC) as rn
                FROM oe.Payments p
                WHERE p.HouseholdId = @householdId AND p.RecurringScheduleId IS NOT NULL
                  AND p.Status IN ('succeeded', 'APPROVAL', 'Completed', 'RecurringScheduled')
            ) p
            WHERE p.rn = 1
        `;
        const legacyResult = await pool.request()
            .input('householdId', sql.UniqueIdentifier, householdId)
            .query(legacyQuery);
        const legacySchedules = (legacyResult.recordset || []).map(r => ({
            scheduleId: String(r.scheduleId),
            locationId: null,
            locationName: 'Individual',
            nextBillingDate: toDateOnly(r.NextBillingDate),
            monthlyAmount: parseFloat(r.MonthlyAmount || 0),
            isActive: true,
            cancelledDate: null,
            processor: 'DIME'
        }));
        const tableScheduleIds = new Set(scheduledPayments.map(s => s.scheduleId));
        for (const leg of legacySchedules) {
            if (!tableScheduleIds.has(leg.scheduleId)) {
                scheduledPayments.push(leg);
            }
        }

        return res.json({
            success: true,
            data: {
                scheduledPayments,
                context: 'individual'
            }
        });
    } catch (error) {
        console.error('❌ Error fetching member recurring schedules:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch recurring schedules',
            error: { message: error.message }
        });
    }
});

/**
 * POST /api/payments/cancel-recurring-schedule
 * Cancel an individual (household) recurring payment schedule in DIME only (no replacement schedule). Clears RecurringScheduleId in oe.Payments. TenantAdmin, SysAdmin only.
 * Body: { memberId, scheduleId, force? }
 *   - force=true: if DIME cancel fails (e.g. schedule not found in DIME), still cancel in our DB.
 *     Without force, a DIME failure returns 400 with `canForce: true` so the UI can offer the user a DB-only cancel.
 */
router.post('/cancel-recurring-schedule', authorize(['SysAdmin', 'TenantAdmin']), async (req, res) => {
    try {
        const { memberId, scheduleId, force } = req.body;
        if (!memberId || !scheduleId) {
            return res.status(400).json({
                success: false,
                message: 'memberId and scheduleId are required'
            });
        }

        const pool = await getPool();
        const request = pool.request();
        request.input('memberId', sql.UniqueIdentifier, memberId);

        let memberQuery = `
            SELECT m.MemberId, m.HouseholdId, u.TenantId
            FROM oe.Members m
            INNER JOIN oe.Users u ON m.UserId = u.UserId
            WHERE m.MemberId = @memberId
        `;
        if (req.user.currentRole !== 'SysAdmin') {
            memberQuery += ' AND u.TenantId = @tenantId';
            request.input('tenantId', sql.UniqueIdentifier, req.user.TenantId);
        }
        const memberResult = await request.query(memberQuery);
        if (!memberResult.recordset || memberResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Member not found'
            });
        }
        const member = memberResult.recordset[0];
        const householdId = member.HouseholdId;
        const tenantId = member.TenantId;
        if (!householdId || !tenantId) {
            return res.status(400).json({
                success: false,
                message: 'Member household or tenant not found'
            });
        }

        const cancelResult = await DimeService.cancelRecurringPayment(String(scheduleId), tenantId);
        let forcedDbOnly = false;
        if (!cancelResult.success && !cancelResult.wasAlreadyCanceled) {
            if (!force) {
                return res.status(400).json({
                    success: false,
                    message: cancelResult.error || 'Failed to cancel schedule in payment processor',
                    canForce: true,
                    dimeError: cancelResult.error || 'DIME did not confirm cancellation'
                });
            }
            forcedDbOnly = true;
            console.warn('⚠️ [cancel-recurring-schedule] DIME cancel failed; proceeding with DB-only cancel (force=true):', cancelResult.error);
        }

        try {
            const updateTable = await pool.request()
                .input('householdId', sql.UniqueIdentifier, householdId)
                .input('dimeScheduleId', sql.NVarChar(255), String(scheduleId))
                .query(`
                    UPDATE oe.IndividualRecurringSchedules
                    SET IsActive = 0, CancelledDate = GETUTCDATE(), ModifiedDate = GETUTCDATE()
                    WHERE HouseholdId = @householdId AND DimeScheduleId = @dimeScheduleId
                `);
            if (updateTable.rowsAffected[0] === 0) {
                const pmRow = await pool.request()
                    .input('householdId', sql.UniqueIdentifier, householdId)
                    .input('scheduleId', sql.NVarChar(255), String(scheduleId))
                    .query(`
                        SELECT TOP 1 Amount, NextBillingDate FROM oe.Payments
                        WHERE HouseholdId = @householdId AND RecurringScheduleId = @scheduleId
                    `);
                const r = pmRow.recordset?.[0];
                if (r) {
                    await pool.request()
                        .input('householdId', sql.UniqueIdentifier, householdId)
                        .input('tenantId', sql.UniqueIdentifier, tenantId)
                        .input('dimeScheduleId', sql.NVarChar(255), String(scheduleId))
                        .input('monthlyAmount', sql.Decimal(10, 2), r.Amount || 0)
                        .input('nextBillingDate', sql.DateTime2, r.NextBillingDate)
                        .query(`
                            INSERT INTO oe.IndividualRecurringSchedules (HouseholdId, TenantId, DimeScheduleId, MonthlyAmount, NextBillingDate, IsActive, CancelledDate, CreatedDate, ModifiedDate)
                            VALUES (@householdId, @tenantId, @dimeScheduleId, @monthlyAmount, @nextBillingDate, 0, GETUTCDATE(), GETUTCDATE(), GETUTCDATE())
                        `);
                }
            }
        } catch (tableErr) {
            if (!String(tableErr.message || '').includes('IndividualRecurringSchedules')) {
                console.warn('⚠️ [cancel-recurring-schedule] IndividualRecurringSchedules update failed:', tableErr.message);
            }
        }

        await pool.request()
            .input('householdId', sql.UniqueIdentifier, householdId)
            .input('scheduleId', sql.NVarChar(255), String(scheduleId))
            .query(`
                UPDATE oe.Payments
                SET RecurringScheduleId = NULL, NextBillingDate = NULL, ModifiedDate = GETUTCDATE()
                WHERE HouseholdId = @householdId AND RecurringScheduleId = @scheduleId
            `);

        posthog.capture({
            distinctId: String(req.user.UserId || req.user.userId || 'unknown'),
            event: 'recurring payment cancelled',
            properties: {
                member_id: memberId,
                schedule_id: String(scheduleId),
                tenant_id: tenantId ? String(tenantId) : undefined,
                forced_db_only: forcedDbOnly,
            },
        });

        return res.json({
            success: true,
            data: {
                message: forcedDbOnly
                    ? 'Recurring schedule canceled in our records only (DIME cancel failed or schedule not found).'
                    : 'Recurring schedule canceled'
            },
            forcedDbOnly
        });
    } catch (error) {
        console.error('❌ Error canceling individual recurring schedule:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to cancel recurring schedule',
            error: { message: error.message }
        });
    }
});

/**
 * PATCH /api/payments/recurring-schedule-amount
 * Update the displayed/next amount for an individual (household) recurring schedule. Updates the most recent payment row for that schedule. SysAdmin only.
 */
router.patch('/recurring-schedule-amount', authorize(['SysAdmin']), async (req, res) => {
    try {
        const { memberId, scheduleId, monthlyAmount } = req.body;
        const amount = parseFloat(monthlyAmount);
        if (!memberId || !scheduleId || typeof amount !== 'number' || Number.isNaN(amount) || amount < 0) {
            return res.status(400).json({
                success: false,
                message: 'memberId, scheduleId, and monthlyAmount (non-negative number) are required'
            });
        }
        const pool = await getPool();
        const request = pool.request();
        request.input('memberId', sql.UniqueIdentifier, memberId);
        const memberResult = await request.query(`
            SELECT m.HouseholdId FROM oe.Members m
            INNER JOIN oe.Users u ON m.UserId = u.UserId
            WHERE m.MemberId = @memberId
        `);
        if (!memberResult.recordset || memberResult.recordset.length === 0) {
            return res.status(404).json({ success: false, message: 'Member not found' });
        }
        const householdId = memberResult.recordset[0].HouseholdId;
        if (!householdId) {
            return res.status(400).json({ success: false, message: 'Member has no household' });
        }
        const updateResult = await pool.request()
            .input('householdId', sql.UniqueIdentifier, householdId)
            .input('scheduleId', sql.NVarChar(255), String(scheduleId))
            .input('amount', sql.Decimal(10, 2), amount)
            .query(`
                UPDATE p SET p.Amount = @amount, p.ModifiedDate = GETUTCDATE()
                FROM oe.Payments p
                INNER JOIN (
                    SELECT TOP 1 PaymentId FROM oe.Payments
                    WHERE HouseholdId = @householdId AND RecurringScheduleId = @scheduleId
                    ORDER BY PaymentDate DESC
                ) latest ON p.PaymentId = latest.PaymentId
            `);
        if (updateResult.rowsAffected[0] === 0) {
            return res.status(404).json({
                success: false,
                message: 'No payment found for this recurring schedule'
            });
        }
        return res.json({
            success: true,
            message: 'Recurring schedule amount updated',
            data: { monthlyAmount: amount }
        });
    } catch (error) {
        console.error('❌ Error updating recurring schedule amount:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update amount',
            error: error.message
        });
    }
});

/**
 * POST /api/payments/link-dime-customer
 * Link a DIME customer (and optional payment method) to the primary member of a household.
 * Use when the member paid via DIME but we have no payment method on file (e.g. from DIME dashboard customer link).
 * Body: { memberId, dimeCustomerId, dimePaymentMethodId?, paymentMethodType? }.
 * TenantAdmin, SysAdmin only.
 */
router.post('/link-dime-customer', authorize(['SysAdmin', 'TenantAdmin']), async (req, res) => {
    console.log('📥 [link-dime-customer] Handler entered', { body: req.body ? { memberId: req.body.memberId, hasDimeCustomerId: !!req.body.dimeCustomerId } : 'no body' });
    try {
        const { memberId, dimeCustomerId, dimePaymentMethodId, paymentMethodType } = req.body;
        if (!memberId || !dimeCustomerId || typeof dimeCustomerId !== 'string' || !dimeCustomerId.trim()) {
            return res.status(400).json({
                success: false,
                message: 'memberId and dimeCustomerId are required'
            });
        }
        const pool = await getPool();
        const request = pool.request();
        request.input('memberId', sql.UniqueIdentifier, memberId);
        let memberQuery = `
            SELECT m.MemberId, m.HouseholdId, u.TenantId
            FROM oe.Members m
            INNER JOIN oe.Users u ON m.UserId = u.UserId
            WHERE m.MemberId = @memberId
        `;
        if (req.user.currentRole !== 'SysAdmin') {
            memberQuery += ' AND u.TenantId = @tenantId';
            request.input('tenantId', sql.UniqueIdentifier, req.user.TenantId);
        }
        const memberResult = await request.query(memberQuery);
        if (!memberResult.recordset || memberResult.recordset.length === 0) {
            return res.status(404).json({ success: false, message: 'Member not found' });
        }
        const { HouseholdId, TenantId } = memberResult.recordset[0];
        if (!HouseholdId) {
            return res.status(400).json({ success: false, message: 'Member has no household' });
        }
        // Resolve primary member of this household
        const primaryResult = await pool.request()
            .input('householdId', sql.UniqueIdentifier, HouseholdId)
            .query(`
                SELECT MemberId FROM oe.Members
                WHERE HouseholdId = @householdId AND RelationshipType = 'P'
            `);
        const primaryMemberId = primaryResult.recordset?.[0]?.MemberId;
        if (!primaryMemberId) {
            return res.status(400).json({ success: false, message: 'No primary member found for household' });
        }
        const actingUserId = req.user?.UserId;
        if (!actingUserId) {
            return res.status(401).json({ success: false, message: 'User not authenticated' });
        }
        // Persist customer link on member record regardless of whether a specific payment method ID is available.
        await pool.request()
            .input('memberId', sql.UniqueIdentifier, primaryMemberId)
            .input('processorCustomerId', sql.NVarChar(255), String(dimeCustomerId).trim())
            .query(`
                UPDATE oe.Members
                SET ProcessorCustomerId = @processorCustomerId,
                    ModifiedDate = GETUTCDATE()
                WHERE MemberId = @memberId
            `);
        const type = (paymentMethodType === 'ACH' || paymentMethodType === 'Card') ? paymentMethodType : 'Card';
        const customerIdTrimmed = String(dimeCustomerId).trim();
        let paymentMethodIdTrimmed = dimePaymentMethodId != null && String(dimePaymentMethodId).trim() !== '' ? String(dimePaymentMethodId).trim() : null;
        let fetchedLast4 = null;
        let fetchedBrand = null;
        let dimeListReturnedNoPaymentMethods = false;

        // If no payment method ID provided, try to look up the customer's payment methods in DIME and use the primary/first card
        if (!paymentMethodIdTrimmed) {
            console.log('🔍 [link-dime-customer] No payment method ID provided, fetching from DIME list...');
            const pmList = await DimeService.getCustomerPaymentMethods(customerIdTrimmed, TenantId);
            if (pmList.success && pmList.paymentMethods && pmList.paymentMethods.length > 0) {
                const defaultPm = pmList.paymentMethods.find((pm) => pm.isDefault);
                const firstCard = pmList.paymentMethods.find((pm) => pm.type === 'cc');
                const primary = defaultPm || firstCard || pmList.paymentMethods[0];
                paymentMethodIdTrimmed = primary.id;
                fetchedLast4 = primary.last4 || null;
                fetchedBrand = primary.brand || null;
                console.log('✅ [link-dime-customer] Using DIME payment method:', { id: paymentMethodIdTrimmed, last4: fetchedLast4, brand: fetchedBrand });
            } else {
                dimeListReturnedNoPaymentMethods = true;
                console.log('⚠️ [link-dime-customer] No payment methods from DIME list (or list failed), linking customer only.');
            }
        }

        // Check for existing MemberPaymentMethods row for this primary with processor IDs
        const existingPm = await pool.request()
            .input('memberId', sql.UniqueIdentifier, primaryMemberId)
            .input('tenantId', sql.UniqueIdentifier, TenantId)
            .query(`
                SELECT TOP 1 PaymentMethodId, ProcessorCustomerId, ProcessorPaymentMethodId
                FROM oe.MemberPaymentMethods
                WHERE MemberId = @memberId AND TenantId = @tenantId AND Status = 'Active'
                ORDER BY IsDefault DESC, CreatedDate DESC
            `);
        const existing = existingPm.recordset?.[0];
        if (existing) {
            const updReq = pool.request()
                .input('paymentMethodId', sql.UniqueIdentifier, existing.PaymentMethodId)
                .input('processorCustomerId', sql.NVarChar(255), customerIdTrimmed)
                .input('modifiedBy', sql.UniqueIdentifier, actingUserId);
            if (paymentMethodIdTrimmed != null) {
                updReq.input('processorPaymentMethodId', sql.NVarChar(255), paymentMethodIdTrimmed);
                if (fetchedLast4 != null || fetchedBrand != null) {
                    updReq.input('cardLast4', sql.NVarChar(10), fetchedLast4);
                    updReq.input('cardBrand', sql.NVarChar(50), fetchedBrand);
                    await updReq.query(`
                        UPDATE oe.MemberPaymentMethods
                        SET ProcessorCustomerId = @processorCustomerId, ProcessorPaymentMethodId = @processorPaymentMethodId, CardLast4 = @cardLast4, CardBrand = @cardBrand, ModifiedDate = GETUTCDATE(), ModifiedBy = @modifiedBy
                        WHERE PaymentMethodId = @paymentMethodId
                    `);
                } else {
                    await updReq.query(`
                        UPDATE oe.MemberPaymentMethods
                        SET ProcessorCustomerId = @processorCustomerId, ProcessorPaymentMethodId = @processorPaymentMethodId, ModifiedDate = GETUTCDATE(), ModifiedBy = @modifiedBy
                        WHERE PaymentMethodId = @paymentMethodId
                    `);
                }
            } else {
                await updReq.query(`
                    UPDATE oe.MemberPaymentMethods
                    SET ProcessorCustomerId = @processorCustomerId, ModifiedDate = GETUTCDATE(), ModifiedBy = @modifiedBy
                    WHERE PaymentMethodId = @paymentMethodId
                `);
            }
        } else {
            // Do not create placeholder "blank" payment method rows when we only have a customer ID.
            if (!paymentMethodIdTrimmed) {
                console.log('ℹ️ [link-dime-customer] Skipping MemberPaymentMethods insert (no payment method ID provided).');
            } else {
            const newPmId = uuidv4();
            const insReq = pool.request()
                .input('paymentMethodId', sql.UniqueIdentifier, newPmId)
                .input('memberId', sql.UniqueIdentifier, primaryMemberId)
                .input('tenantId', sql.UniqueIdentifier, TenantId)
                .input('paymentMethodType', sql.NVarChar(50), type)
                .input('processorCustomerId', sql.NVarChar(255), customerIdTrimmed)
                .input('processorPaymentMethodId', sql.NVarChar(255), paymentMethodIdTrimmed)
                .input('createdBy', sql.UniqueIdentifier, actingUserId)
                .input('modifiedBy', sql.UniqueIdentifier, actingUserId);
            if (fetchedLast4 != null || fetchedBrand != null) {
                insReq.input('cardLast4', sql.NVarChar(10), fetchedLast4);
                insReq.input('cardBrand', sql.NVarChar(50), fetchedBrand);
                await insReq.query(`
                    INSERT INTO oe.MemberPaymentMethods (
                        PaymentMethodId, MemberId, TenantId, PaymentMethodType, IsDefault, Status,
                        ProcessorCustomerId, ProcessorPaymentMethodId, CardLast4, CardBrand, CreatedBy, ModifiedBy, CreatedDate, ModifiedDate
                    ) VALUES (
                        @paymentMethodId, @memberId, @tenantId, @paymentMethodType, 1, 'Active',
                        @processorCustomerId, @processorPaymentMethodId, @cardLast4, @cardBrand, @createdBy, @modifiedBy, GETUTCDATE(), GETUTCDATE()
                    )
                `);
            } else {
                await insReq.query(`
                    INSERT INTO oe.MemberPaymentMethods (
                        PaymentMethodId, MemberId, TenantId, PaymentMethodType, IsDefault, Status,
                        ProcessorCustomerId, ProcessorPaymentMethodId, CreatedBy, ModifiedBy, CreatedDate, ModifiedDate
                    ) VALUES (
                        @paymentMethodId, @memberId, @tenantId, @paymentMethodType, 1, 'Active',
                        @processorCustomerId, @processorPaymentMethodId, @createdBy, @modifiedBy, GETUTCDATE(), GETUTCDATE()
                    )
                `);
            }
            }
        }
        let message;
        if (paymentMethodIdTrimmed) {
            if (fetchedLast4 || fetchedBrand) {
                const label = [fetchedBrand, fetchedLast4 ? `•••• ${fetchedLast4}` : ''].filter(Boolean).join(' ');
                message = `Payment method${label ? ` (${label})` : ''} linked. You can set up recurring payment.`;
            } else {
                message = 'DIME customer and payment method linked. You can set up recurring payment.';
            }
        } else {
            message = dimeListReturnedNoPaymentMethods
                ? 'No payment method found in DIME, but customer linked successfully. Add payment method ID from DIME dashboard to enable recurring.'
                : 'DIME customer linked. Add payment method ID from DIME dashboard to enable recurring.';
        }
        console.log('✅ [link-dime-customer] Success, sending response', { message });
        return res.json({
            success: true,
            message,
            data: { primaryMemberId, hasPaymentMethodId: !!paymentMethodIdTrimmed, cardLast4: fetchedLast4 || undefined, cardBrand: fetchedBrand || undefined }
        });
    } catch (error) {
        console.error('❌ [link-dime-customer] Error:', error);
        return res.status(500).json({
            success: false,
            message: error.message || 'Failed to link DIME customer'
        });
    }
});

/**
 * Compute suggested recurring start date using the household's earliest enrollment
 * effective day-of-month.  E.g. if the effective date is the 4th, the suggested
 * start lands on the 4th of the appropriate month (next month, or the month after
 * if that date has already passed).
 */
async function getSuggestedRecurringStartDate(pool, householdId) {
    const enrollResult = await pool.request()
        .input('householdId', sql.UniqueIdentifier, householdId)
        .query(`
        SELECT TOP 1 e.EffectiveDate
        FROM oe.Enrollments e
        WHERE e.HouseholdId = @householdId
          AND e.Status = 'Active'
          AND e.EnrollmentType IN ('Product', 'Bundle')
        ORDER BY e.EffectiveDate ASC
    `);
    const effDate = enrollResult.recordset?.[0]?.EffectiveDate;
    const now = new Date();

    // Determine the effective day-of-month (default 1 if no enrollment found)
    const effectiveDay = effDate ? new Date(effDate).getUTCDate() : 1;

    // Try the effective day in the current month first
    let candidateYear = now.getUTCFullYear();
    let candidateMonth = now.getUTCMonth();
    const lastDayThisMonth = new Date(Date.UTC(candidateYear, candidateMonth + 1, 0)).getUTCDate();
    let candidate = new Date(Date.UTC(candidateYear, candidateMonth, Math.min(effectiveDay, lastDayThisMonth)));

    // If that date is in the past, advance to next month
    if (candidate <= now) {
        candidateMonth += 1;
        if (candidateMonth > 11) { candidateMonth = 0; candidateYear += 1; }
        const lastDayNextMonth = new Date(Date.UTC(candidateYear, candidateMonth + 1, 0)).getUTCDate();
        candidate = new Date(Date.UTC(candidateYear, candidateMonth, Math.min(effectiveDay, lastDayNextMonth)));
    }

    return candidate.toISOString().slice(0, 10);
}

/**
 * GET /api/payments/can-setup-recurring?memberId=xxx
 * Returns whether the member's household has a DIME customer + payment method on file (so recurring can be set up).
 */
router.get('/can-setup-recurring', authorize(['SysAdmin', 'TenantAdmin']), async (req, res) => {
    try {
        const { memberId } = req.query;
        if (!memberId) {
            return res.status(400).json({ success: false, message: 'memberId is required' });
        }
        const pool = await getPool();
        const request = pool.request();
        request.input('memberId', sql.UniqueIdentifier, memberId);
        let memberQuery = `
            SELECT m.HouseholdId
            FROM oe.Members m
            INNER JOIN oe.Users u ON m.UserId = u.UserId
            WHERE m.MemberId = @memberId
        `;
        if (req.user.currentRole !== 'SysAdmin') {
            memberQuery += ' AND u.TenantId = @tenantId';
            request.input('tenantId', sql.UniqueIdentifier, req.user.TenantId);
        }
        const memberResult = await request.query(memberQuery);
        if (!memberResult.recordset || memberResult.recordset.length === 0) {
            return res.status(404).json({ success: false, message: 'Member not found' });
        }
        const { HouseholdId } = memberResult.recordset[0];
        if (!HouseholdId) {
            return res.json({ success: true, data: { canSetup: false } });
        }
        const pmCheck = await pool.request()
            .input('householdId', sql.UniqueIdentifier, HouseholdId)
            .query(`
            SELECT TOP 1 1 AS HasBoth
            FROM oe.MemberPaymentMethods mpm
            INNER JOIN oe.Members m ON mpm.MemberId = m.MemberId
            WHERE m.HouseholdId = @householdId AND m.RelationshipType = 'P'
              AND mpm.Status = 'Active'
              AND mpm.ProcessorCustomerId IS NOT NULL AND mpm.ProcessorPaymentMethodId IS NOT NULL
            `);
        const canSetup = !!(pmCheck.recordset && pmCheck.recordset.length > 0);
        return res.json({ success: true, data: { canSetup } });
    } catch (error) {
        console.error('❌ Error checking can-setup-recurring:', error);
        res.status(500).json({ success: false, message: error.message || 'Failed to check' });
    }
});

/**
 * GET /api/payments/suggested-recurring-start?memberId=xxx
 * Returns suggested start date for recurring payment based on household's current enrollment effective dates.
 */
router.get('/suggested-recurring-start', authorize(['SysAdmin', 'TenantAdmin']), async (req, res) => {
    try {
        const { memberId } = req.query;
        if (!memberId) {
            return res.status(400).json({ success: false, message: 'memberId is required' });
        }
        const pool = await getPool();
        const request = pool.request();
        request.input('memberId', sql.UniqueIdentifier, memberId);
        let memberQuery = `
            SELECT m.HouseholdId, u.TenantId
            FROM oe.Members m
            INNER JOIN oe.Users u ON m.UserId = u.UserId
            WHERE m.MemberId = @memberId
        `;
        if (req.user.currentRole !== 'SysAdmin') {
            memberQuery += ' AND u.TenantId = @tenantId';
            request.input('tenantId', sql.UniqueIdentifier, req.user.TenantId);
        }
        const memberResult = await request.query(memberQuery);
        if (!memberResult.recordset || memberResult.recordset.length === 0) {
            return res.status(404).json({ success: false, message: 'Member not found' });
        }
        const { HouseholdId, TenantId } = memberResult.recordset[0];
        if (!HouseholdId) {
            return res.status(400).json({ success: false, message: 'Member has no household' });
        }
        const suggestedStartDate = await getSuggestedRecurringStartDate(pool, HouseholdId);
        return res.json({
            success: true,
            data: { suggestedStartDate }
        });
    } catch (error) {
        console.error('❌ Error getting suggested recurring start:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to get suggested start date'
        });
    }
});

/**
 * POST /api/payments/setup-recurring
 * Create a DIME recurring payment schedule for a household using stored DIME customer/payment method.
 * Body: { memberId, monthlyAmount, startDate?, cancelExisting? }. startDate YYYY-MM-DD optional; cancelExisting defaults true to cancel all pre-existing recurring schedules in DIME and update our DB.
 * TenantAdmin, SysAdmin only.
 */
router.post('/setup-recurring', authorize(['SysAdmin', 'TenantAdmin']), async (req, res) => {
    console.log('📥 [setup-recurring] Handler entered');
    try {
        console.log('📥 [setup-recurring] Request body:', { memberId: req.body?.memberId, monthlyAmount: req.body?.monthlyAmount, startDate: req.body?.startDate, cancelExisting: req.body?.cancelExisting });
        const { memberId, monthlyAmount, startDate: startDateParam, cancelExisting: cancelExistingParam } = req.body;
        const cancelExisting = cancelExistingParam !== false;
        const amount = typeof monthlyAmount === 'number' ? monthlyAmount : parseFloat(monthlyAmount);
        if (!memberId || (typeof amount !== 'number' || Number.isNaN(amount) || amount <= 0)) {
            return res.status(400).json({
                success: false,
                message: 'memberId and a positive monthlyAmount are required'
            });
        }
        console.log('📥 [setup-recurring] Validation OK, getting pool...');
        const pool = await getPool();
        console.log('📥 [setup-recurring] Got pool, querying member...');
        const request = pool.request();
        request.input('memberId', sql.UniqueIdentifier, memberId);
        let memberQuery = `
            SELECT m.MemberId, m.HouseholdId, u.TenantId
            FROM oe.Members m
            INNER JOIN oe.Users u ON m.UserId = u.UserId
            WHERE m.MemberId = @memberId
        `;
        if (req.user.currentRole !== 'SysAdmin') {
            memberQuery += ' AND u.TenantId = @tenantId';
            request.input('tenantId', sql.UniqueIdentifier, req.user.TenantId);
        }
        const memberResult = await request.query(memberQuery);
        console.log('📥 [setup-recurring] Member result:', memberResult.recordset?.length);
        if (!memberResult.recordset || memberResult.recordset.length === 0) {
            return res.status(404).json({ success: false, message: 'Member not found' });
        }
        const { HouseholdId, TenantId } = memberResult.recordset[0];
        if (!HouseholdId || !TenantId) {
            return res.status(400).json({ success: false, message: 'Member household or tenant not found' });
        }
        console.log('📥 [setup-recurring] Querying payment method...');
        const pmResult = await pool.request()
            .input('householdId', sql.UniqueIdentifier, HouseholdId)
            .query(`
                SELECT TOP 1 mpm.ProcessorCustomerId, mpm.ProcessorPaymentMethodId
                FROM oe.MemberPaymentMethods mpm
                INNER JOIN oe.Members m ON mpm.MemberId = m.MemberId
                WHERE m.HouseholdId = @householdId AND m.RelationshipType = 'P'
                  AND mpm.Status = 'Active'
                  AND mpm.ProcessorCustomerId IS NOT NULL AND mpm.ProcessorPaymentMethodId IS NOT NULL
                ORDER BY mpm.IsDefault DESC, mpm.CreatedDate DESC
            `);
        const pm = pmResult.recordset?.[0];
        if (!pm?.ProcessorCustomerId || !pm?.ProcessorPaymentMethodId) {
            return res.status(400).json({
                success: false,
                message: 'No active payment method on file with DIME customer and payment method IDs. Link the DIME customer (and payment method) first.'
            });
        }
        let startDate;
        if (startDateParam && /^\d{4}-\d{2}-\d{2}$/.test(String(startDateParam).trim())) {
            startDate = new Date(String(startDateParam).trim() + 'T00:00:00Z');
            if (isNaN(startDate.getTime())) {
                startDate = null;
            }
        }
        if (!startDate || isNaN(startDate.getTime())) {
            const suggested = await getSuggestedRecurringStartDate(pool, HouseholdId);
            startDate = new Date(suggested + 'T00:00:00Z');
        }

        // 1. Create new recurring schedule in DIME first - only cancel existing after we know the new one succeeded
        console.log('📤 [setup-recurring] Calling DIME setupRecurringPayment:', { householdId: HouseholdId, amount: Math.round(amount * 100) / 100, startDate: startDate.toISOString().slice(0, 10) });
        const recurringResult = await DimeService.setupRecurringPayment({
            customerId: pm.ProcessorCustomerId,
            paymentMethodId: pm.ProcessorPaymentMethodId,
            amount: Math.round(amount * 100) / 100,
            description: 'Monthly Payment',
            householdId: HouseholdId,
            startDate
        }, TenantId);
        console.log('📥 [setup-recurring] DIME result:', { success: recurringResult.success, scheduleId: recurringResult.scheduleId, error: recurringResult.error?.message });
        if (!recurringResult.success) {
            return res.status(400).json({
                success: false,
                message: recurringResult.error?.message || 'Failed to create recurring schedule in DIME',
                error: recurringResult.error
            });
        }

        // 2. Now cancel pre-existing schedules (only mark as cancelled in our DB if DIME cancel succeeded)
        const cancelFailures = [];
        const successfullyCancelledIds = [];
        if (cancelExisting && recurringResult.scheduleId) {
            const toCancel = [];
            try {
                const existingFromTable = await pool.request()
                    .input('householdId', sql.UniqueIdentifier, HouseholdId)
                    .query(`
                        SELECT DimeScheduleId, MonthlyAmount, NextBillingDate
                        FROM oe.IndividualRecurringSchedules
                        WHERE HouseholdId = @householdId AND IsActive = 1
                    `);
                for (const r of (existingFromTable.recordset || [])) {
                    if (String(r.DimeScheduleId) !== String(recurringResult.scheduleId)) {
                        toCancel.push({ scheduleId: r.DimeScheduleId, amount: r.MonthlyAmount, nextBillingDate: r.NextBillingDate });
                    }
                }
            } catch (tableErr) {
                if (!String(tableErr.message || '').includes('IndividualRecurringSchedules')) {
                    console.warn('⚠️ [setup-recurring] Could not query IndividualRecurringSchedules:', tableErr.message);
                }
            }
            const existingFromPayments = await pool.request()
                .input('householdId', sql.UniqueIdentifier, HouseholdId)
                .query(`
                    SELECT DISTINCT p.RecurringScheduleId, p.Amount, p.NextBillingDate
                    FROM oe.Payments p
                    WHERE p.HouseholdId = @householdId AND p.RecurringScheduleId IS NOT NULL
                `);
            for (const r of (existingFromPayments.recordset || [])) {
                const sid = String(r.RecurringScheduleId);
                if (sid !== String(recurringResult.scheduleId) && !toCancel.some(x => String(x.scheduleId) === sid)) {
                    toCancel.push({ scheduleId: sid, amount: r.Amount, nextBillingDate: r.NextBillingDate });
                }
            }
            if (toCancel.length > 0) {
                console.log('📤 [setup-recurring] Canceling', toCancel.length, 'pre-existing recurring schedule(s) in DIME');
                for (const { scheduleId, amount, nextBillingDate } of toCancel) {
                    const cancelResult = await DimeService.cancelRecurringPayment(String(scheduleId), TenantId);
                    if (cancelResult.success || cancelResult.wasAlreadyCanceled) {
                        console.log('✅ [setup-recurring] Canceled DIME schedule:', scheduleId);
                        successfullyCancelledIds.push(String(scheduleId));
                        try {
                            const updateResult = await pool.request()
                                .input('householdId', sql.UniqueIdentifier, HouseholdId)
                                .input('dimeScheduleId', sql.NVarChar(255), String(scheduleId))
                                .query(`
                                    UPDATE oe.IndividualRecurringSchedules
                                    SET IsActive = 0, CancelledDate = GETUTCDATE(), ModifiedDate = GETUTCDATE()
                                    WHERE HouseholdId = @householdId AND DimeScheduleId = @dimeScheduleId
                                `);
                            if (updateResult.rowsAffected[0] === 0) {
                                await pool.request()
                                    .input('householdId', sql.UniqueIdentifier, HouseholdId)
                                    .input('tenantId', sql.UniqueIdentifier, TenantId)
                                    .input('dimeScheduleId', sql.NVarChar(255), String(scheduleId))
                                    .input('monthlyAmount', sql.Decimal(10, 2), amount || 0)
                                    .input('nextBillingDate', sql.DateTime2, nextBillingDate)
                                    .query(`
                                        INSERT INTO oe.IndividualRecurringSchedules (HouseholdId, TenantId, DimeScheduleId, MonthlyAmount, NextBillingDate, IsActive, CancelledDate, CreatedDate, ModifiedDate)
                                        VALUES (@householdId, @tenantId, @dimeScheduleId, @monthlyAmount, @nextBillingDate, 0, GETUTCDATE(), GETUTCDATE(), GETUTCDATE())
                                    `);
                            }
                        } catch (tableErr) {
                            if (!String(tableErr.message || '').includes('IndividualRecurringSchedules')) {
                                console.warn('⚠️ [setup-recurring] IndividualRecurringSchedules update failed:', tableErr.message);
                            }
                        }
                    } else {
                        console.error('❌ [setup-recurring] Failed to cancel DIME schedule (NOT updating our DB):', scheduleId, cancelResult.error);
                        cancelFailures.push({ scheduleId, error: cancelResult.error || 'Unknown error' });
                    }
                }
                // Only clear RecurringScheduleId in oe.Payments for schedules we successfully cancelled in DIME
                for (const sid of successfullyCancelledIds) {
                    await pool.request()
                        .input('householdId', sql.UniqueIdentifier, HouseholdId)
                        .input('scheduleId', sql.NVarChar(255), sid)
                        .query(`
                            UPDATE oe.Payments
                            SET RecurringScheduleId = NULL, NextBillingDate = NULL, ModifiedDate = GETUTCDATE()
                            WHERE HouseholdId = @householdId AND RecurringScheduleId = @scheduleId
                        `);
                }
            }
        }
        let insertDbError = null;
        if (recurringResult.scheduleId) {
            const roundedAmount = Math.round(amount * 100) / 100;
            try {
                await pool.request()
                    .input('householdId', sql.UniqueIdentifier, HouseholdId)
                    .input('tenantId', sql.UniqueIdentifier, TenantId)
                    .input('dimeScheduleId', sql.NVarChar(255), String(recurringResult.scheduleId))
                    .input('monthlyAmount', sql.Decimal(10, 2), roundedAmount)
                    .input('nextBillingDate', sql.DateTime2, startDate)
                    .query(`
                        INSERT INTO oe.IndividualRecurringSchedules (HouseholdId, TenantId, DimeScheduleId, MonthlyAmount, NextBillingDate, IsActive, CreatedDate, ModifiedDate)
                        VALUES (@householdId, @tenantId, @dimeScheduleId, @monthlyAmount, @nextBillingDate, 1, GETUTCDATE(), GETUTCDATE())
                    `);
            } catch (insertErr) {
                insertDbError = insertErr.message || String(insertErr);
                console.error('❌ [setup-recurring] Failed to insert into IndividualRecurringSchedules:', insertDbError);
            }
            const updateResult = await PaymentDatabaseService.setLatestSuccessfulRecurringSchedule({
                householdId: HouseholdId,
                recurringScheduleId: recurringResult.scheduleId,
                nextBillingDate: startDate
            });
            if (updateResult && updateResult.rowsAffected && updateResult.rowsAffected[0] === 0) {
                await PaymentDatabaseService.insertRecurringSchedulePlaceholder({
                    householdId: HouseholdId,
                    recurringScheduleId: recurringResult.scheduleId,
                    nextBillingDate: startDate,
                    amount: roundedAmount,
                    tenantId: TenantId
                });
            }
        }
        const responseData = {
            scheduleId: recurringResult.scheduleId,
            nextBillingDate: startDate.toISOString().slice(0, 10)
        };
        if (cancelFailures.length > 0) {
            responseData.cancelFailures = cancelFailures;
            responseData.warning = `${cancelFailures.length} existing schedule(s) could not be cancelled in DIME. They may still be active. Check DIME or contact support.`;
        }
        if (insertDbError) {
            responseData.insertDbError = insertDbError;
            responseData.warning = (responseData.warning ? responseData.warning + ' ' : '') + 'New schedule created in DIME but failed to save to our database.';
        }
        posthog.capture({
            distinctId: String(req.user.UserId || req.user.userId || 'unknown'),
            event: 'recurring payment setup',
            properties: {
                member_id: memberId,
                schedule_id: recurringResult.scheduleId ? String(recurringResult.scheduleId) : undefined,
                amount,
                tenant_id: TenantId ? String(TenantId) : undefined,
                start_date: startDate ? startDate.toISOString().slice(0, 10) : undefined,
            },
        });

        return res.json({
            success: true,
            message: 'Recurring payment schedule created',
            data: responseData
        });
    } catch (error) {
        console.error('❌ Error setting up recurring:', error);
        return res.status(500).json({
            success: false,
            message: error.message || 'Failed to set up recurring payment'
        });
    }
});

/**
 * GET /api/payments/tenant/:tenantId
 * Get payments for a specific tenant (SysAdmin access only)
 */
router.get('/tenant/:tenantId', authorize(['SysAdmin']), async (req, res) => {
    try {
        const { tenantId } = req.params;
        
        const pool = await getPool();
        
        // Get tenant's payment history
        const paymentsQuery = `
            SELECT 
                p.PaymentId,
                p.Amount,
                p.PaymentDate,
                p.Status,
                p.PaymentMethod,
                p.TransactionType,
                p.ProcessorTransactionId,
                p.FailureReason,
                p.ACHReturnCode,
                p.ACHReturnReason,
                p.ChargebackReason,
                p.OriginalPaymentId,
                p.GroupId,
                p.TenantId,
                p.CreatedDate,
                p.ModifiedDate,
                g.Name as GroupName
            FROM oe.Payments p
            LEFT JOIN oe.Groups g ON p.GroupId = g.GroupId
            WHERE p.TenantId = @tenantId
            ORDER BY p.PaymentDate DESC
        `;
        
        const request = pool.request();
        request.input('tenantId', sql.UniqueIdentifier, tenantId);
        
        const payments = await request.query(paymentsQuery);
        
        res.json({
            success: true,
            data: payments.recordset
        });
    } catch (error) {
        console.error('Error fetching tenant payments:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch tenant payments',
            error: error.message
        });
    }
});

/**
 * GET /api/payments/:paymentId/receipt/pdf
 * PDF receipt for a successful payment (member portal + staff). Inline like invoice PDF; ?download=1 for attachment.
 */
router.get(
    '/:paymentId/receipt/pdf',
    authorize(['SysAdmin', 'TenantAdmin', 'Agent', 'AgencyOwner', 'GroupAdmin', 'Member']),
    async (req, res) => {
        try {
            const { paymentId } = req.params;
            const pool = await getPool();
            const request = pool.request();
            request.input('paymentId', sql.UniqueIdentifier, paymentId);

            const loadResult = await request.query(`
                SELECT
                    p.PaymentId,
                    p.TenantId,
                    p.HouseholdId,
                    p.GroupId,
                    p.InvoiceId,
                    p.Amount,
                    p.PaymentDate,
                    p.Status,
                    p.PaymentMethod,
                    p.ProcessorTransactionId,
                    i.InvoiceId AS InvId,
                    i.InvoiceNumber,
                    i.InvoiceType,
                    i.Status AS InvoiceRowStatus,
                    i.TotalAmount AS InvoiceTotalAmount,
                    i.PaidAmount,
                    i.CreditAmount,
                    i.BalanceDue,
                    i.BillingPeriodStart,
                    i.BillingPeriodEnd,
                    i.DueDate,
                    i.InvoiceDate,
                    i.CreatedDate AS InvoiceCreatedDate,
                    i.HouseholdId AS InvoiceHouseholdId,
                    i.SubTotal,
                    i.TaxAmount,
                    u.FirstName AS BillToFirstName,
                    u.LastName AS BillToLastName,
                    pm.Address AS BillToAddress,
                    pm.City AS BillToCity,
                    pm.State AS BillToState,
                    pm.Zip AS BillToZip,
                    t.Name AS TenantName,
                    t.PrimaryAddress AS TenantAddress,
                    t.PrimaryCity AS TenantCity,
                    t.PrimaryState AS TenantState,
                    t.PrimaryZip AS TenantZip,
                    COALESCE(
                        NULLIF(LTRIM(RTRIM(ISNULL(t.CustomLogoUrl, ''))), ''),
                        NULLIF(LTRIM(RTRIM(ISNULL(json_value(t.AdvancedSettings, '$.branding.logoUrl'), ''))), '')
                    ) AS TenantLogoUrl
                FROM oe.Payments p
                INNER JOIN oe.Tenants t ON p.TenantId = t.TenantId
                LEFT JOIN oe.Invoices i ON i.InvoiceId = p.InvoiceId
                LEFT JOIN oe.Members pm ON p.HouseholdId = pm.HouseholdId AND pm.RelationshipType = N'P'
                LEFT JOIN oe.Users u ON pm.UserId = u.UserId
                WHERE p.PaymentId = @paymentId
            `);

            if (!loadResult.recordset || loadResult.recordset.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Resource not found or access denied'
                });
            }

            const row = loadResult.recordset[0];
            const allowed = await assertPaymentReceiptPdfAccess(pool, row, req);
            if (!allowed) {
                return res.status(404).json({
                    success: false,
                    message: 'Resource not found or access denied'
                });
            }

            if (!isSuccessfulPaymentRecordStatus(row.Status)) {
                return res.status(400).json({
                    success: false,
                    message: 'Receipt is only available for successful payments.'
                });
            }

            const tenantLogoBuffer = await prepareTenantLogoBufferForPdf(row.TenantLogoUrl);
            const billToName = [row.BillToFirstName, row.BillToLastName].filter(Boolean).join(' ') || 'Member';
            const billTo = {
                name: billToName,
                addressLine1: row.BillToAddress || '',
                cityStateZip: [row.BillToCity, row.BillToState, row.BillToZip].filter(Boolean).join(', ')
            };

            const tenantBlock = {
                Name: row.TenantName,
                PrimaryAddress: row.TenantAddress,
                PrimaryCity: row.TenantCity,
                PrimaryState: row.TenantState,
                PrimaryZip: row.TenantZip
            };

            const methodSummary = buildPaymentReceiptMethodSummary(row);

            let doc;
            let filenameBase;

            if (row.InvId) {
                if (row.InvoiceType !== 'Individual') {
                    return res.status(404).json({
                        success: false,
                        message: 'Resource not found or access denied'
                    });
                }

                const invoiceRow = {
                    InvoiceId: row.InvId,
                    InvoiceNumber: row.InvoiceNumber,
                    TotalAmount: row.InvoiceTotalAmount,
                    SubTotal: row.SubTotal,
                    TaxAmount: row.TaxAmount != null ? row.TaxAmount : 0,
                    /* oe.Invoices has no PaymentTerms in all deployments; receipt PDF omits terms anyway */
                    PaymentTerms: 30,
                    Status: row.InvoiceRowStatus,
                    BalanceDue: row.BalanceDue,
                    HouseholdId: row.InvoiceHouseholdId
                };

                const billingDate = new Date(row.InvoiceDate || row.InvoiceCreatedDate);
                const dueDate = new Date(row.DueDate);
                const billingPeriodStart = new Date(row.BillingPeriodStart);
                const billingPeriodEnd = new Date(row.BillingPeriodEnd);

                const { lines: pdfSimpleLines } = await invoiceService.getIndividualInvoicePdfLineItems(
                    pool,
                    row.InvoiceHouseholdId,
                    billingPeriodStart,
                    billingPeriodEnd
                );

                const balanceDue = parseFloat(row.BalanceDue);
                const invoicePaidInFull =
                    String(row.InvoiceRowStatus || '').trim() === 'Paid' ||
                    (Number.isFinite(balanceDue) && Math.abs(balanceDue) < 0.005);

                doc = generateInvoicePdf({
                    invoice: invoiceRow,
                    locationResults: [],
                    billTo,
                    tenant: tenantBlock,
                    billingDate,
                    dueDate,
                    billingPeriodStart,
                    billingPeriodEnd,
                    title: 'INVOICE',
                    invoiceNumber: row.InvoiceNumber,
                    isSample: false,
                    simpleLineItems: pdfSimpleLines.length > 0 ? pdfSimpleLines : undefined,
                    tenantLogoBuffer,
                    documentKind: 'payment_receipt',
                    paymentReceipt: {
                        paymentAmount: row.Amount,
                        paymentDate: row.PaymentDate,
                        paymentMethodSummary: methodSummary,
                        processorTransactionId: row.ProcessorTransactionId,
                        invoiceBalanceDue: balanceDue,
                        invoicePaidInFull,
                        minimalStandalone: false
                    }
                });
                filenameBase = `receipt-${row.InvoiceNumber || paymentId}`;
            } else {
                const payDate = new Date(row.PaymentDate);
                const invoiceStub = {
                    TotalAmount: row.Amount,
                    SubTotal: row.Amount,
                    TaxAmount: 0,
                    PaymentTerms: 0
                };
                doc = generateInvoicePdf({
                    invoice: invoiceStub,
                    locationResults: [],
                    billTo,
                    tenant: tenantBlock,
                    billingDate: payDate,
                    dueDate: payDate,
                    billingPeriodStart: payDate,
                    billingPeriodEnd: payDate,
                    title: 'INVOICE',
                    invoiceNumber: String(row.PaymentId || paymentId).replace(/-/g, ''),
                    isSample: false,
                    simpleLineItems: [
                        {
                            description: 'Payment received',
                            quantity: 1,
                            amount: parseFloat(row.Amount)
                        }
                    ],
                    tenantLogoBuffer,
                    documentKind: 'payment_receipt',
                    paymentReceipt: {
                        paymentAmount: row.Amount,
                        paymentDate: row.PaymentDate,
                        paymentMethodSummary: methodSummary,
                        processorTransactionId: row.ProcessorTransactionId,
                        minimalStandalone: true
                    }
                });
                filenameBase = `receipt-payment-${String(row.PaymentId || paymentId).replace(/-/g, '')}`;
            }

            const attachment = req.query.download === '1' || req.query.download === 'true';
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader(
                'Content-Disposition',
                `${attachment ? 'attachment' : 'inline'}; filename="${String(filenameBase).replace(/"/g, '')}.pdf"`
            );
            doc.pipe(res);
            doc.end();
        } catch (err) {
            console.error('GET /api/payments/:paymentId/receipt/pdf error:', err);
            res.status(500).json({
                success: false,
                message: 'Failed to generate payment receipt PDF',
                error: err.message
            });
        }
    }
);

/**
 * PATCH /api/payments/:paymentId
 * Body: { status: string, updateInvoice?: boolean (default false), rescheduleDimeRecurring?: boolean (default false) }
 * — manual status correction (admin; same auth as GET member payments). Optional invoice PaidAmount/Status sync.
 */
router.patch('/:paymentId', authorize(['SysAdmin', 'TenantAdmin', 'Agent', 'AgencyOwner', 'GroupAdmin']), async (req, res) => {
    try {
        const { paymentId } = req.params;
        const status = req.body && req.body.status != null ? String(req.body.status).trim() : '';
        if (!status || status.length > 80) {
            return res.status(400).json({ success: false, message: 'Invalid status' });
        }
        if (!SETTABLE_PAYMENT_STATUSES.has(status)) {
            return res.status(400).json({
                success: false,
                message: 'Status is not allowed. Use a standard payment status value.'
            });
        }

        const updateInvoice = readBodyBool(req.body && req.body.updateInvoice, false);
        const rescheduleDimeRecurring = readBodyBool(req.body && req.body.rescheduleDimeRecurring, false);

        const pool = await getPool();
        const access = await assertPaymentRowAccess(pool, paymentId, req);
        if (access.error) {
            return res.status(access.status || 403).json({
                success: false,
                message: access.error === 'not_found' ? 'Payment not found' : 'Access denied'
            });
        }

        const payReq = pool.request();
        payReq.input('paymentId', sql.UniqueIdentifier, paymentId);
        const payRes = await payReq.query(`
            SELECT p.Status, p.InvoiceId, p.Amount, p.TransactionType, p.OriginalPaymentId,
                   p.HouseholdId, p.GroupId, p.TenantId
            FROM oe.Payments p
            WHERE p.PaymentId = @paymentId
        `);
        if (!payRes.recordset || payRes.recordset.length === 0) {
            return res.status(404).json({ success: false, message: 'Payment not found' });
        }
        const payRow = payRes.recordset[0];
        const previousTrim = String(payRow.Status ?? '').trim();
        if (previousTrim === status) {
            return res.json({
                success: true,
                message: 'No change to payment status',
                invoiceSync: { applied: false, reason: 'no_status_change' }
            });
        }

        const plan = await getPaymentStatusInvoiceAdjustmentPlan(
            pool,
            sql,
            paymentId,
            payRow,
            status,
            updateInvoice
        );
        /** @type {Record<string, unknown>} */
        let invoiceSync = { ...plan.invoiceSync };

        const useTxn = Boolean(plan.kind);

        if (useTxn) {
            const transaction = pool.transaction();
            await transaction.begin();
            try {
                const upd = transaction.request();
                upd.input('paymentId', sql.UniqueIdentifier, paymentId);
                upd.input('status', sql.NVarChar(80), status);
                await upd.query(`
                    UPDATE oe.Payments
                    SET Status = @status, ModifiedDate = GETUTCDATE()
                    WHERE PaymentId = @paymentId
                `);

                const adj = await applyPaymentStatusInvoiceAdjustmentInTxn(
                    transaction,
                    sql,
                    plan.kind,
                    payRow,
                    status
                );
                invoiceSync = {
                    ...invoiceSync,
                    ...adj
                };

                await transaction.commit();
            } catch (txnErr) {
                try {
                    await transaction.rollback();
                } catch (_) {
                    /* ignore */
                }
                console.error('PATCH /api/payments/:paymentId transaction error:', txnErr);
                return res.status(500).json({
                    success: false,
                    message: txnErr.message || 'Failed to update payment and invoice'
                });
            }
        } else {
            const upd = pool.request();
            upd.input('paymentId', sql.UniqueIdentifier, paymentId);
            upd.input('status', sql.NVarChar(80), status);
            await upd.query(`
                UPDATE oe.Payments
                SET Status = @status, ModifiedDate = GETUTCDATE()
                WHERE PaymentId = @paymentId
            `);
        }

        let dimeRecurringReschedule = { skipped: true };
        if (
            rescheduleDimeRecurring &&
            plan.kind === 'sync' &&
            invoiceSync.applied &&
            !payRow.GroupId &&
            payRow.HouseholdId &&
            payRow.InvoiceId
        ) {
            try {
                dimeRecurringReschedule =
                    await invoiceService.rescheduleDimeRecurringAfterAccountingPaymentRetry(
                        pool,
                        payRow.HouseholdId,
                        payRow.TenantId,
                        String(payRow.InvoiceId)
                    );
            } catch (dimeResErr) {
                console.error('PATCH payment DIME recurring reschedule:', dimeResErr);
                dimeRecurringReschedule = {
                    skipped: false,
                    error: dimeResErr.message || String(dimeResErr)
                };
            }
        }

        let message = 'Payment status updated';
        if (invoiceSync.applied) {
            message = 'Payment status updated. Invoice balance was adjusted.';
        }

        return res.json({
            success: true,
            message,
            invoiceSync,
            ...(rescheduleDimeRecurring ? { dimeRecurringReschedule } : {})
        });
    } catch (error) {
        console.error('PATCH /api/payments/:paymentId error:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to update payment'
        });
    }
});

/**
 * DELETE /api/payments/:paymentId
 * Removes the row (fails if FK references exist, e.g. commissions).
 * If the row counted as a successful capture and links an invoice (same rules as PATCH updateInvoice),
 * subtracts Amount from oe.Invoices.PaidAmount and recalculates Status before deleting—atomic in one transaction.
 */
router.delete('/:paymentId', authorize(['SysAdmin', 'TenantAdmin', 'Agent', 'AgencyOwner', 'GroupAdmin']), async (req, res) => {
    try {
        const { paymentId } = req.params;
        const pool = await getPool();
        const access = await assertPaymentRowAccess(pool, paymentId, req);
        if (access.error) {
            return res.status(access.status || 403).json({
                success: false,
                message: access.error === 'not_found' ? 'Payment not found' : 'Access denied'
            });
        }

        const payReq = pool.request();
        payReq.input('paymentId', sql.UniqueIdentifier, paymentId);
        const payRes = await payReq.query(`
            SELECT p.Status, p.InvoiceId, p.Amount, p.TransactionType, p.OriginalPaymentId
            FROM oe.Payments p
            WHERE p.PaymentId = @paymentId
        `);
        if (!payRes.recordset || payRes.recordset.length === 0) {
            return res.status(404).json({ success: false, message: 'Payment not found' });
        }
        const payRow = payRes.recordset[0];

        const plan = await getPaymentStatusInvoiceAdjustmentPlan(
            pool,
            sql,
            paymentId,
            payRow,
            'Failed',
            true
        );

        /** @type {Record<string, unknown>} */
        let invoiceSync = { ...plan.invoiceSync };
        const useTxn = Boolean(plan.kind);

        if (useTxn) {
            const transaction = pool.transaction();
            await transaction.begin();
            try {
                invoiceSync = {
                    ...invoiceSync,
                    ...(await applyPaymentStatusInvoiceAdjustmentInTxn(
                        transaction,
                        sql,
                        plan.kind,
                        payRow,
                        'Failed'
                    ))
                };

                const del = transaction.request();
                del.input('paymentId', sql.UniqueIdentifier, paymentId);
                await del.query(`DELETE FROM oe.Payments WHERE PaymentId = @paymentId`);

                await transaction.commit();
            } catch (txnErr) {
                try {
                    await transaction.rollback();
                } catch (_) {
                    /* ignore */
                }
                const msg = txnErr && txnErr.message ? String(txnErr.message) : '';
                if (msg.includes('REFERENCE') || msg.includes('constraint') || msg.includes('conflict')) {
                    return res.status(409).json({
                        success: false,
                        message: 'Cannot delete this payment: it is referenced by other records (e.g. commissions).'
                    });
                }
                console.error('DELETE /api/payments/:paymentId transaction error:', txnErr);
                return res.status(500).json({
                    success: false,
                    message: txnErr.message || 'Failed to delete payment'
                });
            }
        } else {
            const del = pool.request();
            del.input('paymentId', sql.UniqueIdentifier, paymentId);
            try {
                await del.query(`DELETE FROM oe.Payments WHERE PaymentId = @paymentId`);
            } catch (dbErr) {
                const msg = dbErr && dbErr.message ? String(dbErr.message) : '';
                if (msg.includes('REFERENCE') || msg.includes('constraint') || msg.includes('conflict')) {
                    return res.status(409).json({
                        success: false,
                        message: 'Cannot delete this payment: it is referenced by other records (e.g. commissions).'
                    });
                }
                throw dbErr;
            }
        }

        res.json({ success: true, message: 'Payment deleted', invoiceSync });
    } catch (error) {
        console.error('DELETE /api/payments/:paymentId error:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to delete payment'
        });
    }
});

module.exports = router;
