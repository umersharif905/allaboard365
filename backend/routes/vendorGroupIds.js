/**
 * Vendor Group ID Management Routes
 * 
 * Provides endpoints for managing vendor-specific Group IDs:
 * - GET: Retrieve Group IDs for a group/vendor
 * - POST: Manually create a Group ID
 * - PUT: Update an existing Group ID
 * - DELETE: Soft delete a Group ID
 */

const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/database');
const { authorize, getUserRoles } = require('../middleware/auth');
const VendorGroupIdService = require('../services/vendorGroupIdService');
const { appendGroupScopeForTenantUsers, GROUP_DETAIL_READ_STATUS_SQL } = require('../utils/groupRouteAccess');

/**
 * GET /api/vendor-group-ids/group/:groupId/vendors
 * Get vendors that have at least one product in this group. Dedicated endpoint so the Vendor Group IDs tab can load its dropdown independently.
 */
router.get('/group/:groupId/vendors', authorize(['SysAdmin', 'TenantAdmin', 'GroupAdmin', 'Agent']), async (req, res) => {
    try {
        const { groupId } = req.params;
        const pool = await getPool();
        const userRoles = getUserRoles(req.user);

        let groupCheckQuery = `
            SELECT g.GroupId, g.TenantId FROM oe.Groups g
            WHERE g.GroupId = @groupId AND ${GROUP_DETAIL_READ_STATUS_SQL}
        `;
        const groupCheckRequest = pool.request();
        groupCheckRequest.input('groupId', sql.UniqueIdentifier, groupId);
        groupCheckQuery = appendGroupScopeForTenantUsers(groupCheckQuery, groupCheckRequest, req, userRoles);
        const groupResult = await groupCheckRequest.query(groupCheckQuery);
        if (groupResult.recordset.length === 0) {
            return res.status(404).json({ success: false, message: 'Group not found or access denied' });
        }

        // Ensure GroupProduct rows exist for products inside bundles so vendors from bundle components (e.g. ARM) show on first load
        const userId = req.user?.UserId || req.user?.userId;
        await VendorGroupIdService.ensureGroupProductsForBundleComponents(groupId, userId);

        const result = await pool.request()
            .input('groupId', sql.UniqueIdentifier, groupId)
            .query(`
                SELECT DISTINCT v.VendorId, v.VendorName
                FROM oe.GroupProducts gp
                INNER JOIN oe.Products p ON gp.ProductId = p.ProductId
                INNER JOIN oe.Vendors v ON p.VendorId = v.VendorId
                WHERE gp.GroupId = @groupId AND gp.IsActive = 1 AND p.VendorId IS NOT NULL
                UNION
                SELECT DISTINCT v.VendorId, v.VendorName
                FROM oe.GroupProductVendorGroupIds vgi
                INNER JOIN oe.Vendors v ON vgi.VendorId = v.VendorId
                WHERE vgi.GroupId = @groupId AND vgi.IsActive = 1
                ORDER BY VendorName
            `);
        const seen = new Set();
        const vendors = (result.recordset || [])
            .filter((r) => {
                const key = (r.VendorId || '').toString();
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            })
            .map((r) => ({ VendorId: r.VendorId, Id: r.VendorId, VendorName: r.VendorName }));
        vendors.sort((a, b) => (a.VendorName || '').localeCompare(b.VendorName || ''));
        res.json({ success: true, data: vendors });
    } catch (error) {
        console.error('Error fetching group vendors for vendor-group-ids:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch vendors' });
    }
});

/**
 * GET /api/vendor-group-ids/group/:groupId/vendor/:vendorId
 * Get all Group IDs for a group and vendor
 */
