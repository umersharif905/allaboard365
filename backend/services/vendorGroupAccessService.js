/**
 * Shared checks: whether a vendor (or vendor portal user) is linked to a group via products / enrollments.
 */
const sql = require('mssql');

/**
 * @param {import('mssql').ConnectionPool} pool
 * @param {string} vendorId
 * @param {string} groupId
 * @returns {Promise<boolean>}
 */
async function vendorServesGroup(pool, vendorId, groupId) {
    const r = await pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .input('groupId', sql.UniqueIdentifier, groupId)
        .query(`
            SELECT TOP 1 1 AS Ok
            FROM oe.Groups g
            WHERE g.GroupId = @groupId
              AND (g.Status = 'Active' OR g.Status = 'Archived')
              AND (
                EXISTS (
                    SELECT 1
                    FROM oe.Members m
                    INNER JOIN oe.Enrollments e ON e.MemberId = m.MemberId
                    INNER JOIN oe.Products p ON e.ProductId = p.ProductId
                    WHERE m.GroupId = g.GroupId
                      AND p.VendorId = @vendorId
                      AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
                      AND (e.TerminationDate IS NULL OR e.TerminationDate > SYSUTCDATETIME())
                )
                OR EXISTS (
                    SELECT 1 FROM oe.GroupProducts gp
                    INNER JOIN oe.Products p ON p.ProductId = gp.ProductId
                    WHERE gp.GroupId = g.GroupId AND gp.IsActive = 1 AND p.VendorId = @vendorId
                )
                OR EXISTS (
                    SELECT 1 FROM oe.GroupProducts gp
                    INNER JOIN oe.ProductBundles pb ON pb.BundleProductId = gp.ProductId
                    INNER JOIN oe.Products p ON p.IncludedProductId = p.ProductId
                    WHERE gp.GroupId = g.GroupId AND gp.IsActive = 1 AND p.VendorId = @vendorId
                )
              )
        `);
    return !!(r.recordset && r.recordset.length > 0);
}

/**
 * @param {import('mssql').ConnectionPool} pool
 * @param {string} userId
 * @param {string} groupId
 * @returns {Promise<boolean>}
 */
async function vendorUserServesGroup(pool, userId, groupId) {
    const vr = await pool.request()
        .input('userId', sql.UniqueIdentifier, userId)
        .query('SELECT VendorId FROM oe.Users WHERE UserId = @userId');
    const vendorId = vr.recordset && vr.recordset[0] && vr.recordset[0].VendorId
        ? String(vr.recordset[0].VendorId)
        : null;
    if (!vendorId) return false;
    return vendorServesGroup(pool, vendorId, groupId);
}

module.exports = {
    vendorServesGroup,
    vendorUserServesGroup
};
