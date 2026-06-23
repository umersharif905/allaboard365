const crypto = require('crypto');
const { publishBugReport } = require('./bugReportWebhookService');

const SENTRY_HOOK_SIGNATURE_HEADER = 'sentry-hook-signature';
const SENTRY_HOOK_RESOURCE_HEADER = 'sentry-hook-resource';
const SENTRY_HOOK_TIMESTAMP_HEADER = 'sentry-hook-timestamp';

function isEnabled() {
  return process.env.SENTRY_CURSOR_AUTOMATION_ENABLED === 'true';
}

function allowedEnvironments() {
  const raw = process.env.SENTRY_CURSOR_ENVIRONMENTS || 'production';
  return new Set(
    raw
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
}

function minEventCount() {
  const parsed = Number.parseInt(process.env.SENTRY_CURSOR_MIN_EVENTS || '1', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

/**
 * Verify Sentry Internal Integration webhook signature.
 * @see https://docs.sentry.io/product/integrations/integration-platform/webhooks/
 */
function verifyWebhookSignature(rawBody, signature, secret) {
  if (!secret || !signature || !Buffer.isBuffer(rawBody) || rawBody.length === 0) {
    return false;
  }

  const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const expected = Buffer.from(digest, 'utf8');
  const actual = Buffer.from(signature, 'utf8');

  if (expected.length !== actual.length) {
    return false;
  }

  return crypto.timingSafeEqual(expected, actual);
}

function parseJsonBody(rawBody) {
  const text = rawBody.toString('utf8');
  if (!text) {
    return null;
  }
  return JSON.parse(text);
}

function getIssueFromPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  if (payload.data?.issue) {
    return payload.data.issue;
  }

  if (payload.issue) {
    return payload.issue;
  }

  return null;
}

function getEventFromPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  if (payload.data?.event) {
    return payload.data.event;
  }

  if (payload.event) {
    return payload.event;
  }

  return null;
}

function formatStackTrace(event) {
  const entries = event?.entries;
  if (!Array.isArray(entries)) {
    return null;
  }

  const exceptionEntry = entries.find((entry) => entry.type === 'exception');
  const values = exceptionEntry?.data?.values;
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }

  const lines = [];
  for (const value of values) {
    if (value.type || value.value) {
      lines.push(`${value.type || 'Error'}: ${value.value || ''}`.trim());
    }

    const frames = value.stacktrace?.frames;
    if (!Array.isArray(frames)) {
      continue;
    }

    for (const frame of frames.slice(-8).reverse()) {
      const location = [frame.filename, frame.function, frame.lineno].filter(Boolean).join(':');
      if (location) {
        lines.push(`  at ${location}`);
      }
    }
  }

  return lines.length > 0 ? lines.join('\n') : null;
}

function shouldForwardIssue({ action, resource, issue, event }) {
  if (!isEnabled()) {
    return { forward: false, reason: 'disabled' };
  }

  const allowedActions = new Set(['created', 'unresolved', 'regression']);
  if (resource === 'issue' && !allowedActions.has(action)) {
    return { forward: false, reason: `ignored action: ${action}` };
  }

  if (resource === 'event_alert' && !issue) {
    return { forward: false, reason: 'event_alert without issue payload' };
  }

  const environments = allowedEnvironments();
  const environment = String(
  issue?.environment
    || event?.environment
    || issue?.tags?.find?.((tag) => tag?.[0] === 'environment')?.[1]
    || '',
  ).toLowerCase();

  if (environment && !environments.has(environment)) {
    return { forward: false, reason: `environment ${environment} not allowed` };
  }

  const eventCount = Number(issue?.count || event?.occurrence?.count || 0);
  if (eventCount > 0 && eventCount < minEventCount()) {
    return { forward: false, reason: `event count ${eventCount} below threshold` };
  }

  return { forward: true };
}

function buildAutomationContext({ action, resource, issue, event }) {
  const title = issue?.title || issue?.metadata?.title || event?.title || 'Unknown Sentry issue';
  const shortId = issue?.shortId || issue?.id || 'unknown';
  const issueUrl = issue?.permalink || issue?.web_url || null;
  const culprit = issue?.culprit || event?.culprit || null;
  const level = issue?.level || event?.level || null;
  const count = issue?.count || event?.occurrence?.count || null;
  const stackTrace = formatStackTrace(event);

  const lines = [
    `Sentry ${resource || 'issue'} ${action || 'event'}: ${title}`,
    `Issue: ${shortId}`,
    issueUrl ? `URL: ${issueUrl}` : null,
    culprit ? `Culprit: ${culprit}` : null,
    level ? `Level: ${level}` : null,
    count ? `Events: ${count}` : null,
    stackTrace ? `Stack trace:\n${stackTrace}` : null,
  ].filter(Boolean);

  return lines.join('\n');
}

function buildAutomationPayload({ action, resource, issue, event, headers }) {
  return {
    source: 'sentry-webhook',
    resource: resource || null,
    action: action || null,
    issue: issue
      ? {
        id: issue.id || null,
        shortId: issue.shortId || null,
        title: issue.title || issue.metadata?.title || null,
        culprit: issue.culprit || null,
        level: issue.level || null,
        status: issue.status || null,
        count: issue.count || null,
        userCount: issue.userCount || null,
        firstSeen: issue.firstSeen || null,
        lastSeen: issue.lastSeen || null,
        permalink: issue.permalink || issue.web_url || null,
        project: issue.project?.slug || issue.project?.name || issue.project || null,
      }
      : null,
    event: event
      ? {
        eventId: event.event_id || event.id || null,
        environment: event.environment || null,
        release: event.release || null,
        platform: event.platform || null,
        transaction: event.transaction || null,
        stackTrace: formatStackTrace(event),
      }
      : null,
    webhook: {
      resource: headers?.[SENTRY_HOOK_RESOURCE_HEADER] || null,
      timestamp: headers?.[SENTRY_HOOK_TIMESTAMP_HEADER] || null,
    },
    triggeredAt: new Date().toISOString(),
  };
}

/**
 * Handle a verified Sentry webhook payload and forward eligible issues to Cursor.
 */
async function handleSentryWebhook({ rawBody, headers }) {
  const payload = parseJsonBody(rawBody);
  if (!payload) {
    return { ok: false, status: 400, message: 'Empty webhook body' };
  }

  const resource = headers?.[SENTRY_HOOK_RESOURCE_HEADER] || payload.action?.type || null;
  const action = payload.action || null;
  const issue = getIssueFromPayload(payload);
  const event = getEventFromPayload(payload);

  const decision = shouldForwardIssue({ action, resource, issue, event });
  if (!decision.forward) {
    return {
      ok: true,
      status: 200,
      forwarded: false,
      reason: decision.reason,
    };
  }

  const context = buildAutomationContext({ action, resource, issue, event });
  const automationPayload = buildAutomationPayload({ action, resource, issue, event, headers });
  const result = await publishBugReport({ context, payload: automationPayload });

  return {
    ok: true,
    status: 200,
    forwarded: true,
    result,
  };
}

module.exports = {
  SENTRY_HOOK_SIGNATURE_HEADER,
  SENTRY_HOOK_RESOURCE_HEADER,
  SENTRY_HOOK_TIMESTAMP_HEADER,
  verifyWebhookSignature,
  handleSentryWebhook,
  shouldForwardIssue,
  buildAutomationContext,
};
