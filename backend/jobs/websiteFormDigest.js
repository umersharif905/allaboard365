// backend/jobs/websiteFormDigest.js
//
// Weekly per-tenant digest of website form submissions. Aggregates the prior
// 7 days (or any window) into a single email per tenant, broken down by
// match status + per-agent counts. Includes an "anomaly" warning if the
// tenant had zero submissions in the window but >0 in the equally-long
// preceding window (the week before).
//
// Triggered by POST /api/cron/website-form-digest (or invoked directly via
// the CLI shim at backend/scripts/run-website-form-digest.js).

const { getPool, sql } = require('../config/database');
const sendGridService = require('../services/sendGridEmailService');
const logger = require('../config/logger');

/**
 * Run the digest job.
 * @param {object} opts
 * @param {Date}  [opts.windowEnd]   default = now (UTC)
 * @param {number}[opts.windowHours] default = 168 (7 days)
 * @param {boolean} [opts.dryRun]    if true, log what would be sent but don't actually send
 * @returns {Promise<{tenantsProcessed:number, emailsSent:number, skipped:number, errors:Array}>}
 */
async function runWebsiteFormDigest(opts = {}) {
    const windowEnd = opts.windowEnd instanceof Date ? opts.windowEnd : new Date();
    const windowHours = Number.isFinite(opts.windowHours) ? opts.windowHours : 168;
    const windowStart = new Date(windowEnd.getTime() - windowHours * 60 * 60 * 1000);
    // Baseline = the equally-long window immediately before this one (e.g. the
    // prior week for a 7-day window). Used for the "forms may be broken" anomaly.
    const baselineStart = new Date(windowStart.getTime() - windowHours * 60 * 60 * 1000);
    const dryRun = opts.dryRun === true;

    logger.info('[WEBSITE-FORM-DIGEST] starting', {
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
        windowHours,
        dryRun
    });

    const pool = await getPool();

    // Find tenants that either had submissions in the window OR are configured
    // with digest recipients (so we can send a "0 today" anomaly alert).
    const tenantsResult = await pool.request()
        .input('windowStart', sql.DateTime2, windowStart)
        .input('windowEnd', sql.DateTime2, windowEnd)
        .input('baselineStart', sql.DateTime2, baselineStart)
        .query(`
            SELECT t.TenantId, t.Name, t.AdvancedSettings,
                   (SELECT COUNT(*) FROM oe.WebsiteFormSubmissions
                      WHERE TenantId = t.TenantId
                        AND SubmittedAt >= @windowStart
                        AND SubmittedAt <  @windowEnd) AS WindowCount,
                   (SELECT COUNT(*) FROM oe.WebsiteFormSubmissions
                      WHERE TenantId = t.TenantId
                        AND SubmittedAt >= @baselineStart
                        AND SubmittedAt <  @windowStart) AS BaselineCount
            FROM oe.Tenants t
            WHERE t.Status = 'Active'
              AND EXISTS (
                SELECT 1 FROM oe.WebsiteFormSubmissions s
                WHERE s.TenantId = t.TenantId
                  AND s.SubmittedAt >= @baselineStart
              )
        `);

    const stats = { tenantsProcessed: 0, emailsSent: 0, skipped: 0, errors: [] };

    for (const tenant of tenantsResult.recordset) {
        let advanced = {};
        try { advanced = tenant.AdvancedSettings ? JSON.parse(tenant.AdvancedSettings) : {}; }
        catch { advanced = {}; }

        const recipients = (advanced.websiteForm?.digestRecipients || [])
            .map((e) => String(e || '').trim())
            .filter(Boolean);

        if (recipients.length === 0) {
            stats.skipped++;
            logger.info('[WEBSITE-FORM-DIGEST] skipping (no recipients)', { tenantId: tenant.TenantId, name: tenant.Name });
            continue;
        }

        stats.tenantsProcessed++;

        try {
            // Pull rows for the window with agent info joined in.
            const rowsResult = await pool.request()
                .input('tenantId', sql.UniqueIdentifier, tenant.TenantId)
                .input('windowStart', sql.DateTime2, windowStart)
                .input('windowEnd', sql.DateTime2, windowEnd)
                .query(`
                    SELECT
                        s.SubmissionId, s.Source, s.FormType, s.MatchStatus,
                        s.MatchedAgentId, s.MatchedAgentCode, s.MatchedAgentEmail,
                        s.AttemptedAgentId, s.AttemptedAgentName,
                        s.SubmitterName, s.SubmitterEmail, s.SubmitterState, s.SubmitterCompany,
                        s.EmailSendStatus, s.EmailFailureReason, s.SubmittedAt,
                        u.FirstName AS AgentFirstName, u.LastName AS AgentLastName
                    FROM oe.WebsiteFormSubmissions s
                    LEFT JOIN oe.Agents a ON a.AgentId = s.MatchedAgentId
                    LEFT JOIN oe.Users u  ON u.UserId  = a.UserId
                    WHERE s.TenantId = @tenantId
                      AND s.SubmittedAt >= @windowStart
                      AND s.SubmittedAt <  @windowEnd
                    ORDER BY s.SubmittedAt ASC
                `);

            const rows = rowsResult.recordset;
            const html = renderDigestHtml({
                tenantName: tenant.Name,
                windowStart, windowEnd, windowHours,
                rows,
                baselineCount: tenant.BaselineCount
            });
            const subject = renderSubject(tenant.Name, rows.length, tenant.BaselineCount, windowHours);

            if (dryRun) {
                stats.skipped++;
                logger.info('[WEBSITE-FORM-DIGEST] (dry-run) would send', {
                    tenantId: tenant.TenantId, recipients, subject, rowCount: rows.length
                });
                continue;
            }

            const result = await sendGridService.sendEmail({
                tenantId: tenant.TenantId,
                to: recipients,
                subject,
                html,
                categories: ['website-form-digest'],
                metadata: { tenantId: tenant.TenantId, kind: 'website-form-digest' }
            });

            if (result.success) {
                stats.emailsSent++;
                logger.info('[WEBSITE-FORM-DIGEST] sent', {
                    tenantId: tenant.TenantId, recipients, rowCount: rows.length
                });
            } else {
                stats.errors.push({ tenantId: tenant.TenantId, error: result.message || 'send failed' });
            }
        } catch (err) {
            logger.error('[WEBSITE-FORM-DIGEST] tenant error', {
                tenantId: tenant.TenantId, error: err.message, stack: err.stack
            });
            stats.errors.push({ tenantId: tenant.TenantId, error: err.message });
        }
    }

    logger.info('[WEBSITE-FORM-DIGEST] complete', stats);
    return stats;
}

