/**
 * Email summary for POST /api/scheduled-jobs/product-api-daily (SendGrid).
 * Recipient: PRODUCT_API_DAILY_REPORT_TO or improve@allaboard365.com
 * From: PRODUCT_API_DAILY_REPORT_FROM or noreply@allaboard365.com (does not use DEFAULT_FROM_EMAIL so ops mail stays on a verified sender).
 */
const sendGridEmailService = require('./sendGridEmailService');
const { sql } = require('../config/database');

function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function getProductNamesByIds(pool, productIds) {
  const ids = [...new Set((productIds || []).filter(Boolean).map((id) => String(id)))];
  if (ids.length === 0) return {};
  const req = pool.request();
  ids.forEach((id, i) => {
    req.input(`p${i}`, sql.UniqueIdentifier, id);
  });
  const placeholders = ids.map((_, i) => `@p${i}`).join(', ');
  const r = await req.query(`
    SELECT CAST(ProductId AS NVARCHAR(36)) AS ProductIdStr, Name
    FROM oe.Products
    WHERE ProductId IN (${placeholders})
  `);
  const map = {};
  for (const row of r.recordset || []) {
    const key = String(row.ProductIdStr || '').toLowerCase();
    if (key) map[key] = row.Name || 'Unknown';
  }
  return map;
}

/**
 * @param {import('mssql').ConnectionPool} pool
 * @param {{ results: any[]; productIds: string[] }} payload
 */
async function sendProductApiDailyRunReport(pool, { results, productIds }) {
  const to = process.env.PRODUCT_API_DAILY_REPORT_TO || 'improve@allaboard365.com';
  const from = process.env.PRODUCT_API_DAILY_REPORT_FROM || 'noreply@allaboard365.com';
  const runDate = new Date().toISOString();

  let nameMap = {};
  try {
    nameMap = await getProductNamesByIds(pool, productIds);
  } catch (e) {
    console.warn('product API daily report: could not load product names', e.message);
  }

  const nameFor = (pid) => {
    const k = String(pid || '').toLowerCase();
    return nameMap[k] || '—';
  };

  let totalActivated = 0;
  let totalDeactivated = 0;
  let totalUpdated = 0;
  let totalRowErrors = 0;
  let fatalFailures = 0;

  for (const row of results || []) {
    if (row.success === false) fatalFailures++;
    else if (!row.skipped) {
      totalActivated += row.activated || 0;
      totalDeactivated += row.deactivated || 0;
      totalUpdated += row.updated || 0;
      totalRowErrors += row.errorCount != null ? row.errorCount : (Array.isArray(row.errors) ? row.errors.length : 0);
    }
  }

  const subject = `Product API daily run — ${new Date().toLocaleString('en-US', { timeZone: 'UTC' })} UTC`;

  const lines = [
    'Product API daily job (runDaily products)',
    `Run at: ${runDate}`,
    '',
    'Totals:',
    `  Created / enrolled (activation path): ${totalActivated}`,
    `  Updated (re-sync path): ${totalUpdated}`,
    `  Terminated / deactivated: ${totalDeactivated}`,
    `  Row-level API errors: ${totalRowErrors}`,
    `  Products with fatal failure: ${fatalFailures}`,
    ''
  ];

  if (!results || results.length === 0) {
    lines.push('No products with Run daily enabled, or nothing to report.');
  } else {
    lines.push('Per product:');
    for (const row of results) {
      const pid = row.productId;
      const label = nameFor(pid);
      if (row.skipped) {
        lines.push(`  - ${label} (${pid}): skipped (${row.reason || 'n/a'})`);
      } else if (row.success === false) {
        lines.push(`  - ${label} (${pid}): FATAL — ${row.error || 'unknown'}`);
      } else {
        const ec = row.errorCount != null ? row.errorCount : (Array.isArray(row.errors) ? row.errors.length : 0);
        lines.push(`  - ${label} (${pid}): activated ${row.activated || 0}, updated ${row.updated || 0}, deactivated ${row.deactivated || 0}, errors ${ec}`);
        const prev = row.errorsPreview || (Array.isArray(row.errors) ? row.errors.slice(0, 5) : []);
        for (const e of prev) {
          const msg = (e && e.message) ? String(e.message).slice(0, 200) : '';
          lines.push(`      · ${e?.type || 'err'} ${e?.memberName || ''}: ${msg}`);
        }
      }
    }
  }

  const text = lines.join('\n');

  const rowsHtml = (results || []).map((row) => {
    const pid = esc(row.productId);
    const label = esc(nameFor(row.productId));
    if (row.skipped) {
      return `<tr><td>${label}</td><td><code>${pid}</code></td><td colspan="4">Skipped (${esc(row.reason)})</td></tr>`;
    }
    if (row.success === false) {
      return `<tr class="err"><td>${label}</td><td><code>${pid}</code></td><td colspan="4"><strong>Fatal:</strong> ${esc(row.error)}</td></tr>`;
    }
    const ec = row.errorCount != null ? row.errorCount : (Array.isArray(row.errors) ? row.errors.length : 0);
    const prev = row.errorsPreview || (Array.isArray(row.errors) ? row.errors.slice(0, 5) : []);
    const errDetail = prev.length
      ? `<ul style="margin:4px 0;padding-left:18px;font-size:12px;">${prev.map((e) =>
          `<li>${esc(e?.type)} — ${esc(e?.memberName)}: ${esc((e?.message || '').slice(0, 180))}</li>`
        ).join('')}</ul>`
      : '';
    return `<tr><td>${label}</td><td><code>${pid}</code></td><td>${row.activated || 0}</td><td>${row.updated || 0}</td><td>${row.deactivated || 0}</td><td>${ec}${errDetail}</td></tr>`;
  }).join('');

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family:system-ui,sans-serif;font-size:14px;color:#111;">
<h2 style="margin:0 0 12px;">Product API daily run</h2>
<p style="color:#555;margin:0 0 16px;">${esc(runDate)} (UTC timestamp)</p>
<table style="border-collapse:collapse;width:100%;max-width:900px;">
<tr style="background:#f3f4f6;text-align:left;">
<th style="padding:8px;border:1px solid #e5e7eb;">Product</th>
<th style="padding:8px;border:1px solid #e5e7eb;">ProductId</th>
<th style="padding:8px;border:1px solid #e5e7eb;">Activated</th>
<th style="padding:8px;border:1px solid #e5e7eb;">Updated</th>
<th style="padding:8px;border:1px solid #e5e7eb;">Deactivated</th>
<th style="padding:8px;border:1px solid #e5e7eb;">Errors</th>
</tr>
${rowsHtml || '<tr><td colspan="6" style="padding:8px;border:1px solid #e5e7eb;">No per-product rows.</td></tr>'}
</table>
<p style="margin-top:16px;"><strong>Totals:</strong> activated ${totalActivated}, updated ${totalUpdated}, deactivated ${totalDeactivated}, row-level errors ${totalRowErrors}, fatal products ${fatalFailures}</p>
</body></html>`;

  try {
    await sendGridEmailService.sendEmail({
      to,
      from,
      subject,
      text,
      html,
      metadata: { category: 'product-api-daily-report' }
    });
    console.log(`📧 Product API daily report sent to ${to}`);
  } catch (e) {
    console.error('❌ Product API daily report email failed:', e.message);
  }
}

module.exports = { sendProductApiDailyRunReport };
