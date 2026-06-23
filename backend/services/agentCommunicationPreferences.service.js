/**
 * Agent notification preferences (per-category opt-out).
 *
 * Categories map to columns on oe.AgentCommunicationPreferences:
 *   - enrollment  -> EnrollmentNotificationsOptOut
 *   - payment     -> PaymentAlertsOptOut
 *   - marketing   -> MarketingOptOut
 *
 * Default (no row) = subscribed to everything (opt-out = 0).
 * Mirrors memberCommunicationPreferences.service.js.
 */
const { getPool, sql } = require('../config/database');

const CATEGORY_COLUMN = {
  enrollment: 'EnrollmentNotificationsOptOut',
  payment: 'PaymentAlertsOptOut',
  marketing: 'MarketingOptOut'
};

async function getPreferenceRow(pool, agentId) {
  const r = await pool.request()
    .input('AgentId', sql.UniqueIdentifier, agentId)
    .query(`
      SELECT PreferenceId, AgentId, TenantId,
             EnrollmentNotificationsOptOut, PaymentAlertsOptOut, MarketingOptOut,
             OptOutDate, OptOutSource, CreatedDate, ModifiedDate
      FROM oe.AgentCommunicationPreferences
      WHERE AgentId = @AgentId
    `);
  return r.recordset[0] || null;
}

/**
 * Returns enabled flags (true = subscribed) for the agent.
 * @returns {Promise<{enrollmentNotificationsEnabled:boolean, paymentAlertsEnabled:boolean, marketingEnabled:boolean}>}
 */
async function getPreferencesForAgent(agentId) {
  const pool = await getPool();
  const row = await getPreferenceRow(pool, agentId);
  return {
    enrollmentNotificationsEnabled: !(row && row.EnrollmentNotificationsOptOut),
    paymentAlertsEnabled: !(row && row.PaymentAlertsOptOut),
    marketingEnabled: !(row && row.MarketingOptOut)
  };
}

/**
 * Is the agent opted out of a given category?
 * Fails open (returns false = "still send") on bad input or missing table so
 * a preference lookup never silently swallows a transactional notice.
 * @param {string} agentId
 * @param {'enrollment'|'payment'|'marketing'} category
 */
async function isAgentNotificationOptedOut(agentId, category) {
  if (!agentId || !CATEGORY_COLUMN[category]) return false;
  const pool = await getPool();
  const row = await getPreferenceRow(pool, agentId);
  if (!row) return false;
  return !!row[CATEGORY_COLUMN[category]];
}

/**
 * Resolve an AgentId from a User's UserId (oe.Agents.UserId -> AgentId).
 * Returns { agentId, tenantId } or null if the user is not an agent.
 */
async function resolveAgentByUserId(userId) {
  if (!userId) return null;
  const pool = await getPool();
  const r = await pool.request()
    .input('UserId', sql.UniqueIdentifier, userId)
    .query(`SELECT TOP 1 AgentId, TenantId FROM oe.Agents WHERE UserId = @UserId`);
  if (!r.recordset.length) return null;
  return { agentId: r.recordset[0].AgentId, tenantId: r.recordset[0].TenantId };
}

/**
 * Upsert preferences from the agent settings page.
 * Any flag left undefined is preserved at its current value.
 * @param {string} agentId
 * @param {string} tenantId
 * @param {{enrollmentNotificationsEnabled?:boolean, paymentAlertsEnabled?:boolean, marketingEnabled?:boolean}} prefs
 * @param {{source?:string}} [meta]
 */
async function updatePreferencesForAgent(agentId, tenantId, prefs, { source = 'AgentSettings' } = {}) {
  const pool = await getPool();
  const existing = await getPreferenceRow(pool, agentId);

  // Resolve each opt-out: explicit boolean wins, otherwise keep existing (default subscribed).
  const resolveOptOut = (enabled, existingOptOut) =>
    typeof enabled === 'boolean' ? (enabled ? 0 : 1) : (existing ? (existingOptOut ? 1 : 0) : 0);

  const enrollmentOptOut = resolveOptOut(prefs.enrollmentNotificationsEnabled, existing && existing.EnrollmentNotificationsOptOut);
  const paymentOptOut = resolveOptOut(prefs.paymentAlertsEnabled, existing && existing.PaymentAlertsOptOut);
  const marketingOptOut = resolveOptOut(prefs.marketingEnabled, existing && existing.MarketingOptOut);

  if (!existing) {
    await pool.request()
      .input('AgentId', sql.UniqueIdentifier, agentId)
      .input('TenantId', sql.UniqueIdentifier, tenantId)
      .input('EnrollmentNotificationsOptOut', sql.Bit, enrollmentOptOut)
      .input('PaymentAlertsOptOut', sql.Bit, paymentOptOut)
      .input('MarketingOptOut', sql.Bit, marketingOptOut)
      .input('Source', sql.NVarChar(50), source)
      .query(`
        INSERT INTO oe.AgentCommunicationPreferences
          (AgentId, TenantId, EnrollmentNotificationsOptOut, PaymentAlertsOptOut, MarketingOptOut,
           OptOutDate, OptOutSource, ModifiedDate)
        VALUES
          (@AgentId, @TenantId, @EnrollmentNotificationsOptOut, @PaymentAlertsOptOut, @MarketingOptOut,
           CASE WHEN @EnrollmentNotificationsOptOut = 1 OR @PaymentAlertsOptOut = 1 OR @MarketingOptOut = 1
                THEN SYSUTCDATETIME() ELSE NULL END,
           CASE WHEN @EnrollmentNotificationsOptOut = 1 OR @PaymentAlertsOptOut = 1 OR @MarketingOptOut = 1
                THEN @Source ELSE NULL END,
           SYSUTCDATETIME())
      `);
    return getPreferencesForAgent(agentId);
  }

  await pool.request()
    .input('AgentId', sql.UniqueIdentifier, agentId)
    .input('EnrollmentNotificationsOptOut', sql.Bit, enrollmentOptOut)
    .input('PaymentAlertsOptOut', sql.Bit, paymentOptOut)
    .input('MarketingOptOut', sql.Bit, marketingOptOut)
    .input('Source', sql.NVarChar(50), source)
    .query(`
      UPDATE oe.AgentCommunicationPreferences
      SET EnrollmentNotificationsOptOut = @EnrollmentNotificationsOptOut,
          PaymentAlertsOptOut = @PaymentAlertsOptOut,
          MarketingOptOut = @MarketingOptOut,
          OptOutDate = CASE WHEN @EnrollmentNotificationsOptOut = 1 OR @PaymentAlertsOptOut = 1 OR @MarketingOptOut = 1
                            THEN ISNULL(OptOutDate, SYSUTCDATETIME()) ELSE NULL END,
          OptOutSource = CASE WHEN @EnrollmentNotificationsOptOut = 1 OR @PaymentAlertsOptOut = 1 OR @MarketingOptOut = 1
                              THEN @Source ELSE NULL END,
          ModifiedDate = SYSUTCDATETIME()
      WHERE AgentId = @AgentId
    `);

  return getPreferencesForAgent(agentId);
}

module.exports = {
  getPreferencesForAgent,
  isAgentNotificationOptedOut,
  resolveAgentByUserId,
  updatePreferencesForAgent
};
