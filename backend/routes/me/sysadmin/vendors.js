/**
 * SysAdmin Vendor Lookup
 * GET /api/me/sysadmin/vendors
 *
 * Returns ALL vendors from oe.Vendors. For each vendor:
 *   - hasUsers:        true iff at least one oe.Users row references the vendor.
 *   - defaultTenantId: any TenantId from that vendor's users (MAX is fine —
 *                      single-tenant vendors have identical values). null when
 *                      the vendor has no users.
 *
 * Used by the "Create for Vendor" single-dropdown picker in the SysAdmin
 * messaging create modal. Vendors are tenant-agnostic; the TenantId for a
 * vendor-scoped template is inferred backend-side from oe.Users. SysAdmin-only.
 */
const express = require('express');
const router = express.Router();
const { authorize } = require('../../../middleware/auth');
const { getPool } = require('../../../config/database');

router.use(authorize(['SysAdmin']));

router.get('/', async (_req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT v.VendorId,
             v.VendorName,
             CAST(CASE WHEN MAX(u.UserId) IS NOT NULL THEN 1 ELSE 0 END AS BIT) AS HasUsers,
             MAX(u.TenantId) AS DefaultTenantId
        FROM oe.Vendors v
        LEFT JOIN oe.Users u ON u.VendorId = v.VendorId
       GROUP BY v.VendorId, v.VendorName
       ORDER BY v.VendorName
    `);

    const data = result.recordset.map(r => ({
      vendorId: r.VendorId,
      vendorName: r.VendorName,
      hasUsers: !!r.HasUsers,
      defaultTenantId: r.DefaultTenantId || null,
    }));

    res.json({ success: true, data });
  } catch (err) {
    console.error('GET /api/me/sysadmin/vendors error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch vendors' });
  }
});

module.exports = router;
