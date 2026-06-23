'use strict';

const sendGridEmailService = require('./sendGridEmailService');
const { parseBillingAuditReportEmails } = require('./billingAuditReportRecipients.service');

/** Consolidated nightly report always goes here when SendGrid is enabled (ops backup). */
const BACKUP_BILLING_AUDIT_REPORT_TO = 'improve@allaboard365.com';

function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function getFromAddress() {
  return process.env.BILLING_AUDIT_DAILY_REPORT_FROM || process.env.PRODUCT_API_DAILY_REPORT_FROM || 'noreply@allaboard365.com';
}

function textLinesForMissingRecurringDelta(t) {
  const d = t.missingRecurringSinceLastReport;
  if (!d || typeof d !== 'object') return [];
  const lines = [];
  if (d.comparable === true) {
    const prevWhen = d.previousRunAtUtc
      ? new Date(d.previousRunAtUtc).toLocaleString('en-US', { timeZone: 'UTC' }) + ' UTC'
      : 'prior run';
    if ((d.resolvedCount ?? 0) > 0) {
      lines.push(`  Missing recurring — resolved since last report (${prevWhen}): ${d.resolvedCount}`);
      if (Array.isArray(d.resolved) && d.resolved.length > 0) {
        const shown = d.resolved.slice(0, 25);
        const label = shown
          .map((r) => (r.memberName ? String(r.memberName) : String(r.memberId)))
          .join(', ');
        lines.push(`    ${label}${d.resolvedTruncated ? ' …' : ''}`);
      }
    }
    if ((d.newlyMissingCount ?? 0) > 0) {
      lines.push(`  Missing recurring — new since last report: ${d.newlyMissingCount}`);
    }
    if (
      (d.resolvedCount ?? 0) === 0 &&
      (d.newlyMissingCount ?? 0) === 0 &&
      (d.previousMissingCount != null || d.currentMissingCount != null)
    ) {
      lines.push(
        `  Missing recurring — vs last report: ${d.previousMissingCount ?? '—'} → ${d.currentMissingCount ?? '—'} (no net change in resolved/new counts)`
      );
    }
  } else if (d.reason === 'no_prior_snapshot') {
    lines.push('  Missing recurring — no prior snapshot yet (comparison starts on the next saved report).');
  }
  return lines;
}

function fmtBadJsonSummary(s) {
  if (!s || s.paymentJsonInvalidIncluded === false) return '—';
  return s.paymentJsonInvalidCount ?? '—';
}

function linesForOneTenant(t) {
  const s = t.auditSummary || {};
  const lines = [
    `— ${t.tenantName} (${t.tenantId})`,
    `  Failed (unresolved): ${s.unresolvedFailedPayments ?? '—'} | Webhook errors (30d): ${s.webhookErrors30d ?? '—'} | Missing recurring: ${s.missingRecurringCount ?? '—'} | Bad JSON rows: ${fmtBadJsonSummary(s)} | DB MRR: ${s.dbMrrTotal ?? '—'}`
  ];
  lines.push(...textLinesForMissingRecurringDelta(t));
  const results = t.auditRun?.results || {};
  for (const [id, r] of Object.entries(results)) {
    if (!r || typeof r !== 'object') continue;
    const ok = r.ok === false ? 'FAIL' : 'ok';
    const c = r.count != null ? ` count=${r.count}` : '';
    const er = r.error ? ` err=${String(r.error).slice(0, 120)}` : '';
    lines.push(`    ${id}: ${ok}${c}${er}`);
  }
  return lines;
}

