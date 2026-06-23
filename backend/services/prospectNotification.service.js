// backend/services/prospectNotification.service.js
//
// Centralized "you have a new prospect" agent notification. This is the single
// place every INBOUND channel (website form submissions, external API ingest)
// notifies the owning agent — fired from findOrCreateProspect's creation hook
// (gated by source) so we never duplicate or miss the email.
//
// Agent-self-created prospects (Manual / Proposal / Quote) intentionally do NOT
// reach here — the gating lives in prospect.service.js (NOTIFY_SOURCES).
//
// Resilient by design: every external dependency (DB, preference column that may
// not exist pre-migration, template render, queue) is defensive. This function
// is always called as a fire-and-forget (.catch) from the creation hook, so it
// must resolve quietly on any soft failure rather than throw into the caller.

const { getPool, sql } = require('../config/database');
const { buildTenantAppBaseUrl } = require('../utils/tenantAppUrl');
const EmailTemplatesService = require('./emailTemplates.service');
const MessageQueueService = require('./messageQueue.service');

/**
 * Resolve the owning agent's email + first name (Agents ⋈ Users), scoped to tenant.
 * @returns {Promise<{ email: string|null, firstName: string|null } | null>}
 */
async function resolveAgentContact(pool, { tenantId, agentId }) {
  const r = pool.request();
  r.input('agentId', sql.UniqueIdentifier, agentId);
  r.input('tenantId', sql.UniqueIdentifier, tenantId);
  const res = await r.query(`
    SELECT TOP 1 u.Email, u.FirstName
    FROM oe.Agents a
    INNER JOIN oe.Users u ON a.UserId = u.UserId
    WHERE a.AgentId = @agentId AND a.TenantId = @tenantId
  `);
  const row = res.recordset[0];
  if (!row) return null;
  return { email: row.Email || null, firstName: row.FirstName || null };
}

/**
 * Whether the agent wants the new-prospect email. Reads oe.Agents.NotifyNewProspectEmail:
 *   NULL or 1 => ON (default).  0 => OFF.
 * DEFENSIVE: if the column doesn't exist yet (pre-migration) the query throws — we
 * treat that as ON so the flow works on any DB (mirrors the auth.js fallback).
 * @returns {Promise<boolean>}
 */
async function isNotificationEnabled(pool, { tenantId, agentId }) {
  try {
    const r = pool.request();
    r.input('agentId', sql.UniqueIdentifier, agentId);
    r.input('tenantId', sql.UniqueIdentifier, tenantId);
    const res = await r.query(`
      SELECT TOP 1 NotifyNewProspectEmail
      FROM oe.Agents
      WHERE AgentId = @agentId AND TenantId = @tenantId
    `);
    const row = res.recordset[0];
    if (!row) return true; // no row -> don't suppress; let downstream skip on missing email
    const pref = row.NotifyNewProspectEmail;
    return !(pref === 0 || pref === false);
  } catch (err) {
    // Column likely not present yet -> default ON.
    console.warn('[prospectNotification] preference check failed (defaulting ON):', err && err.message);
    return true;
  }
}

/**
 * Load the tenant row needed to build the portal deep-link base.
 * @returns {Promise<object|null>}
 */
async function getTenantForLink(pool, tenantId) {
  const r = pool.request();
  r.input('tenantId', sql.UniqueIdentifier, tenantId);
  const res = await r.query(`
    SELECT TenantId, Name, CustomLogoUrl, CustomDomain, DefaultUrlPath,
           IsDefaultUrlPathVerified, AdvancedSettings, SupportEmail, ContactEmail
    FROM oe.Tenants WHERE TenantId = @tenantId
  `);
  return res.recordset[0] || null;
}

/**
 * Notify the owning agent that a new (inbound) prospect was created for them.
 * Fire-and-forget: returns (without throwing) on any soft failure — missing
 * email, preference OFF, render/queue error. Never blocks prospect creation.
 *
 * @param {{ tenantId: string, agentId: string, prospect: object }} args
 */
async function notifyAgentOfNewProspect({ tenantId, agentId, prospect }) {
  if (!tenantId || !agentId || !prospect) return;

  const pool = await getPool();

  // Per-agent opt-out (default ON; defensive pre-migration).
  const enabled = await isNotificationEnabled(pool, { tenantId, agentId });
  if (!enabled) return;

  // Resolve the agent's email; skip gracefully if we have nowhere to send.
  const contact = await resolveAgentContact(pool, { tenantId, agentId });
  if (!contact || !contact.email) return;

  // Build the portal deep-link into the agent's Prospects tab.
  const tenant = await getTenantForLink(pool, tenantId);
  const base = tenant ? buildTenantAppBaseUrl(tenant) : 'https://app.allaboard365.com';
  const prospectsUrl = `${base}/agent/prospects`;

  const prospectName =
    [prospect.FirstName, prospect.LastName].filter(Boolean).join(' ').trim() ||
    prospect.Email ||
    prospect.Phone ||
    'New prospect';

  const { subject, html } = await EmailTemplatesService.generateNewProspectNotification({
    tenantId,
    agentName: contact.firstName || 'there',
    prospectName,
    prospectEmail: prospect.Email || null,
    prospectPhone: prospect.Phone || null,
    prospectsUrl,
    source: prospect.Source || null,
  });

  await MessageQueueService.queueEmail({
    tenantId,
    toEmail: contact.email,
    toName: contact.firstName || undefined,
    subject,
    htmlContent: html,
  });
}

module.exports = {
  notifyAgentOfNewProspect,
  // exported for testing
  resolveAgentContact,
  isNotificationEnabled,
};
