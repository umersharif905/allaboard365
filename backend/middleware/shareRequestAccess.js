// middleware/shareRequestAccess.js
// Middleware to check if the Share Request Management module is enabled for a vendor

const { getPool, sql } = require('../config/database');

/**
 * Middleware to check if the Share Request module is enabled for the user's vendor
 * This middleware should be used on all share request related routes
 * 
 * Prerequisites:
 * - User must be authenticated (req.user must exist)
 * - User must have a VendorId (vendor portal user)
 * 
 * @returns {Function} Express middleware function
 */
const requireShareRequestAccess = async (req, res, next) => {
    try {
        // Check if user is authenticated
        if (!req.user) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required',
                code: 'AUTH_REQUIRED'
            });
        }

        // Get user's VendorId
        const vendorId = req.user.VendorId;
        
        if (!vendorId) {
            console.log('❌ Share Request Access: User does not have a VendorId');
            return res.status(403).json({
                success: false,
                message: 'Access denied: This feature is only available to vendor portal users',
                code: 'VENDOR_REQUIRED'
            });
        }

        // Check if the vendor has Share Request module enabled
        const pool = await getPool();
        const request = pool.request();
        request.input('vendorId', sql.UniqueIdentifier, vendorId);
        
        const result = await request.query(`
            SELECT 
                VendorId,
                VendorName,
                ShareRequestEnabled
            FROM oe.Vendors
            WHERE VendorId = @vendorId
        `);

        if (result.recordset.length === 0) {
            console.log('❌ Share Request Access: Vendor not found:', vendorId);
            return res.status(403).json({
                success: false,
                message: 'Access denied: Vendor not found',
                code: 'VENDOR_NOT_FOUND'
            });
        }

        const vendor = result.recordset[0];

        // Check if module is enabled
        if (!vendor.ShareRequestEnabled) {
            console.log(`❌ Share Request Access: Module disabled for vendor ${vendor.VendorName}`);
            return res.status(403).json({
                success: false,
                message: 'Share Request Management module is not enabled for your organization',
                code: 'MODULE_DISABLED'
            });
        }

        // Add vendor info to request for downstream use
        req.vendor = {
            VendorId: vendor.VendorId,
            VendorName: vendor.VendorName
        };

        console.log(`✅ Share Request Access granted for vendor: ${vendor.VendorName}`);
        next();

    } catch (error) {
        console.error('❌ Share Request Access check error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to verify module access',
            code: 'ACCESS_CHECK_ERROR'
        });
    }
};

/**
 * Attach req.vendor (VendorId, VendorName) without requiring ShareRequestEnabled.
 * Use for routes that should work for all vendor portal users (e.g. members list).
 */
const attachVendorContext = async (req, res, next) => {
    try {
        if (!req.user) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required',
                code: 'AUTH_REQUIRED'
            });
        }

        const vendorId = req.user.VendorId;

        if (!vendorId) {
            return res.status(403).json({
                success: false,
                message: 'Access denied: This feature is only available to vendor portal users',
                code: 'VENDOR_REQUIRED'
            });
        }

        const pool = await getPool();
        const request = pool.request();
        request.input('vendorId', sql.UniqueIdentifier, vendorId);

        const result = await request.query(`
            SELECT 
                VendorId,
                VendorName
            FROM oe.Vendors
            WHERE VendorId = @vendorId
        `);

        if (result.recordset.length === 0) {
            return res.status(403).json({
                success: false,
                message: 'Access denied: Vendor not found',
                code: 'VENDOR_NOT_FOUND'
            });
        }

        const vendor = result.recordset[0];
        req.vendor = {
            VendorId: vendor.VendorId,
            VendorName: vendor.VendorName
        };
        next();
    } catch (error) {
        console.error('❌ attachVendorContext error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to load vendor context',
            code: 'VENDOR_CONTEXT_ERROR'
        });
    }
};

/**
 * Check if a specific vendor has the Share Request module enabled
 * Utility function for use outside of middleware context
 * 
 * @param {string} vendorId - The vendor's unique identifier
 * @returns {Promise<{enabled: boolean, vendor?: object}>}
 */
const isShareRequestEnabled = async (vendorId) => {
    try {
        const pool = await getPool();
        const request = pool.request();
        request.input('vendorId', sql.UniqueIdentifier, vendorId);
        
        const result = await request.query(`
            SELECT 
                VendorId,
                VendorName,
                ShareRequestEnabled
            FROM oe.Vendors
            WHERE VendorId = @vendorId
        `);

        if (result.recordset.length === 0) {
            return { enabled: false };
        }

        const vendor = result.recordset[0];
        return {
            enabled: vendor.ShareRequestEnabled === true,
            vendor: {
                VendorId: vendor.VendorId,
                VendorName: vendor.VendorName
            }
        };

    } catch (error) {
        console.error('❌ Error checking Share Request enabled status:', error);
        return { enabled: false };
    }
};

/**
 * Enable or disable Share Request module for a vendor
 * Should only be used by SysAdmin
 * 
 * @param {string} vendorId - The vendor's unique identifier
 * @param {boolean} enabled - Whether to enable or disable the module
 * @param {string} userId - The user making the change (for audit)
 * @returns {Promise<{success: boolean, message?: string}>}
 */
const setShareRequestEnabled = async (vendorId, enabled, userId) => {
    try {
        const pool = await getPool();
        const request = pool.request();
        request.input('vendorId', sql.UniqueIdentifier, vendorId);
        request.input('enabled', sql.Bit, enabled);
        request.input('modifiedBy', sql.UniqueIdentifier, userId);
        
        const result = await request.query(`
            UPDATE oe.Vendors
            SET 
                ShareRequestEnabled = @enabled,
                ModifiedDate = GETDATE(),
                ModifiedBy = @modifiedBy
            WHERE VendorId = @vendorId
        `);

        if (result.rowsAffected[0] === 0) {
            return { success: false, message: 'Vendor not found' };
        }

        console.log(`✅ Share Request module ${enabled ? 'enabled' : 'disabled'} for vendor: ${vendorId}`);
        return { success: true };

    } catch (error) {
        console.error('❌ Error setting Share Request enabled status:', error);
        return { success: false, message: error.message };
    }
};

module.exports = {
    requireShareRequestAccess,
    attachVendorContext,
    isShareRequestEnabled,
    setShareRequestEnabled
};

