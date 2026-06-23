// Mounted at /api/me/tenant-admin/members/:memberId/direct-deposits
//
// List/create/activate/deactivate/reveal direct-deposit (ACH reimbursement)
// records for a member. Read access: TenantAdmin, TenantAccounting, SysAdmin.
// Reveal: TenantAdmin, TenantAccounting, SysAdmin only — and an audit log
// row is written for every successful reveal.

const express = require('express');
const router = express.Router({ mergeParams: true });
const { authorize, getUserRoles } = require('../../../middleware/auth');
const { getPool, sql } = require('../../../config/database');
const memberDirectDepositService = require('../../../services/memberDirectDepositService');

const READ_ROLES = ['TenantAdmin', 'TenantAccounting', 'SysAdmin'];
const WRITE_ROLES = ['TenantAdmin', 'TenantAccounting', 'SysAdmin'];

/** Resolve the tenant scope for the request (mirrors override-ach-accounts pattern). */
function resolveTargetTenantId(req) {
    const userRoles = getUserRoles(req.user);
    if (userRoles.includes('SysAdmin')) {
        return req.query.tenantId || req.user.currentTenantId || req.user.TenantId || null;
    }
    return req.user.currentTenantId || req.user.TenantId || null;
}

/** Verify that :memberId belongs to the resolved tenant before doing anything. */
async function assertMemberInTenant(tenantId, memberId) {
    const pool = await getPool();
    const r = await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('memberId', sql.UniqueIdentifier, memberId)
        .query(`
            SELECT 1 AS Found FROM oe.Members
            WHERE TenantId = @tenantId AND MemberId = @memberId
        `);
    return r.recordset.length === 1;
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
        // Audit failure must never block the user's action — log and move on.
        console.warn('member-direct-deposits: audit log write failed', e.message);
    }
}

/**
 * GET /
 * List all direct-deposit records for a member (last4-only).
 */
router.get('/', authorize(READ_ROLES), async (req, res) => {
    try {
        const tenantId = resolveTargetTenantId(req);
        if (!tenantId) {
            return res.status(400).json({ success: false, message: 'tenantId is required' });
        }
        const { memberId } = req.params;
        if (!await assertMemberInTenant(tenantId, memberId)) {
            return res.status(404).json({ success: false, message: 'Member not found in tenant' });
        }
        const rows = await memberDirectDepositService.listForMember({ memberId, tenantId, includeInactive: true });
        res.json({ success: true, data: rows });
    } catch (err) {
        console.error('GET member-direct-deposits failed:', err);
        res.status(500).json({ success: false, message: 'Failed to load direct deposits' });
    }
});

/**
 * POST /
 * Manual create. Becomes Active; rotates any prior Active to Inactive.
 */
router.post('/', authorize(WRITE_ROLES), async (req, res) => {
    try {
        const tenantId = resolveTargetTenantId(req);
        if (!tenantId) {
            return res.status(400).json({ success: false, message: 'tenantId is required' });
        }
        const { memberId } = req.params;
        if (!await assertMemberInTenant(tenantId, memberId)) {
            return res.status(404).json({ success: false, message: 'Member not found in tenant' });
        }

        const { accountHolderName, bankName, bankAccountType, routingNumber, accountNumber } = req.body || {};
        const result = await memberDirectDepositService.createManual({
            memberId, tenantId,
            accountHolderName, bankName, bankAccountType, routingNumber, accountNumber,
            actorUserId: req.user.UserId
        });

        await writeAuditLog({
            userId: req.user.UserId,
            tenantId,
            action: 'MemberDirectDeposit.Create',
            entityId: result.directDepositId,
            details: { memberId, source: 'TenantAdminEntry' },
            req
        });

        res.status(201).json({ success: true, data: result });
    } catch (err) {
        const status = err.statusCode || 400;
        console.warn('POST member-direct-deposits failed:', err.message);
        res.status(status).json({ success: false, message: err.message || 'Failed to create direct deposit' });
    }
});

/**
 * PATCH /:directDepositId/activate
 * Make a historical row the active one again.
 */
router.patch('/:directDepositId/activate', authorize(WRITE_ROLES), async (req, res) => {
    try {
        const tenantId = resolveTargetTenantId(req);
        if (!tenantId) {
            return res.status(400).json({ success: false, message: 'tenantId is required' });
        }
        const { memberId, directDepositId } = req.params;
        if (!await assertMemberInTenant(tenantId, memberId)) {
            return res.status(404).json({ success: false, message: 'Member not found in tenant' });
        }
        const updated = await memberDirectDepositService.setActive({
            directDepositId, tenantId, actorUserId: req.user.UserId
        });
        await writeAuditLog({
            userId: req.user.UserId,
            tenantId,
            action: 'MemberDirectDeposit.Activate',
            entityId: directDepositId,
            details: { memberId },
            req
        });
        res.json({ success: true, data: updated });
    } catch (err) {
        const status = err.statusCode || 500;
        res.status(status).json({ success: false, message: err.message || 'Failed to activate direct deposit' });
    }
});

/**
 * PATCH /:directDepositId/deactivate
 * Mark active row inactive without activating any other.
 */
router.patch('/:directDepositId/deactivate', authorize(WRITE_ROLES), async (req, res) => {
    try {
        const tenantId = resolveTargetTenantId(req);
        if (!tenantId) {
            return res.status(400).json({ success: false, message: 'tenantId is required' });
        }
        const { memberId, directDepositId } = req.params;
        if (!await assertMemberInTenant(tenantId, memberId)) {
            return res.status(404).json({ success: false, message: 'Member not found in tenant' });
        }
        const updated = await memberDirectDepositService.deactivate({
            directDepositId, tenantId, actorUserId: req.user.UserId
        });
        await writeAuditLog({
            userId: req.user.UserId,
            tenantId,
            action: 'MemberDirectDeposit.Deactivate',
            entityId: directDepositId,
            details: { memberId },
            req
        });
        res.json({ success: true, data: updated });
    } catch (err) {
        const status = err.statusCode || 500;
        res.status(status).json({ success: false, message: err.message || 'Failed to deactivate direct deposit' });
    }
});

/**
 * GET /:directDepositId/reveal
 * Returns full account/routing numbers. Audit-logged.
 * Limited to TenantAdmin/TenantAccounting/SysAdmin per design decision.
 */
router.get('/:directDepositId/reveal', authorize(['TenantAdmin', 'TenantAccounting', 'SysAdmin']), async (req, res) => {
    try {
        const tenantId = resolveTargetTenantId(req);
        if (!tenantId) {
            return res.status(400).json({ success: false, message: 'tenantId is required' });
        }
        const { memberId, directDepositId } = req.params;
        if (!await assertMemberInTenant(tenantId, memberId)) {
            return res.status(404).json({ success: false, message: 'Member not found in tenant' });
        }
        const row = await memberDirectDepositService.getById({ directDepositId, tenantId });
        if (!row || String(row.MemberId).toLowerCase() !== String(memberId).toLowerCase()) {
            return res.status(404).json({ success: false, message: 'Direct deposit not found for member' });
        }
        const decrypted = memberDirectDepositService.decryptRow(row);

        await writeAuditLog({
            userId: req.user.UserId,
            tenantId,
            action: 'MemberDirectDeposit.Reveal',
            entityId: directDepositId,
            details: { memberId, last4: row.AccountNumberLast4 },
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
        console.error('reveal member-direct-deposits failed:', err);
        res.status(500).json({ success: false, message: 'Failed to reveal direct deposit' });
    }
});

module.exports = router;
