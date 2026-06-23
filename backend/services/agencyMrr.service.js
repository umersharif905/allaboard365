/**
 * Monthly recurring revenue (MRR) attributed to each agency for a tenant.
 * Group MRR: recurring plans on groups whose writing agent belongs to the agency.
 * Individual MRR: recurring schedules for primary members whose AgentId belongs to the agency.
 * Aligns with billing audit DB MRR components (active schedules only).
 */
const sql = require('mssql');

function normalizeAgencyKey(id) {
  if (id == null) return '';
  return String(id).toLowerCase().replace(/[{}]/g, '').trim();
}

/**
 * @param {import('mssql').ConnectionPool} pool
 * @param {string} tenantId
 * @returns {Promise<Map<string, number>>} normalized AgencyId -> total MRR
 */
async function getMonthlyRecurringRevenueByAgencyMap(pool, tenantId) {
  const map = new Map();

  const groupReq = pool.request();
  groupReq.input('tenantId', sql.UniqueIdentifier, tenantId);
  const groupRes = await groupReq.query(`
    SELECT
      ag.AgencyId,
      ISNULL(SUM(CAST(ISNULL(grp.MonthlyAmount, 0) AS DECIMAL(18,2))), 0) AS Mrr
    FROM oe.GroupRecurringPaymentPlans grp
    INNER JOIN oe.Groups g ON g.GroupId = grp.GroupId
    INNER JOIN oe.Agents ag ON g.AgentId = ag.AgentId
    WHERE ag.TenantId = @tenantId
      AND ISNULL(grp.IsActive, 1) = 1
    GROUP BY ag.AgencyId
  `);

  const indReq = pool.request();
  indReq.input('tenantId', sql.UniqueIdentifier, tenantId);
  const indRes = await indReq.query(`
    SELECT
      ag.AgencyId,
      ISNULL(SUM(CAST(ISNULL(irs.MonthlyAmount, 0) AS DECIMAL(18,2))), 0) AS Mrr
    FROM oe.IndividualRecurringSchedules irs
    INNER JOIN oe.Members m ON m.HouseholdId = irs.HouseholdId AND m.RelationshipType = N'P'
    INNER JOIN oe.Agents ag ON m.AgentId = ag.AgentId
    WHERE ag.TenantId = @tenantId
      AND ISNULL(irs.IsActive, 1) = 1
    GROUP BY ag.AgencyId
  `);

  for (const row of groupRes.recordset || []) {
    const k = normalizeAgencyKey(row.AgencyId);
    if (!k) continue;
    map.set(k, (map.get(k) || 0) + Number(row.Mrr || 0));
  }
  for (const row of indRes.recordset || []) {
    const k = normalizeAgencyKey(row.AgencyId);
    if (!k) continue;
    map.set(k, (map.get(k) || 0) + Number(row.Mrr || 0));
  }

  return map;
}

module.exports = {
  getMonthlyRecurringRevenueByAgencyMap,
  normalizeAgencyKey,
};
