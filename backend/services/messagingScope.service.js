// backend/services/messagingScope.service.js
// Resolves the messaging-data scope for the calling user.
// Vendor users see only their VendorId's rows; everyone else sees VendorId IS NULL.
const { getPool, sql } = require('../config/database');
const { getUserRoles } = require('../middleware/auth');

class ScopeError extends Error {
  constructor(message) { super(message); this.name = 'ScopeError'; }
}

async function resolveMessagingScope(req, poolOverride) {
  const roles = getUserRoles(req.user);
  const isVendor = roles.includes('VendorAdmin') || roles.includes('VendorAgent');
  if (!isVendor) {
    return { vendorIdFilter: null, isVendor: false };
  }
  const userId = req.user?.UserId || req.user?.userId;
  if (!userId) throw new ScopeError('Vendor user has no UserId in request');
  const pool = poolOverride || await getPool();
  const result = await pool.request()
    .input('userId', sql.UniqueIdentifier, userId)
    .query('SELECT VendorId FROM oe.Users WHERE UserId = @userId');
  const row = result.recordset && result.recordset[0];
  const vendorId = row && row.VendorId ? String(row.VendorId) : null;
  if (!vendorId) throw new ScopeError('Vendor user has no VendorId on oe.Users');
  return { vendorIdFilter: vendorId, isVendor: true };
}

module.exports = { resolveMessagingScope, ScopeError };
