/**
 * CAN-SPAM / RFC 8058: one-click unsubscribe for marketing email.
 * GET: browser link → renders a self-contained branded confirmation page.
 * POST: List-Unsubscribe=One-Click (background request) → 200, no body needed.
 *
 * The HTML is fully self-contained (inline CSS) so it looks right regardless of
 * whether the SPA is deployed/configured — email clients open this URL directly.
 */
const express = require('express');
const router = express.Router();
const { verifyMarketingUnsubscribeToken } = require('../../services/marketingUnsubscribeToken.service');
const { optOutEmailMarketingFromUnsubscribe } = require('../../services/memberCommunicationPreferences.service');
const { frontendBase, escapeHtml } = require('../../services/marketingEmailCompliance.service');

function wantsJson(req) {
  const accept = (req.get('accept') || '').toLowerCase();
  return accept.includes('application/json') || (req.get('x-requested-with') || '').toLowerCase() === 'xmlhttprequest';
}

/** Self-contained branded confirmation/error page. */
function renderUnsubscribePage({ ok, message }) {
  const feBase = frontendBase();
  const prefsUrl = feBase ? `${feBase}/member/communication-preferences` : null;
  const loginUrl = feBase ? `${feBase}/login` : null;

  const accent = ok ? '#1f8dbf' : '#dc2626';
  const accentSoft = ok ? '#d6eef8' : '#fee2e2';
  const title = ok ? 'You’re unsubscribed' : 'Link not valid';
  const heading = ok ? 'You’re unsubscribed' : 'This link didn’t work';
  const bodyText = ok
    ? 'You’ll no longer receive marketing emails from us. You may still get important account and legally required messages.'
    : escapeHtml(message || 'This unsubscribe link is invalid or has expired.');

  const icon = ok
    ? `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="${accent}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`
    : `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="${accent}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>`;

  const actions = ok
    ? [
        prefsUrl ? `<a class="btn btn-primary" href="${prefsUrl}">Manage notification preferences</a>` : '',
        loginUrl ? `<a class="btn btn-secondary" href="${loginUrl}">Go to your account</a>` : ''
      ].filter(Boolean).join('')
    : (loginUrl ? `<a class="btn btn-primary" href="${loginUrl}">Go to your account</a>` : '');

  const reassurance = ok
    ? `<p class="note">Changed your mind? You can re-subscribe anytime from your notification preferences.</p>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>
  :root { --accent:${accent}; --accent-dark:#125e82; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #f3f4f6; padding: 24px;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #111827; -webkit-font-smoothing: antialiased;
  }
  .card {
    background: #fff; border: 1px solid #e5e7eb; border-radius: 16px;
    box-shadow: 0 10px 30px rgba(17,24,39,.08); padding: 40px 32px; max-width: 460px; width: 100%;
    text-align: center;
  }
  .badge {
    width: 64px; height: 64px; border-radius: 9999px; background: ${accentSoft};
    display: inline-flex; align-items: center; justify-content: center; margin-bottom: 20px;
  }
  h1 { font-size: 22px; line-height: 1.3; margin: 0 0 10px; font-weight: 650; }
  p { font-size: 15px; line-height: 1.6; color: #4b5563; margin: 0 0 8px; }
  .note { font-size: 13px; color: #9ca3af; margin-top: 18px; }
  .actions { margin-top: 24px; display: flex; flex-direction: column; gap: 10px; }
  .btn {
    display: inline-block; padding: 11px 18px; border-radius: 10px; font-size: 14px; font-weight: 600;
    text-decoration: none; transition: background-color .15s ease, border-color .15s ease;
  }
  .btn-primary { background: var(--accent); color: #fff; }
  .btn-primary:hover { background: var(--accent-dark); }
  .btn-secondary { background: #fff; color: #374151; border: 1px solid #d1d5db; }
  .btn-secondary:hover { background: #f9fafb; }
  .footer { margin-top: 28px; font-size: 12px; color: #9ca3af; }
</style>
</head>
<body>
  <main class="card" role="main">
    <div class="badge" aria-hidden="true">${icon}</div>
    <h1>${heading}</h1>
    <p>${bodyText}</p>
    ${reassurance}
    ${actions ? `<div class="actions">${actions}</div>` : ''}
    <div class="footer">Open-Enroll · AllAboard365</div>
  </main>
</body>
</html>`;
}

function sendResult(req, res, ok, message) {
  if (wantsJson(req)) {
    return res
      .status(ok ? 200 : 400)
      .json({ success: ok, message: ok ? 'You have been unsubscribed from marketing emails.' : (message || 'Invalid or expired link.') });
  }
  return res
    .status(ok ? 200 : 400)
    .type('html')
    .send(renderUnsubscribePage({ ok, message }));
}

async function processUnsubscribe(token, req, res) {
  const payload = verifyMarketingUnsubscribeToken(token);
  if (!payload) {
    return sendResult(req, res, false, 'This unsubscribe link is invalid or has expired.');
  }
  await optOutEmailMarketingFromUnsubscribe(payload.memberId, payload.tenantId, 'UnsubscribeLink');
  return sendResult(req, res, true);
}

router.get('/', async (req, res) => {
  try {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    if (!token) {
      return sendResult(req, res, false, 'Missing unsubscribe token.');
    }
    await processUnsubscribe(token, req, res);
  } catch (e) {
    console.error('[marketing-unsubscribe] GET error:', e);
    return sendResult(req, res, false, 'We couldn’t process your request. Please try again later.');
  }
});

// RFC 8058 one-click: email clients POST in the background and only care about the status code.
router.post('/', express.urlencoded({ extended: false, limit: '8kb' }), async (req, res) => {
  try {
    const token =
      (typeof req.query.token === 'string' && req.query.token) ||
      (typeof req.body?.token === 'string' && req.body.token) ||
      '';
    if (!token) {
      return res.status(400).send('Bad Request');
    }
    const payload = verifyMarketingUnsubscribeToken(token);
    if (!payload) {
      return res.status(400).send('Invalid or expired link.');
    }
    await optOutEmailMarketingFromUnsubscribe(payload.memberId, payload.tenantId, 'UnsubscribeLink');
    return res.status(200).send('OK');
  } catch (e) {
    console.error('[marketing-unsubscribe] POST error:', e);
    return res.status(500).send('Error');
  }
});

module.exports = router;
// Exposed for tests/preview tooling (pure render helper — no side effects).
module.exports.renderUnsubscribePage = renderUnsubscribePage;
