const db = require('../config/database');

async function computeApplicableMinimum(groupId) {
  if (!groupId) return null;

  const pool = await db.getPool();

  const groupResult = await pool.request()
    .input('GroupId', groupId)
    .query(`
      SELECT GroupType
      FROM oe.Groups
      WHERE GroupId = @GroupId
    `);

  if (!groupResult.recordset.length) return null;
  if (groupResult.recordset[0].GroupType === 'ListBill') return null;

  const vendorResult = await pool.request()
    .input('GroupId', groupId)
    .query(`
      SELECT DISTINCT v.MinimumEmployeesPerGroup
      FROM oe.GroupProducts gp
      INNER JOIN oe.Products p ON gp.ProductId = p.ProductId
      INNER JOIN oe.Vendors v ON p.VendorId = v.VendorId
      WHERE gp.GroupId = @GroupId
        AND gp.IsActive = 1
        AND (gp.IsHidden IS NULL OR gp.IsHidden = 0)
        AND (p.IsHidden IS NULL OR p.IsHidden = 0)
    `);

  const minimums = vendorResult.recordset
    .map(r => r.MinimumEmployeesPerGroup)
    .filter(n => typeof n === 'number' && n > 0);

  if (!minimums.length) return null;
  return Math.max(...minimums);
}

module.exports = { computeApplicableMinimum };
