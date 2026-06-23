'use strict';

/**
 * Overdue invoice reminder — orchestrator entry.
 *
 * Iterates tenants where AdvancedSettings.billing.overdueReminders.enabled is true,
 * pulls candidate invoices (via overdueInvoiceReminder.service), and for each one
 * attempts to queue an email and/or SMS per the tenant's channel settings. Records
 * one InvoiceReminderLog row per (channel) attempt, regardless of outcome —
 * including skips, so the cadence counter advances even when a recipient is missing
 * (avoids re-trying the same dead address every night).
 *
 * Per-tenant try/catch — one tenant's bad data cannot kill the run for others.
 * Same failure-isolation pattern used in billingNightlyOrchestrator.service.js.
 */

const sql = require('mssql');
const { getPool } = require('../config/database');
const reminderService = require('./overdueInvoiceReminder.service');
const composer = require('./overdueInvoiceReminderEmail.service');

/**
 * Default settings used when a tenant has not configured billing.overdueReminders.
 * enabled=true makes the feature opt-OUT — every Active tenant participates with
 * sane defaults the moment the runner ships. Tenants who want different behavior
 * (or want the feature off entirely) override via the settings UI.
 */
const DEFAULT_SETTINGS = {
  enabled: true,
  thresholdDays: 6,
  cadenceDays: 7,
  maxCount: 4,
  skipUnderAmount: 0,
  channels: { email: true, sms: false },
  replyToEmail: null
};

/**
 * Parse settings from a tenant's AdvancedSettings JSON. Always returns a
 * fully-populated object — when the JSON is missing, malformed, or has no
 * billing.overdueReminders block, returns DEFAULT_SETTINGS (enabled=true).
 * The only way to silence the runner is to explicitly set enabled=false.
 */
function parseSettings(advancedSettingsJson) {
  if (!advancedSettingsJson) return { ...DEFAULT_SETTINGS, channels: { ...DEFAULT_SETTINGS.channels } };
  try {
    const adv = typeof advancedSettingsJson === 'string'
      ? JSON.parse(advancedSettingsJson)
      : advancedSettingsJson;
    const r = adv?.billing?.overdueReminders;
    if (!r || typeof r !== 'object') {
      return { ...DEFAULT_SETTINGS, channels: { ...DEFAULT_SETTINGS.channels } };
    }
    return {
      // Opt-out: only an explicit false silences the feature.
      enabled: r.enabled !== false,
      thresholdDays: Number.isFinite(Number(r.thresholdDays)) ? Number(r.thresholdDays) : DEFAULT_SETTINGS.thresholdDays,
      cadenceDays: Number.isFinite(Number(r.cadenceDays)) ? Number(r.cadenceDays) : DEFAULT_SETTINGS.cadenceDays,
      maxCount: Number.isFinite(Number(r.maxCount)) ? Number(r.maxCount) : DEFAULT_SETTINGS.maxCount,
      skipUnderAmount: Number.isFinite(Number(r.skipUnderAmount)) ? Number(r.skipUnderAmount) : DEFAULT_SETTINGS.skipUnderAmount,
      channels: {
        email: r.channels?.email !== false,
        sms: r.channels?.sms === true
      },
      replyToEmail: typeof r.replyToEmail === 'string' && r.replyToEmail.trim() ? r.replyToEmail.trim() : null
    };
  } catch (_) {
    return { ...DEFAULT_SETTINGS, channels: { ...DEFAULT_SETTINGS.channels } };
  }
}

/**
 * Pull all Active tenants and resolve each to a settings object. Tenants with
 * no billing.overdueReminders block (or no AdvancedSettings at all) receive
 * DEFAULT_SETTINGS via parseSettings, so they participate by default.
 * The returned list contains only tenants where settings.enabled is true.
 */
async function listEnabledTenants() {
  const pool = await getPool();
  const result = await pool.request().query(`
    SELECT TenantId, Name, AdvancedSettings
    FROM oe.Tenants
    WHERE Status = N'Active'
  `);
  return result.recordset
    .map((row) => ({
      tenantId: String(row.TenantId),
      tenantName: row.Name,
      settings: parseSettings(row.AdvancedSettings)
    }))
    .filter((t) => t.settings && t.settings.enabled);
}

/**
 * Resolve recipient details for one candidate based on invoice type + channel.
 * Returns null when the channel is not deliverable for this candidate (e.g. no
 * email on file, SMS without consent). Caller logs a Skipped row in that case.
 */
function resolveRecipient(candidate, channel) {
  if (candidate.recipientType === 'GroupBilling') {
    if (channel === 'Email') {
      const addr = (candidate.GroupContactEmail || '').trim();
      if (!addr) return { skipReason: 'NoRecipient' };
      return {
        address: addr,
        name: candidate.GroupContactName || candidate.GroupName || ''
      };
    }
    // SMS to groups deferred in v1 — no consent flag exists.
    return { skipReason: 'GroupSmsNotSupported' };
  }
  // MemberPrimary
  if (channel === 'Email') {
    const addr = (candidate.MemberEmail || '').trim();
    if (!addr) return { skipReason: 'NoRecipient' };
    return {
      address: addr,
      name: candidate.MemberFirstName || ''
    };
  }
  if (channel === 'SMS') {
    const phone = (candidate.MemberPhone || '').trim();
    if (!phone) return { skipReason: 'NoRecipient' };
    // oe.Members.SmsConsent is BIT. Send unless EXPLICITLY denied (false/0).
    // Null / unset / true all proceed — billing reminders to a member who has
    // an outstanding invoice are transactional, not marketing.
    if (candidate.MemberSmsConsent === false || candidate.MemberSmsConsent === 0) {
      return { skipReason: 'NoConsent' };
    }
    return {
      address: phone,
      name: candidate.MemberFirstName || ''
    };
  }
  return { skipReason: 'UnknownChannel' };
}

