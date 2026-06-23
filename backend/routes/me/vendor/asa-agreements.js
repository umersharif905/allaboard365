// backend/routes/me/vendor/asa-agreements.js
//
// Vendor-portal "Signed ASAs" endpoints. Thin wrapper over the shared
// factory in routes/shared/asa-agreements.factory.js — resolves VendorId
// from the current user's session.
//
// Parity admin mount: backend/routes/vendors.js → /api/vendors/:id/asa-agreements.

const sql = require('mssql');
const { getPool } = require('../../../config/database');
const { authorize } = require('../../../middleware/auth');
const { createAsaAgreementsRouter } = require('../../shared/asa-agreements.factory');

const VENDOR_PORTAL_ROLES = ['VendorAdmin', 'VendorAgent'];

async function getVendorIdForUser(req) {
    const userId = req.user?.UserId || req.user?.userId;
    if (!userId) return null;
    const pool = await getPool();
    const r = await pool.request()
        .input('userId', sql.UniqueIdentifier, userId)
        .query(`SELECT VendorId FROM oe.Users WHERE UserId = @userId`);
    return r.recordset[0]?.VendorId || null;
}

module.exports = createAsaAgreementsRouter({
    resolveVendorId: getVendorIdForUser,
    authMiddlewares: [authorize(VENDOR_PORTAL_ROLES)]
});
