/**
 * Forward AI Inspector Priority-1 findings to the Cursor automation webhook.
 * Uses the same BUG_REPORT_WEBHOOK_* env vars as the backend bug-report bridge.
 */

/**
 * @param {Array} criticalFindings - [{appServiceName, title, summary, recommendation, category, rawLogExcerpt}, ...]
 * @param {string} runId
 * @param {Function} log
 */
async function publishCriticalFindingsToCursor(criticalFindings, runId, log) {
  if (!criticalFindings || criticalFindings.length === 0) return { sent: 0, skipped: 0 };

  if (process.env.AI_INSPECTOR_CURSOR_AUTOMATION_ENABLED === 'false') {
    log('AI_INSPECTOR_CURSOR_AUTOMATION_ENABLED=false — skipping Cursor webhook');
    return { sent: 0, skipped: criticalFindings.length };
  }

  const url = process.env.BUG_REPORT_WEBHOOK_URL;
  const token = process.env.BUG_REPORT_WEBHOOK_BEARER_TOKEN;
  if (!url || !token) {
    log('BUG_REPORT_WEBHOOK_URL or BUG_REPORT_WEBHOOK_BEARER_TOKEN not set — skipping Cursor webhook');
    return { sent: 0, skipped: criticalFindings.length };
  }

  let sent = 0;
  let failed = 0;

  for (const finding of criticalFindings) {
    const title = finding.title || 'AI Inspector critical finding';
    const context = `AI Inspector P1 [${finding.appServiceName || 'unknown'}]: ${title}`;
    const payload = {
      source: 'ai-inspector',
      priority: 1,
      runId,
      appServiceName: finding.appServiceName || null,
      category: finding.category || null,
      title,
      summary: finding.summary || null,
      recommendation: finding.recommendation || null,
      rawLogExcerpt: finding.rawLogExcerpt || null,
    };

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ context, payload }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
      }

      sent++;
      log(`Cursor webhook sent for P1 finding: ${title}`);
    } catch (err) {
      failed++;
      log(`Cursor webhook failed for "${title}": ${err.message}`);
    }
  }

  return { sent, failed, skipped: 0 };
}

module.exports = { publishCriticalFindingsToCursor };