function htmlMissingRecurringDelta(t) {
  const d = t.missingRecurringSinceLastReport;
  if (!d || typeof d !== 'object') return '';
  if (d.comparable === true) {
    const prevWhen = d.previousRunAtUtc
      ? esc(new Date(d.previousRunAtUtc).toLocaleString('en-US', { timeZone: 'UTC' }) + ' UTC')
      : 'prior run';
    const parts = [];
    if ((d.resolvedCount ?? 0) > 0) {
      const list = (d.resolved || [])
        .slice(0, 20)
        .map((r) => esc(r.memberName || r.memberId))
        .join(', ');
      parts.push(
        `<strong>Missing recurring</strong> — <span style="color:#166534;">${d.resolvedCount} resolved</span> since last report (${prevWhen})${list ? `: ${list}` : ''}${d.resolvedTruncated ? ' …' : ''}`
      );
    }
    if ((d.newlyMissingCount ?? 0) > 0) {
      parts.push(
        `<strong>Missing recurring</strong> — <span style="color:#b45309;">${d.newlyMissingCount} new</span> since last report`
      );
    }
    return parts.length
      ? `<p style="margin:6px 0 0;font-size:13px;color:#374151;">${parts.join('<br/>')}</p>`
      : '';
  }
  if (d.reason === 'no_prior_snapshot') {
    return `<p style="margin:6px 0 0;font-size:12px;color:#6b7280;">No prior snapshot for missing-recurring comparison yet.</p>`;
  }
  return '';
}

function htmlTableRowForTenant(t) {
  const s = t.auditSummary || {};
  return `<tr>
<td style="padding:8px;border:1px solid #e5e7eb;">${esc(t.tenantName)}</td>
<td style="padding:8px;border:1px solid #e5e7eb;"><code>${esc(t.tenantId)}</code></td>
<td style="padding:8px;border:1px solid #e5e7eb;">${esc(s.unresolvedFailedPayments)}</td>
<td style="padding:8px;border:1px solid #e5e7eb;">${esc(s.webhookErrors30d)}</td>
<td style="padding:8px;border:1px solid #e5e7eb;">${esc(s.missingRecurringCount)}</td>
<td style="padding:8px;border:1px solid #e5e7eb;">${esc(s.paymentHoldEnrollmentCount)}</td>
<td style="padding:8px;border:1px solid #e5e7eb;">${esc(fmtBadJsonSummary(s))}</td>
<td style="padding:8px;border:1px solid #e5e7eb;">${esc(s.dbMrrTotal)}</td>
</tr>`;
}

/**
 * @param {object} opts
 * @param {Array<{ tenantId: string; tenantName: string; auditSummary: object; auditRun: object; billingAuditReportEmails?: string|null }>} opts.perTenant
 * @param {string[]} opts.errors
 */
