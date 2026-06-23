/**
 * Same contract as backend/services/marketingUnsubscribeToken.service.js (Azure Function has no backend bundle).
 */
const jwt = require('jsonwebtoken');

const AUDIENCE = 'marketing-unsubscribe';
const ISSUER = 'open-enroll';
const DEFAULT_EXPIRY = '90d';

function getSecret() {
  const s = process.env.JWT_SECRET;
  if (!s) {
    console.warn('[marketing-unsubscribe] JWT_SECRET not set — unsubscribe links disabled');
    return null;
  }
  return s;
}

function signMarketingUnsubscribeToken(memberId, tenantId) {
  if (!memberId || !tenantId) return null;
  const secret = getSecret();
  if (!secret) return null;
  return jwt.sign(
    { typ: 'mkt-unsub', memberId, tenantId },
    secret,
    { expiresIn: DEFAULT_EXPIRY, audience: AUDIENCE, issuer: ISSUER }
  );
}

function verifyMarketingUnsubscribeToken(token) {
  if (!token || typeof token !== 'string') return null;
  const secret = getSecret();
  if (!secret) return null;
  try {
    const payload = jwt.verify(token.trim(), secret, {
      audience: AUDIENCE,
      issuer: ISSUER
    });
    if (payload.typ !== 'mkt-unsub' || !payload.memberId || !payload.tenantId) return null;
    return { memberId: payload.memberId, tenantId: payload.tenantId };
  } catch {
    return null;
  }
}

module.exports = {
  signMarketingUnsubscribeToken,
  verifyMarketingUnsubscribeToken
};