router.get('/group/:groupId/vendor/:vendorId', authorize(['SysAdmin', 'TenantAdmin', 'GroupAdmin', 'Agent']), async (req, res) => {
    try {
        const { groupId, vendorId } = req.params;
        
        const result = await VendorGroupIdService.getGroupVendorGroupIds(groupId, vendorId);
        
        if (!result.success) {
            return res.status(404).json({
                success: false,
                message: result.error
            });
        }
        
        res.json({
            success: true,
            data: result.groupIds
        });
        
    } catch (error) {
        console.error('❌ Error fetching Group IDs:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch Group IDs',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * GET /api/vendor-group-ids/group-product/:groupProductId/vendor/:vendorId
 * Get Group ID for a specific GroupProduct and vendor
 */
router.get('/group-product/:groupProductId/vendor/:vendorId', authorize(['SysAdmin', 'TenantAdmin', 'GroupAdmin', 'Agent']), async (req, res) => {
    try {
        const { groupProductId, vendorId } = req.params;
        
        const result = await VendorGroupIdService.getVendorGroupId(groupProductId, vendorId);
        
        if (!result.success) {
            return res.status(404).json({
                success: false,
                message: result.error
            });
        }
        
        res.json({
            success: true,
            data: {
                vendorGroupId: result.vendorGroupId,
                productType: result.productType
            }
        });
        
    } catch (error) {
        console.error('❌ Error fetching Group ID:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch Group ID',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * GET /api/vendor-group-ids/group/:groupId/generate
 * Preview proposed vendor group IDs for the group. Optional ?vendorId= to limit to one vendor.
 */
router.get('/group/:groupId/generate', authorize(['SysAdmin', 'TenantAdmin']), async (req, res) => {
    try {
        const { groupId } = req.params;
        const vendorId = req.query.vendorId || null;
        const userId = req.user?.UserId || req.user?.userId;
        await VendorGroupIdService.ensureGroupProductsForBundleComponents(groupId, userId);
        if (vendorId) {
            await VendorGroupIdService.ensureGroupProductsForVendorProducts(groupId, vendorId, userId);
        }
        const result = await VendorGroupIdService.previewGenerateForGroup(groupId, vendorId);
        if (!result.success) {
            return res.status(400).json({ success: false, message: result.error });
        }
        res.json({ success: true, data: result.preview });
    } catch (error) {
        console.error('❌ Error previewing generate group IDs:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to preview group IDs',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * POST /api/vendor-group-ids/group/:groupId/generate
 * Create vendor group IDs for group products that don't have one. Body: { vendorId?: string }.
 */
router.post('/group/:groupId/generate', authorize(['SysAdmin', 'TenantAdmin']), async (req, res) => {
    try {
        const { groupId } = req.params;
        const { vendorId } = req.body || {};
        const userId = req.user?.UserId || req.user?.userId;
        const result = await VendorGroupIdService.applyGenerateForGroup(groupId, vendorId || null, userId);
        if (!result.success) {
            return res.status(400).json({ success: false, message: result.error });
        }
        res.json({
            success: true,
            message:
                `${result.created} vendor group ID(s) created` +
                (result.deactivatedAutoUntyped
                    ? `; ${result.deactivatedAutoUntyped} legacy auto product ID(s) removed (no VendorGroupIdProductType on product).`
                    : '') +
                '.',
            data: {
                created: result.created,
                errors: result.errors,
                deactivatedAutoUntyped: result.deactivatedAutoUntyped ?? 0
            }
        });
    } catch (error) {
        console.error('❌ Error applying generate group IDs:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create group IDs',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * POST /api/vendor-group-ids
 * Manually create a Group ID
 * 
 * Body: {
 *   groupId: string (required for Master Group IDs)
 *   groupProductId: string (required for product-specific Group IDs, null for Master)
 *   vendorId: string,
 *   vendorGroupId: string,
 *   productType: string (required for Master, optional for others)
 * }
 */
router.post('/', authorize(['SysAdmin', 'TenantAdmin']), async (req, res) => {
    try {
        const { groupId, groupProductId, vendorId, vendorGroupId, productType } = req.body;
        const userId = req.user?.UserId || req.user?.userId;
        
        // Validate required fields
        if (!vendorId || !vendorGroupId) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: vendorId, vendorGroupId'
            });
        }
        
        // For Master Group IDs: require groupId and productType='Master'
        if (productType === 'Master' || (!groupProductId && !productType)) {
            if (!groupId) {
                return res.status(400).json({
                    success: false,
                    message: 'Missing required field: groupId (required for Master Group IDs)'
                });
            }
            // Set productType to Master if not provided
            const finalProductType = productType || 'Master';
            const result = await VendorGroupIdService.createManualGroupId(
                groupId,
                null, // groupProductId is null for Master
                vendorId,
                vendorGroupId,
                finalProductType,
                userId
            );
            
            if (!result.success) {
                return res.status(400).json({
                    success: false,
                    message: result.error
                });
            }
            
            return res.status(201).json({
                success: true,
                message: 'Master Group ID created successfully',
                data: {
                    vendorGroupId: result.vendorGroupId,
                    productType: result.productType,
                    isAutoGenerated: result.isAutoGenerated
                }
            });
        }
        
        // For product-specific Group IDs: require groupProductId
        if (!groupProductId) {
            return res.status(400).json({
                success: false,
                message: 'Missing required field: groupProductId (required for product-specific Group IDs)'
            });
        }
        
        const result = await VendorGroupIdService.createManualGroupId(
            groupId, // May be null, will be fetched from GroupProduct
            groupProductId,
            vendorId,
            vendorGroupId,
            productType,
            userId
        );
        
        if (!result.success) {
            return res.status(400).json({
                success: false,
                message: result.error
            });
        }
        
        res.status(201).json({
            success: true,
            message: 'Group ID created successfully',
            data: {
                vendorGroupId: result.vendorGroupId,
                productType: result.productType,
                isAutoGenerated: result.isAutoGenerated
            }
        });
        
    } catch (error) {
        console.error('❌ Error creating Group ID:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create Group ID',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * PUT /api/vendor-group-ids/group-product/:groupProductId/vendor/:vendorId
 * Update an existing Group ID
 * 
 * Body: {
 *   vendorGroupId: string
 * }
 */
router.put('/group-product/:groupProductId/vendor/:vendorId', authorize(['SysAdmin', 'TenantAdmin']), async (req, res) => {
    try {
        const { groupProductId, vendorId } = req.params;
        const { vendorGroupId } = req.body;
        const userId = req.user?.UserId || req.user?.userId;
        
        if (!vendorGroupId) {
            return res.status(400).json({
                success: false,
                message: 'Missing required field: vendorGroupId'
            });
        }
        
        const result = await VendorGroupIdService.updateGroupId(
            groupProductId,
            vendorId,
            vendorGroupId,
            userId
        );
        
        if (!result.success) {
            return res.status(400).json({
                success: false,
                message: result.error
            });
        }
        
        res.json({
            success: true,
            message: 'Group ID updated successfully',
            data: {
                vendorGroupId: result.vendorGroupId
            }
        });
        
    } catch (error) {
        console.error('❌ Error updating Group ID:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update Group ID',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * PUT /api/vendor-group-ids/group/:groupId/vendor/:vendorId/master
 * Update a Master Group ID (group-level)
 * 
 * Body: {
 *   vendorGroupId: string
 * }
 */
router.put('/group/:groupId/vendor/:vendorId/master', authorize(['SysAdmin', 'TenantAdmin']), async (req, res) => {
    try {
        const { groupId, vendorId } = req.params;
        const { vendorGroupId } = req.body;
        const userId = req.user?.UserId || req.user?.userId;
        
        if (!vendorGroupId) {
            return res.status(400).json({
                success: false,
                message: 'Missing required field: vendorGroupId'
            });
        }
        
        const pool = await getPool();
        
        // Check if Master Group ID exists
        const checkResult = await pool.request()
            .input('groupId', sql.UniqueIdentifier, groupId)
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query(`
                SELECT VendorGroupId
                FROM oe.GroupProductVendorGroupIds
                WHERE GroupId = @groupId
                  AND VendorId = @vendorId
                  AND ProductType = 'Master'
                  AND GroupProductId IS NULL
                  AND IsActive = 1
            `);
        
        if (checkResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Master Group ID not found'
            });
        }
        
        // Check for duplicate VendorGroupId
        const duplicateCheck = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('vendorGroupId', sql.NVarChar(50), vendorGroupId)
            .input('groupId', sql.UniqueIdentifier, groupId)
            .query(`
                SELECT VendorGroupId
                FROM oe.GroupProductVendorGroupIds
                WHERE VendorId = @vendorId
                  AND VendorGroupId = @vendorGroupId
                  AND GroupId != @groupId
                  AND IsActive = 1
            `);
        
        if (duplicateCheck.recordset.length > 0) {
            return res.status(400).json({
                success: false,
                message: `Group ID "${vendorGroupId}" is already in use for this vendor`
            });
        }
        
        // Update the Master Group ID
        const updateResult = await pool.request()
            .input('groupId', sql.UniqueIdentifier, groupId)
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('vendorGroupId', sql.NVarChar(50), vendorGroupId)
            .input('modifiedBy', sql.UniqueIdentifier, userId)
            .query(`
                UPDATE oe.GroupProductVendorGroupIds
                SET VendorGroupId = @vendorGroupId,
                    ModifiedDate = GETDATE(),
                    ModifiedBy = @modifiedBy
                WHERE GroupId = @groupId
                  AND VendorId = @vendorId
                  AND ProductType = 'Master'
                  AND GroupProductId IS NULL
                  AND IsActive = 1
            `);
        
        res.json({
            success: true,
            message: 'Master Group ID updated successfully',
            data: {
                vendorGroupId: vendorGroupId
            }
        });
        
    } catch (error) {
        console.error('❌ Error updating Master Group ID:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update Master Group ID',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * DELETE /api/vendor-group-ids/group-product/:groupProductId/vendor/:vendorId
 * Soft delete a Group ID (set IsActive = 0)
 */
router.delete('/group-product/:groupProductId/vendor/:vendorId', authorize(['SysAdmin', 'TenantAdmin']), async (req, res) => {
    try {
        const { groupProductId, vendorId } = req.params;
        const userId = req.user?.UserId || req.user?.userId;
        const pool = await getPool();
        
        // Soft delete
        const result = await pool.request()
            .input('groupProductId', sql.UniqueIdentifier, groupProductId)
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('modifiedBy', sql.UniqueIdentifier, userId)
            .query(`
                UPDATE oe.GroupProductVendorGroupIds
                SET IsActive = 0,
                    ModifiedDate = GETDATE(),
                    ModifiedBy = @modifiedBy
                WHERE GroupProductId = @groupProductId
                  AND VendorId = @vendorId
                  AND IsActive = 1
            `);
        
        if (result.rowsAffected[0] === 0) {
            return res.status(404).json({
                success: false,
                message: 'Group ID not found'
            });
        }
        
        res.json({
            success: true,
            message: 'Group ID deleted successfully'
        });
        
    } catch (error) {
        console.error('❌ Error deleting Group ID:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete Group ID',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * DELETE /api/vendor-group-ids/group/:groupId/vendor/:vendorId/master
 * Soft delete a Master Group ID (set IsActive = 0)
 */
router.delete('/group/:groupId/vendor/:vendorId/master', authorize(['SysAdmin', 'TenantAdmin']), async (req, res) => {
    try {
        const { groupId, vendorId } = req.params;
        const userId = req.user?.UserId || req.user?.userId;
        const pool = await getPool();
        
        // Soft delete Master Group ID
        const result = await pool.request()
            .input('groupId', sql.UniqueIdentifier, groupId)
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('modifiedBy', sql.UniqueIdentifier, userId)
            .query(`
                UPDATE oe.GroupProductVendorGroupIds
                SET IsActive = 0,
                    ModifiedDate = GETDATE(),
                    ModifiedBy = @modifiedBy
                WHERE GroupId = @groupId
                  AND VendorId = @vendorId
                  AND ProductType = 'Master'
                  AND GroupProductId IS NULL
                  AND IsActive = 1
            `);
        
        if (result.rowsAffected[0] === 0) {
            return res.status(404).json({
                success: false,
                message: 'Master Group ID not found'
            });
        }
        
        res.json({
            success: true,
            message: 'Master Group ID deleted successfully'
        });
        
    } catch (error) {
        console.error('❌ Error deleting Master Group ID:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete Master Group ID',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// ============================================================
// LOCATION VENDOR ID ENDPOINTS
// ============================================================

/**
 * GET /api/vendor-group-ids/group/:groupId/vendor/:vendorId/location-setting
 * Get the LocationVendorGroupIdsEnabled setting for a group+vendor.
 */
router.get('/group/:groupId/vendor/:vendorId/location-setting',
    authorize(['SysAdmin', 'TenantAdmin', 'GroupAdmin', 'Agent']),
    async (req, res) => {
        try {
            const { groupId, vendorId } = req.params;
            const pool = await getPool();
            const userRoles = getUserRoles(req.user);

            let groupCheckQuery = `
                SELECT g.GroupId, g.TenantId FROM oe.Groups g
                WHERE g.GroupId = @groupId AND ${GROUP_DETAIL_READ_STATUS_SQL}
            `;
            const groupCheckRequest = pool.request();
            groupCheckRequest.input('groupId', sql.UniqueIdentifier, groupId);
            groupCheckQuery = appendGroupScopeForTenantUsers(groupCheckQuery, groupCheckRequest, req, userRoles);
            const groupResult = await groupCheckRequest.query(groupCheckQuery);
            if (groupResult.recordset.length === 0) {
                return res.status(404).json({ success: false, message: 'Group not found or access denied' });
            }

            const setting = await VendorGroupIdService.getLocationSetting(groupId, vendorId);
            res.json({
                success: true,
                data: setting || {
                    GroupId: groupId,
                    VendorId: vendorId,
                    LocationVendorGroupIdsEnabled: false,
                }
            });
        } catch (error) {
            console.error('❌ Error fetching location setting:', error);
            res.status(500).json({ success: false, message: 'Failed to fetch location setting' });
        }
    }
);

/**
 * PUT /api/vendor-group-ids/group/:groupId/vendor/:vendorId/location-setting
 * Enable/disable per-location vendor IDs for a group+vendor.
 * Body: { locationVendorGroupIdsEnabled: boolean }
 */
router.put('/group/:groupId/vendor/:vendorId/location-setting',
    authorize(['SysAdmin', 'TenantAdmin']),
    async (req, res) => {
        try {
            const { groupId, vendorId } = req.params;
            const { locationVendorGroupIdsEnabled } = req.body;
            const userId = req.user?.UserId || req.user?.userId;

            if (locationVendorGroupIdsEnabled === undefined || locationVendorGroupIdsEnabled === null) {
                return res.status(400).json({ success: false, message: 'Missing required field: locationVendorGroupIdsEnabled' });
            }

            const pool = await getPool();
            // Verify group exists and get tenantId
            const groupReq = pool.request();
            groupReq.input('groupId', sql.UniqueIdentifier, groupId);
            const groupResult = await groupReq.query(`
                SELECT TenantId FROM oe.Groups WHERE GroupId = @groupId
            `);
            if (groupResult.recordset.length === 0) {
                return res.status(404).json({ success: false, message: 'Group not found' });
            }
            const tenantId = groupResult.recordset[0].TenantId;

            const result = await VendorGroupIdService.upsertLocationSetting(
                groupId, vendorId, !!locationVendorGroupIdsEnabled, tenantId, userId
            );
            res.json({ success: true, data: result.data, message: 'Location vendor ID setting updated' });
        } catch (error) {
            console.error('❌ Error updating location setting:', error);
            res.status(500).json({ success: false, message: 'Failed to update location setting' });
        }
    }
);

/**
 * GET /api/vendor-group-ids/group/:groupId/vendor/:vendorId/location-ids/generate
 * Preview location vendor IDs that would be generated for each active location.
 */
router.get('/group/:groupId/vendor/:vendorId/location-ids/generate',
    authorize(['SysAdmin', 'TenantAdmin']),
    async (req, res) => {
        try {
            const { groupId, vendorId } = req.params;
            const result = await VendorGroupIdService.previewLocationVendorGroupIds(groupId, vendorId);
            if (!result.success) {
                return res.status(400).json({ success: false, message: result.error });
            }
            res.json({ success: true, data: result.preview });
        } catch (error) {
            console.error('❌ Error previewing location vendor IDs:', error);
            res.status(500).json({ success: false, message: 'Failed to preview location vendor IDs' });
        }
    }
);

/**
 * POST /api/vendor-group-ids/group/:groupId/vendor/:vendorId/location-ids/generate
 * Apply: generate and persist location vendor IDs for all active locations missing one.
 */
router.post('/group/:groupId/vendor/:vendorId/location-ids/generate',
    authorize(['SysAdmin', 'TenantAdmin']),
    async (req, res) => {
        try {
            const { groupId, vendorId } = req.params;
            const userId = req.user?.UserId || req.user?.userId;
            const result = await VendorGroupIdService.generateLocationVendorGroupIds(groupId, vendorId, userId);
            if (!result.success) {
                return res.status(400).json({ success: false, message: result.error });
            }
            res.json({
                success: true,
                message: `${result.created} location vendor ID(s) created.`,
                data: { created: result.created, errors: result.errors }
            });
        } catch (error) {
            console.error('❌ Error generating location vendor IDs:', error);
            res.status(500).json({ success: false, message: 'Failed to generate location vendor IDs' });
        }
    }
);

/**
 * PUT /api/vendor-group-ids/group/:groupId/location/:locationId/vendor/:vendorId/vendor-location-id
 * Manually set or override the VendorLocationId for a specific location+vendor.
 * Body: { vendorLocationId: string }
 */
router.put('/group/:groupId/location/:locationId/vendor/:vendorId/vendor-location-id',
    authorize(['SysAdmin', 'TenantAdmin']),
    async (req, res) => {
        try {
            const { groupId, locationId, vendorId } = req.params;
            const { vendorLocationId } = req.body;
            const userId = req.user?.UserId || req.user?.userId;

            if (!vendorLocationId || !String(vendorLocationId).trim()) {
                return res.status(400).json({ success: false, message: 'Missing required field: vendorLocationId' });
            }

            const pool = await getPool();

            // Verify location belongs to group and get tenantId
            const locReq = pool.request();
            locReq.input('locationId', sql.UniqueIdentifier, locationId);
            locReq.input('groupId', sql.UniqueIdentifier, groupId);
            const locResult = await locReq.query(`
                SELECT gl.LocationId, g.TenantId
                FROM oe.GroupLocations gl
                INNER JOIN oe.Groups g ON gl.GroupId = g.GroupId
                WHERE gl.LocationId = @locationId AND gl.GroupId = @groupId
            `);
            if (locResult.recordset.length === 0) {
                return res.status(404).json({ success: false, message: 'Location not found in this group' });
            }
            const tenantId = locResult.recordset[0].TenantId;

            const result = await VendorGroupIdService.upsertLocationVendorId(
                locationId, vendorId, String(vendorLocationId).trim(), tenantId, userId
            );
            if (!result.success) {
                return res.status(400).json({ success: false, message: result.error });
            }
            res.json({ success: true, message: 'Vendor location ID updated', data: { vendorLocationId: result.vendorLocationId } });
        } catch (error) {
            console.error('❌ Error setting vendor location ID:', error);
            res.status(500).json({ success: false, message: 'Failed to set vendor location ID' });
        }
    }
);

/**
 * GET /api/vendor-group-ids/group/:groupId/vendor/:vendorId/location-ids
 * Get all existing location vendor IDs for a group+vendor.
 */
router.get('/group/:groupId/vendor/:vendorId/location-ids',
    authorize(['SysAdmin', 'TenantAdmin', 'GroupAdmin', 'Agent']),
    async (req, res) => {
        try {
            const { groupId, vendorId } = req.params;
            const result = await VendorGroupIdService.getLocationVendorIds(groupId, vendorId);
            if (!result.success) {
                return res.status(500).json({ success: false, message: result.error });
            }
            res.json({ success: true, data: result.locationIds });
        } catch (error) {
            console.error('❌ Error fetching location vendor IDs:', error);
            res.status(500).json({ success: false, message: 'Failed to fetch location vendor IDs' });
        }
    }
);

module.exports = router;
