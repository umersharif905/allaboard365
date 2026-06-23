'use strict';

/**
 * Every-15-minute SystemIntegrationErrors digest.
 *
 * Contract:
 *   - Only picks rows with Priority IN ('high','critical') that have NotificationSentAt IS NULL.
 *     Known user-resolvable failures (bank declines, validation errors) are recorded as
 *     Priority='normal' elsewhere and never trigger an email.
 *   - Recipients come from oe.SystemSettings key `system.integration_error_notification_emails`
 *     (comma-separated). Empty or missing → no email sent, rows stay un-notified so the next
 *     run (after ops configures recipients) still picks them up.
 *   - Successful send stamps NotificationSentAt so the same row is never emailed twice.
 *   - Cap of 100 rows per run; overflow stays un-notified and rolls into the next digest.
 */

const { getPool, sql } = require('../config/database');
const sendGridEmailService = require('./sendGridEmailService');

const SETTING_KEY = 'system.integration_error_notification_emails';
const MAX_ROWS_PER_RUN = 100;

function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function parseEmails(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/[,;\s]+/g)
    .map((s) => s.trim())
    .filter((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s));
}

function getFromAddress() {
  return (
    process.env.INTEGRATION_ERROR_DIGEST_FROM
    || process.env.BILLING_AUDIT_DAILY_REPORT_FROM
    || process.env.PRODUCT_API_DAILY_REPORT_FROM
    || 'noreply@allaboard365.com'
  );
}

async function loadRecipients(pool) {
  try {
    const res = await pool
      .request()
      .input('key', sql.NVarChar(128), SETTING_KEY)
      .query(`SELECT SettingValue FROM oe.SystemSettings WHERE SettingKey = @key`);
    const raw = res.recordset?.[0]?.SettingValue;
    return parseEmails(raw);
  } catch (e) {
    console.error('integrationErrorDigest: failed to load recipients:', e.message);
    return [];
  }
}

async function loadUnnotifiedHighPriorityRows(pool) {
  const res = await pool
    .request()
    .input('limit', sql.Int, MAX_ROWS_PER_RUN)
    .query(`
      SELECT TOP (@limit)
        IntegrationErrorId,
        Category,
        Source,
        Severity,
        Priority,
        TenantId,
        Message,
        DetailJson,
        CreatedDate
      FROM oe.SystemIntegrationErrors
      WHERE Priority IN (N'high', N'critical')
        AND NotificationSentAt IS NULL
      ORDER BY CreatedDate ASC
    `);
  return res.recordset || [];
}

async function markRowsNotified(pool, errorIds) {
  if (!errorIds || errorIds.length === 0) return;
  // Plain parameterized IN list — an ad-hoc sql.Table() input requires a
  // user-defined table type in the DB, which silently fails and causes the
  // digest to re-email the same rows every run.
  const req = pool.request();
  const placeholders = errorIds.map((id, i) => {
    req.input(`id${i}`, sql.UniqueIdentifier, id);
    return `@id${i}`;
  });
  await req.query(`
    UPDATE oe.SystemIntegrationErrors
    SET NotificationSentAt = SYSUTCDATETIME()
    WHERE IntegrationErrorId IN (${placeholders.join(', ')})
  `);
}

