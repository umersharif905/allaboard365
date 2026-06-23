'use strict';

const { getPool, sql } = require('../config/database');

/**
 * Reply-To / display name for agent-originated prospect, quote, and proposal email/SMS.
 * Uses active tenant from requireTenantAccess when present.
 *
 * @param {import('express').Request} req
 * @returns {Promise<{ replyToEmail: string, replyToName: string }>}
 */
async function getAgentSenderContext(req) {
  const pool = await getPool();
  const userId = req.user.UserId;
  const tenantId = req.tenantId || req.user.TenantId;
  if (!tenantId) {
    throw new Error('Tenant context is required');
  }

  const agentResult = await pool.request()
    .input('userId', sql.UniqueIdentifier, userId)
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .query(`
            SELECT TOP 1 u.FirstName, u.LastName, u.Email
            FROM oe.Agents a
            INNER JOIN oe.Users u ON u.UserId = a.UserId
            WHERE a.UserId = @userId AND a.TenantId = @tenantId AND a.Status = N'Active'
        `);
  if (agentResult.recordset.length > 0) {
    const row = agentResult.recordset[0];
    const fullName = `${row.FirstName || ''} ${row.LastName || ''}`.trim() || 'Agent';
    return { replyToEmail: row.Email || '', replyToName: fullName };
  }

  const userResult = await pool.request()
    .input('userId', sql.UniqueIdentifier, userId)
    .query(`SELECT FirstName, LastName, Email FROM oe.Users WHERE UserId = @userId`);
  const u = userResult.recordset[0] || {};
  const fullName = `${u.FirstName || ''} ${u.LastName || ''}`.trim() || 'User';
  return { replyToEmail: u.Email || '', replyToName: fullName };
}

module.exports = {
  getAgentSenderContext,
};
