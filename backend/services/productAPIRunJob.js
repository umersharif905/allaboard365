/**
 * Shared product API batch run (same behavior as POST .../product-api/:productId/run-api with updateAll=false).
 * Used by tenant-admin route and scheduled daily job.
 */
const { sql } = require('../config/database');
const ProductAPIService = require('./ProductAPIService');
const productAPIQueries = require('./productAPIQueries');

/**
 * @param {import('mssql').ConnectionPool} pool
 * @param {string} productId
 * @param {{ updateAll?: boolean }} [options]
 * @returns {Promise<{ skipped?: boolean; reason?: string; activated: number; deactivated: number; updated: number; errors: any[]; activatedList: any[]; updatedList: any[]; deactivatedList: any[] }>}
 */
async function runProductApiForProduct(pool, productId, options = {}) {
  const { updateAll = false } = options;

  const configReq = await pool.request()
    .input('productId', sql.UniqueIdentifier, productId)
    .query(`SELECT ConfigJson FROM oe.ProductAPIConfigs WHERE ProductId = @productId`);
  if (configReq.recordset.length === 0) {
    return { skipped: true, reason: 'no_config', activated: 0, deactivated: 0, updated: 0, errors: [], activatedList: [], updatedList: [], deactivatedList: [] };
  }
  const config = typeof configReq.recordset[0].ConfigJson === 'string'
    ? JSON.parse(configReq.recordset[0].ConfigJson) : configReq.recordset[0].ConfigJson;

  const today = new Date().toISOString().split('T')[0];
  let activated = 0; let deactivated = 0; let updated = 0; const errors = [];
  const activatedList = []; const updatedList = []; const deactivatedList = [];

  if (updateAll && config.update?.enabled) {
    const toUpdate = await productAPIQueries.getUpdatesToProcess(pool, productId, today);

    for (const row of toUpdate) {
      let member;
      try {
        const memberReq = await pool.request()
          .input('memberId', sql.UniqueIdentifier, row.MemberId)
          .query(`
              SELECT m.MemberId, m.HouseholdId, m.HouseholdMemberID, m.Tier, m.RelationshipType, FORMAT(m.DateOfBirth, 'yyyy-MM-dd') as DateOfBirth,
                     m.Address, m.City, m.State, m.Zip, m.Gender,
                     u.FirstName, u.LastName, u.Email, u.PhoneNumber
              FROM oe.Members m
              JOIN oe.Users u ON m.UserId = u.UserId
              WHERE m.MemberId = @memberId
            `);
        member = memberReq.recordset[0];
        if (!member) continue;

        const enrollment = { EnrollmentId: row.EnrollmentId, MemberId: row.MemberId, HouseholdId: row.HouseholdId, TerminationDate: row.TerminationDate };
        const result = await ProductAPIService.callUpdateAPI({
          productId,
          member,
          enrollment,
          config: config.update,
          fullConfig: config
        });
        const responseJson = result.rawResponse != null ? JSON.stringify(result.rawResponse) : null;
        await pool.request()
          .input('enrollmentId', sql.UniqueIdentifier, row.EnrollmentId)
          .input('now', sql.DateTime2, new Date())
          .input('responseJson', sql.NVarChar, responseJson)
          .query(`UPDATE oe.Enrollments SET ExternalAPISyncedAt = @now, ExternalAPIResponseJson = @responseJson WHERE EnrollmentId = @enrollmentId`);
        updated++;
        const memberName = ((member.FirstName || '') + ' ' + (member.LastName || '')).trim() || 'Unknown';
        updatedList.push({ memberName, memberId: row.MemberId });
      } catch (err) {
        let memberName = 'Unknown';
        if (member) {
          const full = ((member.FirstName || '') + ' ' + (member.LastName || '')).trim();
          if (full) memberName = full;
        }
        errors.push({
          enrollmentId: row.EnrollmentId,
          type: 'update',
          message: err.message,
          memberName,
          responseBody: err.responseBody,
          responseStatus: err.responseStatus
        });
      }
    }
  } else if (config.enrollment?.enabled && !updateAll) {
    const activations = await productAPIQueries.getActivationsToProcess(pool, productId, today);

    for (const row of activations) {
      let member;
      let useUpdate = false;
      try {
        const memberReq = await pool.request()
          .input('memberId', sql.UniqueIdentifier, row.MemberId)
          .query(`
              SELECT m.MemberId, m.HouseholdId, m.HouseholdMemberID, m.Tier, m.RelationshipType, FORMAT(m.DateOfBirth, 'yyyy-MM-dd') as DateOfBirth,
                     m.Address, m.City, m.State, m.Zip, m.Gender,
                     u.FirstName, u.LastName, u.Email, u.PhoneNumber
              FROM oe.Members m
              JOIN oe.Users u ON m.UserId = u.UserId
              WHERE m.MemberId = @memberId
            `);
        member = memberReq.recordset[0];
        if (!member) continue;

        const hasPriorSynced = await pool.request()
          .input('memberId', sql.UniqueIdentifier, row.MemberId)
          .input('productId', sql.UniqueIdentifier, productId)
          .input('enrollmentId', sql.UniqueIdentifier, row.EnrollmentId)
          .query(`
              SELECT 1 FROM oe.Enrollments e2
              WHERE e2.MemberId = @memberId AND e2.ProductId = @productId AND e2.EnrollmentId != @enrollmentId
                AND e2.ExternalAPISyncedAt IS NOT NULL
            `);
        useUpdate = hasPriorSynced.recordset.length > 0 && config.update?.enabled;

        if (useUpdate) {
          const enrollment = { EnrollmentId: row.EnrollmentId, MemberId: row.MemberId, HouseholdId: row.HouseholdId, TerminationDate: row.TerminationDate };
          const result = await ProductAPIService.callUpdateAPI({
            productId,
            member,
            enrollment,
            config: config.update,
            fullConfig: config
          });
          const responseJson = result.rawResponse != null ? JSON.stringify(result.rawResponse) : null;
          await pool.request()
            .input('enrollmentId', sql.UniqueIdentifier, row.EnrollmentId)
            .input('now', sql.DateTime2, new Date())
            .input('responseJson', sql.NVarChar, responseJson)
            .query(`UPDATE oe.Enrollments SET ExternalAPISyncedAt = @now, ExternalAPIResponseJson = @responseJson WHERE EnrollmentId = @enrollmentId`);
          updated++;
          const memberNameAct = ((member.FirstName || '') + ' ' + (member.LastName || '')).trim() || 'Unknown';
          updatedList.push({ memberName: memberNameAct, memberId: row.MemberId });
        } else {
          const result = await ProductAPIService.callEnrollmentAPI({
            productId,
            member,
            householdMembers: [],
            config: config.enrollment,
            fullConfig: config
          });
          const responseJson = result.rawResponse != null ? JSON.stringify(result.rawResponse) : null;
          await pool.request()
            .input('enrollmentId', sql.UniqueIdentifier, row.EnrollmentId)
            .input('now', sql.DateTime2, new Date())
            .input('responseJson', sql.NVarChar, responseJson)
            .query(`UPDATE oe.Enrollments SET ExternalAPISyncedAt = @now, ExternalAPIResponseJson = @responseJson WHERE EnrollmentId = @enrollmentId`);
          activated++;
          const memberNameAct = ((member.FirstName || '') + ' ' + (member.LastName || '')).trim() || 'Unknown';
          activatedList.push({ memberName: memberNameAct, memberId: row.MemberId });
        }
      } catch (err) {
        let memberName = 'Unknown';
        if (member) {
          const full = ((member.FirstName || '') + ' ' + (member.LastName || '')).trim();
          if (full) memberName = full;
        }
        errors.push({
          enrollmentId: row.EnrollmentId,
          type: useUpdate ? 'update' : 'activation',
          message: err.message,
          memberName,
          responseBody: err.responseBody,
          responseStatus: err.responseStatus
        });
      }
    }
  }

  if (config.deactivation?.enabled) {
    const deactivations = await productAPIQueries.getDeactivationsToProcess(pool, productId, today);

    for (const row of deactivations) {
      let member;
      try {
        const memberReq = await pool.request()
          .input('memberId', sql.UniqueIdentifier, row.MemberId)
          .query(`
              SELECT m.MemberId, m.HouseholdId, m.HouseholdMemberID, m.Tier, FORMAT(m.DateOfBirth, 'yyyy-MM-dd') as DateOfBirth,
                     m.Address, m.City, m.State, m.Zip, m.Gender,
                     u.FirstName, u.LastName, u.Email, u.PhoneNumber
              FROM oe.Members m
              JOIN oe.Users u ON m.UserId = u.UserId
              WHERE m.MemberId = @memberId
            `);
        member = memberReq.recordset[0] || {};
        await ProductAPIService.callDeactivationAPI({
          productId,
          enrollment: row,
          member,
          config: config.deactivation,
          fullConfig: config
        });
        await pool.request()
          .input('enrollmentId', sql.UniqueIdentifier, row.EnrollmentId)
          .input('now', sql.DateTime2, new Date())
          .query(`UPDATE oe.Enrollments SET ExternalAPIDeactivatedAt = @now WHERE EnrollmentId = @enrollmentId`);
        deactivated++;
        const memberName = ((member.FirstName || '') + ' ' + (member.LastName || '')).trim() || 'Unknown';
        deactivatedList.push({ memberName, memberId: row.MemberId });
      } catch (err) {
        let memberName = 'Unknown';
        if (member) {
          const full = ((member.FirstName || '') + ' ' + (member.LastName || '')).trim();
          if (full) memberName = full;
        }
        errors.push({
          enrollmentId: row.EnrollmentId,
          type: 'deactivation',
          message: err.message,
          memberName,
          responseBody: err.responseBody,
          responseStatus: err.responseStatus
        });
      }
    }
  }

  await pool.request()
    .input('productId', sql.UniqueIdentifier, productId)
    .query(`UPDATE oe.ProductAPIConfigs SET LastRunAt = GETUTCDATE() WHERE ProductId = @productId`);

  return {
    activated,
    deactivated,
    updated,
    errors,
    activatedList,
    updatedList,
    deactivatedList
  };
}

/**
 * ProductIds whose API config has runDaily: true (for Azure timer).
 * @param {import('mssql').ConnectionPool} pool
 */
async function listProductIdsWithRunDaily(pool) {
  const r = await pool.request().query(`
    SELECT ProductId
    FROM oe.ProductAPIConfigs
    WHERE ISJSON(ConfigJson) = 1
      AND LOWER(LTRIM(RTRIM(JSON_VALUE(ConfigJson, '$.runDaily')))) = 'true'
  `);
  return (r.recordset || []).map((row) => String(row.ProductId));
}

module.exports = {
  runProductApiForProduct,
  listProductIdsWithRunDaily
};
