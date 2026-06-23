'use strict';

const { getPool, sql } = require('../config/database');

/**
 * Move a household to a target tenant: primary + dependents users/members.
 * Clears GroupId on moved members (individual import scenario).
 */
async function moveHouseholdToTenant({ primaryMemberId, targetTenantId, modifiedBy = null }) {
  const pool = await getPool();
  const transaction = pool.transaction();
  await transaction.begin();
  try {
    const mRes = await transaction.request()
      .input('memberId', sql.UniqueIdentifier, primaryMemberId)
      .query(`
        SELECT MemberId, HouseholdId, UserId, TenantId, GroupId
        FROM oe.Members WHERE MemberId = @memberId
      `);
    const primary = mRes.recordset[0];
    if (!primary) throw new Error('Primary member not found');

    const householdId = primary.HouseholdId || primary.MemberId;
    const membersRes = await transaction.request()
      .input('householdId', sql.UniqueIdentifier, householdId)
      .query(`
        SELECT MemberId, UserId, TenantId FROM oe.Members
        WHERE HouseholdId = @householdId OR MemberId = @householdId
      `);

    const userIds = [...new Set(membersRes.recordset.map((m) => m.UserId).filter(Boolean))];
    for (const uid of userIds) {
      await transaction.request()
        .input('userId', sql.UniqueIdentifier, uid)
        .input('tenantId', sql.UniqueIdentifier, targetTenantId)
        .query(`UPDATE oe.Users SET TenantId = @tenantId, ModifiedDate = GETUTCDATE() WHERE UserId = @userId`);
    }

    for (const row of membersRes.recordset) {
      await transaction.request()
        .input('memberId', sql.UniqueIdentifier, row.MemberId)
        .input('tenantId', sql.UniqueIdentifier, targetTenantId)
        .query(`
          UPDATE oe.Members
          SET TenantId = @tenantId, GroupId = NULL, ModifiedDate = GETUTCDATE()
          WHERE MemberId = @memberId
        `);
    }

    await transaction.commit();
    return { movedCount: membersRes.recordset.length, fromTenantId: primary.TenantId, toTenantId: targetTenantId };
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}

module.exports = { moveHouseholdToTenant };