async function sendBillingAuditDailyReport(opts) {
  const from = getFromAddress();
  const runDate = new Date().toISOString();
  const subject = `Billing audit daily — ${new Date().toLocaleString('en-US', { timeZone: 'UTC' })} UTC`;

  const rows = opts.perTenant || [];
  const errList = opts.errors || [];

  const lines = [
    'Billing audit daily (per-tenant summary + DB-only audits)',
    `Run at: ${runDate}`,
    `Tenants: ${rows.length}`,
    errList.length ? `Errors: ${errList.length}` : '',
    ''
  ].filter(Boolean);

  for (const t of rows) {
    lines.push(...linesForOneTenant(t));
    lines.push('');
  }

  if (errList.length) {
    lines.push('Failures:');
    for (const e of errList.slice(0, 50)) lines.push(`  - ${e}`);
  }

  const text = lines.join('\n');

  const tableRows = rows.map((t) => htmlTableRowForTenant(t)).join('');

  const errHtml =
    errList.length > 0
      ? `<p style="color:#b91c1c;"><strong>${errList.length} tenant run(s) failed.</strong></p><pre style="background:#fef2f2;padding:8px;font-size:12px;">${esc(
          errList.slice(0, 30).join('\n')
        )}</pre>`
      : '';

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family:system-ui,sans-serif;font-size:14px;color:#111;">
<h2 style="margin:0 0 12px;">Billing audit daily</h2>
<p style="color:#555;margin:0 0 16px;">${esc(runDate)} UTC · ${rows.length} tenant(s)</p>
${errHtml}
<table style="border-collapse:collapse;width:100%;max-width:1100px;">
<tr style="background:#f3f4f6;text-align:left;">
<th style="padding:8px;border:1px solid #e5e7eb;">Tenant</th>
<th style="padding:8px;border:1px solid #e5e7eb;">Id</th>
<th style="padding:8px;border:1px solid #e5e7eb;">Failed</th>
<th style="padding:8px;border:1px solid #e5e7eb;">Webhook err (30d)</th>
<th style="padding:8px;border:1px solid #e5e7eb;">Miss recur</th>
<th style="padding:8px;border:1px solid #e5e7eb;">PayHold</th>
<th style="padding:8px;border:1px solid #e5e7eb;">Bad JSON</th>
<th style="padding:8px;border:1px solid #e5e7eb;">DB MRR</th>
</tr>
${tableRows || '<tr><td colspan="8" style="padding:8px;border:1px solid #e5e7eb;">No rows.</td></tr>'}
</table>
<div style="margin-top:12px;max-width:1100px;">
${rows
  .map((t) => {
    const h = htmlMissingRecurringDelta(t);
    return h ? `<div style="margin-bottom:8px;">${h}</div>` : '';
  })
  .join('')}
</div>
<p style="margin-top:16px;font-size:12px;color:#666;">Open Tenant Billing → Audit in the admin UI for details. DIME reconcile runs only when using POST /api/scheduled-jobs/billing-nightly (or manual Run audits → Payment status vs DIME).</p>
</body></html>`;

  try {
    await sendGridEmailService.sendEmail({
      to: BACKUP_BILLING_AUDIT_REPORT_TO,
      from,
      subject,
      text,
      html,
      metadata: { category: 'billing-audit-daily-report' }
    });
    console.log(`📧 Billing audit daily report sent to ${BACKUP_BILLING_AUDIT_REPORT_TO}`);
  } catch (e) {
    console.error('❌ Billing audit daily report email failed:', e.message);
  }

  for (const t of rows) {
    const raw = t.billingAuditReportEmails;
    const recipients = parseBillingAuditReportEmails(raw);
    if (recipients.length === 0) continue;

    const tenantLines = [
      `${t.tenantName} — billing audit nightly`,
      `Run at: ${runDate}`,
      '',
      ...linesForOneTenant(t),
      ''
    ];
    const tenantText = tenantLines.join('\n');

    const oneRow = htmlTableRowForTenant(t);
    const tenantHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family:system-ui,sans-serif;font-size:14px;color:#111;">
<h2 style="margin:0 0 12px;">${esc(t.tenantName)}</h2>
<p style="color:#555;margin:0 0 16px;">${esc(runDate)} UTC · your tenant only</p>
<table style="border-collapse:collapse;width:100%;max-width:1100px;">
<tr style="background:#f3f4f6;text-align:left;">
<th style="padding:8px;border:1px solid #e5e7eb;">Tenant</th>
<th style="padding:8px;border:1px solid #e5e7eb;">Id</th>
<th style="padding:8px;border:1px solid #e5e7eb;">Failed</th>
<th style="padding:8px;border:1px solid #e5e7eb;">Webhook err (30d)</th>
<th style="padding:8px;border:1px solid #e5e7eb;">Miss recur</th>
<th style="padding:8px;border:1px solid #e5e7eb;">PayHold</th>
<th style="padding:8px;border:1px solid #e5e7eb;">Bad JSON</th>
<th style="padding:8px;border:1px solid #e5e7eb;">DB MRR</th>
</tr>
${oneRow}
</table>
${htmlMissingRecurringDelta(t)}
<p style="margin-top:16px;font-size:12px;color:#666;">Configure recipients under Tenant Billing → Audit (daily report settings). DIME reconcile runs only via billing-nightly orchestrator or manual audits.</p>
</body></html>`;

    const tenantSubject = `Billing audit — ${t.tenantName} — ${new Date().toLocaleString('en-US', { timeZone: 'UTC' })} UTC`;

    try {
      await sendGridEmailService.sendEmail({
        tenantId: t.tenantId,
        to: recipients,
        from,
        subject: tenantSubject,
        text: tenantText,
        html: tenantHtml,
        metadata: { category: 'billing-audit-daily-report-tenant' }
      });
      console.log(`📧 Billing audit daily (tenant) sent to ${recipients.join(', ')} for ${t.tenantName}`);
    } catch (e) {
      console.error(`❌ Billing audit daily tenant email failed (${t.tenantId}):`, e.message);
    }
  }
}

module.exports = { sendBillingAuditDailyReport, BACKUP_BILLING_AUDIT_REPORT_TO };
