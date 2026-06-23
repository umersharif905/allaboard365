const sql = require('mssql');

/**
 * Generate a new AgentCode for the given tenant via oe.GenerateAgentCode.
 *
 * @param {object} pool  An mssql connection pool or transaction (must expose .request()).
 * @param {string} tenantId  The tenant's UNIQUEIDENTIFIER.
 * @returns {Promise<string>} The newly generated AgentCode (e.g. 'MWA000124').
 */
async function generateAgentCode(pool, tenantId) {
  const request = pool.request();
  request.input('TenantId', sql.UniqueIdentifier, tenantId);
  request.output('AgentCode', sql.NVarChar(50));
  const result = await request.execute('oe.GenerateAgentCode');
  const code = result?.output?.AgentCode;
  if (!code) {
    throw new Error('oe.GenerateAgentCode returned an empty AgentCode');
  }
  return code;
}

module.exports = { generateAgentCode };
