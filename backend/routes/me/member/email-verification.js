const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../../../config/database');
const emailVerificationService = require('../../../services/email-verification.service');
const { queueVerificationEmail } = require('../../../services/email-verification-mailer');
const {
  getEffectiveUserId,
  getActorUserId,
  isSpouseDelegate,
} = require('../../../middleware/attachMemberHouseholdContext');

const SYNTHETIC_EMAIL_DOMAIN = '@noemail.com';

/**
 * Resolve the authenticated user's primary-member context. Returns null if
 * the user isn't a primary on any member record (we never let dependents or
 * spouses verify here — only primaries).
 */
async function getPrimaryContext(userId) {
  const pool = await getPool();
  const result = await pool.request()
    .input('userId', sql.UniqueIdentifier, userId)
    .query(`
      SELECT TOP 1
        u.UserId,
        u.Email,
        u.EmailVerified,
        u.TenantId,
        m.RelationshipType,
        m.MemberSequence,
        t.Name AS TenantName
      FROM oe.Users u
      INNER JOIN oe.Members m ON m.UserId = u.UserId
      LEFT JOIN oe.Tenants t ON t.TenantId = u.TenantId
      WHERE u.UserId = @userId
        AND m.RelationshipType = 'P'
      ORDER BY m.MemberSequence ASC, m.CreatedDate ASC
    `);

  if (result.recordset.length === 0) return null;
  return result.recordset[0];
}

function isSyntheticEmail(email) {
  return !email || String(email).toLowerCase().endsWith(SYNTHETIC_EMAIL_DOMAIN);
}

/**
 * POST /api/me/member/email-verification/send
 * Sends a verification code to the email already on file. The email cannot be
 * changed from the member-facing UI — wrong addresses must go through the
 * agent.
 */
router.post('/send', async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);
    const actorUserId = getActorUserId(req);

    const ctx = await getPrimaryContext(userId);
    if (!ctx) {
      return res.status(403).json({
        success: false,
        message: 'Email verification is not available for this account.'
      });
    }

    const email = ctx.Email;

    if (isSyntheticEmail(email)) {
      return res.status(400).json({
        success: false,
        message: 'No email is on file for this account. Please contact your agent to add one.'
      });
    }

    let codeData;
    try {
      codeData = await emailVerificationService.createPostEnrollmentCode({
        userId,
        email,
        tenantId: ctx.TenantId
      });
    } catch (err) {
      if (err.code === 'RATE_LIMITED') {
        return res.status(429).json({ success: false, message: err.message });
      }
      throw err;
    }

    await queueVerificationEmail({
      tenantId: ctx.TenantId,
      tenantName: ctx.TenantName,
      toEmail: email,
      verificationCode: codeData.code,
      createdBy: actorUserId,
      recipientId: userId
    });

    return res.json({
      success: true,
      message: 'Verification code sent.',
      data: {
        email,
        expiresIn: codeData.expiresIn,
        isSpouseDelegate: isSpouseDelegate(req),
      }
    });
  } catch (error) {
    console.error('❌ /api/me/member/email-verification/send error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to send verification code.'
    });
  }
});

/**
 * POST /api/me/member/email-verification/verify
 * Body: { code: string }
 */
router.post('/verify', async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);
    const { code } = req.body || {};

    if (!code || !/^[A-Z0-9]{6}$/i.test(String(code).trim())) {
      return res.status(400).json({
        success: false,
        message: 'Invalid verification code format. Code must be 6 characters.'
      });
    }

    const ctx = await getPrimaryContext(userId);
    if (!ctx) {
      return res.status(403).json({
        success: false,
        message: 'Email verification is not available for this account.'
      });
    }

    const result = await emailVerificationService.verifyPostEnrollmentCode({
      userId,
      email: ctx.Email,
      code: String(code).trim().toUpperCase()
    });

    if (!result.success) {
      return res.status(400).json({ success: false, message: result.error });
    }

    return res.json({
      success: true,
      message: 'Email verified successfully.',
      data: { email: ctx.Email, verified: true }
    });
  } catch (error) {
    console.error('❌ /api/me/member/email-verification/verify error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to verify code.'
    });
  }
});

/**
 * GET /api/me/member/email-verification/status
 * Lightweight check for the portal banner.
 */
router.get('/status', async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);
    const ctx = await getPrimaryContext(userId);
    const delegate = isSpouseDelegate(req);

    if (!ctx) {
      return res.json({
        success: true,
        data: {
          isPrimary: false,
          isSpouseDelegate: delegate,
          emailVerified: true,  // suppress banner for non-primaries
          email: null,
          syntheticEmail: false
        }
      });
    }

    return res.json({
      success: true,
      data: {
        isPrimary: true,
        isSpouseDelegate: delegate,
        emailVerified: Boolean(ctx.EmailVerified),
        email: ctx.Email,
        syntheticEmail: isSyntheticEmail(ctx.Email)
      }
    });
  } catch (error) {
    console.error('❌ /api/me/member/email-verification/status error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch verification status.' });
  }
});

module.exports = router;
