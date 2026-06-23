'use strict';

const { getPool, sql } = require('../config/database');

/**
 * Activate user/agent/member records after first successful login (password reset, OTP verify, etc.).
 * Mirrors password-reset completion in routes/password-reset.js.
 *
 * @param {string} userId
 * @returns {Promise<{ userActivated: boolean, agentActivated: boolean, membersActivated: boolean }>}
 */
async function activateUserAfterSuccessfulLogin(userId) {
  const pool = await getPool();
  const result = { userActivated: false, agentActivated: false, membersActivated: false };

  const activateUser = await pool.request()
    .input('userId', sql.UniqueIdentifier, userId)
    .query(`
      UPDATE oe.Users
      SET Status = N'Active', ModifiedDate = GETUTCDATE()
      WHERE UserId = @userId AND Status IN (N'Pending', N'Pending Payment')
    `);
  result.userActivated = activateUser.rowsAffected[0] > 0;

  const activateAgent = await pool.request()
    .input('userId', sql.UniqueIdentifier, userId)
    .query(`
      UPDATE oe.Agents
      SET Status = N'Active', ModifiedDate = GETUTCDATE()
      WHERE UserId = @userId AND Status = N'Pending'
    `);
  result.agentActivated = activateAgent.rowsAffected[0] > 0;

  const hasActiveEnrollment = await pool.request()
    .input('userId', sql.UniqueIdentifier, userId)
    .query(`
      SELECT TOP 1 1 AS ok
      FROM oe.Members m
      INNER JOIN oe.Enrollments e ON e.MemberId = m.MemberId
      WHERE m.UserId = @userId
        AND e.TerminationDate IS NULL
    `);

  if (hasActiveEnrollment.recordset.length > 0) {
    const userUpdate = await pool.request()
      .input('userId', sql.UniqueIdentifier, userId)
      .query(`
        UPDATE oe.Users
        SET Status = N'Active', ModifiedDate = GETUTCDATE()
        WHERE UserId = @userId
          AND Status NOT IN (N'Inactive', N'Terminated')
      `);
    result.userActivated = result.userActivated || userUpdate.rowsAffected[0] > 0;

    const memberUpdate = await pool.request()
      .input('userId', sql.UniqueIdentifier, userId)
      .query(`
        UPDATE oe.Members SET Status = 'Active' WHERE UserId = @userId
      `);
    result.membersActivated = memberUpdate.rowsAffected[0] > 0;
  }

  if (result.userActivated || result.agentActivated || result.membersActivated) {
    console.log('[activateUserAfterLogin] Activated after login:', userId, result);
  }

  return result;
}

module.exports = { activateUserAfterSuccessfulLogin };
