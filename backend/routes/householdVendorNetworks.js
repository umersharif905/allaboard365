const express = require('express');
const router = express.Router();
const { getPool, sql, rawSql } = require('../config/database');
const { authorize, requireTenantAccess, getUserRoles } = require('../middleware/auth');
const { applyHouseholdVendorNetworkSelections } = require('../services/householdVendorNetworks.service');

// ============================================================================
// Household Vendor Networks
//
// Per-household chosen network for a given vendor. Used for INDIVIDUAL members
// (no GroupId). When a member belongs to a group, the group's selection in
// oe.GroupVendorNetworks takes precedence and these rows are ignored.
//
// Tenant scoping: a household is "owned" by the tenant of its primary member.
// Every write/read verifies the caller's tenant matches at least one of the
// household's members (SysAdmin bypasses the check).
// ============================================================================

/**
 * Verify the caller can act on this household.
 * Returns the verified primary member's TenantId, or null if access is denied.
 */
async function resolveHouseholdTenant(pool, householdId, req) {
    const userRoles = getUserRoles(req.user);
    const isSysAdmin = Array.isArray(userRoles) && userRoles.includes('SysAdmin');

    const memberCheck = await pool.request()
        .input('householdId', sql.UniqueIdentifier, householdId)
        .query(`
            SELECT TOP 1 TenantId
            FROM oe.Members
            WHERE HouseholdId = @householdId
            ORDER BY CASE WHEN RelationshipType = 'P' THEN 0 ELSE 1 END
        `);

    if (memberCheck.recordset.length === 0) return null;
    const householdTenantId = memberCheck.recordset[0].TenantId;
    if (isSysAdmin) return householdTenantId;
    if (String(householdTenantId).toLowerCase() === String(req.user.TenantId).toLowerCase()) {
        return householdTenantId;
    }
    return null;
}

// GET /api/households/:householdId/vendor-networks - List the household's network selections
router.get(
    '/:householdId/vendor-networks',
    authorize(['SysAdmin', 'TenantAdmin', 'Agent', 'AgencyOwner']),
    requireTenantAccess,
    async (req, res) => {
        try {
            const { householdId } = req.params;
            const pool = await getPool();

            const tenantId = await resolveHouseholdTenant(pool, householdId, req);
            if (!tenantId) {
                return res.status(404).json({ success: false, message: 'Household not found or access denied' });
            }

            const result = await pool.request()
                .input('householdId', sql.UniqueIdentifier, householdId)
                .query(`
                    SELECT
                        hvn.HouseholdVendorNetworkId,
                        hvn.HouseholdId,
                        hvn.VendorId,
                        hvn.VendorNetworkId,
                        vn.Title AS NetworkTitle,
                        vn.IsDefault AS NetworkIsDefault,
                        v.VendorName
                    FROM oe.HouseholdVendorNetworks hvn
                    INNER JOIN oe.VendorNetworks vn ON hvn.VendorNetworkId = vn.VendorNetworkId
                    INNER JOIN oe.Vendors v ON hvn.VendorId = v.VendorId
                    WHERE hvn.HouseholdId = @householdId AND hvn.IsActive = 1 AND vn.IsActive = 1
                `);

            const selections = result.recordset.map((r) => ({
                householdVendorNetworkId: r.HouseholdVendorNetworkId,
                householdId: r.HouseholdId,
                vendorId: r.VendorId,
                vendorName: r.VendorName,
                vendorNetworkId: r.VendorNetworkId,
                networkTitle: r.NetworkTitle,
                networkIsDefault: r.NetworkIsDefault === true || r.NetworkIsDefault === 1
            }));

            res.json({ success: true, data: selections });
        } catch (error) {
            console.error('Error listing household vendor networks:', error);
            res.status(500).json({ success: false, message: 'Failed to list household vendor networks' });
        }
    }
);

// GET /api/households/:householdId/vendors - Vendors that have at least one
// product enrolled by any member of the household. Drives the network picker UI.
router.get(
    '/:householdId/vendors',
    authorize(['SysAdmin', 'TenantAdmin', 'Agent', 'AgencyOwner']),
    requireTenantAccess,
    async (req, res) => {
        try {
            const { householdId } = req.params;
            const pool = await getPool();

            const tenantId = await resolveHouseholdTenant(pool, householdId, req);
            if (!tenantId) {
                return res.status(404).json({ success: false, message: 'Household not found or access denied' });
            }

            const result = await pool.request()
                .input('householdId', sql.UniqueIdentifier, householdId)
                .query(`
                    SELECT DISTINCT v.VendorId, v.VendorName
                    FROM oe.Enrollments e
                    INNER JOIN oe.Members m ON e.MemberId = m.MemberId
                    INNER JOIN oe.Products p ON e.ProductId = p.ProductId
                    INNER JOIN oe.Vendors v ON p.VendorId = v.VendorId
                    WHERE m.HouseholdId = @householdId
                      AND e.Status IN ('Active', 'Pending')
                      AND v.VendorId IS NOT NULL
                    UNION
                    SELECT DISTINCT v.VendorId, v.VendorName
                    FROM oe.Enrollments e
                    INNER JOIN oe.Members m ON e.MemberId = m.MemberId
                    INNER JOIN oe.Products pb ON e.ProductBundleID = pb.ProductId
                    INNER JOIN oe.Vendors v ON pb.VendorId = v.VendorId
                    WHERE m.HouseholdId = @householdId
                      AND e.Status IN ('Active', 'Pending')
                      AND v.VendorId IS NOT NULL
                `);

            res.json({ success: true, data: result.recordset });
        } catch (error) {
            console.error('Error listing household vendors:', error);
            res.status(500).json({ success: false, message: 'Failed to list household vendors' });
        }
    }
);

// PUT /api/households/:householdId/vendor-networks - Upsert/clear network selections for a household
// Body: { selections: { [vendorId]: vendorNetworkId | null } }
router.put(
    '/:householdId/vendor-networks',
    authorize(['SysAdmin', 'TenantAdmin', 'Agent', 'AgencyOwner']),
    requireTenantAccess,
    async (req, res) => {
        try {
            const { householdId } = req.params;
            const selections = req.body?.selections;
            if (!selections || typeof selections !== 'object' || Array.isArray(selections)) {
                return res.status(400).json({ success: false, message: 'selections object is required' });
            }

            const pool = await getPool();
            const tenantId = await resolveHouseholdTenant(pool, householdId, req);
            if (!tenantId) {
                return res.status(404).json({ success: false, message: 'Household not found or access denied' });
            }

            const transaction = new rawSql.Transaction(pool);
            await transaction.begin();
            try {
                // Admin PUT path: validate strictly. If any selection is invalid, the
                // helper logs+skips it. Surface a 400 here when nothing applied.
                const result = await applyHouseholdVendorNetworkSelections({
                    transaction,
                    householdId,
                    selections
                });
                if (result.skipped.length > 0 && result.applied === 0 && result.cleared === 0) {
                    const err = new Error(result.skipped[0].reason);
                    err.statusCode = 400;
                    throw err;
                }
                await transaction.commit();
            } catch (innerError) {
                try { await transaction.rollback(); } catch (_) { /* noop */ }
                throw innerError;
            }

            res.json({ success: true });
        } catch (error) {
            console.error('Error upserting household vendor networks:', error);
            res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Failed to update household vendor networks' });
        }
    }
);

module.exports = router;