function renderSubject(tenantName, rowCount, baselineCount, windowHours) {
    if (rowCount === 0 && baselineCount > 0) {
        return `[${tenantName}] ⚠ No website form submissions in the last ${windowLabel(windowHours)}`;
    }
    return `[${tenantName}] Website form digest: ${rowCount} submission${rowCount === 1 ? '' : 's'}`;
}

function renderDigestHtml({ tenantName, windowStart, windowEnd, windowHours, rows, baselineCount }) {
    const matchedRows = rows.filter((r) => r.MatchStatus === 'matched');
    const unmatchedRows = rows.filter((r) => r.MatchStatus !== 'matched');

    const byStatus = countBy(rows, (r) => r.MatchStatus);
    const bySource = countBy(rows, (r) => r.Source);

    // Aggregate by agent (only matched rows).
    const byAgent = new Map();
    for (const r of matchedRows) {
        const key = r.MatchedAgentCode || 'unknown';
        const name = `${r.AgentFirstName || ''} ${r.AgentLastName || ''}`.trim() || '—';
        const entry = byAgent.get(key) || { name, code: key, email: r.MatchedAgentEmail, count: 0 };
        entry.count++;
        byAgent.set(key, entry);
    }
    const agentRows = [...byAgent.values()].sort((a, b) => b.count - a.count);

    const anomalyBanner = (rows.length === 0 && baselineCount > 0)
        ? `<div style="background:#fff3cd;border:1px solid #ffeeba;color:#856404;padding:12px;border-radius:6px;margin-bottom:16px;">
             <strong>⚠ No submissions in the last ${windowLabel(windowHours)}.</strong>
             Your forms received ${baselineCount} submission${baselineCount === 1 ? '' : 's'} in the prior ${windowLabel(windowHours)}.
             If you're expecting traffic, the form may be broken — please verify.
           </div>`
        : '';

    return `
<!doctype html>
<html>
<body style="font-family:Inter,Arial,sans-serif;color:#222;max-width:720px;margin:0 auto;padding:24px;">
  <h2 style="margin:0 0 4px;">${escapeHtml(tenantName)} — Website Form Digest</h2>
  <p style="color:#666;margin:0 0 16px;">
    ${escapeHtml(fmtDate(windowStart))} → ${escapeHtml(fmtDate(windowEnd))} UTC
  </p>

  ${anomalyBanner}

  <div style="background:#f6f8fa;border:1px solid #e1e4e8;border-radius:6px;padding:16px;margin-bottom:20px;">
    <div style="font-size:13px;color:#666;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">Totals</div>
    <div style="font-size:28px;font-weight:600;line-height:1;">${rows.length}</div>
    <div style="color:#666;margin-top:4px;">total submission${rows.length === 1 ? '' : 's'}</div>
    <div style="margin-top:12px;">
      ${renderBadgeRow(byStatus, statusLabel)}
    </div>
    <div style="margin-top:6px;">
      ${renderBadgeRow(bySource, sourceLabel)}
    </div>
  </div>

  ${agentRows.length > 0 ? `
    <h3 style="margin:24px 0 8px;">By advisor (${matchedRows.length} matched)</h3>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">
      <thead>
        <tr style="background:#f6f8fa;text-align:left;">
          <th style="padding:8px;border-bottom:1px solid #e1e4e8;">Advisor</th>
          <th style="padding:8px;border-bottom:1px solid #e1e4e8;">Agent Code</th>
          <th style="padding:8px;border-bottom:1px solid #e1e4e8;text-align:right;">Submissions</th>
        </tr>
      </thead>
      <tbody>
        ${agentRows.map((a) => `
          <tr>
            <td style="padding:8px;border-bottom:1px solid #f0f0f0;">${escapeHtml(a.name)}</td>
            <td style="padding:8px;border-bottom:1px solid #f0f0f0;font-family:monospace;">${escapeHtml(a.code)}</td>
            <td style="padding:8px;border-bottom:1px solid #f0f0f0;text-align:right;">${a.count}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  ` : ''}

  ${unmatchedRows.length > 0 ? `
    <h3 style="margin:24px 0 8px;">Unmatched / errored (${unmatchedRows.length})</h3>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">
      <thead>
        <tr style="background:#f6f8fa;text-align:left;">
          <th style="padding:8px;border-bottom:1px solid #e1e4e8;">Time</th>
          <th style="padding:8px;border-bottom:1px solid #e1e4e8;">Status</th>
          <th style="padding:8px;border-bottom:1px solid #e1e4e8;">Attempted</th>
          <th style="padding:8px;border-bottom:1px solid #e1e4e8;">Submitter</th>
        </tr>
      </thead>
      <tbody>
        ${unmatchedRows.map((r) => `
          <tr>
            <td style="padding:8px;border-bottom:1px solid #f0f0f0;color:#666;">${escapeHtml(fmtTime(r.SubmittedAt))}</td>
            <td style="padding:8px;border-bottom:1px solid #f0f0f0;"><span style="background:#ffebee;color:#c62828;padding:2px 8px;border-radius:10px;font-size:12px;">${escapeHtml(statusLabel(r.MatchStatus))}</span></td>
            <td style="padding:8px;border-bottom:1px solid #f0f0f0;font-family:monospace;font-size:13px;">${escapeHtml(r.AttemptedAgentId || r.AttemptedAgentName || '—')}</td>
            <td style="padding:8px;border-bottom:1px solid #f0f0f0;">${escapeHtml(r.SubmitterName || r.SubmitterEmail || '—')}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  ` : ''}

  <p style="color:#999;font-size:12px;margin-top:32px;">
    This is an automated weekly summary from AllAboard365. Recipients are configured in
    Tenant Settings → Marketing Links → Digest Recipients.
  </p>
</body>
</html>
    `.trim();
}

function renderBadgeRow(map, labelFn) {
    const entries = [...map.entries()].sort((a, b) => b[1] - a[1]);
    return entries.map(([k, v]) =>
        `<span style="display:inline-block;background:#fff;border:1px solid #e1e4e8;border-radius:12px;padding:2px 10px;font-size:13px;margin-right:6px;">${escapeHtml(labelFn(k))}: <strong>${v}</strong></span>`
    ).join('');
}

function statusLabel(s) {
    return {
        matched: 'Matched',
        not_found: 'Not found',
        ambiguous_id: 'Ambiguous (ID)',
        ambiguous_name: 'Ambiguous (name)',
        error: 'Lookup error',
        unconfigured: 'Unconfigured',
        no_attribution: 'No attribution'
    }[s] || s;
}

function sourceLabel(s) {
    return { quote: 'Quote forms', contact: 'Contact forms' }[s] || s;
}

function countBy(arr, keyFn) {
    const m = new Map();
    for (const item of arr) {
        const k = keyFn(item);
        m.set(k, (m.get(k) || 0) + 1);
    }
    return m;
}

// Human-friendly label for a window length in hours: 168 -> "week", 24 -> "day",
// falling back to "<n>h" for anything that isn't a whole number of weeks/days.
function windowLabel(windowHours) {
    if (windowHours % 168 === 0) {
        const weeks = windowHours / 168;
        return weeks === 1 ? 'week' : `${weeks} weeks`;
    }
    if (windowHours % 24 === 0) {
        const days = windowHours / 24;
        return days === 1 ? 'day' : `${days} days`;
    }
    return `${windowHours}h`;
}

function fmtDate(d) {
    return d.toISOString().slice(0, 16).replace('T', ' ');
}
function fmtTime(d) {
    return new Date(d).toISOString().slice(11, 16) + ' UTC';
}
function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

module.exports = { runWebsiteFormDigest };
