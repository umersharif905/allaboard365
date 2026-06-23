'use strict';

/**
 * belowMinimumCheckService
 *
 * Scheduled job that identifies Standard groups whose pending-enrollment count
 * is below the vendor minimum, and sends alert emails at two thresholds:
 *   - T-10: Warning email (10 days before effective date)
 *   - T-5:  Lock email (1–5 days before effective date)
 *
 * Dedup: oe.GroupMinimumAlerts ensures at most one alert per (GroupId, EffectiveDate, AlertType).
 *
 * Cohort awareness: groups with AllowMidMonthEffective=1 enroll members on the
 * 15th in addition to the 1st. The job runs the alert check independently for
 * each cohort's next effective date and skips groups that haven't opted into
 * mid-month enrollment for the 15th-cohort pass.
 *
 * TODO (Task 4.2): When PR #90 (groupEnrollmentCutoff.js) is merged, import
 *   adjustFixedDateForGroupEnrollmentCutoff and use it to resolve effectiveDate
 *   per group instead of the naive firstOfNextMonth.
 */

const db = require('../config/database');
const { computeApplicableMinimum } = require('./vendorMinimumService');
const MessageQueueService = require('./messageQueue.service');
const EmailTemplatesService = require('./emailTemplates.service');

/**
 * Returns the first day of the month following `today` (UTC).
 * @param {Date} today
 * @returns {Date}
 */
function firstOfNextMonth(today = new Date()) {
  return new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1));
}

/**
 * Returns the next 15th of a month strictly after `today` (UTC). If today is
 * before the 15th of this month, returns this month's 15th; otherwise next
 * month's 15th.
 * @param {Date} today
 * @returns {Date}
 */
function nextFifteenth(today = new Date()) {
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  const d = today.getUTCDate();
  if (d < 15) return new Date(Date.UTC(y, m, 15));
  return new Date(Date.UTC(y, m + 1, 15));
}

/**
 * Returns the whole number of days between two Date objects (a → b).
 * @param {Date} a
 * @param {Date} b
 * @returns {number}
 */