function groupRows(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.Priority || 'normal'}::${r.Category || 'unknown'}::${r.Source || 'unknown'}`;
    if (!groups.has(key)) {
      groups.set(key, {
        priority: r.Priority || 'normal',
        category: r.Category || 'unknown',
        source: r.Source || 'unknown',
        rows: []
      });
    }
    groups.get(key).rows.push(r);
  }
  return Array.from(groups.values()).sort((a, b) => {
    // Critical first, then high; within same priority, newest first
    if (a.priority !== b.priority) {
      return a.priority === 'critical' ? -1 : 1;
    }
    return b.rows[0].CreatedDate - a.rows[0].CreatedDate;
  });
}

function buildSubject(groups) {
  const total = groups.reduce((n, g) => n + g.rows.length, 0);
  const hasCritical = groups.some((g) => g.priority === 'critical');
  const prefix = hasCritical ? '[CRITICAL]' : '[HIGH]';
  const uniqueSources = new Set(groups.map((g) => g.source));
  const topSource = uniqueSources.size === 1 ? `${Array.from(uniqueSources)[0]} ` : '';
  return `${prefix} ${total} new integration error${total === 1 ? '' : 's'} — ${topSource}${new Date().toLocaleString('en-US', { timeZone: 'UTC' })} UTC`;
}

function buildText(groups) {
  const lines = [];
  lines.push(`Open-Enroll SystemIntegrationErrors digest — ${new Date().toISOString()}`);
  lines.push('');
  for (const g of groups) {
    lines.push(`== ${g.priority.toUpperCase()} · ${g.category} · ${g.source} · ${g.rows.length} row(s) ==`);
    for (const r of g.rows) {
      const when = r.CreatedDate instanceof Date ? r.CreatedDate.toISOString() : String(r.CreatedDate);
      lines.push(`  [${when}] tenant=${r.TenantId || '-'} ${r.Message}`);
      if (r.DetailJson) {
        const snippet = String(r.DetailJson).slice(0, 500);
        lines.push(`    detail: ${snippet}${String(r.DetailJson).length > 500 ? '…' : ''}`);
      }
    }
    lines.push('');
  }
  lines.push('Review in the SysAdmin → Integration Errors view.');
  return lines.join('\n');
}

function buildHtml(groups) {
  const priorityBadge = (p) => {
    const color = p === 'critical' ? '#b91c1c' : '#b45309';
    const bg = p === 'critical' ? '#fee2e2' : '#fef3c7';
    return `<span style="display:inline-block;padding:2px 8px;border-radius:9999px;background:${bg};color:${color};font-size:11px;font-weight:600;text-transform:uppercase;">${esc(p)}</span>`;
  };

  const groupBlocks = groups.map((g) => {
    const rows = g.rows.map((r) => {
      const when = r.CreatedDate instanceof Date ? r.CreatedDate.toISOString() : String(r.CreatedDate);
      const detail = r.DetailJson ? `<div style="margin-top:4px;font-family:ui-monospace,Menlo,monospace;font-size:11px;color:#555;white-space:pre-wrap;max-height:120px;overflow:hidden;">${esc(String(r.DetailJson).slice(0, 800))}${String(r.DetailJson).length > 800 ? ' …' : ''}</div>` : '';
      return `<tr>
        <td style="padding:8px;border-top:1px solid #eee;vertical-align:top;white-space:nowrap;font-family:ui-monospace,Menlo,monospace;font-size:11px;color:#555;">${esc(when)}</td>
        <td style="padding:8px;border-top:1px solid #eee;vertical-align:top;font-family:ui-monospace,Menlo,monospace;font-size:11px;color:#555;">${esc(r.TenantId || '—')}</td>
        <td style="padding:8px;border-top:1px solid #eee;vertical-align:top;">
          <div style="font-size:13px;color:#111;">${esc(r.Message || '')}</div>
          ${detail}
        </td>
      </tr>`;
    }).join('');

    return `<div style="margin:0 0 24px;padding:12px;border:1px solid #e5e7eb;border-radius:8px;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
        ${priorityBadge(g.priority)}
        <strong style="font-size:14px;color:#111;">${esc(g.category)}</strong>
        <span style="color:#666;font-size:13px;">· ${esc(g.source)}</span>
        <span style="color:#666;font-size:12px;margin-left:auto;">${g.rows.length} row${g.rows.length === 1 ? '' : 's'}</span>
      </div>
      <table style="border-collapse:collapse;width:100%;font-size:13px;">
        <thead>
          <tr style="text-align:left;color:#666;font-size:11px;text-transform:uppercase;">
            <th style="padding:6px 8px;border-bottom:1px solid #e5e7eb;">When (UTC)</th>
            <th style="padding:6px 8px;border-bottom:1px solid #e5e7eb;">Tenant</th>
            <th style="padding:6px 8px;border-bottom:1px solid #e5e7eb;">Message</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }).join('');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family:system-ui,-apple-system,sans-serif;background:#f9fafb;margin:0;padding:24px;color:#111;">
<div style="max-width:900px;margin:0 auto;">
  <h1 style="font-size:20px;margin:0 0 4px;">Integration errors digest</h1>
  <p style="color:#666;margin:0 0 20px;">${esc(new Date().toLocaleString('en-US', { timeZone: 'UTC' }))} UTC · high &amp; critical priority only</p>
  ${groupBlocks}
  <p style="color:#666;font-size:12px;margin-top:24px;">Known user-resolvable errors (bank declines, validation failures) are not included — they're logged as normal priority and resolved by the member, not ops. To change recipients edit <code>system.integration_error_notification_emails</code> in SysAdmin → Settings.</p>
</div>
</body></html>`;
}

async function runIntegrationErrorDigestJob() {
  const pool = await getPool();

  let rows;
  try {
    rows = await loadUnnotifiedHighPriorityRows(pool);
  } catch (e) {
    const msg = String(e && e.message || '');
    if (msg.includes('Invalid column name') && (msg.includes('Priority') || msg.includes('NotificationSentAt'))) {
      console.log('integrationErrorDigest: migration not applied yet, skipping run');
      return { ok: true, skipped: true, reason: 'migration-not-applied' };
    }
    throw e;
  }

  if (rows.length === 0) {
    return { ok: true, sent: 0, reason: 'no-new-errors' };
  }

  const recipients = await loadRecipients(pool);
  if (recipients.length === 0) {
    console.warn(`integrationErrorDigest: ${rows.length} un-notified rows but no recipients configured — leaving them un-notified`);
    return { ok: true, sent: 0, reason: 'no-recipients', pending: rows.length };
  }

  const groups = groupRows(rows);
  const subject = buildSubject(groups);
  const text = buildText(groups);
  const html = buildHtml(groups);
  const from = getFromAddress();

  try {
    await sendGridEmailService.sendEmail({
      to: recipients,
      from,
      subject,
      text,
      html,
      metadata: { category: 'integration-error-digest' }
    });
  } catch (e) {
    console.error('integrationErrorDigest: email send failed, leaving rows un-notified:', e.message);
    return { ok: false, sent: 0, reason: 'send-failed', error: e.message, pending: rows.length };
  }

  try {
    await markRowsNotified(pool, rows.map((r) => r.IntegrationErrorId));
  } catch (e) {
    // Email was sent but we failed to stamp — log loudly. Better duplicate next run than silent drop.
    console.error('integrationErrorDigest: email sent but NotificationSentAt update failed:', e.message);
  }

  return {
    ok: true,
    sent: rows.length,
    recipients: recipients.length,
    groups: groups.length,
    truncated: rows.length >= MAX_ROWS_PER_RUN
  };
}

module.exports = { runIntegrationErrorDigestJob };
