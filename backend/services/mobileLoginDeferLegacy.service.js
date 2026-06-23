'use strict';

const { getPool, sql } = require('../config/database');
const { DEFER_MOBILE_LOGIN_TO_LEGACY_WHERE_SQL } = require('../utils/memberEnrollmentStatusSql');

/**
 * E123 import staging with no live AB365 go-live enrollment — mobile should use ShareWELL legacy auth/data.
 */
async function userShouldDeferMobileLoginToLegacy(userId) {
  const pool = await getPool();
  const result = await pool.request()
    .input('userId', sql.UniqueIdentifier, userId)
    .query(`
      SELECT TOP 1 1 AS ok
      FROM oe.Members m
      WHERE m.UserId = @userId
        AND ${DEFER_MOBILE_LOGIN_TO_LEGACY_WHERE_SQL}
    `);
  return result.recordset.length > 0;
}

module.exports = {
  userShouldDeferMobileLoginToLegacy,
};
