const db = require('../config/database');

async function clearForMembers(memberIds, tenantId) {
  if (!tenantId) throw new Error('tenantId is required');
  if (!Array.isArray(memberIds) || memberIds.length === 0) return 0;

  const pool = await db.getPool();
  const request = pool.request().input('TenantId', tenantId);

  const params = memberIds.map((id, i) => {
    const name = `MemberId${i}`;
    request.input(name, id);
    return `@${name}`;
  });

  const result = await request.query(`
    UPDATE oe.Members
    SET HouseholdMemberId = NULL,
        ModifiedDate = SYSUTCDATETIME()
    WHERE TenantId = @TenantId
      AND MemberId IN (${params.join(',')})
  `);

  return result.rowsAffected[0] || 0;
}

module.exports = { clearForMembers };
