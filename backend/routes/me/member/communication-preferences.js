const express = require('express');
const router = express.Router();
const { authorize } = require('../../../middleware/auth');
const { getPool, sql } = require('../../../config/database');
const {
  getPreferencesForMember,
  updatePreferencesFromMemberPortal
} = require('../../../services/memberCommunicationPreferences.service');

router.use(authorize(['Member']));

async function resolveMemberContext(req) {
  const pool = await getPool();
  const r = await pool.request()
    .input('userId', sql.UniqueIdentifier, req.user.UserId)
    .query(`
      SELECT m.MemberId, m.TenantId, m.SmsConsent
      FROM oe.Members m
      WHERE m.UserId = @userId
    `);
  if (!r.recordset.length) return null;
  const row = r.recordset[0];
  return {
    memberId: row.MemberId,
    tenantId: row.TenantId,
    smsConsent: row.SmsConsent === true || row.SmsConsent === 1
  };
}

/**
 * GET /api/me/member/communication-preferences
 */
router.get('/', async (req, res) => {
  try {
    const ctx = await resolveMemberContext(req);
    if (!ctx) {
      return res.status(404).json({ success: false, message: 'Member not found' });
    }
    const prefs = await getPreferencesForMember(ctx.memberId);
    return res.json({
      success: true,
      data: {
        emailMarketingEnabled: !prefs.emailMarketingOptOut,
        smsMarketingEnabled: !prefs.smsMarketingOptOut,
        smsConsentGranted: ctx.smsConsent
      }
    });
  } catch (e) {
    console.error('[communication-preferences] GET:', e);
    return res.status(500).json({ success: false, message: 'Failed to load preferences' });
  }
});

/**
 * PUT /api/me/member/communication-preferences
 * Body: { emailMarketingEnabled?: boolean, smsMarketingEnabled?: boolean }
 */
router.put('/', async (req, res) => {
  try {
    const ctx = await resolveMemberContext(req);
    if (!ctx) {
      return res.status(404).json({ success: false, message: 'Member not found' });
    }

    const { emailMarketingEnabled, smsMarketingEnabled } = req.body || {};
    if (typeof emailMarketingEnabled !== 'boolean' && typeof smsMarketingEnabled !== 'boolean') {
      return res.status(400).json({
        success: false,
        message: 'Provide at least one of emailMarketingEnabled, smsMarketingEnabled (boolean)'
      });
    }

    const current = await getPreferencesForMember(ctx.memberId);
    const nextEmail = typeof emailMarketingEnabled === 'boolean' ? emailMarketingEnabled : !current.emailMarketingOptOut;
    const nextSms = typeof smsMarketingEnabled === 'boolean' ? smsMarketingEnabled : !current.smsMarketingOptOut;

    if (nextSms && !ctx.smsConsent) {
      return res.status(400).json({
        success: false,
        message: 'SMS marketing requires SMS consent on your account. Contact support to update consent.'
      });
    }

    const ip = req.ip || req.connection?.remoteAddress || null;
    const ua = req.get('user-agent') || null;

    const updated = await updatePreferencesFromMemberPortal(
      ctx.memberId,
      ctx.tenantId,
      { emailMarketingEnabled: nextEmail, smsMarketingEnabled: nextSms },
      { source: 'PreferenceCenter', ipAddress: ip, userAgent: ua }
    );

    return res.json({
      success: true,
      data: {
        emailMarketingEnabled: !updated.emailMarketingOptOut,
        smsMarketingEnabled: !updated.smsMarketingOptOut,
        smsConsentGranted: ctx.smsConsent
      }
    });
  } catch (e) {
    console.error('[communication-preferences] PUT:', e);
    return res.status(500).json({ success: false, message: 'Failed to save preferences' });
  }
});

module.exports = router;
