'use strict';

const sendGridEmailService = require('../services/sendGridEmailService');
const { resolveFromEmailForTenant } = require('./tenantEmailFrom');

/**
 * Envelope + reply metadata for agent-originated outbound email (SendGrid).
 * @param {string} tenantId
 * @param {{ replyToEmail: string, replyToName: string }} sender
 */
async function resolveAgentOutboundEmailEnvelope(tenantId, sender) {
  const emailConfig = await sendGridEmailService.getTenantEmailConfig(tenantId);
  const fromEmail = resolveFromEmailForTenant(emailConfig);
  const fromDisplayName =
    (sender.replyToName && String(sender.replyToName).trim()) ||
    emailConfig.tenantName ||
    'AllAboard365';
  return {
    fromEmail,
    fromDisplayName,
    replyToEmail: sender.replyToEmail || '',
    replyToName: sender.replyToName || '',
  };
}

module.exports = {
  resolveAgentOutboundEmailEnvelope,
};