function daysBetween(a, b) {
  return Math.floor((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * Resolve the agent email + name, plus any extra recipients from tenant settings.
 * @param {import('mssql').ConnectionPool} pool
 * @param {string} tenantId
 * @param {string} agentId
 * @returns {Promise<Array<{email: string, firstName: string}>>}
 */
async function resolveRecipients(pool, tenantId, agentId) {
  const recipients = [];

  // Agent email + name
  const agentRow = await pool.request()
    .input('AgentId', agentId)
    .query(`
      SELECT u.Email, u.FirstName
      FROM oe.Agents a
      INNER JOIN oe.Users u ON a.UserId = u.UserId
      WHERE a.AgentId = @AgentId
    `);
  if (agentRow.recordset[0]?.Email) {
    recipients.push({
      email: agentRow.recordset[0].Email,
      firstName: agentRow.recordset[0].FirstName || null
    });
  }

  // Extra recipients from tenant AdvancedSettings.enrollment.belowMinimumAlertRecipients
  const tenantRow = await pool.request()
    .input('TenantId', tenantId)
    .query(`SELECT AdvancedSettings FROM oe.Tenants WHERE TenantId = @TenantId`);
  try {
    const extra = JSON.parse(tenantRow.recordset[0]?.AdvancedSettings || '{}')
      ?.enrollment?.belowMinimumAlertRecipients;
    if (Array.isArray(extra)) {
      for (const addr of extra) {
        if (typeof addr === 'string' && addr.trim()) {
          recipients.push({ email: addr.trim(), firstName: null });
        }
      }
    }
  } catch {
    // malformed JSON — skip extra recipients
  }

  return recipients;
}

function buildGroupUrl(groupId) {
  const base = process.env.FRONTEND_BASE_URL || 'https://allaboard365.com';
  return `${base}/groups/${groupId}`;
}

function buildConvertUrl(groupId) {
  return `${buildGroupUrl(groupId)}/settings?action=request-type-change`;
}

/**
 * Main scheduled job entry point.
 *
 * @param {{ now?: Date }} [options]
 * @returns {Promise<{ processed: number }>}
 */
async function run({ now = new Date() } = {}) {
  // Both cohorts get an independent pass. The 15th-cohort pass is restricted
  // to groups that have opted in via AllowMidMonthEffective=1.
  const candidates = [
    { effectiveDate: firstOfNextMonth(now), midMonth: false },
    { effectiveDate: nextFifteenth(now),    midMonth: true  },
  ];

  let processed = 0;
  let pool = null;

  for (const { effectiveDate, midMonth } of candidates) {
    const daysRemaining = daysBetween(now, effectiveDate);

    // Only fire at exactly T-10 (Warning) or within T-5 window (Lock).
    // Outside those windows, skip this candidate without touching the DB.
    if (daysRemaining !== 10 && daysRemaining > 5) continue;

    if (!pool) pool = await db.getPool();
    const result = await runForEffectiveDate(pool, { effectiveDate, daysRemaining, midMonth });
    processed += Number(result?.processed || 0);
  }

  return { processed };
}

async function runForEffectiveDate(pool, { effectiveDate, daysRemaining, midMonth }) {
  const alertType = daysRemaining === 10 ? 'Warning' : 'Lock';
  const templateName = alertType === 'Warning'
    ? 'group-below-minimum-warning'
    : 'group-below-minimum-lock';

  // Fetch all active Standard groups that have at least one enrollment on that effective date.
  // For the 15th-cohort pass, only groups that opted in via AllowMidMonthEffective=1 qualify.
  const groupsResult = await pool.request()
    .input('EffectiveDate', effectiveDate)
    .query(`
      SELECT DISTINCT g.GroupId, g.TenantId, g.Name AS GroupName, g.AgentId
      FROM oe.Groups g
      WHERE g.GroupType = 'Standard'
        AND g.Status = 'Active'
        ${midMonth ? "AND g.AllowMidMonthEffective = 1" : ""}
        AND EXISTS (
          SELECT 1 FROM oe.Members m
          INNER JOIN oe.Enrollments e ON e.MemberId = m.MemberId
          WHERE m.GroupId = g.GroupId
            AND e.EffectiveDate = @EffectiveDate
        )
    `);

  let processed = 0;

  for (const g of groupsResult.recordset) {
    const minimum = await computeApplicableMinimum(g.GroupId);
    if (!minimum) continue;

    // Count active/pending enrollments for this group on the target effective date.
    const countResult = await pool.request()
      .input('GroupId', g.GroupId)
      .input('EffectiveDate', effectiveDate)
      .query(`
        SELECT COUNT(DISTINCT m.MemberId) AS Cnt
        FROM oe.Members m
        INNER JOIN oe.Enrollments e ON e.MemberId = m.MemberId
        WHERE m.GroupId = @GroupId
          AND e.Status IN ('Active', 'Pending', 'Pending Payment')
          AND e.EffectiveDate = @EffectiveDate
      `);
    const currentMembers = countResult.recordset[0].Cnt;

    if (currentMembers >= minimum) continue;

    // Dedup: skip if we already sent this alert type for this (group, effectiveDate).
    const existing = await pool.request()
      .input('GroupId', g.GroupId)
      .input('EffectiveDate', effectiveDate)
      .input('AlertType', alertType)
      .query(`
        SELECT 1 FROM oe.GroupMinimumAlerts
        WHERE GroupId = @GroupId
          AND EffectiveDate = @EffectiveDate
          AND AlertType = @AlertType
      `);
    if (existing.recordset.length) continue;

    // Resolve recipients and tenant display name.
    const recipients = await resolveRecipients(pool, g.TenantId, g.AgentId);
    if (!recipients.length) {
      // No agent assigned and no manual recipients configured. Skip this
      // group entirely — and crucially, do NOT write a dedup row, so a future
      // run can pick it up once an agent is assigned or a recipient is
      // configured. Writing the dedup row in this case would silently mute
      // alerts for the rest of the effective-date window.
      console.warn(`[belowMinimumCheckService] No recipients for group ${g.GroupId} — skipping email and NOT recording dedup row`);
      continue;
    }

    const tenantConfig = await EmailTemplatesService.getTenantEmailConfig(g.TenantId);
    const effectiveDateStr = effectiveDate.toISOString().slice(0, 10);
    const lockDate = new Date(effectiveDate.getTime() - 5 * 86400000).toISOString().slice(0, 10);
    const groupUrl = buildGroupUrl(g.GroupId);
    const convertUrl = buildConvertUrl(g.GroupId);

    const templateContent = EmailTemplatesService.loadTemplate(templateName);

    // Send one email per recipient so we can personalise agentFirstName.
    for (const recipient of recipients) {
      const htmlContent = EmailTemplatesService.processTemplate(templateContent, {
        tenantName: tenantConfig.tenantName || '',
        agentFirstName: recipient.firstName || 'Agent',
        groupName: g.GroupName,
        currentMemberCount: currentMembers,
        requiredMinimum: minimum,
        effectiveDate: effectiveDateStr,
        daysRemaining,
        lockDate,
        groupUrl,
        convertUrl
      });

      const subject = alertType === 'Warning'
        ? `Action needed: ${g.GroupName} is below the minimum enrollment count`
        : `Enrollments paused: ${g.GroupName} has not reached the vendor minimum`;

      await MessageQueueService.queueEmail({
        tenantId: g.TenantId,
        toEmail: recipient.email,
        toName: recipient.firstName || undefined,
        subject,
        htmlContent,
        messageType: 'Email'
      });
    }

    // Record the alert so we don't re-send.
    await pool.request()
      .input('GroupId', g.GroupId)
      .input('TenantId', g.TenantId)
      .input('EffectiveDate', effectiveDate)
      .input('AlertType', alertType)
      .query(`
        INSERT INTO oe.GroupMinimumAlerts (GroupId, TenantId, EffectiveDate, AlertType)
        VALUES (@GroupId, @TenantId, @EffectiveDate, @AlertType)
      `);

    processed++;
  }

  return { processed };
}

module.exports = { run };
