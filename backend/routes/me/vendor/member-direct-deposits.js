// Mounted at /api/me/vendor/members/:memberId/direct-deposits
//
// Read-only view of a member's direct-deposit records for the vendor back
// office. Vendor must have an active enrollment with the member's product to
// see anything. Reveal is audit-logged.

const express = require('express');
const router = express.Router({ mergeParams: true });
const { authorize } = require('../../../middleware/auth');
const { attachVendorContext } = require('../../../middleware/shareRequestAccess');
const { getPool, sql } = require('../../../config/database');
const memberDirectDepositService = require('../../../services/memberDirectDepositService');

const READ_ROLES = ['VendorAdmin', 'VendorAgent', 'SysAdmin'];
const REVEAL_ROLES = ['VendorAdmin', 'SysAdmin'];

router.use(attachVendorContext);

/**
 * Confirm the member is in this vendor's scope. The same gate
 * `/api/me/vendor/members/:id` uses — at least one enrollment whose product is
 * owned by the calling vendor. Returns the household-primary's MemberId
 * (where DD records actually live, per design decision #2).
 */
async function resolveScopedHouseholdPrimary(vendorId, memberId) {
    const pool = await getPool();
    const r = await pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .input('memberId', sql.UniqueIdentifier, memberId)
        .query(`
            SELECT TOP 1
                m.TenantId AS TenantId,
                COALESCE(p.MemberId, m.MemberId) AS PrimaryMemberId
            FROM oe.Members m
            INNER JOIN oe.Enrollments e ON e.MemberId = m.MemberId
            INNER JOIN oe.Products prd ON prd.ProductId = e.ProductId
            LEFT JOIN oe.Members p
                ON p.HouseholdId = m.HouseholdId
                AND p.TenantId = m.TenantId
                AND p.RelationshipType = 'P'
            WHERE m.MemberId = @memberId
              AND prd.VendorId = @vendorId
        `);
    return r.recordset[0] || null;
}

async function writeAuditLog({ userId, tenantId, action, entityId, details, req }) {
    try {
        const pool = await getPool();
        await pool.request()
            .input('userId', sql.UniqueIdentifier, userId || null)
            .input('tenantId', sql.UniqueIdentifier, tenantId)
            .input('action', sql.NVarChar(100), action)
            .input('entityType', sql.NVarChar(50), 'MemberDirectDeposit')
            .input('entityId', sql.UniqueIdentifier, entityId)
            .input('details', sql.NVarChar(sql.MAX), details ? JSON.stringify(details) : null)
            .input('ipAddress', sql.NVarChar(64), (req.ip || '').slice(0, 64))
            .input('userAgent', sql.NVarChar(500), (req.headers['user-agent'] || '').slice(0, 500))
            .query(`
                INSERT INTO oe.AuditLogs (
                    AuditLogId, UserId, TenantId, Action, EntityType, EntityId,
                    Details, IpAddress, UserAgent, CreatedDate
                ) VALUES (
                    NEWID(), @userId, @tenantId, @action, @entityType, @entityId,
                    @details, @ipAddress, @userAgent, SYSUTCDATETIME()
                )
            `);
    } catch (e) {
        console.warn('vendor member-direct-deposits: audit log write failed', e.message);
    }
}

/**
 * GET /
 * List direct-deposit records (last4 only) for the member's household primary.
 */
router.get('/', authorize(READ_ROLES), async (req, res) => {
    try {
        if (!req.vendor?.VendorId) {
            return res.status(403).json({ success: false, message: 'Vendor context required' });
        }
        const { memberId } = req.params;
        const scope = await resolveScopedHouseholdPrimary(req.vendor.VendorId, memberId);
        if (!scope) {
            return res.status(404).json({ success: false, message: 'Member not found in vendor scope' });
        }
        const rows = await memberDirectDepositService.listForMember({
            memberId: scope.PrimaryMemberId,
            tenantId: scope.TenantId,
            includeInactive: true
        });
        res.json({ success: true, data: rows });
    } catch (err) {
        console.error('GET vendor member-direct-deposits failed:', err);
        res.status(500).json({ success: false, message: 'Failed to load direct deposits' });
    }
});

/**
 * GET /:directDepositId/reveal
 * Returns full account/routing numbers. Audit-logged.
 */
router.get('/:directDepositId/reveal', authorize(REVEAL_ROLES), async (req, res) => {
    try {
        if (!req.vendor?.VendorId) {
            return res.status(403).json({ success: false, message: 'Vendor context required' });
        }
        const { memberId, directDepositId } = req.params;
        const scope = await resolveScopedHouseholdPrimary(req.vendor.VendorId, memberId);
        if (!scope) {
            return res.status(404).json({ success: false, message: 'Member not found in vendor scope' });
        }
        const row = await memberDirectDepositService.getById({
            directDepositId,
            tenantId: scope.TenantId
        });
        if (!row || String(row.MemberId).toLowerCase() !== String(scope.PrimaryMemberId).toLowerCase()) {
            return res.status(404).json({ success: false, message: 'Direct deposit not found for member' });
        }
        const decrypted = memberDirectDepositService.decryptRow(row);

        await writeAuditLog({
            userId: req.user.UserId,
            tenantId: scope.TenantId,
            action: 'MemberDirectDeposit.Reveal',
            entityId: directDepositId,
            details: {
                memberId: scope.PrimaryMemberId,
                vendorId: req.vendor.VendorId,
                via: 'vendor-portal',
                last4: row.AccountNumberLast4
            },
            req
        });

        res.json({
            success: true,
            data: {
                DirectDepositId: decrypted.DirectDepositId,
                MemberId: decrypted.MemberId,
                AccountHolderName: decrypted.AccountHolderName,
                BankName: decrypted.BankName,
                BankAccountType: decrypted.BankAccountType,
                AccountNumber: decrypted.AccountNumber,
                RoutingNumber: decrypted.RoutingNumber,
                AccountNumberLast4: decrypted.AccountNumberLast4,
                RoutingNumberLast4: decrypted.RoutingNumberLast4,
                IsActive: decrypted.IsActive,
                CreatedDate: decrypted.CreatedDate
            }
        });
    } catch (err) {
        console.error('vendor reveal direct-deposit failed:', err);
        res.status(500).json({ success: false, message: 'Failed to reveal direct deposit' });
    }
});

module.exports = router;