async function processCandidate({ tenant, candidate, channel, dryRun }) {
  const recipient = resolveRecipient(candidate, channel);
  const baseLog = {
    tenantId: tenant.tenantId,
    invoiceId: candidate.InvoiceId,
    attemptNumber: candidate.nextAttemptNumber,
    channel,
    recipientType: candidate.recipientType,
    daysOverdueAtSend: candidate.DaysOverdue
  };

  if (recipient.skipReason) {
    if (dryRun) {
      return { ok: true, skipped: true, dryRun: true, skipReason: recipient.skipReason };
    }
    await reminderService.recordSend({
      ...baseLog,
      recipientAddress: '(none)',
      queuedMessageId: null,
      status: 'Skipped',
      skipReason: recipient.skipReason
    });
    return { ok: true, skipped: true, skipReason: recipient.skipReason };
  }

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      previewRecipient: recipient.address,
      previewSubjectLead: channel === 'SMS' ? 'SMS body' : 'Email subject'
    };
  }

  try {
    let queuedMessageId = null;
    if (channel === 'Email') {
      const recipientUserId =
        candidate.recipientType === 'MemberPrimary' && candidate.MemberUserId
          ? String(candidate.MemberUserId)
          : null;
      const r = await composer.composeAndQueueEmail({
        tenantId: tenant.tenantId,
        invoice: candidate,
        recipientEmail: recipient.address,
        recipientName: recipient.name,
        recipientType: candidate.recipientType,
        attemptNumber: candidate.nextAttemptNumber,
        maxCount: tenant.settings.maxCount,
        daysOverdue: candidate.DaysOverdue,
        replyToEmail: tenant.settings.replyToEmail,
        recipientUserId
      });
      queuedMessageId = r.messageId;
    } else {
      const recipientUserId =
        candidate.recipientType === 'MemberPrimary' && candidate.MemberUserId
          ? String(candidate.MemberUserId)
          : null;
      const r = await composer.composeAndQueueSms({
        tenantId: tenant.tenantId,
        invoice: candidate,
        recipientPhone: recipient.address,
        recipientType: candidate.recipientType,
        attemptNumber: candidate.nextAttemptNumber,
        maxCount: tenant.settings.maxCount,
        daysOverdue: candidate.DaysOverdue,
        recipientUserId
      });
      queuedMessageId = r.messageId;
    }

    const logResult = await reminderService.recordSend({
      ...baseLog,
      recipientAddress: recipient.address,
      queuedMessageId,
      status: 'Queued'
    });
    if (logResult.duplicate) {
      return { ok: true, skipped: true, skipReason: 'DuplicateLogRow', queuedMessageId };
    }
    return { ok: true, queuedMessageId };
  } catch (err) {
    try {
      await reminderService.recordSend({
        ...baseLog,
        recipientAddress: recipient.address,
        queuedMessageId: null,
        status: 'Failed',
        skipReason: (err.message || 'unknown').slice(0, 200)
      });
    } catch (_) { /* best-effort log */ }
    return { ok: false, error: err.message };
  }
}

/**
 * Run the reminder pass.
 *
 * @param {object} [opts]
 * @param {string|null} [opts.tenantId]   - if provided, only this tenant runs
 * @param {boolean} [opts.dryRun]         - no DB writes, no queue handoff; returns plan
 * @returns {Promise<object>} per-tenant + overall summary
 */
async function run(opts = {}) {
  const { tenantId: filterTenantId = null, dryRun = false } = opts;

  const startedAt = new Date().toISOString();
  const tenants = await listEnabledTenants();
  const scoped = filterTenantId
    ? tenants.filter((t) => String(t.tenantId).toLowerCase() === String(filterTenantId).toLowerCase())
    : tenants;

  const tenantSummaries = [];
  let totalQueued = 0;
  let totalSkipped = 0;
  let totalFailed = 0;

  for (const tenant of scoped) {
    const tSummary = {
      tenantId: tenant.tenantId,
      tenantName: tenant.tenantName,
      candidateCount: 0,
      queuedEmails: 0,
      queuedSms: 0,
      skipped: 0,
      failed: 0,
      errors: []
    };
    try {
      const candidates = await reminderService.selectCandidatesForTenant(tenant.tenantId, tenant.settings);
      tSummary.candidateCount = candidates.length;

      for (const candidate of candidates) {
        const channels = [];
        if (tenant.settings.channels.email) channels.push('Email');
        if (tenant.settings.channels.sms) channels.push('SMS');

        for (const channel of channels) {
          const r = await processCandidate({ tenant, candidate, channel, dryRun });
          if (!r.ok) {
            tSummary.failed += 1;
            totalFailed += 1;
            tSummary.errors.push({
              invoiceId: candidate.InvoiceId,
              channel,
              error: r.error
            });
          } else if (r.skipped) {
            tSummary.skipped += 1;
            totalSkipped += 1;
          } else {
            if (channel === 'Email') tSummary.queuedEmails += 1;
            else if (channel === 'SMS') tSummary.queuedSms += 1;
            totalQueued += 1;
          }
        }
      }
    } catch (e) {
      tSummary.errors.push({ scope: 'tenant', error: e.message });
      tSummary.failed += 1;
      totalFailed += 1;
    }
    tenantSummaries.push(tSummary);
  }

  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    dryRun,
    tenantCount: scoped.length,
    totalQueued,
    totalSkipped,
    totalFailed,
    tenants: tenantSummaries
  };
}

module.exports = {
  run,
  parseSettings,
  listEnabledTenants
};
