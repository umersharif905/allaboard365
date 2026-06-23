const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { getPool, sql } = require('../config/database');
const { authorize: authMiddleware, getUserRoles } = require('../middleware/auth');
const { authenticateUrls, authenticateProductDocumentsArray } = require('./uploads');
const { getProductDocumentsForProductIds } = require('../services/shared/product-documents.service');
const { EnrollmentLinkService } = require('../services/shared');
const { PricingEngine } = require('../services/pricing');
const DimeService = require('../services/dimeService');
const PaymentAttemptService = require('../services/paymentAttempt.service');
const EnrollmentWriter = require('../services/enrollments/enrollmentWriter.service');
const UserRolesService = require('../services/shared/user-roles.service');
const bcrypt = require('bcryptjs');
const emailVerificationService = require('../services/email-verification.service');
const MessageQueueService = require('../services/messageQueue.service');
const fs = require('fs');
const path = require('path');
const encryptionService = require('../services/encryptionService');
const includedProcessingFeeUtil = require('../utils/includedProcessingFee');
const productProcessingFeesUtil = require('../utils/productProcessingFees');
const pricingAuthority = require('../services/pricing/pricingAuthority.service');
const { getMemberAgeForPricing } = require('../utils/memberAgeFromDob');
const { validateDateOfBirthInput } = require('../utils/validateDateOfBirth');
const { hasSignedAcknowledgementsPayload } = require('../utils/enrollmentAcknowledgements');
const { requireShared } = require('../config/shared-modules');
const oePaymentStatus = requireShared('payment-status');
const { ENROLLMENT_STATUS } = require('../constants/enrollmentStatus');
const enrollmentPaymentHoldService = require('../services/enrollmentPaymentHoldService');
const { recordEnrollmentLifecycleError } = require('../services/enrollmentLifecycleErrors.service');
const { setupStoredPaymentMethodAndRecurringForIndividualEnrollment } = require('../services/individualEnrollmentRecurringSetup');
const { rawSql } = require('../config/database');
const { applyHouseholdVendorNetworkSelections } = require('../services/householdVendorNetworks.service');
const posthog = require('../config/posthog');
const { recordIntegrationError } = require('../services/integrationErrorService');
const invoiceService = require('../services/invoiceService');
const { isGroupLockedForNewEnrollment } = require('../services/enrollmentLockService');
const {
  buildEnrollmentWizardErrorDetail,
  replayEnrollmentPricingOnServer,
  analyzeZeroFrontendMismatch
} = require('../utils/enrollmentSubmitForensics');

/**
 * Persist enrollment wizard pricing / payment-prep failures (oe.SystemIntegrationErrors).
 */
async function recordEnrollmentWizardError({
  tenantId,
  linkToken,
  code,
  summary,
  detail,
  severity = 'error',
  priority
}) {
  try {
    const sev = String(severity || 'error').slice(0, 32);
    await recordIntegrationError({
      category: 'enrollment-wizard',
      source: 'enrollment-links.complete-enrollment',
      severity: sev,
      priority: typeof priority !== 'undefined' ? priority : undefined,
      tenantId: tenantId || null,
      message: String(`${code || 'UNKNOWN'}: ${summary || ''}`).slice(0, 2000),
      detail: {
        linkToken: linkToken || null,
        code: code || null,
        severity: sev,
        ...(detail && typeof detail === 'object' ? detail : {})
      }
    });
  } catch (e) {
    console.warn('recordEnrollmentWizardError:', e?.message || e);
  }
}

/** Sanitized context for pricing display vs backend forensics (no PII). */
function buildEnrollmentPricingMonitorDetail({
  memberCriteria,
  selectedConfigs,
  paymentMethodType,
  selectedProducts,
  productId,
  productName,
  backendBreakdownRow,
  frontendBreakdownRow
}) {
  const selectionSignatureSeed = JSON.stringify({
    mc: memberCriteria
      ? {
          tier: memberCriteria.tier,
          age: memberCriteria.age,
          tobaccoUse: memberCriteria.tobaccoUse
        }
      : null,
    sc: selectedConfigs || {},
    pm: paymentMethodType || null,
    sp: (selectedProducts || []).map(String).slice().sort(),
    pid: productId ? String(productId) : null
  });
  const selectionSignatureHash = crypto
    .createHash('sha256')
    .update(selectionSignatureSeed)
    .digest('hex')
    .slice(0, 16);
  return {
    memberCriteria: memberCriteria
      ? {
          tier: memberCriteria.tier,
          age: memberCriteria.age,
          tobaccoUse: memberCriteria.tobaccoUse
        }
      : null,
    selectedConfigs: selectedConfigs && typeof selectedConfigs === 'object' ? { ...selectedConfigs } : {},
    paymentMethodType: paymentMethodType || null,
    selectedProducts: (selectedProducts || []).map(String),
    productId: productId || null,
    productName: productName || null,
    backendBreakdownPerProduct: backendBreakdownRow,
    frontendBreakdownPerProduct: frontendBreakdownRow,
    selectionSignatureHash
  };
}

/**
 * Full forensic bundle for pricing/payment mismatches (client submitForensics + server replay).
 */
async function recordEnrollmentPricingForensicsError(
  req,
  {
    tenantId,
    linkToken,
    code,
    summary,
    severity = 'error',
    enrollmentLink,
    memberTier,
    pricingContext,
    selectedProducts,
    selectedConfigs,
    effectiveDate,
    amountValidation,
    monitorDetail,
    stack
  }
) {
  const reportId = crypto.randomUUID();
  let serverReplay = req._enrollmentForensicsServerReplay;
  if (!serverReplay) {
    const mc =
      pricingContext && typeof pricingContext === 'object'
        ? pricingContext.memberCriteria
        : null;
    try {
      serverReplay = await replayEnrollmentPricingOnServer({
        enrollmentLink,
        memberCriteria: mc,
        memberTier,
        selectedProducts,
        selectedConfigs,
        effectiveDate
      });
      req._enrollmentForensicsServerReplay = serverReplay;
    } catch (replayErr) {
      serverReplay = { replayError: replayErr?.message || String(replayErr) };
    }
  }

  const hints = analyzeZeroFrontendMismatch({
    clientForensics: req.body?.submitForensics,
    serverReplay,
    amountValidation
  });

  console.error(
    `📋 Enrollment pricing forensics [${code}] reportId=${reportId} hints=${JSON.stringify(hints)}`
  );

  await recordEnrollmentWizardError({
    tenantId,
    linkToken,
    code,
    summary,
    severity,
    detail: buildEnrollmentWizardErrorDetail({
      linkToken,
      code,
      reportId,
      clientForensics: req.body?.submitForensics || null,
      serverForensics: {
        pricingReplay: serverReplay,
        amountValidation: amountValidation || null,
        paymentProcessorFlags: req._enrollmentPaymentProcessorFlags || null
      },
      extra: {
        ...(monitorDetail && typeof monitorDetail === 'object' ? monitorDetail : {}),
        stack: stack || null,
        reproductionHints: hints,
        requestMeta: {
          frontendCalculatedAmount: req.body?.frontendCalculatedAmount,
          frontendPricing:
            Array.isArray(req.body?.frontendPricing) ? req.body.frontendPricing : null,
          hasPricingFingerprint: !!req.body?.pricingFingerprint,
          hasPricingContext: !!req.body?.pricingContext,
          userAgent: req.body?.userAgent || req.headers['user-agent'] || null,
          ipAddress: req.body?.ipAddress || req.ip || null
        }
      }
    })
  });

  return reportId;
}

function isDimeServerError(errLike) {
  if (!errLike) return false;
  const status = Number(
    errLike?.error?.statusCode ??
    errLike?.error?.status ??
    errLike?.statusCode ??
    errLike?.status
  );
  const msg = String(errLike?.error?.message || errLike?.message || '').toLowerCase();
  return (
    (Number.isFinite(status) && status >= 500 && status < 600) ||
    msg.includes('server error') ||
    msg.includes('bad gateway') ||
    msg.includes('gateway timeout') ||
    msg.includes('service unavailable')
  );
}

// IMPORTANT: Specific routes must come BEFORE generic parameterized routes

// ==================== SSN HELPER FUNCTIONS ====================

/**
 * Format SSN to standard format: 123-45-6789
 * @param {string} ssn - SSN in any format (with or without dashes)
 * @returns {string|null} Formatted SSN or null if invalid
 */
function formatSSN(ssn) {
  if (!ssn || typeof ssn !== 'string') {
    return null;
  }
  
  // Remove all non-digit characters
  const digitsOnly = ssn.replace(/\D/g, '');
  
  // Must be exactly 9 digits
  if (digitsOnly.length !== 9) {
    return null;
  }
  
  // Format as XXX-XX-XXXX
  return `${digitsOnly.slice(0, 3)}-${digitsOnly.slice(3, 5)}-${digitsOnly.slice(5, 9)}`;
}

/**
 * Format and encrypt SSN for storage
 * @param {string} ssn - SSN in any format
 * @returns {string|null} Encrypted SSN or null if invalid
 */
function formatAndEncryptSSN(ssn) {
  if (!ssn) {
    return null;
  }
  
  const formatted = formatSSN(ssn);
  if (!formatted) {
    console.warn('⚠️ Invalid SSN format, skipping encryption:', ssn);
    return null;
  }
  
  try {
    return encryptionService.encrypt(formatted);
  } catch (error) {
    console.error('❌ Error encrypting SSN:', error);
    return null;
  }
}

/**
 * Decrypt SSN from database
 * @param {string} encryptedSSN - Encrypted SSN from database
 * @returns {string|null} Decrypted SSN in format 123-45-6789 or null
 */
function decryptSSN(encryptedSSN) {
  if (!encryptedSSN) {
    return null;
  }
  
  try {
    // Check if it's already decrypted (legacy data or test data)
    if (encryptedSSN.match(/^\d{3}-\d{2}-\d{4}$/)) {
      return encryptedSSN; // Already formatted, return as-is
    }
    
    // Try to decrypt
    return encryptionService.decrypt(encryptedSSN);
  } catch (error) {
    console.warn('⚠️ Error decrypting SSN (may be legacy unencrypted data):', error.message);
    // Return as-is if decryption fails (might be legacy unencrypted data)
    return encryptedSSN;
  }
}

function normalizeStateCode(state) {
  if (!state || typeof state !== 'string') return '';
  const normalized = state.trim().toUpperCase();
  return normalized.length === 2 ? normalized : '';
}

function parseAllowedStates(rawAllowedStates) {
  if (!rawAllowedStates) return [];
  let parsed = rawAllowedStates;
  if (typeof rawAllowedStates === 'string') {
    try {
      parsed = JSON.parse(rawAllowedStates);
    } catch (error) {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((state) => normalizeStateCode(state))
    .filter(Boolean);
}

function isProductAvailableForState(allowedStates, memberState) {
  const normalizedMemberState = normalizeStateCode(memberState);
  if (!normalizedMemberState) return false;
  if (!Array.isArray(allowedStates) || allowedStates.length === 0) return true; // empty/null = available in all states
  return allowedStates.includes(normalizedMemberState);
}

async function resolveEnrollmentMemberState({ pool, linkMemberId, requestMemberId, memberInfo }) {
  const submittedState = normalizeStateCode(memberInfo?.state);
  if (submittedState) return submittedState;

  const memberIdToLookup = requestMemberId || linkMemberId;
  if (!memberIdToLookup) return '';

  try {
    const request = pool.request();
    request.input('memberId', sql.UniqueIdentifier, memberIdToLookup);
    const result = await request.query(`
      SELECT TOP 1 State
      FROM oe.Members
      WHERE MemberId = @memberId
    `);
    return normalizeStateCode(result.recordset?.[0]?.State || '');
  } catch (error) {
    console.warn('⚠️ Failed to resolve member state for enrollment eligibility:', error?.message || error);
    return '';
  }
}

async function validateSelectedProductsStateEligibility({ pool, selectedProducts, memberState }) {
  const uniqueSelectedProductIds = [...new Set((selectedProducts || []).filter(Boolean))];
  if (uniqueSelectedProductIds.length === 0) {
    return { isValid: true, disallowedProducts: [], normalizedMemberState: normalizeStateCode(memberState) };
  }

  const normalizedMemberState = normalizeStateCode(memberState);
  const placeholders = uniqueSelectedProductIds.map((_, idx) => `@sp${idx}`).join(',');
  const request = pool.request();
  uniqueSelectedProductIds.forEach((id, idx) => request.input(`sp${idx}`, sql.UniqueIdentifier, id));

  const result = await request.query(`
    ;WITH DirectSelectedProducts AS (
      SELECT DISTINCT
        p.ProductId,
        p.Name AS ProductName,
        p.AllowedStates,
        CAST(0 AS BIT) AS IsBundleComponent
      FROM oe.Products p
      WHERE p.ProductId IN (${placeholders})
    ),
    IncludedBundleProducts AS (
      SELECT DISTINCT
        p.ProductId,
        p.Name AS ProductName,
        p.AllowedStates,
        CAST(1 AS BIT) AS IsBundleComponent
      FROM oe.ProductBundles pb
      INNER JOIN oe.Products p ON pb.IncludedProductId = p.ProductId
      WHERE pb.BundleProductId IN (${placeholders})
    )
    SELECT ProductId, ProductName, AllowedStates, IsBundleComponent
    FROM DirectSelectedProducts
    UNION
    SELECT ProductId, ProductName, AllowedStates, IsBundleComponent
    FROM IncludedBundleProducts
  `);

  const disallowedProducts = (result.recordset || [])
    .map((row) => {
      const allowedStates = parseAllowedStates(row.AllowedStates);
      const isAvailableForState = isProductAvailableForState(allowedStates, normalizedMemberState);
      return {
        productId: row.ProductId,
        productName: row.ProductName,
        isBundleComponent: row.IsBundleComponent === true || row.IsBundleComponent === 1,
        allowedStates,
        isAvailableForState
      };
    })
    .filter((row) => !row.isAvailableForState);

  return {
    isValid: disallowedProducts.length === 0,
    disallowedProducts,
    normalizedMemberState
  };
}

// ==================== POST-ENROLLMENT EMAIL VERIFICATION (wizard, no member auth yet) ====================
//
// After complete-enrollment succeeds the wizard shows a skippable "verify your
// email" step before the final success screen. The member doesn't have a
// session yet, so we authorize via (linkToken, memberId): the linkToken is in
// their URL, the memberId came from the just-issued complete-enrollment
// response, and we additionally require that the member's User row was
// created within the last 24 hours and lives in the link's tenant.
//
// On success we flip oe.Users.EmailVerified = 1 directly via
// emailVerificationService.verifyPostEnrollmentCode.

const POST_ENROLLMENT_VERIFY_WINDOW_HOURS = 24;

async function _resolvePostEnrollmentContext(linkToken, memberId) {
  const pool = await getPool();

  const linkResult = await pool.request()
    .input('linkToken', sql.NVarChar, linkToken)
    .query(`
      SELECT TOP 1
        el.LinkId,
        el.IsActive,
        CASE
          WHEN el.GroupId IS NOT NULL THEN g.TenantId
          WHEN el.MemberId IS NOT NULL THEN lm.TenantId
          WHEN el.AgentId IS NOT NULL THEN a.TenantId
          WHEN el.EnrollmentLinkTemplateId IS NOT NULL THEN elt.TenantId
          ELSE NULL
        END AS TenantId,
        CASE
          WHEN el.GroupId IS NOT NULL THEN t_group.Name
          WHEN el.MemberId IS NOT NULL THEN t_member.Name
          WHEN el.AgentId IS NOT NULL THEN t_agent.Name
          WHEN el.EnrollmentLinkTemplateId IS NOT NULL THEN t_tpl.Name
          ELSE 'AllAboard365'
        END AS TenantName
      FROM oe.EnrollmentLinks el
      LEFT JOIN oe.Groups g ON el.GroupId = g.GroupId
      LEFT JOIN oe.Members lm ON el.MemberId = lm.MemberId
      LEFT JOIN oe.Agents a ON el.AgentId = a.AgentId
      LEFT JOIN oe.EnrollmentLinkTemplates elt ON el.EnrollmentLinkTemplateId = elt.TemplateId
      LEFT JOIN oe.Tenants t_group ON g.TenantId = t_group.TenantId
      LEFT JOIN oe.Tenants t_member ON lm.TenantId = t_member.TenantId
      LEFT JOIN oe.Tenants t_agent ON a.TenantId = t_agent.TenantId
      LEFT JOIN oe.Tenants t_tpl ON elt.TenantId = t_tpl.TenantId
      WHERE el.LinkToken = @linkToken
    `);

  if (linkResult.recordset.length === 0) return { ok: false, status: 404, message: 'Enrollment link not found' };
  const link = linkResult.recordset[0];
  if (!link.IsActive) return { ok: false, status: 400, message: 'Enrollment link is not active' };

  const memberResult = await pool.request()
    .input('memberId', sql.UniqueIdentifier, memberId)
    .query(`
      SELECT TOP 1
        m.MemberId, m.UserId, m.RelationshipType, m.TenantId,
        u.Email, u.CreatedDate AS UserCreatedDate, u.EmailVerified
      FROM oe.Members m
      INNER JOIN oe.Users u ON u.UserId = m.UserId
      WHERE m.MemberId = @memberId
    `);
  if (memberResult.recordset.length === 0) return { ok: false, status: 404, message: 'Member not found' };
  const member = memberResult.recordset[0];

  if (member.RelationshipType !== 'P') {
    return { ok: false, status: 400, message: 'Email verification is only available for the primary member.' };
  }

  if (link.TenantId && member.TenantId && String(link.TenantId).toLowerCase() !== String(member.TenantId).toLowerCase()) {
    return { ok: false, status: 403, message: 'Member does not belong to this enrollment link.' };
  }

  const userCreated = new Date(member.UserCreatedDate);
  const ageHours = (Date.now() - userCreated.getTime()) / (1000 * 60 * 60);
  if (ageHours > POST_ENROLLMENT_VERIFY_WINDOW_HOURS) {
    return {
      ok: false,
      status: 410,
      message: 'This verification window has expired. Please log in to verify your email from your member portal.'
    };
  }

  return {
    ok: true,
    tenantId: member.TenantId || link.TenantId,
    tenantName: link.TenantName,
    member
  };
}

/**
 * POST /api/enrollment-links/:linkToken/post-enrollment-verify/send
 * Body: { memberId }
 *
 * Sends a verification code to the email captured during enrollment. The email
 * cannot be changed from the member-facing wizard — wrong addresses must go
 * through the agent.
 */
router.post('/:linkToken/post-enrollment-verify/send', async (req, res) => {
  try {
    const { linkToken } = req.params;
    const { memberId } = req.body || {};

    if (!memberId) {
      return res.status(400).json({ success: false, message: 'memberId is required' });
    }

    const ctx = await _resolvePostEnrollmentContext(linkToken, memberId);
    if (!ctx.ok) return res.status(ctx.status).json({ success: false, message: ctx.message });

    const { member, tenantId, tenantName } = ctx;
    const email = member.Email;

    if (!email || String(email).toLowerCase().endsWith('@noemail.com')) {
      return res.status(400).json({
        success: false,
        message: 'No email is on file for this enrollment. Please contact your agent.'
      });
    }

    let codeData;
    try {
      codeData = await emailVerificationService.createPostEnrollmentCode({
        userId: member.UserId,
        email,
        tenantId
      });
    } catch (err) {
      if (err.code === 'RATE_LIMITED') {
        return res.status(429).json({ success: false, message: err.message });
      }
      throw err;
    }

    const { queueVerificationEmail } = require('../services/email-verification-mailer');
    await queueVerificationEmail({
      tenantId,
      tenantName,
      toEmail: email,
      verificationCode: codeData.code,
      createdBy: member.UserId,
      recipientId: member.UserId
    });

    posthog.capture({
      distinctId: linkToken,
      event: 'post-enrollment email verification sent',
      properties: {
        tenant_id: tenantId ? String(tenantId) : undefined,
        $process_person_profile: false,
      },
    });

    return res.json({
      success: true,
      message: 'Verification code sent.',
      data: { email, expiresIn: codeData.expiresIn }
    });
  } catch (error) {
    console.error('❌ post-enrollment-verify/send error:', error);
    return res.status(500).json({ success: false, message: 'Failed to send verification code.' });
  }
});

/**
 * POST /api/enrollment-links/:linkToken/post-enrollment-verify/verify
 * Body: { memberId, code }
 */
router.post('/:linkToken/post-enrollment-verify/verify', async (req, res) => {
  try {
    const { linkToken } = req.params;
    const { memberId, code } = req.body || {};

    if (!memberId) return res.status(400).json({ success: false, message: 'memberId is required' });
    if (!code || !/^[A-Z0-9]{6}$/i.test(String(code).trim())) {
      return res.status(400).json({
        success: false,
        message: 'Invalid verification code format. Code must be 6 characters.'
      });
    }

    const ctx = await _resolvePostEnrollmentContext(linkToken, memberId);
    if (!ctx.ok) return res.status(ctx.status).json({ success: false, message: ctx.message });

    const result = await emailVerificationService.verifyPostEnrollmentCode({
      userId: ctx.member.UserId,
      email: ctx.member.Email,
      code: String(code).trim().toUpperCase()
    });

    if (!result.success) {
      return res.status(400).json({ success: false, message: result.error });
    }

    posthog.capture({
      distinctId: linkToken,
      event: 'post-enrollment email verified',
      properties: { $process_person_profile: false },
    });

    return res.json({
      success: true,
      message: 'Email verified successfully.',
      data: { email: ctx.member.Email, verified: true }
    });
  } catch (error) {
    console.error('❌ post-enrollment-verify/verify error:', error);
    return res.status(500).json({ success: false, message: 'Failed to verify code.' });
  }
});

// ==================== END POST-ENROLLMENT EMAIL VERIFICATION ====================


// POST /api/enrollment-links/:linkToken/send-acknowledgements - Send acknowledgements via email/SMS for external signing
router.post('/:linkToken/send-acknowledgements', async (req, res) => {
  try {
    const { linkToken } = req.params;
    const { deliveryMethod, email, phone, selectedProducts, memberInfo } = req.body;
    
    if (!linkToken) {
      return res.status(400).json({
        success: false,
        message: 'Link token is required'
      });
    }
    
    if (!deliveryMethod || (deliveryMethod !== 'Email' && deliveryMethod !== 'SMS')) {
      return res.status(400).json({
        success: false,
        message: 'Valid delivery method (Email or SMS) is required'
      });
    }
    
    if (deliveryMethod === 'Email' && !email) {
      return res.status(400).json({
        success: false,
        message: 'Email address is required for email delivery'
      });
    }
    
    if (deliveryMethod === 'SMS' && !phone) {
      return res.status(400).json({
        success: false,
        message: 'Phone number is required for SMS delivery'
      });
    }
    
    const pool = await getPool();
    
    // Generate unique acknowledgement token
    const acknowledgementToken = `ack_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const acknowledgementTokenId = require('crypto').randomUUID();
    
    // Set expiration (24 hours from now)
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 24);
    
    // Create acknowledgement token record
    const createTokenRequest = pool.request();
    createTokenRequest.input('acknowledgementTokenId', sql.UniqueIdentifier, acknowledgementTokenId);
    createTokenRequest.input('linkToken', sql.NVarChar, linkToken);
    createTokenRequest.input('token', sql.NVarChar, acknowledgementToken);
    createTokenRequest.input('email', sql.NVarChar, email || null);
    createTokenRequest.input('phone', sql.NVarChar, phone || null);
    createTokenRequest.input('deliveryMethod', sql.NVarChar, deliveryMethod);
    createTokenRequest.input('status', sql.NVarChar, 'Pending');
    createTokenRequest.input('selectedProducts', sql.NVarChar, JSON.stringify(selectedProducts || []));
    createTokenRequest.input('firstName', sql.NVarChar, memberInfo?.firstName || null);
    createTokenRequest.input('lastName', sql.NVarChar, memberInfo?.lastName || null);
    createTokenRequest.input('dateOfBirth', sql.Date, memberInfo?.dateOfBirth ? new Date(memberInfo.dateOfBirth) : null);
    createTokenRequest.input('expiresAt', sql.DateTime2, expiresAt);
    createTokenRequest.input('createdDate', sql.DateTime2, new Date());
    
    await createTokenRequest.query(`
      INSERT INTO oe.AcknowledgementTokens (
        AcknowledgementTokenId, LinkToken, Token, Email, Phone,
        DeliveryMethod, Status, SelectedProducts, FirstName, LastName, DateOfBirth, ExpiresAt, CreatedDate
      ) VALUES (
        @acknowledgementTokenId, @linkToken, @token, @email, @phone,
        @deliveryMethod, @status, @selectedProducts, @firstName, @lastName, @dateOfBirth, @expiresAt, @createdDate
      )
    `);
    
    // Generate signing URL
    const baseUrl = req.get('origin') || `${req.protocol}://${req.get('host')}`;
    const signingUrl = `${baseUrl}/sign-acknowledgements/${acknowledgementToken}`;
    
    // Get tenant info for email branding
    const linkQuery = `
      SELECT el.LinkToken, el.EnrollmentLinkTemplateId, elt.TenantId
      FROM oe.EnrollmentLinks el
      INNER JOIN oe.EnrollmentLinkTemplates elt ON el.EnrollmentLinkTemplateId = elt.TemplateId
      WHERE el.LinkToken = @linkToken
    `;
    const linkRequest = pool.request();
    linkRequest.input('linkToken', sql.NVarChar, linkToken);
    const linkResult = await linkRequest.query(linkQuery);
    
    if (linkResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Enrollment link not found'
      });
    }
    
    const tenantId = linkResult.recordset[0].TenantId;
    
    if (deliveryMethod === 'Email') {
      // Import EmailTemplatesService for HTML minification
      const EmailTemplatesService = require('../services/emailTemplates.service');
      
      // Queue email with acknowledgement signing link (HTML without extra whitespace)
      const htmlContent = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>New Enrollment - Signature Required</title></head><body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;"><div style="background-color: #f8f9fa; padding: 30px; border-radius: 8px; text-align: center;"><h1 style="color: #2563eb; margin: 0 0 20px 0;">New Enrollment - Signature Required</h1><p style="font-size: 16px; margin-bottom: 25px;">Please review and sign the acknowledgements for your benefits enrollment.</p><a href="${signingUrl}" style="display: inline-block; background-color: #2563eb; color: white; text-decoration: none; padding: 14px 28px; border-radius: 6px; font-size: 16px; font-weight: 600;">Review & Sign Acknowledgements</a><p style="margin-top: 25px; font-size: 14px; color: #6b7280;">This link will expire in 24 hours.</p><p style="margin-top: 15px; font-size: 12px; color: #9ca3af;"><strong>Important:</strong> Check your Spam/Junk folder if you don't see this email in your inbox.</p></div></body></html>`;
      
      // Minify HTML to prevent email clients from adding whitespace
      const minifiedHtmlContent = EmailTemplatesService.minifyHtml(htmlContent);
      
      await MessageQueueService.queueEmail({
        tenantId: tenantId,
        toEmail: email,
        toName: 'Enrollee',
        subject: 'New Enrollment - Signature Required',
        htmlContent: minifiedHtmlContent,
        messageType: 'Email',
        createdBy: null,
        recipientId: null
      });
      
      console.log(`✅ Acknowledgement signing email queued to: ${email}`);
    } else if (deliveryMethod === 'SMS') {
      // Queue SMS with acknowledgement signing link
      const smsContent = `Sign your enrollment acknowledgements here: ${signingUrl}\n\nThis link expires in 24 hours.`;
      
      await MessageQueueService.queueMessage({
        tenantId: tenantId,
        messageType: 'SMS',
        recipientAddress: phone,
        subject: null, // SMS doesn't have subject
        messageBody: smsContent,
        status: 'Pending',
        createdBy: null,
        recipientId: null
      });
      
      console.log(`✅ Acknowledgement signing SMS queued to: ${phone}`);
    }
    
    res.json({
      success: true,
      message: `Acknowledgements sent via ${deliveryMethod}`,
      data: {
        token: acknowledgementToken,
        expiresAt: expiresAt.toISOString(),
        resendCooldown: 60 // seconds before resend is allowed
      }
    });
    
  } catch (error) {
    console.error('Error sending acknowledgements:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send acknowledgements',
      error: error.message
    });
  }
});

// GET /api/enrollment-links/:linkToken/acknowledgements/status - Check if acknowledgements have been signed
router.get('/:linkToken/acknowledgements/status', async (req, res) => {
  try {
    const { linkToken } = req.params;
    
    if (!linkToken) {
      return res.status(400).json({
        success: false,
        message: 'Link token is required'
      });
    }
    
    const pool = await getPool();
    
    // Check for signed acknowledgements in AcknowledgementTokens table
    const tokenQuery = `
      SELECT 
        at.AcknowledgementTokenId,
        at.Status,
        at.SignedDate,
        at.DeliveryMethod
      FROM oe.AcknowledgementTokens at
      WHERE at.LinkToken = @linkToken
        AND at.Status = 'Signed'
      ORDER BY at.SignedDate DESC
    `;
    
    const tokenRequest = pool.request();
    tokenRequest.input('linkToken', sql.NVarChar, linkToken);
    const tokenResult = await tokenRequest.query(tokenQuery);
    
    const hasSigned = tokenResult.recordset.length > 0;
    
    res.json({
      success: true,
      data: {
        signed: hasSigned,
        signedAt: hasSigned ? tokenResult.recordset[0].SignedDate : null,
        deliveryMethod: hasSigned ? tokenResult.recordset[0].DeliveryMethod : null
      }
    });
    
  } catch (error) {
    console.error('Error checking acknowledgement status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to check acknowledgement status',
      error: error.message
    });
  }
});

// POST /api/enrollment-links/:linkToken/agreements - Save acknowledgements and signatures
router.post('/:linkToken/agreements', async (req, res) => {
    try {
        const { linkToken } = req.params;
        const { acknowledgements, digitalSignature, memberInfo, ipAddress, userAgent } = req.body;

        console.log('📝 Saving agreements for link:', linkToken);
        console.log('🔍 Request body:', { acknowledgements: !!acknowledgements, digitalSignature: !!digitalSignature, memberInfo: !!memberInfo });

        // Validate required data
        if (!acknowledgements || !digitalSignature) {
            console.log('❌ Validation failed - missing required data');
            return res.status(400).json({
                success: false,
                message: 'Acknowledgements and digital signature are required'
            });
        }

        console.log('✅ Validation passed, fetching enrollment link...');

        // Get enrollment link data to find member
        const enrollmentLink = await getEnrollmentLinkByToken(linkToken);
        console.log('🔍 Enrollment link result:', enrollmentLink ? 'Found' : 'Not found');
        
        if (!enrollmentLink) {
            console.log('❌ Enrollment link not found for token:', linkToken);
            return res.status(404).json({
                success: false,
                message: 'Enrollment link not found'
            });
        }

        // Get member information
        const member = await getMemberById(enrollmentLink.memberId);
        if (!member) {
            return res.status(404).json({
                success: false,
                message: 'Member not found'
            });
        }

        // Save acknowledgements to database
        const savedAcknowledgements = await saveAcknowledgements(
            enrollmentLink.memberId,
            acknowledgements,
            digitalSignature,
            ipAddress,
            userAgent
        );

        console.log('✅ Agreements saved successfully for member:', enrollmentLink.memberId);

        res.json({
            success: true,
            message: 'Agreements saved successfully',
            data: {
                acknowledgementsId: savedAcknowledgements.id,
                memberId: enrollmentLink.memberId,
                timestamp: new Date().toISOString()
            }
        });

    } catch (error) {
        console.error('❌ Error saving agreements:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to save agreements'
        });
    }
});

// POST /api/enrollment-links/:linkToken/generate-agreements-pdf - Generate and upload agreements PDF
router.post('/:linkToken/generate-agreements-pdf', async (req, res) => {
    try {
        const { linkToken } = req.params;
        const { acknowledgements, digitalSignature, memberInfo, productSelections } = req.body;

        console.log('📄 Generating agreements PDF for link:', linkToken);

        // Validate required data
        if (!acknowledgements || !digitalSignature || !memberInfo) {
            return res.status(400).json({
                success: false,
                message: 'Acknowledgements, digital signature, and member info are required'
            });
        }

        // Get enrollment link data to find member
        const enrollmentLink = await getEnrollmentLinkByToken(linkToken);
        if (!enrollmentLink) {
            return res.status(404).json({
                success: false,
                message: 'Enrollment link not found'
            });
        }

        // Get member information
        const member = await getMemberById(enrollmentLink.memberId);
        if (!member) {
            return res.status(404).json({
                success: false,
                message: 'Member not found'
            });
        }

        // Generate PDF content
        const pdfContent = await generateAgreementsPDF(acknowledgements, digitalSignature, memberInfo, productSelections);
        
        // Generate filename with user-specific path
        const timestamp = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
        const filename = `users/${member.UserId}/agreements-${timestamp}.pdf`;
        
        // Convert PDF content to buffer
        const pdfBuffer = Buffer.from(pdfContent, 'base64');
        
        // Create a file object for upload
        const fileObject = {
            buffer: pdfBuffer,
            originalname: `agreements-${timestamp}.pdf`,
            mimetype: 'application/pdf',
            size: pdfBuffer.length
        };

        // Upload to Azure Blob Storage
        const { uploadToAzureBlob, generateAuthenticatedUrl } = require('./uploads');
        let pdfUrl = await uploadToAzureBlob(fileObject, 'agreements', filename);

        // CRITICAL: Authenticate the PDF URL before sending to frontend
        try {
            pdfUrl = await generateAuthenticatedUrl(pdfUrl);
            console.log('✅ PDF URL authenticated successfully!');
        } catch (authError) {
            console.error('❌ Failed to authenticate PDF URL:', authError);
            // Continue with original URL if authentication fails
        }

        // Update member record with signed agreements link
        await updateMemberSignedAgreements(member.MemberId, pdfUrl, timestamp);

        console.log('✅ Agreements PDF generated and uploaded successfully:', {
            memberId: member.MemberId,
            filename: filename,
            url: pdfUrl
        });

        // 🔗 IMPORTANT: Log the PDF link for testing
        console.log('🔗 PDF LINK FOR TESTING:', pdfUrl);
        console.log('🔗 Direct download link:', pdfUrl);

        res.json({
            success: true,
            message: 'Agreements PDF generated and uploaded successfully',
            data: {
                pdfUrl: pdfUrl,
                filename: filename,
                memberId: member.MemberId,
                timestamp: timestamp
            }
        });

    } catch (error) {
        console.error('❌ Error generating agreements PDF:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to generate agreements PDF'
        });
    }
});

// GET /api/enrollment-links/:linkToken/vendor-networks - Active networks for a vendor
// referenced by this enrollment link's products. Used by the wizard's Provider Network
// picker. Public-via-link (no auth header) but scoped: vendor must be tied to a product
// the link surfaces, otherwise 403.
router.get('/:linkToken/vendor-networks', async (req, res) => {
  try {
    const { linkToken } = req.params;
    const { vendorId } = req.query;
    if (!linkToken || !vendorId) {
      return res.status(400).json({ success: false, message: 'Link token and vendorId are required' });
    }

    const pool = await getPool();
    // Validate link is active. We don't strictly scope to vendors referenced by the link's
    // template — vendor network titles are non-sensitive and the wizard only asks about
    // vendors that already showed up on a product card.
    const linkCheck = await pool.request()
      .input('linkToken', sql.NVarChar, linkToken)
      .query('SELECT LinkId FROM oe.EnrollmentLinks WHERE LinkToken = @linkToken AND IsActive = 1');
    if (!linkCheck.recordset?.length) {
      return res.status(404).json({ success: false, message: 'Invalid or inactive link' });
    }

    const result = await pool.request()
      .input('vendorId', sql.UniqueIdentifier, vendorId)
      .query(`
        SELECT VendorNetworkId, VendorId, Title, IsDefault, IsActive
        FROM oe.VendorNetworks
        WHERE VendorId = @vendorId AND IsActive = 1
        ORDER BY IsDefault DESC, Title
      `);

    const networks = result.recordset.map((r) => ({
      vendorNetworkId: r.VendorNetworkId,
      vendorId: r.VendorId,
      title: r.Title,
      isDefault: r.IsDefault === true || r.IsDefault === 1,
      isActive: r.IsActive === true || r.IsActive === 1
    }));

    res.json({ success: true, data: networks });
  } catch (error) {
    console.error('Error fetching enrollment-link vendor networks:', error);
    res.status(500).json({ success: false, message: 'Failed to load vendor networks' });
  }
});

// GET /api/enrollment-links/:linkToken/product-info/:productId - Fresh product details for Product Info modal (current productDocuments only)
router.get('/:linkToken/product-info/:productId', async (req, res) => {
  try {
    const { linkToken, productId } = req.params;
    if (!linkToken || !productId) {
      return res.status(400).json({ success: false, message: 'Link token and product ID are required' });
    }
    const pool = await getPool();
    const linkCheck = await pool.request()
      .input('linkToken', sql.NVarChar, linkToken)
      .query('SELECT LinkId FROM oe.EnrollmentLinks WHERE LinkToken = @linkToken AND IsActive = 1');
    if (!linkCheck.recordset?.length) {
      return res.status(404).json({ success: false, message: 'Invalid or inactive link' });
    }
    const prodRequest = pool.request();
    prodRequest.input('productId', sql.UniqueIdentifier, productId);
    const prodResult = await prodRequest.query(`
      SELECT ProductId, Name AS ProductName, Description, ProductType, ProductDocumentUrl, Status
      FROM oe.Products WHERE ProductId = @productId AND Status = 'Active'
    `);
    if (!prodResult.recordset?.length) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }
    const row = prodResult.recordset[0];
    let productDocs = (await getProductDocumentsForProductIds(pool, [productId], sql)).get(productId) || [];
    if (productDocs.length === 0 && row.ProductDocumentUrl && typeof row.ProductDocumentUrl === 'string' && row.ProductDocumentUrl.trim()) {
      productDocs = [{ documentUrl: row.ProductDocumentUrl.trim(), displayName: 'Document', sortOrder: 0 }];
    }
    if (productDocs.length > 0) {
      productDocs = await authenticateProductDocumentsArray(productDocs);
    }
    const product = {
      productId: row.ProductId,
      productName: row.ProductName,
      name: row.ProductName,
      description: row.Description || null,
      productDocumentUrl: row.ProductDocumentUrl || (productDocs[0]?.documentUrl) || null,
      productDocuments: productDocs,
      isBundle: row.ProductType === 'Bundle'
    };
    let includedProducts = [];
    if (row.ProductType === 'Bundle') {
      const bundleResult = await pool.request()
        .input('BundleProductId', sql.UniqueIdentifier, productId)
        .query(`
          SELECT pb.IncludedProductId, pb.SortOrder, p.Name AS ProductName, p.Description, p.ProductType, p.ProductDocumentUrl
          FROM oe.ProductBundles pb
          INNER JOIN oe.Products p ON pb.IncludedProductId = p.ProductId
          WHERE pb.BundleProductId = @BundleProductId AND p.Status = 'Active'
          ORDER BY pb.SortOrder
        `);
      const includedIds = (bundleResult.recordset || []).map((r) => r.IncludedProductId).filter(Boolean);
      const includedDocsMap = includedIds.length > 0 ? await getProductDocumentsForProductIds(pool, includedIds, sql) : new Map();
      for (const inc of bundleResult.recordset || []) {
        let docs = includedDocsMap.get(inc.IncludedProductId) || [];
        if (docs.length === 0 && inc.ProductDocumentUrl && typeof inc.ProductDocumentUrl === 'string' && inc.ProductDocumentUrl.trim()) {
          docs = [{ documentUrl: inc.ProductDocumentUrl.trim(), displayName: 'Document', sortOrder: 0 }];
        }
        if (docs.length > 0) docs = await authenticateProductDocumentsArray(docs);
        includedProducts.push({
          productId: inc.IncludedProductId,
          productName: inc.ProductName,
          name: inc.ProductName,
          description: inc.Description || null,
          productDocumentUrl: inc.ProductDocumentUrl || (docs[0]?.documentUrl) || null,
          productDocuments: docs
        });
      }
    }
    return res.json({ success: true, product, includedProducts });
  } catch (err) {
    console.error('Product info fetch error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Failed to load product info' });
  }
});

// GET /api/enrollment-links/:linkToken/enrollment-data - Get comprehensive enrollment data
router.get('/:linkToken/enrollment-data', async (req, res) => {
  try {
    const { linkToken } = req.params;
    
    if (!linkToken) {
      return res.status(400).json({
        success: false,
        message: 'Link token is required'
      });
    }

    const pool = await getPool();
    
    // First, get the enrollment link with basic info
    // Handle group, member, and agent-static enrollment links
    const linkQuery = `
      SELECT 
        el.LinkId,
        el.GroupId,
        el.MemberId,
        el.LinkToken,
        el.LinkUrl,
        el.Description,
        el.ExpiresAt,
        el.IsActive,
        el.UsageCount,
        el.MaxUsage,
        el.CreatedDate,
        el.CreatedBy,
        el.EnrollmentLinkTemplateId,
        el.AgentId,
        el.AgencyId,
        -- Add LinkType with fallback for existing links
        CASE 
          WHEN el.LinkType IS NOT NULL THEN el.LinkType
          WHEN el.GroupId IS NOT NULL THEN 'Group'
          ELSE 'Member'
        END AS LinkType,
        el.ShortCode,
        g.Name AS GroupName,
        g.LogoUrl AS GroupLogoUrl,
        g.ShowEmployeePricingOnTiles,
        g.ShowContributionStrategy,
        -- TenantId logic: Group > Member > Agent (for Agent-Static links)
        CASE 
          WHEN el.GroupId IS NOT NULL THEN g.TenantId 
          WHEN el.MemberId IS NOT NULL THEN m.TenantId
          WHEN el.AgentId IS NOT NULL THEN a.TenantId
          ELSE NULL
        END AS TenantId,
        -- TenantName logic: Group > Member > Agent
        CASE 
          WHEN el.GroupId IS NOT NULL THEN t_group.Name 
          WHEN el.MemberId IS NOT NULL THEN t_member.Name
          WHEN el.AgentId IS NOT NULL THEN t_agent.Name
          ELSE NULL
        END AS TenantName,
        -- TenantLogoUrl logic: Group > Member > Agent
        CASE 
          WHEN el.GroupId IS NOT NULL THEN ISNULL(json_value(t_group.AdvancedSettings, '$.branding.logoUrl'), '/images/branding/allaboard365/allaboard365-logo-transparent.png')
          WHEN el.MemberId IS NOT NULL THEN ISNULL(json_value(t_member.AdvancedSettings, '$.branding.logoUrl'), '/images/branding/allaboard365/allaboard365-logo-transparent.png')
          WHEN el.AgentId IS NOT NULL THEN ISNULL(json_value(t_agent.AdvancedSettings, '$.branding.logoUrl'), '/images/branding/allaboard365/allaboard365-logo-transparent.png')
          ELSE '/images/branding/allaboard365/allaboard365-logo-transparent.png'
        END as TenantLogoUrl,
        -- Mobile App settings from tenant AdvancedSettings
        CASE
          WHEN el.GroupId IS NOT NULL THEN ISNULL(json_value(t_group.AdvancedSettings, '$.features.mobileApp.enableAppDownloadStep'), 'false')
          WHEN el.MemberId IS NOT NULL THEN ISNULL(json_value(t_member.AdvancedSettings, '$.features.mobileApp.enableAppDownloadStep'), 'false')
          WHEN el.AgentId IS NOT NULL THEN ISNULL(json_value(t_agent.AdvancedSettings, '$.features.mobileApp.enableAppDownloadStep'), 'false')
          ELSE 'false'
        END AS MobileAppEnabled,
        CASE
          WHEN el.GroupId IS NOT NULL THEN json_value(t_group.AdvancedSettings, '$.features.mobileApp.appStoreUrl')
          WHEN el.MemberId IS NOT NULL THEN json_value(t_member.AdvancedSettings, '$.features.mobileApp.appStoreUrl')
          WHEN el.AgentId IS NOT NULL THEN json_value(t_agent.AdvancedSettings, '$.features.mobileApp.appStoreUrl')
          ELSE NULL
        END AS AppStoreUrl,
        CASE
          WHEN el.GroupId IS NOT NULL THEN json_value(t_group.AdvancedSettings, '$.features.mobileApp.playStoreUrl')
          WHEN el.MemberId IS NOT NULL THEN json_value(t_member.AdvancedSettings, '$.features.mobileApp.playStoreUrl')
          WHEN el.AgentId IS NOT NULL THEN json_value(t_agent.AdvancedSettings, '$.features.mobileApp.playStoreUrl')
          ELSE NULL
        END AS PlayStoreUrl,
        CASE
          WHEN el.GroupId IS NOT NULL THEN json_value(t_group.AdvancedSettings, '$.features.mobileApp.appImageUrl')
          WHEN el.MemberId IS NOT NULL THEN json_value(t_member.AdvancedSettings, '$.features.mobileApp.appImageUrl')
          WHEN el.AgentId IS NOT NULL THEN json_value(t_agent.AdvancedSettings, '$.features.mobileApp.appImageUrl')
          ELSE NULL
        END AS AppImageUrl,
        -- Agent/Agency names
        CASE 
          WHEN el.AgentId IS NOT NULL THEN u_agent.FirstName + ' ' + u_agent.LastName
          ELSE NULL
        END AS AgentName,
        u_agent.Email AS AgentEmail,
        u_agent.PhoneNumber AS AgentPhone,
        CASE 
          WHEN el.AgencyId IS NOT NULL THEN ag.AgencyName
          ELSE NULL
        END AS AgencyName,
        elt.TemplateName,
        elt.TemplateType,
        elt.LinkMetaData,
        elt.GroupId AS TemplateGroupId
      FROM oe.EnrollmentLinks el
      LEFT JOIN oe.Groups g ON el.GroupId = g.GroupId
      LEFT JOIN oe.Members m ON el.MemberId = m.MemberId
      LEFT JOIN oe.Tenants t_group ON g.TenantId = t_group.TenantId
      LEFT JOIN oe.Tenants t_member ON m.TenantId = t_member.TenantId
      LEFT JOIN oe.EnrollmentLinkTemplates elt ON el.EnrollmentLinkTemplateId = elt.TemplateId
      -- Join to get agent/agency info
      LEFT JOIN oe.Agents a ON el.AgentId = a.AgentId
      LEFT JOIN oe.Users u_agent ON a.UserId = u_agent.UserId
      LEFT JOIN oe.Tenants t_agent ON a.TenantId = t_agent.TenantId
      LEFT JOIN oe.Agencies ag ON el.AgencyId = ag.AgencyId
      WHERE el.LinkToken = @linkToken
    `;
    
    const linkRequest = pool.request();
    linkRequest.input('linkToken', sql.NVarChar, linkToken);
    
    const linkResult = await linkRequest.query(linkQuery);
    
    if (linkResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Enrollment link not found'
      });
    }
    
    const enrollmentLink = linkResult.recordset[0];
    
    // Debug logging to see what we got from the database
    console.log('🔍 DEBUG: Enrollment link data retrieved:', {
      linkId: enrollmentLink.LinkId,
      linkType: enrollmentLink.LinkType,
      groupId: enrollmentLink.GroupId,
      memberId: enrollmentLink.MemberId,
      linkToken: enrollmentLink.LinkToken,
      groupName: enrollmentLink.GroupName,
      tenantId: enrollmentLink.TenantId
    });
    
    // Check if enrollment link has a MemberId (required for Member/Group links, not Agent-Static/Marketing)
    if (!enrollmentLink.MemberId && enrollmentLink.LinkType !== 'Agent-Static' && enrollmentLink.LinkType !== 'Marketing') {
      console.log('❌ ERROR: Enrollment link missing MemberId:', enrollmentLink.LinkId);
      return res.status(400).json({
        success: false,
        message: 'Enrollment link is not associated with a specific member. Please regenerate the enrollment link.'
      });
    }
    
    // Check if link is active
    if (!enrollmentLink.IsActive) {
      return res.status(200).json({
        success: true,
        data: {
          status: 'inactive',
          message: 'Enrollment link is inactive'
        }
      });
    }
    
    // Check if link has expired
    if (enrollmentLink.ExpiresAt && new Date(enrollmentLink.ExpiresAt) < new Date()) {
      return res.status(200).json({
        success: true,
        data: {
          status: 'expired',
          message: 'Enrollment link has expired'
        }
      });
    }
    
    // Check usage limits
    if (enrollmentLink.MaxUsage && enrollmentLink.UsageCount >= enrollmentLink.MaxUsage) {
      return res.status(200).json({
        success: true,
        data: {
          status: 'used',
          message: 'Enrollment link usage limit reached'
        }
      });
    }

    // T-5 vendor-minimum lock check (Group links only).
    // ListBill groups and links with no minimum are never locked.
    // Mid-flow enrollees (existing Pending/InFlight enrollment) always pass through.
    if (enrollmentLink.GroupId) {
      const lockResult = await isGroupLockedForNewEnrollment(
        enrollmentLink.GroupId,
        enrollmentLink.MemberId || null
      );
      if (lockResult.locked) {
        return res.status(200).json({
          success: false,
          code: lockResult.reason,
          message: 'Enrollment for this group is temporarily paused. Please contact your agent.',
          data: {
            minimum: lockResult.minimum,
            currentCount: lockResult.currentCount
          }
        });
      }
    }

    // Get the specific member associated with this enrollment link (skip for Agent-Static)
    let member = null;
    
    if (enrollmentLink.LinkType !== 'Agent-Static' && enrollmentLink.LinkType !== 'Marketing') {
    const memberQuery = `
      SELECT 
        m.MemberId,
        m.UserId,
        m.GroupId,
        m.HouseholdId,
        m.Status,
        m.DateOfBirth,
        m.Gender,
        m.Address,
        m.City,
        m.State,
        m.Zip,
        m.SSN,
        m.MedicalInfo,
        m.EnrollmentType,
        m.RelationshipType,
        m.TenantId,
        m.AgentId,
        m.TobaccoUse,
        m.Tier,
        m.JobPosition,
        m.Height,
        m.Weight,
        m.CreatedDate,
        m.ModifiedDate,
        u.FirstName,        -- ✅ Get from Users table
        u.LastName,         -- ✅ Get from Users table
        u.Email AS UserEmail, -- ✅ Get from Users table
        u.PhoneNumber       -- ✅ Get from Users table
      FROM oe.Members m
      LEFT JOIN oe.Users u ON m.UserId = u.UserId
      WHERE m.MemberId = @memberId AND m.Status IN ('Active', 'Terminated')  -- Allow terminated members for re-enrollment
    `;
    
    const memberRequest = pool.request();
    memberRequest.input('memberId', sql.UniqueIdentifier, enrollmentLink.MemberId);
    
    console.log('🔍 DEBUG: Querying for member with ID:', enrollmentLink.MemberId);
    
    const memberResult = await memberRequest.query(memberQuery);
    
    console.log('🔍 DEBUG: Member query result:', {
      recordCount: memberResult.recordset.length,
      memberData: memberResult.recordset[0] || 'No member found',
      memberFields: memberResult.recordset[0] ? Object.keys(memberResult.recordset[0]) : 'No fields'
    });
    
    if (memberResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Member not found or inactive'
      });
    }

      member = memberResult.recordset[0];
    } else {
      console.log(`🔍 DEBUG: ${enrollmentLink.LinkType} link detected - skipping member query`);
    }

    // Get products based on the enrollment link template, organized by sections
    let productSections = [];
    let requiresSSN = false; // Initialize SSN requirement flag
    let requiresHeightWeight = false; // Initialize Height/Weight requirement flag
    if (enrollmentLink.LinkMetaData) {
      try {
        const linkMetaData = JSON.parse(enrollmentLink.LinkMetaData);
        console.log('🔍 Parsed LinkMetaData:', linkMetaData);

        // For Group enrollment links, pull products from oe.GroupProducts instead of LinkMetaData
        // This ensures the enrollment wizard always shows the group's current product assignments
        // Use the TEMPLATE's GroupId (not the enrollment link's) to decide whether to pull from GroupProducts.
        // Some older Group templates have GroupId=NULL on the template but GroupId set on the enrollment link —
        // those should continue reading from LinkMetaData to avoid breaking existing enrollments.
        const isGroupLink = enrollmentLink.TemplateType === 'Group' && enrollmentLink.TemplateGroupId;
        let effectiveProductSections = linkMetaData.products;

        if (isGroupLink) {
          console.log('🔍 Group enrollment link detected — loading products from oe.GroupProducts');
          const gpRequest = pool.request();
          gpRequest.input('groupId', sql.UniqueIdentifier, enrollmentLink.TemplateGroupId);
          const gpResult = await gpRequest.query(`
            SELECT gp.ProductId, p.ProductType
            FROM oe.GroupProducts gp
            INNER JOIN oe.Products p ON gp.ProductId = p.ProductId
            WHERE gp.GroupId = @groupId AND gp.IsActive = 1 AND p.Status = 'Active'
              AND (p.IsHidden IS NULL OR p.IsHidden = 0)
              AND (gp.IsHidden IS NULL OR gp.IsHidden = 0)
          `);
          // Group products by ProductType into sections
          const byType = {};
          for (const row of gpResult.recordset) {
            const pt = row.ProductType || 'Other';
            if (!byType[pt]) byType[pt] = [];
            byType[pt].push(row.ProductId);
          }
          effectiveProductSections = Object.entries(byType).map(([productType, ids]) => ({
            page: `${productType} Plans`,
            description: '',
            productType,
            sectionType: 'products',
            includeAllProducts: false,
            specificProducts: ids,
            specificBundles: []
          }));
          console.log(`🔍 Built ${effectiveProductSections.length} sections from GroupProducts`);
        }

        if (effectiveProductSections && Array.isArray(effectiveProductSections)) {
          console.log('🔍 Found products array:', effectiveProductSections);

          // Process each product section
          for (const productSection of effectiveProductSections) {
            console.log(`🔍 Processing product section: ${productSection.page}`);

            let sectionProducts = [];

            // Use only specificProducts (bundles and regular products in one list per section).
            // For backward compatibility, merge specificBundles into the ID list if present.
            const productIdsArray = [
              ...(Array.isArray(productSection.specificProducts) ? productSection.specificProducts : []),
              ...(Array.isArray(productSection.specificBundles) ? productSection.specificBundles : [])
            ];
            const hasSelectedProducts = productIdsArray.length > 0;

            if (productIdsArray.length > 0) {
              const placeholders = productIdsArray.map((_, index) => `@product${index}`).join(',');
              const productsQuery = `
                SELECT
                  p.ProductId,
                  p.Name AS ProductName,
                  p.Description,
                  p.ProductType,
                  p.Status,
                  p.CoverageDetails,
                  p.PricingModel,
                  p.ProductImageUrl,
                  p.ProductLogoUrl,
                  p.ProductDocumentUrl,
                  p.PlanDetailsData,
                  p.IDCardData,
                  p.VendorId,
                  p.RequiredDataFields,
                  p.IsSSNRequired,
                  p.MinAge,
                  p.MaxAge,
                  p.uses_age_banding,
                  p.ProductQuestionnaires,
                  p.AllowedStates
                FROM oe.Products p
                WHERE p.ProductId IN (${placeholders})
                  AND p.Status = 'Active'
              `;
              const productsRequest = pool.request();
              productIdsArray.forEach((id, index) => {
                productsRequest.input(`product${index}`, sql.UniqueIdentifier, id);
              });
              const productsResult = await productsRequest.query(productsQuery);
              const byId = new Map(productsResult.recordset.map((r) => [r.ProductId, r]));
              sectionProducts = productIdsArray.map((id) => byId.get(id)).filter(Boolean);
              console.log(`✅ Retrieved ${sectionProducts.length} products for section: ${productSection.page} (order preserved)`);
            } else {
              console.log(`⚠️ No specific products configured for section: ${productSection.page} - section will be empty`);
            }

            // Fetch ProductDocuments for all products in this section (main + bundle included) for Product Info modal
            const sectionProductIds = sectionProducts.map((p) => p.ProductId).filter(Boolean);
            let includedProductIds = [];
            if (sectionProductIds.length > 0) {
              try {
                const bundleIds = sectionProducts.filter((p) => p.ProductType === 'Bundle').map((p) => p.ProductId).filter(Boolean);
                if (bundleIds.length > 0) {
                  const inclRequest = pool.request();
                  bundleIds.forEach((id, i) => inclRequest.input(`b${i}`, sql.UniqueIdentifier, id));
                  const inclResult = await inclRequest.query(
                    `SELECT DISTINCT IncludedProductId FROM oe.ProductBundles WHERE BundleProductId IN (${bundleIds.map((_, i) => `@b${i}`).join(',')})`
                  );
                  includedProductIds = (inclResult.recordset || []).map((r) => r.IncludedProductId).filter(Boolean);
                }
                const allDocProductIds = [...new Set([...sectionProductIds, ...includedProductIds])];
                var productDocumentsMap = allDocProductIds.length > 0 ? await getProductDocumentsForProductIds(pool, allDocProductIds, sql) : new Map();
              } catch (err) {
                console.warn('⚠️ ProductDocuments fetch for enrollment section failed:', err.message);
                var productDocumentsMap = new Map();
              }
            } else {
              var productDocumentsMap = new Map();
            }

            // Create the section object (always create if products were selected in template, even if query returned 0)
            const section = {
              sectionId: `section-${productSection.productType?.toLowerCase().replace(/\s+/g, '-') || 'unknown'}`,
              page: productSection.page,
              description: productSection.description,
              productType: productSection.productType,
              sectionType: productSection.sectionType,
              includeAllProducts: productSection.includeAllProducts,
              specificProducts: productIdsArray,
              products: await Promise.all(sectionProducts.map(async (product) => {
                // Parse PlanDetailsData if present
                let planDetailsData = null;
                if (product.PlanDetailsData) {
                  try {
                    planDetailsData = typeof product.PlanDetailsData === 'string' 
                      ? JSON.parse(product.PlanDetailsData) 
                      : product.PlanDetailsData;
                  } catch (e) {
                    console.error('Error parsing PlanDetailsData:', e);
                    planDetailsData = null;
                  }
                }

                // Parse ProductQuestionnaires if present
                let productQuestionnaires = null;
                if (product.ProductQuestionnaires) {
                  try {
                    productQuestionnaires = typeof product.ProductQuestionnaires === 'string'
                      ? JSON.parse(product.ProductQuestionnaires)
                      : product.ProductQuestionnaires;
                  } catch (e) {
                    console.error('Error parsing ProductQuestionnaires:', e);
                    productQuestionnaires = null;
                  }
                }

                // Parse RequiredDataFields if present
                let requiredDataFields = null;
                if (product.RequiredDataFields) {
                  try {
                    requiredDataFields = typeof product.RequiredDataFields === 'string' 
                      ? JSON.parse(product.RequiredDataFields) 
                      : product.RequiredDataFields;
                    console.log(`📋 Product ${product.ProductName} - RequiredDataFields parsed:`, JSON.stringify(requiredDataFields));
                  } catch (e) {
                    console.error('Error parsing RequiredDataFields:', e);
                    requiredDataFields = null;
                  }
                } else {
                  console.log(`📋 Product ${product.ProductName} - No RequiredDataFields found`);
                }

                // Get pricing tiers for this product
                const pricingTiersQuery = `
                  SELECT 
                    TierType,
                    MSRPRate,
                    NetRate,
                    OverrideRate
                  FROM oe.ProductPricing
                  WHERE ProductId = @productId
                    AND Status = 'Active'
                `;
                
                const pricingRequest = pool.request();
                pricingRequest.input('productId', sql.UniqueIdentifier, product.ProductId);
                const pricingResult = await pricingRequest.query(pricingTiersQuery);
                
                // Group pricing by TierType and calculate min/max MSRPRate
                const tierMap = new Map();
                pricingResult.recordset.forEach(pricing => {
                  const tierType = pricing.TierType || 'Standard';
                  const msrpRate = parseFloat(pricing.MSRPRate) || 0;
                  
                  if (!tierMap.has(tierType)) {
                    tierMap.set(tierType, {
                      tierType: tierType,
                      minMSRP: msrpRate,
                      maxMSRP: msrpRate,
                      count: 1
                    });
                  } else {
                    const tier = tierMap.get(tierType);
                    tier.minMSRP = Math.min(tier.minMSRP, msrpRate);
                    tier.maxMSRP = Math.max(tier.maxMSRP, msrpRate);
                    tier.count++;
                  }
                });
                
                const pricingTiers = Array.from(tierMap.values());

                let mainProductDocs = productDocumentsMap.get(product.ProductId) || [];
                if (mainProductDocs.length === 0 && product.ProductDocumentUrl && typeof product.ProductDocumentUrl === 'string' && product.ProductDocumentUrl.trim()) {
                  mainProductDocs = [{ documentUrl: product.ProductDocumentUrl.trim(), displayName: 'Document', sortOrder: 0 }];
                }
                const allowedStates = parseAllowedStates(product.AllowedStates);
                const baseProduct = {
                  allowedStates,
                  isAvailableForState: isProductAvailableForState(allowedStates, normalizeStateCode(member?.State || '')),
                  productId: product.ProductId,
                  productName: product.ProductName,
                  description: product.Description,
                  productType: product.ProductType,
                  status: product.Status,
                  coverageDetails: product.CoverageDetails,
                  pricingModel: product.PricingModel,
                  productImageUrl: product.ProductImageUrl || null,
                  productLogoUrl: product.ProductLogoUrl || null,
                  productDocumentUrl: product.ProductDocumentUrl || null,
                  productDocuments: mainProductDocs,
                  planDetailsData: planDetailsData,
                  requiredDataFields: requiredDataFields,
                  pricingTiers: pricingTiers,
                  isSSNRequired: Boolean(product.IsSSNRequired),
                  minAge: product.MinAge != null ? product.MinAge : null,
                  maxAge: product.MaxAge != null ? product.MaxAge : null,
                  usesAgeBanding: Boolean(product.uses_age_banding),
                  productQuestionnaires: productQuestionnaires,
                  vendorId: product.VendorId || null,
                  // Raw IDCardData JSON (parsed) so the wizard can detect NetworkVariations
                  // and decide whether to render the Provider Network picker. Resolution
                  // happens on read elsewhere — here we expose the full structure.
                  idCardData: (() => {
                    if (!product.IDCardData) return null;
                    try {
                      return typeof product.IDCardData === 'string'
                        ? JSON.parse(product.IDCardData)
                        : product.IDCardData;
                    } catch (e) {
                      console.warn('Error parsing IDCardData for product', product.ProductId, e.message);
                      return null;
                    }
                  })()
                };

                // Must be sold with: from TenantProductSubscriptions for this tenant/product
                let mustBeSoldWithProductIds = [];
                let mustBeSoldWithProductNames = [];
                if (enrollmentLink.TenantId && product.ProductId) {
                  try {
                    const tpsReq = pool.request();
                    tpsReq.input('TenantId', sql.UniqueIdentifier, enrollmentLink.TenantId);
                    tpsReq.input('ProductId', sql.UniqueIdentifier, product.ProductId);
                    const tpsResult = await tpsReq.query(`
                      SELECT MustBeSoldWithProductIds FROM oe.TenantProductSubscriptions
                      WHERE TenantId = @TenantId AND ProductId = @ProductId AND SubscriptionStatus IN ('Active', 'Approved')
                    `);
                    const row = tpsResult.recordset[0];
                    if (row && row.MustBeSoldWithProductIds) {
                      try {
                        mustBeSoldWithProductIds = JSON.parse(row.MustBeSoldWithProductIds);
                      } catch (e) { /* ignore */ }
                      if (Array.isArray(mustBeSoldWithProductIds) && mustBeSoldWithProductIds.length > 0) {
                        const placeholders = mustBeSoldWithProductIds.map((_, i) => `@mb${i}`).join(',');
                        const nameReq = pool.request();
                        mustBeSoldWithProductIds.forEach((id, i) => nameReq.input(`mb${i}`, sql.UniqueIdentifier, id));
                        const nameResult = await nameReq.query(`SELECT ProductId, Name FROM oe.Products WHERE ProductId IN (${placeholders})`);
                        const nameMap = new Map((nameResult.recordset || []).map(r => [r.ProductId?.toString?.(), r.Name]));
                        mustBeSoldWithProductNames = mustBeSoldWithProductIds.map(id => nameMap.get(id) || id);
                      }
                    }
                  } catch (e) {
                    console.warn('MustBeSoldWith lookup failed for product', product.ProductId, e.message);
                  }
                }
                baseProduct.mustBeSoldWithProductIds = mustBeSoldWithProductIds;
                baseProduct.mustBeSoldWithProductNames = mustBeSoldWithProductNames;

                // Check if this is a bundle product
                if (product.ProductType === 'Bundle') {
                  console.log(`🔍 Processing bundle product: ${product.ProductName}`);
                  
                  // Get included products for this bundle
                  const bundleProductsQuery = `
                    SELECT
                      pb.IncludedProductId,
                      pb.SortOrder,
                      pb.IsRequired,
                      p.Name AS ProductName,
                      p.Description,
                      p.ProductType,
                      p.Status,
                      p.CoverageDetails,
                      p.PricingModel,
                      p.RequiredDataFields,
                      p.ProductDocumentUrl,
                      p.PlanDetailsData,
                      p.IDCardData,
                      p.VendorId,
                      p.IsSSNRequired,
                      p.ProductQuestionnaires,
                      p.AllowedStates
                    FROM oe.ProductBundles pb
                    INNER JOIN oe.Products p ON pb.IncludedProductId = p.ProductId
                    WHERE pb.BundleProductId = @bundleProductId
                      AND p.Status = 'Active'
                    ORDER BY pb.SortOrder
                  `;
                  
                  const bundleRequest = pool.request();
                  bundleRequest.input('bundleProductId', sql.UniqueIdentifier, product.ProductId);
                  
                  const bundleResult = await bundleRequest.query(bundleProductsQuery);
                  const includedProducts = bundleResult.recordset;
                  
                  console.log(`🔍 Bundle ${product.ProductName} has ${includedProducts.length} included products`);
                  
                  // Process included products
                  const processedIncludedProducts = await Promise.all(
                    includedProducts.map(async (includedProduct) => {
                      // Parse PlanDetailsData for included products
                      let includedPlanDetailsData = null;
                      if (includedProduct.PlanDetailsData) {
                        try {
                          includedPlanDetailsData = typeof includedProduct.PlanDetailsData === 'string' 
                            ? JSON.parse(includedProduct.PlanDetailsData) 
                            : includedProduct.PlanDetailsData;
                        } catch (e) {
                          console.error('Error parsing included product PlanDetailsData:', e);
                          includedPlanDetailsData = null;
                        }
                      }

                      // Parse ProductQuestionnaires for included products
                      let includedProductQuestionnaires = null;
                      if (includedProduct.ProductQuestionnaires) {
                        try {
                          includedProductQuestionnaires = typeof includedProduct.ProductQuestionnaires === 'string'
                            ? JSON.parse(includedProduct.ProductQuestionnaires)
                            : includedProduct.ProductQuestionnaires;
                        } catch (e) {
                          console.error('Error parsing included product ProductQuestionnaires:', e);
                          includedProductQuestionnaires = null;
                        }
                      }

                      // Parse RequiredDataFields for included products
                      let includedRequiredDataFields = null;
                      if (includedProduct.RequiredDataFields) {
                        try {
                          includedRequiredDataFields = typeof includedProduct.RequiredDataFields === 'string' 
                            ? JSON.parse(includedProduct.RequiredDataFields) 
                            : includedProduct.RequiredDataFields;
                        } catch (e) {
                          console.error('Error parsing included product RequiredDataFields:', e);
                          includedRequiredDataFields = null;
                        }
                      }

                      // Get pricing tiers for included product
                      const includedPricingTiersQuery = `
                        SELECT 
                          TierType,
                          MSRPRate,
                          NetRate,
                          OverrideRate
                        FROM oe.ProductPricing
                        WHERE ProductId = @includedProductId
                          AND Status = 'Active'
                      `;
                      
                      const includedPricingRequest = pool.request();
                      includedPricingRequest.input('includedProductId', sql.UniqueIdentifier, includedProduct.IncludedProductId);
                      const includedPricingResult = await includedPricingRequest.query(includedPricingTiersQuery);
                      
                      // Group pricing by TierType and calculate min/max MSRPRate
                      const includedTierMap = new Map();
                      includedPricingResult.recordset.forEach(pricing => {
                        const tierType = pricing.TierType || 'Standard';
                        const msrpRate = parseFloat(pricing.MSRPRate) || 0;
                        
                        if (!includedTierMap.has(tierType)) {
                          includedTierMap.set(tierType, {
                            tierType: tierType,
                            minMSRP: msrpRate,
                            maxMSRP: msrpRate,
                            count: 1
                          });
                        } else {
                          const tier = includedTierMap.get(tierType);
                          tier.minMSRP = Math.min(tier.minMSRP, msrpRate);
                          tier.maxMSRP = Math.max(tier.maxMSRP, msrpRate);
                          tier.count++;
                        }
                      });
                      
                      const includedPricingTiers = Array.from(includedTierMap.values());

                      let includedDocs = productDocumentsMap.get(includedProduct.IncludedProductId) || [];
                      if (includedDocs.length === 0 && includedProduct.ProductDocumentUrl && typeof includedProduct.ProductDocumentUrl === 'string' && includedProduct.ProductDocumentUrl.trim()) {
                        includedDocs = [{ documentUrl: includedProduct.ProductDocumentUrl.trim(), displayName: 'Document', sortOrder: 0 }];
                      }
                      if (includedDocs.length > 0) {
                        includedDocs = await authenticateProductDocumentsArray(includedDocs);
                      }
                      const includedAllowedStates = parseAllowedStates(includedProduct.AllowedStates);
                      const baseIncludedProduct = {
                        allowedStates: includedAllowedStates,
                        isAvailableForState: isProductAvailableForState(includedAllowedStates, normalizeStateCode(member?.State || '')),
                        productId: includedProduct.IncludedProductId,
                        productName: includedProduct.ProductName,
                        description: includedProduct.Description,
                        productType: includedProduct.ProductType,
                        status: includedProduct.Status,
                        coverageDetails: includedProduct.CoverageDetails,
                        pricingModel: includedProduct.PricingModel,
                        productImageUrl: null, // Included products don't have images in this context
                        productLogoUrl: null, // Included products don't have logos in this context
                        productDocumentUrl: includedProduct.ProductDocumentUrl || null,
                        productDocuments: includedDocs,
                        planDetailsData: includedPlanDetailsData,
                        requiredDataFields: includedRequiredDataFields,
                        pricingTiers: includedPricingTiers,
                        isSSNRequired: Boolean(includedProduct.IsSSNRequired),
                        isAvailable: true,
                        productQuestionnaires: includedProductQuestionnaires,
                        vendorId: includedProduct.VendorId || null,
                        idCardData: (() => {
                          if (!includedProduct.IDCardData) return null;
                          try {
                            return typeof includedProduct.IDCardData === 'string'
                              ? JSON.parse(includedProduct.IDCardData)
                              : includedProduct.IDCardData;
                          } catch (e) {
                            console.warn('Error parsing included IDCardData', includedProduct.IncludedProductId, e.message);
                            return null;
                          }
                        })()
                      };

                      // Authenticate single document URL if present (for backward compat when no productDocuments)
                      if (includedProduct.ProductDocumentUrl && includedDocs.length === 0) {
                        const authenticated = await authenticateUrls(baseIncludedProduct, ['productDocumentUrl']);
                        return { ...baseIncludedProduct, productDocumentUrl: authenticated.productDocumentUrl };
                      }
                      if (includedDocs.length > 0 && !baseIncludedProduct.productDocumentUrl) {
                        baseIncludedProduct.productDocumentUrl = includedDocs[0].documentUrl;
                      }
                      return baseIncludedProduct;
                    })
                  );
                  
                  // Aggregate pricing tiers from all included products for the bundle
                  // For bundles, we sum prices across all included products for each tier type
                  const bundleTierMap = new Map();
                  const allBundleMSRPRates = [];
                  
                  processedIncludedProducts.forEach(includedProduct => {
                    if (includedProduct.pricingTiers && includedProduct.pricingTiers.length > 0) {
                      includedProduct.pricingTiers.forEach(tier => {
                        const tierType = tier.tierType || 'Standard';
                        
                        // For each tier type, sum the min and max prices across all included products
                        if (!bundleTierMap.has(tierType)) {
                          bundleTierMap.set(tierType, {
                            tierType: tierType,
                            minMSRP: tier.minMSRP || 0,
                            maxMSRP: tier.maxMSRP || 0,
                            productCount: 1
                          });
                        } else {
                          const bundleTier = bundleTierMap.get(tierType);
                          // Sum the prices across products (bundle = sum of all included products)
                          bundleTier.minMSRP += (tier.minMSRP || 0);
                          bundleTier.maxMSRP += (tier.maxMSRP || 0);
                          bundleTier.productCount = (bundleTier.productCount || 0) + 1;
                        }
                        
                        // Collect all rates for overall bundle min/max calculation
                        if (tier.minMSRP > 0) allBundleMSRPRates.push(tier.minMSRP);
                        if (tier.maxMSRP > 0) allBundleMSRPRates.push(tier.maxMSRP);
                      });
                    }
                  });
                  
                  // Calculate overall bundle min/max across all tier types
                  // This is the minimum of all tier minimums and maximum of all tier maximums
                  let bundleMinMSRP = 0;
                  let bundleMaxMSRP = 0;
                  let hasBundlePricing = false;
                  
                  if (bundleTierMap.size > 0) {
                    // Find the overall min (smallest sum) and max (largest sum) across all tier types
                    bundleTierMap.forEach(tier => {
                      if (!hasBundlePricing) {
                        bundleMinMSRP = tier.minMSRP;
                        bundleMaxMSRP = tier.maxMSRP;
                        hasBundlePricing = true;
                      } else {
                        // Overall bundle range is min of all tier minimums to max of all tier maximums
                        bundleMinMSRP = Math.min(bundleMinMSRP, tier.minMSRP);
                        bundleMaxMSRP = Math.max(bundleMaxMSRP, tier.maxMSRP);
                      }
                    });
                  }
                  
                  // Use aggregated bundle tiers if available, otherwise use bundle's own pricing
                  const finalBundlePricingTiers = bundleTierMap.size > 0 
                    ? Array.from(bundleTierMap.values())
                    : pricingTiers;
                  
                  return {
                    ...baseProduct,
                    isBundle: true,
                    includedProducts: processedIncludedProducts,
                    pricingTiers: finalBundlePricingTiers,
                    bundleMinMSRP: hasBundlePricing ? bundleMinMSRP : null,
                    bundleMaxMSRP: hasBundlePricing ? bundleMaxMSRP : null
                  };
                }
                
                return baseProduct;
              }))
            };
            
            // Log if products were expected but not found
            if (hasSelectedProducts && sectionProducts.length === 0) {
              console.log(`⚠️ WARNING: Section "${productSection.page}" has ${productSection.specificProducts?.length || productSection.specificBundles?.length || 0} products selected in template but query returned 0 products. Product IDs:`, productSection.specificProducts || productSection.specificBundles);
            }
            
            // Always include the section if products were selected in the template
            // This ensures sections appear even if products aren't found (for debugging/visibility)
            if (hasSelectedProducts || section.products.length > 0) {
              productSections.push(section);
              console.log(`✅ Created section: ${section.page} with ${section.products.length} products (${hasSelectedProducts ? 'has selected products in template' : 'has products from query'})`);
            } else {
              console.log(`⚠️ Skipping section: ${section.page} - no products selected and query returned 0 products`);
            }
          }
          
          console.log(`🎯 Total product sections: ${productSections.length}`);
          
          // Authenticate blob URLs for all products in enrollment-data
          console.log('🔐 Authenticating URLs for enrollment-data products');
          const authenticatedProductSections = await Promise.all(
            productSections.map(async (section) => ({
              ...section,
              products: await Promise.all(
                section.products.map(async (product) => {
                  const authenticated = await authenticateUrls(product, ['productDocumentUrl']);
                  if (Array.isArray(authenticated.productDocuments) && authenticated.productDocuments.length > 0) {
                    authenticated.productDocuments = await authenticateProductDocumentsArray(authenticated.productDocuments);
                  }
                  console.log('🔍 Enrollment-data product authentication result:', {
                    productName: product.productName,
                    original: product.productImageUrl,
                    authenticated: authenticated.productImageUrl
                  });
                  return authenticated;
                })
              )
            }))
          );
          console.log('✅ Authentication complete for enrollment-data products');
          
          // Update productSections with authenticated URLs
          productSections.length = 0;
          productSections.push(...authenticatedProductSections);
          
          // Calculate if any product requires SSN (check direct products and bundle included products)
          requiresSSN = false; // Reset and recalculate
          for (const section of productSections) {
            for (const product of section.products) {
              // Check direct product
              if (product.isSSNRequired) {
                requiresSSN = true;
                break;
              }
              // Check bundle included products
              if (product.isBundle && product.includedProducts) {
                for (const includedProduct of product.includedProducts) {
                  if (includedProduct.isSSNRequired) {
                    requiresSSN = true;
                    break;
                  }
                }
              }
              if (requiresSSN) break;
            }
            if (requiresSSN) break;
          }
          
          console.log(`🔍 SSN Requirement Check: ${requiresSSN ? 'SSN is required' : 'SSN is not required'} for this enrollment`);

          // Calculate if any product requires Height/Weight (check direct products and bundle included products)
          requiresHeightWeight = false; // Reset and recalculate
          for (const section of productSections) {
            for (const product of section.products) {
              // Check direct product
              if (product.productQuestionnaires?.enabled && product.productQuestionnaires?.requiresHeightWeight) {
                requiresHeightWeight = true;
                break;
              }
              // Check bundle included products
              if (product.isBundle && product.includedProducts) {
                for (const includedProduct of product.includedProducts) {
                  if (includedProduct.productQuestionnaires?.enabled && includedProduct.productQuestionnaires?.requiresHeightWeight) {
                    requiresHeightWeight = true;
                    break;
                  }
                }
              }
              if (requiresHeightWeight) break;
            }
            if (requiresHeightWeight) break;
          }
          console.log(`🔍 Height/Weight Requirement Check: ${requiresHeightWeight ? 'Height/Weight required' : 'Height/Weight not required'} for this enrollment`);
        } else {
          console.log('⚠️ No products array found in LinkMetaData');
        }
      } catch (parseError) {
        console.warn('⚠️ Warning: Could not parse LinkMetaData:', parseError.message);
        console.warn('⚠️ Raw LinkMetaData:', enrollmentLink.LinkMetaData);
      }
    }

    // Get dependents (members with different relationship types) - skip for Agent-Static
    let dependentsResult = { recordset: [] };
    
    if (enrollmentLink.LinkType !== 'Agent-Static' && enrollmentLink.LinkType !== 'Marketing' && enrollmentLink.GroupId && member && member.HouseholdId) {
    const dependentsQuery = `
      SELECT 
        m.MemberId,
        m.UserId,
        m.GroupId,
        m.Status,
        m.DateOfBirth,
        m.Gender,
        m.Address,
        m.City,
        m.State,
        m.Zip,
        m.SSN,
        m.RelationshipType,
        m.CreatedDate,
        m.ModifiedDate,
        u.FirstName,
        u.LastName,
        u.Email AS UserEmail,
        u.PhoneNumber
      FROM oe.Members m
      LEFT JOIN oe.Users u ON m.UserId = u.UserId
      WHERE m.HouseholdId = @householdId 
        AND m.Status = 'Active'
        AND m.RelationshipType IN ('S', 'C')
        AND m.MemberId != @primaryMemberId
    `;
    
    const dependentsRequest = pool.request();
    dependentsRequest.input('householdId', sql.UniqueIdentifier, member.HouseholdId);
    dependentsRequest.input('primaryMemberId', sql.UniqueIdentifier, member.MemberId);
    
      dependentsResult = await dependentsRequest.query(dependentsQuery);
      console.log(`✅ Found ${dependentsResult.recordset.length} dependents for household ${member.HouseholdId}`);
    } else {
      if (!member || !member.HouseholdId) {
        console.log('🔍 DEBUG: Skipping dependents query (no member or HouseholdId)');
      } else {
        console.log(`🔍 DEBUG: Skipping dependents query (${enrollmentLink.LinkType} or no GroupId)`);
      }
    }

    // Fetch payment settings for processing fee calculation (PUBLIC - no auth required)
    let paymentProcessorSettings = null;
    let systemFeesSettings = null;
    
    if (enrollmentLink.TenantId) {
      try {
        const tenantSettingsQuery = `
          SELECT PaymentProcessorSettings, SystemFees
          FROM oe.Tenants 
          WHERE TenantId = @tenantId
        `;
        
        const tenantSettingsRequest = pool.request();
        tenantSettingsRequest.input('tenantId', sql.UniqueIdentifier, enrollmentLink.TenantId);
        const tenantSettingsResult = await tenantSettingsRequest.query(tenantSettingsQuery);
        
        if (tenantSettingsResult.recordset.length > 0) {
          if (tenantSettingsResult.recordset[0].PaymentProcessorSettings) {
            try {
              paymentProcessorSettings = JSON.parse(tenantSettingsResult.recordset[0].PaymentProcessorSettings);
            } catch (e) {
              console.warn('⚠️ Failed to parse PaymentProcessorSettings:', e);
            }
          }
          
          if (tenantSettingsResult.recordset[0].SystemFees) {
            try {
              systemFeesSettings = JSON.parse(tenantSettingsResult.recordset[0].SystemFees);
            } catch (e) {
              console.warn('⚠️ Failed to parse SystemFees:', e);
            }
          }
          
          console.log('✅ DEBUG: Payment settings loaded for enrollment-data:', {
            hasPaymentProcessorSettings: !!paymentProcessorSettings,
            hasSystemFeesSettings: !!systemFeesSettings
          });
        }
      } catch (error) {
        console.warn('⚠️ Failed to fetch payment settings for enrollment-data:', error);
      }
    }

    // Prepare the simplified response structure
    const enrollmentData = {
      status: 'valid',
      enrollmentLink: {
        linkId: enrollmentLink.LinkId,
        groupId: enrollmentLink.GroupId,
        linkToken: enrollmentLink.LinkToken,
        linkType: enrollmentLink.LinkType, // Add LinkType to response
        description: enrollmentLink.Description,
        expiresAt: enrollmentLink.ExpiresAt,
        usageCount: enrollmentLink.UsageCount,
        maxUsage: enrollmentLink.MaxUsage,
        templateName: enrollmentLink.TemplateName,
        templateType: enrollmentLink.TemplateType,
        agentId: enrollmentLink.AgentId,
        agencyId: enrollmentLink.AgencyId,
        agentName: enrollmentLink.AgentName,
        agentEmail: enrollmentLink.AgentEmail,
        agentPhone: enrollmentLink.AgentPhone,
        agencyName: enrollmentLink.AgencyName
      },
      group: {
        groupId: enrollmentLink.GroupId,
        groupName: enrollmentLink.GroupName,
        tenantId: enrollmentLink.TenantId,
        groupLogoUrl: enrollmentLink.GroupLogoUrl,
        showEmployeePricingOnTiles: !!enrollmentLink.ShowEmployeePricingOnTiles,
        showContributionStrategy: !!enrollmentLink.ShowContributionStrategy
      },
      tenant: {
        tenantId: enrollmentLink.TenantId,
        tenantName: enrollmentLink.TenantName,
        tenantLogoUrl: enrollmentLink.TenantLogoUrl,
        mobileAppEnabled: enrollmentLink.MobileAppEnabled === 'true',
        appStoreUrl: enrollmentLink.AppStoreUrl || null,
        playStoreUrl: enrollmentLink.PlayStoreUrl || null,
        appImageUrl: enrollmentLink.AppImageUrl || null,
        // Default ON when unset. We'd rather vault the card and let DIME recurring charge on the
        // effective date than hit the member with an immediate charge that can decline and leave
        // behind an orphaned account. Tenants opt out by explicitly setting the flag to false.
        chargeFirstPaymentWithRecurring: paymentProcessorSettings?.chargeFirstPaymentWithRecurring !== false
      },
      paymentSettings: {
        paymentProcessorSettings,
        systemFeesSettings
      },
      requiresSSN: requiresSSN || false, // Flag indicating if any product requires SSN
      requiresHeightWeight: requiresHeightWeight || false, // Flag indicating if any product requires height/weight
      primaryMember: member ? {
        MemberId: member.MemberId,           // ✅ PascalCase to match interface
        UserId: member.UserId,               // ✅ PascalCase to match interface
        GroupId: member.GroupId,             // ✅ PascalCase to match interface
        Status: member.Status,               // ✅ PascalCase to match interface
        FirstName: member.FirstName,         // ✅ Get from Users table
        LastName: member.LastName,           // ✅ Get from Users table
        PhoneNumber: member.PhoneNumber,     // ✅ Get from Users table
        DateOfBirth: member.DateOfBirth,     // ✅ PascalCase to match interface
        Gender: member.Gender,               // ✅ PascalCase to match interface
        Address: member.Address,             // ✅ PascalCase to match interface
        City: member.City,                   // ✅ PascalCase to match interface
        State: member.State,                 // ✅ PascalCase to match interface
        Zip: member.Zip,                     // ✅ PascalCase to match interface
        SSN: decryptSSN(member.SSN),         // ✅ Decrypt SSN before returning
        MedicalInfo: member.MedicalInfo,     // ✅ PascalCase to match interface
        EnrollmentType: member.EnrollmentType, // ✅ PascalCase to match interface
        RelationshipType: member.RelationshipType, // ✅ PascalCase to match interface
        TenantId: member.TenantId,           // ✅ PascalCase to match interface
        AgentId: member.AgentId,             // ✅ PascalCase to match interface
        TobaccoUse: member.TobaccoUse,       // ✅ PascalCase to match interface
        Tier: member.Tier,                   // ✅ PascalCase to match interface
        JobPosition: member.JobPosition,     // ✅ PascalCase to match interface
        Height: member.Height || null,       // ✅ Height in inches
        Weight: member.Weight || null,       // ✅ Weight in pounds
        CreatedDate: member.CreatedDate,     // ✅ PascalCase to match interface
        ModifiedDate: member.ModifiedDate,   // ✅ PascalCase to match interface
        Email: member.UserEmail              // ✅ Map UserEmail to Email (PascalCase)
      } : null, // Return null for Agent-Static/Marketing links (no pre-existing member)
      productSections: productSections,
      dependents: dependentsResult.recordset.map(dependent => ({
        MemberId: dependent.MemberId,
        UserId: dependent.UserId,
        GroupId: dependent.GroupId,
        Status: dependent.Status,
        FirstName: dependent.FirstName,
        LastName: dependent.LastName,
        Email: dependent.UserEmail,
        PhoneNumber: dependent.PhoneNumber,
        DateOfBirth: dependent.DateOfBirth,
        Gender: dependent.Gender,
        Address: dependent.Address,
        City: dependent.City,
        State: dependent.State,
        Zip: dependent.Zip,
        SSN: decryptSSN(dependent.SSN),  // ✅ Decrypt SSN before returning
        RelationshipType: dependent.RelationshipType,
        CreatedDate: dependent.CreatedDate,
        ModifiedDate: dependent.ModifiedDate
      })),
      template: {
        templateId: enrollmentLink.EnrollmentLinkTemplateId,
        templateName: enrollmentLink.TemplateName,
        templateType: enrollmentLink.TemplateType,
        linkMetaData: enrollmentLink.LinkMetaData ? JSON.parse(enrollmentLink.LinkMetaData) : null
      }
    };

    console.log(`✅ Enrollment data retrieved for link: ${linkToken}`);
    const linkTypeLabel = enrollmentLink.LinkType === 'Marketing' ? 'Marketing' : enrollmentLink.LinkType === 'Agent-Static' ? 'Agent-Static' : 'Standard';
    console.log(`📊 Found ${enrollmentData.primaryMember ? 'primary member' : `${linkTypeLabel} (no member)`}, ${enrollmentData.productSections.length} product sections, ${enrollmentData.dependents.length} dependents`);
    
    // Debug: Log the actual response data being sent
    console.log('🔍 DEBUG: Response data being sent:', {
      primaryMember: enrollmentData.primaryMember ? {
        memberId: enrollmentData.primaryMember.MemberId,
        userEmail: enrollmentData.primaryMember.Email,
        relationshipType: enrollmentData.primaryMember.RelationshipType
      } : null,
      dependentsCount: enrollmentData.dependents.length,
      dependentsData: enrollmentData.dependents
    });
    
    // Debug: Log the complete enrollmentData object structure
    console.log('🔍 DEBUG: Complete enrollmentData object:', JSON.stringify(enrollmentData, null, 2));
    
    // Debug: Log what we're actually sending in the response
    console.log('🔍 DEBUG: About to send response with data:', {
      hasPrimaryMember: !!enrollmentData.primaryMember,
      primaryMemberKeys: enrollmentData.primaryMember ? Object.keys(enrollmentData.primaryMember) : 'NO PRIMARY MEMBER',
      hasMembers: !!enrollmentData.members,
      membersLength: enrollmentData.members ? enrollmentData.members.length : 'NO MEMBERS ARRAY',
      responseKeys: Object.keys(enrollmentData)
    });

    // Tenant logo URL no longer requires authentication (images are now public)
    if (enrollmentData.tenant && enrollmentData.tenant.tenantLogoUrl) {
      console.log('🖼️ Returning tenant logo URL (no authentication needed):', enrollmentData.tenant.tenantLogoUrl);
    }

    res.json({
      success: true,
      data: enrollmentData,
      message: 'Enrollment data retrieved successfully'
    });
    
  } catch (error) {
    console.error('❌ Error fetching enrollment data:', error);
    console.error('❌ Error stack:', error.stack);
    console.error('❌ Error message:', error.message);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching enrollment data',
      error: error.message
    });
  }
});

// POST /api/enrollment-links/:linkToken/ask-agent-question - Send question to agent
router.post('/:linkToken/ask-agent-question', async (req, res) => {
  try {
    const { linkToken } = req.params;
    const { question, memberInfo } = req.body;

    if (!linkToken) {
      return res.status(400).json({
        success: false,
        message: 'Link token is required'
      });
    }

    if (!question || !question.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Question is required'
      });
    }

    const pool = await getPool();
    
    // Get enrollment link and agent info
    const linkQuery = `
      SELECT 
        el.LinkToken,
        el.AgentId,
        el.GroupId,
        el.MemberId,
        g.Name AS GroupName,
        -- TenantId logic: Group > Member > Agent (for Agent-Static links)
        CASE 
          WHEN el.GroupId IS NOT NULL THEN g.TenantId 
          WHEN el.MemberId IS NOT NULL THEN m.TenantId
          WHEN el.AgentId IS NOT NULL THEN a.TenantId
          ELSE NULL
        END AS TenantId,
        u_agent.Email AS AgentEmail,
        u_agent.PhoneNumber AS AgentPhone,
        u_agent.FirstName + ' ' + u_agent.LastName AS AgentName,
        -- TenantName logic: Group > Member > Agent
        CASE 
          WHEN el.GroupId IS NOT NULL THEN t_group.Name 
          WHEN el.MemberId IS NOT NULL THEN t_member.Name
          WHEN el.AgentId IS NOT NULL THEN t_agent.Name
          ELSE NULL
        END AS TenantName
      FROM oe.EnrollmentLinks el
      LEFT JOIN oe.Groups g ON el.GroupId = g.GroupId
      LEFT JOIN oe.Members m ON el.MemberId = m.MemberId
      LEFT JOIN oe.Agents a ON el.AgentId = a.AgentId
      LEFT JOIN oe.Users u_agent ON a.UserId = u_agent.UserId
      LEFT JOIN oe.Tenants t_group ON g.TenantId = t_group.TenantId
      LEFT JOIN oe.Tenants t_member ON m.TenantId = t_member.TenantId
      LEFT JOIN oe.Tenants t_agent ON a.TenantId = t_agent.TenantId
      WHERE el.LinkToken = @linkToken
        AND el.IsActive = 1
    `;

    const linkRequest = pool.request();
    linkRequest.input('linkToken', sql.NVarChar, linkToken);
    const linkResult = await linkRequest.query(linkQuery);

    if (linkResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Enrollment link not found'
      });
    }

    const enrollmentLink = linkResult.recordset[0];

    if (!enrollmentLink.AgentId || !enrollmentLink.AgentEmail) {
      return res.status(400).json({
        success: false,
        message: 'Agent information not available for this enrollment link'
      });
    }

    // Prepare member info - require name
    if (!memberInfo?.firstName || !memberInfo?.lastName) {
      return res.status(400).json({
        success: false,
        message: 'First name and last name are required to send a question'
      });
    }

    const memberName = `${memberInfo.firstName} ${memberInfo.lastName}`;
    const memberEmail = memberInfo?.email || '';
    const memberPhone = memberInfo?.phone || '';

    // Require at least one contact method
    if (!memberEmail && !memberPhone) {
      return res.status(400).json({
        success: false,
        message: 'Email or phone number is required so the agent can respond'
      });
    }

    // Create email content
    const emailHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>New Question from Enrollee</title>
      </head>
      <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
          <h2 style="color: #1f6db0; margin-top: 0;">New Question from Enrollee</h2>
          <p style="margin: 0;">You have received a new question from someone enrolling through your enrollment link.</p>
        </div>
        
        <div style="background-color: #ffffff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin-bottom: 20px;">
          <h3 style="color: #333; margin-top: 0;">Question:</h3>
          <p style="background-color: #f8f9fa; padding: 15px; border-radius: 4px; white-space: pre-wrap;">${question.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>
        </div>
        
        <div style="background-color: #ffffff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px;">
          <h3 style="color: #333; margin-top: 0;">Contact Information:</h3>
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="padding: 8px 0; font-weight: bold; width: 120px;">Name:</td>
              <td style="padding: 8px 0;">${memberName}</td>
            </tr>
            ${enrollmentLink.GroupName ? `
            <tr>
              <td style="padding: 8px 0; font-weight: bold;">Group:</td>
              <td style="padding: 8px 0;">${enrollmentLink.GroupName}</td>
            </tr>
            ` : ''}
            ${memberEmail ? `
            <tr>
              <td style="padding: 8px 0; font-weight: bold;">Email:</td>
              <td style="padding: 8px 0;"><a href="mailto:${memberEmail}" style="color: #1f6db0;">${memberEmail}</a></td>
            </tr>
            ` : ''}
            ${memberPhone ? `
            <tr>
              <td style="padding: 8px 0; font-weight: bold;">Phone:</td>
              <td style="padding: 8px 0;"><a href="tel:${memberPhone}" style="color: #1f6db0;">${memberPhone}</a></td>
            </tr>
            ` : ''}
          </table>
        </div>
        
        <div style="margin-top: 20px; padding-top: 20px; border-top: 1px solid #e0e0e0; color: #666; font-size: 12px;">
          <p>This message was sent from the enrollment system. Please reply directly to ${memberEmail || 'the enrollee'} using the email address above.</p>
        </div>
      </body>
      </html>
    `;

    let emailText = `New Question from Enrollee

Question:
${question}

Contact Information:
Name: ${memberName}`;

    if (enrollmentLink.GroupName) {
      emailText += `\nGroup: ${enrollmentLink.GroupName}`;
    }
    if (memberEmail) {
      emailText += `\nEmail: ${memberEmail}`;
    }
    if (memberPhone) {
      emailText += `\nPhone: ${memberPhone}`;
    }

    emailText += `\n\nPlease reply directly to ${memberEmail || 'the enrollee'} using the contact information above.`;

    // Queue email to agent
    await MessageQueueService.queueEmail({
      tenantId: enrollmentLink.TenantId,
      toEmail: enrollmentLink.AgentEmail,
      toName: enrollmentLink.AgentName,
      subject: `New Question from Enrollee - ${memberName}`,
      htmlContent: emailHtml,
      textContent: emailText,
      messageType: 'Email',
      createdBy: null,
      recipientId: null
    });

    // Queue SMS to agent if phone number is available
    if (enrollmentLink.AgentPhone) {
      let smsContent = `New question from ${memberName}`;
      if (enrollmentLink.GroupName) {
        smsContent += `\nGroup: ${enrollmentLink.GroupName}`;
      }
      if (memberEmail) {
        smsContent += `\nEmail: ${memberEmail}`;
      }
      if (memberPhone) {
        smsContent += `\nPhone: ${memberPhone}`;
      }
      smsContent += `\n\nQuestion: ${question.substring(0, 150)}${question.length > 150 ? '...' : ''}`;
      
      await MessageQueueService.queueMessage({
        tenantId: enrollmentLink.TenantId,
        messageType: 'SMS',
        recipientAddress: enrollmentLink.AgentPhone,
        subject: null,
        messageBody: smsContent,
        status: 'Pending',
        createdBy: null,
        recipientId: null
      });
    }

    console.log(`✅ Question queued to agent ${enrollmentLink.AgentEmail} from ${memberEmail}`);

    return res.json({
      success: true,
      message: 'Your question has been sent successfully'
    });

  } catch (error) {
    console.error('❌ Error sending question to agent:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send question',
      error: error.message
    });
  }
});

// POST /api/enrollment-links/:linkToken/setup-password - Setup password for enrollment
// SECURITY MODEL:
// 1. Only users who have completed enrollment can set up password
// 2. Password can only be set once per account (no password changes)
// 3. Link token must be valid and not expired (handles time-based security)
// 4. Users with existing passwords must use proper password reset flow
// 5. Enrollment link is only marked as "used" after password setup (prevents abandonment)
router.post('/:linkToken/setup-password', async (req, res) => {
  try {
    const { linkToken } = req.params;
    const { email, password, memberId, smsConsent } = req.body;
    
    if (!linkToken || !email || !password || !memberId) {
      return res.status(400).json({
        success: false,
        message: 'Link token, email, password, and member ID are required'
      });
    }

    // Validate password strength (HIPAA compliant)
    const passwordRequirements = require('../constants/password-requirements');
    const passwordRegex = passwordRequirements.getPasswordRegex();
    if (!passwordRegex.test(password)) {
      return res.status(400).json({
        success: false,
        message: passwordRequirements.getPasswordErrorMessage()
      });
    }

    const pool = await getPool();
    
    // First, verify the enrollment link is valid
    const linkQuery = `
      SELECT 
        el.LinkId,
        el.GroupId,
        el.IsActive,
        el.ExpiresAt,
        el.UsageCount,
        el.MaxUsage
      FROM oe.EnrollmentLinks el
      WHERE el.LinkToken = @linkToken
    `;
    
    const linkRequest = pool.request();
    linkRequest.input('linkToken', sql.NVarChar, linkToken);
    
    const linkResult = await linkRequest.query(linkQuery);
    
    if (linkResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Enrollment link not found'
      });
    }
    
    const enrollmentLink = linkResult.recordset[0];
    
    // Check if link is active
    if (!enrollmentLink.IsActive) {
      return res.status(400).json({
        success: false,
        message: 'Enrollment link is inactive'
      });
    }
    
    // Check if link has expired
    if (enrollmentLink.ExpiresAt && new Date(enrollmentLink.ExpiresAt) < new Date()) {
      return res.status(400).json({
        success: false,
        message: 'Enrollment link has expired'
      });
    }
    
    // Note: We don't check usage limits here because setup-password is part of the enrollment process
    // Usage limits are only checked and enforced during the initial enrollment data fetch
    // This allows users to complete their enrollment even after the initial data fetch

    // SECURITY: Verify that enrollment has been completed for this member
    // This prevents unauthorized password setup by someone who just has the link token
    // For Agent-Static/Marketing links, enrollments start as 'Pending Payment' and become 'Active' after password setup
    const enrollmentCheckQuery = `
      SELECT COUNT(*) as enrollmentCount
      FROM oe.Enrollments e
      WHERE e.MemberId = @memberId 
        AND e.Status IN ('Active', 'Pending Payment')
    `;
    
    const enrollmentCheckRequest = pool.request();
    enrollmentCheckRequest.input('memberId', sql.UniqueIdentifier, memberId);
    
    const enrollmentCheckResult = await enrollmentCheckRequest.query(enrollmentCheckQuery);
    const hasEnrollment = enrollmentCheckResult.recordset[0].enrollmentCount > 0;
    
    if (!hasEnrollment) {
      console.log(`🚨 SECURITY: Password setup blocked - No enrollment found for member: ${memberId}`);
      return res.status(403).json({
        success: false,
        message: 'Enrollment must be completed before setting up password. Please complete your enrollment first.'
      });
    }

    // Verify the member exists and belongs to the group (for group enrollments) or is valid (for individual enrollments)
    let memberQuery;
    let memberRequest = pool.request();
    memberRequest.input('memberId', sql.UniqueIdentifier, memberId);
    
    if (enrollmentLink.GroupId) {
      // Group enrollment - member must belong to the group
      memberQuery = `
        SELECT 
          m.MemberId,
          m.UserId,
          m.Status,
          m.GroupId
        FROM oe.Members m
        WHERE m.MemberId = @memberId 
          AND m.GroupId = @groupId 
          AND m.Status IN ('Active', 'Pending Payment')
      `;
      memberRequest.input('groupId', sql.UniqueIdentifier, enrollmentLink.GroupId);
    } else {
      // Individual enrollment - accept Active or Pending Payment status
      // Pending Payment is used for Agent-Static/Marketing links before password setup
      memberQuery = `
        SELECT 
          m.MemberId,
          m.UserId,
          m.Status,
          m.GroupId
        FROM oe.Members m
        WHERE m.MemberId = @memberId 
          AND m.Status IN ('Active', 'Pending Payment')
      `;
    }
    
    const memberResult = await memberRequest.query(memberQuery);
    
    if (memberResult.recordset.length === 0) {
      const errorMessage = enrollmentLink.GroupId 
        ? 'Member not found or does not belong to this group'
        : 'Member not found or is not active';
      return res.status(404).json({
        success: false,
        message: errorMessage
      });
    }
    
    const member = memberResult.recordset[0];
    
    // Check if user already exists and get password status
    let userId = member.UserId;
    let isNewUser = false;
    let isExistingUserWithPassword = false;
    
    if (!userId) {
      // No UserId on member - create new user account
      const crypto = require('crypto');
      
      // Generate new user ID
      userId = crypto.randomUUID();
      
      // Hash password with bcryptjs (HIPAA compliant)
      const saltRounds = 12; // Industry standard for HIPAA
      const passwordHash = await bcrypt.hash(password, saltRounds);
      
      // Create user account (no UserType/Roles fields)
      const createUserQuery = `
        INSERT INTO oe.Users (UserId, Email, PasswordHash, Status, IsActive, CreatedDate, ModifiedDate)
        VALUES (@userId, @email, @passwordHash, 'Active', 1, GETDATE(), GETDATE())
      `;
      
      const createUserRequest = pool.request();
      createUserRequest.input('userId', sql.UniqueIdentifier, userId);
      createUserRequest.input('email', sql.NVarChar, email);
      createUserRequest.input('passwordHash', sql.NVarChar, passwordHash);
      
      await createUserRequest.query(createUserQuery);
      
      // Assign Member role using UserRolesService
      await UserRolesService.assignRoleToUser(userId, 'Member', null);
      
      // Update member with new user ID
      const updateMemberQuery = `
        UPDATE oe.Members 
        SET UserId = @userId, ModifiedDate = GETDATE()
        WHERE MemberId = @memberId
      `;
      
      const updateMemberRequest = pool.request();
      updateMemberRequest.input('userId', sql.UniqueIdentifier, userId);
      updateMemberRequest.input('memberId', sql.UniqueIdentifier, memberId);
      
      await updateMemberRequest.query(updateMemberQuery);
      
      isNewUser = true;
      
      console.log(`✅ Created new user account for member: ${memberId}`);
    } else {
      // UserId exists - check if they already have a password
      
      const getUserQuery = `
        SELECT UserId, PasswordHash, FirstName, LastName, Email
        FROM oe.Users
        WHERE UserId = @userId
      `;
      
      const getUserRequest = pool.request();
      getUserRequest.input('userId', sql.UniqueIdentifier, userId);
      const getUserResult = await getUserRequest.query(getUserQuery);
      
      if (getUserResult.recordset.length === 0) {
        // User doesn't exist - shouldn't happen but handle gracefully
        return res.status(404).json({
          success: false,
          message: 'User account not found'
        });
      }
      
      const existingUser = getUserResult.recordset[0];
      
      // USER ALREADY HAS PASSWORD - Validate it (like login)
      if (existingUser.PasswordHash) {
        console.log(`🔐 Existing user with password detected: ${email} - Validating password`);
        
        // Validate the provided password against existing hash
        const isPasswordValid = await bcrypt.compare(password, existingUser.PasswordHash);
        
        if (!isPasswordValid) {
          console.log(`❌ Invalid password attempt for existing user: ${email}`);
          return res.status(401).json({
            success: false,
            message: 'Invalid password. Please enter your existing account password.',
            code: 'INVALID_PASSWORD'
          });
        }
        
        console.log(`✅ Password validated for existing user: ${email}`);
        isExistingUserWithPassword = true;
        
        // Password is valid - ensure Member role is assigned
        await UserRolesService.assignRoleToUser(userId, 'Member', null);
        console.log(`✅ Member role assigned to existing user: ${userId}`);
        
      } else {
        // USER EXISTS BUT NO PASSWORD - Set password (first-time setup)
        console.log(`🔑 Existing user without password detected: ${email} - Setting password`);
        
        const saltRounds = 12;
        const passwordHash = await bcrypt.hash(password, saltRounds);
        
        // Update user password and activate account
        const updateUserQuery = `
          UPDATE oe.Users 
          SET PasswordHash = @passwordHash, Status = 'Active', ModifiedDate = GETDATE()
          WHERE UserId = @userId
        `;
        
        const updateUserRequest = pool.request();
        updateUserRequest.input('passwordHash', sql.NVarChar, passwordHash);
        updateUserRequest.input('userId', sql.UniqueIdentifier, userId);
        
        await updateUserRequest.query(updateUserQuery);
        
        // Assign Member role using UserRolesService
        await UserRolesService.assignRoleToUser(userId, 'Member', null);
        
        console.log(`✅ Password set for existing user: ${memberId}`);
      }
    }

    // SECURITY: Now increment usage count since enrollment is fully complete
    // This marks the enrollment link as "used" only after password setup
    const updateUsageQuery = `
      UPDATE oe.EnrollmentLinks 
      SET UsageCount = UsageCount + 1, ModifiedDate = GETUTCDATE()
      WHERE LinkToken = @linkToken
    `;
    
    const updateUsageRequest = pool.request();
    updateUsageRequest.input('linkToken', sql.NVarChar, linkToken);
    
    await updateUsageRequest.query(updateUsageQuery);
    
    console.log(`📈 Usage count incremented for enrollment link: ${linkToken}`);

    // Generate JWT token for immediate authentication
    const jwt = require('jsonwebtoken');
    const jwtSecret = process.env.JWT_SECRET || 'your-secret-key'; // Use environment variable in production
    
    // Get all user roles for JWT token
    const userRoles = await UserRolesService.getUserRoleNames(userId);
    
    const token = jwt.sign(
      { 
        userId: userId, 
        email: email, 
        roles: userRoles, // Include all roles (may have Agent, TenantAdmin, etc.)
        currentRole: 'Member' // Default to Member for enrollment flow
      },
      jwtSecret,
      { expiresIn: '24h' }
    );

    console.log(`✅ Password setup completed for enrollment link: ${linkToken}`);
    console.log(`📊 User ${isNewUser ? 'created' : (isExistingUserWithPassword ? 'validated' : 'updated')}: ${email}`);
    console.log(`🎭 User roles: ${userRoles.join(', ')}`);

    // Persist final-step SMS consent from password setup (source of truth for enrollment flow opt-in).
    if (typeof smsConsent === 'boolean') {
      await pool.request()
        .input('memberId', sql.UniqueIdentifier, memberId)
        .input('smsConsent', sql.Bit, smsConsent ? 1 : 0)
        .query(`
          UPDATE oe.Members
          SET SmsConsent = @smsConsent,
              ModifiedDate = GETUTCDATE()
          WHERE MemberId = @memberId
        `);
      console.log(`✅ SMS consent updated during setup-password for member ${memberId}: ${smsConsent}`);
    }

    res.json({
      success: true,
      data: {
        userId: userId,
        email: email,
        memberId: memberId,
        token: token,
        isNewUser: isNewUser,
        isExistingUser: isExistingUserWithPassword,
        roles: userRoles,
        message: isNewUser 
          ? 'User account created and password set successfully' 
          : isExistingUserWithPassword 
            ? 'Password confirmed - Member access added to your account'
            : 'Password updated successfully'
      },
      message: 'Password setup completed successfully'
    });
    
  } catch (error) {
    console.error('❌ Error setting up password:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while setting up password'
    });
  }
});

// GET /api/enrollment-links/:linkToken/enrollment-status - Check enrollment and password setup status
router.get('/:linkToken/enrollment-status', async (req, res) => {
  try {
    const { linkToken } = req.params;
    console.log(`🔍 DEBUG: Checking enrollment status for link: ${linkToken}`);
    
    const pool = await getPool();
    
    // 1. Validate enrollment link
    const linkQuery = `
      SELECT 
        LinkId, 
        GroupId, 
        MemberId,
        IsActive, 
        UsageCount, 
        MaxUsage, 
        ExpiresAt,
        CASE 
          WHEN LinkType IS NOT NULL THEN LinkType
          WHEN GroupId IS NOT NULL THEN 'Group'
          ELSE 'Member'
        END AS LinkType
      FROM oe.EnrollmentLinks 
      WHERE LinkToken = @linkToken
    `;
    
    const linkRequest = pool.request();
    linkRequest.input('linkToken', sql.NVarChar, linkToken);
    const linkResult = await linkRequest.query(linkQuery);
    
    console.log(`🔍 DEBUG: Link query result:`, linkResult.recordset);
    
    if (linkResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Enrollment link not found'
      });
    }
    
    const enrollmentLink = linkResult.recordset[0];
    
    // Check if link is active
    if (!enrollmentLink.IsActive) {
      return res.status(400).json({
        success: false,
        message: 'Enrollment link is not active'
      });
    }
    
    // Check if link has expired (skip if ExpiresAt is null - never expires)
    if (enrollmentLink.ExpiresAt) {
    const now = new Date();
    const expiresAt = new Date(enrollmentLink.ExpiresAt);
    if (now > expiresAt) {
      return res.status(400).json({
        success: false,
        message: 'Enrollment link has expired'
      });
      }
    }
    
    console.log(`🔍 DEBUG: Link validation passed, LinkType: ${enrollmentLink.LinkType}`);
    
    // For Agent-Static/Marketing links, skip member lookup and return minimal status
    if (enrollmentLink.LinkType === 'Agent-Static' || enrollmentLink.LinkType === 'Marketing') {
      console.log(`🔍 DEBUG: ${enrollmentLink.LinkType} link - skipping member lookup, returning minimal status`);
      return res.json({
        success: true,
        data: {
          hasExistingPassword: false,
          selectedProducts: [],
          acknowledgementsStatus: {
            hasAcknowledgements: false
          },
          paymentStatus: {
            hasPayment: false
          },
          isCompleted: false,
          passwordSetupCompleted: false
        }
      });
    }
    
    // 3. Get the primary member from the enrollment link
    // Check if this is a group enrollment or individual enrollment
    const isGroupEnrollment = enrollmentLink.GroupId && typeof enrollmentLink.GroupId === 'string' && enrollmentLink.GroupId.length === 36 && !enrollmentLink.MemberId;
    console.log(`🔍 DEBUG: Is group enrollment: ${isGroupEnrollment}, GroupId: ${enrollmentLink.GroupId}`);
    
    let memberQuery, memberRequest, memberResult, primaryMember;
    
    try {
      if (isGroupEnrollment) {
        // Group enrollment: get primary member from group
        memberQuery = `
          SELECT m.MemberId, u.FirstName, u.LastName, u.Email
          FROM oe.Members m
          INNER JOIN oe.Users u ON m.UserId = u.UserId
          INNER JOIN oe.EnrollmentLinks el ON m.GroupId = el.GroupId
          WHERE el.LinkToken = @linkToken
          AND m.RelationshipType = 'P'
        `;
        
        memberRequest = pool.request();
        memberRequest.input('linkToken', sql.NVarChar, linkToken);
        console.log(`🔍 DEBUG: Executing group member query`);
        memberResult = await memberRequest.query(memberQuery);
        console.log(`🔍 DEBUG: Group member query result:`, memberResult.recordset);
      } else {
        // Individual enrollment: get member directly from enrollment link
        memberQuery = `
          SELECT m.MemberId, u.FirstName, u.LastName, u.Email
          FROM oe.Members m
          INNER JOIN oe.Users u ON m.UserId = u.UserId
          INNER JOIN oe.EnrollmentLinks el ON m.MemberId = el.MemberId
          WHERE el.LinkToken = @linkToken
        `;
        
        memberRequest = pool.request();
        memberRequest.input('linkToken', sql.NVarChar, linkToken);
        console.log(`🔍 DEBUG: Executing individual member query`);
        memberResult = await memberRequest.query(memberQuery);
        console.log(`🔍 DEBUG: Individual member query result:`, memberResult.recordset);
      }
      
      if (memberResult.recordset.length === 0) {
        console.log(`❌ DEBUG: No member found for enrollment link`);
        return res.status(404).json({
          success: false,
          message: 'No member found for this enrollment link'
        });
      }
      
      primaryMember = memberResult.recordset[0];
      console.log(`🔍 DEBUG: Primary member found:`, primaryMember);
      
    } catch (memberError) {
      console.error('❌ Member query failed:', memberError);
      return res.status(500).json({
        success: false,
        message: 'Failed to retrieve member information',
        error: {
          message: memberError.message,
          code: memberError.code || 'MEMBER_QUERY_ERROR'
        }
      });
    }
    
    // 4. Check if member has ACTIVE or FUTURE enrollments (date-based; allows re-enrollment after termination)
    // We use date-based logic (Effective + Termination) to determine completion,
    // rather than just `Status`, so that members whose enrollment naturally
    // expires (TerminationDate in the past) can re-enroll without showing
    // "completed" forever.
    //
    // BUT we DO exclude Status='Cancelled' rows. A cancelled enrollment is a
    // deliberate override (e.g. by the type-change wizard's reEnroll branch),
    // and the member should be treated as NOT enrolled regardless of what the
    // date columns say. Without this filter, the wizard's reEnroll cancel
    // (Status='Cancelled', dates untouched) would leave members locked on the
    // "Enrollment Completed" screen the next time they hit their link.
    let hasActiveOrFutureEnrollment = false;
    try {
      const activeOrFutureEnrollmentsQuery = `
        SELECT
          CASE WHEN EXISTS (
            SELECT 1
            FROM oe.Enrollments e
            WHERE e.MemberId = @memberId
              AND e.Status <> 'Cancelled'
              AND (
                -- Active today (in-force)
                (e.EffectiveDate IS NOT NULL AND e.EffectiveDate <= GETUTCDATE() AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE()))
                OR
                -- Future effective (scheduled)
                -- IMPORTANT: If TerminationDate is before EffectiveDate, this enrollment is canceled and should NOT count as future enrollment.
                (e.EffectiveDate IS NOT NULL AND e.EffectiveDate > GETUTCDATE() AND (e.TerminationDate IS NULL OR e.TerminationDate > e.EffectiveDate))
                OR
                -- Defensive: missing effective date but still not terminated (treat as active)
                (e.EffectiveDate IS NULL AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE()))
              )
          ) THEN 1 ELSE 0 END AS HasActiveOrFutureEnrollment
      `;
      
      const activeEnrollmentsRequest = pool.request();
      activeEnrollmentsRequest.input('memberId', sql.UniqueIdentifier, primaryMember.MemberId);
      const activeEnrollmentsResult = await activeEnrollmentsRequest.query(activeOrFutureEnrollmentsQuery);
      
      hasActiveOrFutureEnrollment = activeEnrollmentsResult.recordset?.[0]?.HasActiveOrFutureEnrollment === 1;
      
      console.log(`🔍 DEBUG: Active/Future enrollment check - HasActiveOrFutureEnrollment: ${hasActiveOrFutureEnrollment}`);
      console.log(`🔍 DEBUG: Enrollment link usage - UsageCount: ${enrollmentLink.UsageCount}, MaxUsage: ${enrollmentLink.MaxUsage || 'N/A'}`);
      
    } catch (enrollmentError) {
      console.error('❌ Enrollment check failed:', enrollmentError);
      return res.status(500).json({
        success: false,
        message: 'Failed to check enrollment status',
        error: {
          message: enrollmentError.message,
          code: enrollmentError.code || 'ENROLLMENT_CHECK_ERROR'
        }
      });
    }
    
    // 5. Check if password is set up (for UI purposes only - not used for completion logic)
    let hasPassword = false;
    let hasExistingPassword = false; // NEW: Differentiate between "has password" and "existing user with password"
    try {
      // First, let's check if the member has a UserId
      const memberUserQuery = `
        SELECT m.UserId, u.PasswordHash
        FROM oe.Members m
        LEFT JOIN oe.Users u ON m.UserId = u.UserId
        WHERE m.MemberId = @memberId
      `;
      
      const memberUserRequest = pool.request();
      memberUserRequest.input('memberId', sql.UniqueIdentifier, primaryMember.MemberId);
      const memberUserResult = await memberUserRequest.query(memberUserQuery);
      
      console.log(`🔍 DEBUG: Member-User relationship:`, memberUserResult.recordset[0]);
      
      if (memberUserResult.recordset.length > 0) {
        const memberUser = memberUserResult.recordset[0];
        hasPassword = memberUser.PasswordHash && memberUser.PasswordHash !== '';
        
        // NEW: Check if this is an existing user (has UserId AND PasswordHash)
        // This indicates they already have an account (Agent, TenantAdmin, etc.)
        hasExistingPassword = !!memberUser.UserId && hasPassword;
        
        console.log(`🔍 DEBUG: Member has UserId: ${!!memberUser.UserId}, PasswordHash exists: ${!!memberUser.PasswordHash}`);
        console.log(`🔍 DEBUG: Has existing password (existing user): ${hasExistingPassword}`);
      } else {
        console.log(`🔍 DEBUG: No member-user relationship found for member: ${primaryMember.MemberId}`);
      }
      
      console.log(`🔍 DEBUG: Has password: ${hasPassword}, Has existing password: ${hasExistingPassword}`);
      
    } catch (passwordError) {
      console.error('❌ Password check failed:', passwordError);
      // Don't fail the request for password check errors - just log and continue
      hasPassword = false;
      hasExistingPassword = false;
    }
    
    // 6. Check payment status for individual enrollments (recent only; prevents old payments from blocking re-enrollment)
    let paymentStatus = null;
    if (!enrollmentLink.GroupId) { // Individual enrollment
      console.log(`🔍 DEBUG: Checking payment status for individual enrollment`);
      
      if (!hasActiveOrFutureEnrollment) {
        paymentStatus = {
          hasPayment: false,
          status: null,
          paymentDate: null,
          amount: null,
          transactionId: null
        };
        console.log(`🔍 DEBUG: No active/future enrollments - treating payment as not present for re-enrollment`);
      } else {
        const paymentQuery = `
          SELECT TOP 1 p.PaymentId, p.Status, p.PaymentDate, p.Amount, p.ProcessorTransactionId
          FROM oe.Payments p
          INNER JOIN oe.Members m ON p.HouseholdId = m.HouseholdId
          WHERE m.MemberId = @memberId
            AND p.PaymentDate >= DATEADD(day, -1, GETUTCDATE()) -- Within last 24 hours (retry-safe)
          ORDER BY p.PaymentDate DESC
        `;
        
        const paymentRequest = pool.request();
        paymentRequest.input('memberId', sql.UniqueIdentifier, primaryMember.MemberId);
        const paymentResult = await paymentRequest.query(paymentQuery);
        
        if (paymentResult.recordset.length > 0) {
          const latestPayment = paymentResult.recordset[0];
          paymentStatus = {
            hasPayment: true,
            status: latestPayment.Status,
            paymentDate: latestPayment.PaymentDate,
            amount: latestPayment.Amount,
            transactionId: latestPayment.ProcessorTransactionId
          };
          console.log(`🔍 DEBUG: Recent payment found - Status: ${latestPayment.Status}, Date: ${latestPayment.PaymentDate}`);
        } else {
          paymentStatus = {
            hasPayment: false,
            status: null,
            paymentDate: null,
            amount: null,
            transactionId: null
          };
          console.log(`🔍 DEBUG: No recent payment found for individual enrollment`);
        }
      }
    }
    
    // 7. Return the status (enrollment completion based only on enrollment records)
    // 6. Check acknowledgements status (NEW)
    let acknowledgementsStatus = null;
    try {
      if (!hasActiveOrFutureEnrollment) {
        acknowledgementsStatus = {
          hasAcknowledgements: false,
          count: 0
        };
        console.log(`🔍 DEBUG: No active/future enrollments - treating acknowledgements as not present for re-enrollment`);
      } else {
      const acknowledgementsQuery = `
        SELECT COUNT(*) as AcknowledgementCount
        FROM oe.EnrollmentAcknowledgements
        WHERE LinkToken = @linkToken
          AND SignedDate >= DATEADD(day, -1, GETUTCDATE()) -- Within last 24 hours (retry-safe)
      `;
      
      const acknowledgementsRequest = pool.request();
      acknowledgementsRequest.input('linkToken', sql.NVarChar, linkToken);
      const acknowledgementsResult = await acknowledgementsRequest.query(acknowledgementsQuery);
      
      const acknowledgementCount = acknowledgementsResult.recordset[0].AcknowledgementCount;
      acknowledgementsStatus = {
        hasAcknowledgements: acknowledgementCount > 0,
        count: acknowledgementCount
      };
      
      console.log(`🔍 DEBUG: Acknowledgements check - Count: ${acknowledgementCount}, Has acknowledgements: ${acknowledgementsStatus.hasAcknowledgements}`);
      }
      
    } catch (acknowledgementsError) {
      console.error('❌ Acknowledgements check failed:', acknowledgementsError);
      acknowledgementsStatus = {
        hasAcknowledgements: false,
        count: 0,
        error: acknowledgementsError.message
      };
    }
    
    // 7. Get selected products (NEW) - only active/future (date-based)
    let selectedProducts = [];
    try {
      if (!hasActiveOrFutureEnrollment) {
        selectedProducts = [];
        console.log(`🔍 DEBUG: No active/future enrollments - Selected products cleared for re-enrollment`);
      } else {
        // Mirrors the hasActiveOrFutureEnrollment filter above — Cancelled rows
        // are excluded so a member who was reset by the type-change wizard
        // doesn't see their cancelled selections re-populated.
        const selectedProductsQuery = `
          SELECT e.ProductId, p.Name as ProductName, e.PremiumAmount, e.Status, e.EffectiveDate, e.TerminationDate
          FROM oe.Enrollments e
          JOIN oe.Products p ON e.ProductId = p.ProductId
          WHERE e.MemberId = @memberId
            AND e.Status <> 'Cancelled'
            AND (
              (e.EffectiveDate IS NOT NULL AND e.EffectiveDate <= GETUTCDATE() AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE()))
              OR
              (e.EffectiveDate IS NOT NULL AND e.EffectiveDate > GETUTCDATE() AND (e.TerminationDate IS NULL OR e.TerminationDate > e.EffectiveDate))
              OR
              (e.EffectiveDate IS NULL AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE()))
            )
          ORDER BY e.EffectiveDate DESC, e.CreatedDate DESC
        `;
        
        const selectedProductsRequest = pool.request();
        selectedProductsRequest.input('memberId', sql.UniqueIdentifier, primaryMember.MemberId);
        const selectedProductsResult = await selectedProductsRequest.query(selectedProductsQuery);
        
        selectedProducts = selectedProductsResult.recordset.map(product => ({
          productId: product.ProductId,
          productName: product.ProductName,
          premiumAmount: product.PremiumAmount,
          status: product.Status
        }));
        
        console.log(`🔍 DEBUG: Selected products (active/future) - Count: ${selectedProducts.length}`);
      }
      
    } catch (selectedProductsError) {
      console.error('❌ Selected products check failed:', selectedProductsError);
      selectedProducts = [];
    }

    console.log(`🔍 DEBUG: Final status - Active/Future Enrollment: ${hasActiveOrFutureEnrollment}, Password: ${hasPassword}, Payment (recent): ${paymentStatus?.hasPayment || 'N/A'}, Acknowledgements (recent): ${acknowledgementsStatus?.hasAcknowledgements || 'N/A'}`);
    
    res.json({
      success: true,
      data: {
        isCompleted: hasActiveOrFutureEnrollment,  // Date-based active/future enrollment determines completion (allows re-enroll after termination)
        passwordSetupCompleted: hasPassword,  // For UI purposes only
        hasExistingPassword: hasExistingPassword,  // NEW: User has existing account with password
        paymentStatus: paymentStatus,  // Payment status for individual enrollments
        acknowledgementsStatus: acknowledgementsStatus,  // Acknowledgements status
        selectedProducts: selectedProducts,  // Selected products
        memberId: primaryMember.MemberId,
        memberName: `${primaryMember.FirstName} ${primaryMember.LastName}`,
        memberEmail: primaryMember.Email,
        linkActive: enrollmentLink.IsActive,
        linkExpired: enrollmentLink.ExpiresAt ? new Date() > new Date(enrollmentLink.ExpiresAt) : false,
        usageCount: enrollmentLink.UsageCount,
        maxUsage: enrollmentLink.MaxUsage
      }
    });
    
  } catch (error) {
    console.error('❌ Error checking enrollment status:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while checking enrollment status',
      error: {
        message: error.message,
        code: error.code || 'UNKNOWN_ERROR'
      }
    });
  }
});

// GET /api/enrollment-links/:linkToken/tenant-redirect - Get tenant redirection information
router.get('/:linkToken/tenant-redirect', async (req, res) => {
  const pool = await getPool();
  try {
    const { linkToken } = req.params;
    
    console.log('🔍 Getting tenant redirect info for link:', linkToken);
    
    // Get enrollment link and tenant information
    // Handle group, member, and agent-static/marketing enrollment links by getting tenant info from group, member, or agent
    const enrollmentLinkQuery = `
      SELECT 
        el.LinkId,
        el.GroupId,
        el.MemberId,
        el.AgentId,
        el.LinkType,
        CASE 
          WHEN el.GroupId IS NOT NULL THEN g.TenantId 
          WHEN el.MemberId IS NOT NULL THEN m.TenantId
          WHEN el.AgentId IS NOT NULL THEN a.TenantId
          ELSE NULL
        END AS TenantId,
        CASE 
          WHEN el.GroupId IS NOT NULL THEN t_group.Name 
          WHEN el.MemberId IS NOT NULL THEN t_member.Name
          WHEN el.AgentId IS NOT NULL THEN t_agent.Name
          ELSE NULL
        END AS TenantName,
        CASE 
          WHEN el.GroupId IS NOT NULL THEN t_group.CustomDomain 
          WHEN el.MemberId IS NOT NULL THEN t_member.CustomDomain
          WHEN el.AgentId IS NOT NULL THEN t_agent.CustomDomain
          ELSE NULL
        END AS CustomDomain,
        CASE 
          WHEN el.GroupId IS NOT NULL THEN t_group.DefaultUrlPath 
          WHEN el.MemberId IS NOT NULL THEN t_member.DefaultUrlPath
          WHEN el.AgentId IS NOT NULL THEN t_agent.DefaultUrlPath
          ELSE NULL
        END AS DefaultUrlPath,
        CASE 
          WHEN el.GroupId IS NOT NULL THEN t_group.IsDefaultUrlPathVerified 
          WHEN el.MemberId IS NOT NULL THEN t_member.IsDefaultUrlPathVerified
          WHEN el.AgentId IS NOT NULL THEN t_agent.IsDefaultUrlPathVerified
          ELSE NULL
        END AS IsDefaultUrlPathVerified
      FROM oe.EnrollmentLinks el
      LEFT JOIN oe.Groups g ON el.GroupId = g.GroupId
      LEFT JOIN oe.Members m ON el.MemberId = m.MemberId
      LEFT JOIN oe.Agents a ON el.AgentId = a.AgentId
      LEFT JOIN oe.Tenants t_group ON g.TenantId = t_group.TenantId
      LEFT JOIN oe.Tenants t_member ON m.TenantId = t_member.TenantId
      LEFT JOIN oe.Tenants t_agent ON a.TenantId = t_agent.TenantId
      WHERE el.LinkToken = @linkToken
        AND el.IsActive = 1
        AND (
          (el.GroupId IS NOT NULL AND t_group.Status = 'Active') OR
          (el.MemberId IS NOT NULL AND t_member.Status IN ('Active', 'Terminated')) OR  -- Allow terminated members for re-enrollment
          (el.AgentId IS NOT NULL AND (el.LinkType = 'Agent-Static' OR el.LinkType = 'Marketing') AND t_agent.Status = 'Active')
        )
`;
    
    const request = pool.request();
    request.input('linkToken', sql.NVarChar, linkToken);
    
    const result = await request.query(enrollmentLinkQuery);
    
    if (result.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Enrollment link not found or inactive'
      });
    }
    
    const tenantInfo = result.recordset[0];
    
    // Determine redirect URL based on priority:
    // 1. CustomDomain (if available and working)
    // 2. DefaultUrlPath (if verified)
    // 3. Default to /login
    
    let redirectUrl = '/login'; // Default fallback
    let redirectType = 'default';
    
    if (tenantInfo.CustomDomain && tenantInfo.CustomDomain.trim() !== '') {
      // Use custom domain
      redirectUrl = `https://${tenantInfo.CustomDomain}/login`;
      redirectType = 'custom_domain';
    } else if (tenantInfo.DefaultUrlPath && tenantInfo.IsDefaultUrlPathVerified) {
      // Use default URL path
      redirectUrl = `https://app.allaboard365.com/${tenantInfo.DefaultUrlPath}/login`;
      redirectType = 'default_url_path';
    }
    
    console.log('✅ Tenant redirect info:', {
      tenantName: tenantInfo.TenantName,
      customDomain: tenantInfo.CustomDomain,
      defaultUrlPath: tenantInfo.DefaultUrlPath,
      redirectUrl: redirectUrl,
      redirectType: redirectType
    });
    
    res.json({
      success: true,
      data: {
        tenantName: tenantInfo.TenantName,
        customDomain: tenantInfo.CustomDomain,
        defaultUrlPath: tenantInfo.DefaultUrlPath,
        redirectUrl: redirectUrl,
        redirectType: redirectType
      }
    });
    
  } catch (error) {
    console.error('❌ Error getting tenant redirect info:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get tenant redirect information',
      error: error.message
    });
  }
});


// POST /api/enrollment-links/:linkToken/validate-pricing - Test pricing validation only (no payment, no DB changes). For localhost/dev use.
router.post('/:linkToken/validate-pricing', async (req, res) => {
  try {
    const { linkToken } = req.params;
    const {
      memberId,
      memberInfo,
      memberTier,
      selectedProducts,
      selectedConfigs,
      frontendPricing,
      householdMembers,
      dependents,
      effectiveDate
    } = req.body;

    if (!linkToken || !selectedProducts?.length) {
      return res.status(400).json({
        success: false,
        message: 'linkToken and selectedProducts are required'
      });
    }

    const hasFrontendPricingComparison = Array.isArray(frontendPricing) && frontendPricing.length > 0;
    const pool = await getPool();
    const makeRequest = () => pool.request();

    // 1. Load enrollment link
    const linkQuery = `
      SELECT el.LinkId, el.LinkToken, el.GroupId, el.MemberId, el.AgentId, el.AgencyId, el.IsActive, el.ExpiresAt, el.UsageCount, el.MaxUsage,
        CASE WHEN el.LinkType IS NOT NULL THEN el.LinkType WHEN el.GroupId IS NOT NULL THEN 'Group' ELSE 'Member' END AS LinkType,
        CASE WHEN el.GroupId IS NOT NULL THEN g.TenantId WHEN el.MemberId IS NOT NULL THEN m.TenantId WHEN el.AgentId IS NOT NULL THEN a.TenantId ELSE NULL END AS TenantId
      FROM oe.EnrollmentLinks el
      LEFT JOIN oe.Groups g ON el.GroupId = g.GroupId
      LEFT JOIN oe.Members m ON el.MemberId = m.MemberId
      LEFT JOIN oe.Agents a ON el.AgentId = a.AgentId
      WHERE el.LinkToken = @linkToken
    `;
    const linkReq = makeRequest();
    linkReq.input('linkToken', sql.NVarChar, linkToken);
    const linkResult = await linkReq.query(linkQuery);
    if (linkResult.recordset.length === 0) {
      return res.status(404).json({ success: false, message: 'Enrollment link not found' });
    }
    const enrollmentLink = linkResult.recordset[0];

    // 2. Build allHouseholdMembers for pricing (primary + dependents)
    let allHouseholdMembers = [];
    if (memberId && typeof memberId === 'string' && memberId.length > 0) {
      const memberReq = makeRequest();
      memberReq.input('memberId', sql.UniqueIdentifier, memberId);
      const memberRes = await memberReq.query(`
        SELECT m.MemberId, m.DateOfBirth, m.TobaccoUse, m.Tier, m.RelationshipType, u.FirstName, u.LastName
        FROM oe.Members m
        LEFT JOIN oe.Users u ON m.UserId = u.UserId
        WHERE m.MemberId = @memberId
      `);
      if (memberRes.recordset.length > 0) {
        const m = memberRes.recordset[0];
        m.RelationshipType = m.RelationshipType || 'P';
        allHouseholdMembers.push(m);
      }
    }
    if (allHouseholdMembers.length === 0) {
      const primary = {
        MemberId: crypto.randomUUID(),
        DateOfBirth: memberInfo?.dateOfBirth || null,
        TobaccoUse: (memberInfo?.tobaccoUse === 'Yes' || memberInfo?.tobaccoUse === true) ? 'Y' : 'N',
        Tier: memberTier || 'EE',
        RelationshipType: 'P',
        FirstName: memberInfo?.firstName || 'Primary',
        LastName: memberInfo?.lastName || 'Member'
      };
      allHouseholdMembers.push(primary);
    }
    const depList = dependents || householdMembers || [];
    if (Array.isArray(depList)) {
      for (const d of depList) {
        allHouseholdMembers.push({
          MemberId: crypto.randomUUID(),
          DateOfBirth: d.dateOfBirth || null,
          RelationshipType: (d.relationship === 'Spouse' || d.relationshipType === 'S') ? 'S' : 'C',
          FirstName: d.firstName || '',
          LastName: d.lastName || ''
        });
      }
    }
    if (allHouseholdMembers.length === 0) {
      return res.status(400).json({ success: false, message: 'No primary member data (memberId or memberInfo required)' });
    }

    const uniqueProductIds = [...new Set(selectedProducts)];
    const calculateIncludedProcessingFeeForDisplay = includedProcessingFeeUtil.calculateIncludedProcessingFeeForDisplay;
    let paymentProcessorSettingsForValidation = null;
    try {
      const tsReq = makeRequest();
      tsReq.input('tenantId', sql.UniqueIdentifier, enrollmentLink.TenantId);
      const tsRes = await tsReq.query('SELECT PaymentProcessorSettings FROM oe.Tenants WHERE TenantId = @tenantId');
      const raw = tsRes.recordset?.[0]?.PaymentProcessorSettings;
      if (raw) {
        try {
          paymentProcessorSettingsForValidation = JSON.parse(raw);
        } catch (e) {
          console.warn('⚠️ Failed to parse PaymentProcessorSettings for pricing validation:', e);
        }
      }
    } catch (e) {
      console.warn('⚠️ Failed to load PaymentProcessorSettings for pricing validation:', e);
    }

    const subscriptionFeeSettingsByProductIdForValidation = new Map();
    const getSubscriptionFeeCfgForValidation = async (pid) => {
      const key = String(pid);
      if (subscriptionFeeSettingsByProductIdForValidation.has(key)) {
        return subscriptionFeeSettingsByProductIdForValidation.get(key);
      }
      const r = { includeProcessingFee: false, roundUpProcessingFee: false };
      try {
        const req2 = makeRequest();
        req2.input('tenantId', sql.UniqueIdentifier, enrollmentLink.TenantId);
        req2.input('productId', sql.UniqueIdentifier, pid);
        const rs = await req2.query(`
          SELECT TOP 1 IncludeProcessingFee, RoundUpProcessingFee
          FROM oe.TenantProductSubscriptions
          WHERE TenantId = @tenantId AND ProductId = @productId AND SubscriptionStatus IN ('Active', 'Approved')
          ORDER BY CASE WHEN SubscriptionStatus = 'Active' THEN 0 ELSE 1 END
        `);
        if (rs.recordset?.length > 0) {
          const row = rs.recordset[0];
          r.includeProcessingFee = row.IncludeProcessingFee === true || row.IncludeProcessingFee === 1;
          r.roundUpProcessingFee = row.RoundUpProcessingFee === true || row.RoundUpProcessingFee === 1;
        }
      } catch (e) {
        console.warn('⚠️ Failed to load TenantProductSubscriptions fee flags:', { productId: pid, err: e?.message || e });
      }
      subscriptionFeeSettingsByProductIdForValidation.set(key, r);
      return r;
    };

    const validationResults = [];

    for (const productId of uniqueProductIds) {
      const productReq = makeRequest();
      productReq.input('productId', sql.UniqueIdentifier, productId);
      const productResult = await productReq.query(`
        SELECT ProductId, Name, VendorProductID, IsBundle
        FROM oe.Products
        WHERE ProductId = @productId
      `);
      if (productResult.recordset.length === 0) {
        validationResults.push({ productId, productName: 'Unknown', passed: false, reason: 'Product not found' });
        continue;
      }
      const product = productResult.recordset[0];
      const primaryMember = allHouseholdMembers.find(m => m.RelationshipType === 'P');
      let householdPremium = 0;
      let pricingResult = null;

      if (!primaryMember) {
        validationResults.push({ productId, productName: product.Name, passed: false, reason: 'No primary member' });
        continue;
      }

      try {
        const hasSpouse = allHouseholdMembers.some(m => m.RelationshipType === 'S');
        const childrenCount = allHouseholdMembers.filter(m => m.RelationshipType === 'C').length;
        const derivedTierFromHousehold = hasSpouse && childrenCount > 0
          ? 'EF'
          : hasSpouse
            ? 'ES'
            : childrenCount > 0
              ? 'EC'
              : 'EE';
        const memberCriteria = {
          age: getMemberAgeForPricing(primaryMember.DateOfBirth, 30),
          tobaccoUse: primaryMember.TobaccoUse === 'Y' ? 'Yes' : 'No',
          // IMPORTANT: derive tier from submitted household shape for validation paths (especially static links)
          tier: memberTier || derivedTierFromHousehold || primaryMember.Tier || 'EE',
          hasSpouse,
          childrenCount,
          householdSize: allHouseholdMembers.length
        };
        let productConfigValue = selectedConfigs?.[productId] ?? null;
        if (!productConfigValue && hasFrontendPricingComparison && frontendPricing) {
          const fp = frontendPricing.find(p => p && String(p.productId) === String(productId));
          if (fp && (fp.selectedConfig || fp.selectedConfig === 0)) productConfigValue = String(fp.selectedConfig);
        }
        const configValues = productConfigValue ? { configValue1: productConfigValue } : {};

        if (product.IsBundle) {
          const bundleSelections = [{ productId, configValues }];
          const bundleResults = await PricingEngine.calculatePricing({
            calculationType: 'enrollment',
            memberCriteria,
            productSelections: bundleSelections,
            effectiveDate: effectiveDate || null
          });
          pricingResult = bundleResults.products[0];
          if (pricingResult?.includedProducts && configValues.configValue1) {
            for (const includedProduct of pricingResult.includedProducts) {
              if (includedProduct.hasConfigurationFields && includedProduct.availableConfigs?.includes(configValues.configValue1)) {
                const mv = includedProduct.pricingVariations?.find(v => v.configValue === configValues.configValue1);
                if (mv) {
                  includedProduct.monthlyPremium = mv.monthlyPremium;
                  includedProduct.basePremium = mv.basePremium;
                  includedProduct.employeeContribution = mv.employeeContribution;
                }
              }
            }
            pricingResult.monthlyPremium = pricingResult.includedProducts.reduce((sum, p) => sum + p.monthlyPremium, 0);
            pricingResult.employeeContribution = pricingResult.monthlyPremium;
          }
        } else {
          pricingResult = await PricingEngine.calculateProductPricing(productId, memberCriteria, configValues, effectiveDate || null);
        }

        householdPremium = pricingResult?.monthlyPremium || 0;
        const frontendProduct =
          hasFrontendPricingComparison && Array.isArray(frontendPricing)
            ? frontendPricing.find(
              fp => fp && String(fp.productId).toLowerCase() === String(productId).toLowerCase()
            )
            : null;

        const backendBaseAmount = householdPremium;
        // Match /product-pricing display semantics: pricingAuthority + MSRPRate retail only.
        // Do not add deprecated TenantProductSubscriptions.IncludeProcessingFee on top of engine MSRP
        // (GetWell Dental EE: $40.72 display vs $42.00 when subscription include baked +$1.28).
        const includedProcessingFeeForDisplay = 0;
        const backendAmount = Math.round(Number(backendBaseAmount || 0) * 100) / 100;

        if (!hasFrontendPricingComparison || !frontendProduct) {
          validationResults.push({
            productId,
            productName: product.Name,
            passed: true,
            mode: !hasFrontendPricingComparison ? 'backend-only' : 'missing-frontend-product-row',
            frontendAmount: null,
            backendAmount,
            backendBaseAmount,
            includedProcessingFeeForDisplay,
            ...(hasFrontendPricingComparison && !frontendProduct
              ? { reason: 'No frontend pricing row for this product; backend snapshot only' }
              : {})
          });
          continue;
        }

        const frontendAmount = frontendProduct.monthlyPremium || 0;
        const difference = Math.abs(Number(frontendAmount) - Number(backendAmount));
        const tolerance = 0.01;
        const passed = difference <= tolerance;

        validationResults.push({
          productId,
          productName: product.Name,
          passed,
          mode: 'compare',
          frontendAmount,
          backendAmount,
          backendBaseAmount,
          includedProcessingFeeForDisplay,
          difference,
          tolerance,
          withinTolerance: passed,
          selectedConfig: frontendProduct.selectedConfig
        });
      } catch (pricingError) {
        console.error('❌ Error calculating pricing for validate-pricing:', pricingError);
        validationResults.push({ productId, productName: product.Name, passed: false, reason: String(pricingError?.message || pricingError) });
      }
    }

    const allPassed = validationResults.every(r => r.passed);
    return res.json({
      success: allPassed,
      message: allPassed ? 'Pricing validation passed for all products' : 'Pricing validation failed for one or more products',
      validationResults
    });
  } catch (err) {
    console.error('❌ validate-pricing error:', err);
    return res.status(500).json({
      success: false,
      message: 'Pricing validation request failed',
      error: err?.message || String(err)
    });
  }
});


// POST /api/enrollment-links/:linkToken/complete-enrollment - Complete enrollment and create all records
router.post('/:linkToken/complete-enrollment', async (req, res) => {
  console.log('🔍 DEBUG: Complete enrollment route hit for linkToken:', req.params.linkToken);
  console.log('🔍 DEBUG: Request method:', req.method);
  console.log('🔍 DEBUG: Request URL:', req.url);
  console.log('🔍 DEBUG: Request body type:', typeof req.body);
  console.log('🔍 DEBUG: Request body keys:', Object.keys(req.body || {}));
  
  try {
    const { linkToken } = req.params;
    const { 
      memberId, 
      memberInfo, 
      memberTier,
      selectedProducts, 
      selectedConfigs, // Add selected configurations
      frontendPricing, // NEW: Add frontend-calculated pricing for validation
      pricingFingerprint, // Pricing Authority fingerprint (preferred). When present, skips per-product legacy validator.
      // Snapshot of the memberCriteria + paymentMethodType the wizard sent to /contribution-preview.
      // The fingerprint was generated from these exact inputs, so verify against the same ones —
      // recomputing them from DB state can drift (e.g. stored DOB → age 0, group PM lookup races).
      pricingContext,
      householdMembers,
      effectiveDate,
      dependents,
      // NEW: Add agreements data
      acknowledgements,
      digitalSignature,
      // NEW: Add payment method data
      paymentMethod,
      skipPaymentProcessing: requestedSkipPaymentProcessing,
      smsConsent,
      ipAddress,
      userAgent,
      // NEW: Product questionnaire responses
      questionnaireResponses,
      // Per-vendor ID card network selections from the wizard. Only applied for
      // INDIVIDUAL members (no GroupId). Group members inherit the group's selection.
      // Shape: [{ vendorId, vendorNetworkId }] OR { [vendorId]: vendorNetworkId }.
      networkSelections,
      submitForensics
    } = req.body;

    if (memberInfo?.address != null && String(memberInfo.address).trim() !== '') {
      const { sanitizeMemberInfoAddress } = require('../utils/memberDataValidation');
      const addressResult = sanitizeMemberInfoAddress(memberInfo);
      if (addressResult.error) {
        return res.status(400).json({
          success: false,
          message: `${addressResult.error.field}: ${addressResult.error.reason}`,
        });
      }
      Object.assign(memberInfo, addressResult.memberInfo);
    }

    const requestOrigin = String(req.headers.origin || '');
    const isLocalOrigin = requestOrigin.startsWith('http://localhost') || requestOrigin.startsWith('http://127.0.0.1');
    const skipPaymentProcessing = requestedSkipPaymentProcessing === true && (isLocalOrigin || process.env.NODE_ENV !== 'production');

    console.log('🔍 DEBUG: Complete enrollment request body paymentMethod:', JSON.stringify(paymentMethod, null, 2));
    console.log('🔍 DEBUG: Full request body keys:', Object.keys(req.body));
    console.log('🔍 DEBUG: Request body has paymentMethod:', 'paymentMethod' in req.body);
    console.log('🔍 DEBUG: skipPaymentProcessing:', {
      requested: requestedSkipPaymentProcessing === true,
      effective: skipPaymentProcessing,
      requestOrigin
    });
    console.log('🔍 DEBUG: Effective date from request body:', effectiveDate);
    if (submitForensics && typeof submitForensics === 'object') {
      console.log('📋 submitForensics received:', {
        capturedAt: submitForensics.capturedAt,
        pricingSource: submitForensics.pricingSource,
        calculatedAmount: submitForensics?.submitDerived?.calculatedAmount,
        selectionSignatureHash: submitForensics?.reproducibility?.selectionSignatureHash
      });
    }
    
    // Extract member email and name for password setup email
    const memberEmail = memberInfo?.email || paymentMethod?.email || null;
    const memberFirstName = memberInfo?.firstName || null;
    
    if (!linkToken) {
      return res.status(400).json({
        success: false,
        message: 'Link token is required'
      });
    }

    // Strict DOB: reject bad/ambiguous dates before any pricing or DB work.
    // Product-pricing uses age from the wizard; complete-enrollment uses member row — static/marketing reuse could leave stale DB DOB unless we validate + sync (see below).
    if (memberInfo && (memberInfo.firstName || memberInfo.lastName || memberInfo.email)) {
      const d = validateDateOfBirthInput(memberInfo.dateOfBirth, { required: true, fieldLabel: 'Date of birth' });
      if (!d.ok) {
        return res.status(400).json({
          success: false,
          message: d.message,
          error: {
            code: /required/i.test(d.message) ? 'MISSING_DATE_OF_BIRTH' : 'INVALID_DATE_OF_BIRTH'
          }
        });
      }
      memberInfo.dateOfBirth = d.iso;
    }
    if (Array.isArray(dependents)) {
      for (let i = 0; i < dependents.length; i++) {
        const dep = dependents[i];
        if (dep?.dateOfBirth != null && String(dep.dateOfBirth).trim() !== '') {
          const d = validateDateOfBirthInput(dep.dateOfBirth, { fieldLabel: `Dependent ${i + 1} date of birth` });
          if (!d.ok) {
            return res.status(400).json({
              success: false,
              message: d.message,
              error: { code: 'INVALID_DATE_OF_BIRTH' }
            });
          }
          dep.dateOfBirth = d.iso;
        }
      }
    }

    // 🛡️ Dependent completeness + tier/count consistency guard.
    // Prior behavior silently skipped any dependent missing a required field (see ~line 4888),
    // and allowed tier=EC/ES/EF to submit with zero/blank dependents. That combination
    // let agents charge EC pricing while saving ZERO child rows (see 2026-04-21 Lenar-Cummins).
    // Fail loudly here so the UI shows a clear error instead of "success" with missing kids.
    {
      const depSource = (Array.isArray(dependents) && dependents.length > 0)
        ? dependents
        : (Array.isArray(householdMembers) ? householdMembers : []);

      const requiredDepFields = ['firstName', 'lastName', 'dateOfBirth', 'relationship'];
      const incompleteDeps = depSource
        .map((dep, idx) => {
          const missing = requiredDepFields.filter((k) => {
            const v = dep?.[k];
            return v == null || String(v).trim() === '';
          });
          return { index: idx, dep, missing };
        })
        .filter((x) => x.missing.length > 0);

      if (incompleteDeps.length > 0) {
        console.error('🚨 [complete-enrollment] Rejecting incomplete dependents', {
          linkToken,
          memberId: memberId || null,
          memberTier: memberTier || null,
          incompleteCount: incompleteDeps.length,
          totalSubmitted: depSource.length,
          details: incompleteDeps.map((x) => ({
            index: x.index,
            missingFields: x.missing,
            firstName: x.dep?.firstName || '',
            lastName: x.dep?.lastName || '',
            relationship: x.dep?.relationship || x.dep?.relationshipType || ''
          }))
        });
        return res.status(400).json({
          success: false,
          message: `One or more dependents are missing required information (${incompleteDeps.map((x) => `dependent ${x.index + 1}: ${x.missing.join(', ')}`).join('; ')}). Please go back and fill in every dependent before submitting.`,
          error: {
            code: 'INCOMPLETE_DEPENDENT',
            details: incompleteDeps.map((x) => ({ index: x.index, missingFields: x.missing }))
          }
        });
      }

      // Tier must be consistent with supplied dependents so we never charge EC/ES/EF pricing
      // while writing zero dependent rows.
      const spouseCount = depSource.filter((d) =>
        d?.relationship === 'Spouse' || d?.relationshipType === 'S'
      ).length;
      const childCount = depSource.filter((d) =>
        d?.relationship === 'Child' || d?.relationshipType === 'C'
      ).length;
      const tierNorm = typeof memberTier === 'string' ? memberTier.toUpperCase() : '';
      const tierRequiresSpouse = tierNorm === 'ES' || tierNorm === 'EF';
      const tierRequiresChild = tierNorm === 'EC' || tierNorm === 'EF';

      if (tierRequiresSpouse && spouseCount < 1) {
        console.error('🚨 [complete-enrollment] Tier/dependent mismatch: spouse required but none submitted', {
          linkToken, memberId, memberTier: tierNorm, spouseCount, childCount, submittedDependents: depSource.length
        });
        return res.status(400).json({
          success: false,
          message: `Tier ${tierNorm} requires a spouse but none was submitted. Please add the spouse before submitting.`,
          error: { code: 'TIER_DEPENDENT_MISMATCH', details: { tier: tierNorm, spouseCount, childCount } }
        });
      }
      if (tierRequiresChild && childCount < 1) {
        console.error('🚨 [complete-enrollment] Tier/dependent mismatch: child required but none submitted', {
          linkToken, memberId, memberTier: tierNorm, spouseCount, childCount, submittedDependents: depSource.length
        });
        return res.status(400).json({
          success: false,
          message: `Tier ${tierNorm} requires at least one child but none was submitted. Please add the child(ren) before submitting.`,
          error: { code: 'TIER_DEPENDENT_MISMATCH', details: { tier: tierNorm, spouseCount, childCount } }
        });
      }
    }

      console.log('🚨🚨🚨 UPDATED CODE IS RUNNING 🚨🚨🚨');
      console.log('🔍 DEBUG: Complete enrollment request:', {
        linkToken,
        memberId: memberId || 'UNDEFINED',
        selectedProducts: selectedProducts?.length || 0,
        selectedProductsData: selectedProducts,
        selectedConfigs: selectedConfigs ? Object.keys(selectedConfigs).length : 0,
        selectedConfigsData: selectedConfigs,
        frontendPricing: frontendPricing?.length || 0,
        frontendPricingData: frontendPricing,
        householdMembers: householdMembers?.length || 0,
        householdMembersData: householdMembers,
        hasAcknowledgements: !!acknowledgements,
        hasDigitalSignature: !!digitalSignature,
        hasPaymentMethod: !!paymentMethod,
        paymentMethodData: paymentMethod
      });
      
      console.log('🔍 DEBUG: Request body keys:', Object.keys(req.body));
      console.log('🔍 DEBUG: memberId from request body:', req.body.memberId);
      console.log('🔍 DEBUG: memberId type:', typeof req.body.memberId);
      
      console.log('🔍 DEBUG: Raw request body keys:', Object.keys(req.body));
      console.log('🔍 DEBUG: Raw request body selectedConfigs:', req.body.selectedConfigs);
      console.log('🔍 DEBUG: Raw request body frontendPricing:', req.body.frontendPricing);

    const pool = await getPool();

    // Charge-first for individual enrollment (existing member): charge before transaction so we can refund if commit fails
    let chargeFirstResult = null;
    const linkQueryPre = `
      SELECT el.LinkId, el.LinkToken, el.GroupId, el.MemberId, el.AgentId, el.AgencyId, el.IsActive, el.ExpiresAt, el.UsageCount, el.MaxUsage,
        CASE WHEN el.LinkType IS NOT NULL THEN el.LinkType WHEN el.GroupId IS NOT NULL THEN 'Group' ELSE 'Member' END AS LinkType,
        CASE WHEN el.GroupId IS NOT NULL THEN g.TenantId WHEN el.MemberId IS NOT NULL THEN m.TenantId WHEN el.AgentId IS NOT NULL THEN a.TenantId ELSE NULL END AS TenantId
      FROM oe.EnrollmentLinks el
      LEFT JOIN oe.Groups g ON el.GroupId = g.GroupId
      LEFT JOIN oe.Members m ON el.MemberId = m.MemberId
      LEFT JOIN oe.Agents a ON el.AgentId = a.AgentId
      WHERE el.LinkToken = @linkToken
    `;
    const linkRequestPre = pool.request();
    linkRequestPre.input('linkToken', sql.NVarChar, linkToken);
    const linkResultPre = await linkRequestPre.query(linkQueryPre);
    if (linkResultPre.recordset.length > 0) {
      const linkRow = linkResultPre.recordset[0];
      const selectedProductsForEligibility = Array.isArray(selectedProducts) ? selectedProducts : [];
      if (selectedProductsForEligibility.length > 0) {
        const resolvedMemberState = await resolveEnrollmentMemberState({
          pool,
          linkMemberId: linkRow.MemberId,
          requestMemberId: memberId,
          memberInfo
        });
        const eligibilityValidation = await validateSelectedProductsStateEligibility({
          pool,
          selectedProducts: selectedProductsForEligibility,
          memberState: resolvedMemberState
        });
        if (!eligibilityValidation.normalizedMemberState) {
          return res.status(400).json({
            success: false,
            message: 'Member state is required before selecting products.',
            error: {
              code: 'MEMBER_STATE_REQUIRED',
              details: 'Unable to validate product state eligibility without a 2-letter member state.'
            }
          });
        }
        if (!eligibilityValidation.isValid) {
          return res.status(400).json({
            success: false,
            message: 'One or more selected products are not available in your state.',
            error: {
              code: 'PRODUCT_STATE_NOT_AVAILABLE',
              details: {
                memberState: eligibilityValidation.normalizedMemberState,
                disallowedProducts: eligibilityValidation.disallowedProducts.map((p) => ({
                  productId: p.productId,
                  productName: p.productName,
                  isBundleComponent: p.isBundleComponent,
                  allowedStates: p.allowedStates
                }))
              }
            }
          });
        }
      }
      const isGroupLink = linkRow.GroupId && String(linkRow.GroupId).length === 36;
      const hasExistingMember = linkRow.MemberId || memberId;
      if (!isGroupLink && paymentMethod && !skipPaymentProcessing && hasExistingMember && selectedProducts?.length > 0 && frontendPricing?.length > 0) {
        const totalPremiumFromFrontend = frontendPricing.reduce((s, p) => s + (Number(p.monthlyPremium) || 0), 0);
        const tenantIdPre = linkRow.TenantId;
        if (tenantIdPre && totalPremiumFromFrontend > 0) {
          preChargeBlock: try {
            // Canonical fee composition via PricingEngine + pricingAuthority (single source of truth).
            //
            // The legacy path here built `basePremiumByProductIdPre` from `frontendPricing.monthlyPremium`,
            // but that field is the DISPLAY premium produced by /contribution-preview (base + Highest-policy
            // included processing fee folded in). Feeding it to the authority as a base premium — and dropping
            // isBundle/includedProducts — caused the authority to look up the bundle PARENT's own subscription
            // config and apply a fresh non-included fee on top. For bundles whose parent has IncludeProcessingFee=false
            // but whose components have IncludeProcessingFee=true (e.g. MightyWELL Concierge bundle), this charged
            // an extra ~3% (~$24 on a $799 bundle).
            //
            // Recompute pristine base premiums via PricingEngine here so the authority sees the same bundle-aware
            // shape that /contribution-preview, fingerprint-verify, and the post-commit persist path use.
            // `totals.monthlyContribution` is then the canonical fee-included monthly total to charge.
            const PricingEngine = require('../services/pricing/PricingEngine');
            const ctxCriteria = pricingContext && typeof pricingContext === 'object'
              ? pricingContext.memberCriteria
              : null;
            if (!ctxCriteria || typeof ctxCriteria !== 'object') {
              // Older clients that don't send pricingContext can't be canonically recomputed here.
              // Skip pre-charge and let the post-commit deferred path charge using the persist authority
              // output (which reads correct base premiums from already-created enrollment rows).
              console.warn('⚠️ PRE-TX: missing pricingContext.memberCriteria — skipping pre-charge to avoid fee double-counting; deferring to post-commit charge path.');
              break preChargeBlock;
            }
            const fpMemberCriteria = {
              age: Number(ctxCriteria.age) || 35,
              tobaccoUse: ctxCriteria.tobaccoUse === 'Yes' || ctxCriteria.tobaccoUse === 'Y' ? 'Yes' : 'No',
              tier: ctxCriteria.tier || memberTier || 'EE',
              householdSize: Number(ctxCriteria.householdSize) || 1
            };
            const fpProductSelections = [...new Set(selectedProducts)].map((pid) => {
              const cfgVal = selectedConfigs?.[pid];
              return {
                productId: pid,
                configValues: cfgVal && cfgVal !== 'Default'
                  ? (typeof cfgVal === 'string' ? { configValue1: cfgVal } : cfgVal)
                  : {}
              };
            });
            const fpPricingResult = await PricingEngine.calculatePricing({
              calculationType: 'enrollment',
              memberCriteria: fpMemberCriteria,
              productSelections: fpProductSelections,
              groupId: linkRow.GroupId || undefined,
              effectiveDate: effectiveDate || null
            });
            const ctxMethod = pricingContext.paymentMethodType;
            const fpMethod = (ctxMethod === 'ACH' || ctxMethod === 'Card')
              ? ctxMethod
              : (paymentMethod?.paymentMethodType === 'Card' ? 'Card' : 'ACH');
            // Authority internally loads PaymentProcessorSettings + TenantProductSubscriptions and
            // composes both included + non-included processing fees + system fees consistently.
            const preChargeAuthorityOutput = await pricingAuthority.computePricing({
              poolOrTransaction: pool,
              tenantId: tenantIdPre,
              pricingProducts: fpPricingResult.products,
              paymentMethodType: fpMethod
            });
            const paymentProcessorSettings = preChargeAuthorityOutput._raw.paymentProcessorSettings;
            let totalSetupFeePre = 0;
            if (selectedProducts.length > 0) {
              const setupReq = pool.request();
              setupReq.input('tenantId', sql.UniqueIdentifier, tenantIdPre);
              selectedProducts.forEach((pid, i) => setupReq.input(`p${i}`, sql.UniqueIdentifier, pid));
              const setupRes = await setupReq.query(`SELECT SUM(COALESCE(SetupFee, 0)) as TotalSetupFee FROM oe.TenantProductSubscriptions WHERE TenantId = @tenantId AND ProductId IN (${selectedProducts.map((_, i) => `@p${i}`).join(',')}) AND SubscriptionStatus IN ('Active', 'Approved')`);
              if (setupRes.recordset.length > 0 && setupRes.recordset[0].TotalSetupFee != null) totalSetupFeePre = Number(setupRes.recordset[0].TotalSetupFee) || 0;
            }

            // Tenant flag: defer first payment to the DIME recurring schedule (skip charge at enrollment).
            // Default ON when unset — see /enrollment-data handler for rationale.
            const chargeFirstPaymentWithRecurringPre = paymentProcessorSettings?.chargeFirstPaymentWithRecurring !== false;
            const setupFeeOnlyPre = chargeFirstPaymentWithRecurringPre && totalSetupFeePre > 0;
            const skipEnrollmentChargePre = chargeFirstPaymentWithRecurringPre && !setupFeeOnlyPre;
            if (skipEnrollmentChargePre) {
              console.log('💳 PRE-TX: chargeFirstPaymentWithRecurring is ON and no setup fee — skipping charge at enrollment (DIME recurring will charge on effective date)');
              break preChargeBlock;
            }

            // monthlyContribution = base + included + non-included + system fees (single source of truth).
            // Setup fee is added on top as a one-time at-enrollment charge.
            const totalPaymentAmountPre = setupFeeOnlyPre
              ? Math.round(totalSetupFeePre * 100) / 100
              : Math.round((Number(preChargeAuthorityOutput.totals.monthlyContribution || 0) + totalSetupFeePre) * 100) / 100;
            const finalMemberIdPre = linkRow.MemberId || memberId;
            const dupReq = pool.request();
            dupReq.input('memberId', sql.UniqueIdentifier, finalMemberIdPre);
            const dupRes = await dupReq.query(`SELECT TOP 5 p.PaymentId, p.Status FROM oe.Payments p INNER JOIN oe.Enrollments e ON p.EnrollmentId = e.EnrollmentId WHERE e.MemberId = @memberId AND p.PaymentDate >= DATEADD(day, -1, GETUTCDATE()) ORDER BY p.PaymentDate DESC`);
            const recentSuccess = (dupRes.recordset || []).filter(p => oePaymentStatus.isSuccessfulPaymentRecordStatus(String(p.Status)));
            if (recentSuccess.length > 0) {
              return res.status(400).json({ success: false, message: 'Payment already processed for this enrollment', error: { code: 'DUPLICATE_PAYMENT' } });
            }
            const hhReq = pool.request();
            hhReq.input('memberId', sql.UniqueIdentifier, finalMemberIdPre);
            const hhRes = await hhReq.query('SELECT HouseholdId FROM oe.Members WHERE MemberId = @memberId');
            const householdIdPre = hhRes.recordset?.[0]?.HouseholdId;
            if (!householdIdPre) {
              return res.status(400).json({ success: false, message: 'Member or household not found', error: { code: 'MEMBER_NOT_FOUND' } });
            }
            const normalizedEmailForIdem = String(paymentMethod?.email || memberInfo?.email || '').trim().toLowerCase();
            const isStaticReusableLink = linkRow.LinkType === 'Agent-Static' || linkRow.LinkType === 'Marketing';
            const emailHash = normalizedEmailForIdem ? crypto.createHash('sha256').update(normalizedEmailForIdem).digest('hex').slice(0, 32) : null;
            const idempotencyKeyPre = isStaticReusableLink && emailHash ? `enrollment-link-${linkToken}-${emailHash}` : `enrollment-link-${linkToken}`;

            // DB-level idempotency: only one request can charge for this key (prevents double/triple charge on double-submit or retries)
            let attemptRowPre = await PaymentAttemptService.createOrGetAttempt({
              idempotencyKey: idempotencyKeyPre,
              linkToken,
              tenantId: tenantIdPre,
              memberId: finalMemberIdPre,
              householdId: householdIdPre,
              amount: totalPaymentAmountPre,
              paymentMethodType: paymentMethod?.paymentMethodType || 'Card',
              status: 'Processing'
            });
            const claimPre = await PaymentAttemptService.claimForCharge(idempotencyKeyPre);
            attemptRowPre = claimPre.attempt || attemptRowPre;

            if (!claimPre.claimed) {
              if (attemptRowPre && ['Charged', 'Completed'].includes(String(attemptRowPre.Status || '')) && attemptRowPre.ProcessorTransactionId) {
                chargeFirstResult = {
                  paymentResult: { success: true, transactionId: attemptRowPre.ProcessorTransactionId },
                  totalPaymentAmount: totalPaymentAmountPre,
                  processorTransactionId: attemptRowPre.ProcessorTransactionId,
                  tenantId: tenantIdPre,
                  householdId: householdIdPre,
                  finalMemberId: finalMemberIdPre,
                  customerId: null
                };
                console.log('💳 Charge-first: reusing existing charge for idempotencyKey (no duplicate charge)');
              } else {
                return res.status(409).json({
                  success: false,
                  message: 'Payment is already being processed for this enrollment. Please wait a moment and do not submit again.',
                  error: { code: 'PAYMENT_IN_PROGRESS' }
                });
              }
            } else {
            const customerEmailPre = paymentMethod?.email || memberInfo?.email;
            if (!customerEmailPre) {
              await PaymentAttemptService.updateAttemptByKey(idempotencyKeyPre, { status: 'Failed', errorMessage: 'Missing customer email' });
              return res.status(400).json({ success: false, message: 'Missing customer email', error: { code: 'PAYMENT_ERROR', details: 'Missing customer email' } });
            }
            let customerResultPre = await DimeService.findCustomerByEmail(customerEmailPre, tenantIdPre);
            if (!customerResultPre.success) {
              customerResultPre = await DimeService.createCustomer({
                firstName: paymentMethod?.cardholderName?.split(' ')[0] || memberInfo?.firstName,
                lastName: paymentMethod?.cardholderName?.split(' ').slice(1).join(' ') || memberInfo?.lastName,
                email: customerEmailPre,
                phone: paymentMethod?.phone || memberInfo?.phone,
                billingAddress: paymentMethod?.billingAddress || memberInfo?.address || ''
              }, tenantIdPre);
            }
            if (!customerResultPre.success || !customerResultPre.customerId) {
              const msg = customerResultPre?.error?.message || 'Failed to create customer';
              await PaymentAttemptService.updateAttemptByKey(idempotencyKeyPre, { status: 'Failed', errorMessage: msg });
              if (isDimeServerError(customerResultPre)) {
                throw new Error(`Processor unavailable during charge-first customer setup: ${msg}`);
              }
              return res.status(400).json({ success: false, message: 'Payment processing failed', error: { code: 'PAYMENT_ERROR', details: msg } });
            }
            try {
              await pool.request()
                .input('memberId', sql.UniqueIdentifier, finalMemberIdPre)
                .input('customerId', sql.NVarChar(255), String(customerResultPre.customerId))
                .query(`
                  UPDATE oe.Members
                  SET ProcessorCustomerId = @customerId,
                      ModifiedDate = GETUTCDATE()
                  WHERE MemberId = @memberId
                `);
            } catch (persistCustomerErr) {
              console.warn('⚠️ Charge-first: failed to persist ProcessorCustomerId before transaction:', persistCustomerErr?.message || persistCustomerErr);
            }
            const paymentResultPre = await DimeService.processPayment({
              customerId: customerResultPre.customerId,
              paymentMethodId: paymentMethod.paymentMethodType === 'ACH' ? 'ACH_PAYMENT' : 'RAW_CARD',
              amount: totalPaymentAmountPre,
              description: 'Initial payment for individual enrollment',
              householdId: householdIdPre,
              paymentMethodType: paymentMethod.paymentMethodType || 'Card',
              idempotencyKey: idempotencyKeyPre,
              cardNumber: paymentMethod.cardNumber,
              expiryDate: paymentMethod.expiryDate,
              cvv: paymentMethod.cvv,
              cardholderName: paymentMethod.cardholderName,
              routingNumber: paymentMethod.routingNumber,
              accountNumber: paymentMethod.accountNumber,
              accountType: paymentMethod.accountType,
              accountHolderName: paymentMethod.accountHolderName,
              bankName: paymentMethod.bankName,
              phone: paymentMethod.phone || memberInfo?.phone,
              email: customerEmailPre,
              billingAddress: paymentMethod.billingAddress || memberInfo?.address || '',
              billingAddress2: paymentMethod.billingAddress2 || '',
              billingCity: paymentMethod.billingCity || memberInfo?.city || '',
              billingState: paymentMethod.billingState || memberInfo?.state || '',
              billingZip: paymentMethod.billingZip || memberInfo?.zip || '',
              billingCountry: paymentMethod.billingCountry || 'US',
              billingFirstName: paymentMethod.cardholderName?.split(' ')[0] || memberInfo?.firstName,
              billingLastName: paymentMethod.cardholderName?.split(' ').slice(1).join(' ') || memberInfo?.lastName
            }, tenantIdPre);
            if (!paymentResultPre.success) {
              await PaymentAttemptService.updateAttemptByKey(idempotencyKeyPre, { status: 'Failed', errorMessage: paymentResultPre?.error?.message || 'Payment failed' });
              if (isDimeServerError(paymentResultPre)) {
                throw new Error(`Processor unavailable during charge-first payment: ${paymentResultPre?.error?.message || 'Payment failed'}`);
              }
              return res.status(400).json({
                success: false,
                message: 'Payment processing failed',
                error: { code: 'PAYMENT_ERROR', details: paymentResultPre?.error?.message || 'Payment failed' }
              });
            }
            await PaymentAttemptService.updateAttemptByKey(idempotencyKeyPre, {
              status: 'Charged',
              processorTransactionId: String(paymentResultPre.transactionId || ''),
              processorResponse: JSON.stringify(paymentResultPre?.rawResponse || {})
            });
            chargeFirstResult = {
              paymentResult: paymentResultPre,
              totalPaymentAmount: totalPaymentAmountPre,
              processorTransactionId: paymentResultPre.transactionId,
              processorTransactionInfoId: paymentResultPre.transactionInfoId || null,
              tenantId: tenantIdPre,
              householdId: householdIdPre,
              finalMemberId: finalMemberIdPre,
              customerId: customerResultPre.customerId || null
            };
            console.log('💳 Charge-first: charged successfully, will create enrollments in transaction');
            }
          } catch (preChargeErr) {
            console.warn('⚠️ Charge-first pre-charge failed, will use deferred payment:', preChargeErr?.message || preChargeErr);
          }
        }
      }
    }

    const transaction = pool.transaction();
    
    // Variable to store payment receipt data for individual enrollments
    let paymentReceiptData = null;
    // Defer individual enrollment payment processing until AFTER commit (prevents "charged but rolled back" failures)
    // When chargeFirstResult is set, we already charged; skip deferred context and post-commit charge
    let deferredIndividualPaymentContext = null;
    /** Fee snapshot for charge-first individual enrollments (stored PM + recurring runs after commit). */
    let chargeFirstIndividualRecurringContext = null;
    // Variable to store password setup token (set during user creation/update); deferred UPDATE after commit to avoid lock contention
    let passwordSetupToken = null;
    let passwordSetupExpiry = null;
    // Defer member/user "profile sync" updates until after commit to avoid lock contention blocking enrollment
    let deferredMemberFrontendUpdate = null;
    let deferredUserFrontendUpdate = null;
    
    try {
      await transaction.begin();

      // Log SPID for DMV debugging when locks occur
      try {
        const spidResult = await transaction.request().query('SELECT @@SPID as spid');
        console.log('🔍 DEBUG: SQL SPID (complete-enrollment):', spidResult.recordset?.[0]?.spid);
      } catch (e) {
        console.warn('⚠️ Failed to read SQL SPID:', e?.message || e);
      }
      
      // 1. Verify enrollment link
      const linkQuery = `
        SELECT 
          el.LinkId,
          el.LinkToken,
          el.GroupId,
          el.MemberId,
          el.AgentId,
          el.AgencyId,
          el.IsActive,
          el.ExpiresAt,
          el.UsageCount,
          el.MaxUsage,
          -- Add LinkType with fallback for existing links
          CASE
            WHEN el.LinkType IS NOT NULL THEN el.LinkType
            WHEN el.GroupId IS NOT NULL THEN 'Group'
            ELSE 'Member'
          END AS LinkType,
          elt.LinkMetaData,
          elt.TemplateType,
          g.Name as GroupName,
          g.AllowMidMonthEffective,
          -- TenantId logic: Group > Member > Agent (for Agent-Static links)
          CASE 
            WHEN el.GroupId IS NOT NULL THEN g.TenantId 
            WHEN el.MemberId IS NOT NULL THEN m.TenantId
            WHEN el.AgentId IS NOT NULL THEN a.TenantId
            ELSE NULL
          END AS TenantId
        FROM oe.EnrollmentLinks el
        LEFT JOIN oe.EnrollmentLinkTemplates elt ON el.EnrollmentLinkTemplateId = elt.TemplateId
        LEFT JOIN oe.Groups g ON el.GroupId = g.GroupId
        LEFT JOIN oe.Members m ON el.MemberId = m.MemberId
        LEFT JOIN oe.Agents a ON el.AgentId = a.AgentId
        WHERE el.LinkToken = @linkToken
      `;
      
      const linkRequest = transaction.request();
      linkRequest.input('linkToken', sql.NVarChar, linkToken);
      
      const linkResult = await linkRequest.query(linkQuery);
      
      if (linkResult.recordset.length === 0) {
        await transaction.rollback();
        return res.status(404).json({
          success: false,
          message: 'Enrollment link not found'
        });
      }
      
      const enrollmentLink = linkResult.recordset[0];
      
      console.log('🔍 Raw enrollment link result:', linkResult.recordset[0]);
      console.log('🔍 DEBUG: TenantId from enrollment link:', enrollmentLink.TenantId);
      console.log('🔍 DEBUG: MemberId from enrollment link:', enrollmentLink.MemberId);
      console.log('🔍 DEBUG: MemberId type:', typeof enrollmentLink.MemberId);
      console.log('🔍 Enrollment link data:', {
        linkId: enrollmentLink.LinkId,
        groupId: enrollmentLink.GroupId,
        memberId: enrollmentLink.MemberId,
        groupIdType: typeof enrollmentLink.GroupId,
        groupIdValue: enrollmentLink.GroupId,
        isActive: enrollmentLink.IsActive,
        expiresAt: enrollmentLink.ExpiresAt,
        usageCount: enrollmentLink.UsageCount,
        maxUsage: enrollmentLink.MaxUsage
      });
      
      // Check if link is active and not expired
      if (!enrollmentLink.IsActive) {
        await transaction.rollback();
        return res.status(400).json({
          success: false,
          message: 'Enrollment link is inactive'
        });
      }
      
      if (enrollmentLink.ExpiresAt && new Date(enrollmentLink.ExpiresAt) < new Date()) {
        await transaction.rollback();
        return res.status(400).json({
          success: false,
          message: 'Enrollment link has expired'
        });
      }
      
      // Check usage limits
      if (enrollmentLink.MaxUsage && enrollmentLink.UsageCount >= enrollmentLink.MaxUsage) {
        await transaction.rollback();
        return res.status(400).json({
          success: false,
          message: 'Enrollment link usage limit reached'
        });
      }
      
      // Determine enrollment type (Group, Member, Agent-Static, or Marketing)
      const linkType = enrollmentLink.LinkType;
      const isGroupEnrollment = linkType === 'Group' || (enrollmentLink.GroupId && typeof enrollmentLink.GroupId === 'string' && enrollmentLink.GroupId.length === 36);
      const isAgentStatic = linkType === 'Agent-Static';
      const isMarketing = linkType === 'Marketing';
      
      console.log('🔍 Enrollment type:', {
        linkType,
        isGroupEnrollment,
        isAgentStatic,
        isMarketing,
        groupId: enrollmentLink.GroupId,
        memberId: enrollmentLink.MemberId,
        agentId: enrollmentLink.AgentId
      });

      // Server-side cohort validation for group enrollments. The wizard
      // restricts the date picker to 1st (and 15th when AllowMidMonthEffective
      // is on), but never trust the client — reject any other day before any
      // DB writes so we don't store an EffectiveDate that downstream
      // cohort math (getCohortFromDate) cannot process.
      //
      // If the link's member already has a household with active enrollments,
      // the household's existing cohort overrides the group flag (a family
      // must stay single-cohort, one bill per period).
      if (isGroupEnrollment && effectiveDate) {
        const { isValidEarliestEffectiveDate } = require('./_groups-validation');
        const { getHouseholdCohortByMemberId } = require('../services/householdCohort.service');
        const householdCohort = enrollmentLink.MemberId
          ? await getHouseholdCohortByMemberId(pool, enrollmentLink.MemberId)
          : null;
        const parsed = new Date(effectiveDate);
        const ok = isValidEarliestEffectiveDate(
          parsed,
          { AllowMidMonthEffective: enrollmentLink.AllowMidMonthEffective },
          householdCohort
        );
        if (!ok) {
          await transaction.rollback();
          let message;
          if (householdCohort === 'FIRST') {
            message = 'Effective date must be the 1st of a month — this household is on the 1st-of-month billing cycle.';
          } else if (householdCohort === 'FIFTEENTH') {
            message = 'Effective date must be the 15th of a month — this household is on the 15th-of-month billing cycle.';
          } else {
            const allowMid = enrollmentLink.AllowMidMonthEffective === true || enrollmentLink.AllowMidMonthEffective === 1;
            message = allowMid
              ? 'Effective date must be the 1st or 15th of a month for this group.'
              : 'Effective date must be the 1st of a month for this group.';
          }
          return res.status(400).json({
            success: false,
            message,
            error: { code: 'INVALID_EFFECTIVE_DATE' }
          });
        }
      }

      if (isAgentStatic) {
        console.log('✅ Agent-Static enrollment detected - will create new member...');
      } else if (isMarketing) {
        console.log('✅ Marketing enrollment detected - will create new member...');
      } else if (isGroupEnrollment) {
        console.log('✅ Group enrollment detected - proceeding with group member validation...');
      } else {
        console.log('✅ Individual enrollment detected - proceeding with individual member validation...');
      }

      // Verify/create member (different logic for Agent-Static/Marketing vs existing members)
      let memberQuery, memberRequest, memberResult, member;
      let finalMemberId = memberId; // Will be set to created member ID for Agent-Static/Marketing
      let userId; // Declare at higher scope for use after transaction
      let isNewUser = false; // Declare at higher scope for use after transaction
      // True when a static/marketing link landed on a pre-existing User and/or Member row
      // (i.e. anything other than the brand-new email + fresh INSERT path). Drives the 1.5
      // update block below — without this, fields the wizard collected (SSN, TobaccoUse,
      // Address, Gender, Phone, FirstName, LastName, etc.) get silently dropped. Two cases:
      //   A) existing User + existing Member (reuse): Member SSN/Tobacco/etc. and User
      //      Name/Phone never updated. Prod incident 2026-04-27 (Turning Point Church):
      //      April English, Isabelle Cogdill, Michael Turner all completed via Agent-Static
      //      "Self Enrollment" link against pre-existing invite-shell Member rows.
      //   B) existing User + brand-new Member: Member is INSERTed fresh, but the existing
      //      User row's Name/Phone isn't refreshed if the wizard captured different values.
      // For brand-new User + brand-new Member (case C) we leave the flag false because the
      // INSERTs already set everything from memberInfo.
      let staticLinkUsedExistingRecord = false;
      const UserRolesService = require('../services/shared/user-roles.service');
      
      if (isAgentStatic || isMarketing) {
        console.log(`🔍 ${isMarketing ? 'Marketing' : 'Agent-Static'} enrollment - Creating new User and Member...`);
        
        // AGENT-STATIC FLOW: Create new User and Member
        // Validate required member info
        if (!memberInfo || !memberInfo.email || !memberInfo.firstName || !memberInfo.lastName) {
          await transaction.rollback();
          return res.status(400).json({
            success: false,
            message: 'Missing required member information (email, firstName, lastName)'
          });
        }
        
        // Check if User exists with this email (across ALL tenants)
        const existingUserQuery = `
          SELECT UserId, Email, FirstName, LastName, TenantId, PasswordHash
          FROM oe.Users
          WHERE Email = @email
        `;
        
        const existingUserRequest = transaction.request();
        existingUserRequest.input('email', sql.NVarChar, memberInfo.email);
        const existingUserResult = await existingUserRequest.query(existingUserQuery);
        
        if (existingUserResult.recordset.length > 0) {
          // User exists - reuse the User record
          userId = existingUserResult.recordset[0].UserId;
          const hasPassword = existingUserResult.recordset[0].PasswordHash !== null;
          // Mark that we landed on a pre-existing User row. Case A (reuse Member) and Case B
          // (create new Member but reuse User) both need the 1.5 update block to actually
          // persist wizard-collected fields onto the existing rows.
          staticLinkUsedExistingRecord = true;
          console.log('✅ Found existing User with email:', memberInfo.email, 'UserId:', userId, 'HasPassword:', hasPassword);
          
          // Generate password setup token for existing users (deferred UPDATE after commit to avoid lock contention)
          passwordSetupToken = require('crypto').randomBytes(32).toString('hex');
          const tokenExpiry = new Date();
          tokenExpiry.setDate(tokenExpiry.getDate() + 7);
          passwordSetupExpiry = tokenExpiry;
          req.body.passwordSetupToken = passwordSetupToken;
          console.log('✅ Generated password setup token for existing user (will persist after commit)');
          
          // Check if Member already exists for this User in this Tenant.
          // For static/marketing links, we can reuse that existing member when eligible.
          const duplicateMemberQuery = `
            SELECT TOP 1
              MemberId,
              GroupId,
              Status,
              HouseholdId,
              HouseholdMemberID
            FROM oe.Members 
            WHERE UserId = @userId AND TenantId = @tenantId
            ORDER BY
              CASE WHEN Status = 'Active' THEN 0 WHEN Status = 'Pending Payment' THEN 1 ELSE 2 END,
              ModifiedDate DESC
          `;
          
          const duplicateMemberRequest = transaction.request();
          duplicateMemberRequest.input('userId', sql.UniqueIdentifier, userId);
          duplicateMemberRequest.input('tenantId', sql.UniqueIdentifier, enrollmentLink.TenantId);
          const duplicateMemberResult = await duplicateMemberRequest.query(duplicateMemberQuery);
          
          let useExistingMember = false;
          let existingMemberRecord = null;
          if (duplicateMemberResult.recordset.length > 0) {
            existingMemberRecord = duplicateMemberResult.recordset[0];

            if (existingMemberRecord.GroupId) {
              await transaction.rollback();
              return res.status(400).json({
                success: false,
                message: "You're already associated with a group in this organization.",
                error: {
                  code: 'MEMBER_IN_GROUP',
                  message: 'Existing member is already associated with a group and cannot use static enrollment.'
                }
              });
            }

            const activeEnrollmentCheckRequest = transaction.request();
            activeEnrollmentCheckRequest.input('memberId', sql.UniqueIdentifier, existingMemberRecord.MemberId);
            const activeEnrollmentCheck = await activeEnrollmentCheckRequest.query(`
              SELECT COUNT(1) AS activeCount
              FROM oe.Enrollments e
              WHERE e.MemberId = @memberId
                AND e.Status = 'Active'
                AND (e.EffectiveDate IS NULL OR CAST(e.EffectiveDate AS date) <= CAST(GETUTCDATE() AS date))
                AND (e.TerminationDate IS NULL OR CAST(e.TerminationDate AS date) >= CAST(GETUTCDATE() AS date))
            `);
            const activeCount = Number(activeEnrollmentCheck.recordset?.[0]?.activeCount || 0);

            if (activeCount > 0) {
              await transaction.rollback();
              return res.status(400).json({
                success: false,
                message: "You're already enrolled with this organization.",
                error: {
                  code: 'DUPLICATE_MEMBER',
                  message: 'A member record already exists for this email in this organization with active enrollments.'
                }
              });
            }

            useExistingMember = true;
            finalMemberId = existingMemberRecord.MemberId;
            console.log('✅ Reusing existing eligible member for static/marketing enrollment:', {
              memberId: finalMemberId,
              status: existingMemberRecord.Status
            });
          }

          if (useExistingMember && finalMemberId) {
            // If existing member is terminated, reactivate to continue enrollment
            if (existingMemberRecord?.Status === 'Terminated') {
              const reactivateRequest = transaction.request();
              reactivateRequest.input('memberId', sql.UniqueIdentifier, finalMemberId);
              await reactivateRequest.query(`
                UPDATE oe.Members
                SET Status = 'Pending Payment', ModifiedDate = GETUTCDATE()
                WHERE MemberId = @memberId
              `);
            }

            const existingMemberDetailsRequest = transaction.request();
            existingMemberDetailsRequest.input('memberId', sql.UniqueIdentifier, finalMemberId);
            const existingMemberDetailsResult = await existingMemberDetailsRequest.query(`
              SELECT
                m.MemberId,
                m.UserId,
                m.Status,
                m.GroupId,
                m.AgentId,
                m.RelationshipType,
                m.Tier,
                m.TobaccoUse,
                m.DateOfBirth,
                m.Gender,
                m.Address,
                m.City,
                m.State,
                m.Zip,
                m.SSN,
                m.HouseholdId,
                m.MemberSequence,
                m.HouseholdMemberID,
                u.FirstName,
                u.LastName,
                u.Email,
                u.PhoneNumber
              FROM oe.Members m
              LEFT JOIN oe.Users u ON m.UserId = u.UserId
              WHERE m.MemberId = @memberId
            `);
            if (existingMemberDetailsResult.recordset.length === 0) {
              await transaction.rollback();
              return res.status(404).json({
                success: false,
                message: 'Existing member not found'
              });
            }
            member = existingMemberDetailsResult.recordset[0];
            member.Status = member.Status === 'Terminated' ? 'Pending Payment' : member.Status;
            // Static/Marketing: section 1.5 does not run for these link types, so DB DOB can be stale while the wizard sent a valid DOB.
            // Sync validated memberInfo.dateOfBirth onto the row + in-memory member so pricing matches product-pricing (age query param).
            if (memberInfo?.dateOfBirth) {
              const syncDobReq = transaction.request();
              syncDobReq.input('memberId', sql.UniqueIdentifier, finalMemberId);
              syncDobReq.input('dateOfBirth', sql.Date, new Date(`${memberInfo.dateOfBirth}T12:00:00.000Z`));
              await syncDobReq.query(`
                UPDATE oe.Members
                SET DateOfBirth = @dateOfBirth, ModifiedDate = GETUTCDATE()
                WHERE MemberId = @memberId
              `);
              member.DateOfBirth = memberInfo.dateOfBirth;
            }
          }
        } else {
          // Create new User (without password - will be set in password-setup step)
          userId = require('crypto').randomUUID();
          isNewUser = true;
          
          // Generate password setup token (valid for 7 days)
          passwordSetupToken = require('crypto').randomBytes(32).toString('hex');
          const tokenExpiry = new Date();
          tokenExpiry.setDate(tokenExpiry.getDate() + 7);
          
          console.log('🔍 Creating new User:', { userId, email: memberInfo.email, hasPasswordToken: true });
          
          const createUserQuery = `
            INSERT INTO oe.Users (
              UserId, Email, FirstName, LastName, PhoneNumber, Status, TenantId,
              ResetPasswordToken, ResetPasswordExpiry,
              CreatedDate, ModifiedDate
            ) VALUES (
              @userId, @email, @firstName, @lastName, @phoneNumber, 'Active', @tenantId,
              @resetPasswordToken, @resetPasswordExpiry,
              GETUTCDATE(), GETUTCDATE()
            )
          `;
          
          const createUserRequest = transaction.request();
          createUserRequest.input('userId', sql.UniqueIdentifier, userId);
          createUserRequest.input('email', sql.NVarChar, memberInfo.email);
          createUserRequest.input('firstName', sql.NVarChar, memberInfo.firstName);
          createUserRequest.input('lastName', sql.NVarChar, memberInfo.lastName);
          createUserRequest.input('phoneNumber', sql.NVarChar, memberInfo.phone || null);
          createUserRequest.input('tenantId', sql.UniqueIdentifier, enrollmentLink.TenantId);
          createUserRequest.input('resetPasswordToken', sql.NVarChar, passwordSetupToken);
          createUserRequest.input('resetPasswordExpiry', sql.DateTime2, tokenExpiry);
          
          await createUserRequest.query(createUserQuery);
          
          // Store token for email sending (both in req.body and local variable)
          req.body.passwordSetupToken = passwordSetupToken;
          
          console.log('✅ Created new User:', userId);
        }
        
        // Create new Member only when we did not reuse an existing one
        if (!member) {
          finalMemberId = require('crypto').randomUUID();
          
          console.log('🔍 Creating new Member:', { memberId: finalMemberId, userId, agentId: enrollmentLink.AgentId });
          
          // If the enrollment link is group-scoped (GroupId set on the link row,
          // e.g. an Agent-Static/Marketing link created for employee-facing doc
          // distribution), link the new member to that group. Otherwise treat
          // as standalone Individual enrollment as before.
          const linkGroupId = enrollmentLink.GroupId || null;
          const memberEnrollmentType = linkGroupId ? 'Group' : 'Individual';

          const createMemberQuery = `
            INSERT INTO oe.Members (
              MemberId, UserId, TenantId, AgentId, GroupId, Status, RelationshipType, Tier,
              EnrollmentType, DateOfBirth, Gender, Address, City, State, Zip, TobaccoUse, SSN,
              Height, Weight,
              HouseholdId, MemberSequence,
              CreatedDate, ModifiedDate
            ) VALUES (
              @memberId, @userId, @tenantId, @agentId, @groupId, 'Pending Payment', 'P', @tier,
              @enrollmentType, @dateOfBirth, @gender, @address, @city, @state, @zip, @tobaccoUse, @ssn,
              @height, @weight,
              @memberId, 1,
              GETUTCDATE(), GETUTCDATE()
            )
          `;

          const createMemberRequest = transaction.request();
          createMemberRequest.input('memberId', sql.UniqueIdentifier, finalMemberId);
          createMemberRequest.input('userId', sql.UniqueIdentifier, userId);
          createMemberRequest.input('tenantId', sql.UniqueIdentifier, enrollmentLink.TenantId);
          createMemberRequest.input('agentId', sql.UniqueIdentifier, enrollmentLink.AgentId);
          createMemberRequest.input('groupId', sql.UniqueIdentifier, linkGroupId);
          createMemberRequest.input('enrollmentType', sql.NVarChar, memberEnrollmentType);
          createMemberRequest.input('tier', sql.NVarChar, memberTier || 'EE');
          createMemberRequest.input('dateOfBirth', sql.Date, memberInfo.dateOfBirth || null);
          createMemberRequest.input('gender', sql.NVarChar, memberInfo.gender || null);
          createMemberRequest.input('address', sql.NVarChar, memberInfo.address || null);
          createMemberRequest.input('city', sql.NVarChar, memberInfo.city || null);
          createMemberRequest.input('state', sql.NVarChar, memberInfo.state || null);
          createMemberRequest.input('zip', sql.NVarChar, memberInfo.zip || null);
          createMemberRequest.input('tobaccoUse', sql.NVarChar, memberInfo.tobaccoUse || 'N');
          // Format and encrypt SSN before saving
          const encryptedSSN = formatAndEncryptSSN(memberInfo.ssn);
          createMemberRequest.input('ssn', sql.NVarChar, encryptedSSN);
          createMemberRequest.input('height', sql.Int, memberInfo.height ? parseInt(memberInfo.height) : null);
          createMemberRequest.input('weight', sql.Int, memberInfo.weight ? parseInt(memberInfo.weight) : null);

          await createMemberRequest.query(createMemberQuery);
          
          console.log('✅ Created new Member:', finalMemberId);
          
          // NOTE: Role assignment moved outside transaction to prevent deadlocks
          // Will be assigned after transaction commits
          
          // Create member object for the rest of the flow
          member = {
            MemberId: finalMemberId,
            UserId: userId,
            Status: 'Pending Payment',
            GroupId: linkGroupId,
            AgentId: enrollmentLink.AgentId,
            RelationshipType: 'P',
            Tier: memberTier || 'EE',
            TobaccoUse: memberInfo.tobaccoUse || 'N',
            DateOfBirth: memberInfo.dateOfBirth || null,
            Gender: memberInfo.gender || null,
            Address: memberInfo.address || null,
            City: memberInfo.city || null,
            State: memberInfo.state || null,
            Zip: memberInfo.zip || null,
            HouseholdId: finalMemberId, // Primary member's HouseholdId = their own MemberId
            MemberSequence: 1,
            FirstName: memberInfo.firstName,
            LastName: memberInfo.lastName,
            Email: memberInfo.email,
            PhoneNumber: memberInfo.phone || null
          };
        }
        
      } else if (isGroupEnrollment) {
        // Group enrollment: verify member belongs to the group
        memberQuery = `
          SELECT 
            m.MemberId,
            m.UserId,
            m.Status,
            m.GroupId,
            m.AgentId,
            m.RelationshipType,
            m.Tier,
            m.TobaccoUse,
            m.DateOfBirth,
            m.Gender,
            m.Address,
            m.City,
            m.State,
            m.Zip,
            m.SSN,
            m.HouseholdId,
            m.MemberSequence,
            m.JobPosition,
            u.FirstName,
            u.LastName,
            u.Email,
            u.PhoneNumber,
            u.PasswordHash
          FROM oe.Members m
          LEFT JOIN oe.Users u ON m.UserId = u.UserId
          WHERE m.MemberId = @memberId 
            AND m.GroupId = @groupId 
            AND m.Status = 'Active'
          `;
        
        memberRequest = transaction.request();
        memberRequest.input('memberId', sql.UniqueIdentifier, enrollmentLink.MemberId);
        memberRequest.input('groupId', sql.UniqueIdentifier, enrollmentLink.GroupId);
        
        console.log('🔍 Group enrollment - Member query params:', {
          memberId: enrollmentLink.MemberId,
          groupId: enrollmentLink.GroupId
        });
        
        memberResult = await memberRequest.query(memberQuery);
        
        if (memberResult.recordset.length === 0) {
          await transaction.rollback();
          return res.status(404).json({
            success: false,
            message: 'Member not found or does not belong to this group'
          });
        }
        
        member = memberResult.recordset[0];
        finalMemberId = member.MemberId;
        userId = member.UserId; // Extract UserId for file uploads

        // Group-admin onboarding can create a primary Member row without HouseholdId.
        // Enrollment inserts and contribution logic require it — default to self for primaries.
        if (member.RelationshipType === 'P' && !member.HouseholdId) {
          const householdFixRequest = transaction.request();
          householdFixRequest.input('memberId', sql.UniqueIdentifier, finalMemberId);
          await householdFixRequest.query(`
            UPDATE oe.Members
            SET HouseholdId = @memberId, ModifiedDate = GETUTCDATE()
            WHERE MemberId = @memberId AND HouseholdId IS NULL
          `);
          member.HouseholdId = finalMemberId;
          console.log('✅ Backfilled missing HouseholdId for group primary member:', finalMemberId);
        }
        
        // If member is Terminated, update status to 'Pending Payment' for re-enrollment
        if (member.Status === 'Terminated') {
          console.log('🔄 Updating terminated member status to Pending Payment for re-enrollment');
          const updateStatusRequest = transaction.request();
          updateStatusRequest.input('memberId', sql.UniqueIdentifier, finalMemberId);
          await updateStatusRequest.query(`
            UPDATE oe.Members 
            SET Status = 'Pending Payment', ModifiedDate = GETUTCDATE()
            WHERE MemberId = @memberId
          `);
          member.Status = 'Pending Payment'; // Update in-memory object
        }
        
        // Generate password setup token only for existing users who do NOT yet have a password (deferred UPDATE after commit to avoid lock contention)
        if (userId) {
          const hasPassword = member.PasswordHash != null && String(member.PasswordHash).trim() !== '';
          console.log('✅ Found existing User for group enrollment:', { userId, email: member.Email || memberInfo?.email, hasPassword });
          if (!hasPassword) {
            passwordSetupToken = require('crypto').randomBytes(32).toString('hex');
            const tokenExpiry = new Date();
            tokenExpiry.setDate(tokenExpiry.getDate() + 7);
            passwordSetupExpiry = tokenExpiry;
            req.body.passwordSetupToken = passwordSetupToken;
            console.log('✅ Generated password setup token for existing user (group enrollment, will persist after commit)');
          } else {
            console.log('✅ User already has password - skipping password token');
          }
        }
      } else {
        // Individual enrollment: verify member exists (no group requirement)
        console.log('🔍 Processing as INDIVIDUAL enrollment (no GroupId required)');
        
        memberQuery = `
          SELECT 
            m.MemberId,
            m.UserId,
            m.Status,
            m.GroupId,
            m.AgentId,
            m.RelationshipType,
            m.Tier,
            m.TobaccoUse,
            m.DateOfBirth,
            m.Gender,
            m.Address,
            m.City,
            m.State,
            m.Zip,
            m.SSN,
            m.HouseholdId,
            m.MemberSequence,
            m.HouseholdMemberID,
            m.JobPosition,
            u.FirstName,
            u.LastName,
            u.Email,
            u.PhoneNumber
          FROM oe.Members m
          LEFT JOIN oe.Users u ON m.UserId = u.UserId
          WHERE m.MemberId = @memberId 
            AND m.Status IN ('Active', 'Terminated')  -- Allow terminated members for re-enrollment
        `;
        
        memberRequest = transaction.request();
        memberRequest.input('memberId', sql.UniqueIdentifier, enrollmentLink.MemberId);
        
        console.log('🔍 Individual enrollment - Member query params:', {
          memberId: enrollmentLink.MemberId
        });
      
      memberResult = await memberRequest.query(memberQuery);
      
      if (memberResult.recordset.length === 0) {
        await transaction.rollback();
        return res.status(404).json({
          success: false,
            message: 'Member not found'
        });
      }
      
      member = memberResult.recordset[0];
        finalMemberId = member.MemberId;
        userId = member.UserId; // Extract UserId for file uploads
        
        // If member is Terminated, update status to 'Pending Payment' for re-enrollment
        if (member.Status === 'Terminated') {
          console.log('🔄 Updating terminated member status to Pending Payment for re-enrollment');
          const updateStatusRequest = transaction.request();
          updateStatusRequest.input('memberId', sql.UniqueIdentifier, finalMemberId);
          await updateStatusRequest.query(`
            UPDATE oe.Members 
            SET Status = 'Pending Payment', ModifiedDate = GETUTCDATE()
            WHERE MemberId = @memberId
          `);
          member.Status = 'Pending Payment'; // Update in-memory object
        }
        
        // Generate password setup token for existing users (deferred UPDATE after commit to avoid lock contention)
        if (userId) {
          console.log('✅ Found existing User for individual enrollment:', { userId, email: member.Email || memberInfo?.email });
          passwordSetupToken = require('crypto').randomBytes(32).toString('hex');
          const tokenExpiry = new Date();
          tokenExpiry.setDate(tokenExpiry.getDate() + 7);
          passwordSetupExpiry = tokenExpiry;
          req.body.passwordSetupToken = passwordSetupToken;
          console.log('✅ Generated password setup token for existing user (individual enrollment, will persist after commit)');
        }
      }
      
      console.log('🔍 DEBUG: Member data:', {
        memberId: member.MemberId,
        finalMemberId: finalMemberId,
        householdMemberID: member.HouseholdMemberID,
        hasHouseholdMemberID: !!member.HouseholdMemberID,
        memberStatus: member.Status,
        isAgentStatic: isAgentStatic,
        isMarketing: isMarketing
      });

      // 1.4. Generate HouseholdMemberID if needed.
      //
      // We regenerate in two cases:
      //   (a) Member has no HouseholdMemberID yet (brand-new enrollment).
      //   (b) DEFENSIVE FALLBACK: member is now an INDIVIDUAL (GroupId IS NULL) but their stored
      //       HouseholdMemberID still carries the tenant's GROUP prefix (e.g. "MW123"). In normal
      //       flows this should not happen anymore — both Edit Member's group change
      //       (PUT /api/members/:id) and the Advanced Tab's bulk release
      //       (POST /api/groups/:id/release-unenrolled) now perform an immediate prefix swap to
      //       "SW123" via swapHouseholdMemberIdPrefix at the moment GroupId is cleared. This branch
      //       remains as a safety net for legacy data, manual SQL fixes, or future bypasses.
      //       oe.GenerateHouseholdMemberID picks the individual prefix automatically when GroupId
      //       IS NULL, and the existing UPDATE overwrites the stale value with a fresh sequence.
      let shouldRegenerateHouseholdMemberID = !member.HouseholdMemberID;
      let regenReason = shouldRegenerateHouseholdMemberID ? 'no-existing-id' : null;

      if (!shouldRegenerateHouseholdMemberID && !member.GroupId && member.HouseholdMemberID) {
        try {
          const tenantPrefixRequest = transaction.request();
          tenantPrefixRequest.input('tenantId', sql.UniqueIdentifier, enrollmentLink.TenantId);
          const tenantPrefixResult = await tenantPrefixRequest.query(`
            SELECT MemberIDPrefix, IndividualMemberIDPrefix
            FROM oe.Tenants
            WHERE TenantId = @tenantId
          `);
          if (tenantPrefixResult.recordset.length > 0) {
            const groupPrefix = (tenantPrefixResult.recordset[0].MemberIDPrefix || '').trim();
            const individualPrefix = (tenantPrefixResult.recordset[0].IndividualMemberIDPrefix || '').trim();
            const currentId = String(member.HouseholdMemberID).trim();
            const hasStaleGroupPrefix =
              !!groupPrefix &&
              !!individualPrefix &&
              groupPrefix.toUpperCase() !== individualPrefix.toUpperCase() &&
              currentId.length >= groupPrefix.length &&
              currentId.slice(0, groupPrefix.length).toUpperCase() === groupPrefix.toUpperCase() &&
              currentId.slice(0, individualPrefix.length).toUpperCase() !== individualPrefix.toUpperCase();
            if (hasStaleGroupPrefix) {
              shouldRegenerateHouseholdMemberID = true;
              regenReason = 'released-from-group-stale-prefix';
              console.log('🔄 Released-from-group member detected with stale group prefix — regenerating HouseholdMemberID:', {
                memberId: finalMemberId,
                staleId: currentId,
                groupPrefix,
                individualPrefix
              });
            }
          }
        } catch (prefixErr) {
          console.warn('⚠️ Could not fetch tenant prefixes for stale-prefix check; falling back to skip-generation:', prefixErr.message);
        }
      }

      if (shouldRegenerateHouseholdMemberID) {
        console.log('🔍 DEBUG: Will (re)generate HouseholdMemberID. Reason:', regenReason, 'Existing:', member.HouseholdMemberID || '(none)');
      } else {
        console.log('🔍 DEBUG: Member already has HouseholdMemberID:', member.HouseholdMemberID, '- skipping generation');
      }

      if (shouldRegenerateHouseholdMemberID) {
        try {
          console.log('🔍 Generating HouseholdMemberID for member:', finalMemberId);
          console.log('🔍 DEBUG: finalMemberId type:', typeof finalMemberId);
          console.log('🔍 DEBUG: finalMemberId value:', finalMemberId);
          console.log('🔍 DEBUG: enrollmentLink.TenantId type:', typeof enrollmentLink.TenantId);
          console.log('🔍 DEBUG: enrollmentLink.TenantId value:', enrollmentLink.TenantId);

          // Use raw SQL query to call stored procedure and get result
          const householdMemberIdQuery = `
            SET LOCK_TIMEOUT 10000;
            DECLARE @HouseholdMemberID NVARCHAR(50);
            EXEC oe.GenerateHouseholdMemberID 
              @TenantId = @TenantId,
              @MemberId = @MemberId,
              @HouseholdMemberID = @HouseholdMemberID OUTPUT;
            SELECT @HouseholdMemberID as GeneratedHouseholdMemberID;
          `;

          const householdMemberIdRequest = transaction.request();
          householdMemberIdRequest.input('TenantId', sql.UniqueIdentifier, enrollmentLink.TenantId);
          householdMemberIdRequest.input('MemberId', sql.UniqueIdentifier, finalMemberId);
          householdMemberIdRequest.timeout = 15000;

          console.log('🔍 DEBUG: Input parameters before execution:', {
            MemberId: finalMemberId,
            TenantId: enrollmentLink.TenantId
          });

          console.log('🔍 DEBUG: About to execute GenerateHouseholdMemberID with raw SQL');
          const result = await householdMemberIdRequest.query(householdMemberIdQuery);

          const generatedHouseholdMemberID = result.recordset[0]?.GeneratedHouseholdMemberID;
          console.log('🔍 DEBUG: Generated HouseholdMemberID:', generatedHouseholdMemberID);

          if (!generatedHouseholdMemberID) {
            console.log('❌ ERROR: Generated HouseholdMemberID is null or empty');
            await transaction.rollback();
            return res.status(500).json({
              success: false,
              message: 'Failed to generate HouseholdMemberID - enrollment cannot be completed'
            });
          }

          console.log('✅ Generated HouseholdMemberID:', generatedHouseholdMemberID);

          // Update the member with the generated HouseholdMemberID
          // Also update status from 'Terminated' to 'Pending Payment' if re-enrolling
          const updateHouseholdIdRequest = transaction.request();
          updateHouseholdIdRequest.input('memberId', sql.UniqueIdentifier, finalMemberId);
          updateHouseholdIdRequest.input('householdMemberID', sql.NVarChar, generatedHouseholdMemberID);
          updateHouseholdIdRequest.timeout = 15000;

          await updateHouseholdIdRequest.query(`
            SET LOCK_TIMEOUT 10000;
            UPDATE oe.Members 
            SET HouseholdMemberID = @householdMemberID,
                Status = CASE WHEN Status = 'Terminated' THEN 'Pending Payment' ELSE Status END,
                ModifiedDate = GETUTCDATE()
            WHERE MemberId = @memberId
          `);

          // Update the member object for use in subsequent operations
          member.HouseholdMemberID = generatedHouseholdMemberID;
          // Update status in member object if it was Terminated
          if (member.Status === 'Terminated') {
            member.Status = 'Pending Payment';
          }
        } catch (error) {
          console.error('❌ Error generating HouseholdMemberID:', error);
          console.error('❌ Error details:', {
            message: error.message,
            code: error.code,
            number: error.number,
            state: error.state,
            class: error.class,
            serverName: error.serverName,
            procName: error.procName,
            lineNumber: error.lineNumber
          });
          await transaction.rollback();
          return res.status(500).json({
            success: false,
            message: 'Failed to generate HouseholdMemberID - enrollment cannot be completed',
            error: error.message
          });
        }
      }
      
      // 1.5. Update member's information based on frontend data.
      // For Agent-Static/Marketing links: run this block whenever the static path landed on
      // a pre-existing User and/or Member row (staticLinkUsedExistingRecord) so wizard fields
      // (SSN, TobaccoUse, Address, Gender, Phone, FirstName, LastName, Height, Weight, etc.)
      // actually get persisted. Skip ONLY for brand-new-User + brand-new-Member (case C) —
      // those are fully populated by the INSERTs above and re-running 1.5 would be wasteful.
      // Pre-fix the existing-record branch only synced DateOfBirth (for pricing) and dropped
      // everything else — see Turning Point Church 2026-04-27 incident in commit message.
      // Note: for the Case B sub-path (existing User + freshly INSERTed Member), the Member
      // portion of this block writes the same values the INSERT just set — idempotent. The
      // SSN re-encrypts to a new ciphertext but decrypts to the same plaintext, so safe.
      if ((memberInfo || memberTier) && ((!isAgentStatic && !isMarketing) || staticLinkUsedExistingRecord)) {
        console.log('🔍 Updating member data with frontend values:', {
          currentTobaccoUse: member.TobaccoUse,
          newTobaccoUse: memberInfo?.tobaccoUse,
          currentTier: member.Tier,
          newTier: memberTier,
          hasMemberInfo: !!memberInfo
        });
        
        const updateMemberRequest = transaction.request();
        updateMemberRequest.input('memberId', sql.UniqueIdentifier, finalMemberId);
        updateMemberRequest.input('modifiedBy', sql.UniqueIdentifier, member.UserId);
        
        let updateFields = [];
        let encryptedSSNForUpdate = null;
        
        // Update status from 'Terminated' to 'Pending Payment' for re-enrollment
        if (member.Status === 'Terminated') {
          updateFields.push('Status = \'Pending Payment\'');
          member.Status = 'Pending Payment'; // Update in-memory object
        }
        
        // Update tobacco use
        if (memberInfo?.tobaccoUse) {
          const tobaccoMapping = {
            'N': 'N', 'Y': 'Y', 'No': 'N', 'Yes': 'Y'
          };
          const dbTobaccoUse = tobaccoMapping[memberInfo.tobaccoUse] || 'N';
          updateFields.push('TobaccoUse = @tobaccoUse');
          updateMemberRequest.input('tobaccoUse', sql.NVarChar, dbTobaccoUse);
        }
        
        // Update tier
        if (memberTier) {
          updateFields.push('Tier = @tier');
          updateMemberRequest.input('tier', sql.NVarChar, memberTier);
        }
        
        // Update personal information (only fields that exist in Members table)
        if (memberInfo) {
          if (memberInfo.dateOfBirth) {
            updateFields.push('DateOfBirth = @dateOfBirth');
            updateMemberRequest.input('dateOfBirth', sql.Date, new Date(memberInfo.dateOfBirth));
          }
          if (memberInfo.gender) {
            updateFields.push('Gender = @gender');
            updateMemberRequest.input('gender', sql.NVarChar, memberInfo.gender);
          }
          if (memberInfo.address) {
            updateFields.push('Address = @address');
            updateMemberRequest.input('address', sql.NVarChar, memberInfo.address);
          }
          if (memberInfo.city) {
            updateFields.push('City = @city');
            updateMemberRequest.input('city', sql.NVarChar, memberInfo.city);
          }
          if (memberInfo.state) {
            updateFields.push('State = @state');
            updateMemberRequest.input('state', sql.NVarChar, memberInfo.state);
          }
          if (memberInfo.zip) {
            updateFields.push('Zip = @zip');
            updateMemberRequest.input('zip', sql.NVarChar, memberInfo.zip);
          }
          if (memberInfo.ssn) {
            updateFields.push('SSN = @ssn');
            // Format and encrypt SSN before saving
            encryptedSSNForUpdate = formatAndEncryptSSN(memberInfo.ssn);
            updateMemberRequest.input('ssn', sql.NVarChar, encryptedSSNForUpdate);
          }
          if (memberInfo.height != null) {
            updateFields.push('Height = @height');
            updateMemberRequest.input('height', sql.Int, parseInt(memberInfo.height) || null);
          }
          if (memberInfo.weight != null) {
            updateFields.push('Weight = @weight');
            updateMemberRequest.input('weight', sql.Int, parseInt(memberInfo.weight) || null);
          }
        }
        
        if (updateFields.length > 0) {
          updateFields.push('ModifiedDate = GETUTCDATE()');
          updateFields.push('ModifiedBy = @modifiedBy');
          
          const updateMemberQuery = `
            SET LOCK_TIMEOUT 10000;
            UPDATE oe.Members 
            SET ${updateFields.join(', ')}
            WHERE MemberId = @memberId
          `;
          
          console.log('🔍 DEBUG: About to update oe.Members with frontend values:', {
            memberId: finalMemberId,
            updateFields: updateFields
          });
          const updateMemberStart = Date.now();
          // Per-request timeout so we fail fast if blocked
          updateMemberRequest.timeout = 15000;
          try {
            await updateMemberRequest.query(updateMemberQuery);
            console.log('✅ Updated member data with frontend values', { ms: Date.now() - updateMemberStart });
          } catch (e) {
            console.error('❌ Error updating oe.Members with frontend values:', {
              message: e?.message,
              code: e?.code,
              number: e?.number,
              state: e?.state,
              class: e?.class,
              serverName: e?.serverName,
              procName: e?.procName,
              lineNumber: e?.lineNumber,
              ms: Date.now() - updateMemberStart
            });
            // If we're blocked, don't fail the whole enrollment; defer update until after commit
            if (e?.number === 1222) {
              deferredMemberFrontendUpdate = {
                memberId: finalMemberId,
                modifiedBy: member.UserId,
                tobaccoUse: memberInfo?.tobaccoUse || null,
                tier: memberTier || null,
                dateOfBirth: memberInfo?.dateOfBirth ? new Date(memberInfo.dateOfBirth) : null,
                gender: memberInfo?.gender || null,
                address: memberInfo?.address || null,
                city: memberInfo?.city || null,
                state: memberInfo?.state || null,
                zip: memberInfo?.zip || null,
                ssn: encryptedSSNForUpdate,
                height: memberInfo?.height != null ? parseInt(memberInfo.height) : null,
                weight: memberInfo?.weight != null ? parseInt(memberInfo.weight) : null
              };
              console.warn('⚠️ Deferring oe.Members update until after commit due to lock contention');
            } else {
              throw e;
            }
          }
          
          // Also update the Users table for name and contact info
          if (memberInfo && (memberInfo.firstName || memberInfo.lastName || memberInfo.phone)) {
            const updateUserRequest = transaction.request();
            updateUserRequest.input('userId', sql.UniqueIdentifier, member.UserId);
            let userUpdateFields = [];
            
            if (memberInfo.firstName) {
              userUpdateFields.push('FirstName = @userFirstName');
              updateUserRequest.input('userFirstName', sql.NVarChar, memberInfo.firstName);
            }
            if (memberInfo.lastName) {
              userUpdateFields.push('LastName = @userLastName');
              updateUserRequest.input('userLastName', sql.NVarChar, memberInfo.lastName);
            }
            if (memberInfo.phone) {
              userUpdateFields.push('PhoneNumber = @userPhoneNumber');
              updateUserRequest.input('userPhoneNumber', sql.NVarChar, memberInfo.phone);
            }
            
            if (userUpdateFields.length > 0) {
              userUpdateFields.push('ModifiedDate = GETUTCDATE()');
              
              const updateUserQuery = `
                SET LOCK_TIMEOUT 10000;
                UPDATE oe.Users 
                SET ${userUpdateFields.join(', ')}
                WHERE UserId = @userId
              `;
              
              console.log('🔍 DEBUG: About to update oe.Users with frontend values:', {
                userId: member.UserId,
                userUpdateFields: userUpdateFields
              });
              const updateUserStart = Date.now();
              updateUserRequest.timeout = 15000;
              try {
                await updateUserRequest.query(updateUserQuery);
                console.log('✅ Updated user data with frontend values', { ms: Date.now() - updateUserStart });
              } catch (e) {
                console.error('❌ Error updating oe.Users with frontend values:', {
                  message: e?.message,
                  code: e?.code,
                  number: e?.number,
                  state: e?.state,
                  class: e?.class,
                  serverName: e?.serverName,
                  procName: e?.procName,
                  lineNumber: e?.lineNumber,
                  ms: Date.now() - updateUserStart
                });
                if (e?.number === 1222) {
                  deferredUserFrontendUpdate = {
                    userId: member.UserId,
                    firstName: memberInfo?.firstName || null,
                    lastName: memberInfo?.lastName || null,
                    phoneNumber: memberInfo?.phone || null
                  };
                  console.warn('⚠️ Deferring oe.Users update until after commit due to lock contention');
                } else {
                  throw e;
                }
              }
            }
          }
          
          // Update the member object with new values for pricing calculations
          if (memberInfo?.tobaccoUse) {
            const tobaccoMapping = {
              'N': 'N', 'Y': 'Y', 'No': 'N', 'Yes': 'Y'
            };
            member.TobaccoUse = tobaccoMapping[memberInfo.tobaccoUse] || 'N';
          }
          if (memberTier) {
            member.Tier = memberTier;
          }
          if (memberInfo?.dateOfBirth) {
            member.DateOfBirth = memberInfo.dateOfBirth;
          }
          if (memberInfo?.gender) {
            member.Gender = memberInfo.gender;
          }
        }
      }
      
      // 2. Handle dependent members - check for existing ones first, create new ones only if needed
      const createdDependents = [];
      const updatedDependents = [];
      
      if (dependents && Array.isArray(dependents)) {
        for (const dependent of dependents) {
          // Defense-in-depth: the top-of-route INCOMPLETE_DEPENDENT guard already rejects these,
          // but if a future code path bypasses that guard, fail loudly instead of silently skipping.
          if (!dependent?.firstName || !dependent?.lastName || !dependent?.dateOfBirth || !dependent?.relationship) {
            console.error('🚨 [complete-enrollment] Incomplete dependent reached write loop — should have been rejected earlier', {
              firstName: dependent?.firstName || '',
              lastName: dependent?.lastName || '',
              dateOfBirth: dependent?.dateOfBirth || '',
              relationship: dependent?.relationship || dependent?.relationshipType || ''
            });
            throw new Error('Incomplete dependent record reached write loop. Aborting to prevent charging for missing dependents.');
          }
          {
            
            // First, check if this dependent already exists (different logic for group vs individual)
            let existingDependentQuery, existingDependentRequest, existingDependentResult;
            
            if (isGroupEnrollment) {
              // Group enrollment: check if dependent exists in the group
              existingDependentQuery = `
                SELECT 
                  m.MemberId,
                  m.UserId,
                  m.Status,
                  m.RelationshipType,
                  u.FirstName,
                  u.LastName,
                  u.Email
                FROM oe.Members m
                JOIN oe.Users u ON m.UserId = u.UserId
                WHERE m.GroupId = @groupId 
                  AND m.RelationshipType = @relationshipType
                  AND u.FirstName = @firstName 
                  AND u.LastName = @lastName
                  AND m.DateOfBirth = @dateOfBirth
                  AND m.Status = 'Active'
              `;
              
              existingDependentRequest = transaction.request();
              existingDependentRequest.input('groupId', sql.UniqueIdentifier, enrollmentLink.GroupId);
              existingDependentRequest.input('relationshipType', sql.NVarChar, dependent.relationship === 'Spouse' ? 'S' : 'C');
              existingDependentRequest.input('firstName', sql.NVarChar, dependent.firstName);
              existingDependentRequest.input('lastName', sql.NVarChar, dependent.lastName);
              existingDependentRequest.input('dateOfBirth', sql.Date, dependent.dateOfBirth);
            } else {
              // Individual enrollment: check if dependent exists for this member (no group requirement)
              existingDependentQuery = `
                SELECT 
                  m.MemberId,
                  m.UserId,
                  m.Status,
                  m.RelationshipType,
                  u.FirstName,
                  u.LastName,
                  u.Email
                FROM oe.Members m
                JOIN oe.Users u ON m.UserId = u.UserId
                WHERE m.RelationshipType = @relationshipType
                  AND u.FirstName = @firstName 
                  AND u.LastName = @lastName
                  AND m.DateOfBirth = @dateOfBirth
                  AND m.Status = 'Active'
              `;
              
              existingDependentRequest = transaction.request();
              existingDependentRequest.input('relationshipType', sql.NVarChar, dependent.relationship === 'Spouse' ? 'S' : 'C');
              existingDependentRequest.input('firstName', sql.NVarChar, dependent.firstName);
              existingDependentRequest.input('lastName', sql.NVarChar, dependent.lastName);
              existingDependentRequest.input('dateOfBirth', sql.Date, dependent.dateOfBirth);
            }
            
            // First, check if memberId is provided (for existing dependents from census import)
            let existingDependent = null;
            if (dependent.memberId) {
              const memberIdRequest = transaction.request();
              memberIdRequest.input('memberId', sql.UniqueIdentifier, dependent.memberId);
              const memberIdResult = await memberIdRequest.query(`
                SELECT 
                  m.MemberId,
                  m.UserId,
                  m.Status,
                  m.RelationshipType,
                  u.FirstName,
                  u.LastName,
                  u.Email
                FROM oe.Members m
                JOIN oe.Users u ON m.UserId = u.UserId
                WHERE m.MemberId = @memberId
                  AND m.Status = 'Active'
              `);
              
              if (memberIdResult.recordset.length > 0) {
                existingDependent = memberIdResult.recordset[0];
                console.log(`🔄 Found existing dependent by memberId: ${existingDependent.FirstName} ${existingDependent.LastName} (${existingDependent.MemberId})`);
              }
            }
            
            // If not found by memberId, try the original query
            if (!existingDependent) {
              existingDependentResult = await existingDependentRequest.query(existingDependentQuery);
              if (existingDependentResult.recordset.length > 0) {
                existingDependent = existingDependentResult.recordset[0];
                console.log(`🔄 Found existing dependent by name/DOB: ${existingDependent.FirstName} ${existingDependent.LastName} (${existingDependent.MemberId})`);
              }
            }
            
            if (existingDependent) {
              // Dependent already exists - update their information
              console.log(`🔄 Updating existing dependent: ${existingDependent.FirstName} ${existingDependent.LastName} (${existingDependent.MemberId})`);
              
              // Update Users table (firstName, lastName, email)
              const updateUserRequest = transaction.request();
              updateUserRequest.input('userId', sql.UniqueIdentifier, existingDependent.UserId);
              updateUserRequest.input('firstName', sql.NVarChar, dependent.firstName);
              updateUserRequest.input('lastName', sql.NVarChar, dependent.lastName);
              
              // Update email if provided (for spouses), otherwise keep existing or generate default
              let dependentEmail = dependent.email;
              if (!dependentEmail || dependentEmail.trim() === '') {
                // Keep existing email if it's not a default, otherwise generate new default
                if (existingDependent.Email && !existingDependent.Email.includes('@noemail.com')) {
                  dependentEmail = existingDependent.Email;
                } else {
                  dependentEmail = `dependent-${existingDependent.UserId}@noemail.com`;
                }
              }
              updateUserRequest.input('email', sql.NVarChar, dependentEmail);
              
              await updateUserRequest.query(`
                UPDATE oe.Users 
                SET FirstName = @firstName,
                    LastName = @lastName,
                    Email = @email,
                    ModifiedDate = GETUTCDATE()
                WHERE UserId = @userId
              `);
              
              // Update Members table (dateOfBirth, relationshipType, tier, gender, SSN)
              const updateDependentRequest = transaction.request();
              updateDependentRequest.input('memberId', sql.UniqueIdentifier, existingDependent.MemberId);
              updateDependentRequest.input('dateOfBirth', sql.Date, dependent.dateOfBirth);
              updateDependentRequest.input('relationshipType', sql.NVarChar, dependent.relationship === 'Spouse' ? 'S' : 'C');
              updateDependentRequest.input('tier', sql.NVarChar, 'EF'); // Employee Family tier
              updateDependentRequest.input('gender', sql.NVarChar, dependent.gender || null);
              // Format and encrypt SSN before saving
              const encryptedDependentSSN = formatAndEncryptSSN(dependent.ssn);
              updateDependentRequest.input('ssn', sql.NVarChar, encryptedDependentSSN);
              
              await updateDependentRequest.query(`
                UPDATE oe.Members 
                SET DateOfBirth = @dateOfBirth,
                    RelationshipType = @relationshipType,
                    Tier = @tier,
                    Gender = @gender,
                    SSN = @ssn,
                    ModifiedDate = GETUTCDATE()
                WHERE MemberId = @memberId
              `);
              
              updatedDependents.push({
                memberId: existingDependent.MemberId,
                firstName: dependent.firstName,
                lastName: dependent.lastName,
                relationship: dependent.relationship,
                action: 'updated'
              });
              
              console.log(`✅ Updated existing dependent: ${dependent.firstName} ${dependent.lastName}`);
              
            } else {
              // Dependent doesn't exist - create new one
              console.log(`🆕 Creating new dependent: ${dependent.firstName} ${dependent.lastName}`);
              
              // Create user account for dependent
              const dependentUserId = require('crypto').randomUUID();
              const dependentPassword = require('crypto').randomBytes(8).toString('hex'); // Temporary password
              
              // ✅ Use async hash for better performance
              const passwordHash = await bcrypt.hash(dependentPassword, 10);
              
              const createUserRequest = transaction.request();
              createUserRequest.input('userId', sql.UniqueIdentifier, dependentUserId);
              createUserRequest.input('firstName', sql.NVarChar, dependent.firstName);
              createUserRequest.input('lastName', sql.NVarChar, dependent.lastName);
              // ✅ Use unique UUID-based email (matches product-changes-complete.js pattern)
              createUserRequest.input('email', sql.NVarChar, `dependent-${dependentUserId}@noemail.com`);
              createUserRequest.input('passwordHash', sql.NVarChar, passwordHash);
              createUserRequest.input('tenantId', sql.UniqueIdentifier, enrollmentLink.TenantId);
              createUserRequest.input('status', sql.NVarChar, 'Active');
              
              console.log(`📝 Creating user account for dependent: ${dependent.firstName} ${dependent.lastName}`);
              
              await createUserRequest.query(`
                INSERT INTO oe.Users (UserId, FirstName, LastName, Email, PasswordHash, TenantId, Status, CreatedDate, ModifiedDate)
                VALUES (@userId, @firstName, @lastName, @email, @passwordHash, @tenantId, @status, GETUTCDATE(), GETUTCDATE())
              `);
              
              console.log(`✅ User account created for dependent: ${dependentUserId}`);
              
              // Assign Member role manually (can't use UserRolesService inside transaction - it creates its own transaction causing deadlock)
              console.log(`🔑 Assigning Member role to dependent: ${dependentUserId}`);
              
              // Get Member role ID
              const memberRoleRequest = transaction.request();
              memberRoleRequest.input('roleName', sql.NVarChar, 'Member');
              const memberRoleResult = await memberRoleRequest.query(`
                SELECT RoleId FROM oe.Roles WHERE Name = @roleName
              `);
              
              if (memberRoleResult.recordset.length === 0) {
                throw new Error('Member role not found in oe.Roles table');
              }
              
              const memberRoleId = memberRoleResult.recordset[0].RoleId;
              
              // Insert UserRole record
              const userRoleId = require('crypto').randomUUID();
              const assignRoleRequest = transaction.request();
              assignRoleRequest.input('userRoleId', sql.UniqueIdentifier, userRoleId);
              assignRoleRequest.input('userId', sql.UniqueIdentifier, dependentUserId);
              assignRoleRequest.input('roleId', sql.UniqueIdentifier, memberRoleId);
              assignRoleRequest.input('createdBy', sql.UniqueIdentifier, member.UserId);
              
              await assignRoleRequest.query(`
                INSERT INTO oe.UserRoles (UserRoleId, UserId, RoleId, CreatedDate, CreatedBy)
                VALUES (@userRoleId, @userId, @roleId, GETUTCDATE(), @createdBy)
              `);
              
              console.log(`✅ Member role assigned to dependent`);
              
              // Create dependent member record
              const dependentMemberId = require('crypto').randomUUID();
              console.log(`📝 Creating member record for dependent: ${dependentMemberId}`);
              
              const createDependentRequest = transaction.request();
              createDependentRequest.input('memberId', sql.UniqueIdentifier, dependentMemberId);
              createDependentRequest.input('userId', sql.UniqueIdentifier, dependentUserId);
              createDependentRequest.input('dateOfBirth', sql.Date, dependent.dateOfBirth);
              createDependentRequest.input('relationshipType', sql.NVarChar, dependent.relationship === 'Spouse' ? 'S' : 'C'); // Map to valid values
              createDependentRequest.input('status', sql.NVarChar, 'Active');
              createDependentRequest.input('tenantId', sql.UniqueIdentifier, enrollmentLink.TenantId);
              createDependentRequest.input('agentId', sql.UniqueIdentifier, member.AgentId);
              createDependentRequest.input('enrollmentType', sql.NVarChar, 'Dependent');
              createDependentRequest.input('tier', sql.NVarChar, 'EF'); // Employee Family tier
              createDependentRequest.input('gender', sql.NVarChar, dependent.gender || null); // NEW: Add gender
              // Format and encrypt SSN before saving
              const encryptedDependentSSN = formatAndEncryptSSN(dependent.ssn);
              createDependentRequest.input('ssn', sql.NVarChar, encryptedDependentSSN);
              // ✅ CRITICAL: Set HouseholdId to link dependent with primary member
              createDependentRequest.input('householdId', sql.UniqueIdentifier, member.HouseholdId);
              
              console.log(`🔍 Dependent member creation params:`, {
                memberId: dependentMemberId,
                userId: dependentUserId,
                relationshipType: dependent.relationship === 'Spouse' ? 'S' : 'C',
                agentId: member.AgentId,
                householdId: member.HouseholdId,
                isGroupEnrollment
              });
              
              // Handle GroupId based on enrollment type
              if (isGroupEnrollment) {
                createDependentRequest.input('groupId', sql.UniqueIdentifier, enrollmentLink.GroupId);
                
                await createDependentRequest.query(`
                  INSERT INTO oe.Members (
                    MemberId, UserId, GroupId, HouseholdId, DateOfBirth, 
                    RelationshipType, Status, TenantId, AgentId, EnrollmentType, Tier, Gender, SSN,
                    CreatedDate, ModifiedDate
                  )
                  VALUES (
                    @memberId, @userId, @groupId, @householdId, @dateOfBirth,
                    @relationshipType, @status, @tenantId, @agentId, @enrollmentType, @tier, @gender, @ssn,
                    GETUTCDATE(), GETUTCDATE()
                  )
                `);
              } else {
                // Individual enrollment: no GroupId required but MUST have HouseholdId
                console.log(`📝 Inserting dependent member record (individual enrollment)...`);
                
                await createDependentRequest.query(`
                  INSERT INTO oe.Members (
                    MemberId, UserId, HouseholdId, DateOfBirth, 
                    RelationshipType, Status, TenantId, AgentId, EnrollmentType, Tier, Gender, SSN,
                    CreatedDate, ModifiedDate
                  )
                  VALUES (
                    @memberId, @userId, @householdId, @dateOfBirth,
                    @relationshipType, @status, @tenantId, @agentId, @enrollmentType, @tier, @gender, @ssn,
                    GETUTCDATE(), GETUTCDATE()
                  )
                `);
                
                console.log(`✅ Member record inserted for dependent: ${dependentMemberId}`);
              }
              
              createdDependents.push({
                memberId: dependentMemberId,
                firstName: dependent.firstName,
                lastName: dependent.lastName,
                relationship: dependent.relationship,
                action: 'created'
              });
              
              console.log(`✅ Created new dependent: ${dependent.firstName} ${dependent.lastName}`);
            }
          }
        }
      }
      
      // 3. Get all household members for enrollment creation
      const allHouseholdMembers = [member]; // Start with primary member
      
      // Add dependents to household members list
      if (createdDependents && createdDependents.length > 0) {
        for (const dependent of createdDependents) {
          // Get the created dependent member details
          const dependentMemberQuery = `
            SELECT m.*, u.FirstName, u.LastName, u.Email
            FROM oe.Members m
            JOIN oe.Users u ON m.UserId = u.UserId
            WHERE m.MemberId = @memberId
          `;
          
          const dependentMemberRequest = transaction.request();
          dependentMemberRequest.input('memberId', sql.UniqueIdentifier, dependent.memberId);
          const dependentMemberResult = await dependentMemberRequest.query(dependentMemberQuery);
          
          if (dependentMemberResult.recordset.length > 0) {
            allHouseholdMembers.push(dependentMemberResult.recordset[0]);
          }
        }
      }
      
      // Update primary member's Tier to reflect submitted household answers (new or existing member).
      // This must not rely on current DB status filters because newly created primaries can be Pending Payment.
      if (member?.MemberId) {
        const dependentsFromRequest = Array.isArray(dependents) ? dependents : [];
        const hasSpouseFromAnswers = dependentsFromRequest.some((d) => {
          const rel = String(d?.relationshipType || d?.relationship || '').toUpperCase();
          return rel === 'S' || rel === 'SPOUSE';
        });
        const childrenCountFromAnswers = dependentsFromRequest.filter((d) => {
          const rel = String(d?.relationshipType || d?.relationship || '').toUpperCase();
          return rel === 'C' || rel === 'CHILD';
        }).length;

        const hasSpouse = hasSpouseFromAnswers || allHouseholdMembers.some(m => String(m?.RelationshipType || '').toUpperCase() === 'S');
        const childrenCount = Math.max(
          childrenCountFromAnswers,
          allHouseholdMembers.filter(m => String(m?.RelationshipType || '').toUpperCase() === 'C').length
        );

        const primaryTier = hasSpouse && childrenCount > 0
          ? 'EF'
          : hasSpouse
            ? 'ES'
            : childrenCount > 0
              ? 'EC'
              : 'EE';

        const updatePrimaryTierRequest = transaction.request();
        updatePrimaryTierRequest.input('memberId', sql.UniqueIdentifier, member.MemberId);
        updatePrimaryTierRequest.input('tier', sql.NVarChar(10), primaryTier);
        await updatePrimaryTierRequest.query(`
          UPDATE oe.Members
          SET Tier = @tier, ModifiedDate = GETDATE()
          WHERE MemberId = @memberId
        `);
        member.Tier = primaryTier;
        console.log(`✅ Updated primary member Tier to ${primaryTier} (spouse=${hasSpouse}, children=${childrenCount})`);
      }
      
      console.log('🔍 All household members for enrollment:', allHouseholdMembers.map(m => ({
        memberId: m.MemberId,
        relationshipType: m.RelationshipType,
        tier: m.Tier
      })));
      
      // 4. Create enrollment records for selected products - check for existing enrollments first
      console.log('🔍 Selected products data:', {
        selectedProducts,
        isArray: Array.isArray(selectedProducts),
        length: selectedProducts ? selectedProducts.length : 'undefined',
        uniqueCount: selectedProducts ? new Set(selectedProducts).size : 'undefined'
      });
      
      const createdEnrollments = [];
      const updatedEnrollments = [];

      const frontendPremiumSumFromPayload = (frontendPricing && Array.isArray(frontendPricing))
        ? frontendPricing.reduce((s, p) => s + (Number(p.monthlyPremium) || 0), 0)
        : NaN;
      // When frontend omits monthly totals (authority-only submits), assume premium > $0 when products are selected so payment hold can still apply.
      const frontendPremiumLooksPositive =
        Number.isFinite(frontendPremiumSumFromPayload) ? frontendPremiumSumFromPayload > 0 : true;
      const usePaymentHoldForIndividualEnrollments = Boolean(
        !enrollmentLink.GroupId &&
        paymentMethod &&
        !skipPaymentProcessing &&
        finalMemberId &&
        frontendPremiumLooksPositive &&
        !chargeFirstResult
      );
      const enrollmentRowStatusForCreate = usePaymentHoldForIndividualEnrollments
        ? ENROLLMENT_STATUS.PAYMENT_HOLD
        : ENROLLMENT_STATUS.ACTIVE;

      // ========================================================================
      // PRICING AUTHORITY FINGERPRINT — monitoring only (non-blocking).
      // Enrollment always uses backend recomputation for charge amounts.
      // ========================================================================
      let pricingFingerprintVerified = false;
      let submitPaymentMethodTypeForPricingMonitor = null;
      if (pricingFingerprint && selectedProducts?.length > 0) {
        try {
          const primaryMemberForFp = allHouseholdMembers.find(m => m.RelationshipType === 'P') || allHouseholdMembers[0];
          if (primaryMemberForFp) {
            const hasSpouseFp = allHouseholdMembers.some(m => m.RelationshipType === 'S');
            const childrenCountFp = allHouseholdMembers.filter(m => m.RelationshipType === 'C').length;
            const derivedTierFp = hasSpouseFp && childrenCountFp > 0
              ? 'EF'
              : hasSpouseFp ? 'ES' : childrenCountFp > 0 ? 'EC' : 'EE';
            // Prefer the wizard's snapshot of memberCriteria when supplied — that's exactly what
            // /contribution-preview hashed. Reconstructing from the DB drifts when stored DOB is
            // bogus or memberInfo doesn't include the fields the wizard collected.
            const ctxCriteria = pricingContext && typeof pricingContext === 'object'
              ? pricingContext.memberCriteria
              : null;
            const fpMemberCriteria = ctxCriteria && typeof ctxCriteria === 'object'
              ? {
                  age: Number(ctxCriteria.age) || 35,
                  tobaccoUse: ctxCriteria.tobaccoUse === 'Yes' || ctxCriteria.tobaccoUse === 'Y' ? 'Yes' : 'No',
                  tier: ctxCriteria.tier || memberTier || derivedTierFp || primaryMemberForFp.Tier || 'EE',
                  householdSize: Number(ctxCriteria.householdSize) || allHouseholdMembers.length
                }
              : {
                  age: getMemberAgeForPricing(primaryMemberForFp.DateOfBirth, 30),
                  tobaccoUse: primaryMemberForFp.TobaccoUse === 'Y' ? 'Yes' : 'No',
                  tier: memberTier || derivedTierFp || primaryMemberForFp.Tier || 'EE',
                  householdSize: allHouseholdMembers.length
                };
            const fpProductSelections = [...new Set(selectedProducts)].map((pid) => {
              const cfgVal = selectedConfigs?.[pid];
              const configValues = cfgVal && cfgVal !== 'Default'
                ? (typeof cfgVal === 'string' ? { configValue1: cfgVal } : cfgVal)
                : {};
              return { productId: pid, configValues };
            });
            const PricingEngine = require('../services/pricing/PricingEngine');
            const fpPricingResult = await PricingEngine.calculatePricing({
              calculationType: 'enrollment',
              memberCriteria: fpMemberCriteria,
              productSelections: fpProductSelections,
              groupId: enrollmentLink.GroupId || undefined,
              effectiveDate: effectiveDate || null
            });
            let fpMethod;
            const ctxMethod = pricingContext && typeof pricingContext === 'object'
              ? pricingContext.paymentMethodType
              : null;
            if (ctxMethod === 'ACH' || ctxMethod === 'Card') {
              fpMethod = ctxMethod;
            } else if (enrollmentLink.GroupId) {
              try {
                const gpmReq = transaction.request();
                gpmReq.input('groupId', sql.UniqueIdentifier, enrollmentLink.GroupId);
                const gpmRes = await gpmReq.query(`
                  SELECT TOP 1 Type
                  FROM oe.GroupPaymentMethods
                  WHERE GroupId = @groupId AND Status = 'Active'
                  ORDER BY IsDefault DESC, CreatedDate DESC
                `);
                const gpmType = gpmRes.recordset?.[0]?.Type;
                fpMethod = gpmType === 'ACH' ? 'ACH' : gpmType ? 'Card' : 'ACH';
              } catch (gpmErr) {
                console.warn('⚠️ Fingerprint verify: failed to load group payment method, defaulting to ACH:', gpmErr?.message);
                fpMethod = 'ACH';
              }
            } else {
              fpMethod = (paymentMethod?.type === 'card' || paymentMethod?.paymentType === 'card') ? 'Card' : 'ACH';
            }
            submitPaymentMethodTypeForPricingMonitor = fpMethod;
            const fpVerify = await pricingAuthority.verifyFingerprint({
              poolOrTransaction: transaction,
              tenantId: enrollmentLink.TenantId,
              pricingProducts: fpPricingResult.products,
              paymentMethodType: fpMethod,
              expectedFingerprint: pricingFingerprint
            });
            pricingFingerprintVerified = fpVerify.matched;
            if (!pricingFingerprintVerified) {
              console.warn('⚠️ PRICING FINGERPRINT DIVERGENCE (non-blocking): continuing enrollment with backend prices', {
                expected: pricingFingerprint,
                actual: fpVerify.actualFingerprint,
                tenantId: enrollmentLink.TenantId,
                linkToken
              });
              const reportId = crypto.randomUUID();
              const monitorDetail = buildEnrollmentPricingMonitorDetail({
                memberCriteria: fpMemberCriteria,
                selectedConfigs,
                paymentMethodType: fpMethod,
                selectedProducts,
                productId: null,
                productName: null,
                backendBreakdownRow: [{ fingerprintActual: fpVerify.actualFingerprint }],
                frontendBreakdownRow: [{ fingerprintExpected: pricingFingerprint }]
              });
              await recordEnrollmentWizardError({
                tenantId: enrollmentLink.TenantId,
                linkToken,
                code: 'PRICING_FINGERPRINT_DIVERGENCE',
                summary: 'Pricing fingerprint mismatch — continuing with backend recomputation',
                severity: 'warning',
                detail: { reportId, ...monitorDetail, expectedFingerprint: pricingFingerprint, actualFingerprint: fpVerify.actualFingerprint }
              });
            } else {
              console.log('✅ PRICING FINGERPRINT VERIFIED', { fingerprint: pricingFingerprint });
            }
          }
        } catch (fpErr) {
          console.warn('⚠️ Pricing fingerprint verification threw — continuing enrollment:', fpErr);
        }
      }

      if (selectedProducts && Array.isArray(selectedProducts) && selectedProducts.length > 0) {
        // Remove duplicates to prevent multiple enrollments for the same product
        const uniqueProductIds = [...new Set(selectedProducts)];
        console.log('🔍 Unique product IDs after deduplication:', uniqueProductIds);
        console.log('🔍 DEBUG: Starting pricing calculation loop for products:', uniqueProductIds);
        let loggedMissingFrontendPricingPayload = false;

        // Load tenant payment processor settings once for pricing validation and included-fee display calculations.
        // FrontendPricing.monthlyPremium represents the DISPLAY premium (base + included fees), so validation must match that.
        const calculateIncludedProcessingFeeForDisplay = includedProcessingFeeUtil.calculateIncludedProcessingFeeForDisplay;
        let paymentProcessorSettingsForValidation = null;
        try {
          const tenantSettingsRequest = transaction.request();
          tenantSettingsRequest.input('tenantId', sql.UniqueIdentifier, enrollmentLink.TenantId);
          const tenantSettingsResult = await tenantSettingsRequest.query(`
            SELECT PaymentProcessorSettings
            FROM oe.Tenants
            WHERE TenantId = @tenantId
          `);
          const raw = tenantSettingsResult.recordset?.[0]?.PaymentProcessorSettings;
          if (raw) {
            try {
              paymentProcessorSettingsForValidation = JSON.parse(raw);
            } catch (e) {
              console.warn('⚠️ Failed to parse PaymentProcessorSettings for pricing validation:', e);
            }
          }
        } catch (e) {
          console.warn('⚠️ Failed to load PaymentProcessorSettings for pricing validation:', e);
        }

        const subscriptionFeeSettingsByProductIdForValidation = new Map();
        const getSubscriptionFeeCfgForValidation = async (pid) => {
          const key = String(pid);
          if (subscriptionFeeSettingsByProductIdForValidation.has(key)) {
            return subscriptionFeeSettingsByProductIdForValidation.get(key);
          }
          const r = { includeProcessingFee: false, roundUpProcessingFee: false };
          try {
            const req2 = transaction.request();
            req2.input('tenantId', sql.UniqueIdentifier, enrollmentLink.TenantId);
            req2.input('productId', sql.UniqueIdentifier, pid);
            const rs = await req2.query(`
              SELECT TOP 1 IncludeProcessingFee, RoundUpProcessingFee
              FROM oe.TenantProductSubscriptions
              WHERE TenantId = @tenantId
                AND ProductId = @productId
                AND SubscriptionStatus IN ('Active', 'Approved')
              ORDER BY CASE WHEN SubscriptionStatus = 'Active' THEN 0 ELSE 1 END
            `);
            if (rs.recordset?.length > 0) {
              const row = rs.recordset[0];
              r.includeProcessingFee = row.IncludeProcessingFee === true || row.IncludeProcessingFee === 1;
              r.roundUpProcessingFee = row.RoundUpProcessingFee === true || row.RoundUpProcessingFee === 1;
            }
          } catch (e) {
            console.warn('⚠️ Failed to load TenantProductSubscriptions fee flags for pricing validation:', { productId: pid, err: e?.message || e });
          }
          subscriptionFeeSettingsByProductIdForValidation.set(key, r);
          return r;
        };
        
        for (const productId of uniqueProductIds) {
          // Get product details including vendor product ID (policy number)
          const productQuery = `
            SELECT ProductId, Name, VendorProductID, IsBundle
            FROM oe.Products
            WHERE ProductId = @productId
          `;
          
          const productRequest = transaction.request();
          productRequest.input('productId', sql.UniqueIdentifier, productId);
          const productResult = await productRequest.query(productQuery);
          
          if (productResult.recordset.length === 0) {
            console.log(`⚠️ Product not found: ${productId}`);
            continue;
          }
          
          const product = productResult.recordset[0];
          console.log(`🔍 Product details: ${product.Name}, VendorProductID: ${product.VendorProductID || 'None'}`);
          
          // Calculate pricing for primary member only (who pays the premium)
          const primaryMember = allHouseholdMembers.find(m => m.RelationshipType === 'P');
          let householdPremium = 0;
          let pricingResult = null;
          
          console.log(`🔍 DEBUG: Starting pricing calculation for product ${productId}:`, {
            hasPrimaryMember: !!primaryMember,
            primaryMemberId: primaryMember?.MemberId,
            selectedConfigs: selectedConfigs,
            frontendPricing: frontendPricing,
            allHouseholdMembers: allHouseholdMembers,
            householdMembersCount: allHouseholdMembers?.length || 0,
            relationshipTypes: allHouseholdMembers?.map(m => ({ 
              memberId: m.MemberId, 
              relationshipType: m.RelationshipType,
              firstName: m.FirstName,
              lastName: m.LastName
            })) || [],
            productName: product.Name,
            isBundle: product.IsBundle
          });
          
          if (primaryMember) {
            console.log(`🔍 DEBUG: Primary member found, proceeding with pricing calculation for ${productId}`);
            try {
              // Prepare member criteria for pricing calculation
              const hasSpouse = allHouseholdMembers.some(m => m.RelationshipType === 'S');
              const childrenCount = allHouseholdMembers.filter(m => m.RelationshipType === 'C').length;
              const derivedTierFromHousehold = hasSpouse && childrenCount > 0
                ? 'EF'
                : hasSpouse
                  ? 'ES'
                  : childrenCount > 0
                    ? 'EC'
                    : 'EE';
              const memberCriteria = {
                age: getMemberAgeForPricing(primaryMember.DateOfBirth, 30),
                tobaccoUse: primaryMember.TobaccoUse === 'Y' ? 'Yes' : 'No',
                // IMPORTANT: derive tier from submitted household shape for validation paths (especially static links)
                tier: memberTier || derivedTierFromHousehold || primaryMember.Tier || 'EE',
                // Add household info for tier calculation
                hasSpouse,
                childrenCount,
                householdSize: allHouseholdMembers.length
              };
              
              console.log('🔍 Pricing criteria for primary member:', memberCriteria);
              
              // Get selected configuration for this product (so fee is calculated on config-aware premium, e.g. 6000 not default 1500)
              // Prefer selectedConfigs[productId]; fallback to frontendPricing[].selectedConfig so backend matches what user selected
              let productConfigValue = selectedConfigs && selectedConfigs[productId] ? selectedConfigs[productId] : null;
              if (!productConfigValue && frontendPricing && Array.isArray(frontendPricing)) {
                const fp = frontendPricing.find(p => p && String(p.productId) === String(productId));
                if (fp && (fp.selectedConfig || fp.selectedConfig === 0)) {
                  productConfigValue = String(fp.selectedConfig);
                  console.log(`🔧 DEBUG: Using frontendPricing.selectedConfig fallback for product ${productId}: ${productConfigValue} (so fee uses config-aware premium)`);
                }
              }
              const configValues = productConfigValue ? { configValue1: productConfigValue } : {};
              
              // Calculate pricing using PricingEngine
              console.log('🔍 Calling PricingEngine.calculateProductPricing with:', {
                productId,
                memberCriteria,
                configValues
              });
              
              console.log(`🔍 DEBUG: Product ${productId} configuration:`, {
                hasSelectedConfigs: !!selectedConfigs,
                productConfig: selectedConfigs?.[productId],
                productConfigValue,
                configValues,
                selectedConfigsKeys: selectedConfigs ? Object.keys(selectedConfigs) : 'undefined'
              });
              
              // Handle bundle products differently
              if (product.IsBundle) {
                console.log(`🔍 DEBUG: Product ${productId} is a bundle, using bundle pricing logic`);
                // For bundles, use the main calculatePricing method which has bundle logic
                const bundleSelections = [{
                  productId: productId,
                  configValues: configValues
                }];
                
                const bundleResults = await PricingEngine.calculatePricing({
                  calculationType: 'enrollment',
                  memberCriteria: memberCriteria,
                  productSelections: bundleSelections,
                  effectiveDate: effectiveDate || null
                });
                
                // Extract the first (and only) result
                pricingResult = bundleResults.products[0];
                
                // For bundles, we need to apply the configuration to the included products
                // The bundle configuration should be applied to configurable included products
                if (pricingResult && pricingResult.includedProducts) {
                  console.log(`🔍 DEBUG: Applying bundle configuration ${configValues.configValue1} to included products`);
                  
                  // Find configurable included products and apply the configuration
                  for (const includedProduct of pricingResult.includedProducts) {
                    if (includedProduct.hasConfigurationFields && includedProduct.availableConfigs.includes(configValues.configValue1)) {
                      console.log(`🔍 DEBUG: Applying configuration ${configValues.configValue1} to ${includedProduct.productName}`);
                      
                      // Find the pricing variation that matches the configuration
                      const matchingVariation = includedProduct.pricingVariations?.find(v => v.configValue === configValues.configValue1);
                      if (matchingVariation) {
                        console.log(`🔍 DEBUG: Found matching variation for ${includedProduct.productName}: $${matchingVariation.monthlyPremium}`);
                        includedProduct.monthlyPremium = matchingVariation.monthlyPremium;
                        includedProduct.basePremium = matchingVariation.basePremium;
                        includedProduct.employeeContribution = matchingVariation.employeeContribution;
                      }
                    }
                  }
                  
                  // Recalculate the total bundle premium
                  const newTotalPremium = pricingResult.includedProducts.reduce((sum, p) => sum + p.monthlyPremium, 0);
                  console.log(`🔍 DEBUG: Recalculated bundle total: $${newTotalPremium} (was $${pricingResult.monthlyPremium})`);
                  pricingResult.monthlyPremium = newTotalPremium;
                  pricingResult.employeeContribution = newTotalPremium;
                }
              } else {
                // Regular product pricing
                pricingResult = await PricingEngine.calculateProductPricing(
                  productId,
                  memberCriteria,
                  configValues, // Use selected configurations in correct format
                  effectiveDate || null
                );
              }
              
              console.log('🔍 PricingEngine result:', pricingResult);
              console.log('🔍 DEBUG: PricingEngine result structure:', {
                hasPricingDetails: !!pricingResult?.pricingDetails,
                pricingDetailsKeys: pricingResult?.pricingDetails ? Object.keys(pricingResult.pricingDetails) : [],
                pricingDetails: pricingResult?.pricingDetails
              });
              
              householdPremium = pricingResult.monthlyPremium || 0;
              console.log(`💰 Calculated household premium: $${householdPremium} for product ${product.Name}`);

              // Non-blocking display vs backend monitoring (enrollment always proceeds on backend-computed amounts).
              let paymentMethodTypeForMonitor = submitPaymentMethodTypeForPricingMonitor;
              if (!paymentMethodTypeForMonitor) {
                const ctxPm = pricingContext && typeof pricingContext === 'object' ? pricingContext.paymentMethodType : null;
                if (ctxPm === 'ACH' || ctxPm === 'Card') {
                  paymentMethodTypeForMonitor = ctxPm;
                } else if (enrollmentLink.GroupId) {
                  try {
                    const gpmReq2 = transaction.request();
                    gpmReq2.input('groupId', sql.UniqueIdentifier, enrollmentLink.GroupId);
                    const gpmRes2 = await gpmReq2.query(`
                      SELECT TOP 1 Type
                      FROM oe.GroupPaymentMethods
                      WHERE GroupId = @groupId AND Status = 'Active'
                      ORDER BY IsDefault DESC, CreatedDate DESC
                    `);
                    const g2 = gpmRes2.recordset?.[0]?.Type;
                    paymentMethodTypeForMonitor = g2 === 'ACH' ? 'ACH' : g2 ? 'Card' : 'ACH';
                  } catch (_) {
                    paymentMethodTypeForMonitor = 'ACH';
                  }
                } else {
                  paymentMethodTypeForMonitor =
                    (paymentMethod?.type === 'card' || paymentMethod?.paymentType === 'card') ? 'Card' : 'ACH';
                }
              }

              const backendBaseAmount = householdPremium;
              let includedProcessingFeeForDisplay = 0;
              const chargeFeeToMemberEnabled = paymentProcessorSettingsForValidation?.chargeFeeToMember === true;

              if (chargeFeeToMemberEnabled && paymentProcessorSettingsForValidation) {
                try {
                  if (product.IsBundle && pricingResult?.includedProducts && Array.isArray(pricingResult.includedProducts)) {
                    for (const included of pricingResult.includedProducts) {
                      const includedPid = included?.productId;
                      if (!includedPid) continue;
                      const cfg = await getSubscriptionFeeCfgForValidation(includedPid);
                      const includeProcessingFee = cfg?.includeProcessingFee === true;
                      if (!includeProcessingFee) continue;

                      const roundUpProcessingFeeEnabled = cfg?.roundUpProcessingFee === true;
                      includedProcessingFeeForDisplay += calculateIncludedProcessingFeeForDisplay(
                        Number(included?.monthlyPremium || 0),
                        paymentProcessorSettingsForValidation,
                        roundUpProcessingFeeEnabled
                      );
                    }
                  } else {
                    const cfg = await getSubscriptionFeeCfgForValidation(productId);
                    const includeProcessingFee = cfg?.includeProcessingFee === true;
                    if (includeProcessingFee) {
                      const roundUpProcessingFeeEnabled = cfg?.roundUpProcessingFee === true;
                      includedProcessingFeeForDisplay += calculateIncludedProcessingFeeForDisplay(
                        Number(backendBaseAmount || 0),
                        paymentProcessorSettingsForValidation,
                        roundUpProcessingFeeEnabled
                      );
                    }
                  }
                } catch (e) {
                  console.warn('⚠️ Failed to compute included processing fee for pricing monitoring:', e);
                }
              }

              includedProcessingFeeForDisplay = Math.round(Number(includedProcessingFeeForDisplay || 0) * 100) / 100;
              const backendAmount = Math.round((backendBaseAmount + includedProcessingFeeForDisplay) * 100) / 100;

              if (pricingFingerprintVerified) {
                console.log(`✅ Skipping display-divergence monitoring for ${product.Name} (fingerprint verified)`);
              } else if (frontendPricing && Array.isArray(frontendPricing)) {
                const frontendProduct = frontendPricing.find(fp =>
                  fp && String(fp.productId).toLowerCase() === String(productId).toLowerCase()
                );
                if (frontendProduct) {
                  const frontendAmount = frontendProduct.monthlyPremium || 0;
                  const difference = Math.abs(Number(frontendAmount) - Number(backendAmount));
                  const tolerance = 0.01;

                  console.log(`🔍 PRICING MONITORING for ${product.Name}:`, {
                    frontendAmount: `$${Number(frontendAmount).toFixed(2)}`,
                    backendBaseAmount: `$${Number(backendBaseAmount).toFixed(2)}`,
                    includedProcessingFeeForDisplay: `$${includedProcessingFeeForDisplay.toFixed(2)}`,
                    backendAmount: `$${backendAmount.toFixed(2)}`,
                    difference: `$${difference.toFixed(2)}`,
                    withinTolerance: difference <= tolerance,
                    selectedConfig: frontendProduct.selectedConfig
                  });

                  if (difference > tolerance) {
                    console.warn(`⚠️ PRICING_DISPLAY_DIVERGENCE (non-blocking): Frontend $${Number(frontendAmount).toFixed(2)} vs Backend $${backendAmount.toFixed(2)}`);
                    const monitorDetail = buildEnrollmentPricingMonitorDetail({
                      memberCriteria,
                      selectedConfigs,
                      paymentMethodType: paymentMethodTypeForMonitor,
                      selectedProducts,
                      productId,
                      productName: product.Name,
                      backendBreakdownRow: [{
                        productId,
                        productName: product.Name,
                        base: backendBaseAmount,
                        includedFee: includedProcessingFeeForDisplay,
                        displayPremium: backendAmount
                      }],
                      frontendBreakdownRow: [{
                        productId,
                        monthlyPremium: frontendAmount,
                        selectedConfig: frontendProduct.selectedConfig ?? null
                      }]
                    });
                    await recordEnrollmentPricingForensicsError(req, {
                      tenantId: enrollmentLink.TenantId,
                      linkToken,
                      code: 'PRICING_DISPLAY_DIVERGENCE',
                      summary: `Pricing display mismatch for ${product.Name}. Frontend: $${Number(frontendAmount).toFixed(2)}, Backend: $${backendAmount.toFixed(2)}`,
                      severity: 'warning',
                      enrollmentLink,
                      memberTier,
                      pricingContext,
                      selectedProducts,
                      selectedConfigs,
                      effectiveDate,
                      amountValidation: {
                        frontendAmount: Number(frontendAmount),
                        backendAmount: Number(backendAmount),
                        backendBaseAmount: Number(backendBaseAmount),
                        includedProcessingFeeForDisplay: Number(includedProcessingFeeForDisplay),
                        difference: Number(difference),
                        tolerance
                      },
                      monitorDetail: {
                        ...monitorDetail,
                        difference,
                        tolerance,
                        code: 'PRICING_DISPLAY_DIVERGENCE'
                      }
                    });
                  }
                } else {
                  console.warn(`⚠️ No frontend pricing row for product ${productId} — monitoring breadcrumb only`);
                  const reportId = crypto.randomUUID();
                  const monitorDetail = buildEnrollmentPricingMonitorDetail({
                    memberCriteria,
                    selectedConfigs,
                    paymentMethodType: paymentMethodTypeForMonitor,
                    selectedProducts,
                    productId,
                    productName: product.Name,
                    backendBreakdownRow: [{
                      productId,
                      productName: product.Name,
                      base: backendBaseAmount,
                      includedFee: includedProcessingFeeForDisplay,
                      displayPremium: backendAmount
                    }],
                    frontendBreakdownRow: []
                  });
                  await recordEnrollmentWizardError({
                    tenantId: enrollmentLink.TenantId,
                    linkToken,
                    code: 'MISSING_FRONTEND_PRICING_PRODUCT',
                    summary: `No frontend pricing payload for ${product.Name}`,
                    severity: 'warning',
                    detail: { reportId, ...monitorDetail }
                  });
                }
              } else if (!pricingFingerprintVerified && !loggedMissingFrontendPricingPayload) {
                loggedMissingFrontendPricingPayload = true;
                console.warn('⚠️ No frontendPricing array supplied — monitoring breadcrumb only (once per enrollment)');
                const reportId = crypto.randomUUID();
                const monitorDetail = buildEnrollmentPricingMonitorDetail({
                  memberCriteria,
                  selectedConfigs,
                  paymentMethodType: paymentMethodTypeForMonitor,
                  selectedProducts,
                  productId: null,
                  productName: null,
                  backendBreakdownRow: [{
                    note: 'per-product breakdown omitted; see enrollment logs'
                  }],
                  frontendBreakdownRow: []
                });
                await recordEnrollmentWizardError({
                  tenantId: enrollmentLink.TenantId,
                  linkToken,
                  code: 'MISSING_FRONTEND_PRICING_PAYLOAD',
                  summary: 'No frontendPricing array on submit — backend pricing used',
                  severity: 'warning',
                  detail: { reportId, ...monitorDetail }
                });
              }
              
            } catch (pricingError) {
              const pricingFailureContext = {
                productId,
                productName: product?.Name || null,
                memberCriteria: memberCriteria
                  ? {
                      tier: memberCriteria.tier,
                      age: memberCriteria.age,
                      tobaccoUse: memberCriteria.tobaccoUse
                    }
                  : null,
                dateOfBirthSubmitted: memberInfo?.dateOfBirth || null,
                dateOfBirthUsedForPricing: primaryMember?.DateOfBirth
                  ? (primaryMember.DateOfBirth instanceof Date
                      ? primaryMember.DateOfBirth.toISOString().split('T')[0]
                      : String(primaryMember.DateOfBirth).split('T')[0])
                  : null,
                effectiveDate: effectiveDate || null,
                memberTier: memberTier || null
              };
              console.error('❌ Error calculating pricing:', pricingError, pricingFailureContext);
              await transaction.rollback();
              const reportId = crypto.randomUUID();
              const errPayload = {
                message: pricingError.message,
                code: 'PRICING_CALCULATION_FAILED',
                reportId,
                details: pricingError.message,
                ...pricingFailureContext
              };
              await recordEnrollmentWizardError({
                tenantId: enrollmentLink.TenantId,
                linkToken,
                code: 'PRICING_CALCULATION_FAILED',
                summary: String(pricingError.message || pricingError),
                detail: {
                  reportId,
                  stack: pricingError.stack,
                  ...pricingFailureContext
                }
              });
              return res.status(400).json({
                success: false,
                message: 'Pricing could not be calculated for this enrollment. Please verify member date of birth and try again, or contact support.',
                error: errPayload
              });
            }
          } else {
            console.log(`⚠️ DEBUG: No primary member found for product ${productId}, using $0 premium`);
            // Set pricingResult to null if no primary member found
            pricingResult = null;
          }
          
          // Handle bundle vs individual product enrollment creation
          if (product.IsBundle) {
            console.log(`🔍 Processing BUNDLE product: ${product.Name} - creating individual enrollments for each component`);
            
            // Get bundle components
            const bundleComponentsQuery = `
              SELECT 
                pb.IncludedProductId,
                pb.SortOrder,
                pb.IsRequired,
                p.Name AS ProductName,
                p.VendorProductID,
                p.Status
              FROM oe.ProductBundles pb
              INNER JOIN oe.Products p ON pb.IncludedProductId = p.ProductId
              WHERE pb.BundleProductId = @bundleProductId
                AND p.Status = 'Active'
              ORDER BY pb.SortOrder
            `;
            
            const bundleRequest = transaction.request();
            bundleRequest.input('bundleProductId', sql.UniqueIdentifier, productId);
            const bundleResult = await bundleRequest.query(bundleComponentsQuery);
            const bundleComponents = bundleResult.recordset;
            
            console.log(`🔍 Bundle ${product.Name} has ${bundleComponents.length} components:`, 
              bundleComponents.map(c => ({ name: c.ProductName, id: c.IncludedProductId, sortOrder: c.SortOrder })));
            
            // Create enrollments for each bundle component
            for (const component of bundleComponents) {
              console.log(`🔍 Processing bundle component: ${component.ProductName}`);
              
              // Calculate pricing for this specific component
              let componentPremium = 0;
              let componentPricingDetails = null;
              if (primaryMember && pricingResult && pricingResult.includedProducts) {
                const componentPricing = pricingResult.includedProducts.find(ip => ip.productId === component.IncludedProductId);
                if (componentPricing) {
                  componentPremium = componentPricing.monthlyPremium || 0;
                  componentPricingDetails = componentPricing.pricingDetails || null; // Extract pricing details from component
                  console.log(`💰 Component ${component.ProductName} premium: $${componentPremium}`);
                  console.log(`📋 Component pricing details:`, componentPricingDetails);
                } else {
                  console.log(`⚠️ No pricing found for component ${component.ProductName} (${component.IncludedProductId})`);
                  console.log(`🔍 Available included products:`, pricingResult.includedProducts.map(ip => ({ id: ip.productId, name: ip.productName, premium: ip.monthlyPremium })));
                }
              } else {
                console.log(`⚠️ Cannot calculate component premium:`, {
                  hasPrimaryMember: !!primaryMember,
                  hasPricingResult: !!pricingResult,
                  hasIncludedProducts: !!(pricingResult && pricingResult.includedProducts)
                });
              }
              
              // Create enrollments for all household members for this component
              for (const householdMember of allHouseholdMembers) {
                const isPrimaryMember = householdMember.RelationshipType === 'P';
                const premiumAmount = isPrimaryMember ? componentPremium : 0;
                
                console.log(`🔍 Creating enrollment for ${householdMember.RelationshipType} member: ${householdMember.MemberId}, Component: ${component.ProductName}, Premium: $${premiumAmount}`);
                
                // Get bundle configuration value (apply bundle's config to its components)
                const bundleConfigValue = selectedConfigs && selectedConfigs[productId] ? selectedConfigs[productId] : null;
                
                await createOrUpdateEnrollment({
                  transaction,
                  householdMember,
                  productId: component.IncludedProductId,
                  productName: component.ProductName,
                  vendorProductId: component.VendorProductID,
                  premiumAmount,
                  isPrimaryMember,
                  member,
                  linkToken,
                  isGroupEnrollment,
                  enrollmentLink,
                  createdEnrollments,
                  updatedEnrollments,
                  productBundleId: productId, // Set the bundle ID for bundle component enrollments
                  configValue: bundleConfigValue, // Pass bundle configuration to component enrollments
                  effectiveDate: effectiveDate, // Pass the effective date from request body
                  pricingDetails: componentPricingDetails, // Pass component pricing details for enrollment snapshot
                  bundleTotalPremium: pricingResult?.monthlyPremium || 0, // Pass bundle total premium for contribution calculation
                  enrollmentRowStatus: enrollmentRowStatusForCreate,
                  questionnaireResponses: questionnaireResponses || null // Pass questionnaire responses
                });
              }
            }
          } else {
            console.log(`🔍 Processing INDIVIDUAL product: ${product.Name}`);
            
            // Extract pricing details from pricing result for individual products
            const pricingDetails = pricingResult?.pricingDetails || null;
            console.log('📋 Individual product pricing details:', pricingDetails);
            console.log('🔍 DEBUG: Extracted pricing details keys:', pricingDetails ? Object.keys(pricingDetails) : 'null');
            
            // Create enrollments for all household members for the individual product
            for (const householdMember of allHouseholdMembers) {
              const isPrimaryMember = householdMember.RelationshipType === 'P';
              const premiumAmount = isPrimaryMember ? householdPremium : 0;
              
              console.log(`🔍 Creating enrollment for ${householdMember.RelationshipType} member: ${householdMember.MemberId}, Product: ${product.Name}, Premium: $${premiumAmount}`);
              
              // Get individual product configuration value
              const productConfigValue = selectedConfigs && selectedConfigs[productId] ? selectedConfigs[productId] : null;
              
              await createOrUpdateEnrollment({
                transaction,
                householdMember,
                productId,
                productName: product.Name,
                vendorProductId: product.VendorProductID,
                premiumAmount,
                isPrimaryMember,
                member,
                linkToken,
                isGroupEnrollment,
                enrollmentLink,
                createdEnrollments,
                updatedEnrollments,
                productBundleId: null, // No bundle ID for individual products
                pricingDetails: pricingDetails, // Pass pricing details for enrollment snapshot
                effectiveDate: effectiveDate, // Pass the effective date from request body
                configValue: productConfigValue, // Pass product configuration
                enrollmentRowStatus: enrollmentRowStatusForCreate,
                questionnaireResponses: questionnaireResponses || null // Pass questionnaire responses
              });
            }
          }
        }
      } else {
        console.log('⚠️ DEBUG: No selected products or selectedProducts is not an array:', {
          selectedProducts,
          isArray: Array.isArray(selectedProducts),
          length: selectedProducts ? selectedProducts.length : 'undefined'
        });
      }
      
      // Create all-products contribution enrollment if applicable (for group enrollments only)
      // Track all-products contribution enrollment info for potential adjustment with processing fees
      let allProductsContributionEnrollmentId = null;
      let allProductsContributionRuleDirection = null;
      let allProductsContributionAmount = 0;
      
      if (isGroupEnrollment && enrollmentLink.GroupId && createdEnrollments.length > 0) {
        try {
          const primaryMember = allHouseholdMembers.find(m => m.RelationshipType === 'P');
          if (primaryMember) {
            // Get all-products contribution rules (include ContributionDirection for MaxEmployee check)
            const allProductsQuery = `
              SELECT TOP 1 
                gc.ContributionId,
                gc.Name,
                gc.ContributionType,
                gc.FlatRateAmount,
                gc.PercentageAmount,
                gc.TierContributions,
                gc.Priority,
                gc.ContributionDirection
              FROM oe.GroupContributions gc
              WHERE gc.GroupId = @groupId
                AND gc.ProductId IS NULL
                AND gc.Status = 'Active'
                AND gc.EffectiveDate <= @effectiveDate
                AND (gc.EndDate IS NULL OR gc.EndDate >= @effectiveDate)
              ORDER BY gc.Priority ASC
            `;
            
            const allProductsRequest = transaction.request();
            allProductsRequest.input('groupId', sql.UniqueIdentifier, enrollmentLink.GroupId);
            allProductsRequest.input('effectiveDate', sql.Date, effectiveDate ? new Date(effectiveDate) : new Date());
            
            const allProductsResult = await allProductsRequest.query(allProductsQuery);
            
            if (allProductsResult.recordset.length > 0) {
              const allProductsRule = allProductsResult.recordset[0];
              console.log(`✅ Found all-products contribution rule: ${allProductsRule.ContributionId}`);
              
              // Store rule direction for potential adjustment with processing fees
              allProductsContributionRuleDirection = allProductsRule.ContributionDirection || 'Employer';
              
              // Calculate total premium from all created enrollments
              const totalPremium = createdEnrollments.reduce((sum, e) => sum + (e.premiumAmount || 0), 0);
              console.log(`💰 Total premium for all products: $${totalPremium.toFixed(2)}`);
              
              // Get actual member data for contribution calculation
              const memberTier = primaryMember.Tier || 'EE';
              const memberDateOfBirth = primaryMember.DateOfBirth;
              const memberTobaccoUse = primaryMember.TobaccoUse || 'N';
              const memberJobPosition = member.JobPosition || primaryMember.JobPosition || undefined;
              const memberAge = memberDateOfBirth 
                ? Math.floor((new Date() - new Date(memberDateOfBirth)) / (365.25 * 24 * 60 * 60 * 1000))
                : 35;
              const tobaccoUseString = memberTobaccoUse === 'Y' ? 'Yes' : 'No';
              
              // Calculate contribution using ContributionCalculator
              const ContributionCalculator = require('../services/pricing/ContributionCalculator');
              const contributionCalcResult = await ContributionCalculator.calculateContributions({
                groupId: enrollmentLink.GroupId,
                productPricingResults: createdEnrollments.map(e => ({
                  productId: e.productId,
                  productName: e.productName || 'Product',
                  monthlyPremium: e.premiumAmount || 0,
                  productType: '',
                  isBundle: false
                })),
                memberCriteria: {
                  age: memberAge,
                  tobaccoUse: tobaccoUseString,
                  tier: memberTier,
                  jobPosition: memberJobPosition
                }
              });
              
              const allProductsContribution = contributionCalcResult.allProductsContribution || 0;
              allProductsContributionAmount = allProductsContribution;
              console.log(`💰 All-products employer contribution: $${allProductsContribution.toFixed(2)} (tier: ${memberTier}, direction: ${allProductsContributionRuleDirection})`);
              
              if (allProductsContribution > 0) {
                // Create enrollment record for all-products contribution
                const allProductsEnrollmentId = crypto.randomUUID();
                allProductsContributionEnrollmentId = allProductsEnrollmentId; // Store for potential adjustment
                const enrollmentAgentId = primaryMember.AgentId || enrollmentLink.AgentId || enrollmentLink.AgencyId || null;
                const enrollmentEffectiveDate = effectiveDate ? new Date(effectiveDate) : new Date();
                
                const allProductsEnrollmentRequest = transaction.request();
                allProductsEnrollmentRequest.input('enrollmentId', sql.UniqueIdentifier, allProductsEnrollmentId);
                allProductsEnrollmentRequest.input('memberId', sql.UniqueIdentifier, primaryMember.MemberId);
                allProductsEnrollmentRequest.input('productId', sql.UniqueIdentifier, '00000000-0000-0000-0000-000000000000'); // Special "All Products" GUID
                allProductsEnrollmentRequest.input('agentId', sql.UniqueIdentifier, enrollmentAgentId);
                allProductsEnrollmentRequest.input('effectiveDate', sql.Date, enrollmentEffectiveDate);
                allProductsEnrollmentRequest.input('premiumAmount', sql.Decimal(19,4), 0); // No premium for virtual enrollment
                allProductsEnrollmentRequest.input('employerContribution', sql.Decimal(19,4), allProductsContribution);
                allProductsEnrollmentRequest.input('contributionId', sql.UniqueIdentifier, allProductsRule.ContributionId);
                allProductsEnrollmentRequest.input('paymentFrequency', sql.NVarChar, 'Monthly');
                allProductsEnrollmentRequest.input('status', sql.NVarChar, 'Active');
                allProductsEnrollmentRequest.input('groupId', sql.UniqueIdentifier, enrollmentLink.GroupId);
                allProductsEnrollmentRequest.input('householdId', sql.UniqueIdentifier, primaryMember.HouseholdId);
                allProductsEnrollmentRequest.input('createdBy', sql.UniqueIdentifier, primaryMember.UserId);
                allProductsEnrollmentRequest.input('modifiedBy', sql.UniqueIdentifier, primaryMember.UserId);
                
                allProductsEnrollmentRequest.input('enrollmentType', sql.NVarChar, 'Contribution');
                
                const allProductsInsertQuery = `
                  INSERT INTO oe.Enrollments (
                    EnrollmentId, MemberId, ProductId, AgentId, Status, EffectiveDate,
                    PremiumAmount, PaymentFrequency, EmployerContributionAmount, ContributionId,
                    GroupId, HouseholdId, EnrollmentType,
                    CreatedDate, ModifiedDate, CreatedBy, ModifiedBy
                  )
                  VALUES (
                    @enrollmentId, @memberId, @productId, @agentId, @status, @effectiveDate,
                    @premiumAmount, @paymentFrequency, @employerContribution, @contributionId,
                    @groupId, @householdId, @enrollmentType,
                    GETUTCDATE(), GETUTCDATE(), @createdBy, @modifiedBy
                  )
                `;
                
                await allProductsEnrollmentRequest.query(allProductsInsertQuery);
                
                console.log(`✅ Created all-products contribution enrollment: ${allProductsEnrollmentId} with contribution $${allProductsContribution.toFixed(2)}`);
                
                // Add to createdEnrollments array for tracking
                createdEnrollments.push({
                  enrollmentId: allProductsEnrollmentId,
                  productId: '00000000-0000-0000-0000-000000000000',
                  productName: 'All Products Contribution',
                  premiumAmount: 0,
                  employerContribution: allProductsContribution
                });
              }
            } else {
              console.log(`ℹ️ No all-products contribution rules found for group ${enrollmentLink.GroupId}`);
            }
          }
        } catch (error) {
          console.error('❌ Error creating all-products contribution enrollment:', error);
          console.error('❌ Error stack:', error.stack);
          // Continue without all-products contribution if creation fails
        }
        
        // Create Contribution enrollment records for product-specific contributions
        // Group by ContributionId so each unique contribution rule gets its own Contribution enrollment
        try {
          // Get primary member from allHouseholdMembers (available in this scope)
          const primaryMemberForContributions = allHouseholdMembers?.find(m => m.RelationshipType === 'P');
          
          if (isGroupEnrollment && enrollmentLink.GroupId && primaryMemberForContributions) {
            // Query for product enrollments with contributions, grouped by ContributionId
            const productContributionsQuery = `
              SELECT 
                ContributionId,
                SUM(EmployerContributionAmount) AS TotalContributionAmount
              FROM oe.Enrollments
              WHERE MemberId = @memberId
                AND EnrollmentType = 'Product'
                AND ProductId != '00000000-0000-0000-0000-000000000000'
                AND EmployerContributionAmount > 0
                AND ContributionId IS NOT NULL
                AND CreatedDate >= DATEADD(SECOND, -10, GETUTCDATE())
              GROUP BY ContributionId
            `;
            
            const productContributionsRequest = transaction.request();
            productContributionsRequest.input('memberId', sql.UniqueIdentifier, primaryMemberForContributions.MemberId);
            const productContributionsResult = await productContributionsRequest.query(productContributionsQuery);
            
            // Create a Contribution enrollment for each unique ContributionId
            for (const contribRow of productContributionsResult.recordset) {
              const contributionId = contribRow.ContributionId;
              const totalContributionAmount = contribRow.TotalContributionAmount || 0;
              
              if (totalContributionAmount > 0) {
                const productSpecificContributionEnrollmentId = crypto.randomUUID();
                const enrollmentAgentId = primaryMemberForContributions.AgentId || enrollmentLink.AgentId || enrollmentLink.AgencyId || null;
                const enrollmentEffectiveDate = effectiveDate ? new Date(effectiveDate) : new Date();
                
                const productSpecificContributionRequest = transaction.request();
                productSpecificContributionRequest.input('enrollmentId', sql.UniqueIdentifier, productSpecificContributionEnrollmentId);
                productSpecificContributionRequest.input('memberId', sql.UniqueIdentifier, primaryMemberForContributions.MemberId);
                productSpecificContributionRequest.input('productId', sql.UniqueIdentifier, '00000000-0000-0000-0000-000000000000'); // Special "All Products" GUID
                productSpecificContributionRequest.input('agentId', sql.UniqueIdentifier, enrollmentAgentId);
                productSpecificContributionRequest.input('effectiveDate', sql.Date, enrollmentEffectiveDate);
                productSpecificContributionRequest.input('premiumAmount', sql.Decimal(19,4), 0); // No premium for virtual enrollment
                productSpecificContributionRequest.input('employerContribution', sql.Decimal(19,4), totalContributionAmount);
                productSpecificContributionRequest.input('contributionId', sql.UniqueIdentifier, contributionId);
                productSpecificContributionRequest.input('paymentFrequency', sql.NVarChar, 'Monthly');
                productSpecificContributionRequest.input('status', sql.NVarChar, 'Active');
                productSpecificContributionRequest.input('groupId', sql.UniqueIdentifier, enrollmentLink.GroupId);
                productSpecificContributionRequest.input('householdId', sql.UniqueIdentifier, primaryMemberForContributions.HouseholdId);
                productSpecificContributionRequest.input('createdBy', sql.UniqueIdentifier, primaryMemberForContributions.UserId);
                productSpecificContributionRequest.input('modifiedBy', sql.UniqueIdentifier, primaryMemberForContributions.UserId);
                productSpecificContributionRequest.input('enrollmentType', sql.NVarChar, 'Contribution');
                
                const productSpecificContributionInsertQuery = `
                  INSERT INTO oe.Enrollments (
                    EnrollmentId, MemberId, ProductId, AgentId, Status, EffectiveDate,
                    PremiumAmount, PaymentFrequency, EmployerContributionAmount, ContributionId,
                    GroupId, HouseholdId, EnrollmentType,
                    CreatedDate, ModifiedDate, CreatedBy, ModifiedBy
                  )
                  VALUES (
                    @enrollmentId, @memberId, @productId, @agentId, @status, @effectiveDate,
                    @premiumAmount, @paymentFrequency, @employerContribution, @contributionId,
                    @groupId, @householdId, @enrollmentType,
                    GETUTCDATE(), GETUTCDATE(), @createdBy, @modifiedBy
                  )
                `;
                
                await productSpecificContributionRequest.query(productSpecificContributionInsertQuery);
                
                console.log(`✅ Created product-specific contribution enrollment: ${productSpecificContributionEnrollmentId} for ContributionId ${contributionId} with total contribution $${totalContributionAmount.toFixed(2)}`);
              }
            }
          }
        } catch (error) {
          console.error('❌ Error creating product-specific contribution enrollment:', error);
          console.error('❌ Error stack:', error.stack);
          // Continue without contribution enrollment if creation fails
        }
      }
      
      // ✅ Track payment method creation results to share between payment processing and database storage blocks
      let paymentMethodCreatedInDime = false;
      let dimePaymentMethodId = null;
      let dimeCustomerIdUsed = null;
      let dimeTokenUsed = null;
      
      // 🔥 Process payment for individual enrollments (after enrollments are created)
      // When chargeFirstResult is set we already charged before the transaction; still run fee creation and validation, skip building deferred context
      // Use finalMemberId for Agent-Static enrollments where memberId is initially null
      if (!enrollmentLink.GroupId && paymentMethod && !skipPaymentProcessing && finalMemberId && createdEnrollments.length > 0) {
        console.log('💳 Processing payment for individual enrollment...');
        
        // Generate idempotency key.
        // For static (Agent-Static / Marketing) links, the same linkToken can be used by many people,
        // so we must key idempotency by (linkToken + person) to avoid cross-user collisions.
        const normalizedEmailForIdem = String(paymentMethod?.email || memberInfo?.email || '')
          .trim()
          .toLowerCase();
        const isStaticReusableLink = enrollmentLink.LinkType === 'Agent-Static' || enrollmentLink.LinkType === 'Marketing';
        const emailHash = normalizedEmailForIdem
          ? crypto.createHash('sha256').update(normalizedEmailForIdem).digest('hex').slice(0, 32)
          : null;
        const idempotencyKey = isStaticReusableLink && emailHash
          ? `enrollment-link-${linkToken}-${emailHash}`
          : `enrollment-link-${linkToken}`;
        
        // Check for existing payments with more sophisticated logic
        const existingPaymentQuery = `
          SELECT 
            p.PaymentId, 
            p.Status, 
            p.ProcessorTransactionId,
            p.Amount,
            p.PaymentDate,
            p.ProcessorResponse,
            CASE 
              WHEN p.Status = 'REFUNDED' THEN 1
              WHEN p.Status = 'FAILED' THEN 1
              WHEN p.Status = 'CANCELLED' THEN 1
              ELSE 0
            END as CanResubmit
          FROM oe.Payments p
          INNER JOIN oe.Enrollments e ON p.EnrollmentId = e.EnrollmentId
          WHERE e.MemberId = @memberId
            AND p.PaymentDate >= DATEADD(day, -1, GETDATE()) -- Within last 24 hours
          ORDER BY p.PaymentDate DESC
        `;
        
        const existingPaymentRequest = transaction.request();
        existingPaymentRequest.input('memberId', sql.UniqueIdentifier, finalMemberId);
        const existingPaymentResult = await existingPaymentRequest.query(existingPaymentQuery);
        
        // Check for successful payments that can't be resubmitted
        // Normalize status check to include both old ('APPROVAL') and new ('Completed') statuses
        const successfulPayments = existingPaymentResult.recordset.filter(p =>
          oePaymentStatus.isSuccessfulPaymentRecordStatus(String(p.Status)) && p.CanResubmit === 0
        );
        
        if (successfulPayments.length > 0) {
          console.log('⚠️ Payment already processed for this member, skipping duplicate payment');
          await transaction.rollback();
          return res.status(400).json({
            success: false,
            message: 'Payment already processed for this enrollment',
            error: {
              code: 'DUPLICATE_PAYMENT',
              details: 'This enrollment has already been paid for. Please refresh the page to see your enrollment status.',
              existingPayment: {
                paymentId: successfulPayments[0].PaymentId,
                status: successfulPayments[0].Status,
                amount: successfulPayments[0].Amount,
                paymentDate: successfulPayments[0].PaymentDate
              }
            }
          });
        }
        
        // Check for recent failed payments to prevent rapid retries
        const recentFailedPayments = existingPaymentResult.recordset.filter(p => 
          ['FAILED', 'DECLINED'].includes(p.Status) && 
          p.PaymentDate >= new Date(Date.now() - 5 * 60 * 1000) // Last 5 minutes
        );
        
        if (recentFailedPayments.length > 0) {
          console.log('⚠️ Recent failed payment detected, preventing rapid retry');
          await transaction.rollback();
          return res.status(429).json({
            success: false,
            message: 'Please wait before retrying payment',
            error: {
              code: 'RATE_LIMITED',
              details: 'A payment attempt failed recently. Please wait a few minutes before trying again.',
              retryAfter: 300 // 5 minutes
            }
          });
        }
        
        try {
          // Calculate base premium from created enrollments (BEFORE any contributions or deductions)
          // This ensures fees are calculated on the full premium, not the employee contribution amount.
          // NOTE: "Included processing fee" (if enabled per product subscription) will be folded into premium below.
          const NON_PRODUCT_PRODUCT_ID = '00000000-0000-0000-0000-000000000000';
          const basePremiumByProductId = new Map();
          const basePremium = createdEnrollments
            .filter(e => e.productId !== NON_PRODUCT_PRODUCT_ID) // Exclude non-product enrollments
            .reduce((sum, e) => {
              const amt = Number(e.premiumAmount || 0);
              sum += amt;
              const pid = e.productId;
              if (pid) {
                basePremiumByProductId.set(pid, (basePremiumByProductId.get(pid) || 0) + amt);
              }
              return sum;
            }, 0);
          console.log(`💰 Total household premium (before contributions): $${basePremium.toFixed(2)}`);
          
          // Route fee composition through pricingAuthority (single source of truth).
          // Authority loads PaymentProcessorSettings + TenantProductSubscriptions internally and
          // computes included + non-included processing fees + system fees consistently.
          const primaryPersistAuthorityOutput = await pricingAuthority.computePricing({
            poolOrTransaction: transaction,
            tenantId: enrollmentLink.TenantId,
            pricingProducts: Array.from(basePremiumByProductId.entries())
              .map(([productId, monthlyPremium]) => ({ productId, monthlyPremium: Number(monthlyPremium || 0) })),
            paymentMethodType: paymentMethod.paymentMethodType || 'Card'
          });
          const paymentProcessorSettings = primaryPersistAuthorityOutput._raw.paymentProcessorSettings;
          req._enrollmentPaymentProcessorFlags = {
            chargeFirstPaymentWithRecurring:
              paymentProcessorSettings?.chargeFirstPaymentWithRecurring !== false,
            chargeFeeToMember: paymentProcessorSettings?.chargeFeeToMember === true,
            skipPaymentProcessing: !!skipPaymentProcessing,
            chargeFirstResult: !!chargeFirstResult,
            isGroupLink: !!enrollmentLink.GroupId,
            linkType: enrollmentLink.LinkType || null
          };
          const subscriptionFeeSettingsByProductId = primaryPersistAuthorityOutput._raw.subscriptionFeeSettingsByProductId;
          const processingFeeBreakdown = primaryPersistAuthorityOutput._raw.feeBreakdown;
          const chargeFeeToMemberEnabled = primaryPersistAuthorityOutput._raw.chargeFeeToMemberEnabled;
          const includedProcessingFeeTotal = Number(primaryPersistAuthorityOutput.totals.includedFeeTotal || 0);
          const nonIncludedPremiumSubtotal = Number(processingFeeBreakdown.nonIncludedPremiumSubtotal || 0);
          const nonIncludedPaymentProcessingFeeAmount = Number(primaryPersistAuthorityOutput.totals.nonIncludedFeeTotal || 0);
          const systemFeesAmount = Number(primaryPersistAuthorityOutput.totals.systemFees || 0);

          // Persist included processing fees onto the product enrollment row (prefer primary member enrollment).
          // Note: PremiumAmount remains the base product premium. The Included* columns are used for UI display math.
          if (includedProcessingFeeTotal > 0) {
            const primaryMemberQuery = `
              SELECT TOP 1 m.MemberId, m.HouseholdId, m.AgentId, m.UserId
              FROM oe.Members m
              WHERE m.HouseholdId = (
                SELECT HouseholdId 
                FROM oe.Members 
                WHERE MemberId = @memberId
              )
              AND m.RelationshipType = 'P'
            `;
            const primaryMemberRequest = transaction.request();
            primaryMemberRequest.input('memberId', sql.UniqueIdentifier, finalMemberId);
            const primaryMemberResult = await primaryMemberRequest.query(primaryMemberQuery);
            const primaryMember = primaryMemberResult.recordset[0];

            if (primaryMember) {
              for (const [productId, productPremium] of basePremiumByProductId.entries()) {
                const cfg = subscriptionFeeSettingsByProductId.get(String(productId));
                const includeProcessingFee = chargeFeeToMemberEnabled && cfg?.includeProcessingFee === true;
                if (!includeProcessingFee) continue;

                const includedFeeForProduct = Number(
                  processingFeeBreakdown.includedProcessingFeeByProductId[String(productId)] || 0
                );
                if (includedFeeForProduct <= 0) continue;

                // Prefer primary member enrollment for this product; fallback to any enrollment for the product
                const target = createdEnrollments.find(e => e.productId === productId && e.memberId === primaryMember.MemberId)
                  || createdEnrollments.find(e => e.productId === productId);
                if (!target?.enrollmentId) continue;

                const updateIncludedRequest = transaction.request();
                updateIncludedRequest.input('enrollmentId', sql.UniqueIdentifier, target.enrollmentId);
                updateIncludedRequest.input('delta', sql.Decimal(19, 4), includedFeeForProduct);
                /** @deprecated Legacy display column — prefer MSRP-baked PremiumAmount (includedFeeDeprecation.js). */
                await updateIncludedRequest.query(`
                  UPDATE oe.Enrollments
                    SET IncludedPaymentProcessingFeeAmount = COALESCE(IncludedPaymentProcessingFeeAmount, 0) + @delta,
                      ModifiedDate = GETUTCDATE()
                  WHERE EnrollmentId = @enrollmentId
                `);
              }
            }
          }

          // Total premium shown in the UI (base premium + included processing fees; display only)
          const totalPremium = Math.round((basePremium + includedProcessingFeeTotal) * 100) / 100;

          // System fees: already set above (custom system fee override or tenant calculation)
          
          // Calculate payment processing fee on the NON-included subtotal only (this is the remainder shown on the Fees line)

          // PPF enrollment row stores non-included remainder only; included fee lives on product rows.
          const paymentProcessingFeeRemainderForRow = Math.round(Number(nonIncludedPaymentProcessingFeeAmount || 0) * 100) / 100;
          const paymentProcessingFeeTotal = Math.round((paymentProcessingFeeRemainderForRow + Number(includedProcessingFeeTotal || 0)) * 100) / 100;
          
          // Combined fees shown on the Fees line (system fee + non-included processing fee remainder)
          const combinedFees = systemFeesAmount + paymentProcessingFeeRemainderForRow;

          // For MaxEmployee rules: employer should cover all fees (system + total processing)
          const totalFeesForMaxEmployee = systemFeesAmount + paymentProcessingFeeTotal;
          
          console.log(`💳 Fees calculated:`, {
            systemFees: `$${systemFeesAmount.toFixed(2)}`,
            paymentProcessingFeeTotal: `$${paymentProcessingFeeTotal.toFixed(2)}`,
            paymentProcessingFeeRemainder: `$${paymentProcessingFeeRemainderForRow.toFixed(2)}`,
            combinedTotal: `$${combinedFees.toFixed(2)}`
          });
          
          // Adjust all-products contribution for MaxEmployee rules when processing fees exist
          // For MaxEmployee rules: employer should cover processing fees so employee doesn't exceed max
          if (allProductsContributionEnrollmentId && allProductsContributionRuleDirection === 'MaxEmployee' && totalFeesForMaxEmployee > 0) {
            try {
              const adjustedContribution = allProductsContributionAmount + totalFeesForMaxEmployee;
              console.log(`💰 Adjusting MaxEmployee all-products contribution: $${allProductsContributionAmount.toFixed(2)} + fees $${totalFeesForMaxEmployee.toFixed(2)} = $${adjustedContribution.toFixed(2)}`);
              
              const adjustContributionRequest = transaction.request();
              adjustContributionRequest.input('enrollmentId', sql.UniqueIdentifier, allProductsContributionEnrollmentId);
              adjustContributionRequest.input('adjustedContribution', sql.Decimal(19,4), adjustedContribution);
              
              await adjustContributionRequest.query(`
                UPDATE oe.Enrollments
                SET EmployerContributionAmount = @adjustedContribution,
                    ModifiedDate = GETUTCDATE()
                WHERE EnrollmentId = @enrollmentId
              `);
              
              console.log(`✅ Updated all-products contribution enrollment ${allProductsContributionEnrollmentId} to include processing fees`);
            } catch (adjustError) {
              console.error('❌ Error adjusting all-products contribution for processing fees:', adjustError);
              // Continue - don't fail enrollment if adjustment fails
            }
          }
          
          // Calculate total SetupFee from selected products for this enrollment
          let totalSetupFee = 0;
          if (selectedProducts && selectedProducts.length > 0) {
            const setupFeeRequest = transaction.request();
            setupFeeRequest.input('tenantId', sql.UniqueIdentifier, enrollmentLink.TenantId);
            // Use parameterized query to prevent SQL injection
            const productIdParams = selectedProducts.map((pid, index) => {
              const paramName = `productId${index}`;
              setupFeeRequest.input(paramName, sql.UniqueIdentifier, pid);
              return `@${paramName}`;
            }).join(',');
            const setupFeeResult = await setupFeeRequest.query(`
              SELECT SUM(COALESCE(SetupFee, 0)) as TotalSetupFee
              FROM oe.TenantProductSubscriptions
              WHERE TenantId = @tenantId
                AND ProductId IN (${productIdParams})
                AND SubscriptionStatus IN ('Active', 'Approved')
            `);
            if (setupFeeResult.recordset.length > 0 && setupFeeResult.recordset[0].TotalSetupFee !== null) {
              totalSetupFee = Number(setupFeeResult.recordset[0].TotalSetupFee) || 0;
            }
            console.log(`💰 Setup fees calculated: $${totalSetupFee.toFixed(2)} for ${selectedProducts.length} product(s)`);
          }
          
          // Calculate total payment amount including combined fees AND setup fees
          const totalPaymentAmount = totalPremium + combinedFees + totalSetupFee;
          console.log(`💰 Total payment amount (premium: $${totalPremium.toFixed(2)} + fees: $${combinedFees.toFixed(2)} + setup fee: $${totalSetupFee.toFixed(2)} = $${totalPaymentAmount.toFixed(2)})`);
          
          // Create fee enrollment records (SystemFee and PaymentProcessingFee)
          // Get primary member and household ID
          const primaryMemberQuery = `
            SELECT TOP 1 m.MemberId, m.HouseholdId, m.AgentId, m.UserId
            FROM oe.Members m
            WHERE m.HouseholdId = (
              SELECT HouseholdId 
              FROM oe.Members 
              WHERE MemberId = @memberId
            )
            AND m.RelationshipType = 'P'
          `;
          const primaryMemberRequest = transaction.request();
          primaryMemberRequest.input('memberId', sql.UniqueIdentifier, finalMemberId);
          const primaryMemberResult = await primaryMemberRequest.query(primaryMemberQuery);
          const primaryMember = primaryMemberResult.recordset[0];
          
          if (primaryMember && (systemFeesAmount > 0 || paymentProcessingFeeRemainderForRow > 0 || totalSetupFee > 0)) {
            await createFeeEnrollmentRecords({
              transaction,
              primaryMember: {
                MemberId: primaryMember.MemberId,
                AgentId: primaryMember.AgentId,
                UserId: primaryMember.UserId || enrollmentLink.UserId
              },
              householdId: primaryMember.HouseholdId,
              totalPremium,
              systemFeesAmount,
              paymentProcessingFeeAmount: paymentProcessingFeeRemainderForRow,
              setupFeeAmount: totalSetupFee,
              effectiveDate: effectiveDate || new Date(),
              enrollmentLink,
              enrollmentRowStatus: enrollmentRowStatusForCreate
            });
          }
          
          // Validate frontend amount matches backend calculation (premium only, not including separate fees)
          const frontendAmount = req.body.frontendCalculatedAmount || 0;
          const amountDifference = Math.abs(totalPremium - frontendAmount);
          
          console.log(`🔍 Amount validation - Frontend: $${frontendAmount}, Backend: $${totalPremium}, Difference: $${amountDifference}`);
          
          if (amountDifference > 0.01) { // Allow for small rounding differences
            throw new Error(`Amount mismatch detected. Frontend calculated: $${frontendAmount.toFixed(2)}, Backend calculated: $${totalPremium.toFixed(2)}. Please refresh the page and try again.`);
          }
          
          // ✅ ALWAYS process payment for enrollment regardless of effective date
          // This charges the first month immediately, even if coverage starts later
          //
          // When chargeFirstResult is set we already charged before the transaction; do not build deferred context (payment stored in transaction before commit).
          // IMPORTANT: Payment processing is intentionally deferred until AFTER the enrollment transaction commits (when not using charge-first).
          if (totalPremium > 0 && !chargeFirstResult) {
            const householdIdForPayment = (await getHouseholdIdForMember(finalMemberId, transaction)).householdId;
            const firstEnrollmentId = createdEnrollments.length > 0 ? createdEnrollments[0].enrollmentId : null;
            
            if (!firstEnrollmentId) {
              throw new Error('No enrollment ID found for payment record');
            }

            deferredIndividualPaymentContext = {
              linkToken,
              idempotencyKey,
              tenantId: enrollmentLink.TenantId,
              finalMemberId,
              householdId: householdIdForPayment,
              firstEnrollmentId,
              totalPremium,
              totalPaymentAmount,
              combinedFees,
              systemFeesAmount,
              paymentProcessingFeeRemainder: paymentProcessingFeeRemainderForRow,
              paymentProcessingFeeTotal: Number(paymentProcessingFeeTotal || 0),
              basePremium,
              totalSetupFee,
              effectiveDate,
              memberInfo,
              paymentMethod,
              frontendPricing,
              // Default ON when unset — see /enrollment-data handler for rationale.
              chargeFirstPaymentWithRecurring: paymentProcessorSettings?.chargeFirstPaymentWithRecurring !== false
            };
            
            console.log('💳 Deferred payment processing until post-commit:', {
              idempotencyKey,
              householdId: householdIdForPayment,
              totalPremium,
              totalPaymentAmount
            });
          } else if (totalPremium > 0 && chargeFirstResult) {
            const householdIdForRecurring = (await getHouseholdIdForMember(finalMemberId, transaction)).householdId;
            chargeFirstIndividualRecurringContext = {
              tenantId: enrollmentLink.TenantId,
              memberId: finalMemberId,
              householdId: householdIdForRecurring,
              memberInfo,
              paymentMethod,
              effectiveDate,
              basePremium,
              paymentProcessingFeeTotal: Number(paymentProcessingFeeTotal || 0),
              systemFeesAmount,
              totalPremium,
              totalSetupFee,
              combinedFees,
              paymentProcessingFeeRemainder: paymentProcessingFeeRemainderForRow,
              dimeCustomerIdHint: chargeFirstResult.customerId || null,
              // Default ON when unset — see /enrollment-data handler for rationale.
              chargeFirstPaymentWithRecurring: paymentProcessorSettings?.chargeFirstPaymentWithRecurring !== false
            };
            console.log('💳 Charge-first: prepared post-commit PM/recurring context:', {
              memberId: finalMemberId,
              householdId: householdIdForRecurring,
              totalPremium,
              totalPaymentAmount
            });
          } else {
            console.log('⚠️ No premium amount to charge for individual enrollment');
          }
          
        } catch (paymentError) {
          console.error('❌ Error preparing deferred payment:', paymentError);
          await transaction.rollback();
          const frontendAmountForLog =
            typeof req.body?.frontendCalculatedAmount === 'number'
              ? req.body.frontendCalculatedAmount
              : Number(req.body?.frontendCalculatedAmount) || 0;
          let backendTotalForLog = null;
          let backendBaseForLog = null;
          let includedFeeForLog = null;
          try {
            backendTotalForLog = typeof totalPremium !== 'undefined' ? totalPremium : null;
            backendBaseForLog = typeof basePremium !== 'undefined' ? basePremium : null;
            includedFeeForLog =
              typeof includedProcessingFeeTotal !== 'undefined' ? includedProcessingFeeTotal : null;
          } catch (_) {
            /* variables may be unset if failure happened early */
          }
          const reportId = await recordEnrollmentPricingForensicsError(req, {
            tenantId: enrollmentLink.TenantId,
            linkToken,
            code: 'PAYMENT_ERROR',
            summary: `Payment preparation: ${paymentError.message}`,
            severity: 'error',
            enrollmentLink,
            memberTier,
            pricingContext,
            selectedProducts,
            selectedConfigs,
            effectiveDate,
            amountValidation: {
              frontendAmount: frontendAmountForLog,
              backendAmount: backendTotalForLog,
              basePremium: backendBaseForLog,
              includedProcessingFeeTotal: includedFeeForLog,
              difference:
                backendTotalForLog != null
                  ? Math.abs(Number(backendTotalForLog) - Number(frontendAmountForLog))
                  : null
            },
            stack: paymentError.stack
          });
          const errPayload = {
            message: paymentError.message,
            code: 'PAYMENT_ERROR',
            reportId,
            details: paymentError.message
          };
          await transaction.rollback();
          return res.status(400).json({
            success: false,
            message: 'Payment preparation failed',
            error: errPayload
          });
        }
      } else if (enrollmentLink.GroupId) {
        console.log('🏢 Group enrollment - skipping payment processing');
      } else {
        console.log('ℹ️ Individual enrollment payment method present but charging is deferred until post-commit');
      }
      
      // ✅ PAYMENT METHOD DATABASE STORAGE (Block 2)
      // ===================================================================
      // This block saves payment method details to our MemberPaymentMethods table
      // 
      // FLOW:
      // 1. If Block 1 processed payment (totalPremium > 0):
      //    - Reuse payment method created in DIME during payment processing
      //    - This ensures we store the SAME payment method ID used for recurring billing
      // 
      // 2. If no payment was processed (totalPremium == 0):
      //    - Create new permanent payment method in DIME
      //    - Store for future use when member makes plan changes
      // 
      // IMPORTANT: For Credit Cards, we need BOTH:
      // - Token (one-time) - created during payment processing  
      // - Payment Method ID (permanent) - created for recurring billing
      // 
      // For Bank Accounts: createBankAccountPaymentMethod creates permanent payment method directly
      // ===================================================================
      // Skip when payment is deferred post-commit OR charge-first: stored PM + recurring are created after commit (same path for both).
      if (paymentMethod && !skipPaymentProcessing && enrollmentLink.TemplateType !== 'Group' && !deferredIndividualPaymentContext && !chargeFirstResult) {
        console.log('💾 Saving payment method to database:', {
          paymentMethodType: paymentMethod.paymentMethodType,
          alreadyCreatedInDime: paymentMethodCreatedInDime,
          hasPaymentMethodId: !!dimePaymentMethodId,
          hasCustomerId: !!dimeCustomerIdUsed
        });
        
        try {
          // Get member information for DIME customer creation
          const memberQuery = `
            SELECT m.MemberId, u.FirstName, u.LastName, u.Email, u.PhoneNumber
            FROM oe.Members m
            INNER JOIN oe.Users u ON m.UserId = u.UserId
            WHERE m.MemberId = @memberId
          `;
          const memberRequest = transaction.request();
          // Use finalMemberId instead of enrollmentLink.MemberId (which is null for Agent-Static/Marketing)
          memberRequest.input('memberId', sql.UniqueIdentifier, finalMemberId);
          const memberResult = await memberRequest.query(memberQuery);

          if (memberResult.recordset.length === 0) {
            throw new Error('Member not found for payment method creation');
          }

          const member = memberResult.recordset[0];

          // Check if member already has a DIME customer ID
          const existingCustomerQuery = `
            SELECT ProcessorCustomerId
            FROM oe.Members
            WHERE MemberId = @memberId
          `;
          const existingCustomerRequest = transaction.request();
          // Use finalMemberId instead of enrollmentLink.MemberId (which is null for Agent-Static/Marketing)
          existingCustomerRequest.input('memberId', sql.UniqueIdentifier, finalMemberId);
          const existingCustomerResult = await existingCustomerRequest.query(existingCustomerQuery);

          let dimeCustomerId = existingCustomerResult.recordset[0]?.ProcessorCustomerId;
          
          // ✅ CRITICAL: Check if Block 1 already created the customer and payment method
          if (paymentMethodCreatedInDime && dimeCustomerIdUsed) {
            console.log('✅ Using payment method created during payment processing (Block 1)');
            dimeCustomerId = dimeCustomerIdUsed;
          }

          // If no customer ID for this member, check if there's an existing customer with this email
          else if (!dimeCustomerId) {
            const existingEmailCustomerQuery = `
              SELECT ProcessorCustomerId
              FROM oe.Members
              WHERE ProcessorCustomerId IS NOT NULL
                AND MemberId IN (
                  SELECT m.MemberId 
                  FROM oe.Members m
                  INNER JOIN oe.Users u ON m.UserId = u.UserId
                  WHERE u.Email = @email
                )
            `;
            const existingEmailCustomerRequest = transaction.request();
            existingEmailCustomerRequest.input('email', sql.NVarChar, member.Email);
            const existingEmailCustomerResult = await existingEmailCustomerRequest.query(existingEmailCustomerQuery);
            
            if (existingEmailCustomerResult.recordset.length > 0) {
              dimeCustomerId = existingEmailCustomerResult.recordset[0].ProcessorCustomerId;
              console.log('✅ Found existing DIME customer for email:', member.Email, 'Customer ID:', dimeCustomerId);
              
              // Update this member with the existing DIME customer ID
              const updateMemberCustomerRequest = transaction.request();
              // Use finalMemberId instead of enrollmentLink.MemberId (which is null for Agent-Static/Marketing)
              updateMemberCustomerRequest.input('memberId', sql.UniqueIdentifier, finalMemberId);
              updateMemberCustomerRequest.input('customerId', sql.NVarChar, dimeCustomerId);
              
              await updateMemberCustomerRequest.query(`
                UPDATE oe.Members 
                SET ProcessorCustomerId = @customerId, ModifiedDate = GETUTCDATE()
                WHERE MemberId = @memberId
              `);
              
              console.log('✅ Updated member with existing DIME customer ID');
            }
          }

          // Create DIME customer if doesn't exist
          if (!dimeCustomerId) {
            // Validate required information before creating DIME customer
            if (!member.FirstName || !member.LastName || !member.Email) {
              await transaction.rollback();
              return res.status(400).json({
                success: false,
                message: 'Missing required member information for DIME customer creation',
                details: {
                  missing: {
                    firstName: !member.FirstName,
                    lastName: !member.LastName,
                    email: !member.Email
                  }
                }
              });
            }

            const customerData = {
              firstName: member.FirstName,
              lastName: member.LastName,
              email: member.Email,
              phone: member.PhoneNumber,
              billingAddress: paymentMethod.billingAddress || memberInfo.address || '',
              billingCity: paymentMethod.billingCity || memberInfo.city || '',
              billingState: paymentMethod.billingState || memberInfo.state || '',
              billingZip: paymentMethod.billingZip || memberInfo.zip || '',
              billingCountry: paymentMethod.billingCountry || 'US'
            };

            const customerResult = await DimeService.createCustomer(customerData, enrollmentLink.TenantId);
            if (!customerResult.success) {
              throw new Error(`Failed to create DIME customer: ${customerResult.message}`);
            }

            dimeCustomerId = customerResult.customerId;

            // Store DIME customer ID in member
            const updateCustomerRequest = transaction.request();
            // Use finalMemberId instead of enrollmentLink.MemberId (which is null for Agent-Static/Marketing)
            updateCustomerRequest.input('memberId', sql.UniqueIdentifier, finalMemberId);
            updateCustomerRequest.input('customerId', sql.NVarChar(255), dimeCustomerId);
            await updateCustomerRequest.query(`
              UPDATE oe.Members 
              SET ProcessorCustomerId = @customerId, ModifiedDate = GETUTCDATE()
              WHERE MemberId = @memberId
            `);
          }

          // Convert MM/YYYY format to separate month/year for DIME
        let processedPaymentMethod = { ...paymentMethod };
        if (paymentMethod.expiryDate && paymentMethod.paymentMethodType === 'Card') {
          const [month, year] = paymentMethod.expiryDate.split('/');
          if (month && year) {
            processedPaymentMethod.expiryMonth = parseInt(month, 10);
              processedPaymentMethod.expiryYear = parseInt(year, 10);
              delete processedPaymentMethod.expiryDate;
            }
          }

          // Tokenize payment method with DIME (or use existing from Block 1)
          let dimeResult;
          
          // ✅ CRITICAL: If Block 1 already created payment method, use those details
          if (paymentMethodCreatedInDime && dimePaymentMethodId) {
            console.log('✅ Using existing payment method from Block 1 - skipping tokenization');
            dimeResult = {
              success: true,
              token: dimeTokenUsed,
              customerId: dimeCustomerIdUsed,
              paymentMethodId: dimePaymentMethodId,
              // Card/bank details will be added below based on payment method type
            };
            
            // Add type-specific details for database storage
            if (paymentMethod.paymentMethodType === 'Card') {
              // Get card brand using DimeService method
              const firstDigit = paymentMethod.cardNumber[0];
              let detectedBrand = 'Unknown';
              if (firstDigit === '4') detectedBrand = 'Visa';
              else if (firstDigit === '5') detectedBrand = 'MasterCard';
              else if (firstDigit === '3') detectedBrand = 'Amex';
              else if (firstDigit === '6') detectedBrand = 'Discover';
              
              dimeResult.cardBrand = paymentMethod.cardBrand || detectedBrand;
              dimeResult.last4 = paymentMethod.cardNumber.slice(-4);
              dimeResult.expiryMonth = processedPaymentMethod.expiryMonth;
              dimeResult.expiryYear = processedPaymentMethod.expiryYear;
            } else if (paymentMethod.paymentMethodType === 'ACH') {
              dimeResult.bankName = paymentMethod.bankName;
              dimeResult.last4 = paymentMethod.accountNumber.slice(-4);
              dimeResult.accountType = paymentMethod.accountType;
            }
          }
          // Otherwise, create new payment method in DIME
          else if (paymentMethod.paymentMethodType === 'ACH') {
            // For ACH, createBankAccountPaymentMethod creates a permanent payment method (not just a token)
            dimeResult = await DimeService.createBankAccountPaymentMethod({
              routingNumber: paymentMethod.routingNumber,
              accountNumber: paymentMethod.accountNumber,
              accountType: paymentMethod.accountType || 'Checking',
              accountHolderName: paymentMethod.accountHolderName || `${member.FirstName} ${member.LastName}`,
              bankName: paymentMethod.bankName,
              billingAddress: {
                address: paymentMethod.billingAddress || memberInfo.address || '',
                address2: paymentMethod.billingAddress2 || '',
                city: paymentMethod.billingCity || memberInfo.city || '',
                state: paymentMethod.billingState || memberInfo.state || '',
                zip: paymentMethod.billingZip || memberInfo.zip || '',
                country: paymentMethod.billingCountry || 'US'
              },
              customerId: dimeCustomerId
            }, enrollmentLink.TenantId);
          } else if (paymentMethod.paymentMethodType === 'Card') {
            console.log('🔍 DEBUG: Raw paymentMethod object:', JSON.stringify(paymentMethod, null, 2));
            console.log('🔍 DEBUG: Processed paymentMethod object:', JSON.stringify(processedPaymentMethod, null, 2));
            console.log('🔍 DEBUG: Credit card tokenization data:', {
              number: paymentMethod.cardNumber,
              expiryMonth: processedPaymentMethod.expiryMonth,
              expiryYear: processedPaymentMethod.expiryYear,
              cvv: paymentMethod.cvv,
              cardholderName: paymentMethod.cardholderName || `${member.FirstName} ${member.LastName}`,
              customerId: dimeCustomerId
            });
            
            // For credit cards without payment, create permanent payment method (not just tokenization)
            // NOTE: If payment was processed (Block 1), this won't run - it will use Block 1's result
            console.log('💳 No payment processed yet - creating permanent payment method for future use');
            dimeResult = await DimeService.createCreditCardPaymentMethod({
              number: paymentMethod.cardNumber,
              expiryMonth: processedPaymentMethod.expiryMonth,
              expiryYear: processedPaymentMethod.expiryYear,
              cvv: paymentMethod.cvv,
              cardholderName: paymentMethod.cardholderName || `${member.FirstName} ${member.LastName}`,
              billingAddress: {
                address: paymentMethod.billingAddress || memberInfo.address || '',
                address2: paymentMethod.billingAddress2 || '',
                city: paymentMethod.billingCity || memberInfo.city || '',
                state: paymentMethod.billingState || memberInfo.state || '',
                zip: paymentMethod.billingZip || memberInfo.zip || '',
                country: paymentMethod.billingCountry || 'US',
                firstName: paymentMethod.cardholderName?.split(' ')[0] || member.FirstName,
                lastName: paymentMethod.cardholderName?.split(' ').slice(1).join(' ') || member.LastName
              },
              customerId: dimeCustomerId
            }, enrollmentLink.TenantId);
          }

          if (!dimeResult.success) {
            console.warn('⚠️ DIME payment method creation failed; saving method locally only:', dimeResult?.error?.message || dimeResult?.message);
            dimeResult = {
              success: false,
              token: null,
              customerId: dimeCustomerId || null,
              paymentMethodId: null
            };
          }
          
          // ✅ CRITICAL: Ensure payment method ID is a string for SQL Server
          if (dimeResult.paymentMethodId !== null && dimeResult.paymentMethodId !== undefined) {
            dimeResult.paymentMethodId = String(dimeResult.paymentMethodId);
            console.log('🔍 DEBUG: Converted payment method ID to string:', dimeResult.paymentMethodId);
          }

          // Store payment method in database with DIME tokens
          console.log('🔍 DEBUG: About to insert payment method with TenantId:', enrollmentLink.TenantId);
          console.log('🔍 DEBUG: Member UserId for CreatedBy:', member.UserId);
          
          // Ensure we have a valid UserId for CreatedBy/ModifiedBy
          let createdByUserId = member.UserId;
          if (!createdByUserId) {
            // Check if a user with this email already exists
            const existingUserQuery = `
              SELECT UserId FROM oe.Users WHERE Email = @email
            `;
            const existingUserRequest = transaction.request();
            existingUserRequest.input('email', sql.NVarChar, member.Email);
            const existingUserResult = await existingUserRequest.query(existingUserQuery);
            
            if (existingUserResult.recordset.length > 0) {
              // Use existing user
              createdByUserId = existingUserResult.recordset[0].UserId;
              console.log('✅ Using existing user account for payment method insertion:', createdByUserId);
              
              // Update member with existing user ID
              const updateMemberRequest = transaction.request();
              // Use finalMemberId instead of enrollmentLink.MemberId (which is null for Agent-Static/Marketing)
              updateMemberRequest.input('memberId', sql.UniqueIdentifier, finalMemberId);
              updateMemberRequest.input('userId', sql.UniqueIdentifier, createdByUserId);
              
              await updateMemberRequest.query(`
                UPDATE oe.Members 
                SET UserId = @userId, ModifiedDate = GETUTCDATE()
                WHERE MemberId = @memberId
              `);
            } else {
              // Create new user account
              const crypto = require('crypto');
              
              createdByUserId = crypto.randomUUID();
              const tempPassword = crypto.randomBytes(16).toString('hex');
              const passwordHash = await bcrypt.hash(tempPassword, 12);
              
              // Create user account (no UserType/Roles fields)
              const createUserRequest = transaction.request();
              createUserRequest.input('userId', sql.UniqueIdentifier, createdByUserId);
              createUserRequest.input('firstName', sql.NVarChar, member.FirstName);
              createUserRequest.input('lastName', sql.NVarChar, member.LastName);
              createUserRequest.input('email', sql.NVarChar, member.Email);
              createUserRequest.input('passwordHash', sql.NVarChar, passwordHash);
              createUserRequest.input('tenantId', sql.UniqueIdentifier, enrollmentLink.TenantId);
              createUserRequest.input('status', sql.NVarChar, 'Active');
              
              await createUserRequest.query(`
                INSERT INTO oe.Users (UserId, FirstName, LastName, Email, PasswordHash, TenantId, Status, CreatedDate, ModifiedDate)
                VALUES (@userId, @firstName, @lastName, @email, @passwordHash, @tenantId, @status, GETUTCDATE(), GETUTCDATE())
              `);
              
              // NOTE: Role assignment removed - will be handled after transaction commits to avoid deadlocks
              
              // Update member with new user ID
              const updateMemberRequest = transaction.request();
              // Use finalMemberId instead of enrollmentLink.MemberId (which is null for Agent-Static/Marketing)
              updateMemberRequest.input('memberId', sql.UniqueIdentifier, finalMemberId);
              updateMemberRequest.input('userId', sql.UniqueIdentifier, createdByUserId);
              
              await updateMemberRequest.query(`
                UPDATE oe.Members 
                SET UserId = @userId, ModifiedDate = GETUTCDATE()
                WHERE MemberId = @memberId
              `);
              
              console.log('✅ Created new user account for payment method insertion:', createdByUserId);
            }
          }
          
          const insertPaymentMethodRequest = transaction.request();
          // Use finalMemberId instead of enrollmentLink.MemberId (which is null for Agent-Static/Marketing)
          insertPaymentMethodRequest.input('memberId', sql.UniqueIdentifier, finalMemberId);
          insertPaymentMethodRequest.input('tenantId', sql.UniqueIdentifier, enrollmentLink.TenantId);
          insertPaymentMethodRequest.input('createdBy', sql.UniqueIdentifier, createdByUserId);
          insertPaymentMethodRequest.input('modifiedBy', sql.UniqueIdentifier, createdByUserId);
          insertPaymentMethodRequest.input('paymentMethodType', sql.NVarChar(20), paymentMethod.paymentMethodType);
          insertPaymentMethodRequest.input('isDefault', sql.Bit, true); // Always default for enrollment
          insertPaymentMethodRequest.input('status', sql.NVarChar(20), 'Active');
          
          // For ACH, DIME doesn't provide a token - set to NULL (column allows NULL)
          const processorToken = dimeResult.token || null;
          const processorCustomerId = dimeResult.customerId || null;
          const processorPaymentMethodId = dimeResult.paymentMethodId ? String(dimeResult.paymentMethodId) : null;
          
          console.log('🔍 DEBUG: Payment method values before insert:', {
            processorToken,
            processorTokenType: typeof processorToken,
            processorCustomerId,
            processorPaymentMethodId,
            paymentMethodType: paymentMethod.paymentMethodType,
            dimeResultKeys: Object.keys(dimeResult || {})
          });
          
          // Use conditional logic to only add processorToken if it exists
          if (processorToken) {
            insertPaymentMethodRequest.input('processorToken', sql.NVarChar(255), processorToken);
          } else {
            insertPaymentMethodRequest.input('processorToken', sql.NVarChar(255), null);
          }
          
          insertPaymentMethodRequest.input('processorCustomerId', sql.NVarChar(255), processorCustomerId);
          insertPaymentMethodRequest.input('processorPaymentMethodId', sql.NVarChar(255), processorPaymentMethodId);
          const encryptedPaymentData = encryptionService.encryptPaymentData(paymentMethod || {});
          insertPaymentMethodRequest.input('cardNumberEncrypted', sql.NVarChar(sql.MAX), encryptedPaymentData.cardNumberEncrypted || null);
          insertPaymentMethodRequest.input('accountNumberEncrypted', sql.NVarChar(sql.MAX), encryptedPaymentData.accountNumberEncrypted || null);
          insertPaymentMethodRequest.input('routingNumberEncrypted', sql.NVarChar(sql.MAX), encryptedPaymentData.routingNumberEncrypted || null);
          // PCI DSS 3.3.1: CVV is never persisted, even encrypted. Drop the bind.

          if (paymentMethod.paymentMethodType === 'ACH') {
            insertPaymentMethodRequest.input('bankName', sql.NVarChar(100), paymentMethod.bankName);
            insertPaymentMethodRequest.input('accountType', sql.NVarChar(20), paymentMethod.accountType);
            insertPaymentMethodRequest.input('accountNumberLast4', sql.NVarChar(4), paymentMethod.accountNumber.slice(-4));
            insertPaymentMethodRequest.input('accountHolderName', sql.NVarChar(100), paymentMethod.accountHolderName);
            insertPaymentMethodRequest.input('routingNumber', sql.NVarChar(20), paymentMethod.routingNumber || null);
            
            // ✅ CRITICAL: Add billing address fields
            insertPaymentMethodRequest.input('billingAddress', sql.NVarChar(255), paymentMethod.billingAddress || '');
            insertPaymentMethodRequest.input('billingAddress2', sql.NVarChar(255), paymentMethod.billingAddress2 || '');
            insertPaymentMethodRequest.input('billingCity', sql.NVarChar(100), paymentMethod.billingCity || '');
            insertPaymentMethodRequest.input('billingState', sql.NVarChar(2), paymentMethod.billingState || '');
            insertPaymentMethodRequest.input('billingZip', sql.NVarChar(10), paymentMethod.billingZip || '');

            await insertPaymentMethodRequest.query(`
              INSERT INTO oe.MemberPaymentMethods (
                MemberId, TenantId, CreatedBy, ModifiedBy, PaymentMethodType, IsDefault, Status,
                BankName, AccountType, AccountNumberLast4, AccountHolderName, RoutingNumber,
                ProcessorToken, ProcessorCustomerId, ProcessorPaymentMethodId,
                BillingAddress, BillingAddress2, BillingCity, BillingState, BillingZip,
                CardNumberEncrypted, AccountNumberEncrypted, RoutingNumberEncrypted,
                CreatedDate, ModifiedDate
              ) VALUES (
                @memberId, @tenantId, @createdBy, @modifiedBy, @paymentMethodType, @isDefault, @status,
                @bankName, @accountType, @accountNumberLast4, @accountHolderName, @routingNumber,
                @processorToken, @processorCustomerId, @processorPaymentMethodId,
                @billingAddress, @billingAddress2, @billingCity, @billingState, @billingZip,
                @cardNumberEncrypted, @accountNumberEncrypted, @routingNumberEncrypted,
                GETUTCDATE(), GETUTCDATE()
              )
            `);
          } else if (paymentMethod.paymentMethodType === 'Card') {
            // Determine card brand
            const cardLast4 = paymentMethod.cardNumber.slice(-4);
            const firstDigit = paymentMethod.cardNumber[0];
            let cardBrand = 'Unknown';
            
            if (firstDigit === '4') cardBrand = 'Visa';
            else if (firstDigit === '5') cardBrand = 'MasterCard';
            else if (firstDigit === '3') cardBrand = 'Amex';
            else if (firstDigit === '6') cardBrand = 'Discover';

            insertPaymentMethodRequest.input('cardBrand', sql.NVarChar(20), cardBrand);
            insertPaymentMethodRequest.input('cardLast4', sql.NVarChar(4), cardLast4);
            insertPaymentMethodRequest.input('expiryMonth', sql.Int, processedPaymentMethod.expiryMonth);
            insertPaymentMethodRequest.input('expiryYear', sql.Int, processedPaymentMethod.expiryYear);
            insertPaymentMethodRequest.input('cardholderName', sql.NVarChar(100), paymentMethod.cardholderName);
            
            // ✅ CRITICAL: Add billing address fields
            insertPaymentMethodRequest.input('billingAddress', sql.NVarChar(255), paymentMethod.billingAddress || '');
            insertPaymentMethodRequest.input('billingAddress2', sql.NVarChar(255), paymentMethod.billingAddress2 || '');
            insertPaymentMethodRequest.input('billingCity', sql.NVarChar(100), paymentMethod.billingCity || '');
            insertPaymentMethodRequest.input('billingState', sql.NVarChar(2), paymentMethod.billingState || '');
            insertPaymentMethodRequest.input('billingZip', sql.NVarChar(10), paymentMethod.billingZip || '');

            await insertPaymentMethodRequest.query(`
              INSERT INTO oe.MemberPaymentMethods (
                MemberId, TenantId, CreatedBy, ModifiedBy, PaymentMethodType, IsDefault, Status,
                CardBrand, CardLast4, ExpiryMonth, ExpiryYear, CardholderName,
                ProcessorToken, ProcessorCustomerId, ProcessorPaymentMethodId,
                BillingAddress, BillingAddress2, BillingCity, BillingState, BillingZip,
                CardNumberEncrypted, AccountNumberEncrypted, RoutingNumberEncrypted,
                CreatedDate, ModifiedDate
              ) VALUES (
                @memberId, @tenantId, @createdBy, @modifiedBy, @paymentMethodType, @isDefault, @status,
                @cardBrand, @cardLast4, @expiryMonth, @expiryYear, @cardholderName,
                @processorToken, @processorCustomerId, @processorPaymentMethodId,
                @billingAddress, @billingAddress2, @billingCity, @billingState, @billingZip,
                @cardNumberEncrypted, @accountNumberEncrypted, @routingNumberEncrypted,
                GETUTCDATE(), GETUTCDATE()
              )
            `);
          }
          
          console.log('✅ Payment method created with DIME tokens for member enrollment');
        } catch (paymentError) {
          console.error('❌ Error processing payment method with DIME:', paymentError);
          // Fail the enrollment if payment method processing fails
          throw new Error(`Payment method processing failed: ${paymentError.message}`);
        }
      } else if (enrollmentLink.TemplateType === 'Group') {
        console.log('🏢 Group enrollment - no payment method required');
      } else {
        console.log('ℹ️ Payment method DB storage skipped (payment handled post-commit or not provided)');
      }
      
      // NEW: Generate PDF BEFORE committing transaction (for compliance)
      let pdfUrl = null;
      let fileUploadId = null;
      
      if (hasSignedAcknowledgementsPayload(acknowledgements, digitalSignature)) {
        console.log('📄 Generating agreements PDF with acknowledgements and signature...');
        
        try {
          // Generate timestamp first for use throughout the PDF generation process
          const timestamp = new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-');
          
          // Prepare product data with names for PDF
          const productDataForPDF = [];
          for (const productId of selectedProducts) {
            const productRequest = transaction.request();
            productRequest.input('productId', sql.UniqueIdentifier, productId);
            
            const productQuery = `
              SELECT 
                p.ProductId,
                p.Name,
                p.IsBundle,
                (SELECT 
                  pb.IncludedProductId,
                  ip.Name AS IncludedProductName,
                  pb.SortOrder
                FROM oe.ProductBundles pb
                INNER JOIN oe.Products ip ON pb.IncludedProductId = ip.ProductId
                WHERE pb.BundleProductId = p.ProductId
                ORDER BY pb.SortOrder
                FOR JSON PATH) AS BundleComponents
              FROM oe.Products p
              WHERE p.ProductId = @productId
            `;
            
            const productResult = await productRequest.query(productQuery);
            if (productResult.recordset.length > 0) {
              const product = productResult.recordset[0];
              const productData = {
                productId: product.ProductId,
                name: product.Name,
                isBundle: product.IsBundle
              };
              
              // If it's a bundle, parse the components
              if (product.IsBundle && product.BundleComponents) {
                try {
                  productData.bundleComponents = JSON.parse(product.BundleComponents);
                } catch (e) {
                  console.warn('Failed to parse bundle components:', e);
                  productData.bundleComponents = [];
                }
              }
              
              productDataForPDF.push(productData);
            }
          }
          
          // Prepare acknowledgement data with actual question texts for PDF
          const acknowledgementsForPDF = [];
          if (acknowledgements && acknowledgements.length > 0) {
            for (const ack of acknowledgements) {
              if (ack.responses && Array.isArray(ack.responses)) {
                for (const response of ack.responses) {
                  // Query for the actual question text
                  const questionRequest = transaction.request();
                  questionRequest.input('productId', sql.UniqueIdentifier, response.productId);
                  
                  const questionQuery = `
                    SELECT AcknowledgementQuestions
                    FROM oe.Products
                    WHERE ProductId = @productId
                  `;
                  
                  const questionResult = await questionRequest.query(questionQuery);
                  if (questionResult.recordset.length > 0 && questionResult.recordset[0].AcknowledgementQuestions) {
                    try {
                      const questions = JSON.parse(questionResult.recordset[0].AcknowledgementQuestions);
                      const matchingQuestion = questions.find(q => q.id === response.questionId);
                      
                      if (matchingQuestion) {
                        acknowledgementsForPDF.push({
                          question: matchingQuestion.question || matchingQuestion.text || matchingQuestion.label,
                          response: response.response
                        });
                      }
                    } catch (e) {
                      console.warn('Failed to parse acknowledgement questions:', e);
                    }
                  }
                }
              }
            }
          }
          
          const pdfBase64 = await generateAgreementsPDF(acknowledgementsForPDF, digitalSignature, memberInfo, productDataForPDF);
          
          // Convert base64 to Buffer for Azure upload
          const pdfBuffer = Buffer.from(pdfBase64, 'base64');
          
          // Create a file object for Azure upload
          const fileObject = {
            buffer: pdfBuffer,
            originalname: `agreements-${timestamp}.pdf`,
            mimetype: 'application/pdf',
            size: pdfBuffer.length
          };
          
          console.log('📤 Uploading PDF to Azure...');
          const { uploadToAzureBlob } = require('./uploads');
          const fileName = `agreements-${memberId}-${timestamp}.pdf`;
          const containerName = 'agreements';
          const blobPath = `users/${memberId}/${fileName}`;
          
          pdfUrl = await uploadToAzureBlob(fileObject, containerName, fileName);
          
          // CRITICAL: Authenticate the PDF URL before sending to frontend
          const { generateAuthenticatedUrl } = require('./uploads');
          try {
            pdfUrl = await generateAuthenticatedUrl(pdfUrl);
            console.log('✅ PDF URL authenticated successfully!');
          } catch (authError) {
            console.error('❌ Failed to authenticate PDF URL:', authError);
            // Continue with original URL if authentication fails
          }
          
          console.log('✅ PDF uploaded successfully!');
          console.log('🔗 PDF LINK FOR TESTING:', pdfUrl);
          console.log('🔗 Direct download link:', pdfUrl);
          
          // NEW: Save PDF to oe.FileUploads table
          const fileUploadRequest = transaction.request();
          fileUploadId = require('crypto').randomUUID();
          
          fileUploadRequest.input('fileId', sql.UniqueIdentifier, fileUploadId);
          fileUploadRequest.input('fileName', sql.NVarChar, `agreements-${timestamp}.pdf`);
          fileUploadRequest.input('storedFileName', sql.NVarChar, fileName);
          fileUploadRequest.input('filePath', sql.NVarChar, pdfUrl);
          fileUploadRequest.input('fileSize', sql.Int, pdfBuffer.length);
          fileUploadRequest.input('mimeType', sql.NVarChar, 'application/pdf');
          fileUploadRequest.input('uploadType', sql.NVarChar, 'member');
          fileUploadRequest.input('entityId', sql.NVarChar, finalMemberId);
          fileUploadRequest.input('category', sql.NVarChar, 'enrollment_agreements');
          fileUploadRequest.input('description', sql.NVarChar, 'Enrollment acknowledgements and agreements');
          fileUploadRequest.input('uploadedBy', sql.UniqueIdentifier, userId);
          fileUploadRequest.input('tenantId', sql.UniqueIdentifier, enrollmentLink.TenantId);
          fileUploadRequest.input('status', sql.NVarChar, 'Active');
          fileUploadRequest.input('createdDate', sql.DateTime2, new Date());
          
          await fileUploadRequest.query(`
            INSERT INTO oe.FileUploads (
              FileId, FileName, StoredFileName, FilePath, FileSize, MimeType,
              UploadType, EntityId, Category, Description, UploadedBy, TenantId, Status, CreatedDate
            ) VALUES (
              @fileId, @fileName, @storedFileName, @filePath, @fileSize, @mimeType,
              @uploadType, @entityId, @category, @description, @uploadedBy, @tenantId, @status, @createdDate
            )
          `);
          
          console.log('✅ PDF saved to oe.FileUploads table with ID:', fileUploadId);
          
          // NEW: Save acknowledgements to oe.EnrollmentAcknowledgements table
          // Note: acknowledgements structure is [{ responses: [{ questionId, productId, response, fieldType }], digitalSignature, timestamp }]
          let totalResponses = 0;
          for (const acknowledgement of acknowledgements) {
            // Loop through each response within the acknowledgement
            if (acknowledgement.responses && Array.isArray(acknowledgement.responses)) {
              for (const response of acknowledgement.responses) {
                const acknowledgementRequest = transaction.request();
                const acknowledgementId = require('crypto').randomUUID();
                
                // Capture IP address from request (prioritize x-forwarded-for for proxied requests)
                const capturedIpAddress = req.headers['x-forwarded-for'] || req.ip || req.connection.remoteAddress || ipAddress || '127.0.0.1';
                const capturedUserAgent = req.headers['user-agent'] || userAgent || 'Unknown';
                
                acknowledgementRequest.input('acknowledgementId', sql.UniqueIdentifier, acknowledgementId);
                acknowledgementRequest.input('linkToken', sql.NVarChar, linkToken);
                acknowledgementRequest.input('memberId', sql.UniqueIdentifier, finalMemberId);
                acknowledgementRequest.input('productId', sql.UniqueIdentifier, response.productId);
                acknowledgementRequest.input('questionId', sql.NVarChar, response.questionId);
                acknowledgementRequest.input('response', sql.NVarChar, response.response.toString());
                acknowledgementRequest.input('digitalSignature', sql.NVarChar, acknowledgement.digitalSignature || digitalSignature);
                acknowledgementRequest.input('signedDate', sql.DateTime2, new Date());
                acknowledgementRequest.input('fileUploadId', sql.UniqueIdentifier, fileUploadId);
                acknowledgementRequest.input('ipAddress', sql.NVarChar, capturedIpAddress);
                acknowledgementRequest.input('userAgent', sql.NVarChar, capturedUserAgent);
                acknowledgementRequest.input('createdDate', sql.DateTime2, new Date());
                
                await acknowledgementRequest.query(`
                  INSERT INTO oe.EnrollmentAcknowledgements (
                    AcknowledgementId, LinkToken, MemberId, ProductId, QuestionId, Response, 
                    DigitalSignature, SignedDate, FileUploadId, IpAddress, UserAgent, CreatedDate
                  ) VALUES (
                    @acknowledgementId, @linkToken, @memberId, @productId, @questionId, @response,
                    @digitalSignature, @signedDate, @fileUploadId, @ipAddress, @userAgent, @createdDate
                  )
                `);
                totalResponses++;
              }
            }
          }
          
          console.log(`✅ Saved ${totalResponses} acknowledgement responses to oe.EnrollmentAcknowledgements table`);
          
          // Store link in oe.Members.SignedAgreements field (for backward compatibility)
          await updateMemberSignedAgreements(finalMemberId, pdfUrl, timestamp, transaction);
          console.log('✅ Signed agreements link stored in database');
          
          // Add PDF URL to payment receipt data if it was generated
          if (paymentReceiptData && pdfUrl) {
            paymentReceiptData.agreementsPdfUrl = pdfUrl;
            console.log('✅ Added agreements PDF URL to payment receipt');
          }
          
        } catch (pdfError) {
          console.error('❌ ERROR: Failed to generate/upload agreements PDF:', pdfError);
          // CRITICAL: PDF generation is required for compliance - fail the enrollment
          try {
            await recordEnrollmentWizardError({
              tenantId: enrollmentLink.TenantId,
              linkToken,
              code: 'AGREEMENTS_PDF_FAILED',
              summary: `Agreements PDF generation failed: ${pdfError?.message || pdfError}`,
              severity: 'error',
              detail: {
                memberId: finalMemberId,
                userId: userId || null,
                stack: pdfError?.stack || null
              }
            });
          } catch (logErr) {
            console.warn('⚠️ Failed to record AGREEMENTS_PDF_FAILED:', logErr?.message || logErr);
          }
          await transaction.rollback();
          return res.status(500).json({
            success: false,
            message: 'Enrollment failed: Could not generate agreements PDF. This is required for compliance.',
            error: pdfError.message
          });
        }
      } else {
        console.log('⚠️ No acknowledgements or digital signature provided in request body');
      }
      
      // 🔍 ALWAYS check for externally signed acknowledgements from AcknowledgementTokens
      // This runs REGARDLESS of whether acknowledgements were provided in request body
      // because user may have signed via email/SMS link
      console.log('🔍 Checking for externally signed acknowledgements from AcknowledgementTokens...');
      const tokenAckQuery = `
        SELECT 
          at.AcknowledgementTokenId,
          at.SignedData,
          at.SignedDate,
          at.IpAddress,
          at.UserAgent
        FROM oe.AcknowledgementTokens at
        WHERE at.LinkToken = @linkToken
          AND at.Status = 'Signed'
          AND at.MemberId IS NULL
      `;
      
      const tokenAckRequest = transaction.request();
      tokenAckRequest.input('linkToken', sql.NVarChar, linkToken);
      const tokenAckResult = await tokenAckRequest.query(tokenAckQuery);
      
      if (tokenAckResult.recordset.length > 0) {
        console.log(`✅ Found ${tokenAckResult.recordset.length} signed acknowledgement(s) from email/SMS - transferring to member ${finalMemberId}`);
        
        for (const tokenAck of tokenAckResult.recordset) {
          try {
            const signedData = JSON.parse(tokenAck.SignedData);
            const responses = signedData.responses || [];
            const fileUploadIdFromToken = signedData.fileUploadId || null;
            
            console.log(`🔍 Processing token ${tokenAck.AcknowledgementTokenId} with ${responses.length} responses`);
            
            for (const response of responses) {
              const transferRequest = transaction.request();
              const transferAckId = require('crypto').randomUUID();
              
              transferRequest.input('acknowledgementId', sql.UniqueIdentifier, transferAckId);
              transferRequest.input('linkToken', sql.NVarChar, linkToken);
              transferRequest.input('memberId', sql.UniqueIdentifier, finalMemberId);
              transferRequest.input('productId', sql.UniqueIdentifier, response.productId);
              transferRequest.input('questionId', sql.NVarChar, response.questionId);
              transferRequest.input('response', sql.NVarChar, response.response.toString());
              transferRequest.input('digitalSignature', sql.NVarChar, signedData.digitalSignature);
              transferRequest.input('signedDate', sql.DateTime2, new Date(tokenAck.SignedDate));
              transferRequest.input('fileUploadId', sql.UniqueIdentifier, fileUploadIdFromToken);
              transferRequest.input('ipAddress', sql.NVarChar, tokenAck.IpAddress);
              transferRequest.input('userAgent', sql.NVarChar, tokenAck.UserAgent);
              transferRequest.input('createdDate', sql.DateTime2, new Date());
              
              await transferRequest.query(`
                INSERT INTO oe.EnrollmentAcknowledgements (
                  AcknowledgementId, LinkToken, MemberId, ProductId, QuestionId, Response,
                  DigitalSignature, SignedDate, FileUploadId, IpAddress, UserAgent, CreatedDate
                ) VALUES (
                  @acknowledgementId, @linkToken, @memberId, @productId, @questionId, @response,
                  @digitalSignature, @signedDate, @fileUploadId, @ipAddress, @userAgent, @createdDate
                )
              `);
            }
            
            // Update the token to link it to the member
            const updateTokenRequest = transaction.request();
            updateTokenRequest.input('acknowledgementTokenId', sql.UniqueIdentifier, tokenAck.AcknowledgementTokenId);
            updateTokenRequest.input('memberId', sql.UniqueIdentifier, finalMemberId);
            
            await updateTokenRequest.query(`
              UPDATE oe.AcknowledgementTokens
              SET MemberId = @memberId,
                  ModifiedDate = GETUTCDATE()
              WHERE AcknowledgementTokenId = @acknowledgementTokenId
            `);
            
            console.log(`✅ Transferred signed acknowledgements from token ${tokenAck.AcknowledgementTokenId} to member ${finalMemberId}`);
          } catch (transferError) {
            console.error('❌ Error transferring token acknowledgements:', transferError);
            // Continue with other tokens even if one fails
          }
        }
      } else {
        console.log('ℹ️ No externally signed acknowledgements found for this enrollment');
      }
      
      // 🚨 SECURITY: Validate that required acknowledgements have been signed
      // Check if any selected products require acknowledgements
      console.log('🔒 SECURITY: Validating required acknowledgements...');
      const ackValidationQuery = `
        -- Get acknowledgements from directly selected products
        SELECT 
          p.ProductId,
          p.Name AS ProductName,
          p.AcknowledgementQuestions
        FROM oe.Products p
        WHERE p.ProductId IN (${selectedProducts.map((_, idx) => `@valProduct${idx}`).join(',')})
          AND p.Status = 'Active'
        
        UNION ALL
        
        -- Get acknowledgements from products included in selected bundles
        SELECT 
          p.ProductId,
          p.Name AS ProductName,
          p.AcknowledgementQuestions
        FROM oe.ProductBundles pb
        INNER JOIN oe.Products p ON pb.IncludedProductId = p.ProductId
        WHERE pb.BundleProductId IN (${selectedProducts.map((_, idx) => `@valProduct${idx}`).join(',')})
          AND p.Status = 'Active'
      `;
      
      const ackValidationRequest = transaction.request();
      selectedProducts.forEach((id, idx) => {
        ackValidationRequest.input(`valProduct${idx}`, sql.UniqueIdentifier, id);
      });
      
      const ackValidationResult = await ackValidationRequest.query(ackValidationQuery);
      
      // Check if any products have required acknowledgements
      const productsRequiringAcknowledgements = [];
      for (const row of ackValidationResult.recordset) {
        if (row.AcknowledgementQuestions) {
          try {
            const questions = JSON.parse(row.AcknowledgementQuestions);
            if (Array.isArray(questions)) {
              const hasRequired = questions.some(q => q.required === true || q.required === 'true');
              if (hasRequired) {
                productsRequiringAcknowledgements.push({
                  productId: row.ProductId,
                  productName: row.ProductName,
                  requiredQuestions: questions.filter(q => q.required === true || q.required === 'true')
                });
              }
            }
          } catch (error) {
            console.error('Error parsing acknowledgements for validation:', row.ProductId, error);
          }
        }
      }
      
      if (productsRequiringAcknowledgements.length > 0) {
        console.log(`🔒 Found ${productsRequiringAcknowledgements.length} product(s) requiring acknowledgements`);
        
        // Check if acknowledgements were actually saved to oe.EnrollmentAcknowledgements
        const savedAcksQuery = `
          SELECT COUNT(*) AS SavedCount
          FROM oe.EnrollmentAcknowledgements
          WHERE MemberId = @memberId
            AND LinkToken = @linkToken
        `;
        
        const savedAcksRequest = transaction.request();
        savedAcksRequest.input('memberId', sql.UniqueIdentifier, finalMemberId);
        savedAcksRequest.input('linkToken', sql.NVarChar, linkToken);
        const savedAcksResult = await savedAcksRequest.query(savedAcksQuery);
        const savedCount = savedAcksResult.recordset[0]?.SavedCount || 0;
        
        if (savedCount === 0) {
          console.error('🚨 SECURITY VIOLATION: Products require acknowledgements but none were signed!');
          console.error('🚨 Products requiring acknowledgements:', productsRequiringAcknowledgements.map(p => p.productName).join(', '));

          await transaction.rollback();

          // Charge-first safety: if card was charged before this validation failure, refund immediately.
          if (chargeFirstResult) {
            const refundOutcome = await DimeService.refundTransaction(
              chargeFirstResult.processorTransactionId,
              chargeFirstResult.totalPaymentAmount,
              chargeFirstResult.tenantId
            );
            console.error('❌ Charge-first: acknowledgement validation failed after charge; refund issued:', refundOutcome.success ? 'OK' : refundOutcome.error?.message);
            return res.status(400).json({
              success: false,
              error: {
                code: 'ENROLLMENT_FAILED_REFUND_ISSUED',
                message: 'Required acknowledgements were not completed. Your payment has been refunded.',
                details: 'Acknowledgements are required for selected products. Payment was reversed.',
                productsRequiringAcknowledgements: productsRequiringAcknowledgements.map(p => p.productName)
              }
            });
          }

          try {
            await recordEnrollmentWizardError({
              tenantId: enrollmentLink.TenantId,
              linkToken,
              code: 'ACKNOWLEDGEMENTS_REQUIRED',
              summary: 'Required acknowledgements were not saved before enrollment commit',
              severity: 'error',
              detail: {
                memberId: finalMemberId,
                savedCount,
                hadSignedPayload: hasSignedAcknowledgementsPayload(acknowledgements, digitalSignature),
                productsRequiringAcknowledgements: productsRequiringAcknowledgements.map(p => p.productName)
              }
            });
          } catch (logErr) {
            console.warn('⚠️ Failed to record ACKNOWLEDGEMENTS_REQUIRED:', logErr?.message || logErr);
          }
          return res.status(400).json({
            success: false,
            error: {
              code: 'ACKNOWLEDGEMENTS_REQUIRED',
              message: 'Selected products require acknowledgements to be signed before enrollment can be completed.',
              productsRequiringAcknowledgements: productsRequiringAcknowledgements.map(p => p.productName)
            }
          });
        }
        
        console.log(`✅ SECURITY: Validation passed - ${savedCount} acknowledgement(s) found for products requiring them`);
      } else {
        console.log('ℹ️ No products require acknowledgements - validation skipped');
      }
      
      // 💾 Save payment receipt HTML document for individual enrollments
      if (!enrollmentLink.GroupId && paymentReceiptData) {
        try {
          console.log('📄 Generating payment receipt HTML document...');
          
          const receiptTimestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0];
          const receiptFileName = `receipt-${finalMemberId}-${receiptTimestamp}.html`;
          
          // Generate receipt HTML matching the modal display
          const receiptHtml = `
<!DOCTYPE html>
<html>
  <head>
    <title>Payment Receipt - ${paymentReceiptData.transactionId || 'Transaction'}</title>
    <style>
      @media print {
        body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      }
      body { 
        font-family: Arial, sans-serif; 
        max-width: 800px; 
        margin: 0 auto; 
        padding: 40px; 
        background: white;
      }
      .header { 
        text-align: center; 
        border-bottom: 3px solid #2563eb; 
        padding-bottom: 20px; 
        margin-bottom: 30px; 
      }
      .header h1 { color: #1e40af; margin: 0 0 10px 0; }
      .section { margin-bottom: 25px; padding: 15px; background: #f9fafb; border-radius: 8px; }
      .section h3 { color: #1f2937; margin: 0 0 15px 0; border-bottom: 2px solid #e5e7eb; padding-bottom: 8px; }
      .row { display: flex; justify-between; padding: 8px 0; }
      .label { font-weight: 600; color: #4b5563; }
      .value { color: #111827; }
      .line-item { display: flex; justify-between; padding: 12px 0; border-bottom: 1px solid #e5e7eb; }
      .total-section { background: #dbeafe; padding: 15px; border-radius: 8px; margin-top: 10px; }
      .total { font-size: 20px; font-weight: bold; display: flex; justify-between; align-items: center; }
      .total .amount { color: #2563eb; }
    </style>
  </head>
  <body>
    <div class="header">
      <h1>Payment Receipt</h1>
      <p style="font-size: 18px; color: #4b5563; margin: 0;">${paymentReceiptData.tenantName}</p>
    </div>
    
    <div class="section">
      <h3>Transaction Details</h3>
      <div class="row">
        <span class="label">Transaction ID: </span>
        <span class="value">${paymentReceiptData.transactionId || 'N/A'}</span>
      </div>
      <div class="row">
        <span class="label">Date: </span>
        <span class="value">${new Date(paymentReceiptData.paymentDate).toLocaleString()}</span>
      </div>
      <div class="row">
        <span class="label">Status: </span>
        <span class="value" style="color: #16a34a; font-weight: 600;">APPROVED</span>
      </div>
    </div>
    
    <div class="section">
      <h3>Member Information</h3>
      <div class="row">
        <span class="label">Name: </span>
        <span class="value">${paymentReceiptData.memberInfo.name}</span>
      </div>
      <div class="row">
        <span class="label">Email: </span>
        <span class="value">${paymentReceiptData.memberInfo.email}</span>
      </div>
      <div class="row">
        <span class="label">Company: </span>
        <span class="value">${paymentReceiptData.tenantName}</span>
      </div>
    </div>
    
    <div class="section">
      <h3>Payment Method</h3>
      <div class="row">
        <span class="label">Type: </span>
        <span class="value">${paymentReceiptData.paymentMethod.brand}</span>
      </div>
      <div class="row">
        <span class="label">Card Number: </span>
        <span class="value">****${paymentReceiptData.paymentMethod.last4}</span>
      </div>
    </div>
    
    <div class="section">
      <h3>Products Enrolled</h3>
      ${paymentReceiptData.products.map(product => `
        <div class="line-item">
          <span class="label">${product.productName}</span>
          <span class="value">$${product.amount.toFixed(2)}/mo</span>
        </div>
      `).join('')}
      <div style="margin-top: 10px; padding: 10px 0; border-top: 1px solid #e5e7eb;">
        <div class="row">
          <span class="label">Subtotal (Monthly Premium):</span>
          <span class="value">$${paymentReceiptData.amount.toFixed(2)}</span>
        </div>
        ${paymentReceiptData.processingFee && paymentReceiptData.processingFee > 0 ? `
          <div class="row">
            <span class="label">Processing Fees:</span>
            <span class="value">$${paymentReceiptData.processingFee.toFixed(2)}</span>
          </div>
        ` : ''}
        ${paymentReceiptData.setupFee && paymentReceiptData.setupFee > 0 ? `
          <div class="row">
            <span class="label">Setup Fees (One-time):</span>
            <span class="value">$${paymentReceiptData.setupFee.toFixed(2)}</span>
          </div>
        ` : ''}
      </div>
      <div class="total-section">
        <div class="total">
          <span>Total Charged: </span>
          <span class="amount">$${(paymentReceiptData.totalAmount || paymentReceiptData.amount).toFixed(2)}</span>
        </div>
      </div>
    </div>
    
    <div style="text-align: center; margin-top: 40px; padding-top: 20px; border-top: 2px solid #e5e7eb; color: #6b7280; font-size: 12px;">
      <p>Thank you for your enrollment!</p>
      <p>If you have questions, please contact your agent or our support team.</p>
    </div>
  </body>
</html>
          `;
          
          const receiptBuffer = Buffer.from(receiptHtml, 'utf8');
          
          // Upload receipt to Azure Blob Storage
          console.log('📤 Uploading receipt HTML to Azure...');
          const { BlobServiceClient } = require('@azure/storage-blob');
          const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
          
          if (!connectionString) {
            throw new Error('Azure Storage connection string not configured');
          }
          
          const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
          const receiptContainerName = 'agreements';
          const receiptContainerClient = blobServiceClient.getContainerClient(receiptContainerName);
          
          // Create container if it doesn't exist
          try {
            await receiptContainerClient.createIfNotExists();
          } catch (error) {
            console.log('⚠️ Container creation warning:', error.message);
          }
          
          const receiptBlockBlobClient = receiptContainerClient.getBlockBlobClient(receiptFileName);
          
          // Upload the receipt HTML with metadata
          await receiptBlockBlobClient.upload(receiptBuffer, receiptBuffer.length, {
            blobHTTPHeaders: {
              blobContentType: 'text/html'
            },
            metadata: {
              originalName: receiptFileName,
              uploadedBy: 'allaboard365-system'
            }
          });
          
          // Extract account name from connection string
          const accountNameMatch = connectionString.match(/AccountName=([^;]+)/);
          const storageAccountName = accountNameMatch ? accountNameMatch[1] : process.env.AZURE_STORAGE_ACCOUNT_NAME || 'oestorage';
          
          const receiptBlobUrl = `https://${storageAccountName}.blob.core.windows.net/${receiptContainerName}/${receiptFileName}`;
          console.log('✅ Receipt HTML uploaded to Azure:', receiptBlobUrl);
          
          // Save receipt to oe.FileUploads table
          const receiptFileUploadRequest = transaction.request();
          const receiptFileId = require('crypto').randomUUID();
          
          receiptFileUploadRequest.input('fileId', sql.UniqueIdentifier, receiptFileId);
          receiptFileUploadRequest.input('fileName', sql.NVarChar, `Payment Receipt - ${receiptTimestamp}.html`);
          receiptFileUploadRequest.input('storedFileName', sql.NVarChar, receiptFileName);
          receiptFileUploadRequest.input('filePath', sql.NVarChar, receiptBlobUrl);
          receiptFileUploadRequest.input('fileSize', sql.Int, receiptBuffer.length);
          receiptFileUploadRequest.input('mimeType', sql.NVarChar, 'text/html');
          receiptFileUploadRequest.input('uploadType', sql.NVarChar, 'member');
          receiptFileUploadRequest.input('entityId', sql.NVarChar, finalMemberId);
          receiptFileUploadRequest.input('category', sql.NVarChar, 'payment_receipt');
          receiptFileUploadRequest.input('description', sql.NVarChar, `Payment receipt for enrollment - $${paymentReceiptData.amount.toFixed(2)} charged on ${new Date(paymentReceiptData.paymentDate).toLocaleDateString()}`);
          receiptFileUploadRequest.input('uploadedBy', sql.UniqueIdentifier, userId);
          receiptFileUploadRequest.input('tenantId', sql.UniqueIdentifier, enrollmentLink.TenantId);
          receiptFileUploadRequest.input('status', sql.NVarChar, 'Active');
          receiptFileUploadRequest.input('createdDate', sql.DateTime2, new Date());
          
          await receiptFileUploadRequest.query(`
            INSERT INTO oe.FileUploads (
              FileId, FileName, StoredFileName, FilePath, FileSize, MimeType,
              UploadType, EntityId, Category, Description, UploadedBy, TenantId, Status, CreatedDate
            ) VALUES (
              @fileId, @fileName, @storedFileName, @filePath, @fileSize, @mimeType,
              @uploadType, @entityId, @category, @description, @uploadedBy, @tenantId, @status, @createdDate
            )
          `);
          
          console.log('✅ Payment receipt saved to oe.FileUploads table with ID:', receiptFileId);
          
        } catch (receiptError) {
          console.error('⚠️ WARNING: Failed to save payment receipt document:', receiptError);
          // Don't fail enrollment if receipt save fails - this is non-critical
        }
      }
      
      // NOTE: Group recurring payments are NOT updated here during enrollment.
      // The oe_payment_manager scheduled job handles all group billing on the 1st of each month.
      // This prevents DIME API calls during enrollment and avoids timeouts.
      // The scheduled job will automatically include new enrollments in the next billing cycle.
      if (enrollmentLink.GroupId && createdEnrollments.length > 0) {
        console.log('🏢 Group enrollment detected - recurring payment will be handled by scheduled job (oe_payment_manager)');
        
        // Calculate and store processing fees for group enrollments (for display on confirmation page)
        // Even though payment isn't processed here, we calculate fees to show on UI
        try {
          // Calculate base premium from created enrollments (BEFORE contributions are deducted)
          // NOTE: "Included processing fee" (if enabled per product subscription) will be folded into premium below.
          const NON_PRODUCT_PRODUCT_ID = '00000000-0000-0000-0000-000000000000';
          const basePremiumByProductId = new Map();
          const basePremium = createdEnrollments
            .filter(e => e.productId !== NON_PRODUCT_PRODUCT_ID) // Exclude non-product enrollments
            .reduce((sum, e) => {
              const amt = Number(e.premiumAmount || 0);
              sum += amt;
              const pid = e.productId;
              if (pid) {
                basePremiumByProductId.set(pid, (basePremiumByProductId.get(pid) || 0) + amt);
              }
              return sum;
            }, 0);
          console.log(`💰 Group enrollment - Total household premium (before contributions): $${basePremium.toFixed(2)}`);
          
          if (basePremium > 0) {
            // Resolve group's primary payment method BEFORE computing fee breakdown (needs paymentMethodType).
            let groupPaymentMethod = 'ACH'; // Default fallback to ACH
            let paymentMethodSource = 'default'; // Track where the payment method came from

            if (enrollmentLink.GroupId) {
              console.log(`🔍 Looking up payment method for group: ${enrollmentLink.GroupId}`);
              const groupPaymentMethodQuery = `
                SELECT TOP 1 Type, IsDefault, PaymentMethodId, CreatedDate
                FROM oe.GroupPaymentMethods
                WHERE GroupId = @groupId
                  AND Status = 'Active'
                ORDER BY IsDefault DESC, CreatedDate DESC
              `;
              const groupPaymentMethodRequest = transaction.request();
              groupPaymentMethodRequest.input('groupId', sql.UniqueIdentifier, enrollmentLink.GroupId);
              const groupPaymentMethodResult = await groupPaymentMethodRequest.query(groupPaymentMethodQuery);

              if (groupPaymentMethodResult.recordset.length > 0) {
                const paymentMethodRecord = groupPaymentMethodResult.recordset[0];
                groupPaymentMethod = paymentMethodRecord.Type || 'ACH';
                paymentMethodSource = paymentMethodRecord.IsDefault ? 'default_payment_method' : 'most_recent_active';
                console.log(`✅ Group payment method found: ${groupPaymentMethod} (Source: ${paymentMethodSource}, PaymentMethodId: ${paymentMethodRecord.PaymentMethodId}, IsDefault: ${paymentMethodRecord.IsDefault})`);
              } else {
                paymentMethodSource = 'fallback_no_payment_methods';
                console.log(`⚠️ No active payment method found for group ${enrollmentLink.GroupId}`);
                console.log(`💡 Using fallback payment method: ACH (default for group enrollments when no payment method is configured)`);
              }
            } else {
              paymentMethodSource = 'fallback_no_group_id';
              console.log(`⚠️ No GroupId in enrollment link, using fallback payment method: ACH`);
            }

            console.log(`💳 Payment method determined for processing fee calculation: ${groupPaymentMethod} (Source: ${paymentMethodSource})`);

            // Route fee composition through pricingAuthority (single source of truth).
            // Authority loads PaymentProcessorSettings + TenantProductSubscriptions internally and
            // computes included + non-included processing fees + system fees consistently.
            const groupPersistAuthorityOutput = await pricingAuthority.computePricing({
              poolOrTransaction: transaction,
              tenantId: enrollmentLink.TenantId,
              pricingProducts: Array.from(basePremiumByProductId.entries())
                .map(([productId, monthlyPremium]) => ({ productId, monthlyPremium: Number(monthlyPremium || 0) })),
              paymentMethodType: groupPaymentMethod
            });
            const paymentProcessorSettings = groupPersistAuthorityOutput._raw.paymentProcessorSettings;
            const subscriptionFeeSettingsByProductId = groupPersistAuthorityOutput._raw.subscriptionFeeSettingsByProductId;
            const processingFeeBreakdown = groupPersistAuthorityOutput._raw.feeBreakdown;
            const chargeFeeToMemberEnabled = groupPersistAuthorityOutput._raw.chargeFeeToMemberEnabled;
            const includedProcessingFeeTotal = Number(groupPersistAuthorityOutput.totals.includedFeeTotal || 0);
            const nonIncludedPremiumSubtotal = Number(processingFeeBreakdown.nonIncludedPremiumSubtotal || 0);
            const nonIncludedPaymentProcessingFeeAmount = Number(groupPersistAuthorityOutput.totals.nonIncludedFeeTotal || 0);
            const systemFeesAmount = Number(groupPersistAuthorityOutput.totals.systemFees || 0);

            // Persist included processing fees onto the product enrollment row (prefer primary member enrollment).
            // Note: PremiumAmount remains the base product premium. The Included* columns are used for UI display math.
            if (includedProcessingFeeTotal > 0) {
              const primaryMemberQuery = `
                SELECT TOP 1 m.MemberId, m.HouseholdId, m.AgentId, m.UserId
                FROM oe.Members m
                WHERE m.HouseholdId = (
                  SELECT HouseholdId 
                  FROM oe.Members 
                  WHERE MemberId = @memberId
                )
                AND m.RelationshipType = 'P'
              `;
              const primaryMemberRequest = transaction.request();
              primaryMemberRequest.input('memberId', sql.UniqueIdentifier, finalMemberId);
              const primaryMemberResult = await primaryMemberRequest.query(primaryMemberQuery);
              const primaryMember = primaryMemberResult.recordset[0];

              if (primaryMember) {
                for (const [productId, productPremium] of basePremiumByProductId.entries()) {
                  const cfg = subscriptionFeeSettingsByProductId.get(String(productId));
                  const includeProcessingFee = chargeFeeToMemberEnabled && cfg?.includeProcessingFee === true;
                  if (!includeProcessingFee) continue;

                  const includedFeeForProduct = Number(
                    processingFeeBreakdown.includedProcessingFeeByProductId[String(productId)] || 0
                  );
                  if (includedFeeForProduct <= 0) continue;

                  const target = createdEnrollments.find(e => e.productId === productId && e.memberId === primaryMember.MemberId)
                    || createdEnrollments.find(e => e.productId === productId);
                  if (!target?.enrollmentId) continue;

                  const updateIncludedRequest = transaction.request();
                  updateIncludedRequest.input('enrollmentId', sql.UniqueIdentifier, target.enrollmentId);
                  updateIncludedRequest.input('delta', sql.Decimal(19, 4), includedFeeForProduct);
                  /** @deprecated Legacy display column — see includedFeeDeprecation.js */
                  await updateIncludedRequest.query(`
                    UPDATE oe.Enrollments
                    SET IncludedPaymentProcessingFeeAmount = COALESCE(IncludedPaymentProcessingFeeAmount, 0) + @delta,
                        ModifiedDate = GETUTCDATE()
                    WHERE EnrollmentId = @enrollmentId
                  `);
                }
              }
            }
            
            // Total premium for display/validation (base premium + included processing fees; display only)
            const totalPremium = Math.round((basePremium + includedProcessingFeeTotal) * 100) / 100;

            // System fees: already set above (custom system fee override or tenant calculation)
            
            // Calculate payment processing fee on the NON-included subtotal (remainder shown on the Fees line)

            // PPF enrollment row stores non-included remainder only; included fee lives on product rows.
            const paymentProcessingFeeRemainderForRow = Math.round(Number(nonIncludedPaymentProcessingFeeAmount || 0) * 100) / 100;
            const paymentProcessingFeeTotal = Math.round((paymentProcessingFeeRemainderForRow + Number(includedProcessingFeeTotal || 0)) * 100) / 100;
            
            // Combined fees shown on the Fees line (system fee + non-included processing fee remainder)
            const combinedFees = systemFeesAmount + paymentProcessingFeeRemainderForRow;

            // For MaxEmployee rules: employer should cover all fees (system + total processing)
            const totalFeesForMaxEmployee = systemFeesAmount + paymentProcessingFeeTotal;
            
            // Adjust all-products contribution for MaxEmployee rules when processing fees exist
            // For MaxEmployee rules: employer should cover processing fees so employee doesn't exceed max
            if (allProductsContributionEnrollmentId && allProductsContributionRuleDirection === 'MaxEmployee' && totalFeesForMaxEmployee > 0) {
              try {
                const adjustedContribution = allProductsContributionAmount + totalFeesForMaxEmployee;
                console.log(`💰 Adjusting MaxEmployee all-products contribution: $${allProductsContributionAmount.toFixed(2)} + fees $${totalFeesForMaxEmployee.toFixed(2)} = $${adjustedContribution.toFixed(2)}`);
                
                const adjustContributionRequest = transaction.request();
                adjustContributionRequest.input('enrollmentId', sql.UniqueIdentifier, allProductsContributionEnrollmentId);
                adjustContributionRequest.input('adjustedContribution', sql.Decimal(19,4), adjustedContribution);
                
                await adjustContributionRequest.query(`
                  UPDATE oe.Enrollments
                  SET EmployerContributionAmount = @adjustedContribution,
                      ModifiedDate = GETUTCDATE()
                  WHERE EnrollmentId = @enrollmentId
                `);
                
                console.log(`✅ Updated all-products contribution enrollment ${allProductsContributionEnrollmentId} to include processing fees`);
              } catch (adjustError) {
                console.error('❌ Error adjusting all-products contribution for processing fees:', adjustError);
                // Continue - don't fail enrollment if adjustment fails
              }
            }
            
            // Calculate total SetupFee from selected products for this enrollment
            let totalSetupFee = 0;
            if (selectedProducts && selectedProducts.length > 0) {
              const setupFeeRequest = transaction.request();
              setupFeeRequest.input('tenantId', sql.UniqueIdentifier, enrollmentLink.TenantId);
              // Use parameterized query to prevent SQL injection
              const productIdParams = selectedProducts.map((pid, index) => {
                const paramName = `productId${index}`;
                setupFeeRequest.input(paramName, sql.UniqueIdentifier, pid);
                return `@${paramName}`;
              }).join(',');
              const setupFeeResult = await setupFeeRequest.query(`
                SELECT SUM(COALESCE(SetupFee, 0)) as TotalSetupFee
                FROM oe.TenantProductSubscriptions
                WHERE TenantId = @tenantId
                  AND ProductId IN (${productIdParams})
                  AND SubscriptionStatus IN ('Active', 'Approved')
              `);
              if (setupFeeResult.recordset.length > 0 && setupFeeResult.recordset[0].TotalSetupFee !== null) {
                totalSetupFee = Number(setupFeeResult.recordset[0].TotalSetupFee) || 0;
              }
              console.log(`💰 Setup fees calculated: $${totalSetupFee.toFixed(2)} for ${selectedProducts.length} product(s)`);
            }
            
            console.log(`💳 Group enrollment - Fees calculated:`, {
              paymentMethod: groupPaymentMethod,
              paymentMethodSource: paymentMethodSource,
              totalPremium: `$${totalPremium.toFixed(2)}`,
              systemFees: `$${systemFeesAmount.toFixed(2)}`,
              paymentProcessingFeeTotal: `$${paymentProcessingFeeTotal.toFixed(2)}`,
              paymentProcessingFeeRemainder: `$${paymentProcessingFeeRemainderForRow.toFixed(2)}`,
              setupFee: `$${totalSetupFee.toFixed(2)}`,
              combinedTotal: `$${combinedFees.toFixed(2)}`,
              chargeFeeToMember: paymentProcessorSettings?.chargeFeeToMember || false
            });
            
            if (paymentMethodSource.includes('fallback')) {
              console.log(`📝 NOTE: Processing fee calculated using fallback payment method (${groupPaymentMethod}) because: ${paymentMethodSource}`);
            }
            
            // Create fee enrollment records (SystemFee, PaymentProcessingFee, and SetupFee)
            // Use the member object we already have instead of querying again
            // For group enrollments, member is already loaded; for new members, it's created earlier in the flow
            if (!member) {
              console.error('❌ Member object not available for fee enrollment records creation');
              throw new Error('Member data not available for fee enrollment records');
            }
            
            console.log(`🔍 Determining primary member for fee records:`, {
              memberId: member.MemberId,
              relationshipType: member.RelationshipType,
              householdId: member.HouseholdId,
              isPrimary: member.RelationshipType === 'P'
            });
            
            // Ensure we have the primary member (RelationshipType = 'P')
            // For group enrollments, member is already the primary member
            // For new members, we need to get the primary member from the household
            let primaryMemberForFees = member;
            
            // If the current member is the primary member, use them directly
            if (member.RelationshipType === 'P') {
              console.log(`✅ Current member ${member.MemberId} is primary, using for fee records.`);
              primaryMemberForFees = member;
            } 
            // If the current member is not the primary member, try to find the primary member
            else if (member.HouseholdId) {
              console.log(`🔍 Current member is not primary (${member.RelationshipType}), attempting to find primary member for household ${member.HouseholdId}`);
              const primaryMemberQuery = `
                SELECT TOP 1 m.MemberId, m.HouseholdId, m.AgentId, m.UserId, m.RelationshipType
                FROM oe.Members m
                WHERE m.HouseholdId = @householdId
                  AND m.RelationshipType = 'P'
              `;
              const primaryMemberRequest = transaction.request();
              primaryMemberRequest.input('householdId', sql.UniqueIdentifier, member.HouseholdId);
              const primaryMemberResult = await primaryMemberRequest.query(primaryMemberQuery);
              
              if (primaryMemberResult.recordset.length > 0) {
                primaryMemberForFees = primaryMemberResult.recordset[0];
                console.log(`✅ Found primary member for fees: ${primaryMemberForFees.MemberId}`);
              } else {
                // If no primary member found, use the current member (might be a new enrollment where member is primary)
                console.warn(`⚠️ No primary member found for household ${member.HouseholdId}, falling back to current member for fee records.`);
                primaryMemberForFees = member;
              }
            } else {
              // No HouseholdId - this might be a new primary member enrollment
              console.warn(`⚠️ Current member ${member.MemberId} has no HouseholdId, cannot determine primary member for fee records. Using current member.`);
              // For new primary members, their HouseholdId might be set to their own MemberId
              // Check if member is primary, and if so, use their MemberId as HouseholdId
              if (member.RelationshipType === 'P') {
                primaryMemberForFees = {
                  ...member,
                  HouseholdId: member.HouseholdId || member.MemberId
                };
                console.log(`✅ Using current member as primary with HouseholdId = MemberId for new enrollment`);
              } else {
                primaryMemberForFees = member;
              }
            }
            
            // Ensure we have a valid HouseholdId for fee records
            const householdIdForFees = primaryMemberForFees.HouseholdId || primaryMemberForFees.MemberId;
            
            if (primaryMemberForFees && (systemFeesAmount > 0 || paymentProcessingFeeRemainderForRow > 0 || totalSetupFee > 0)) {
              console.log(`💰 Creating fee enrollment records for primary member:`, {
                memberId: primaryMemberForFees.MemberId,
                householdId: householdIdForFees,
                systemFees: systemFeesAmount,
                paymentProcessingFee: paymentProcessingFeeRemainderForRow,
                setupFee: totalSetupFee
              });
              
              await createFeeEnrollmentRecords({
                transaction,
                primaryMember: {
                  MemberId: primaryMemberForFees.MemberId,
                  AgentId: primaryMemberForFees.AgentId,
                  UserId: primaryMemberForFees.UserId || enrollmentLink.UserId
                },
                householdId: householdIdForFees,
                totalPremium,
                systemFeesAmount,
                paymentProcessingFeeAmount: paymentProcessingFeeRemainderForRow,
                setupFeeAmount: totalSetupFee,
                effectiveDate: effectiveDate || new Date(),
                enrollmentLink
              });
            } else {
              console.log('ℹ️ No fees to create or primary member not found for fee records.');
            }
          }
        } catch (error) {
          // Log error but don't fail enrollment - processing fee calculation is for display purposes
          console.error('⚠️ Error calculating processing fees for group enrollment:', error);
        }
      }

      // Note: Usage count is NOT incremented here - only when password is set up
      // This keeps the enrollment "pending" until the user completes account setup

      // When charge-first was used, store payment record and set member Active inside this transaction before commit
      if (chargeFirstResult) {
        const firstEnrollmentIdForPayment = createdEnrollments.length > 0 ? createdEnrollments[0].enrollmentId : null;
        if (!firstEnrollmentIdForPayment) {
          const refundOutcome = await DimeService.refundTransaction(chargeFirstResult.processorTransactionId, chargeFirstResult.totalPaymentAmount, chargeFirstResult.tenantId);
          console.error('❌ Charge-first: no enrollment ID for payment record; refund issued:', refundOutcome.success ? 'OK' : refundOutcome.error?.message);
          return res.status(500).json({
            success: false,
            message: 'Enrollment could not be completed. Your payment has been refunded.',
            error: { code: 'ENROLLMENT_FAILED_REFUND_ISSUED', details: 'Your payment has been refunded. You should see the credit within a few business days. Please try again or contact support.' }
          });
        }
        const PaymentDatabaseService = require('../services/paymentDatabaseService');
        const cfProcFee = chargeFirstIndividualRecurringContext?.paymentProcessingFeeTotal ?? 0;
        const cfSetupFee = chargeFirstIndividualRecurringContext?.totalSetupFee ?? 0;
        await PaymentDatabaseService.storePaymentRecord({
          enrollmentId: firstEnrollmentIdForPayment,
          householdId: chargeFirstResult.householdId,
          amount: chargeFirstResult.totalPaymentAmount,
          status: chargeFirstResult.paymentResult?.recordStatus || 'Completed',
          paymentMethod: paymentMethod?.paymentMethodType || 'Card',
          processorTransactionId: String(chargeFirstResult.processorTransactionId),
          processorTransactionInfoId: chargeFirstResult.processorTransactionInfoId ? String(chargeFirstResult.processorTransactionInfoId) : null,
          processorResponse: JSON.stringify(chargeFirstResult.paymentResult?.rawResponse || {}),
          paymentDate: new Date(),
          processingFeeAmount: Number(cfProcFee || 0),
          setupFee: Number(cfSetupFee || 0)
        }, transaction);
        await transaction.request()
          .input('memberId', sql.UniqueIdentifier, chargeFirstResult.finalMemberId)
          .query(`
            UPDATE oe.Members
            SET Status = 'Active', ModifiedDate = GETUTCDATE()
            WHERE MemberId = @memberId
          `);
        console.log('💳 Charge-first: stored payment record and set member Active');
      }
      
      await transaction.commit();

      // Persist per-vendor ID card network selections from the wizard. INDIVIDUAL members
      // only — group members inherit the group's selection (oe.GroupVendorNetworks).
      // Best-effort: failures are logged but never block enrollment completion.
      try {
        const hasSelections = (Array.isArray(networkSelections) && networkSelections.length > 0)
          || (networkSelections && typeof networkSelections === 'object' && Object.keys(networkSelections).length > 0);
        if (hasSelections && finalMemberId) {
          const memberCtxReq = pool.request();
          memberCtxReq.input('memberId', sql.UniqueIdentifier, finalMemberId);
          const memberCtxRes = await memberCtxReq.query(`
            SELECT HouseholdId, GroupId FROM oe.Members WHERE MemberId = @memberId
          `);
          const memberCtx = memberCtxRes.recordset?.[0];
          if (memberCtx && !memberCtx.GroupId && memberCtx.HouseholdId) {
            // Normalize selections to { [vendorId]: vendorNetworkId } map.
            const map = {};
            if (Array.isArray(networkSelections)) {
              for (const s of networkSelections) {
                if (s && s.vendorId && s.vendorNetworkId) map[s.vendorId] = s.vendorNetworkId;
              }
            } else if (typeof networkSelections === 'object') {
              for (const [vid, nid] of Object.entries(networkSelections)) {
                if (vid && nid) map[vid] = nid;
              }
            }
            if (Object.keys(map).length > 0) {
              const hvnTx = new rawSql.Transaction(pool);
              await hvnTx.begin();
              try {
                const result = await applyHouseholdVendorNetworkSelections({
                  transaction: hvnTx,
                  householdId: memberCtx.HouseholdId,
                  selections: map
                });
                await hvnTx.commit();
                console.log('🛡️ Applied household vendor network selections', {
                  householdId: memberCtx.HouseholdId,
                  applied: result.applied,
                  cleared: result.cleared,
                  skipped: result.skipped
                });
              } catch (hvnErr) {
                try { await hvnTx.rollback(); } catch (_) { /* noop */ }
                console.warn('⚠️ Failed to apply household vendor network selections (non-fatal):', hvnErr.message);
              }
            }
          } else if (memberCtx && memberCtx.GroupId) {
            console.log('ℹ️ Skipping household vendor network selections — member is in a group; group selection wins.');
          }
        }
      } catch (networkPersistError) {
        console.warn('⚠️ Network selection persistence error (non-fatal):', networkPersistError.message);
      }

      // Charge-first: build payment receipt for response (we already charged before transaction)
      if (chargeFirstResult) {
        const cfCtx = chargeFirstIndividualRecurringContext;
        const totalPremiumFromReceipt = cfCtx?.totalPremium ?? (frontendPricing?.reduce((s, p) => s + (Number(p.monthlyPremium) || 0), 0) || chargeFirstResult.totalPaymentAmount);
        const productsListReceipt = (frontendPricing || []).map(p => ({ productName: p.productName || 'Product', amount: Number(p.monthlyPremium) || 0 }));
        paymentReceiptData = {
          transactionId: chargeFirstResult.processorTransactionId,
          amount: totalPremiumFromReceipt,
          processingFee: cfCtx?.combinedFees ?? 0,
          systemFees: cfCtx?.systemFeesAmount ?? 0,
          paymentProcessingFee: cfCtx?.paymentProcessingFeeRemainder ?? 0,
          setupFee: cfCtx?.totalSetupFee ?? 0,
          totalAmount: chargeFirstResult.totalPaymentAmount,
          status: chargeFirstResult.paymentResult?.recordStatus || 'Completed',
          paymentDate: new Date().toISOString(),
          paymentMethod: {
            type: paymentMethod?.paymentMethodType || 'Card',
            last4: paymentMethod?.paymentMethodType === 'Card' ? String(paymentMethod?.cardNumber || '').slice(-4) : String(paymentMethod?.accountNumber || '').slice(-4),
            brand: paymentMethod?.paymentMethodType === 'Card' ? (paymentMethod?.cardBrand || 'Card') : paymentMethod?.accountType
          },
          memberInfo: {
            name: `${memberInfo?.firstName || ''} ${memberInfo?.lastName || ''}`.trim() || 'Member',
            email: memberInfo?.email || paymentMethod?.email || ''
          },
          tenantName: enrollmentLink?.TenantName || '',
          products: productsListReceipt.length > 0 ? productsListReceipt : [{ productName: 'Enrollment', amount: totalPremiumFromReceipt }]
        };
      }

      // Charge-first individual: stored PM + DIME recurring (same as deferred post-commit; charge-first previously skipped this entirely)
      if (chargeFirstResult && chargeFirstIndividualRecurringContext && !enrollmentLink.GroupId && paymentMethod && !skipPaymentProcessing) {
        try {
          const cfPmSetupResult = await setupStoredPaymentMethodAndRecurringForIndividualEnrollment({
            pool,
            sql,
            tenantId: chargeFirstIndividualRecurringContext.tenantId,
            memberId: chargeFirstIndividualRecurringContext.memberId,
            householdId: chargeFirstIndividualRecurringContext.householdId,
            memberInfo: chargeFirstIndividualRecurringContext.memberInfo,
            paymentMethod: chargeFirstIndividualRecurringContext.paymentMethod,
            effectiveDate: chargeFirstIndividualRecurringContext.effectiveDate,
            basePremium: chargeFirstIndividualRecurringContext.basePremium,
            paymentProcessingFeeTotal: chargeFirstIndividualRecurringContext.paymentProcessingFeeTotal,
            systemFeesAmount: chargeFirstIndividualRecurringContext.systemFeesAmount,
            userId,
            dimeCustomerIdHint: chargeFirstIndividualRecurringContext.dimeCustomerIdHint || null,
            // Flag is captured on the context when it's built inside the transaction — we're
            // outside the scope where paymentProcessorSettings was declared.
            chargeFirstPaymentWithRecurring: chargeFirstIndividualRecurringContext.chargeFirstPaymentWithRecurring === true
          });
          if (cfPmSetupResult?.paymentMethodSaved && !cfPmSetupResult?.recurringScheduled) {
            const reportId = crypto.randomUUID();
            console.warn('⚠️ Charge-first: payment method saved, but recurring not scheduled', {
              tenantId: chargeFirstIndividualRecurringContext.tenantId,
              memberId: chargeFirstIndividualRecurringContext.memberId,
              householdId: chargeFirstIndividualRecurringContext.householdId,
              linkToken,
              reportId,
              recurringSkipReason: cfPmSetupResult?.recurringSkipReason || null,
              recurringErrorMessage: cfPmSetupResult?.recurringErrorMessage || null
            });
            try {
              await recordIntegrationError({
                category: 'enrollment-wizard',
                source: 'enrollment-links.complete-enrollment-charge-first-recurring',
                severity: 'warning',
                tenantId: chargeFirstIndividualRecurringContext.tenantId,
                message: String(
                  cfPmSetupResult?.recurringErrorMessage ||
                  cfPmSetupResult?.recurringSkipReason ||
                  'Recurring schedule not created after successful payment method save'
                ).slice(0, 2000),
                detail: {
                  memberId: chargeFirstIndividualRecurringContext.memberId,
                  householdId: chargeFirstIndividualRecurringContext.householdId,
                  linkToken,
                  reportId,
                  recurringSkipReason: cfPmSetupResult?.recurringSkipReason || null,
                  recurringErrorMessage: cfPmSetupResult?.recurringErrorMessage || null
                }
              });
            } catch (e) {
              console.warn('recordIntegrationError charge-first recurring:', e?.message || e);
            }
          }
          console.log('✅ Charge-first: individual recurring + stored payment method setup completed');
        } catch (cfPmErr) {
          console.error('⚠️ Charge-first: Payment method storage/recurring setup failed (enrollment still successful):', {
            error: cfPmErr?.message || String(cfPmErr),
            tenantId: chargeFirstIndividualRecurringContext.tenantId,
            memberId: chargeFirstIndividualRecurringContext.memberId,
            householdId: chargeFirstIndividualRecurringContext.householdId,
            linkToken,
            stack: cfPmErr?.stack
          });
          try {
            await recordIntegrationError({
              category: 'enrollment-wizard',
              source: 'enrollment-links.complete-enrollment-charge-first-pm',
              severity: 'error',
              tenantId: chargeFirstIndividualRecurringContext.tenantId,
              message: String(cfPmErr?.message || cfPmErr).slice(0, 2000),
              detail: {
                memberId: chargeFirstIndividualRecurringContext.memberId,
                householdId: chargeFirstIndividualRecurringContext.householdId,
                linkToken,
                stack: cfPmErr?.stack
              }
            });
          } catch (e) {
            console.warn('recordIntegrationError charge-first pm:', e?.message || e);
          }
        }
      } else if (chargeFirstResult && !enrollmentLink.GroupId && !skipPaymentProcessing) {
        console.warn('⚠️ Charge-first: skipped post-commit PM/recurring setup due to missing prerequisites', {
          hasChargeFirstResult: !!chargeFirstResult,
          hasRecurringContext: !!chargeFirstIndividualRecurringContext,
          hasPaymentMethod: !!paymentMethod,
          isGroupEnrollment: !!enrollmentLink.GroupId,
          skipPaymentProcessing
        });
      }

      // Welcome side effects (campaign trigger → welcome email, SMS consent persist, welcome SMS).
      //
      // ⚠️ IMPORTANT: These MUST only fire after payment has succeeded (or no payment is required).
      // Previously fired unconditionally here, which caused welcome emails to be sent even when the
      // post-commit DIME charge later declined — users got a "Welcome" email for an enrollment that
      // never actually happened. For the deferred (post-commit) payment path we wait until after
      // the charge succeeds and call this helper from inside `deferredPaymentBlock`.
      let welcomeSideEffectsFired = false;
      const fireEnrollmentCompletionSideEffects = async () => {
        if (welcomeSideEffectsFired) return;
        welcomeSideEffectsFired = true;

        try {
          const CampaignTriggerService = require('../services/campaignTrigger.service');
          const triggerResult = await CampaignTriggerService.fireTrigger(pool, 'EnrollmentCompletion', {
            memberId: finalMemberId,
            tenantId: enrollmentLink.TenantId,
            groupId: enrollmentLink.GroupId || (member && member.GroupId) || null,
            agentId: enrollmentLink.AgentId || null
          });
          if (triggerResult.campaignsTriggered > 0) {
            console.log(`✅ Campaign trigger fired: ${triggerResult.campaignsTriggered} campaigns, ${triggerResult.messagesQueued} messages queued`);
          } else {
            // Always log the no-op case so missing-campaign config is visible in ops logs
            // (otherwise tenants with no EnrollmentCompletion campaign look identical to silent failures).
            console.warn(`⚠️ Campaign trigger fired with 0 active EnrollmentCompletion campaigns for tenant ${enrollmentLink.TenantId} (member ${finalMemberId}) — no welcome message will be sent.`);
          }
        } catch (triggerErr) {
          console.error('⚠️ Campaign trigger failed (enrollment succeeded):', triggerErr?.message || triggerErr);
        }

        if (typeof smsConsent === 'boolean' && finalMemberId) {
          try {
            await pool.request()
              .input('memberId', sql.UniqueIdentifier, finalMemberId)
              .input('smsConsent', sql.Bit, smsConsent ? 1 : 0)
              .query(`
                UPDATE oe.Members
                SET SmsConsent = @smsConsent, ModifiedDate = GETUTCDATE()
                WHERE MemberId = @memberId
              `);
            console.log('✅ SMS consent saved for member:', finalMemberId, '=', smsConsent);
          } catch (consentErr) {
            console.error('⚠️ Failed to save SMS consent (enrollment succeeded):', consentErr?.message || consentErr);
          }
        }

        if (smsConsent && enrollmentLink.TenantId) {
          const phoneRaw = (member && member.PhoneNumber) || memberInfo?.phone || '';
          const phoneDigits = (phoneRaw || '').replace(/\D/g, '');
          let phoneE164 = null;
          if (phoneDigits.length === 10) {
            phoneE164 = '+1' + phoneDigits;
          } else if (phoneDigits.length === 11 && phoneDigits.charAt(0) === '1') {
            phoneE164 = '+' + phoneDigits;
          }
          if (phoneE164) {
            try {
              await MessageQueueService.queueMessage({
                tenantId: enrollmentLink.TenantId,
                messageType: 'SMS',
                recipientAddress: phoneE164,
                subject: null,
                messageBody: 'Welcome to AllAboard! Download our app to manage your benefits. Reply STOP to opt out.',
                status: 'Pending',
                createdBy: null,
                recipientId: member && member.UserId ? member.UserId : null
              });
              console.log('✅ Welcome SMS queued for member:', finalMemberId);
            } catch (smsErr) {
              console.error('⚠️ Welcome SMS queue failed (enrollment succeeded):', smsErr?.message || smsErr);
            }
          }
        }
      };

      // Fire welcome side effects NOW only for flows where payment has already cleared (charge-first),
      // no payment is required (group / skipPaymentProcessing), or we are re-processing a previously
      // successful submission. The deferred individual payment path fires them inside
      // `deferredPaymentBlock` after the DIME charge succeeds so a declined card never triggers a
      // welcome email.
      const shouldDeferWelcomeSideEffects = !!deferredIndividualPaymentContext && !skipPaymentProcessing;
      if (!shouldDeferWelcomeSideEffects) {
        await fireEnrollmentCompletionSideEffects();
      } else {
        console.log('🕗 Deferring welcome side effects until post-commit payment succeeds', {
          memberId: finalMemberId,
          tenantId: enrollmentLink.TenantId
        });
      }

      // 🔥 POST-COMMIT: Process deferred payment for individual enrollments
      // Payment is processed AFTER commit to prevent "charged but rolled back" scenarios.
      let paymentDeferredToEffectiveDate = false;
      deferredPaymentBlock: if (deferredIndividualPaymentContext) {
        console.log('💳 POST-COMMIT: Processing deferred payment for individual enrollment...');
        const {
          linkToken: deferredLinkToken,
          idempotencyKey,
          tenantId,
          finalMemberId: deferredMemberId,
          householdId,
          firstEnrollmentId,
          totalPremium,
          totalPaymentAmount,
          combinedFees,
          systemFeesAmount,
          paymentProcessingFeeRemainder,
          paymentProcessingFeeTotal,
          basePremium,
          totalSetupFee,
          effectiveDate: deferredEffectiveDate,
          memberInfo: deferredMemberInfo,
          paymentMethod: deferredPaymentMethod,
          frontendPricing: deferredFrontendPricing,
          chargeFirstPaymentWithRecurring: deferredChargeFirstPaymentWithRecurring
        } = deferredIndividualPaymentContext;

        // Tenant flag: defer the first payment to the DIME recurring schedule.
        // When on AND no setup fee: skip the at-enrollment charge entirely. DIME will charge on the effective date.
        // When on AND setup fee present: still charge the setup fee now (one-time), recurring picks up premium on effective date.
        const setupFeeOnlyPost = deferredChargeFirstPaymentWithRecurring && Number(totalSetupFee || 0) > 0;
        const skipPostCommitCharge = deferredChargeFirstPaymentWithRecurring && !setupFeeOnlyPost;

        if (skipPostCommitCharge) {
          console.log('💳 POST-COMMIT: chargeFirstPaymentWithRecurring is ON and no setup fee — skipping charge (DIME recurring will charge on effective date)');

          // CRITICAL: DIME vault BEFORE activation.
          //
          // Previously we activated the Member + PaymentHold enrollments here and THEN called
          // setupStoredPaymentMethodAndRecurringForIndividualEnrollment. When DIME rejected the
          // card with a known failure, the subsequent "rollback" only deleted enrollments still
          // in PaymentHold — which by then was zero, since we'd just flipped them to Active.
          // The member ended up Active with no billing schedule (Dawn Taylor, 2026-04-18).
          //
          // The correct order: vault first while enrollments are still PaymentHold, classify the
          // result, and only activate on full success or a transient (not-the-user's-fault)
          // failure. A known failure now leaves the enrollments in PaymentHold so
          // cleanupPaymentHoldAfterFailedPayment can actually undo them.
          //
          // Classification buckets:
          //   (a) full success           → processorSaved && recurringScheduled → activate, welcome
          //   (b) transient / unknown    → DIME 5xx, upstream hiccup, opaque 4xx, PM saved but
          //                                schedule failed → activate (proceed), record system
          //                                error at priority:high, fire welcome. PM is stored
          //                                as PendingProcessorVault so ops can retry the vault
          //                                via the "Add to Processor" button.
          //   (c) known user-fixable    → DIME rejected the card (validation / decline) → roll
          //                                back PaymentHold + orphan Member/User, skip welcome,
          //                                return 400 with friendly copy. NOT recorded as a
          //                                system error because it's an expected, user-resolvable
          //                                condition.
          const DEFERRED_TRANSIENT_SKIP_REASONS = new Set([
            'processor_unavailable',             // DIME 5xx or upstream-processor hiccup
            'processor_unclassified',            // opaque 4xx, no validation body, no decline string
            'processor_recurring_unavailable',   // recurring-side transient (PM saved, schedule failed)
            'missing_effective_date',            // internal bug — not member-fixable
            'missing_processor_customer'         // couldn't create DIME customer — treat as transient
          ]);

          let deferredPmResult = null;
          let deferredPmThrewUnexpected = null;
          try {
            deferredPmResult = await setupStoredPaymentMethodAndRecurringForIndividualEnrollment({
              pool,
              sql,
              tenantId,
              memberId: deferredMemberId,
              householdId,
              memberInfo: deferredMemberInfo,
              paymentMethod: deferredPaymentMethod,
              effectiveDate: deferredEffectiveDate,
              basePremium,
              paymentProcessingFeeTotal: Number(paymentProcessingFeeTotal || 0),
              systemFeesAmount,
              userId,
              dimeCustomerIdHint: null,
              chargeFirstPaymentWithRecurring: true
            });
          } catch (pmErr) {
            console.error('⚠️ POST-COMMIT (deferred charge): PM setup threw unexpectedly:', pmErr?.message || pmErr);
            deferredPmThrewUnexpected = pmErr;
          }

          const pmFullSuccess = deferredPmResult?.processorSaved === true && deferredPmResult?.recurringScheduled === true;
          // Treat a "PM saved but recurring failed" result as transient regardless of the skip
          // reason — the member's card was accepted, the schedule just didn't stick. Ops retries.
          const pmOnlyRecurringFailed = deferredPmResult?.processorSaved === true && deferredPmResult?.recurringScheduled !== true;
          const pmKnownFailure =
            !pmFullSuccess &&
            !deferredPmThrewUnexpected &&
            !pmOnlyRecurringFailed &&
            !!deferredPmResult?.recurringSkipReason &&
            !DEFERRED_TRANSIENT_SKIP_REASONS.has(deferredPmResult.recurringSkipReason);
          const pmTransient = !pmFullSuccess && !pmKnownFailure;

          if (pmKnownFailure) {
            const friendly = typeof DimeService.buildFriendlyDimeVaultError === 'function'
              ? DimeService.buildFriendlyDimeVaultError(deferredPmResult)
              : {
                  title: "We couldn't save your payment method",
                  body: "We weren't able to save your card for recurring billing. Please try again or use a different card.",
                  validationSummary: null,
                  isBankDecline: false,
                  declineReasonCode: null
                };

            console.warn('⛔ POST-COMMIT (deferred charge): KNOWN user-fixable DIME failure — rolling back enrollment', {
              tenantId, memberId: deferredMemberId, householdId, linkToken,
              recurringSkipReason: deferredPmResult.recurringSkipReason,
              processorSaved: deferredPmResult.processorSaved || false,
              recurringErrorMessage: deferredPmResult.recurringErrorMessage || null,
              isBankDecline: friendly.isBankDecline,
              declineReasonCode: friendly.declineReasonCode
            });

            // Intentionally NOT recorded via recordIntegrationError: this is an expected,
            // user-resolvable outcome (bad card, expired, AVS mismatch, etc.). Ops doesn't need
            // to know about a bank decline — the member will either enter a different card or
            // abandon. Piping every decline into SystemIntegrationErrors would drown the signal
            // we actually want from that table (DIME-side outages).

            // Same cleanup path as a declined charge — delete PaymentHold enrollments, then orphan
            // Member/User rows. Skip welcome so the member doesn't get a password-setup email for
            // an enrollment that no longer exists. Now that this runs BEFORE activation, the
            // PaymentHold rows still exist to be cleaned up.
            try {
              await enrollmentPaymentHoldService.cleanupPaymentHoldAfterFailedPayment(deferredMemberId);
            } catch (e) {
              console.error('cleanup PaymentHold after deferred-charge known failure:', e?.message || e);
            }
            try {
              const orphanCleanup = await enrollmentPaymentHoldService.cleanupOrphanUserAndMemberAfterFailedPayment({
                memberId: deferredMemberId, userId, tenantId
              });
              console.log('🧹 POST-COMMIT (deferred charge) orphan Member/User cleanup:', orphanCleanup);
            } catch (e) {
              console.error('cleanup orphan Member/User after deferred-charge known failure:', e?.message || e);
            }

            return res.status(400).json({
              success: false,
              // Always surface friendly.body as the top-level message so the wizard's generic
              // error modal shows DIME's actual reason (or our friendly translation of it),
              // not a short title that hides the detail.
              message: friendly.body || friendly.title || "We couldn't save your payment method",
              error: {
                code: 'PAYMENT_METHOD_ERROR',
                title: friendly.title || "We couldn't save your payment method",
                details: friendly.body,
                isBankDecline: friendly.isBankDecline === true,
                declineReasonCode: friendly.declineReasonCode || null,
                validationSummary: friendly.validationSummary || null,
                dimeDetails: deferredPmResult.processorErrorDetails || null
              }
            });
          }

          // Full success or transient → activate now. Transient still activates because the
          // member's card was accepted (or we have no evidence they did anything wrong) — we
          // flip them Active, leave the PM in PendingProcessorVault, and let ops retry the
          // vault via the Add-to-Processor button in the admin UI.
          try {
            const txActivate = pool.transaction();
            await txActivate.begin();
            await txActivate.request()
              .input('memberId', sql.UniqueIdentifier, deferredMemberId)
              .input('status', sql.NVarChar(20), 'Active')
              .query(`UPDATE oe.Members SET Status = @status, ModifiedDate = GETUTCDATE() WHERE MemberId = @memberId`);
            await enrollmentPaymentHoldService.activatePaymentHoldEnrollmentsForMemberInTransaction(txActivate, deferredMemberId, {
              tenantId,
              processorTransactionId: null,
              expectRows: false
            });
            await txActivate.commit();
          } catch (activateErr) {
            console.error('⚠️ POST-COMMIT (deferred charge): failed to activate member / payment-hold enrollments:', activateErr?.message || activateErr);
          }

          if (pmTransient) {
            // Not the member's problem. Record at priority:high so ops gets an alert in the
            // 15-min SystemIntegrationErrors digest, then fall through to the success path.
            const logPayload = {
              tenantId, memberId: deferredMemberId, householdId, linkToken,
              processorSaved: deferredPmResult?.processorSaved || false,
              recurringScheduled: deferredPmResult?.recurringScheduled || false,
              recurringSkipReason: deferredPmResult?.recurringSkipReason || (deferredPmThrewUnexpected ? 'exception' : null),
              recurringErrorMessage: deferredPmResult?.recurringErrorMessage || deferredPmThrewUnexpected?.message || null
            };
            if (pmOnlyRecurringFailed) {
              console.warn('⚠️ POST-COMMIT (deferred charge): card vaulted but recurring schedule failed — ops will retry', logPayload);
            } else {
              console.warn('⚠️ POST-COMMIT (deferred charge): transient DIME issue — proceeding without vault; ops will retry', logPayload);
            }
            try {
              await recordIntegrationError({
                category: 'enrollment-wizard',
                source: deferredPmThrewUnexpected
                  ? 'enrollment-links.complete-enrollment-deferred-charge-pm-exception'
                  : (pmOnlyRecurringFailed
                      ? 'enrollment-links.complete-enrollment-deferred-charge-recurring-transient'
                      : 'enrollment-links.complete-enrollment-deferred-charge-vault-transient'),
                severity: 'warning',
                priority: 'high',
                tenantId,
                message: String(
                  deferredPmResult?.recurringErrorMessage ||
                  deferredPmThrewUnexpected?.message ||
                  deferredPmResult?.recurringSkipReason ||
                  'Deferred-charge PM/recurring setup transient failure'
                ).slice(0, 2000),
                detail: {
                  memberId: deferredMemberId, householdId, linkToken,
                  recurringSkipReason: deferredPmResult?.recurringSkipReason || null,
                  recurringErrorMessage: deferredPmResult?.recurringErrorMessage || null,
                  processorSaved: deferredPmResult?.processorSaved || false,
                  processorErrorDetails: deferredPmResult?.processorErrorDetails || null,
                  threwUnexpected: !!deferredPmThrewUnexpected
                }
              });
            } catch (e) {
              console.warn('recordIntegrationError deferred-charge transient:', e?.message || e);
            }
          }

          let tenantNameForReceiptSkip = '';
          try {
            const tenantRowSkip = await pool.request()
              .input('tenantId', sql.UniqueIdentifier, tenantId)
              .query(`SELECT Name FROM oe.Tenants WHERE TenantId = @tenantId`);
            tenantNameForReceiptSkip = tenantRowSkip.recordset?.[0]?.Name || '';
          } catch (_) {}

          const productsListSkip = deferredFrontendPricing && deferredFrontendPricing.length > 0
            ? deferredFrontendPricing.map(p => ({ productName: p.productName, amount: p.monthlyPremium }))
            : [];

          paymentReceiptData = {
            transactionId: null,
            amount: totalPremium,
            processingFee: combinedFees,
            systemFees: systemFeesAmount,
            paymentProcessingFee: Number(paymentProcessingFeeRemainder || 0),
            setupFee: 0,
            totalAmount: 0,
            status: 'ScheduledForEffectiveDate',
            paymentDate: null,
            firstChargeDate: deferredEffectiveDate,
            paymentMethod: {
              type: deferredPaymentMethod?.paymentMethodType,
              last4: deferredPaymentMethod?.paymentMethodType === 'Card'
                ? String(deferredPaymentMethod?.cardNumber || '').slice(-4)
                : String(deferredPaymentMethod?.accountNumber || '').slice(-4),
              brand: deferredPaymentMethod?.paymentMethodType === 'Card'
                ? (deferredPaymentMethod?.cardBrand || 'Card')
                : deferredPaymentMethod?.accountType
            },
            memberInfo: {
              name: `${deferredMemberInfo.firstName} ${deferredMemberInfo.lastName}`,
              email: deferredMemberInfo.email
            },
            tenantName: tenantNameForReceiptSkip,
            products: productsListSkip
          };
          if (pdfUrl) paymentReceiptData.agreementsPdfUrl = pdfUrl;

          // No charge today is treated as success (DIME recurring will charge on the effective date).
          // Fire welcome side effects now that the enrollment is confirmed.
          await fireEnrollmentCompletionSideEffects();

          // Mark for response building + skip the rest of the charge/finalize sequence.
          // Control falls through to the normal post-commit tail (password email, role
          // assignment, deferred profile updates, final response).
          paymentDeferredToEffectiveDate = true;
          break deferredPaymentBlock;
        }

        // setupFeeOnly: from here on, the existing flow runs but will charge only the setup fee.
        const effectiveChargeAmount = setupFeeOnlyPost
          ? Math.round(Number(totalSetupFee || 0) * 100) / 100
          : totalPaymentAmount;

        const persistPostCommitFailedPayment = async ({ failureReason, processorPayload, processorTransactionId: failedTxnId }) => {
          try {
            const PaymentDatabaseService = require('../services/paymentDatabaseService');
            await PaymentDatabaseService.storePaymentRecord({
              enrollmentId: firstEnrollmentId,
              householdId,
              tenantId,
              amount: effectiveChargeAmount,
              status: 'Failed',
              paymentMethod: deferredPaymentMethod?.paymentMethodType || 'Card',
              processorTransactionId:
                failedTxnId != null && String(failedTxnId).trim() !== '' ? String(failedTxnId) : null,
              processorTransactionInfoId: null,
              processorResponse: JSON.stringify({
                flow: 'complete-enrollment-post-commit',
                idempotencyKey,
                amount: effectiveChargeAmount,
                ...processorPayload
              }),
              paymentDate: new Date(),
              processingFeeAmount: Number(paymentProcessingFeeTotal || 0),
              setupFee: Number(totalSetupFee || 0),
              failureReason: String(failureReason).slice(0, 4000)
            });
          } catch (persistPayErr) {
            console.error('⚠️ POST-COMMIT: Failed to persist oe.Payments row for failed payment:', persistPayErr?.message || persistPayErr);
          }
        };

        const cleanupPaymentHoldAfterFailedPostCommit = async () => {
          try {
            await enrollmentPaymentHoldService.cleanupPaymentHoldAfterFailedPayment(deferredMemberId);
          } catch (e) {
            console.error('cleanup PaymentHold after failed post-commit payment:', e?.message || e);
          }
          // Also remove the orphan Member + (optionally) User rows so a declined enrollment
          // does not leave behind a half-provisioned account. The service applies strict safety
          // checks and only deletes rows that clearly belong to this never-completed attempt.
          try {
            const orphanCleanup = await enrollmentPaymentHoldService.cleanupOrphanUserAndMemberAfterFailedPayment({
              memberId: deferredMemberId,
              userId,
              tenantId
            });
            console.log('🧹 POST-COMMIT: orphan Member/User cleanup result:', orphanCleanup);
          } catch (e) {
            console.error('cleanup orphan Member/User after failed post-commit payment:', e?.message || e);
          }
        };

        const finalizeAsPendingProcessorAndRespond = async ({ reason, dimeCustomerIdHint = null }) => {
          try {
            const txPending = pool.transaction();
            await txPending.begin();
            await txPending.request()
              .input('memberId', sql.UniqueIdentifier, deferredMemberId)
              .input('status', sql.NVarChar(20), 'Active')
              .query(`
                UPDATE oe.Members
                SET Status = @status,
                    ModifiedDate = GETUTCDATE()
                WHERE MemberId = @memberId
              `);
            await enrollmentPaymentHoldService.activatePaymentHoldEnrollmentsForMemberInTransaction(txPending, deferredMemberId, {
              tenantId,
              processorTransactionId: null,
              expectRows: false
            });
            await txPending.commit();
          } catch (pendingFinalizeErr) {
            console.error('⚠️ POST-COMMIT: Failed to activate pending-processor enrollment state:', pendingFinalizeErr);
          }

          try {
            await setupStoredPaymentMethodAndRecurringForIndividualEnrollment({
              pool,
              sql,
              tenantId,
              memberId: deferredMemberId,
              householdId,
              memberInfo: deferredMemberInfo,
              paymentMethod: deferredPaymentMethod,
              effectiveDate: deferredEffectiveDate,
              basePremium,
              paymentProcessingFeeTotal: Number(paymentProcessingFeeTotal || 0),
              systemFeesAmount,
              userId,
              dimeCustomerIdHint,
              // Read the tenant flag from the deferred context (we're outside the scope where
              // paymentProcessorSettings was declared — using the already-destructured value).
              chargeFirstPaymentWithRecurring: deferredChargeFirstPaymentWithRecurring === true
            });
          } catch (pmErr) {
            console.error('⚠️ POST-COMMIT: pending-processor local payment method persistence failed:', pmErr?.message || pmErr);
          }

          paymentReceiptData = {
            transactionId: null,
            amount: totalPremium,
            processingFee: combinedFees,
            systemFees: systemFeesAmount,
            paymentProcessingFee: Number(paymentProcessingFeeRemainder || 0),
            setupFee: totalSetupFee,
            totalAmount: totalPaymentAmount,
            status: 'Pending',
            pendingReason: reason,
            paymentDate: new Date().toISOString(),
            paymentMethod: {
              type: deferredPaymentMethod?.paymentMethodType,
              last4: deferredPaymentMethod?.paymentMethodType === 'Card'
                ? String(deferredPaymentMethod?.cardNumber || '').slice(-4)
                : String(deferredPaymentMethod?.accountNumber || '').slice(-4),
              brand: deferredPaymentMethod?.paymentMethodType === 'Card'
                ? (deferredPaymentMethod?.cardBrand || 'Card')
                : deferredPaymentMethod?.accountType
            },
            memberInfo: {
              name: `${deferredMemberInfo.firstName} ${deferredMemberInfo.lastName}`,
              email: deferredMemberInfo.email
            },
            tenantName: enrollmentLink?.TenantName || '',
            products: deferredFrontendPricing && deferredFrontendPricing.length > 0
              ? deferredFrontendPricing.map(product => ({
                  productName: product.productName,
                  amount: product.monthlyPremium
                }))
              : []
          };
          if (paymentReceiptData && pdfUrl) {
            paymentReceiptData.agreementsPdfUrl = pdfUrl;
          }

          // Pending-processor is treated as a successful enrollment (DIME temporarily unavailable;
          // the charge will retry automatically). Fire welcome side effects now.
          await fireEnrollmentCompletionSideEffects();

          return res.json({
            success: true,
            data: {
              message: 'Enrollment successful, payment will draft within 24 hours',
              memberId: deferredMemberId,
              enrollments: [...(createdEnrollments || []), ...(updatedEnrollments || [])],
              dependents: [...(createdDependents || []), ...(updatedDependents || [])],
              effectiveDate: (createdEnrollments && createdEnrollments.length > 0) ? createdEnrollments[0].effectiveDate : null,
              agreementsPdfUrl: pdfUrl || null,
              paymentReceipt: paymentReceiptData || null,
              paymentPendingProcessor: true
            },
            message: 'Enrollment successful, payment will draft within 24 hours'
          });
        };

        // Ensure idempotency attempt exists (DB-level guard across retries and app instances)
        let attemptRow = await PaymentAttemptService.createOrGetAttempt({
          idempotencyKey,
          linkToken: deferredLinkToken || linkToken,
          tenantId,
          memberId: deferredMemberId,
          householdId,
          amount: effectiveChargeAmount,
          paymentMethodType: deferredPaymentMethod?.paymentMethodType || null,
          status: 'Processing'
        });

        const claim = await PaymentAttemptService.claimForCharge(idempotencyKey);
        attemptRow = claim.attempt || attemptRow;

        // If we couldn't claim the attempt, another request may be charging right now
        if (!claim.claimed) {
          if (attemptRow && ['Charged', 'Completed'].includes(String(attemptRow.Status || ''))) {
            console.log('🔒 POST-COMMIT: Payment already charged/completed for idempotencyKey, will attempt DB finalize only');
          } else {
            return res.status(409).json({
              success: false,
              message: 'Payment is already being processed. Please wait a moment and refresh.',
              error: { code: 'PAYMENT_IN_PROGRESS' }
            });
          }
        }

        let dimeCustomerId = null;
        let paymentResult = null;
        let processorResponseJson = null;

        // Only the claimant performs the processor charge
        if (claim.claimed) {
          const customerEmail = deferredPaymentMethod?.email || deferredMemberInfo?.email;
          if (!customerEmail) {
            await PaymentAttemptService.updateAttemptByKey(idempotencyKey, {
              status: 'Failed',
              errorMessage: 'Missing customer email for payment processing'
            });
            await persistPostCommitFailedPayment({
              failureReason: 'Missing customer email for payment processing | stage:pre-charge-missing-email',
              processorPayload: { stage: 'pre-charge-missing-email' }
            });
            try {
              await recordIntegrationError({
                category: 'enrollment_wizard_payment',
                source: 'enrollment-links.complete-enrollment-pre-charge-missing-email',
                severity: 'error',
                tenantId,
                message: 'Missing customer email for payment processing',
                detail: {
                  stage: 'pre-charge-missing-email',
                  memberId: deferredMemberId,
                  householdId,
                  idempotencyKey
                }
              });
            } catch (e) {
              console.warn('recordIntegrationError enrollment wizard payment (missing email):', e?.message || e);
            }
            await cleanupPaymentHoldAfterFailedPostCommit();
            return res.status(400).json({
              success: false,
              message: 'Payment processing failed',
              error: { code: 'PAYMENT_ERROR', details: 'Missing customer email for payment processing' }
            });
          }

          // Find or create DIME customer
          let customerResult = await DimeService.findCustomerByEmail(customerEmail, tenantId);
          if (!customerResult.success) {
            console.log('🔍 POST-COMMIT: Customer not found, creating new customer...');
            customerResult = await DimeService.createCustomer({
              firstName: deferredPaymentMethod?.cardholderName?.split(' ')[0] || deferredMemberInfo?.firstName,
              lastName: deferredPaymentMethod?.cardholderName?.split(' ').slice(1).join(' ') || deferredMemberInfo?.lastName,
              email: customerEmail,
              phone: deferredPaymentMethod?.phone || deferredMemberInfo?.phone,
              billingAddress: deferredPaymentMethod?.billingAddress || deferredMemberInfo?.address || ''
            }, tenantId);
          }

          if (!customerResult.success || !customerResult.customerId) {
            const msg = customerResult?.error?.message || customerResult?.message || 'Failed to create customer';
            await PaymentAttemptService.updateAttemptByKey(idempotencyKey, { status: 'Failed', errorMessage: msg });
            await persistPostCommitFailedPayment({
              failureReason: `${msg} | stage:pre-charge-customer`,
              processorPayload: {
                stage: 'pre-charge-customer',
                customerResult: {
                  success: customerResult.success,
                  customerId: customerResult.customerId,
                  error: customerResult.error || null,
                  message: customerResult.message || null
                }
              }
            });
            try {
              await recordIntegrationError({
                category: 'enrollment_wizard_payment',
                source: 'enrollment-links.complete-enrollment-pre-charge-customer',
                severity: 'warning',
                tenantId,
                message: String(msg).slice(0, 2000),
                detail: {
                  stage: 'pre-charge-customer',
                  memberId: deferredMemberId,
                  householdId,
                  idempotencyKey,
                  customerResult: {
                    success: customerResult.success,
                    customerId: customerResult.customerId,
                    error: customerResult.error || null,
                    message: customerResult.message || null
                  }
                }
              });
            } catch (e) {
              console.warn('recordIntegrationError enrollment wizard payment (customer):', e?.message || e);
            }
            if (isDimeServerError(customerResult)) {
              return finalizeAsPendingProcessorAndRespond({
                reason: `Payment processor unavailable during customer setup: ${msg}`,
                dimeCustomerIdHint: null
              });
            }
            await cleanupPaymentHoldAfterFailedPostCommit();
            return res.status(400).json({
              success: false,
              message: 'Payment processing failed',
              error: { code: 'PAYMENT_ERROR', details: msg }
            });
          }

          dimeCustomerId = customerResult.customerId;

          // Best-effort: persist ProcessorCustomerId on the member
          try {
            await pool.request()
              .input('memberId', sql.UniqueIdentifier, deferredMemberId)
              .input('customerId', sql.NVarChar(255), String(dimeCustomerId))
              .query(`
                UPDATE oe.Members
                SET ProcessorCustomerId = @customerId,
                    ModifiedDate = GETUTCDATE()
                WHERE MemberId = @memberId
              `);
          } catch (e) {
            console.warn('⚠️ POST-COMMIT: Failed to persist ProcessorCustomerId on oe.Members:', e?.message || e);
          }

          // Charge the first month immediately (idempotent by key).
          // When setupFeeOnlyPost is true, effectiveChargeAmount is the setup fee only; premium is left to DIME recurring.
          paymentResult = await DimeService.processPayment({
            customerId: dimeCustomerId,
            paymentMethodId: deferredPaymentMethod?.paymentMethodType === 'ACH' ? 'ACH_PAYMENT' : 'RAW_CARD',
            amount: effectiveChargeAmount,
            description: setupFeeOnlyPost
              ? `Setup fee for individual enrollment - ${enrollmentLink.GroupName || 'Individual Enrollment'}`
              : `Initial payment for individual enrollment - ${enrollmentLink.GroupName || 'Individual Enrollment'}`,
            householdId: householdId,
            paymentMethodType: deferredPaymentMethod?.paymentMethodType || 'Card',
            idempotencyKey: idempotencyKey, // Prevent duplicate payments
            // Card fields
            cardNumber: deferredPaymentMethod?.cardNumber,
            expiryDate: deferredPaymentMethod?.expiryDate,
            cvv: deferredPaymentMethod?.cvv,
            cardholderName: deferredPaymentMethod?.cardholderName,
            // ACH fields
            routingNumber: deferredPaymentMethod?.routingNumber,
            accountNumber: deferredPaymentMethod?.accountNumber,
            accountType: deferredPaymentMethod?.accountType,
            accountHolderName: deferredPaymentMethod?.accountHolderName,
            bankName: deferredPaymentMethod?.bankName,
            // Common fields
            phone: deferredPaymentMethod?.phone || deferredMemberInfo?.phone,
            email: customerEmail,
            billingAddress: deferredPaymentMethod?.billingAddress || deferredMemberInfo?.address || '',
            billingAddress2: deferredPaymentMethod?.billingAddress2 || '',
            billingCity: deferredPaymentMethod?.billingCity || deferredMemberInfo?.city || '',
            billingState: deferredPaymentMethod?.billingState || deferredMemberInfo?.state || '',
            billingZip: deferredPaymentMethod?.billingZip || deferredMemberInfo?.zip || '',
            billingCountry: deferredPaymentMethod?.billingCountry || 'US',
            billingFirstName: deferredPaymentMethod?.cardholderName?.split(' ')[0] || deferredMemberInfo?.firstName,
            billingLastName: deferredPaymentMethod?.cardholderName?.split(' ').slice(1).join(' ') || deferredMemberInfo?.lastName
          }, tenantId);

          if (!paymentResult.success) {
            const msg = paymentResult?.error?.message || 'Payment processing failed';
            await PaymentAttemptService.updateAttemptByKey(idempotencyKey, { status: 'Failed', errorMessage: msg });
            const d = paymentResult?.error?.details;
            const dataBlock = d?.data?.data ?? d?.data ?? d;
            const declinedTxn =
              dataBlock?.transaction_number ||
              dataBlock?.transactionNumber ||
              paymentResult?.transactionNumber ||
              paymentResult?.transactionId ||
              null;
            const httpSt = paymentResult?.error?.statusCode ?? paymentResult?.error?.status;
            const failureReason = [msg, paymentResult?.error?.code && `code:${paymentResult.error.code}`, httpSt != null && `http:${httpSt}`, 'stage:processor-charge-failed']
              .filter(Boolean)
              .join(' | ')
              .slice(0, 4000);
            await persistPostCommitFailedPayment({
              failureReason,
              processorTransactionId: declinedTxn,
              processorPayload: {
                stage: 'processor-charge-failed',
                error: paymentResult.error || null,
                paymentResult: { ...paymentResult, error: paymentResult.error }
              }
            });
            try {
              const userFacing =
                paymentResult?.error?.validationSummary ||
                paymentResult?.error?.message ||
                msg;
              await recordIntegrationError({
                category: 'enrollment_wizard_payment',
                source: 'enrollment-links.complete-enrollment-post-commit',
                severity: 'warning',
                tenantId,
                message: String(userFacing).slice(0, 2000),
                detail: {
                  stage: 'processor-charge-failed',
                  memberId: deferredMemberId,
                  householdId,
                  idempotencyKey,
                  httpStatus: paymentResult?.error?.statusCode ?? paymentResult?.error?.status ?? null,
                  errorCode: paymentResult?.error?.code || null,
                  message: msg,
                  validationSummary: paymentResult?.error?.validationSummary || null,
                  processorTransactionId: declinedTxn || null
                }
              });
            } catch (e) {
              console.warn('recordIntegrationError enrollment wizard payment:', e?.message || e);
            }
            if (isDimeServerError(paymentResult)) {
              return finalizeAsPendingProcessorAndRespond({
                reason: `Payment processor unavailable during charge: ${msg}`,
                dimeCustomerIdHint: dimeCustomerId || null
              });
            }
            await cleanupPaymentHoldAfterFailedPostCommit();
            return res.status(400).json({
              success: false,
              message: paymentResult?.error?.isBankDecline
                ? 'Your bank declined this transaction'
                : 'Payment processing failed',
              error: {
                code: 'PAYMENT_ERROR',
                details: msg,
                // Pass through decline metadata so the frontend can present a tailored UI
                // (special title for bank declines, reason code for ops dashboards).
                isBankDecline: paymentResult?.error?.isBankDecline === true,
                declineReasonCode: paymentResult?.error?.declineReasonCode || null,
                amount: paymentResult?.error?.amount ?? effectiveChargeAmount ?? null,
                validationSummary: paymentResult?.error?.validationSummary || null,
                dimeDetails: paymentResult?.error?.details || null
              }
            });
          }

          const processorTransactionId = paymentResult.transactionId || paymentResult.transactionNumber || null;
          processorResponseJson = JSON.stringify({
            statusCode: paymentResult.statusCode,
            statusText: paymentResult.statusText,
            transactionType: paymentResult.transactionType,
            multiUseToken: paymentResult.multiUseToken,
            billingAddress: paymentResult.billingAddress,
            rawResponse: paymentResult.rawResponse
          });

          attemptRow = await PaymentAttemptService.updateAttemptByKey(idempotencyKey, {
            status: 'Charged',
            processorTransactionId,
            processorResponse: processorResponseJson,
            errorMessage: null
          });
        }

        // Finalize DB state in a second transaction (never re-charge)
        const attemptAfterCharge = attemptRow || (await PaymentAttemptService.getByIdempotencyKey(idempotencyKey));
        const finalProcessorTransactionId = (paymentResult?.transactionId || paymentResult?.transactionNumber || attemptAfterCharge?.ProcessorTransactionId || null);
        const finalProcessorTransactionInfoId = (paymentResult?.transactionInfoId != null ? String(paymentResult.transactionInfoId) : attemptAfterCharge?.ProcessorTransactionInfoId) || null;
        const finalProcessorResponse = processorResponseJson || attemptAfterCharge?.ProcessorResponse || null;

        if (!finalProcessorTransactionId) {
          await PaymentAttemptService.updateAttemptByKey(idempotencyKey, {
            status: 'Failed',
            errorMessage: 'Missing processor transaction ID after charge'
          });
          return res.status(500).json({
            success: false,
            message: 'Payment recorded with processor but could not be finalized',
            error: { code: 'PAYMENT_FINALIZE_ERROR', details: 'Missing processor transaction ID after charge' }
          });
        }

        try {
          const PaymentDatabaseService = require('../services/paymentDatabaseService');
          const tx2 = pool.transaction();
          await tx2.begin();

          // If payment already exists for this processor transaction, do not insert a duplicate
          const existingPaymentCheck = await tx2.request()
            .input('processorTransactionId', sql.NVarChar(255), String(finalProcessorTransactionId))
            .input('householdId', sql.UniqueIdentifier, householdId)
            .query(`
              SELECT TOP 1 PaymentId, Status
              FROM oe.Payments
              WHERE ProcessorTransactionId = @processorTransactionId
                AND HouseholdId = @householdId
              ORDER BY PaymentDate DESC
            `);

          if (!existingPaymentCheck.recordset || existingPaymentCheck.recordset.length === 0) {
            await PaymentDatabaseService.storePaymentRecord({
              enrollmentId: firstEnrollmentId,
              householdId,
              amount: effectiveChargeAmount,
              status: paymentResult.recordStatus || 'Completed',
              paymentMethod: deferredPaymentMethod?.paymentMethodType || 'Card',
              processorTransactionId: String(finalProcessorTransactionId),
              processorTransactionInfoId: finalProcessorTransactionInfoId || null,
              processorResponse: finalProcessorResponse,
              paymentDate: new Date(),
              processingFeeAmount: Number(paymentProcessingFeeTotal || 0),
              setupFee: Number(totalSetupFee || 0)
            }, tx2);
          } else {
            console.log('🔒 POST-COMMIT: Payment already exists for processor transaction, skipping insert:', {
              paymentId: existingPaymentCheck.recordset[0].PaymentId,
              status: existingPaymentCheck.recordset[0].Status
            });
          }

          // Update member status after successful payment
          await tx2.request()
            .input('memberId', sql.UniqueIdentifier, deferredMemberId)
            .input('status', sql.NVarChar(20), 'Active')
            .query(`
              UPDATE oe.Members
              SET Status = @status,
                  ModifiedDate = GETUTCDATE()
              WHERE MemberId = @memberId
            `);

          await enrollmentPaymentHoldService.activatePaymentHoldEnrollmentsForMemberInTransaction(tx2, deferredMemberId, {
            tenantId,
            processorTransactionId: String(finalProcessorTransactionId),
            expectRows: false
          });

          await tx2.commit();

          await PaymentAttemptService.updateAttemptByKey(idempotencyKey, {
            status: 'Completed',
            errorMessage: null
          });

          // Payment succeeded and DB state is finalized. Fire welcome side effects now — this is
          // the first point where we are certain the enrollment actually happened. Do NOT move
          // this call earlier: firing before a successful DIME charge would cause welcome emails
          // to be sent for declined cards (which previously happened on this route).
          await fireEnrollmentCompletionSideEffects();
        } catch (finalizeErr) {
          console.error('❌ POST-COMMIT: Failed to finalize payment in DB:', finalizeErr);
          try { await PaymentAttemptService.updateAttemptByKey(idempotencyKey, { status: 'Charged', errorMessage: String(finalizeErr?.message || finalizeErr) }); } catch (e) {}
          try {
            await recordEnrollmentLifecycleError({
              category: 'EnrollmentActivation',
              source: 'complete-enrollment-post-commit-finalize',
              severity: 'error',
              tenantId,
              message: `Finalize after charge failed: ${String(finalizeErr?.message || finalizeErr)}`.slice(0, 2000),
              detail: { memberId: String(deferredMemberId), idempotencyKey, processorTransactionId: String(finalProcessorTransactionId || '') }
            });
          } catch (e) {}
          return res.status(500).json({
            success: false,
            message: 'Payment succeeded but could not be finalized in database. Please contact support.',
            error: { code: 'PAYMENT_FINALIZE_ERROR', details: finalizeErr.message }
          });
        }

        // Build payment receipt data for frontend
        let tenantNameForReceipt = '';
        try {
          const tenantResult = await pool.request()
            .input('tenantId', sql.UniqueIdentifier, tenantId)
            .query(`SELECT Name FROM oe.Tenants WHERE TenantId = @tenantId`);
          tenantNameForReceipt = tenantResult.recordset?.[0]?.Name || tenantNameForReceipt;
        } catch (e) {}

        const productsList = deferredFrontendPricing && deferredFrontendPricing.length > 0
          ? deferredFrontendPricing.map(product => ({
              productName: product.productName,
              amount: product.monthlyPremium
            }))
          : [];

        paymentReceiptData = {
          transactionId: finalProcessorTransactionId,
          amount: totalPremium,
          processingFee: combinedFees,
          systemFees: systemFeesAmount,
          paymentProcessingFee: Number(paymentProcessingFeeRemainder || 0),
          setupFee: totalSetupFee,
          totalAmount: totalPaymentAmount,
          status: paymentResult?.recordStatus || paymentResult?.status || 'Completed',
          paymentDate: new Date().toISOString(),
          paymentMethod: {
            type: deferredPaymentMethod?.paymentMethodType,
            last4: deferredPaymentMethod?.paymentMethodType === 'Card'
              ? String(deferredPaymentMethod?.cardNumber || '').slice(-4)
              : String(deferredPaymentMethod?.accountNumber || '').slice(-4),
            brand: deferredPaymentMethod?.paymentMethodType === 'Card'
              ? (deferredPaymentMethod?.cardBrand || 'Card')
              : deferredPaymentMethod?.accountType
          },
          memberInfo: {
            name: `${deferredMemberInfo.firstName} ${deferredMemberInfo.lastName}`,
            email: deferredMemberInfo.email
          },
          tenantName: tenantNameForReceipt,
          products: productsList
          // agreementsPdfUrl will be added later if PDF is generated
        };

        // Add PDF URL to payment receipt data if it was generated
        if (paymentReceiptData && pdfUrl) {
          paymentReceiptData.agreementsPdfUrl = pdfUrl;
          console.log('✅ Added agreements PDF URL to payment receipt (post-commit)');
        }

        // ✅ PAYMENT METHOD DATABASE STORAGE (Post-Commit)
        // ===================================================================
        // This is best-effort and MUST NOT fail enrollment after a successful payment.
        // (Shared with charge-first path via individualEnrollmentRecurringSetup.)
        // ===================================================================
        try {
          const pmSetupResult = await setupStoredPaymentMethodAndRecurringForIndividualEnrollment({
            pool,
            sql,
            tenantId,
            memberId: deferredMemberId,
            householdId,
            memberInfo: deferredMemberInfo,
            paymentMethod: deferredPaymentMethod,
            effectiveDate: deferredEffectiveDate,
            basePremium,
            paymentProcessingFeeTotal: Number(paymentProcessingFeeTotal || 0),
            systemFeesAmount,
            userId,
            dimeCustomerIdHint: dimeCustomerId,
            // Read the tenant flag from the deferred context (we're outside the scope where
            // paymentProcessorSettings was declared — using the already-destructured value).
            chargeFirstPaymentWithRecurring: deferredChargeFirstPaymentWithRecurring === true
          });
          if (pmSetupResult?.paymentMethodSaved && !pmSetupResult?.recurringScheduled) {
            const reportId = crypto.randomUUID();
            console.warn('⚠️ POST-COMMIT: payment method saved, but recurring not scheduled', {
              tenantId,
              memberId: deferredMemberId,
              householdId,
              linkToken,
              idempotencyKey,
              reportId,
              recurringSkipReason: pmSetupResult?.recurringSkipReason || null,
              recurringErrorMessage: pmSetupResult?.recurringErrorMessage || null
            });
            try {
              await recordIntegrationError({
                category: 'enrollment-wizard',
                source: 'enrollment-links.complete-enrollment-post-commit-recurring',
                severity: 'warning',
                tenantId,
                message: String(
                  pmSetupResult?.recurringErrorMessage ||
                  pmSetupResult?.recurringSkipReason ||
                  'Recurring schedule not created after successful payment method save'
                ).slice(0, 2000),
                detail: {
                  memberId: deferredMemberId,
                  householdId,
                  linkToken,
                  idempotencyKey,
                  reportId,
                  recurringSkipReason: pmSetupResult?.recurringSkipReason || null,
                  recurringErrorMessage: pmSetupResult?.recurringErrorMessage || null
                }
              });
            } catch (e) {
              console.warn('recordIntegrationError post-commit recurring:', e?.message || e);
            }
          }
        } catch (pmErr) {
          console.error('⚠️ POST-COMMIT: Payment method storage/recurring setup failed (enrollment/payment still successful):', {
            error: pmErr?.message || String(pmErr),
            tenantId,
            memberId: deferredMemberId,
            householdId,
            linkToken,
            idempotencyKey,
            stack: pmErr?.stack
          });
          try {
            await recordIntegrationError({
              category: 'enrollment-wizard',
              source: 'enrollment-links.complete-enrollment-post-commit-pm',
              severity: 'error',
              tenantId,
              message: String(pmErr?.message || pmErr).slice(0, 2000),
              detail: {
                memberId: deferredMemberId,
                householdId,
                linkToken,
                idempotencyKey,
                stack: pmErr?.stack
              }
            });
          } catch (e) {
            console.warn('recordIntegrationError post-commit pm:', e?.message || e);
          }
        }
      }
      
      console.log(`✅ Enrollment submitted for link: ${linkToken}`);
      console.log(`📊 Created ${createdEnrollments.length} enrollments, updated ${updatedEnrollments.length} enrollments, created ${createdDependents.length} new dependents, and updated ${updatedDependents.length} existing dependents`);
      console.log(`📈 Enrollment pending - waiting for password setup`);

      // Create the first-month Unpaid invoice for individual enrollments so it
      // appears in billing/audits before DIME charges. Idempotent.
      if (deferredIndividualPaymentContext && !enrollmentLink.GroupId) {
        try {
          const invHouseholdId = deferredIndividualPaymentContext.householdId;
          const invTenantId = deferredIndividualPaymentContext.tenantId || enrollmentLink.TenantId;
          const invEffectiveDate = deferredIndividualPaymentContext.effectiveDate;
          if (invHouseholdId && invEffectiveDate) {
            const invResult = await invoiceService.createInvoiceForEnrollment(invHouseholdId, invTenantId, invEffectiveDate);
            console.log('✅ POST-COMMIT: Created first-month invoice:', {
              invoiceId: invResult?.invoiceId,
              alreadyFulfilled: invResult?.alreadyFulfilled,
              householdId: invHouseholdId,
              effectiveDate: invEffectiveDate
            });
          }
        } catch (invErr) {
          console.warn('⚠️ POST-COMMIT: first-month invoice creation failed (non-blocking):', invErr?.message || invErr);
        }
      }

      console.log('🔍🔍🔍 POST-COMMIT: Ensuring Member role - isAgentStatic:', isAgentStatic, 'isNewUser:', isNewUser, 'userId:', userId);

      // Apply deferred member/user updates AFTER commit (fire-and-forget)
      if (deferredMemberFrontendUpdate || deferredUserFrontendUpdate) {
        void (async () => {
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          const attempts = [250, 750, 2000]; // quick retries in case the blocker clears
          for (let i = 0; i < attempts.length; i++) {
            try {
              if (deferredMemberFrontendUpdate) {
                const r = pool.request();
                r.timeout = 15000;
                r.input('memberId', sql.UniqueIdentifier, deferredMemberFrontendUpdate.memberId);
                r.input('modifiedBy', sql.UniqueIdentifier, deferredMemberFrontendUpdate.modifiedBy);
                r.input('tobaccoUse', sql.NVarChar, deferredMemberFrontendUpdate.tobaccoUse);
                r.input('tier', sql.NVarChar, deferredMemberFrontendUpdate.tier);
                r.input('dateOfBirth', sql.Date, deferredMemberFrontendUpdate.dateOfBirth);
                r.input('gender', sql.NVarChar, deferredMemberFrontendUpdate.gender);
                r.input('address', sql.NVarChar, deferredMemberFrontendUpdate.address);
                r.input('city', sql.NVarChar, deferredMemberFrontendUpdate.city);
                r.input('state', sql.NVarChar, deferredMemberFrontendUpdate.state);
                r.input('zip', sql.NVarChar, deferredMemberFrontendUpdate.zip);
                r.input('ssn', sql.NVarChar, deferredMemberFrontendUpdate.ssn);
                r.input('height', sql.Int, deferredMemberFrontendUpdate.height);
                r.input('weight', sql.Int, deferredMemberFrontendUpdate.weight);
                await r.query(`
                  SET LOCK_TIMEOUT 10000;
                  UPDATE oe.Members
                  SET TobaccoUse = COALESCE(@tobaccoUse, TobaccoUse),
                      Tier = COALESCE(@tier, Tier),
                      DateOfBirth = COALESCE(@dateOfBirth, DateOfBirth),
                      Gender = COALESCE(@gender, Gender),
                      Address = COALESCE(@address, Address),
                      City = COALESCE(@city, City),
                      State = COALESCE(@state, State),
                      Zip = COALESCE(@zip, Zip),
                      SSN = CASE WHEN @ssn IS NULL OR LTRIM(RTRIM(@ssn)) = '' THEN SSN ELSE @ssn END,
                      Height = COALESCE(@height, Height),
                      Weight = COALESCE(@weight, Weight),
                      ModifiedDate = GETUTCDATE(),
                      ModifiedBy = @modifiedBy
                  WHERE MemberId = @memberId
                `);
                console.log('✅ POST-COMMIT: Deferred oe.Members update applied');
                deferredMemberFrontendUpdate = null;
              }

              if (deferredUserFrontendUpdate) {
                const r2 = pool.request();
                r2.timeout = 15000;
                r2.input('userId', sql.UniqueIdentifier, deferredUserFrontendUpdate.userId);
                r2.input('firstName', sql.NVarChar, deferredUserFrontendUpdate.firstName);
                r2.input('lastName', sql.NVarChar, deferredUserFrontendUpdate.lastName);
                r2.input('phoneNumber', sql.NVarChar, deferredUserFrontendUpdate.phoneNumber);
                await r2.query(`
                  SET LOCK_TIMEOUT 10000;
                  UPDATE oe.Users
                  SET FirstName = COALESCE(@firstName, FirstName),
                      LastName = COALESCE(@lastName, LastName),
                      PhoneNumber = COALESCE(@phoneNumber, PhoneNumber),
                      ModifiedDate = GETUTCDATE()
                  WHERE UserId = @userId
                `);
                console.log('✅ POST-COMMIT: Deferred oe.Users update applied');
                deferredUserFrontendUpdate = null;
              }

              if (!deferredMemberFrontendUpdate && !deferredUserFrontendUpdate) return;
            } catch (e) {
              console.warn('⚠️ POST-COMMIT: Deferred profile update attempt failed:', e?.message || e);
            }
            await sleep(attempts[i]);
          }
          if (deferredMemberFrontendUpdate || deferredUserFrontendUpdate) {
            console.warn('⚠️ POST-COMMIT: Deferred profile updates still blocked after retries');
          }
        })();
      }

      // Persist password setup token AFTER commit (avoids UPDATE oe.Users inside long transaction → lock contention / timeout)
      if (passwordSetupToken && passwordSetupExpiry && userId) {
        try {
          const updateTokenRequest = pool.request();
          updateTokenRequest.input('userId', sql.UniqueIdentifier, userId);
          updateTokenRequest.input('resetPasswordToken', sql.NVarChar, passwordSetupToken);
          updateTokenRequest.input('resetPasswordExpiry', sql.DateTime2, passwordSetupExpiry);
          await updateTokenRequest.query(`
            UPDATE oe.Users
            SET ResetPasswordToken = @resetPasswordToken,
                ResetPasswordExpiry = @resetPasswordExpiry,
                ModifiedDate = GETUTCDATE()
            WHERE UserId = @userId
          `);
          console.log('✅ Password setup token persisted to oe.Users');
        } catch (tokenErr) {
          console.error('⚠️ Failed to persist password setup token (email may still send):', tokenErr.message);
        }
      }
      
      // Ensure Member role AFTER transaction commits (idempotent). Previously only (Agent-Static|Marketing)&&isNewUser,
      // which skipped individual enrollments and static/marketing flows that reused an existing oe.Users row.
      if (userId) {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        let lastRoleErr = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            console.log(`🔍 Ensuring Member role for portal (attempt ${attempt}):`, userId);
            await UserRolesService.assignRoleToUser(userId, 'Member', null);
            console.log('✅ Member role present for user');
            lastRoleErr = null;
            break;
          } catch (roleError) {
            lastRoleErr = roleError;
            console.error(`⚠️ Member role assignment attempt ${attempt} failed:`, roleError.message);
            if (attempt < 3) await sleep(200 * attempt);
          }
        }
        if (lastRoleErr) {
          console.error('❌ CRITICAL: Member role still missing after retries — user may be unable to use member portal:', userId, lastRoleErr.message);
        }
      }
      
      // Send password setup email to new members (for all enrollment types: individual, group, and agent-static)
      // Use local variable first, fallback to req.body, then fetch from database if needed
      if (!passwordSetupToken && req.body.passwordSetupToken) {
        passwordSetupToken = req.body.passwordSetupToken;
      }
      
      // If still no token, fetch from database (for existing users)
      if (!passwordSetupToken && userId && memberEmail) {
        try {
          const tokenQuery = `
            SELECT ResetPasswordToken, ResetPasswordExpiry
            FROM oe.Users
            WHERE UserId = @userId
          `;
          const tokenRequest = pool.request();
          tokenRequest.input('userId', sql.UniqueIdentifier, userId);
          const tokenResult = await tokenRequest.query(tokenQuery);
          if (tokenResult.recordset.length > 0 && tokenResult.recordset[0].ResetPasswordToken) {
            const expiry = new Date(tokenResult.recordset[0].ResetPasswordExpiry);
            if (expiry > new Date()) {
              passwordSetupToken = tokenResult.recordset[0].ResetPasswordToken;
              console.log('✅ Retrieved password setup token from database');
            } else {
              console.log('⚠️ Password setup token expired, generating new one...');
              // Generate new token if expired
              passwordSetupToken = require('crypto').randomBytes(32).toString('hex');
              const tokenExpiry = new Date();
              tokenExpiry.setDate(tokenExpiry.getDate() + 7);
              const updateTokenRequest = pool.request();
              updateTokenRequest.input('userId', sql.UniqueIdentifier, userId);
              updateTokenRequest.input('resetPasswordToken', sql.NVarChar, passwordSetupToken);
              updateTokenRequest.input('resetPasswordExpiry', sql.DateTime2, tokenExpiry);
              await updateTokenRequest.query(`
                UPDATE oe.Users
                SET ResetPasswordToken = @resetPasswordToken,
                    ResetPasswordExpiry = @resetPasswordExpiry,
                    ModifiedDate = GETUTCDATE()
                WHERE UserId = @userId
              `);
              console.log('✅ Generated new password setup token for expired token');
            }
          }
        } catch (tokenError) {
          console.error('⚠️ Failed to fetch password setup token from database:', tokenError.message);
        }
      }
      
      console.log('🔍 DEBUG: Password email check:', {
        isAgentStatic,
        isGroupEnrollment,
        isNewUser,
        memberEmail,
        hasPasswordSetupToken: !!passwordSetupToken,
        passwordSetupToken: passwordSetupToken ? 'EXISTS' : 'MISSING',
        userId: userId
      });
      
      // Send password setup email for all enrollments (even if user exists - they may need to reset password)
      if (memberEmail && passwordSetupToken) {
        try {
          console.log('📧 Sending password setup email to:', memberEmail);
          
          // Use request origin (frontend URL) if available, otherwise use protocol + host from request
          // Never use localhost as fallback
          const baseUrl = req.get('origin') || `${req.protocol}://${req.get('host')}`;
          const passwordSetupLink = `${baseUrl}/setup-password/${passwordSetupToken}`;
          
          // Import EmailTemplatesService for HTML minification
          const EmailTemplatesService = require('../services/emailTemplates.service');
          
          const emailBody = `<h2>Welcome to Your Health Benefits Portal!</h2><p>Dear ${memberFirstName || 'Member'},</p><p>Thank you for completing your enrollment! To access your member portal and view your benefits, please set up your password.</p><p style="margin: 30px 0;"><a href="${passwordSetupLink}" style="background-color: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Set Up Your Password</a></p><p><strong>If you have already set up your password, you can sign in to your portal at any time.</strong></p><p>This link will expire in 7 days for security purposes.</p><p>If the button above doesn't work, copy and paste this link into your browser:</p><p style="word-break: break-all; color: #666; background-color: #f9fafb; padding: 10px; border-radius: 4px;">${passwordSetupLink}</p><hr style="margin: 30px 0; border: none; border-top: 1px solid #e5e7eb;"><p style="color: #6b7280; font-size: 14px;">If you did not complete an enrollment, please disregard this email or contact support if you have concerns.</p>`;
          
          // Minify HTML to prevent email clients from adding whitespace
          const minifiedEmailBody = EmailTemplatesService.minifyHtml(emailBody);
          
          await MessageQueueService.queueMessage({
            tenantId: enrollmentLink.TenantId,
            messageType: 'Email',
            recipientAddress: memberEmail,
            subject: 'Complete Your Account Setup - Set Your Password',
            messageBody: minifiedEmailBody,
            status: 'Pending',
            createdBy: userId,
            recipientId: userId
          });
          
          console.log('✅ Password setup email queued successfully');
        } catch (emailError) {
          console.error('⚠️ Failed to queue password setup email (enrollment still successful):', emailError.message);
          // Don't fail the enrollment - member can still set password via wizard
        }
      }
      
      posthog.capture({
        distinctId: finalMemberId ? String(finalMemberId) : linkToken,
        event: 'enrollment completed',
        properties: {
          link_token: linkToken,
          link_type: enrollmentLink.LinkType,
          tenant_id: enrollmentLink.TenantId ? String(enrollmentLink.TenantId) : undefined,
          enrollment_count: (createdEnrollments || []).length + (updatedEnrollments || []).length,
          payment_deferred: !!paymentDeferredToEffectiveDate,
          effective_date: (createdEnrollments && createdEnrollments.length > 0) ? createdEnrollments[0].effectiveDate : null,
        },
      });

      return res.json({
        success: true,
        data: {
          message: 'Enrollment submitted successfully - please complete password setup',
          memberId: finalMemberId, // Include memberId for subsequent calls (e.g., acknowledgements)
          enrollments: [...(createdEnrollments || []), ...(updatedEnrollments || [])],
          dependents: [...(createdDependents || []), ...(updatedDependents || [])],
          effectiveDate: (createdEnrollments && createdEnrollments.length > 0) ? createdEnrollments[0].effectiveDate : null,
          // NEW: Include PDF info if generated
          agreementsPdfUrl: pdfUrl || null,
          // NEW: Include payment receipt data for individual enrollments
          paymentReceipt: paymentReceiptData || null,
          // When the tenant's chargeFirstPaymentWithRecurring flag is on, no charge ran today —
          // DIME recurring will charge on the effective date. Frontend can swap copy on success.
          paymentDeferredToEffectiveDate
        },
        message: 'Enrollment submitted successfully - please complete password setup'
      });
      
    } catch (error) {
      // Charge-first: if we charged but the transaction failed, refund and return specific error so UI can show refund message
      if (chargeFirstResult) {
        const refundOutcome = await DimeService.refundTransaction(
          chargeFirstResult.processorTransactionId,
          chargeFirstResult.totalPaymentAmount,
          chargeFirstResult.tenantId
        );
        console.error('❌ Charge-first: transaction failed after charge; refund issued:', refundOutcome.success ? 'OK' : refundOutcome.error?.message);
        if (transaction && transaction._acquiredConnection) {
          try { await transaction.rollback(); } catch (rollbackError) {}
        }
        return res.status(400).json({
          success: false,
          message: 'Enrollment could not be completed. Your payment has been refunded.',
          error: {
            code: 'ENROLLMENT_FAILED_REFUND_ISSUED',
            message: 'Due to a technical error we could not complete your enrollment. Your payment has been refunded.',
            details: 'Your payment has been refunded; you should see the credit within a few business days. Please try again or contact support.'
          }
        });
      }
      // Only rollback if transaction is still active (not yet committed)
      if (transaction && transaction._acquiredConnection) {
        try {
      await transaction.rollback();
        } catch (rollbackError) {
          console.error('⚠️ Error during rollback (transaction may already be committed):', rollbackError.message);
        }
      }
      throw error;
    } finally {
      // Safety net: if any code path returned a response without explicitly committing or rolling back,
      // roll back now so we never leak a SQL Server transaction holding locks on shared tables
      // (e.g. oe.TenantProductSubscriptions). See: April 2026 incident where a leaked tx blocked
      // oe.EnrollmentLinks inserts for ~40 minutes because of three early-return paths that
      // skipped rollback. `_acquiredConnection` is non-null only when tx is still open.
      if (transaction && transaction._acquiredConnection) {
        try {
          await transaction.rollback();
          console.warn('⚠️ [complete-enrollment] finally-block rollback fired — an earlier code path returned without committing or rolling back. Fix that path.');
        } catch (finalRbErr) {
          // Already committed/rolled back on a different branch — safe to ignore
        }
      }
    }
    
  } catch (error) {
    console.error('❌ Error completing enrollment:', error);
    console.error('❌ Error stack:', error.stack);
    console.error('❌ Error details:', {
      message: error.message,
      code: error.code,
      name: error.name,
      number: error.number,
      state: error.state,
      class: error.class,
      serverName: error.serverName,
      procName: error.procName,
      lineNumber: error.lineNumber
    });
    
    // Return detailed error information for debugging
    const errorResponse = {
      success: false,
      message: error.message || 'Server error while completing enrollment',
      error: {
        message: error.message,
        code: error.code,
        name: error.name,
        ...(error.number && { number: error.number }),
        ...(error.state && { state: error.state }),
        ...(error.class && { class: error.class }),
        ...(error.procName && { procName: error.procName }),
        ...(error.lineNumber && { lineNumber: error.lineNumber })
      }
    };
    
    // Determine appropriate status code
    const statusCode = error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED' ? 503
      : error.code === 'ER_DUP_ENTRY' || error.code === 'EREQUEST' && error.number === 2627 ? 409
      : error.message && error.message.includes('not found') ? 404
      : error.message && error.message.includes('required') ? 400
      : 500;
    
    res.status(statusCode).json(errorResponse);
  }
});

// GET /api/enrollment-links/:linkToken/product-acknowledgements - Get acknowledgements for selected products
router.get('/:linkToken/product-acknowledgements', async (req, res) => {
  try {
    const { linkToken } = req.params;
    const { selectedProducts } = req.query;
    
    console.log('🔍 DEBUG: Product acknowledgements request:', {
      linkToken,
      selectedProducts: selectedProducts ? selectedProducts.split(',') : []
    });
    
    // Validate required parameters
    if (!linkToken || !selectedProducts) {
      return res.status(400).json({
        success: false,
        message: 'Link token and selected products are required'
      });
    }
    
    const productIds = selectedProducts.split(',');
    
    const pool = await getPool();
    
    // 1. Get enrollment link to validate it's active
    const linkQuery = `
      SELECT 
        el.LinkId,
        el.GroupId,
        el.LinkToken,
        el.IsActive,
        el.ExpiresAt,
        el.UsageCount,
        el.MaxUsage
      FROM oe.EnrollmentLinks el
      WHERE el.LinkToken = @linkToken
    `;
    
    const linkRequest = pool.request();
    linkRequest.input('linkToken', sql.NVarChar, linkToken);
    
    const linkResult = await linkRequest.query(linkQuery);
    
    if (linkResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Enrollment link not found'
      });
    }
    
    const enrollmentLink = linkResult.recordset[0];
    
    // 2. Validate enrollment link status
    if (!enrollmentLink.IsActive) {
      return res.status(400).json({
        success: false,
        message: 'Enrollment link is inactive'
      });
    }
    
    if (enrollmentLink.ExpiresAt && new Date(enrollmentLink.ExpiresAt) < new Date()) {
      return res.status(400).json({
        success: false,
        message: 'Enrollment link has expired'
      });
    }
    
    if (enrollmentLink.MaxUsage && enrollmentLink.UsageCount >= enrollmentLink.MaxUsage) {
      return res.status(400).json({
        success: false,
        message: 'Enrollment link usage limit reached'
      });
    }
    
    // 3. Get acknowledgements and questionnaires for selected products AND products included in selected bundles
    const acknowledgementsQuery = `
      SELECT
        p.ProductId,
        p.Name AS ProductName,
        p.ProductType,
        p.AcknowledgementQuestions,
        p.ProductQuestionnaires,
        'direct' as SelectionType
      FROM oe.Products p
      WHERE p.ProductId IN (${productIds.map((_, index) => `@product${index}`).join(',')})
        AND p.Status = 'Active'

      UNION ALL

      SELECT
        p.ProductId,
        p.Name AS ProductName,
        p.ProductType,
        p.AcknowledgementQuestions,
        p.ProductQuestionnaires,
        'bundle' as SelectionType
      FROM oe.Products p
      INNER JOIN oe.ProductBundles pb ON p.ProductId = pb.IncludedProductId
      WHERE pb.BundleProductId IN (${productIds.map((_, index) => `@product${index}`).join(',')})
        AND p.Status = 'Active'
    `;
    
    const acknowledgementsRequest = pool.request();
    productIds.forEach((id, index) => {
      acknowledgementsRequest.input(`product${index}`, sql.UniqueIdentifier, id);
    });
    
    const acknowledgementsResult = await acknowledgementsRequest.query(acknowledgementsQuery);
    
    // 4. Process acknowledgements (avoid duplicates)
    const productAcknowledgements = [];
    const processedProductIds = new Set();
    
    for (const product of acknowledgementsResult.recordset) {
      // Skip if we've already processed this product
      if (processedProductIds.has(product.ProductId)) {
        continue;
      }
      
      let acknowledgements = [];
      
      if (product.AcknowledgementQuestions) {
        try {
          acknowledgements = JSON.parse(product.AcknowledgementQuestions);
        } catch (parseError) {
          console.log(`⚠️ DEBUG: Could not parse acknowledgements for ${product.ProductName}:`, parseError.message);
          acknowledgements = [];
        }
      }
      
      if (acknowledgements.length > 0) {
        productAcknowledgements.push({
          productId: product.ProductId,
          productName: product.ProductName,
          productType: product.ProductType,
          selectionType: product.SelectionType,
          acknowledgements: acknowledgements.map((ack) => ({
            id: ack.id,
            question: ack.question,
            fieldType: ack.fieldType,
            required: ack.required,
            options: ack.options || [],
            customAction: ack.customAction
          }))
        });
        
        // Mark this product as processed
        processedProductIds.add(product.ProductId);
      }
    }
    
    console.log(`✅ DEBUG: Retrieved acknowledgements for ${productAcknowledgements.length} products`);

    // 5. Process product questionnaires (avoid duplicates)
    const productQuestionnaires = [];
    const processedQuestionnaireProductIds = new Set();
    let requiresHeightWeight = false;

    for (const product of acknowledgementsResult.recordset) {
      if (processedQuestionnaireProductIds.has(product.ProductId)) {
        continue;
      }

      if (product.ProductQuestionnaires) {
        try {
          const questionnaire = typeof product.ProductQuestionnaires === 'string'
            ? JSON.parse(product.ProductQuestionnaires)
            : product.ProductQuestionnaires;

          if (questionnaire && questionnaire.enabled) {
            productQuestionnaires.push({
              productId: product.ProductId,
              productName: product.ProductName,
              productType: product.ProductType,
              selectionType: product.SelectionType,
              questionnaire: questionnaire
            });

            if (questionnaire.requiresHeightWeight) {
              requiresHeightWeight = true;
            }
          }
        } catch (parseError) {
          console.log(`⚠️ DEBUG: Could not parse ProductQuestionnaires for ${product.ProductName}:`, parseError.message);
        }
      }

      processedQuestionnaireProductIds.add(product.ProductId);
    }

    console.log(`✅ DEBUG: Retrieved questionnaires for ${productQuestionnaires.length} products, requiresHeightWeight: ${requiresHeightWeight}`);

    res.json({
      success: true,
      data: {
        productAcknowledgements,
        productQuestionnaires,
        requiresHeightWeight,
        totalProducts: productIds.length,
        productsWithAcknowledgements: productAcknowledgements.length,
        productsWithQuestionnaires: productQuestionnaires.length
      },
      message: 'Product acknowledgements retrieved successfully'
    });
    
  } catch (error) {
    console.error('❌ ERROR: Failed to get product acknowledgements:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching product acknowledgements'
    });
  }
});

// GET /api/enrollment-links/:linkToken/product-pricing - Get products with pricing using unified system
router.get('/:linkToken/product-pricing', async (req, res) => {
  try {
    const { linkToken } = req.params;
    const { memberAge, tobaccoUse, memberTier, jobPosition, selectedProducts, selectedConfigs, effectiveDate, householdSize, paymentMethod: paymentMethodQuery } = req.query;
    // Optional: for individual links, pass payment method so backend can return fee calculated on config-aware premium (ACH | Card; default ACH)
    const paymentMethodForFees = (paymentMethodQuery === 'Card' || paymentMethodQuery === 'ACH') ? paymentMethodQuery : 'ACH';
    
    console.log('🔍 DEBUG: New product pricing request:', {
      linkToken,
      memberAge: parseInt(memberAge),
      tobaccoUse,
      memberTier,
      jobPosition,
      householdSize,
      effectiveDate,
      paymentMethodForFees,
      selectedProducts: selectedProducts ? JSON.parse(selectedProducts) : null,
      selectedConfigs: selectedConfigs ? JSON.parse(selectedConfigs) : null
    });
    
    // Validate required parameters
    if (!linkToken || !memberAge || !tobaccoUse || !memberTier) {
      return res.status(400).json({
        success: false,
        message: 'Link token, member age, tobacco use, and member tier are required'
      });
    }
    
    // Validate effective date if provided
    if (effectiveDate) {
      const effectiveDateObj = new Date(effectiveDate);
      if (isNaN(effectiveDateObj.getTime())) {
        return res.status(400).json({
          success: false,
          message: 'Invalid effective date format. Expected YYYY-MM-DD'
        });
      }
    }
    
    const pool = await getPool();
    
    // Get enrollment link and group info
    // Handle TenantId for group, member, and agent-static enrollment links
    const linkQuery = `
      SELECT 
        el.LinkId,
        el.GroupId,
        el.MemberId,
        el.AgentId,
        el.LinkToken,
        el.IsActive,
        el.ExpiresAt,
        g.Name AS GroupName,
        -- TenantId logic: Group > Member > Agent (for Agent-Static links)
        CASE 
          WHEN el.GroupId IS NOT NULL THEN g.TenantId 
          WHEN el.MemberId IS NOT NULL THEN m.TenantId
          WHEN el.AgentId IS NOT NULL THEN a.TenantId
          ELSE NULL
        END AS TenantId
      FROM oe.EnrollmentLinks el
      LEFT JOIN oe.Groups g ON el.GroupId = g.GroupId
      LEFT JOIN oe.Members m ON el.MemberId = m.MemberId
      LEFT JOIN oe.Agents a ON el.AgentId = a.AgentId
      WHERE el.LinkToken = @linkToken
    `;
    
    const linkRequest = pool.request();
    linkRequest.input('linkToken', sql.NVarChar, linkToken);
    
    const linkResult = await linkRequest.query(linkQuery);
    
    if (linkResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Enrollment link not found'
      });
    }
    
    const enrollmentLink = linkResult.recordset[0];
    console.log('🔍 DEBUG: Enrollment link TenantId:', enrollmentLink.TenantId, 'GroupId:', enrollmentLink.GroupId, 'MemberId:', enrollmentLink.MemberId, 'AgentId:', enrollmentLink.AgentId);
    
    // If jobPosition not provided in query params, fetch it from member record
    let memberJobPosition = jobPosition;
    if (!memberJobPosition && enrollmentLink.MemberId) {
      try {
        const memberJobPositionRequest = pool.request();
        memberJobPositionRequest.input('memberId', sql.UniqueIdentifier, enrollmentLink.MemberId);
        const memberJobPositionResult = await memberJobPositionRequest.query(`
          SELECT JobPosition
          FROM oe.Members
          WHERE MemberId = @memberId
        `);
        if (memberJobPositionResult.recordset.length > 0 && memberJobPositionResult.recordset[0].JobPosition) {
          memberJobPosition = memberJobPositionResult.recordset[0].JobPosition;
          console.log('🔍 DEBUG: Fetched JobPosition from member record:', memberJobPosition);
        }
      } catch (error) {
        console.warn('⚠️ Failed to fetch JobPosition from member record:', error.message);
      }
    }
    
    // Get products from the enrollment link template
    const templateQuery = `
      SELECT elt.LinkMetaData, elt.TemplateType, elt.GroupId
      FROM oe.EnrollmentLinkTemplates elt
      INNER JOIN oe.EnrollmentLinks el ON el.EnrollmentLinkTemplateId = elt.TemplateId
      WHERE el.LinkToken = @linkToken
    `;

    const templateRequest = pool.request();
    templateRequest.input('linkToken', sql.NVarChar, linkToken);

    const templateResult = await templateRequest.query(templateQuery);

    if (templateResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Enrollment link template not found'
      });
    }

    const templateRow = templateResult.recordset[0];
    const linkMetaData = JSON.parse(templateRow.LinkMetaData);
    const availableProducts = [];

    // For Group enrollment links, pull products from oe.GroupProducts
    const isGroupLink = templateRow.TemplateType === 'Group' && templateRow.GroupId;

    if (isGroupLink) {
      const gpReq = pool.request();
      gpReq.input('groupId', sql.UniqueIdentifier, templateRow.GroupId);
      const gpRes = await gpReq.query(`
        SELECT gp.ProductId
        FROM oe.GroupProducts gp
        INNER JOIN oe.Products p ON gp.ProductId = p.ProductId
        WHERE gp.GroupId = @groupId AND gp.IsActive = 1 AND p.Status = 'Active'
          AND (p.IsHidden IS NULL OR p.IsHidden = 0)
          AND (gp.IsHidden IS NULL OR gp.IsHidden = 0)
      `);
      availableProducts.push(...gpRes.recordset.map(r => r.ProductId));
      console.log('🔍 DEBUG: Group link — loaded', availableProducts.length, 'products from GroupProducts');
    } else if (linkMetaData.products) {
      // Extract product IDs from the template (Individual links)
      for (const section of linkMetaData.products) {
        if (section.specificProducts && section.specificProducts.length > 0) {
          availableProducts.push(...section.specificProducts);
        } else if (section.specificBundles && section.specificBundles.length > 0) {
          // Handle bundle products - add the bundle itself, not its included products
          availableProducts.push(...section.specificBundles);
        } else if (section.includeAllProducts) {
          // If includeAllProducts is true, fetch all active products
          const allProductsQuery = `
            SELECT ProductId
            FROM oe.Products
            WHERE Status = 'Active'
          `;
          const allProductsRequest = pool.request();
          const allProductsResult = await allProductsRequest.query(allProductsQuery);
          availableProducts.push(...allProductsResult.recordset.map(p => p.ProductId));
          console.log('🔍 DEBUG: Fetched all active products:', allProductsResult.recordset.length);
        }
      }
    }
    
    console.log('🔍 DEBUG: Found available products from template:', availableProducts.length);
    
    // ALWAYS calculate pricing for ALL available products (so UI can display them)
    // But contributions/totals will ONLY be calculated for selected products
    const productsForPricing = availableProducts; // Always all products for pricing display
    
    // Parse selectedProducts - only used for contribution calculations
    let selectedProductsForContributions = [];
    if (selectedProducts) {
      try {
        const parsedSelectedProducts = typeof selectedProducts === 'string' 
          ? JSON.parse(selectedProducts) 
          : selectedProducts;
        if (Array.isArray(parsedSelectedProducts) && parsedSelectedProducts.length > 0) {
          // Filter to only products that are available in the template
          selectedProductsForContributions = parsedSelectedProducts.filter(productId => 
            availableProducts.includes(productId)
          );
          console.log('🔍 DEBUG: Selected products for contributions:', {
            received: parsedSelectedProducts.length,
            afterFilter: selectedProductsForContributions.length,
            available: availableProducts.length,
            selectedIds: parsedSelectedProducts,
            filteredIds: selectedProductsForContributions
          });
        } else {
          console.log('🔍 DEBUG: No products selected - contributions will be $0', {
            parsedSelectedProducts,
            isArray: Array.isArray(parsedSelectedProducts),
            length: parsedSelectedProducts?.length || 0
          });
        }
      } catch (error) {
        console.warn('⚠️ Failed to parse selectedProducts:', error.message);
      }
    }
    
    // If no available products, return empty results
    if (productsForPricing.length === 0) {
      console.log('🔍 DEBUG: No available products in template');
      return res.json({
        success: true,
        data: {
          products: [],
          contributions: {
            employerTotal: 0,
            employeeTotal: 0,
            productContributions: {},
            appliedRules: [],
            calculationDetails: 'No products available'
          },
          totals: {
            totalPremium: 0,
            totalEmployerContribution: 0,
            totalEmployeeContribution: 0
          },
          allProductsRules: [],
          calculationType: 'enrollment',
          calculatedAt: new Date().toISOString()
        }
      });
    }
    
    // Parse selectedConfigs
    const parsedSelectedConfigs = selectedConfigs ? JSON.parse(selectedConfigs) : {};
    
    // Calculate pricing for ALL available products (so UI can display them all)
    const pricingParams = {
      calculationType: 'enrollment',
      memberCriteria: {
        age: parseInt(memberAge) || 35, // Default to 35 if age is invalid
        tobaccoUse: tobaccoUse || 'No', // Default to 'No' if not provided
        tier: memberTier || 'EE', // Default to 'EE' if not provided
        householdSize: Math.max(1, parseInt(householdSize, 10) || 1), // From query; default 1 so pricing is correct when no contribution-preview
        jobPosition: memberJobPosition || undefined // Use job position from query param or member record
      },
      productSelections: productsForPricing.map(productId => {
        const configValue = parsedSelectedConfigs[productId];
        // Convert string config value to object format expected by PricingEngine
        // Treat 'Default' as empty (no config selected)
        const configValues = configValue && configValue !== 'Default'
          ? (typeof configValue === 'string' ? { configValue1: configValue } : configValue)
          : {};
        return {
          productId,
          configValues
        };
      }),
      groupId: enrollmentLink.GroupId,
      effectiveDate: effectiveDate || null // Pass effective date to PricingEngine
    };
    
    console.log('🔍 DEBUG: Pricing params with memberCriteria:', {
      ...pricingParams,
      memberCriteria: {
        ...pricingParams.memberCriteria,
        jobPosition: pricingParams.memberCriteria.jobPosition || 'NOT PROVIDED'
      }
    });
    
    console.log('🔍 DEBUG: Calling PricingEngine for ALL products (pricing only):', pricingParams.productSelections.length, 'products');
    
    // Calculate pricing for ALL products (so UI can display them all)
    const pricingResult = await PricingEngine.calculatePricing(pricingParams);
    // Snapshot before we mutate premiums by folding in included processing fees.
    // Used for system fee calculations which should be based on premium-only totals.
    const productsBeforeIncludedProcessingFee = JSON.parse(JSON.stringify(pricingResult.products || []));
    
    console.log('🔍 DEBUG: PricingEngine returned:', {
      hasProducts: !!pricingResult.products,
      productsCount: pricingResult.products?.length || 0,
      hasContributions: !!pricingResult.contributions,
      hasTotals: !!pricingResult.totals
    });
    
    // Now calculate contributions ONLY for selected products
    let contributionResults = pricingResult.contributions;
    let totals = pricingResult.totals;
    
    if (selectedProductsForContributions.length > 0) {
      console.log('🔍 DEBUG: Calculating contributions for selected products only:', selectedProductsForContributions.length);
      
      // Filter pricing results to only selected products for contribution calculation
      const selectedProductsPricing = pricingResult.products.filter(p => 
        selectedProductsForContributions.includes(p.productId)
      );
      
      if (selectedProductsPricing.length > 0 && enrollmentLink.GroupId) {
        // Recalculate contributions only for selected products
        const ContributionCalculator = require('../services/pricing/ContributionCalculator');
        contributionResults = await ContributionCalculator.calculateContributions({
          groupId: enrollmentLink.GroupId,
          productPricingResults: selectedProductsPricing,
          memberCriteria: pricingParams.memberCriteria
        });
        
        // Recalculate totals based on selected products only
        const totalPremium = selectedProductsPricing.reduce((sum, p) => sum + p.monthlyPremium, 0);
        totals = {
          totalPremium,
          totalEmployerContribution: contributionResults.employerTotal,
          totalEmployeeContribution: contributionResults.employeeTotal
        };
        
        console.log('🔍 DEBUG: Contributions recalculated for selected products:', {
          selectedCount: selectedProductsPricing.length,
          selectedProductIds: selectedProductsPricing.map(p => p.productId),
          totalPremium: totals.totalPremium,
          employerContribution: totals.totalEmployerContribution,
          employeeContribution: totals.totalEmployeeContribution,
          contributionResults: {
            employerTotal: contributionResults.employerTotal,
            employeeTotal: contributionResults.employeeTotal,
            productContributionsKeys: Object.keys(contributionResults.productContributions || {}),
            appliedRulesCount: contributionResults.appliedRules?.length || 0
          }
        });
      } else {
        // No selected products or no group (individual) - no employer contribution; return config-aware totals for individuals
        const ContributionCalculatorForTotals = require('../services/pricing/ContributionCalculator');
        const totalPremiumIndividual = selectedProductsPricing.length > 0
          ? selectedProductsPricing.reduce((sum, p) => sum + (Number(p.monthlyPremium) || 0), 0)
          : 0;
        contributionResults = {
          employerTotal: 0,
          employeeTotal: totalPremiumIndividual,
          productContributions: selectedProductsPricing.length > 0
            ? ContributionCalculatorForTotals.createEmptyProductContributions(selectedProductsPricing)
            : {},
          appliedRules: [],
          calculationDetails: selectedProductsPricing.length === 0 ? 'No products selected' : 'No group contributions'
        };
        totals = {
          totalPremium: totalPremiumIndividual,
          totalEmployerContribution: 0,
          totalEmployeeContribution: totalPremiumIndividual
        };
      }
    } else {
      // No products selected - zero contributions but keep all products with pricing
      contributionResults = {
        employerTotal: 0,
        employeeTotal: 0,
        productContributions: {},
        appliedRules: [],
        calculationDetails: 'No products selected'
      };
      totals = {
        totalPremium: 0,
        totalEmployerContribution: 0,
        totalEmployeeContribution: 0
      };
      console.log('🔍 DEBUG: No products selected - contributions set to $0, but all products returned with pricing');
      console.log('🔍 DEBUG: selectedProductsForContributions is empty, raw selectedProducts from query:', selectedProducts);
    }
    
    // Update products with contributions (only selected products will have contributions)
    const productsWithContributions = pricingResult.products.map(product => {
      if (selectedProductsForContributions.includes(product.productId)) {
        // This product is selected - use calculated contributions
        const productContribution = contributionResults.productContributions[product.productId] || {
          productSpecific: 0,
          allProductsShare: 0,
          total: 0,
          employeeContribution: product.monthlyPremium
        };
        return {
          ...product,
          employerContribution: productContribution.total,
          employeeContribution: productContribution.employeeContribution
        };
      } else {
        // This product is not selected - no contributions
        return {
          ...product,
          employerContribution: 0,
          employeeContribution: product.monthlyPremium
        };
      }
    });
    
    // Update pricingResult with recalculated contributions and totals
    pricingResult.products = productsWithContributions;
    pricingResult.contributions = contributionResults;
    pricingResult.totals = totals;
    
    // Fetch CustomSettings from oe.GroupProducts for all products to filter configuration options
    const groupProductSettingsMap = new Map();
    if (pricingResult.products && pricingResult.products.length > 0) {
      const productIds = pricingResult.products.map(p => p.productId);
      const placeholders = productIds.map((_, i) => `@productId${i}`).join(',');
      const groupProductSettingsQuery = `
        SELECT ProductId, CustomSettings
        FROM oe.GroupProducts
        WHERE GroupId = @groupId
          AND ProductId IN (${placeholders})
          AND IsActive = 1
      `;
      
      const settingsRequest = pool.request();
      settingsRequest.input('groupId', sql.UniqueIdentifier, enrollmentLink.GroupId);
      productIds.forEach((productId, i) => {
        settingsRequest.input(`productId${i}`, sql.UniqueIdentifier, productId);
      });
      
      try {
        const settingsResult = await settingsRequest.query(groupProductSettingsQuery);
        settingsResult.recordset.forEach(record => {
          let customSettings = {};
          if (record.CustomSettings) {
            try {
              customSettings = typeof record.CustomSettings === 'string' 
                ? JSON.parse(record.CustomSettings) 
                : record.CustomSettings;
            } catch (error) {
              console.warn(`⚠️ Failed to parse CustomSettings for product ${record.ProductId}:`, error);
            }
          }
          groupProductSettingsMap.set(record.ProductId.toString(), customSettings);
        });
        console.log('🔍 DEBUG: Fetched CustomSettings for', settingsResult.recordset.length, 'products');
      } catch (error) {
        console.warn('⚠️ Failed to fetch CustomSettings from GroupProducts:', error);
      }
    }
    
    // Helper function to filter configuration options based on allowedDeductibleOptions
    const filterConfigOptions = (product, customSettings) => {
      // Safety check: if product is null/undefined, return as-is
      if (!product) {
        return product;
      }
      
      if (!customSettings || !customSettings.allowedDeductibleOptions) {
        return product; // No filtering needed
      }
      
      const allowedOptions = customSettings.allowedDeductibleOptions;
      let filteredProduct = { ...product };
      
      // Filter availableConfigs
      if (product.availableConfigs && Array.isArray(product.availableConfigs)) {
        filteredProduct.availableConfigs = product.availableConfigs.filter(config => {
          // Check if this config value is in any of the allowed options arrays
          return Object.values(allowedOptions).some(allowedArray => 
            Array.isArray(allowedArray) && allowedArray.includes(config)
          );
        });
        console.log(`🔍 DEBUG: Filtered availableConfigs for ${product.productName}:`, {
          original: product.availableConfigs.length,
          filtered: filteredProduct.availableConfigs.length,
          allowed: filteredProduct.availableConfigs
        });
      }
      
      // Filter pricingVariations to only include allowed configs
      // SKIP filtering for bundles - they come pre-calculated from BundleProcessor with correct pricing
      if (product.isBundle) {
        // For bundles, preserve pricingVariations as-is (they're already correctly calculated by BundleProcessor)
        // Bundle pricingVariations are based on configurable subproducts and should not be filtered here
        filteredProduct.pricingVariations = product.pricingVariations;
      } else if (product.pricingVariations && Array.isArray(product.pricingVariations)) {
        // Only filter if we have availableConfigs after filtering (don't remove all variations if no configs match)
        if (filteredProduct.availableConfigs && filteredProduct.availableConfigs.length > 0) {
          filteredProduct.pricingVariations = product.pricingVariations.filter(variation => {
            // Handle type mismatches - convert both to strings for comparison
            const variationConfigValue = String(variation.configValue || '');
            const availableConfigsStrings = filteredProduct.availableConfigs.map(c => String(c));
            return availableConfigsStrings.includes(variationConfigValue);
          });
        } else {
          // If no availableConfigs after filtering, keep all pricing variations (no filtering applied)
          filteredProduct.pricingVariations = product.pricingVariations;
        }
        console.log(`🔍 DEBUG: Filtered pricingVariations for ${product.productName || 'unknown'}:`, {
          original: product.pricingVariations.length,
          filtered: filteredProduct.pricingVariations.length,
          hasAvailableConfigs: filteredProduct.availableConfigs?.length > 0,
          availableConfigs: filteredProduct.availableConfigs,
          variationConfigValues: product.pricingVariations.map(v => v.configValue)
        });
      }
      
      // Update defaultConfig if it's not in the allowed options
      if (filteredProduct.defaultConfig && filteredProduct.availableConfigs && Array.isArray(filteredProduct.availableConfigs) && !filteredProduct.availableConfigs.includes(filteredProduct.defaultConfig)) {
        filteredProduct.defaultConfig = filteredProduct.availableConfigs[0] || null;
        console.log(`🔍 DEBUG: Updated defaultConfig for ${product.productName} to:`, filteredProduct.defaultConfig);
      }
      
      // Filter requiredDataFields options
      if (product.requiredDataFields && Array.isArray(product.requiredDataFields)) {
        filteredProduct.requiredDataFields = product.requiredDataFields.map(field => {
          if (allowedOptions[field.fieldName] && Array.isArray(allowedOptions[field.fieldName])) {
            return {
              ...field,
              fieldOptions: field.fieldOptions.filter(option => 
                allowedOptions[field.fieldName].includes(option)
              )
            };
          }
          return field;
        });
      }
      
      return filteredProduct;
    };
    
    // Fetch contribution rules for all products BEFORE transforming products
    // This ensures product-specific rules are available for attachment to each product.
    // IMPORTANT: If a rule targets a bundle, ContributionCalculator enriches it with rule._productIds
    // (bundle id + included product ids). We must key the map by ALL those ids so the frontend wizard
    // can apply the rule to included products as well.
    const productSpecificRulesMap = new Map(); // Map of normalized ProductId -> Array of rules
    let allProductsRules = [];
    if (enrollmentLink.GroupId) {
      try {
        const ContributionCalculator = require('../services/pricing/ContributionCalculator');
        const allRules = await ContributionCalculator.getGroupContributionRules(enrollmentLink.GroupId);
        
        // Filter for all-products rules (ProductId is null AND no multi-product ProductIds)
        // Matches ContributionCalculator.js logic — multi-product rules with _productIds are product-specific, not all-products
        const allProductsRulesRaw = allRules.filter(rule =>
          rule.ProductId === null && (!rule._productIds || rule._productIds.length === 0)
        );

        // Create a map of product-specific rules (ProductId is set, OR has multi-product _productIds)
        const productSpecificRulesRaw = allRules.filter(rule =>
          rule.ProductId !== null || (rule._productIds && rule._productIds.length > 0)
        );
        console.log(`🔍 DEBUG: Fetched ${productSpecificRulesRaw.length} product-specific contribution rules from database`);
        
        const normId = (id) => (id == null ? '' : String(id).toLowerCase().trim());

        // Group product-specific rules by all applicable product ids (bundle + included products)
        productSpecificRulesRaw.forEach(rule => {
          const ids = Array.isArray(rule._productIds) && rule._productIds.length > 0
            ? rule._productIds
            : [rule.ProductId];
          ids.forEach((pid) => {
            const key = normId(pid);
            if (!key) return;
            if (!productSpecificRulesMap.has(key)) {
              productSpecificRulesMap.set(key, []);
            }
            productSpecificRulesMap.get(key).push(rule);
          });
        });
        
        console.log(`🔍 DEBUG: Grouped product-specific rules into ${productSpecificRulesMap.size} products`);
        console.log(`🔍 DEBUG: Product-specific rules by ProductId:`, Array.from(productSpecificRulesMap.entries()).map(([pid, rules]) => ({
          productId: pid,
          ruleCount: rules.length,
          ruleNames: rules.map(r => r.Name)
        })));
        
        console.log(`🔍 DEBUG: Fetched ${allProductsRulesRaw.length} all-products contribution rules directly from database`);
        
        allProductsRules = allProductsRulesRaw.map(rule => {
          // Parse JSON fields if they're strings
          let tierContributions = null;
          let ageRules = null;
          let jobPositions = null;
          let tenureRules = null;
          let roleContributions = null;
          
          if (rule.TierContributions) {
            try {
              tierContributions = typeof rule.TierContributions === 'string' 
                ? JSON.parse(rule.TierContributions) 
                : rule.TierContributions;
            } catch (error) {
              console.warn(`Error parsing TierContributions for all-products rule ${rule.Name}:`, error);
            }
          }
          
          if (rule.AgeRules) {
            try {
              ageRules = typeof rule.AgeRules === 'string' 
                ? JSON.parse(rule.AgeRules) 
                : rule.AgeRules;
            } catch (error) {
              console.warn(`Error parsing AgeRules for all-products rule ${rule.Name}:`, error);
            }
          }
          
          if (rule.JobPositions) {
            try {
              jobPositions = typeof rule.JobPositions === 'string' 
                ? JSON.parse(rule.JobPositions) 
                : rule.JobPositions;
            } catch (error) {
              console.warn(`Error parsing JobPositions for all-products rule ${rule.Name}:`, error);
            }
          }
          
          if (rule.TenureRules) {
            try {
              tenureRules = typeof rule.TenureRules === 'string' 
                ? JSON.parse(rule.TenureRules) 
                : rule.TenureRules;
            } catch (error) {
              console.warn(`Error parsing TenureRules for all-products rule ${rule.Name}:`, error);
            }
          }
          
          if (rule.RoleContributions) {
            try {
              roleContributions = typeof rule.RoleContributions === 'string' 
                ? JSON.parse(rule.RoleContributions) 
                : rule.RoleContributions;
            } catch (error) {
              console.warn(`Error parsing RoleContributions for all-products rule ${rule.Name}:`, error);
            }
          }
          
          return {
            type: rule.ContributionType,
            amount: rule.FlatRateAmount || rule.PercentageAmount || 0,
            description: rule.Name || `${rule.ContributionType} of remaining premium`,
            appliesTo: 'remaining_premium',
            contributionDirection: rule.ContributionDirection || 'Employer',
            equivalentTier: rule.EquivalentTier || null,
            // Include all rule details for frontend
            tierContributions: tierContributions || undefined,
            ageRules: ageRules || undefined,
            jobPositions: jobPositions || undefined,
            tenureRules: tenureRules || undefined,
            roleContributions: roleContributions || undefined,
            priority: rule.Priority || 0,
            stacking: rule.Stacking !== undefined ? rule.Stacking : true,
            appliesToRestrictions: rule.AppliesTo ? (typeof rule.AppliesTo === 'string' ? JSON.parse(rule.AppliesTo) : rule.AppliesTo) : undefined
          };
        });
      } catch (error) {
        console.error('⚠️ Failed to fetch contribution rules:', error);
        allProductsRules = [];
      }
    }
    
    // Transform the response to return contribution rules instead of calculated contributions
    const transformedProducts = await Promise.all(pricingResult.products.map(async (product) => {
      // Get CustomSettings for this product and filter configuration options
      const customSettings = groupProductSettingsMap.get(product.productId.toString());
      const filteredProduct = filterConfigOptions(product, customSettings);
      // Get SetupFee from TenantProductSubscriptions for this product
      let setupFee = null;
      let includeProcessingFee = false;
      let roundUpProcessingFee = true;
      let zeroFeeForACH = false;
      let customSystemFeeEnabled = false;
      let customSystemFeeAmount = null;
      try {
        const setupFeeRequest = pool.request();
        setupFeeRequest.input('productId', sql.UniqueIdentifier, filteredProduct.productId);
        setupFeeRequest.input('tenantId', sql.UniqueIdentifier, enrollmentLink.TenantId);
        console.log(`🔍 DEBUG: Fetching SetupFee for product ${filteredProduct.productId} (${filteredProduct.productName || 'unknown'}) with TenantId ${enrollmentLink.TenantId}`);
        const setupFeeResult = await setupFeeRequest.query(`
          SELECT SetupFee, IncludeProcessingFee, RoundUpProcessingFee, ZeroFeeForACH, CustomSystemFeeEnabled, CustomSystemFeeAmount, SubscriptionStatus, SubscriptionId
          FROM oe.TenantProductSubscriptions
          WHERE ProductId = @productId
            AND TenantId = @tenantId
            AND SubscriptionStatus IN ('Active', 'Approved')
        `);
        console.log(`🔍 DEBUG: SetupFee query returned ${setupFeeResult.recordset.length} record(s) for product ${filteredProduct.productId}`);
        if (setupFeeResult.recordset.length > 0) {
          const record = setupFeeResult.recordset[0];
          console.log(`🔍 DEBUG: SetupFee record details:`, {
            SubscriptionId: record.SubscriptionId,
            SubscriptionStatus: record.SubscriptionStatus,
            SetupFee: record.SetupFee,
            SetupFeeType: typeof record.SetupFee,
            SetupFeeIsNull: record.SetupFee === null,
            SetupFeeIsUndefined: record.SetupFee === undefined
          });
          includeProcessingFee = record.IncludeProcessingFee === true || record.IncludeProcessingFee === 1;
          roundUpProcessingFee = record.RoundUpProcessingFee === null || record.RoundUpProcessingFee === undefined
            ? true
            : (record.RoundUpProcessingFee === true || record.RoundUpProcessingFee === 1);
          zeroFeeForACH = record.ZeroFeeForACH === true || record.ZeroFeeForACH === 1;
          customSystemFeeEnabled = record.CustomSystemFeeEnabled === true || record.CustomSystemFeeEnabled === 1;
          customSystemFeeAmount = record.CustomSystemFeeAmount != null ? Number(record.CustomSystemFeeAmount) : null;
          if (record.SetupFee !== null && record.SetupFee !== undefined) {
            setupFee = parseFloat(record.SetupFee) || null;
            console.log(`💰 Setup Fee found for product ${filteredProduct.productId} (${filteredProduct.productName || 'unknown'}): $${setupFee} (raw value: ${record.SetupFee}, parsed: ${setupFee})`);
          } else {
            console.log(`ℹ️ SetupFee is NULL or undefined for product ${filteredProduct.productId} (${filteredProduct.productName || 'unknown'})`);
          }
        } else {
          console.log(`ℹ️ No SetupFee record found for product ${filteredProduct.productId} (${filteredProduct.productName || 'unknown'}) with TenantId ${enrollmentLink.TenantId} and status Active/Approved`);
          // Debug: Check if subscription exists with different status
          const debugRequest = pool.request();
          debugRequest.input('productId', sql.UniqueIdentifier, filteredProduct.productId);
          debugRequest.input('tenantId', sql.UniqueIdentifier, enrollmentLink.TenantId);
          const debugResult = await debugRequest.query(`
            SELECT SetupFee, SubscriptionStatus, SubscriptionId
            FROM oe.TenantProductSubscriptions
            WHERE ProductId = @productId
              AND TenantId = @tenantId
          `);
          if (debugResult.recordset.length > 0) {
            console.log(`⚠️ DEBUG: Found subscription with different status:`, debugResult.recordset.map(r => ({
              SubscriptionId: r.SubscriptionId,
              SubscriptionStatus: r.SubscriptionStatus,
              SetupFee: r.SetupFee
            })));
          } else {
            console.log(`⚠️ DEBUG: No subscription found at all for product ${filteredProduct.productId} and tenant ${enrollmentLink.TenantId}`);
          }
        }
      } catch (error) {
        console.warn('⚠️ Could not fetch SetupFee for product:', filteredProduct.productId, error.message);
        console.error('⚠️ SetupFee fetch error details:', error);
      }
      
      // Get contribution rules for this product from the map (includes ALL rules, not just applied ones)
      // This ensures frontend has all rules for calculations even if backend didn't apply them
      const productRulesFromMap = productSpecificRulesMap.get(String(filteredProduct.productId).toLowerCase().trim()) || [];
      
      // Also check appliedRules as a fallback (though map should have everything)
      const productRulesFromApplied = pricingResult.contributions?.appliedRules?.filter(rule => 
        rule.ProductId === filteredProduct.productId
      ) || [];
      
      // Combine and deduplicate by ContributionId
      const allProductRules = [...productRulesFromMap];
      productRulesFromApplied.forEach(appliedRule => {
        const exists = allProductRules.some(rule => rule.ContributionId === appliedRule.ContributionId);
        if (!exists) {
          allProductRules.push(appliedRule);
        }
      });
      
      console.log(`🔍 DEBUG: Product ${filteredProduct.productId} (${filteredProduct.productName || 'unknown'}) contribution rules:`, {
        fromMap: productRulesFromMap.length,
        fromApplied: productRulesFromApplied.length,
        total: allProductRules.length,
        ruleNames: allProductRules.map(r => r.Name || r.ContributionType)
      });
      
      // Create contribution rule objects for frontend
      const contributionRules = allProductRules.map(rule => {
        // Parse JSON fields if they're strings
        let tierContributions = null;
        let ageRules = null;
        let jobPositions = null;
        let tenureRules = null;
        let roleContributions = null;
        
        if (rule.TierContributions) {
          try {
            tierContributions = typeof rule.TierContributions === 'string' 
              ? JSON.parse(rule.TierContributions) 
              : rule.TierContributions;
          } catch (error) {
            console.warn(`Error parsing TierContributions for rule ${rule.Name}:`, error);
          }
        }
        
        if (rule.AgeRules) {
          try {
            ageRules = typeof rule.AgeRules === 'string' 
              ? JSON.parse(rule.AgeRules) 
              : rule.AgeRules;
          } catch (error) {
            console.warn(`Error parsing AgeRules for rule ${rule.Name}:`, error);
          }
        }
        
        if (rule.JobPositions) {
          try {
            jobPositions = typeof rule.JobPositions === 'string' 
              ? JSON.parse(rule.JobPositions) 
              : rule.JobPositions;
          } catch (error) {
            console.warn(`Error parsing JobPositions for rule ${rule.Name}:`, error);
          }
        }
        
        if (rule.TenureRules) {
          try {
            tenureRules = typeof rule.TenureRules === 'string' 
              ? JSON.parse(rule.TenureRules) 
              : rule.TenureRules;
          } catch (error) {
            console.warn(`Error parsing TenureRules for rule ${rule.Name}:`, error);
          }
        }
        
        if (rule.RoleContributions) {
          try {
            roleContributions = typeof rule.RoleContributions === 'string' 
              ? JSON.parse(rule.RoleContributions) 
              : rule.RoleContributions;
          } catch (error) {
            console.warn(`Error parsing RoleContributions for rule ${rule.Name}:`, error);
          }
        }
        
        return {
          type: rule.ContributionType,
          amount: rule.FlatRateAmount || rule.PercentageAmount || 0,
          description: rule.Name || `${rule.ContributionType} contribution rule`,
          appliesTo: 'product',
          contributionDirection: rule.ContributionDirection || 'Employer',
          equivalentTier: rule.EquivalentTier || null,
          // Include all rule details for frontend
          tierContributions: tierContributions || undefined,
          ageRules: ageRules || undefined,
          jobPositions: jobPositions || undefined,
          tenureRules: tenureRules || undefined,
          roleContributions: roleContributions || undefined,
          priority: rule.Priority || 0,
          stacking: rule.Stacking !== undefined ? rule.Stacking : true,
          appliesToRestrictions: rule.AppliesTo ? (typeof rule.AppliesTo === 'string' ? JSON.parse(rule.AppliesTo) : rule.AppliesTo) : undefined
        };
      });
      
      // Remove calculated contributions from pricing variations - let frontend calculate them
      // Use filtered pricing variations from filteredProduct
      // For bundles, pricingVariations come from BundleProcessor and need to be properly formatted
      let pricingVariations = [];
      
      if (filteredProduct.pricingVariations && Array.isArray(filteredProduct.pricingVariations) && filteredProduct.pricingVariations.length > 0) {
        pricingVariations = filteredProduct.pricingVariations.map(variation => ({
          configValue: variation.configValue,
          monthlyPremium: variation.monthlyPremium || variation.monthlyPremium,
          // Remove employerContribution and employeeContribution - frontend will calculate
          netRate: variation.netRate || 0,
          overrideRate: variation.overrideRate || 0,
          msrpRate: variation.msrpRate || 0,
          tierType: variation.tierType || filteredProduct.tierType,
          tobaccoStatus: variation.tobaccoStatus || filteredProduct.tobaccoStatus
        }));
      } else if (filteredProduct.isBundle) {
        // For bundles without pricingVariations, check if we need to generate them
        console.log(`⚠️ DEBUG: Bundle ${filteredProduct.productId} (${filteredProduct.productName}) has no pricingVariations in response`);
        console.log(`🔍 DEBUG: Bundle details:`, {
          hasConfigurationFields: filteredProduct.hasConfigurationFields,
          availableConfigs: filteredProduct.availableConfigs,
          hasIncludedProducts: !!filteredProduct.includedProducts,
          includedProductsCount: filteredProduct.includedProducts?.length || 0
        });
      }
      
      console.log(`🔍 DEBUG: Product ${filteredProduct.productId} (${filteredProduct.productName || 'unknown'}) pricingVariations:`, {
        isBundle: filteredProduct.isBundle,
        hasPricingVariations: pricingVariations.length > 0,
        pricingVariationsCount: pricingVariations.length,
        configValues: pricingVariations.map(v => v.configValue)
      });
      
      // For bundles, fetch and add included products with their pricing
      let includedProductsWithPricing = [];
      let bundleIncludedProcessingFeeTotal = 0;
      let bundleNonIncludedPremiumSubtotal = 0;
      if (product.isBundle) {
        const bundleProductsQuery = `
          SELECT 
            pb.IncludedProductId,
            pb.SortOrder,
            pb.HidePricing,
            pb.LinkedToProductId,
            pb.AllowedConfigOptions,
            p.Name AS ProductName,
            p.ProductType
          FROM oe.ProductBundles pb
          INNER JOIN oe.Products p ON pb.IncludedProductId = p.ProductId
          WHERE pb.BundleProductId = @bundleProductId
            AND p.Status = 'Active'
          ORDER BY pb.SortOrder
        `;
        
        const bundleRequest = pool.request();
        bundleRequest.input('bundleProductId', sql.UniqueIdentifier, filteredProduct.productId);
        const bundleResult = await bundleRequest.query(bundleProductsQuery);
        
        // Fetch tenant payment processor settings once for included-product processing fee calculation
        let bundlePaymentProcessorSettings = null;
        if (enrollmentLink.TenantId) {
          try {
            const tenantSettingsRequest = pool.request();
            tenantSettingsRequest.input('tenantId', sql.UniqueIdentifier, enrollmentLink.TenantId);
            const tenantSettingsResult = await tenantSettingsRequest.query(`
              SELECT PaymentProcessorSettings FROM oe.Tenants WHERE TenantId = @tenantId
            `);
            if (tenantSettingsResult.recordset.length > 0 && tenantSettingsResult.recordset[0].PaymentProcessorSettings) {
              bundlePaymentProcessorSettings = JSON.parse(tenantSettingsResult.recordset[0].PaymentProcessorSettings);
            }
          } catch (e) {
            console.warn('⚠️ Failed to fetch PaymentProcessorSettings for bundle included-product fees:', e);
          }
        }
        
        // Get pricing for each included product
        console.log(`🔍 DEBUG: Bundle ${filteredProduct.productId} - Mapping included products`);
        console.log(`🔍 DEBUG: filteredProduct.includedProducts from PricingEngine:`, filteredProduct.includedProducts?.map(ip => ({
          id: ip.productId,
          name: ip.productName,
          premium: ip.monthlyPremium
        })));
        console.log(`🔍 DEBUG: bundleResult.recordset from DB:`, bundleResult.recordset.map(included => ({
          id: included.IncludedProductId,
          name: included.ProductName
        })));
        
        includedProductsWithPricing = await Promise.all(bundleResult.recordset.map(async (included) => {
          // Find this included product's pricing in the PricingEngine result
          // The BundleProcessor returns includedProducts array with pricing
          const includedPricing = filteredProduct.includedProducts?.find(
            ip => ip.productId === included.IncludedProductId
          );
          
          console.log(`🔍 DEBUG: Mapping ${included.ProductName} - Found pricing:`, includedPricing ? {
            id: includedPricing.productId,
            premium: includedPricing.monthlyPremium,
            hasPricingVariations: !!includedPricing.pricingVariations,
            hasRequiredDataFields: !!includedPricing.requiredDataFields
          } : 'NOT FOUND');
          
          // Build effective customSettings: group CustomSettings (if any) + bundle AllowedConfigOptions
          // Bundle AllowedConfigOptions limits which config values are offered in this bundle; intersect with group allowed.
          // If AllowedConfigOptions is null/empty, all config options are included by default.
          let bundleAllowedOptions = null;
          if (included.AllowedConfigOptions) {
            try {
              bundleAllowedOptions = typeof included.AllowedConfigOptions === 'string'
                ? JSON.parse(included.AllowedConfigOptions)
                : included.AllowedConfigOptions;
            } catch (e) {
              console.warn(`⚠️ Failed to parse AllowedConfigOptions for bundle included product ${included.IncludedProductId}:`, e);
            }
          }
          // Group config for a bundle is stored under the bundle's ProductId; per-included-product options use allowedDeductibleOptionsByProduct[includedProductId]
          const bundleGroupSettings = groupProductSettingsMap.get(filteredProduct.productId.toString());
          const byProduct = bundleGroupSettings?.allowedDeductibleOptionsByProduct || {};
          const includedIdStr = included.IncludedProductId.toString();
          const matchedKey = Object.keys(byProduct).find(k => k.toLowerCase() === includedIdStr.toLowerCase());
          const groupAllowedForIncluded = matchedKey ? byProduct[matchedKey] : bundleGroupSettings?.allowedDeductibleOptions;
          const effectiveCustomSettings = { ...(bundleGroupSettings || {}) };
          const groupAllowed = groupAllowedForIncluded || {};
          if (bundleAllowedOptions && typeof bundleAllowedOptions === 'object' && Object.keys(bundleAllowedOptions).length > 0) {
            const mergedAllowed = {};
            for (const [fieldName, bundleOpts] of Object.entries(bundleAllowedOptions)) {
              if (!Array.isArray(bundleOpts)) continue;
              const groupOpts = groupAllowed[fieldName];
              if (Array.isArray(groupOpts) && groupOpts.length > 0) {
                mergedAllowed[fieldName] = groupOpts.filter(opt => bundleOpts.includes(opt));
              } else {
                mergedAllowed[fieldName] = [...bundleOpts];
              }
            }
            effectiveCustomSettings.allowedDeductibleOptions = mergedAllowed;
          } else if (groupAllowed && typeof groupAllowed === 'object' && Object.keys(groupAllowed).length > 0) {
            // No bundle-level AllowedConfigOptions: apply group filter only so group's allowedDeductibleOptionsByProduct is still respected
            effectiveCustomSettings.allowedDeductibleOptions = groupAllowed;
          }
          const hasEffectiveFilter = effectiveCustomSettings.allowedDeductibleOptions && Object.keys(effectiveCustomSettings.allowedDeductibleOptions).length > 0;
          let filteredIncludedPricing = includedPricing;
          if (hasEffectiveFilter && includedPricing) {
            filteredIncludedPricing = filterConfigOptions(includedPricing, effectiveCustomSettings);
            console.log(`🔍 DEBUG: Filtered configuration options for bundle subproduct ${included.ProductName}`);
          }
          
          let basePremium = filteredIncludedPricing?.monthlyPremium || includedPricing?.monthlyPremium || 0;
          let includeProcessingFeeIncluded = false;
          let roundUpProcessingFeeIncluded = true;
          let zeroFeeForACHIncluded = false;
          let customSystemFeeEnabledIncluded = false;
          let customSystemFeeAmountIncluded = null;
          let displayPremium = basePremium;
          let pricingVariationsOut = filteredIncludedPricing?.pricingVariations || includedPricing?.pricingVariations || [];

          // Fetch subscription for included product (processing fee + custom system fee for frontend "skip system fee" check)
          if (enrollmentLink.TenantId) {
            try {
              const subRequest = pool.request();
              subRequest.input('productId', sql.UniqueIdentifier, included.IncludedProductId);
              subRequest.input('tenantId', sql.UniqueIdentifier, enrollmentLink.TenantId);
              const subResult = await subRequest.query(`
                SELECT IncludeProcessingFee, RoundUpProcessingFee, ZeroFeeForACH, CustomSystemFeeEnabled, CustomSystemFeeAmount
                FROM oe.TenantProductSubscriptions
                WHERE ProductId = @productId AND TenantId = @tenantId
                  AND SubscriptionStatus IN ('Active', 'Approved')
              `);
              if (subResult.recordset.length > 0) {
                const r = subResult.recordset[0];
                includeProcessingFeeIncluded = r.IncludeProcessingFee === true || r.IncludeProcessingFee === 1;
                roundUpProcessingFeeIncluded = r.RoundUpProcessingFee === null || r.RoundUpProcessingFee === undefined
                  ? true
                  : (r.RoundUpProcessingFee === true || r.RoundUpProcessingFee === 1);
                zeroFeeForACHIncluded = r.ZeroFeeForACH === true || r.ZeroFeeForACH === 1;
                customSystemFeeEnabledIncluded = r.CustomSystemFeeEnabled === true || r.CustomSystemFeeEnabled === 1;
                customSystemFeeAmountIncluded = r.CustomSystemFeeAmount != null ? Number(r.CustomSystemFeeAmount) : null;
              }
            } catch (e) {
              console.warn(`⚠️ Failed to fetch subscription for bundle included product ${included.IncludedProductId}:`, e.message);
            }
          }
          // If this included product has IncludeProcessingFee, add fee to displayed price and to each variation.
          // Included fees use 'Highest' so the baked-in price safely covers either ACH or Card at charge time.
          // ZeroFeeForACH is still honored so products flagged for zero-ACH don't get a CC-rate bake-in.
          if (bundlePaymentProcessorSettings?.chargeFeeToMember && includeProcessingFeeIncluded) {
            try {
              const roundTotal = (amount) => roundUpProcessingFeeIncluded
                ? (Math.ceil(amount) * 1)
                : (Math.round(amount * 100) / 100);
              if (basePremium > 0) {
                const fee = Number(includedProcessingFeeUtil.calculateIncludedProcessingFeeForDisplay(
                  Number(basePremium),
                  bundlePaymentProcessorSettings,
                  roundUpProcessingFeeIncluded,
                  { paymentMethod: 'Highest', zeroFeeForACH: zeroFeeForACHIncluded }
                ) || 0);
                displayPremium = roundTotal(basePremium + fee);
              }
              if (Array.isArray(pricingVariationsOut) && pricingVariationsOut.length > 0) {
                pricingVariationsOut = pricingVariationsOut.map((v) => {
                  const varPremium = Number(v.monthlyPremium || 0);
                  // pricingAuthority.computeDisplayPremiums() re-applies include-fee math; it must receive
                  // THIS variation's pristine base, not (baked - flat-line fee): flat-line processingFeeIncludedInPrice
                  // ignores per-config fee deltas and double-bakes Highest fees on UA rows (inflate bundle cards).
                  if (varPremium <= 0) {
                    return { ...v, _pricingAuthorityBaselineVariationPremium: varPremium };
                  }
                  const feeVar = Number(includedProcessingFeeUtil.calculateIncludedProcessingFeeForDisplay(
                    varPremium,
                    bundlePaymentProcessorSettings,
                    roundUpProcessingFeeIncluded,
                    { paymentMethod: 'Highest', zeroFeeForACH: zeroFeeForACHIncluded }
                  ) || 0);
                  return {
                    ...v,
                    monthlyPremium: roundTotal(varPremium + feeVar),
                    _pricingAuthorityBaselineVariationPremium: varPremium
                  };
                });
              }
            } catch (e) {
              console.warn(`⚠️ Failed to fetch subscription for bundle included product ${included.IncludedProductId}:`, e.message);
            }
          }
          
          const processingFeeIncludedInPrice = includeProcessingFeeIncluded && displayPremium > basePremium
            ? Math.round((displayPremium - basePremium) * 100) / 100
            : 0;
          
          return {
            productId: included.IncludedProductId,
            productName: included.ProductName,
            productType: included.ProductType,
            monthlyPremium: displayPremium,
            // Stripped client-side response after computeDisplayPremiums (see loop below).
            _pricingAuthorityBaselineMonthlyPremium: Number(basePremium) || 0,
            // When group has percentage + EquivalentTier rules, PricingEngine can provide equivalentPremiums for EE/ES/EC/EF.
            // This enables the frontend EnrollmentWizard to correctly compute EE-equivalent percentage rules.
            equivalentPremiums: filteredIncludedPricing?.equivalentPremiums || includedPricing?.equivalentPremiums || undefined,
            hidePricing: included.HidePricing || false,
            linkedToProductId: included.LinkedToProductId || null,
            pricingVariations: pricingVariationsOut,
            availableConfigs: filteredIncludedPricing?.availableConfigs || includedPricing?.availableConfigs || [],
            hasConfigurationFields: filteredIncludedPricing?.hasConfigurationFields || includedPricing?.hasConfigurationFields || false,
            requiredDataFields: filteredIncludedPricing?.requiredDataFields || includedPricing?.requiredDataFields || [],
            includeProcessingFee: includeProcessingFeeIncluded,
            roundUpProcessingFee: roundUpProcessingFeeIncluded,
            zeroFeeForACH: zeroFeeForACHIncluded,
            processingFeeIncludedInPrice,
            customSystemFeeEnabled: customSystemFeeEnabledIncluded,
            customSystemFeeAmount: customSystemFeeAmountIncluded
          };
        }));
        
        // For bundles: totals so the confirmation "Fees" line only shows system fees + fee on non-included portion (not the included fee again)
        if (includedProductsWithPricing.length > 0) {
          bundleIncludedProcessingFeeTotal = includedProductsWithPricing.reduce((sum, ip) => sum + (Number(ip.processingFeeIncludedInPrice) || 0), 0);
          bundleNonIncludedPremiumSubtotal = includedProductsWithPricing.reduce((sum, ip) => {
            if (ip.includeProcessingFee) return sum;
            return sum + (Number(ip.monthlyPremium) || 0);
          }, 0);
        }
      }
      
      // For bundles: enrollment wizard uses the bundle's top-level availableConfigs. Override them
      // from the first configurable included product's filtered list (bundle AllowedConfigOptions + group).
      let finalAvailableConfigs = filteredProduct.availableConfigs;
      let finalPricingVariations = pricingVariations;
      let finalDefaultConfig = filteredProduct.defaultConfig;
      let finalRequiredDataFields = filteredProduct.requiredDataFields;
      if (filteredProduct.isBundle && includedProductsWithPricing.length > 0) {
        const firstConfigurable = includedProductsWithPricing.find(
          ip => ip.hasConfigurationFields && ip.availableConfigs && ip.availableConfigs.length > 0
        );
        if (firstConfigurable) {
          finalAvailableConfigs = firstConfigurable.availableConfigs;
          const allowedSet = new Set((firstConfigurable.availableConfigs || []).map(c => String(c)));
          finalPricingVariations = (pricingVariations || []).filter(v => allowedSet.has(String(v.configValue || '')));
          finalDefaultConfig = (finalDefaultConfig && allowedSet.has(String(finalDefaultConfig)))
            ? finalDefaultConfig
            : (finalAvailableConfigs && finalAvailableConfigs[0]) || null;
          finalRequiredDataFields = firstConfigurable.requiredDataFields || filteredProduct.requiredDataFields;
          console.log(`🔍 DEBUG: Bundle ${filteredProduct.productId} top-level config restricted to first configurable:`, {
            availableConfigs: finalAvailableConfigs,
            pricingVariationsCount: finalPricingVariations.length
          });
        }
      }
      
      // Log the final setupFee value being returned
      console.log(`📤 FINAL: Returning setupFee for product ${filteredProduct.productId} (${filteredProduct.productName || 'unknown'}):`, {
        setupFee,
        setupFeeType: typeof setupFee,
        setupFeeIsNull: setupFee === null,
        setupFeeIsUndefined: setupFee === undefined,
        willBeIncluded: setupFee !== null && setupFee !== undefined
      });
      
      return {
        productId: filteredProduct.productId,
        productName: filteredProduct.productName,
        description: filteredProduct.description,
        productType: filteredProduct.productType,
        isBundle: filteredProduct.isBundle,
        monthlyPremium: filteredProduct.monthlyPremium,
        // When group has percentage + EquivalentTier rules, PricingEngine can provide equivalentPremiums for EE/ES/EC/EF.
        // This enables the frontend EnrollmentWizard to correctly compute EE-equivalent percentage rules.
        equivalentPremiums: filteredProduct.equivalentPremiums || undefined,
        employerContribution: filteredProduct.employerContribution,
        employeeContribution: filteredProduct.employeeContribution,
        setupFee: setupFee, // Add SetupFee to product response
        includeProcessingFee,
        roundUpProcessingFee,
        zeroFeeForACH,
        customSystemFeeEnabled,
        customSystemFeeAmount,
        contributionRules,
        pricingVariations: finalPricingVariations,
        // Include configuration fields for frontend (use filtered values; for bundles, from first configurable)
        hasConfigurationFields: filteredProduct.hasConfigurationFields,
        availableConfigs: finalAvailableConfigs,
        defaultConfig: finalDefaultConfig,
        requiredDataFields: finalRequiredDataFields,
        // For bundles, include which subproducts are configurable
        configurableSubproducts: filteredProduct.configurableSubproducts,
        // For bundles, include included products with their pricing
        includedProducts: includedProductsWithPricing,
        // For bundles: fee breakdown so confirmation "Fees" line does not double-count included fee
        ...(filteredProduct.isBundle && includedProductsWithPricing.length > 0 ? {
          bundleIncludedProcessingFeeTotal,
          bundleNonIncludedPremiumSubtotal
        } : {})
      };
    }));
    
    // Log all setup fees in the final response
    console.log('📦 FINAL RESPONSE: All products with setup fees:', transformedProducts.map(p => ({
      productId: p.productId,
      productName: p.productName,
      setupFee: p.setupFee,
      setupFeeType: typeof p.setupFee
    })));
    
    console.log(`✅ DEBUG: Returning ${allProductsRules.length} all-products contribution rules to frontend`);

    // Annotate each product with authority-computed `displayPremium` (base + Highest-policy
    // included fee) so the wizard renders product cards directly from backend numbers and never
    // runs client-side fee math. Covers top-level monthlyPremium, each pricingVariation, and each
    // bundle-included product + its pricingVariations.
    if (enrollmentLink.TenantId) {
      try {
        // BundleProcessor uses oe.ProductPricing.MSRPRate as monthlyPremium — that value is already
        // member retail (components + IncludedProcessingFee). Tag rows with catalogRetailMsrp so
        // pricingAuthority does not dynamically re-bake Highest fees on top (Concierge EE $360→$371 drift).
        const retailMsrpPricingDetails = (amount) => {
          const retail = Math.round(Number(amount || 0) * 100) / 100;
          return retail > 0 ? { catalogRetailMsrp: retail } : undefined;
        };

        const productsForDisplay = transformedProducts.map((p) => ({
          productId: p.productId,
          monthlyPremium: Number(p.monthlyPremium || 0),
          isBundle: p.isBundle === true,
          pricingDetails: retailMsrpPricingDetails(p.monthlyPremium),
          pricingVariations: Array.isArray(p.pricingVariations)
            ? p.pricingVariations.map((v) => ({
                configValue: v.configValue,
                monthlyPremium: Number(v.monthlyPremium || 0),
                pricingDetails: retailMsrpPricingDetails(v.monthlyPremium)
              }))
            : [],
          // For bundles, bundle.includedProducts[*].monthlyPremium is ALREADY the per-child
          // displayPremium (base + included fee, baked above). pricingAuthority recomputes
          // display from pristine bases via _pricingAuthorityBaseline* keys; subtracting flat
          // processingFeeIncludedInPrice from each variation wrong when Fees differ per UA row.
          includedProducts: p.isBundle === true && Array.isArray(p.includedProducts)
            ? p.includedProducts.map((ip) => {
                const ipBaseline =
                  ip._pricingAuthorityBaselineMonthlyPremium != null &&
                  ip._pricingAuthorityBaselineMonthlyPremium !== undefined
                    ? Number(ip._pricingAuthorityBaselineMonthlyPremium)
                    : Math.round((Number(ip.monthlyPremium || 0) - Number(ip.processingFeeIncludedInPrice || 0)) * 100) /
                      100;
                return {
                  productId: ip.productId,
                  monthlyPremium: ipBaseline,
                  pricingDetails: retailMsrpPricingDetails(ipBaseline),
                  pricingVariations: Array.isArray(ip.pricingVariations)
                    ? ip.pricingVariations.map((v) => {
                        const vBaseline =
                          v._pricingAuthorityBaselineVariationPremium != null &&
                          v._pricingAuthorityBaselineVariationPremium !== undefined
                            ? Number(v._pricingAuthorityBaselineVariationPremium)
                            : Math.round((Number(v.monthlyPremium || 0) - Number(ip.processingFeeIncludedInPrice || 0)) * 100) /
                              100;
                        return {
                          configValue: v.configValue,
                          monthlyPremium: vBaseline,
                          pricingDetails: retailMsrpPricingDetails(vBaseline)
                        };
                      })
                    : []
                };
              })
            : []
        }));
        const { byProductId } = await pricingAuthority.computeDisplayPremiums({
          poolOrTransaction: pool,
          tenantId: enrollmentLink.TenantId,
          productsForDisplay
        });
        for (const tp of transformedProducts) {
          const entry = byProductId.get(String(tp.productId));
          if (!entry) continue;
          tp.displayPremium = entry.displayPremium;
          if (Array.isArray(tp.pricingVariations)) {
            for (const v of tp.pricingVariations) {
              const cfg = String(v.configValue || '');
              if (entry.variationDisplayPremiumByConfig.has(cfg)) {
                v.displayPremium = entry.variationDisplayPremiumByConfig.get(cfg);
              }
            }
          }
          if (tp.isBundle && Array.isArray(tp.includedProducts) && entry.includedProductsDisplayByProductId.size > 0) {
            for (const ip of tp.includedProducts) {
              const ipEntry = entry.includedProductsDisplayByProductId.get(String(ip.productId));
              if (!ipEntry) continue;
              ip.displayPremium = ipEntry.displayPremium;
              if (Array.isArray(ip.pricingVariations)) {
                for (const v of ip.pricingVariations) {
                  const cfg = String(v.configValue || '');
                  if (ipEntry.variationDisplayPremiumByConfig.has(cfg)) {
                    v.displayPremium = ipEntry.variationDisplayPremiumByConfig.get(cfg);
                  }
                }
              }
            }
          }
        }

        // Bundle IA row: premiums were fully baked onto each included line + variation BEFORE
        // computeDisplayPremiums ran. Variation baselines are correct now, but applyIncludedFee
        // recomputation can still drift by dollars vs `roundTotal(monthlyPremium+fee)` (501↔531↔532 churn).
        // Published contract: WHAT YOU SEE ON THE ROW is the baked premium already on `monthlyPremium`.
        const roundDisplay2 = (n) => Math.round(Number(n || 0) * 100) / 100;
        const bundleSumForConfig = (bundleTp, cfgVal) => {
          let sum = 0;
          for (const ip of bundleTp.includedProducts || []) {
            const variations = ip.pricingVariations || [];
            const match =
              variations.length > 0
                ? variations.find((xv) => String(xv?.configValue ?? '') === String(cfgVal))
                : null;
            if (match) {
              const line = Number(match.displayPremium ?? match.monthlyPremium ?? 0);
              sum += line;
            } else {
              const line = Number(ip.displayPremium ?? ip.monthlyPremium ?? 0);
              sum += line;
            }
          }
          return roundDisplay2(sum);
        };
        for (const tp of transformedProducts) {
          if (!tp?.isBundle || !Array.isArray(tp.includedProducts) || tp.includedProducts.length === 0) {
            continue;
          }
          for (const ip of tp.includedProducts) {
            if (!ip.includeProcessingFee) continue;
            const bakedFlat = Number(ip.monthlyPremium);
            if (Number.isFinite(bakedFlat)) {
              ip.displayPremium = roundDisplay2(bakedFlat);
            }
            if (!Array.isArray(ip.pricingVariations)) continue;
            for (const v of ip.pricingVariations) {
              const baked = Number(v.monthlyPremium);
              if (!Number.isFinite(baked)) continue;
              const prior = Number(v.displayPremium);
              if (Number.isFinite(prior) && Math.abs(prior - baked) > 0.005) {
                console.warn('[product-pricing] bundle IA displayPremium aligned to baked monthlyPremium', {
                  bundleProductId: tp.productId,
                  includedProductId: ip.productId,
                  configValue: v.configValue,
                  pricingAuthorityDisplay: prior,
                  bakedMonthlyPremium: baked
                });
              }
              v.displayPremium = roundDisplay2(baked);
            }
          }
          const configKeys = new Set();
          for (const ip of tp.includedProducts) {
            if (!Array.isArray(ip.pricingVariations)) continue;
            for (const v of ip.pricingVariations) {
              if (v?.configValue != null) configKeys.add(String(v.configValue));
            }
          }
          if (Array.isArray(tp.pricingVariations)) {
            for (const bv of tp.pricingVariations) {
              const c = String(bv?.configValue ?? '');
              if (c) {
                bv.displayPremium = bundleSumForConfig(tp, c);
              }
            }
          }
          const defaultCfg =
            tp.defaultConfig != null && String(tp.defaultConfig).trim() !== ''
              ? String(tp.defaultConfig)
              : configKeys.size > 0
                ? [...configKeys][0]
                : '';
          if (defaultCfg !== '') {
            tp.displayPremium = bundleSumForConfig(tp, defaultCfg);
          }
        }
      } catch (e) {
        console.warn('⚠️ Failed to compute authority displayPremiums for product-pricing:', e && e.message);
      } finally {
        for (const tp of transformedProducts) {
          if (!tp?.isBundle || !Array.isArray(tp.includedProducts)) continue;
          for (const ip of tp.includedProducts) {
            delete ip._pricingAuthorityBaselineMonthlyPremium;
            if (Array.isArray(ip.pricingVariations)) {
              for (const v of ip.pricingVariations) {
                delete v._pricingAuthorityBaselineVariationPremium;
              }
            }
          }
        }
      }
    }

    // For individual (no group) or when we have selected products: compute fee on backend from config-aware totalPremium so frontend displays correct fee (e.g. 6000 not 1500)
    let feesFromBackend = null;
    const totalPremium = pricingResult.totals && Number(pricingResult.totals.totalPremium) > 0 ? Number(pricingResult.totals.totalPremium) : 0;
    const hasSelectedProducts = selectedProductsForContributions && selectedProductsForContributions.length > 0;
    if (totalPremium > 0 && hasSelectedProducts && enrollmentLink.TenantId) {
      try {
        const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;

        // Build basePremiumByProductId for the selected products (decompose bundles into children so per-product
        // fee flags like ZeroFeeForACH apply correctly).
        const basePremiumByProductId = new Map();
        const selectedSet = new Set(selectedProductsForContributions.map(String));
        for (const p of (pricingResult.products || [])) {
          if (!p?.productId || !selectedSet.has(String(p.productId))) continue;
          if (p.isBundle === true && Array.isArray(p.includedProducts) && p.includedProducts.length > 0) {
            for (const ip of p.includedProducts) {
              if (!ip?.productId) continue;
              const amt = Number(ip.monthlyPremium || 0);
              if (amt > 0) {
                basePremiumByProductId.set(String(ip.productId), round2(Number(basePremiumByProductId.get(String(ip.productId)) || 0) + amt));
              }
            }
          } else {
            const amt = Number(p.monthlyPremium || 0);
            if (amt > 0) {
              basePremiumByProductId.set(String(p.productId), round2(Number(basePremiumByProductId.get(String(p.productId)) || 0) + amt));
            }
          }
        }

        // Route all fee/system-fee composition through pricingAuthority (single source of truth).
        // Authority loads tenant PaymentProcessorSettings + SystemFees, resolves per-product
        // subscription flags (IncludeProcessingFee / RoundUp / ZeroFeeForACH / CustomSystemFee),
        // and returns `totals.{systemFees, includedFeeTotal, nonIncludedFeeTotal}`.
        //
        // Pre-migration this block called calculateProcessingFeeBreakdownByProduct +
        // calculateSystemFeeAmount directly. The legacy `paymentProcessingFeeAmount` equals
        // authority's `includedFeeTotal + nonIncludedFeeTotal`, so the feesFromBackend shape
        // is reproduced byte-for-byte (see routes/__tests__/enrollment-links.authority.test.js).
        const selectedEngineProducts = (pricingResult.products || []).filter(
          (p) => p?.productId && selectedSet.has(String(p.productId))
        );
        let pricingProducts = pricingAuthority.buildPricingProductsFromEngineResults(selectedEngineProducts);
        if (!pricingProducts.length && basePremiumByProductId.size > 0) {
          pricingProducts = Array.from(basePremiumByProductId.entries()).map(([productId, monthlyPremium]) => ({
            productId,
            monthlyPremium: Number(monthlyPremium || 0)
          }));
        }
        const authorityOutput = await pricingAuthority.computePricing({
          poolOrTransaction: pool,
          tenantId: enrollmentLink.TenantId,
          pricingProducts,
          paymentMethodType: paymentMethodForFees
        });
        const systemFeesAmount = round2(authorityOutput.totals.systemFees);
        // processingFee here is the fee BEYOND the displayed product premiums (matching the
        // semantic /contribution-preview already uses for `processingFeeTotal`). Authority's
        // `includedFeeTotal` is already folded into each product's `displayPremium` (and into
        // `totals.totalPremium` consumed by the wizard's cart), so adding it here would cause
        // the cart's running-total widget to double-count the included fee — exactly the
        // ~$24 phantom Fees line on bundles whose components carry IncludeProcessingFee=true
        // (e.g. MightyWELL Concierge bundle).
        const processingFee = round2(authorityOutput.totals.nonIncludedFeeTotal);

        feesFromBackend = {
          systemFeesAmount,
          processingFee,
          totalFees: round2(systemFeesAmount + processingFee)
        };
        console.log('💰 DEBUG: Backend fee (authority):', { totalPremium, paymentMethodForFees, ...feesFromBackend });
      } catch (e) {
        console.warn('⚠️ Failed to compute backend fees for product-pricing:', e && e.message);
      }
    }
    
    res.json({
      success: true,
      data: {
        products: transformedProducts,
        allProductsRules,
        contributions: pricingResult.contributions, // Include contributions object for frontend
        totals: pricingResult.totals,
        ...(feesFromBackend ? { fees: feesFromBackend } : {}),
        enrollmentInfo: {
          linkId: enrollmentLink.LinkId,
          groupId: enrollmentLink.GroupId,
          groupName: enrollmentLink.GroupName,
          tenantId: enrollmentLink.TenantId
        }
      },
      message: 'Product pricing calculated successfully with contribution rules'
    });
    
  } catch (error) {
    console.error('❌ ERROR: Failed to get product pricing (v2):', error);
    console.error('❌ ERROR Stack:', error.stack);
    res.status(500).json({
      success: false,
      message: 'Server error while calculating product pricing',
      error: {
        message: error.message,
        code: error.code || 'UNKNOWN_ERROR',
        stack: error.stack
      }
    });
  }
});

// POST /api/enrollment-links/:linkToken/contribution-preview - Compute contributions (backend source of truth)
// Used by EnrollmentWizard to compute employer/employee totals for hypothetical selections.
router.post('/:linkToken/contribution-preview', async (req, res) => {
  try {
    const { linkToken } = req.params;
    const {
      memberCriteria,
      selectedProducts,
      selectedConfigs,
      effectiveDate,
      paymentMethodType: requestedPaymentMethodType
    } = req.body || {};

    if (!linkToken) {
      return res.status(400).json({ success: false, message: 'Link token is required' });
    }
    if (!memberCriteria || typeof memberCriteria !== 'object') {
      return res.status(400).json({ success: false, message: 'memberCriteria is required' });
    }
    if (!Array.isArray(selectedProducts)) {
      return res.status(400).json({ success: false, message: 'selectedProducts must be an array' });
    }

    // Validate effective date if provided
    if (effectiveDate) {
      const effectiveDateObj = new Date(effectiveDate);
      if (isNaN(effectiveDateObj.getTime())) {
        return res.status(400).json({ success: false, message: 'Invalid effective date format. Expected YYYY-MM-DD' });
      }
    }

    const pool = await getPool();

    // Reuse the same enrollment-link query used by product-pricing endpoint
    const linkQuery = `
      SELECT 
        el.LinkId,
        el.GroupId,
        el.MemberId,
        el.AgentId,
        el.LinkToken,
        el.IsActive,
        el.ExpiresAt,
        g.Name AS GroupName,
        CASE 
          WHEN el.GroupId IS NOT NULL THEN g.TenantId 
          WHEN el.MemberId IS NOT NULL THEN m.TenantId
          WHEN el.AgentId IS NOT NULL THEN a.TenantId
          ELSE NULL
        END AS TenantId
      FROM oe.EnrollmentLinks el
      LEFT JOIN oe.Groups g ON el.GroupId = g.GroupId
      LEFT JOIN oe.Members m ON el.MemberId = m.MemberId
      LEFT JOIN oe.Agents a ON el.AgentId = a.AgentId
      WHERE el.LinkToken = @linkToken
    `;
    const linkRequest = pool.request();
    linkRequest.input('linkToken', sql.NVarChar, linkToken);
    const linkResult = await linkRequest.query(linkQuery);
    if (linkResult.recordset.length === 0) {
      return res.status(404).json({ success: false, message: 'Enrollment link not found' });
    }
    const enrollmentLink = linkResult.recordset[0];
    if (!enrollmentLink.GroupId) {
      return res.status(400).json({ success: false, message: 'Contribution preview requires a group-based enrollment link' });
    }

    // Build productSelections for PricingEngine (fee is calculated from this premium; wrong config => wrong premium => wrong fee)
    const parsedSelectedConfigs = selectedConfigs && typeof selectedConfigs === 'object' ? selectedConfigs : {};
    const productSelections = selectedProducts.map((productId) => {
      const configValue = parsedSelectedConfigs[productId];
      if (configValue === undefined || configValue === null) {
        console.warn(`⚠️ DEBUG: No selectedConfig for product ${productId} in product-pricing request; bundle may use default (e.g. 1500) and fee will be too high if user selected 6000`);
      }
      const configValues = configValue && configValue !== 'Default'
        ? (typeof configValue === 'string' ? { configValue1: configValue } : configValue)
        : {};
      return { productId, configValues };
    });

    const PricingEngine = require('../services/pricing/PricingEngine');
    const pricingParams = {
      calculationType: 'enrollment',
      memberCriteria: {
        age: Number(memberCriteria.age) || 35,
        tobaccoUse: memberCriteria.tobaccoUse || 'No',
        tier: memberCriteria.tier || 'EE',
        householdSize: Number(memberCriteria.householdSize) || 1,
        jobPosition: memberCriteria.jobPosition || undefined
      },
      productSelections,
      groupId: enrollmentLink.GroupId,
      effectiveDate: effectiveDate || null
    };

    const pricingResult = await PricingEngine.calculatePricing(pricingParams);
    // Snapshot before we mutate premiums by folding in included processing fees.
    // Used for system fee calculations which should be based on premium-only totals.
    const productsBeforeIncludedProcessingFee = JSON.parse(JSON.stringify(pricingResult.products || []));

    // Product Selection preview logic:
    // - Show "Processing Fee" per selected product/bundle (when NOT included).
    // - Apply contribution rules against (premium + processing fee) so totals reconcile:
    //     employer + employee === total (premium + processing fee)
    //
    // Included processing fee (IncludeProcessingFee + optional RoundUpProcessingFee) is folded into the premium and not shown as a separate line.
    const effectivePaymentMethodType = (requestedPaymentMethodType === 'ACH' || requestedPaymentMethodType === 'Card')
      ? requestedPaymentMethodType
      : 'ACH';

    // Load tenant PaymentProcessorSettings + SystemFees
    const tenantSettingsReq = pool.request();
    tenantSettingsReq.input('tenantId', sql.UniqueIdentifier, enrollmentLink.TenantId);
    const tenantSettingsRow = await tenantSettingsReq.query(`
      SELECT TOP 1 PaymentProcessorSettings, SystemFees
      FROM oe.Tenants
      WHERE TenantId = @tenantId
    `);
    let paymentProcessorSettings = null;
    let systemFeesSettings = null;
    const rawPps = tenantSettingsRow.recordset?.[0]?.PaymentProcessorSettings;
    if (rawPps) {
      try { paymentProcessorSettings = JSON.parse(rawPps); } catch (_) {}
    }
    const rawSystemFees = tenantSettingsRow.recordset?.[0]?.SystemFees;
    if (rawSystemFees) {
      try { systemFeesSettings = JSON.parse(rawSystemFees); } catch (_) {}
    }
    const chargeFeeToMemberEnabled = paymentProcessorSettings?.chargeFeeToMember === true;

    // Load per-product subscription fee flags (TenantProductSubscriptions)
    const idsForFeeSettings = [];
    const seenFeeIds = new Set();
    for (const p of pricingResult.products || []) {
      const pId = p?.productId || p?.id;
      if (pId && !seenFeeIds.has(String(pId))) {
        seenFeeIds.add(String(pId));
        idsForFeeSettings.push(pId);
      }
      if (p?.isBundle === true && Array.isArray(p.includedProducts)) {
        for (const ip of p.includedProducts) {
          const pid = ip?.productId || ip?.id;
          if (pid && !seenFeeIds.has(String(pid))) {
            seenFeeIds.add(String(pid));
            idsForFeeSettings.push(pid);
          }
        }
      }
    }

    const subscriptionFeeSettingsByProductId = new Map();
    const subscriptionFeeSettingsDebug = {};
    if (idsForFeeSettings.length > 0) {
      const loadedSettings = await productProcessingFeesUtil.loadSubscriptionFeeSettingsByProductId({
        poolOrTransaction: pool,
        tenantId: enrollmentLink.TenantId,
        productIds: idsForFeeSettings
      });
      loadedSettings.forEach((mapped, productId) => {
        subscriptionFeeSettingsByProductId.set(String(productId), mapped);
        subscriptionFeeSettingsDebug[String(productId)] = mapped;
      });
    }

    const processingFeeCalculator = require('../utils/processingFeeCalculator');
    const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;
    const calculateIncludedProcessingFeeForDisplay = includedProcessingFeeUtil.calculateIncludedProcessingFeeForDisplay;
    const cfgFor = (productId) => subscriptionFeeSettingsByProductId.get(String(productId)) || productProcessingFeesUtil.defaultProductFeeSettings();
    const applyIncludedFeeToAmount = (productId, amount) => {
      if (!chargeFeeToMemberEnabled || !paymentProcessorSettings) return Number(amount || 0);
      const cfg = cfgFor(productId);
      if (!cfg?.includeProcessingFee) return Number(amount || 0);
      // Included fees use 'Highest' so the quoted display safely covers either ACH or Card at charge time.
      // ZeroFeeForACH is still honored for products flagged to skip ACH fees.
      const inc = calculateIncludedProcessingFeeForDisplay(
        Number(amount || 0),
        paymentProcessorSettings,
        cfg?.roundUpProcessingFee === true,
        { paymentMethod: 'Highest', zeroFeeForACH: cfg?.zeroFeeForACH === true }
      );
      return round2(Number(amount || 0) + Number(inc || 0));
    };

    // 1) Fold included processing fee into premiums for display + equivalence
    for (const p of pricingResult.products || []) {
      if (!p?.productId) continue;

      // Bundle: adjust each included product, then recompute bundle totals
      if (p.isBundle === true && Array.isArray(p.includedProducts) && p.includedProducts.length > 0) {
        const TIERS = ['EE', 'ES', 'EC', 'EF'];
        for (const ip of p.includedProducts) {
          if (!ip?.productId) continue;
          ip.monthlyPremium = applyIncludedFeeToAmount(ip.productId, Number(ip.monthlyPremium || 0));
          if (ip.equivalentPremiums && typeof ip.equivalentPremiums === 'object') {
            for (const tier of Object.keys(ip.equivalentPremiums)) {
              ip.equivalentPremiums[tier] = applyIncludedFeeToAmount(ip.productId, Number(ip.equivalentPremiums[tier] || 0));
            }
          }
        }
        p.monthlyPremium = round2(p.includedProducts.reduce((sum, ip) => sum + Number(ip?.monthlyPremium || 0), 0));
        p.equivalentPremiums = p.equivalentPremiums && typeof p.equivalentPremiums === 'object' ? p.equivalentPremiums : {};
        for (const tier of TIERS) {
          const sumTier = p.includedProducts.reduce((sum, ip) => {
            const eq = (ip?.equivalentPremiums && ip.equivalentPremiums[tier] != null) ? Number(ip.equivalentPremiums[tier] || 0) : Number(ip?.monthlyPremium || 0);
            return sum + eq;
          }, 0);
          p.equivalentPremiums[tier] = round2(sumTier);
        }
      } else {
        p.monthlyPremium = applyIncludedFeeToAmount(p.productId, Number(p.monthlyPremium || 0));
        if (p.equivalentPremiums && typeof p.equivalentPremiums === 'object') {
          for (const tier of Object.keys(p.equivalentPremiums)) {
            p.equivalentPremiums[tier] = applyIncludedFeeToAmount(p.productId, Number(p.equivalentPremiums[tier] || 0));
          }
        }
      }
    }

    // System fees:
    // - If ANY selected product (or bundle component) has CustomSystemFeeEnabled, the product handles system fees in its premium → do not add tenant system fees here.
    // - Otherwise, use tenant SystemFees settings (calculated on premium-only totals; processing fees are handled separately).
    const systemFeesCalculator = require('../utils/systemFeesCalculator');
    const basePremiumTotal = round2((productsBeforeIncludedProcessingFee || []).reduce((sum, p) => sum + (Number(p?.monthlyPremium) || 0), 0));
    const anyProductHandlesSystemFeeOwn = Array.from(subscriptionFeeSettingsByProductId.values()).some(
      (cfg) => cfg && cfg.customSystemFeeEnabled === true
    );
    const customSystemFeeAmounts = [];
    for (const pid of idsForFeeSettings) {
      const cfg = subscriptionFeeSettingsByProductId.get(String(pid));
      if (cfg?.customSystemFeeEnabled && cfg?.customSystemFeeAmount != null && cfg.customSystemFeeAmount > 0) {
        customSystemFeeAmounts.push(Number(cfg.customSystemFeeAmount));
      }
    }
    const systemFeesForPremiumTotal = (premiumOnlyTotal) => {
      if (anyProductHandlesSystemFeeOwn) return 0;
      if (customSystemFeeAmounts.length > 0) return round2(Math.max(...customSystemFeeAmounts));
      return round2(systemFeesCalculator.calculateSystemFees(Number(premiumOnlyTotal || 0), systemFeesSettings));
    };
    const systemFeesAmount = systemFeesForPremiumTotal(basePremiumTotal);

    // 2) Compute total processing fee remainder (non-included subtotal only) and allocate per selected product/bundle.
    // Total fee (including the zero-fee-for-ACH two-pool split) is delegated to the shared helper:
    //   backend/utils/productProcessingFees.js:calculateProcessingFeeBreakdownByProduct
    // The allocation step below only needs per-selection billable amounts under the current method.
    const isACHMethod = String(effectivePaymentMethodType).toLowerCase() === 'ach';
    const billableNonIncludedAmount = (pid, amount) => {
      const cfg = cfgFor(pid);
      const amt = Number(amount || 0);
      if (chargeFeeToMemberEnabled && cfg?.includeProcessingFee === true) return 0;
      if (chargeFeeToMemberEnabled && cfg?.zeroFeeForACH === true && isACHMethod) return 0;
      return round2(amt);
    };

    const perSelectionNonIncluded = (pricingResult.products || []).map((p) => {
      if (!p?.productId) return { productId: p?.productId, nonIncludedSubtotal: 0 };
      if (p.isBundle === true && Array.isArray(p.includedProducts) && p.includedProducts.length > 0) {
        let subtotal = 0;
        for (const ip of p.includedProducts) {
          if (!ip?.productId) continue;
          subtotal += billableNonIncludedAmount(ip.productId, ip.monthlyPremium);
        }
        return { productId: p.productId, nonIncludedSubtotal: round2(subtotal) };
      }
      return { productId: p.productId, nonIncludedSubtotal: billableNonIncludedAmount(p.productId, p.monthlyPremium) };
    });

    // Pricing Authority (single source of truth for fee semantics + display block + fingerprint).
    // Run on the pristine pre-fee product list so the authority re-does its own fee math from scratch.
    // Site 5.3: the two legacy calculateProcessingFeeBreakdownByProduct call sites below (order-level
    // processing-fee total + per-equivalent-tier processing fee) now read from this single authority
    // output instead of invoking the helper directly. See
    // routes/__tests__/enrollment-links.authority.test.js for the permanent 48-scenario equivalence proof.
    const authorityOutput = await pricingAuthority.computePricing({
      poolOrTransaction: pool,
      tenantId: enrollmentLink.TenantId,
      pricingProducts: productsBeforeIncludedProcessingFee,
      paymentMethodType: effectivePaymentMethodType
    });
    const processingFeeTotal = Number(authorityOutput._raw.feeBreakdown.nonIncludedProcessingFeeAmount || 0);
    const nonIncludedSubtotalTotal = Number(authorityOutput._raw.feeBreakdown.nonIncludedPremiumSubtotal || 0);

    // Fee config debug (helps reconcile "where did $X.XX come from?")
    const processorsForFeeCfg = paymentProcessorSettings?.processors || {};
    const activeKeyForFeeCfg = paymentProcessorSettings?.activeProcessor ? String(paymentProcessorSettings.activeProcessor) : null;
    const activeProcessorForFeeCfg = activeKeyForFeeCfg && processorsForFeeCfg ? processorsForFeeCfg[activeKeyForFeeCfg] : null;
    const fallbackProcessorForFeeCfg = processorsForFeeCfg?.openenroll || null;
    const processorToUseForFeeCfg = activeProcessorForFeeCfg || fallbackProcessorForFeeCfg;
    const feeCfg = effectivePaymentMethodType === 'ACH'
      ? processorToUseForFeeCfg?.fees?.ach
      : processorToUseForFeeCfg?.fees?.creditCard;
    const rawPercentageFee = Number(feeCfg?.percentageFee || 0);
    const normalizedPercentageFee = rawPercentageFee > 1 ? rawPercentageFee / 100 : rawPercentageFee;
    const flatFee = Number(feeCfg?.flatFee || 0);

    const processingFeeByProductId = {};
    if (processingFeeTotal > 0) {
      // Allocate using the sum of products that were actually billed (nonIncludedSubtotal > 0 under current method),
      // not the raw non-included total — otherwise zero-fee-for-ACH pools would dilute the ratio under ACH.
      const candidates = perSelectionNonIncluded.filter((r) => Number(r.nonIncludedSubtotal || 0) > 0);
      const candidateDenominator = round2(candidates.reduce((sum, r) => sum + Number(r.nonIncludedSubtotal || 0), 0));
      if (candidateDenominator > 0) {
        let allocated = 0;
        for (let i = 0; i < candidates.length; i++) {
          const r = candidates[i];
          const isLast = i === candidates.length - 1;
          const share = isLast
            ? round2(processingFeeTotal - allocated)
            : round2(processingFeeTotal * (Number(r.nonIncludedSubtotal || 0) / candidateDenominator));
          processingFeeByProductId[String(r.productId)] = share;
          allocated = round2(allocated + share);
        }
      }
    }

    for (const p of pricingResult.products || []) {
      const fee = Number(processingFeeByProductId[String(p.productId)] || 0);
      p.processingFeeAmount = fee;
    }

    // 3) Equivalent-tier bases for EquivalentTier percentage rules (premium + processing fee).
    // Task 5.3: per-tier processing fee is now delegated to pricingAuthority.computePricing.
    // For each tier we build a per-tier pricingProducts list (premium = tier base for each product)
    // and ask the authority for the non-included processing fee. This keeps the zero-fee-for-ACH
    // two-pool split and included-fee semantics consistent with the rest of the pipeline.
    let equivalentTierBases = null;
    try {
      const TIERS = ['EE', 'ES', 'EC', 'EF'];
      equivalentTierBases = {};
      const tierBaseOf = (entity, tier) => {
        const eq = entity?.equivalentPremiums;
        return (eq && eq[tier] != null) ? Number(eq[tier] || 0) : Number(entity?.monthlyPremium || 0);
      };
      for (const tier of TIERS) {
        let productTotal = 0;
        let productTotalForSystemFee = 0;

        // Display-inflated tier totals (included fees already folded into pricingResult above).
        for (const p of pricingResult.products || []) {
          productTotal += tierBaseOf(p, tier);
        }
        // Pristine per-product pricing list for this tier (authority input mirrors
        // the full computePricing shape — bundles stay as bundles so included-fee math works).
        const tierPricingProducts = (productsBeforeIncludedProcessingFee || []).map((p) => {
          if (!p?.productId) return null;
          productTotalForSystemFee += tierBaseOf(p, tier);
          if (p.isBundle === true && Array.isArray(p.includedProducts)) {
            return {
              productId: p.productId,
              productName: p.productName || p.name,
              isBundle: true,
              monthlyPremium: tierBaseOf(p, tier),
              includedProducts: p.includedProducts
                .filter((ip) => ip?.productId)
                .map((ip) => ({
                  productId: ip.productId,
                  productName: ip.productName || ip.name,
                  monthlyPremium: tierBaseOf(ip, tier)
                }))
            };
          }
          return {
            productId: p.productId,
            productName: p.productName || p.name,
            monthlyPremium: tierBaseOf(p, tier)
          };
        }).filter(Boolean);

        const tierAuthorityOutput = await pricingAuthority.computePricing({
          poolOrTransaction: pool,
          tenantId: enrollmentLink.TenantId,
          pricingProducts: tierPricingProducts,
          paymentMethodType: effectivePaymentMethodType
        });

        productTotal = round2(productTotal);
        productTotalForSystemFee = round2(productTotalForSystemFee);
        const tierSystemFees = systemFeesForPremiumTotal(productTotalForSystemFee);
        const tierProcessingFee = Number(tierAuthorityOutput.totals.nonIncludedFeeTotal || 0);
        equivalentTierBases[tier] = { productTotal, totalWithFees: round2(productTotal + tierSystemFees + tierProcessingFee) };
      }
    } catch (_) {
      equivalentTierBases = null;
    }

    // Compute contributions using backend ContributionCalculator as source of truth.
    const ContributionCalculator = require('../services/pricing/ContributionCalculator');
    // For contribution math, fold the allocated (non-included) processing fee into each product's premium.
    const productsForContribution = JSON.parse(JSON.stringify(pricingResult.products || []));
    for (const p of productsForContribution) {
      const fee = Number(processingFeeByProductId[String(p.productId)] || 0);
      if (fee > 0) p.monthlyPremium = round2(Number(p.monthlyPremium || 0) + fee);
    }
    const contributionResult = await ContributionCalculator.calculateContributions({
      groupId: enrollmentLink.GroupId,
      productPricingResults: productsForContribution,
      memberCriteria: pricingParams.memberCriteria,
      additionalFees: systemFeesAmount,
      equivalentTierBases
    });
    const totalPremium = round2(
      (pricingResult.products || []).reduce((sum, p) => sum + (Number(p.monthlyPremium) || 0) + (Number(p.processingFeeAmount) || 0), 0)
      + Number(systemFeesAmount || 0)
    );
    const totals = {
      totalPremium,
      totalEmployerContribution: contributionResult.employerTotal || 0,
      totalEmployeeContribution: contributionResult.employeeTotal || 0
    };

    // Return products (pricing), per-product processing fee, contribution breakdown, totals (premium + processing fee)
    return res.json({
      success: true,
      data: {
        products: pricingResult.products,
        fees: {
          processingFeeTotal,
          processingFeeByProductId,
          nonIncludedSubtotalTotal,
          systemFeesAmount,
          basePremiumTotal,
          anyProductHandlesSystemFeeOwn,
          customSystemFeeAmounts,
          subscriptionFeeSettingsByProductId: subscriptionFeeSettingsDebug,
          feeSettingsProductIds: idsForFeeSettings.map(String),
          nonIncludedSubtotalByProductId: perSelectionNonIncluded.reduce((acc, r) => {
            acc[String(r.productId)] = round2(Number(r.nonIncludedSubtotal || 0));
            return acc;
          }, {}),
          paymentMethodType: effectivePaymentMethodType,
          chargeFeeToMember: chargeFeeToMemberEnabled,
          feeConfig: {
            percentageFeeRaw: rawPercentageFee,
            percentageFeeNormalized: normalizedPercentageFee,
            flatFee
          }
        },
        contributions: contributionResult,
        totals,
        authority: authorityOutput
          ? {
              products: authorityOutput.products,
              totals: authorityOutput.totals,
              display: authorityOutput.display,
              pricingFingerprint: authorityOutput.pricingFingerprint
            }
          : null
      }
    });
  } catch (error) {
    console.error('❌ ERROR: Failed to compute contribution preview:', error);
    return res.status(500).json({ success: false, message: error.message || 'Contribution preview failed' });
  }
});

router.get('/:linkToken/effective-dates', async (req, res) => {
  try {
    const { linkToken } = req.params;
    const { selectedProducts } = req.query;
    
    console.log('🔍 DEBUG: Effective dates request for link:', linkToken, 'selectedProducts:', selectedProducts);
    
    if (!linkToken) {
      return res.status(400).json({
        success: false,
        message: 'Link token is required'
      });
    }
    
    const pool = await getPool();
    
    // 1. Get enrollment link and template data
    const linkQuery = `
      SELECT 
        el.LinkId,
        el.GroupId,
        el.MemberId,
        el.LinkToken,
        el.LinkType,
        el.IsActive,
        el.ExpiresAt,
        el.EnrollmentLinkTemplateId,
        el.EarliestEffectiveDate,
        g.Name AS GroupName,
        g.TenantId,
        g.IsInInitialEnrollmentPeriod,
        g.InitialEnrollmentPeriodStart,
        g.InitialEnrollmentPeriodEnd,
        g.EarliestEffectiveDate AS GroupEarliestEffectiveDate,
        g.AllowMidMonthEffective,
        elt.TemplateName,
        elt.TemplateType,
        elt.LinkMetaData
      FROM oe.EnrollmentLinks el
      LEFT JOIN oe.Groups g ON el.GroupId = g.GroupId
      LEFT JOIN oe.EnrollmentLinkTemplates elt ON el.EnrollmentLinkTemplateId = elt.TemplateId
      WHERE el.LinkToken = @linkToken
    `;
    
    const linkRequest = pool.request();
    linkRequest.input('linkToken', sql.NVarChar, linkToken);
    
    const linkResult = await linkRequest.query(linkQuery);
    
    if (linkResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Enrollment link not found or has expired'
      });
    }
    
    const enrollmentLink = linkResult.recordset[0];
    
    // 2. Get member information (hire date) - skip for Agent-Static/Marketing links
    let member = null;
    const isAgentStaticLink = enrollmentLink.LinkType === 'Agent-Static' || enrollmentLink.LinkType === 'Marketing' || (!enrollmentLink.MemberId && !enrollmentLink.GroupId);
    
    if (!isAgentStaticLink && enrollmentLink.MemberId) {
      const memberQuery = `
        SELECT 
          m.MemberId,
          m.UserId,
          m.HireDate,
          u.FirstName,
          u.LastName,
          u.Email
        FROM oe.Members m
        JOIN oe.Users u ON m.UserId = u.UserId
        WHERE m.MemberId = @memberId
      `;
      
      const memberRequest = pool.request();
      memberRequest.input('memberId', sql.UniqueIdentifier, enrollmentLink.MemberId);
      
      const memberResult = await memberRequest.query(memberQuery);
      
      if (memberResult.recordset.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Member not found for this enrollment link'
        });
      }
      
      member = memberResult.recordset[0];
    }
    
    // 3. Parse link metadata
    let linkMetaData = {};
    try {
      linkMetaData = JSON.parse(enrollmentLink.LinkMetaData || '{}');
    } catch (error) {
      console.warn('⚠️ Failed to parse LinkMetaData, using empty object');
    }
    
    const isGroupEnrollment = enrollmentLink.TemplateType === 'Group' && !isAgentStaticLink;
    
    // Check if group is in initial enrollment period
    const isInEnrollmentPeriod = isGroupEnrollment && 
        enrollmentLink.IsInInitialEnrollmentPeriod && 
        enrollmentLink.InitialEnrollmentPeriodEnd;
    
    // For group enrollments during initial period, effective date is FIXED to 1st of month after period ends
    // For individual enrollments, check linkMetaData for fixed date
    let fixedEffectiveDate = null;
    
    if (isInEnrollmentPeriod) {
        // Use group's EarliestEffectiveDate if set, otherwise calculate 1st of month after enrollment period ends
        if (enrollmentLink.GroupEarliestEffectiveDate) {
            fixedEffectiveDate = new Date(enrollmentLink.GroupEarliestEffectiveDate).toISOString().split('T')[0];
            console.log('🔍 DEBUG: Group in initial enrollment period - using group EarliestEffectiveDate:', fixedEffectiveDate);
        } else {
            // Calculate 1st of month after enrollment period ends (fallback)
            const periodEnd = new Date(enrollmentLink.InitialEnrollmentPeriodEnd);
            const benefitStart = new Date(periodEnd.getFullYear(), periodEnd.getMonth() + 1, 1);
            fixedEffectiveDate = benefitStart.toISOString().split('T')[0];
            console.log('🔍 DEBUG: Group in initial enrollment period - calculating default (no EarliestEffectiveDate set):', fixedEffectiveDate);
        }
    } else if (!isGroupEnrollment) {
        // Individual enrollment - check linkMetaData for fixed date
        fixedEffectiveDate = linkMetaData.effectiveDate;
    }
    
    const minimumHirePeriod = linkMetaData.minimumHirePeriod || 0;
    
    console.log('🔍 DEBUG: Enrollment details:', {
      isGroupEnrollment,
      isAgentStaticLink,
      fixedEffectiveDate,
      minimumHirePeriod,
      memberHireDate: member?.HireDate || `N/A (${enrollmentLink.LinkType || 'no member'})`
    });
    
    // 4. Calculate effective date rules (hire date is optional)
    const today = new Date();
    const memberHireDate = member?.HireDate ? new Date(member.HireDate) : null;
    
    let effectiveDateOptions = {
      type: 'dropdown', // default
      fixedDate: null,
      availableDates: [],
      dateRange: null,
      restrictions: {
        mustBeFirstOfMonth: false,
        maxDaysInFuture: 90
      }
    };
    
    let memberQualified = true;
    let qualificationMessage = '';
    
    // For individual enrollment links, check product effective date rules
    if (!isGroupEnrollment) {
      memberQualified = true;
      qualificationMessage = 'You can choose any date within the next 90 days for your benefits to start.';
      
      // Check if any SELECTED products require first of month effective dates
      let requiresFirstOfMonth = false;
      
      // If no products are selected yet, default to calendar picker (any day)
      if (!selectedProducts || selectedProducts.length === 0) {
        console.log('🔍 DEBUG: No products selected yet, defaulting to calendar picker');
        requiresFirstOfMonth = false;
      } else {
        try {
          // Parse selected products from query parameter
          const selectedProductIds = selectedProducts.split(',').filter(id => id.trim());
          
          console.log('🔍 DEBUG: Checking effective date rules for selected products:', selectedProductIds);
          
          // Check if any selected products require first of month
          if (selectedProductIds.length > 0) {
            const productIdsStr = selectedProductIds.map(id => `'${id.trim()}'`).join(',');
            const productRulesQuery = `
              -- Non-bundle selected products only (bundle EffectiveDateLogic is ignored)
              SELECT ProductId, Name, EffectiveDateLogic
              FROM oe.Products
              WHERE ProductId IN (${productIdsStr})
                AND Status = 'Active'
                AND ISNULL(IsBundle, 0) = 0

              UNION ALL

              -- Included products within selected bundles determine bundle effective-date rules
              SELECT p.ProductId, p.Name, p.EffectiveDateLogic
              FROM oe.ProductBundles pb
              INNER JOIN oe.Products p ON pb.IncludedProductId = p.ProductId
              WHERE pb.BundleProductId IN (${productIdsStr})
                AND p.Status = 'Active'
            `;
            
            const productRulesRequest = pool.request();
            const productRulesResult = await productRulesRequest.query(productRulesQuery);
            
            console.log('🔍 DEBUG: Product effective date rules:', productRulesResult.recordset);
            
            // Check if any selected product requires first of month
            requiresFirstOfMonth = productRulesResult.recordset.some(product => 
              product.EffectiveDateLogic === 'FirstOfMonth'
            );
            
            console.log('🔍 DEBUG: Requires first of month:', requiresFirstOfMonth);
          }
        } catch (error) {
          console.warn('⚠️ Error checking product effective date rules:', error.message);
          // Default to calendar picker if there's an error
          requiresFirstOfMonth = false;
        }
      }
      
      if (requiresFirstOfMonth) {
        // Generate first of month dates for the next 90 days
        const availableDates = [];
        const currentDate = new Date(today);
        const endDate = new Date(today.getTime() + 90 * 24 * 60 * 60 * 1000);
        
        // Start from the 1st of current month or next month
        currentDate.setDate(1);
        if (currentDate <= today) {
          currentDate.setMonth(currentDate.getMonth() + 1);
        }
        
        while (currentDate <= endDate) {
          availableDates.push(currentDate.toISOString().split('T')[0]);
          currentDate.setMonth(currentDate.getMonth() + 1);
        }
        
        effectiveDateOptions = {
          type: 'dropdown',
          fixedDate: null,
          availableDates: availableDates,
          dateRange: null,
          restrictions: {
            mustBeFirstOfMonth: true,
            maxDaysInFuture: 90
          }
        };
        
        qualificationMessage = 'You can choose from the available first-of-month dates for your benefits to start.';
      } else {
        // Use calendar picker for flexible dates
        effectiveDateOptions = {
          type: 'calendar',
          fixedDate: null,
          availableDates: null,
          dateRange: {
            earliest: today.toISOString().split('T')[0],
            latest: new Date(today.getTime() + 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
          },
          restrictions: {
            mustBeFirstOfMonth: false,
            maxDaysInFuture: 90
          }
        };
      }
    } else if (fixedEffectiveDate) {
      // Fixed effective date scenario
      const effectiveDate = new Date(fixedEffectiveDate);
      
      // For group enrollments during initial period, skip hire date check
      if (isInEnrollmentPeriod) {
        memberQualified = true;
        const periodEnd = new Date(enrollmentLink.InitialEnrollmentPeriodEnd);
        qualificationMessage = `Your group is currently in its initial enrollment period (ending ${periodEnd.toLocaleDateString()}). Your benefits will automatically start on ${effectiveDate.toLocaleDateString()} - the first of the month after the enrollment period ends.`;
      } else if (memberHireDate && minimumHirePeriod > 0) {
        // Regular fixed date logic with hire date check (only if minimumHirePeriod > 0)
        const daysBetween = Math.floor((effectiveDate.getTime() - memberHireDate.getTime()) / (1000 * 60 * 60 * 24));
        
        if (daysBetween < minimumHirePeriod) {
          memberQualified = false;
          qualificationMessage = `You do not qualify because you will not have been hired long enough by this effective date. You need to be hired for at least ${minimumHirePeriod} days, but you will only have been hired for ${daysBetween} days by ${effectiveDate.toLocaleDateString()}.`;
        } else {
          qualificationMessage = `Your benefits will start on ${effectiveDate.toLocaleDateString()}.`;
        }
      } else {
        // No hire date check needed (minimumHirePeriod is 0 or no hire date available)
        memberQualified = true;
        qualificationMessage = `Your benefits will start on ${effectiveDate.toLocaleDateString()}.`;
      }
      
      effectiveDateOptions = {
        type: 'fixed',
        fixedDate: fixedEffectiveDate,
        availableDates: null,
        dateRange: null,
        restrictions: {
          mustBeFirstOfMonth: true,
          maxDaysInFuture: 0
        }
      };
    } else {
      // Employee can choose scenario
      let earliestDate, latestDate, mustBeFirstOfMonth;
      
      if (isGroupEnrollment) {
        // Group enrollments: Only 1st of month dates within 90 days
        mustBeFirstOfMonth = true;
        
        // Use group's EarliestEffectiveDate if set and in the future, otherwise calculate from today
        if (enrollmentLink.GroupEarliestEffectiveDate) {
          const groupEarliest = new Date(enrollmentLink.GroupEarliestEffectiveDate);
          const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
          
          // Use group's earliest date if it's today or in the future, otherwise use calculated date
          if (groupEarliest >= todayStart) {
            earliestDate = new Date(groupEarliest.getFullYear(), groupEarliest.getMonth(), groupEarliest.getDate());
            console.log('🔍 DEBUG: Using group EarliestEffectiveDate for group enrollment:', earliestDate.toISOString().split('T')[0]);
          } else {
            // Group's earliest date is in the past, calculate from today.
            // Bump to "tomorrow" rather than next month's 1st so any remaining
            // cohort days in the current month (e.g. the 15th when today is
            // the 1st) stay eligible. Per-candidate filter below still excludes
            // specific day-of-month values on or before today.
            earliestDate = new Date(today.getFullYear(), today.getMonth(), 1);
            if (earliestDate <= today) {
              earliestDate = new Date(today);
              earliestDate.setDate(earliestDate.getDate() + 1);
            }
            console.log('🔍 DEBUG: Group EarliestEffectiveDate is in the past, using calculated date:', earliestDate.toISOString().split('T')[0]);
          }
        } else {
          // Start from 1st of current month. If today is on/after the 1st,
          // bump earliestDate to tomorrow so the current month's 15th remains
          // eligible (matters when AllowMidMonthEffective=on).
          earliestDate = new Date(today.getFullYear(), today.getMonth(), 1);
          if (earliestDate <= today) {
            earliestDate = new Date(today);
            earliestDate.setDate(earliestDate.getDate() + 1);
          }
          console.log('🔍 DEBUG: No group EarliestEffectiveDate set, using calculated earliest date for group enrollment:', earliestDate.toISOString().split('T')[0]);
        }
        
        // End 90 days from today
        latestDate = new Date(today);
        latestDate.setDate(latestDate.getDate() + 90);
      } else {
        // Individual enrollments: Check if any products require 1st of month
        // For now, we'll assume individual enrollments can be flexible
        // In a full implementation, you'd check the selected products
        mustBeFirstOfMonth = false;
        
        // Start from tomorrow for flexible dates
        earliestDate = new Date(today);
        earliestDate.setDate(earliestDate.getDate() + 1);
        
        // End 90 days from today
        latestDate = new Date(today);
        latestDate.setDate(latestDate.getDate() + 90);
      }
      
      // Generate available dates
      const availableDates = [];

      if (mustBeFirstOfMonth) {
        // Determine which cohort day(s) to offer.
        //
        // If the link points at an existing member whose household already
        // has active enrollments, lock to that household's cohort so the
        // family stays on a single billing cycle. Otherwise fall back to
        // the group's AllowMidMonthEffective flag.
        const { getHouseholdCohortByMemberId } = require('../services/householdCohort.service');
        const householdCohort = enrollmentLink.MemberId
          ? await getHouseholdCohortByMemberId(pool, enrollmentLink.MemberId)
          : null;
        let allowedDays;
        if (householdCohort === 'FIRST') {
          allowedDays = [1];
        } else if (householdCohort === 'FIFTEENTH') {
          allowedDays = [15];
        } else {
          const allowMidMonth = isGroupEnrollment && (enrollmentLink.AllowMidMonthEffective === true || enrollmentLink.AllowMidMonthEffective === 1);
          allowedDays = allowMidMonth ? [1, 15] : [1];
        }

        // Generate cohort-day dates.
        // Anchor month iterator at the 1st of earliestDate's month, not
        // earliestDate's actual day, so the last-month's 1st isn't skipped
        // when earliestDate landed mid-month (e.g. "today+1" bump).
        const currentDate = new Date(earliestDate.getFullYear(), earliestDate.getMonth(), 1);
        while (currentDate <= latestDate) {
          for (const day of allowedDays) {
            const candidate = new Date(currentDate.getFullYear(), currentDate.getMonth(), day);
            if (candidate >= earliestDate && candidate <= latestDate) {
              // Check if member qualifies for this date (only if minimumHirePeriod > 0 and hire date exists)
              if (memberHireDate && minimumHirePeriod > 0) {
                const daysBetween = Math.floor((candidate.getTime() - memberHireDate.getTime()) / (1000 * 60 * 60 * 24));
                if (daysBetween >= minimumHirePeriod) {
                  availableDates.push(candidate.toISOString().split('T')[0]);
                }
              } else {
                // No hire date check needed (minimumHirePeriod is 0, Agent-Static, or individual enrollment)
                availableDates.push(candidate.toISOString().split('T')[0]);
              }
            }
          }
          currentDate.setMonth(currentDate.getMonth() + 1);
        }
        availableDates.sort();

        effectiveDateOptions = {
          type: 'dropdown',
          fixedDate: null,
          availableDates: availableDates,
          dateRange: null,
          restrictions: {
            allowedDays: allowedDays,
            // Backward-compat alias: true only when 1st-of-month is the only allowed day
            mustBeFirstOfMonth: allowedDays.length === 1 && allowedDays[0] === 1,
            maxDaysInFuture: 90
          }
        };
      } else {
        // Generate flexible dates (calendar picker)
        effectiveDateOptions = {
          type: 'calendar',
          fixedDate: null,
          availableDates: null,
          dateRange: {
            earliest: earliestDate.toISOString().split('T')[0],
            latest: latestDate.toISOString().split('T')[0]
          },
          restrictions: {
            mustBeFirstOfMonth: false,
            maxDaysInFuture: 90
          }
        };
      }
      
      // Check if any dates are available
      if (mustBeFirstOfMonth && availableDates.length === 0) {
        memberQualified = false;
        qualificationMessage = `No effective dates are available because you have not been hired long enough. You need to be hired for at least ${minimumHirePeriod} days before any available effective date.`;
      } else if (!mustBeFirstOfMonth && memberHireDate && minimumHirePeriod > 0) {
        // For flexible dates, check if member qualifies for the earliest possible date (only if minimumHirePeriod > 0)
        const daysBetween = Math.floor((earliestDate.getTime() - memberHireDate.getTime()) / (1000 * 60 * 60 * 24));
        if (daysBetween < minimumHirePeriod) {
          memberQualified = false;
          qualificationMessage = `You do not qualify for the earliest possible effective date. You need to be hired for at least ${minimumHirePeriod} days, but you will only have been hired for ${daysBetween} days by ${earliestDate.toLocaleDateString()}.`;
        }
      }
    }
    
    console.log('🔍 DEBUG: Effective date options:', effectiveDateOptions);
    
    res.json({
      success: true,
      data: {
        enrollmentType: isGroupEnrollment ? 'Group' : 'Individual',
        memberQualified: memberQualified,
        qualificationMessage: qualificationMessage,
        effectiveDateOptions: effectiveDateOptions
      },
      message: 'Effective dates retrieved successfully'
    });
    
  } catch (error) {
    console.error('❌ ERROR: Failed to get effective dates:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching effective dates'
    });
  }
});

// POST /api/enrollment-links/send-individual - Send individual enrollment link to a member
// MOVED TO /api/me/enrollment-links/send-individual for authentication
// This endpoint is now deprecated - use the authenticated version instead
router.post('/send-individual', async (req, res) => {
  // This endpoint has been moved to /api/me/enrollment-links/send-individual for authentication
  res.status(410).json({
    success: false,
    message: 'This endpoint has been moved to /api/me/enrollment-links/send-individual. Please use the authenticated version.',
    deprecated: true,
    newEndpoint: '/api/me/enrollment-links/send-individual'
  });
});

// Import unified PDF generator
const { generateAgreementsPDF } = require('../utils/pdfGenerator');

// Helper function to create fee enrollment records (SystemFee, PaymentProcessingFee, and SetupFee)
async function createFeeEnrollmentRecords({
  transaction,
  primaryMember,
  householdId,
  totalPremium,
  systemFeesAmount,
  paymentProcessingFeeAmount,
  setupFeeAmount,
  effectiveDate,
  enrollmentLink,
  enrollmentRowStatus = ENROLLMENT_STATUS.ACTIVE
}) {
  const createdFeeEnrollments = [];
  const crypto = require('crypto');
  const sql = require('mssql');
  
  // Use the same GUID for all non-product enrollment records (SystemFee, PaymentProcessingFee, Contribution)
  const NON_PRODUCT_PRODUCT_ID = '00000000-0000-0000-0000-000000000000';
  
  // Create SystemFee enrollment record if amount > 0
  if (systemFeesAmount > 0) {
    const systemFeeEnrollmentId = crypto.randomUUID();
    const enrollmentAgentId = primaryMember.AgentId || enrollmentLink.AgentId || enrollmentLink.AgencyId || null;
    const enrollmentEffectiveDate = effectiveDate ? new Date(effectiveDate) : new Date();
    
    const systemFeeRequest = transaction.request();
    systemFeeRequest.input('enrollmentId', sql.UniqueIdentifier, systemFeeEnrollmentId);
    systemFeeRequest.input('memberId', sql.UniqueIdentifier, primaryMember.MemberId);
    systemFeeRequest.input('productId', sql.UniqueIdentifier, NON_PRODUCT_PRODUCT_ID);
    systemFeeRequest.input('agentId', sql.UniqueIdentifier, enrollmentAgentId);
    systemFeeRequest.input('effectiveDate', sql.Date, enrollmentEffectiveDate);
    systemFeeRequest.input('premiumAmount', sql.Decimal(19,4), systemFeesAmount);
    systemFeeRequest.input('paymentFrequency', sql.NVarChar, 'Monthly');
    systemFeeRequest.input('status', sql.NVarChar, 'Active');
    systemFeeRequest.input('householdId', sql.UniqueIdentifier, householdId);
    systemFeeRequest.input('enrollmentType', sql.NVarChar, 'SystemFee');
    systemFeeRequest.input('createdBy', sql.UniqueIdentifier, primaryMember.UserId);
    systemFeeRequest.input('modifiedBy', sql.UniqueIdentifier, primaryMember.UserId);
    
    if (enrollmentLink.GroupId) {
      systemFeeRequest.input('groupId', sql.UniqueIdentifier, enrollmentLink.GroupId);
    }
    
    await EnrollmentWriter.insertNonProductEnrollmentRow({
      poolOrTransaction: transaction,
      enrollmentId: systemFeeEnrollmentId,
      memberId: primaryMember.MemberId,
      householdId,
      agentId: enrollmentAgentId,
      groupId: enrollmentLink.GroupId || null,
      effectiveDate: enrollmentEffectiveDate,
      premiumAmount: systemFeesAmount,
      enrollmentType: 'SystemFee',
      paymentFrequency: 'Monthly',
      createdBy: primaryMember.UserId,
      modifiedBy: primaryMember.UserId,
      nonProductProductId: NON_PRODUCT_PRODUCT_ID,
      status: enrollmentRowStatus
    });
    console.log(`✅ Created SystemFee enrollment: ${systemFeeEnrollmentId} with amount $${systemFeesAmount.toFixed(2)}`);
    createdFeeEnrollments.push({
      enrollmentId: systemFeeEnrollmentId,
      enrollmentType: 'SystemFee',
      amount: systemFeesAmount
    });
  }
  
  // Create PaymentProcessingFee enrollment record if amount > 0
  if (paymentProcessingFeeAmount > 0) {
    const processingFeeEnrollmentId = crypto.randomUUID();
    const enrollmentAgentId = primaryMember.AgentId || enrollmentLink.AgentId || enrollmentLink.AgencyId || null;
    const enrollmentEffectiveDate = effectiveDate ? new Date(effectiveDate) : new Date();
    
    const processingFeeRequest = transaction.request();
    processingFeeRequest.input('enrollmentId', sql.UniqueIdentifier, processingFeeEnrollmentId);
    processingFeeRequest.input('memberId', sql.UniqueIdentifier, primaryMember.MemberId);
    processingFeeRequest.input('productId', sql.UniqueIdentifier, NON_PRODUCT_PRODUCT_ID);
    processingFeeRequest.input('agentId', sql.UniqueIdentifier, enrollmentAgentId);
    processingFeeRequest.input('effectiveDate', sql.Date, enrollmentEffectiveDate);
    processingFeeRequest.input('premiumAmount', sql.Decimal(19,4), paymentProcessingFeeAmount);
    processingFeeRequest.input('paymentFrequency', sql.NVarChar, 'Monthly');
    processingFeeRequest.input('status', sql.NVarChar, 'Active');
    processingFeeRequest.input('householdId', sql.UniqueIdentifier, householdId);
    processingFeeRequest.input('enrollmentType', sql.NVarChar, 'PaymentProcessingFee');
    processingFeeRequest.input('createdBy', sql.UniqueIdentifier, primaryMember.UserId);
    processingFeeRequest.input('modifiedBy', sql.UniqueIdentifier, primaryMember.UserId);
    
    if (enrollmentLink.GroupId) {
      processingFeeRequest.input('groupId', sql.UniqueIdentifier, enrollmentLink.GroupId);
    }
    
    await EnrollmentWriter.insertNonProductEnrollmentRow({
      poolOrTransaction: transaction,
      enrollmentId: processingFeeEnrollmentId,
      memberId: primaryMember.MemberId,
      householdId,
      agentId: enrollmentAgentId,
      groupId: enrollmentLink.GroupId || null,
      effectiveDate: enrollmentEffectiveDate,
      premiumAmount: paymentProcessingFeeAmount,
      enrollmentType: 'PaymentProcessingFee',
      paymentFrequency: 'Monthly',
      createdBy: primaryMember.UserId,
      modifiedBy: primaryMember.UserId,
      nonProductProductId: NON_PRODUCT_PRODUCT_ID,
      status: enrollmentRowStatus
    });
    console.log(`✅ Created PaymentProcessingFee enrollment: ${processingFeeEnrollmentId} with amount $${paymentProcessingFeeAmount.toFixed(2)}`);
    createdFeeEnrollments.push({
      enrollmentId: processingFeeEnrollmentId,
      enrollmentType: 'PaymentProcessingFee',
      amount: paymentProcessingFeeAmount
    });
  }
  
  // Create SetupFee enrollment record if amount > 0
  if (setupFeeAmount > 0) {
    const setupFeeEnrollmentId = crypto.randomUUID();
    const enrollmentAgentId = primaryMember.AgentId || enrollmentLink.AgentId || enrollmentLink.AgencyId || null;
    const enrollmentEffectiveDate = effectiveDate ? new Date(effectiveDate) : new Date();
    
    const setupFeeRequest = transaction.request();
    setupFeeRequest.input('enrollmentId', sql.UniqueIdentifier, setupFeeEnrollmentId);
    setupFeeRequest.input('memberId', sql.UniqueIdentifier, primaryMember.MemberId);
    setupFeeRequest.input('productId', sql.UniqueIdentifier, NON_PRODUCT_PRODUCT_ID);
    setupFeeRequest.input('agentId', sql.UniqueIdentifier, enrollmentAgentId);
    setupFeeRequest.input('effectiveDate', sql.Date, enrollmentEffectiveDate);
    setupFeeRequest.input('premiumAmount', sql.Decimal(19,4), setupFeeAmount);
    setupFeeRequest.input('paymentFrequency', sql.NVarChar, 'One-time');
    setupFeeRequest.input('status', sql.NVarChar, enrollmentRowStatus);
    setupFeeRequest.input('householdId', sql.UniqueIdentifier, householdId);
    setupFeeRequest.input('enrollmentType', sql.NVarChar, 'SetupFee');
    setupFeeRequest.input('createdBy', sql.UniqueIdentifier, primaryMember.UserId);
    setupFeeRequest.input('modifiedBy', sql.UniqueIdentifier, primaryMember.UserId);
    
    if (enrollmentLink.GroupId) {
      setupFeeRequest.input('groupId', sql.UniqueIdentifier, enrollmentLink.GroupId);
    }
    
    const setupFeeInsertQuery = enrollmentLink.GroupId
      ? `
        INSERT INTO oe.Enrollments (
          EnrollmentId, MemberId, ProductId, AgentId, Status, EffectiveDate,
          PremiumAmount, PaymentFrequency, GroupId, HouseholdId, EnrollmentType,
          CreatedDate, ModifiedDate, CreatedBy, ModifiedBy
        )
        VALUES (
          @enrollmentId, @memberId, @productId, @agentId, @status, @effectiveDate,
          @premiumAmount, @paymentFrequency, @groupId, @householdId, @enrollmentType,
          GETUTCDATE(), GETUTCDATE(), @createdBy, @modifiedBy
        )
      `
      : `
        INSERT INTO oe.Enrollments (
          EnrollmentId, MemberId, ProductId, AgentId, Status, EffectiveDate,
          PremiumAmount, PaymentFrequency, HouseholdId, EnrollmentType,
          CreatedDate, ModifiedDate, CreatedBy, ModifiedBy
        )
        VALUES (
          @enrollmentId, @memberId, @productId, @agentId, @status, @effectiveDate,
          @premiumAmount, @paymentFrequency, @householdId, @enrollmentType,
          GETUTCDATE(), GETUTCDATE(), @createdBy, @modifiedBy
        )
      `;
    
    await setupFeeRequest.query(setupFeeInsertQuery);
    console.log(`✅ Created SetupFee enrollment: ${setupFeeEnrollmentId} with amount $${setupFeeAmount.toFixed(2)}`);
    createdFeeEnrollments.push({
      enrollmentId: setupFeeEnrollmentId,
      enrollmentType: 'SetupFee',
      amount: setupFeeAmount
    });
  }
  
  return createdFeeEnrollments;
}

// Helper function to create or update enrollment
async function createOrUpdateEnrollment({
  transaction,
  householdMember,
  productId,
  productName,
  vendorProductId,
  premiumAmount,
  isPrimaryMember,
  member,
  linkToken,
  isGroupEnrollment,
  enrollmentLink,
  createdEnrollments,
  updatedEnrollments,
  productBundleId = null,
  pricingDetails = null, // NEW: Add pricing details for enrollment snapshot
  configValue = null, // NEW: Add configuration value for bundle components
  effectiveDate = null, // NEW: Add effective date parameter
  bundleTotalPremium = null, // NEW: Bundle total premium for contribution calculations
  enrollmentRowStatus = ENROLLMENT_STATUS.ACTIVE,
  questionnaireResponses = null // NEW: Product questionnaire responses
}) {
  // Check if enrollment already exists for this member and product
  const existingEnrollmentQuery = `
    SELECT 
      e.EnrollmentId,
      e.Status,
      e.EffectiveDate,
      e.PremiumAmount
    FROM oe.Enrollments e
    WHERE e.MemberId = @memberId 
      AND e.ProductId = @productId
      AND e.Status IN ('Active', 'Pending', 'PaymentHold', 'Pending Payment')
  `;
  
  const existingEnrollmentRequest = transaction.request();
  existingEnrollmentRequest.input('memberId', sql.UniqueIdentifier, householdMember.MemberId);
  existingEnrollmentRequest.input('productId', sql.UniqueIdentifier, productId);
  
  const existingEnrollmentResult = await existingEnrollmentRequest.query(existingEnrollmentQuery);
  
  if (existingEnrollmentResult.recordset.length > 0) {
    // Enrollment already exists - update it if needed
    const existingEnrollment = existingEnrollmentResult.recordset[0];
    
    console.log(`🔄 Found existing enrollment: ${existingEnrollment.EnrollmentId} for product ${productId}`);
    
    // Update the existing enrollment if status is different or premium amount changed
    console.log(`🔍 Checking if enrollment needs update:`, {
      currentStatus: existingEnrollment.Status,
      currentPremium: existingEnrollment.PremiumAmount,
      newPremium: premiumAmount,
      statusChanged: existingEnrollment.Status !== 'Active',
      premiumChanged: existingEnrollment.PremiumAmount !== premiumAmount
    });
    
    if (existingEnrollment.Status !== 'Active' || existingEnrollment.PremiumAmount !== premiumAmount) {
      const updateEnrollmentRequest = transaction.request();
      updateEnrollmentRequest.input('enrollmentId', sql.UniqueIdentifier, existingEnrollment.EnrollmentId);
      updateEnrollmentRequest.input('status', sql.NVarChar, 'Active');
      updateEnrollmentRequest.input('premiumAmount', sql.Decimal(19,4), premiumAmount);
      updateEnrollmentRequest.input('policyNumber', sql.NVarChar, vendorProductId);
      const updateEnrollmentDetailsObj = {
        configuration: configValue || 'Default',
        enrollmentType: 'enrollment_link',
        linkToken: linkToken,
        timestamp: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...(questionnaireResponses ? { questionnaireResponses } : {})
      };
      updateEnrollmentRequest.input('enrollmentDetails', sql.NVarChar, JSON.stringify(updateEnrollmentDetailsObj));
      updateEnrollmentRequest.input('modifiedBy', sql.UniqueIdentifier, member.UserId);
      
      // Add HouseholdId (use from householdMember or member)
      const updateHouseholdId = householdMember.HouseholdId || member.HouseholdId || null;
      updateEnrollmentRequest.input('householdId', sql.UniqueIdentifier, updateHouseholdId);

      // Add pricing snapshot fields if pricing details are available (primary member only)
      if (pricingDetails && isPrimaryMember) {
        updateEnrollmentRequest.input('productPricingId', sql.UniqueIdentifier, pricingDetails.productPricingId || null);
        updateEnrollmentRequest.input('netRate', sql.Decimal(19,4), pricingDetails.netRate || 0);
        updateEnrollmentRequest.input('overrideRate', sql.Decimal(19,4), pricingDetails.overrideRate || 0);
        updateEnrollmentRequest.input('commission', sql.Decimal(19,4), pricingDetails.vendorCommission || 0);
        updateEnrollmentRequest.input('systemFees', sql.Decimal(19,4), pricingDetails.systemFees || 0);
      } else {
        // Non-primary members or no pricing details - don't update pricing fields
        updateEnrollmentRequest.input('productPricingId', sql.UniqueIdentifier, null);
        updateEnrollmentRequest.input('netRate', sql.Decimal(19,4), null);
        updateEnrollmentRequest.input('overrideRate', sql.Decimal(19,4), null);
        updateEnrollmentRequest.input('commission', sql.Decimal(19,4), null);
        updateEnrollmentRequest.input('systemFees', sql.Decimal(19,4), null);
      }
      
      // Add GroupID and ProductBundleID if applicable
      let updateFields = [
        'Status = @status',
        'PremiumAmount = @premiumAmount',
        'PolicyNumber = @policyNumber',
        'EnrollmentDetails = @enrollmentDetails',
        'HouseholdId = @householdId',
        'ProductPricingId = @productPricingId',
        'NetRate = @netRate',
        'OverrideRate = @overrideRate',
        'Commission = @commission',
        'SystemFees = @systemFees',
        'ModifiedDate = GETUTCDATE()',
        'ModifiedBy = @modifiedBy'
      ];
      
      if (isGroupEnrollment && enrollmentLink.GroupId) {
        updateFields.push('GroupId = @groupId');
        updateEnrollmentRequest.input('groupId', sql.UniqueIdentifier, enrollmentLink.GroupId);
      }
      
      if (productBundleId) {
        updateFields.push('ProductBundleId = @productBundleId');
        updateEnrollmentRequest.input('productBundleId', sql.UniqueIdentifier, productBundleId);
      }
      
      await updateEnrollmentRequest.query(`
        UPDATE oe.Enrollments 
        SET ${updateFields.join(', ')}
        WHERE EnrollmentId = @enrollmentId
      `);
      
      updatedEnrollments.push({
        enrollmentId: existingEnrollment.EnrollmentId,
        memberId: householdMember.MemberId,
        memberName: `Member ${householdMember.MemberId}`,
        productId,
        premiumAmount,
        action: 'updated',
        previousStatus: existingEnrollment.Status,
        newStatus: 'Active'
      });
      
      console.log(`✅ Updated existing enrollment: ${existingEnrollment.EnrollmentId} to Active status with premium $${premiumAmount}`);
    } else {
      // Enrollment is already active - just log it
      console.log(`ℹ️ Enrollment already active: ${existingEnrollment.EnrollmentId} for product ${productId}`);
    }
    
  } else {
    // Create new enrollment
    const enrollmentId = require('crypto').randomUUID();
    
    // Use the provided effective date, or default to first of next month if not provided
    let enrollmentEffectiveDate;
    if (effectiveDate) {
      // Use the passed effective date from the request
      enrollmentEffectiveDate = new Date(effectiveDate);
      console.log('🔍 DEBUG: Using effective date from parameter:', enrollmentEffectiveDate);
    } else {
      // Fallback to first of next month if no effective date provided
      enrollmentEffectiveDate = new Date();
      enrollmentEffectiveDate.setMonth(enrollmentEffectiveDate.getMonth() + 1);
      enrollmentEffectiveDate.setDate(1); // First day of next month
      console.log('⚠️ WARNING: No effective date provided, defaulting to:', enrollmentEffectiveDate);
    }
    
    // Calculate employer contribution for primary members only
    let contributionId = null;
    let employerContribution = 0;
    
    if (isPrimaryMember && isGroupEnrollment && enrollmentLink.GroupId) {
      try {
        // Get actual member data for contribution calculation
        const memberTier = householdMember?.Tier || member?.Tier || 'EE';
        const memberDateOfBirth = householdMember?.DateOfBirth || member?.DateOfBirth;
        const memberTobaccoUse = householdMember?.TobaccoUse || member?.TobaccoUse || 'N';
        const memberAge = memberDateOfBirth 
          ? Math.floor((new Date() - new Date(memberDateOfBirth)) / (365.25 * 24 * 60 * 60 * 1000))
          : 35;
        const tobaccoUseString = memberTobaccoUse === 'Y' ? 'Yes' : 'No';
        
        console.log(`🔍 DEBUG: Using actual member data for contribution calculation:`, {
          tier: memberTier,
          age: memberAge,
          tobaccoUse: tobaccoUseString,
          memberId: householdMember?.MemberId || member?.MemberId
        });
        
        // Check for product-specific contribution rule (component-level or bundle-level)
        let ruleToCheckProductId = productId;
        
        // If this is a bundle component, also check for bundle-level contribution rules
        if (productBundleId) {
          ruleToCheckProductId = productBundleId;
          console.log(`🔍 Checking for bundle-level contribution rule for bundle ${productBundleId} (component: ${productId})`);
        }
        
        // Calculate employer contribution amount using ContributionCalculator with actual member data
        const ContributionCalculator = require('../services/pricing/ContributionCalculator');
        const memberJobPosition = member.JobPosition || undefined;
        
        // Check if this is a bundle component
        const isBundleRule = productBundleId && productBundleId === ruleToCheckProductId;
        
        if (isBundleRule) {
          // For bundle rules, calculate contribution first, then find the rule that was applied
          // Use bundle total premium if provided, otherwise calculate from enrollments
          const totalBundlePremium = bundleTotalPremium || (() => {
            const bundleComponentEnrollments = createdEnrollments.filter(e => e.productBundleId === productBundleId);
            return bundleComponentEnrollments.reduce((sum, e) => sum + (e.premiumAmount || 0), 0) + premiumAmount;
          })();
          
          console.log(`📊 Bundle contribution calculation: Total bundle premium = $${totalBundlePremium.toFixed(2)}, This component = $${premiumAmount.toFixed(2)}`);
          
          // Calculate contribution for the entire bundle using the bundle product ID
          const bundleContributionCalcResult = await ContributionCalculator.calculateContributions({
            groupId: enrollmentLink.GroupId,
            productPricingResults: [{
              productId: productBundleId,
              productName: `Bundle ${productBundleId.substring(0, 8)}`, // Bundle name if available
              monthlyPremium: totalBundlePremium,
              productType: '',
              isBundle: true
            }],
            memberCriteria: {
              age: memberAge,
              tobaccoUse: tobaccoUseString,
              tier: memberTier,
              jobPosition: memberJobPosition
            }
          });
          
          const bundleContribution = bundleContributionCalcResult.productContributions[productBundleId];
          if (bundleContribution && bundleContribution.productSpecific > 0) {
            // Now find which rule was actually applied by querying all bundle-level rules and matching
            // Include rules where ProductId IS NULL (group-level rules that apply to any product/bundle)
            const allBundleRulesQuery = `
              SELECT gc.ContributionId, gc.Name, gc.AgeRules, gc.JobPositions, gc.ContributionType, gc.FlatRateAmount, gc.PercentageAmount
              FROM oe.GroupContributions gc
              WHERE gc.GroupId = @groupId
                AND (gc.ProductId = @productId OR gc.ProductId IS NULL)
                AND gc.Status = 'Active'
                AND gc.EffectiveDate <= @effectiveDate
                AND (gc.EndDate IS NULL OR gc.EndDate >= @effectiveDate)
              ORDER BY gc.Priority ASC
            `;

            const allRulesRequest = transaction.request();
            allRulesRequest.input('groupId', sql.UniqueIdentifier, enrollmentLink.GroupId);
            allRulesRequest.input('productId', sql.UniqueIdentifier, productBundleId);
            allRulesRequest.input('effectiveDate', sql.Date, enrollmentEffectiveDate);
            
            const allRulesResult = await allRulesRequest.query(allBundleRulesQuery);
            
            // Find the rule that matches the calculated contribution amount and member criteria
            let appliedRuleId = null;
            for (const rule of allRulesResult.recordset) {
              // Check if this rule applies to the member
              let ruleApplies = true;
              
              // Check job position
              if (rule.JobPositions) {
                try {
                  const jobPositions = typeof rule.JobPositions === 'string' ? JSON.parse(rule.JobPositions) : rule.JobPositions;
                  if (Array.isArray(jobPositions) && jobPositions.length > 0) {
                    if (!jobPositions.includes(memberJobPosition)) {
                      ruleApplies = false;
                    }
                  }
                } catch (e) {
                  console.warn(`Error parsing JobPositions for rule ${rule.ContributionId}:`, e);
                }
              }
              
              // Check age rules
              if (ruleApplies && rule.AgeRules) {
                try {
                  const ageRules = typeof rule.AgeRules === 'string' ? JSON.parse(rule.AgeRules) : rule.AgeRules;
                  if (Array.isArray(ageRules) && ageRules.length > 0) {
                    let ageMatches = false;
                    for (const ageRule of ageRules) {
                      const minAge = ageRule.minAge || 0;
                      const maxAge = ageRule.maxAge !== null && ageRule.maxAge !== undefined ? ageRule.maxAge : 999;
                      if (memberAge >= minAge && (maxAge === null || memberAge <= maxAge)) {
                        ageMatches = true;
                        break;
                      }
                    }
                    if (!ageMatches) {
                      ruleApplies = false;
                    }
                  }
                } catch (e) {
                  console.warn(`Error parsing AgeRules for rule ${rule.ContributionId}:`, e);
                }
              }
              
              // If rule applies, check if it would produce the calculated contribution amount
              if (ruleApplies) {
                let expectedContribution = 0;
                if (rule.ContributionType === 'flat_rate' && rule.FlatRateAmount) {
                  expectedContribution = Number(rule.FlatRateAmount);
                } else if (rule.ContributionType === 'percentage' && rule.PercentageAmount) {
                  expectedContribution = totalBundlePremium * (Number(rule.PercentageAmount) / 100);
                } else if (rule.ContributionType === 'age_based' && rule.AgeRules) {
                  try {
                    const ageRules = typeof rule.AgeRules === 'string' ? JSON.parse(rule.AgeRules) : rule.AgeRules;
                    for (const ageRule of ageRules) {
                      const minAge = ageRule.minAge || 0;
                      const maxAge = ageRule.maxAge !== null && ageRule.maxAge !== undefined ? ageRule.maxAge : 999;
                      if (memberAge >= minAge && (maxAge === null || memberAge <= maxAge)) {
                        if (ageRule.contributionType === 'flat') {
                          expectedContribution = Number(ageRule.contributionAmount);
                        } else if (ageRule.contributionType === 'percentage') {
                          expectedContribution = totalBundlePremium * (Number(ageRule.contributionAmount) / 100);
                        }
                        break;
                      }
                    }
                  } catch (e) {
                    console.warn(`Error calculating expected contribution from AgeRules:`, e);
                  }
                }
                
                // Check if this rule's expected contribution matches what was calculated (within 1 cent tolerance)
                if (Math.abs(expectedContribution - bundleContribution.productSpecific) < 0.01) {
                  appliedRuleId = rule.ContributionId;
                  console.log(`✅ Matched bundle rule "${rule.Name}" (${rule.ContributionId}) - expected: $${expectedContribution.toFixed(2)}, calculated: $${bundleContribution.productSpecific.toFixed(2)}`);
                  break;
                }
              }
            }
            
            if (appliedRuleId) {
              contributionId = appliedRuleId;
            } else {
              // Fallback: use first rule found (include group-level rules where ProductId IS NULL)
              const firstRuleQuery = `
                SELECT TOP 1 gc.ContributionId
                FROM oe.GroupContributions gc
                WHERE gc.GroupId = @groupId
                  AND (gc.ProductId = @productId OR gc.ProductId IS NULL)
                  AND gc.Status = 'Active'
                  AND gc.EffectiveDate <= @effectiveDate
                  AND (gc.EndDate IS NULL OR gc.EndDate >= @effectiveDate)
                ORDER BY gc.Priority ASC
              `;
              const firstRuleRequest = transaction.request();
              firstRuleRequest.input('groupId', sql.UniqueIdentifier, enrollmentLink.GroupId);
              firstRuleRequest.input('productId', sql.UniqueIdentifier, productBundleId);
              firstRuleRequest.input('effectiveDate', sql.Date, enrollmentEffectiveDate);
              const firstRuleResult = await firstRuleRequest.query(firstRuleQuery);
              if (firstRuleResult.recordset.length > 0) {
                contributionId = firstRuleResult.recordset[0].ContributionId;
              }
              console.log(`⚠️ Could not match applied rule, using first rule found: ${contributionId}`);
            }
            
            // Apply bundle contribution proportionally to this component
            const componentShare = totalBundlePremium > 0 ? premiumAmount / totalBundlePremium : 0;
            employerContribution = bundleContribution.productSpecific * componentShare;
            console.log(`💰 Bundle-level employer contribution: $${bundleContribution.productSpecific.toFixed(2)} total, This component's share: $${employerContribution.toFixed(2)} (${(componentShare * 100).toFixed(1)}%)`);
          } else {
            console.log(`ℹ️ Bundle-level contribution calculated but result is 0 or missing`);
          }
        } else {
          // Regular product-specific contribution - use existing query logic
          const contributionQuery = `
            SELECT TOP 1 gc.ContributionId
            FROM oe.GroupContributions gc
            WHERE gc.GroupId = @groupId
              AND gc.ProductId = @productId
              AND gc.Status = 'Active'
              AND gc.EffectiveDate <= @effectiveDate
              AND (gc.EndDate IS NULL OR gc.EndDate >= @effectiveDate)
            ORDER BY gc.Priority ASC
          `;

          const contributionRequest = transaction.request();
          contributionRequest.input('groupId', sql.UniqueIdentifier, enrollmentLink.GroupId);
          contributionRequest.input('productId', sql.UniqueIdentifier, ruleToCheckProductId);
          contributionRequest.input('effectiveDate', sql.Date, enrollmentEffectiveDate);

          const contributionResult = await contributionRequest.query(contributionQuery);

          if (contributionResult.recordset.length > 0) {
            contributionId = contributionResult.recordset[0].ContributionId;
            console.log(`✅ Found product-specific contribution rule: ${contributionId} for product ${productId}`);
            
            // Regular product-specific contribution
            const contributionCalcResult = await ContributionCalculator.calculateContributions({
              groupId: enrollmentLink.GroupId,
              productPricingResults: [{
                productId: productId,
                productName: productName,
                monthlyPremium: premiumAmount,
                productType: '',
                isBundle: false
              }],
              memberCriteria: {
                age: memberAge,
                tobaccoUse: tobaccoUseString,
                tier: memberTier,
                jobPosition: memberJobPosition
              }
            });
            
            const productContribution = contributionCalcResult.productContributions[productId];
            if (productContribution) {
              employerContribution = productContribution.productSpecific || 0;
              console.log(`💰 Employer contribution for ${productName}: $${employerContribution.toFixed(2)} (tier: ${memberTier})`);
            }
          } else {
            // No product-specific contribution rule found - all-products contributions will be handled separately
            console.log(`ℹ️ No product-specific contribution rule found for product ${productId}`);
          }
        }
        
        // If no contribution was found/calculated, log it
        if (!contributionId && employerContribution === 0) {
          console.log(`ℹ️ No ${productBundleId ? 'bundle-level' : 'product-specific'} contribution rule found or applied for ${productBundleId ? `bundle ${productBundleId}` : `product ${productId}`} - all-products contributions will be handled separately`);
        }
      } catch (error) {
        console.error('❌ Error calculating contribution:', error);
        console.error('❌ Error stack:', error.stack);
        // Continue without contribution if calculation fails
      }
    }
    
    // Determine which AgentId to use for the enrollment
    // Priority: 1) Member's existing AgentId, 2) Link's AgentId, 3) Link's AgencyId (for agency enrollments)
    // Note: Enrollments.AgentId is a single field, so we use AgencyId if no AgentId exists
    const enrollmentAgentId = householdMember.AgentId || enrollmentLink.AgentId || enrollmentLink.AgencyId || null;
    
    console.log(`🔍 DEBUG: Determining AgentId for enrollment:`, {
      memberAgentId: householdMember.AgentId,
      linkAgentId: enrollmentLink.AgentId,
      linkAgencyId: enrollmentLink.AgencyId,
      finalAgentId: enrollmentAgentId,
      source: householdMember.AgentId ? 'member' : enrollmentLink.AgentId ? 'link-agent' : enrollmentLink.AgencyId ? 'link-agency' : 'none'
    });
    
    // If member doesn't have an AgentId but the link does, update the member
    if (!householdMember.AgentId && (enrollmentLink.AgentId || enrollmentLink.AgencyId)) {
      const updateMemberAgentRequest = transaction.request();
      updateMemberAgentRequest.input('memberId', sql.UniqueIdentifier, householdMember.MemberId);
      updateMemberAgentRequest.input('agentId', sql.UniqueIdentifier, enrollmentAgentId);
      
      await updateMemberAgentRequest.query(`
        UPDATE oe.Members
        SET AgentId = @agentId, ModifiedDate = GETUTCDATE()
        WHERE MemberId = @memberId
      `);
      
      console.log(`✅ Updated member ${householdMember.MemberId} with AgentId from enrollment link: ${enrollmentAgentId}`);
    }
    
    console.log('🔍 DEBUG: About to create enrollment with effectiveDate:', enrollmentEffectiveDate, 'Type:', typeof enrollmentEffectiveDate);
    
    // Note: Setup fees are now handled separately as their own enrollment records with EnrollmentType = 'SetupFee'
    // They are created in createFeeEnrollmentRecords() and are not stored on product enrollment records
    
    const createEnrollmentRequest = transaction.request();
    createEnrollmentRequest.input('enrollmentId', sql.UniqueIdentifier, enrollmentId);
    createEnrollmentRequest.input('memberId', sql.UniqueIdentifier, householdMember.MemberId);
    createEnrollmentRequest.input('productId', sql.UniqueIdentifier, productId);
    createEnrollmentRequest.input('agentId', sql.UniqueIdentifier, enrollmentAgentId);
    createEnrollmentRequest.input('policyNumber', sql.NVarChar, vendorProductId);
    createEnrollmentRequest.input('effectiveDate', sql.Date, enrollmentEffectiveDate);
    createEnrollmentRequest.input('premiumAmount', sql.Decimal(19,4), premiumAmount);
    createEnrollmentRequest.input('paymentFrequency', sql.NVarChar, 'Monthly');
    
    // Store configuration in enrollment details as JSON (matching EnrollmentCompletionService format)
    const enrollmentDetailsObj = {
      configuration: configValue || 'Default',
      enrollmentType: 'enrollment_link',
      linkToken: linkToken,
      timestamp: new Date().toISOString(),
      ...(questionnaireResponses ? { questionnaireResponses } : {})
    };
    createEnrollmentRequest.input('enrollmentDetails', sql.NVarChar, JSON.stringify(enrollmentDetailsObj));
    createEnrollmentRequest.input('createdBy', sql.UniqueIdentifier, member.UserId);
    createEnrollmentRequest.input('employerContribution', sql.Decimal(19,4), employerContribution);
    createEnrollmentRequest.input('contributionId', sql.UniqueIdentifier, contributionId);
    
    // Add HouseholdId (use from householdMember or member)
    const enrollmentHouseholdId = householdMember.HouseholdId || member.HouseholdId || null;
    createEnrollmentRequest.input('householdId', sql.UniqueIdentifier, enrollmentHouseholdId);

    // Add pricing snapshot fields if pricing details are available (primary member only)
    console.log('📋 DEBUG: creating enrollment with pricing details:', {
      hasPricingDetails: !!pricingDetails,
      isPrimaryMember,
      pricingDetails: pricingDetails ? {
        productPricingId: pricingDetails.productPricingId,
        netRate: pricingDetails.netRate,
        overrideRate: pricingDetails.overrideRate,
        vendorCommission: pricingDetails.vendorCommission,
        systemFees: pricingDetails.systemFees
      } : null
    });
    
    // Set EnrollmentType - default to 'Product' for regular enrollments
    // This will be overridden for special enrollment types (SystemFee, PaymentProcessingFee, Contribution)
    createEnrollmentRequest.input('enrollmentType', sql.NVarChar, 'Product');
    
    if (pricingDetails && isPrimaryMember) {
      createEnrollmentRequest.input('productPricingId', sql.UniqueIdentifier, pricingDetails.productPricingId || null);
      createEnrollmentRequest.input('netRate', sql.Decimal(19,4), pricingDetails.netRate || 0);
      createEnrollmentRequest.input('overrideRate', sql.Decimal(19,4), pricingDetails.overrideRate || 0);
      createEnrollmentRequest.input('commission', sql.Decimal(19,4), pricingDetails.vendorCommission || 0);
      // Note: SystemFees field is deprecated - will be removed, set to 0 for now
      createEnrollmentRequest.input('systemFees', sql.Decimal(19,4), 0);
      console.log('✅ DEBUG: Set pricing fields from pricingDetails for primary member');
    } else {
      // Non-primary members or no pricing details - set to 0/NULL
      createEnrollmentRequest.input('productPricingId', sql.UniqueIdentifier, null);
      createEnrollmentRequest.input('netRate', sql.Decimal(19,4), 0);
      createEnrollmentRequest.input('overrideRate', sql.Decimal(19,4), 0);
      createEnrollmentRequest.input('commission', sql.Decimal(19,4), 0);
      // Note: SystemFees field is deprecated - will be removed, set to 0 for now
      createEnrollmentRequest.input('systemFees', sql.Decimal(19,4), 0);
      console.log('⚠️ DEBUG: Set pricing fields to 0/NULL because:', {
        hasPricingDetails: !!pricingDetails,
        isPrimaryMember
      });
    }
    
    // Note: SetupFee and SetupFeePaid are no longer stored on product enrollment records
    // Setup fees are now separate enrollment records with EnrollmentType = 'SetupFee'
    
    // Add GroupID, ProductBundleID, EmployerContributionAmount, and ContributionId
    // Note: EnrollmentType defaults to 'Product' for regular enrollments
    await EnrollmentWriter.insertProductEnrollmentRow({
      poolOrTransaction: transaction,
      enrollmentId,
      memberId: householdMember.MemberId,
      productId,
      agentId: enrollmentAgentId,
      policyNumber: vendorProductId,
      effectiveDate: enrollmentEffectiveDate,
      premiumAmount,
      enrollmentDetails: enrollmentDetailsObj,
      householdId: enrollmentHouseholdId,
      groupId: isGroupEnrollment && enrollmentLink.GroupId ? enrollmentLink.GroupId : null,
      productBundleId: productBundleId || null,
      enrollmentType: 'Product',
      paymentFrequency: 'Monthly',
      employerContributionAmount: employerContribution,
      contributionId,
      productPricingId: pricingDetails && isPrimaryMember ? pricingDetails.productPricingId || null : null,
      netRate: pricingDetails && isPrimaryMember ? pricingDetails.netRate || 0 : 0,
      overrideRate: pricingDetails && isPrimaryMember ? pricingDetails.overrideRate || 0 : 0,
      commission: pricingDetails && isPrimaryMember ? pricingDetails.vendorCommission || 0 : 0,
      createdBy: member.UserId,
      modifiedBy: member.UserId,
      status: enrollmentRowStatus
    });
    
    createdEnrollments.push({
      enrollmentId,
      memberId: householdMember.MemberId,
      memberName: `Member ${householdMember.MemberId}`,
      productId,
      productName,
      premiumAmount,
      effectiveDate: enrollmentEffectiveDate.toISOString().split('T')[0],
      productBundleId: productBundleId || null,
      action: 'created'
    });
    
    console.log(`✅ Created new enrollment: ${enrollmentId} for ${householdMember.RelationshipType} member ${householdMember.FirstName} ${householdMember.LastName} with premium $${premiumAmount}`);
  }
}


// Helper function to get household ID for a member
async function getHouseholdIdForMember(memberId, transaction = null) {
  try {
    const query = `
      SELECT HouseholdId 
      FROM oe.Members 
      WHERE MemberId = @memberId
    `;
    
    const request = transaction ? transaction.request() : (await getPool()).request();
    request.input('memberId', sql.UniqueIdentifier, memberId);
    const result = await request.query(query);
    
    if (result.recordset.length === 0) {
      throw new Error('Member not found');
    }
    
    return {
      success: true,
      householdId: result.recordset[0].HouseholdId
    };
  } catch (error) {
    console.error('❌ Error getting household ID:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

// Helper function to update member's signed agreements
async function updateMemberSignedAgreements(memberId, pdfUrl, timestamp, transaction = null) {
    try {
        console.log('🔍 DEBUG: Starting updateMemberSignedAgreements for member:', memberId);
        
        // Use provided transaction or create new connection
        let pool;
        if (transaction) {
            pool = transaction;
            console.log('🔍 DEBUG: Using provided transaction');
        } else {
            pool = await getPool();
            console.log('🔍 DEBUG: Database pool obtained, connected:', pool.connected);
        }
        
        // Use a single query with MERGE to handle both insert and update cases
        // This is much more efficient than multiple separate queries
        const request = pool.request();
        request.input('memberId', sql.UniqueIdentifier, memberId);
        request.input('pdfUrl', sql.NVarChar, pdfUrl);
        request.input('timestamp', sql.NVarChar, timestamp);
        request.input('newAgreement', sql.NVarChar, JSON.stringify({
            url: pdfUrl,
            timestamp: timestamp,
            generatedDate: new Date().toISOString(),
            type: 'enrollment_agreements'
        }));
        
        // First, ensure the SignedAgreements column exists (only check once per session and not in transaction)
        if (!global.signedAgreementsColumnExists && !transaction) {
            try {
                const checkResult = await pool.request().query(`
                    SELECT COLUMN_NAME 
                    FROM INFORMATION_SCHEMA.COLUMNS 
                    WHERE TABLE_NAME = 'Members' 
                    AND COLUMN_NAME = 'SignedAgreements'
                `);
                
                if (checkResult.recordset.length === 0) {
                    console.log('🔧 Adding SignedAgreements field to Members table');
                    await pool.request().query(`
                        ALTER TABLE oe.Members 
                        ADD SignedAgreements NVARCHAR(MAX)
                    `);
                }
                global.signedAgreementsColumnExists = true;
            } catch (error) {
                console.warn('⚠️ Could not check/add SignedAgreements column:', error.message);
                // Continue anyway - the column might already exist
            }
        }
        
        // Get existing agreements first
        console.log('🔍 DEBUG: Getting existing agreements for member:', memberId);
        const existingResult = await request.query(`
            SELECT ISNULL(SignedAgreements, '[]') as SignedAgreements
            FROM oe.Members 
            WHERE MemberId = @memberId
        `);
        console.log('🔍 DEBUG: Retrieved existing agreements, count:', existingResult.recordset.length);
        
        let existingAgreements = [];
        if (existingResult.recordset.length > 0 && existingResult.recordset[0].SignedAgreements) {
            try {
                existingAgreements = JSON.parse(existingResult.recordset[0].SignedAgreements);
            } catch (error) {
                console.warn('⚠️ Failed to parse existing SignedAgreements, starting fresh');
                existingAgreements = [];
            }
        }
        
        // Add new agreement
        const newAgreement = {
            url: pdfUrl,
            timestamp: timestamp,
            generatedDate: new Date().toISOString(),
            type: 'enrollment_agreements'
        };
        
        existingAgreements.push(newAgreement);
        
        // Update the record with the new agreements array
        console.log('🔍 DEBUG: Updating member record with new agreements');
        const updateRequest = pool.request();
        updateRequest.input('memberId', sql.UniqueIdentifier, memberId);
        updateRequest.input('signedAgreements', sql.NVarChar, JSON.stringify(existingAgreements));
        
        await updateRequest.query(`
            UPDATE oe.Members 
            SET SignedAgreements = @signedAgreements,
                ModifiedDate = GETUTCDATE()
            WHERE MemberId = @memberId
        `);
        console.log('🔍 DEBUG: Member record updated successfully');
        
        console.log('✅ Member signed agreements updated successfully');
        
    } catch (error) {
        console.error('❌ Error updating member signed agreements:', error);
        throw error;
    }
}

// Helper function to get enrollment link by token
async function getEnrollmentLinkByToken(linkToken) {
    try {
        console.log('🔍 getEnrollmentLinkByToken called with token:', linkToken);
        
        const pool = await getPool();
        console.log('✅ Database pool acquired');
        
        const request = pool.request();
        request.input('linkToken', sql.NVarChar, linkToken);
        
        console.log('🔍 Executing query for link token:', linkToken);
        const result = await request.query(`
            SELECT LinkId, GroupId, LinkToken, MemberId, IsActive, ExpiresAt, UsageCount, MaxUsage
            FROM oe.EnrollmentLinks
            WHERE LinkToken = @linkToken
        `);
        
        console.log('🔍 Query result:', { recordCount: result.recordset.length });
        
        if (result.recordset.length === 0) {
            console.log('❌ No enrollment link found for token:', linkToken);
            return null;
        }
        
        console.log('✅ Enrollment link found:', { 
            linkId: result.recordset[0].LinkId,
            memberId: result.recordset[0].MemberId,
            isActive: result.recordset[0].IsActive
        });
        
        return result.recordset[0];
    } catch (error) {
        console.error('❌ Error getting enrollment link by token:', error);
        throw error;
    }
}

// Helper function to get member by ID
async function getMemberById(memberId) {
    try {
        const pool = await getPool();
        const request = pool.request();
        request.input('memberId', sql.UniqueIdentifier, memberId);
        
        const result = await request.query(`
            SELECT 
                m.MemberId, 
                m.UserId, 
                m.DateOfBirth, 
                m.Gender, 
                m.Address, 
                m.City, 
                m.State, 
                m.Zip, 
                m.TobaccoUse,
                u.FirstName, 
                u.LastName, 
                u.Email, 
                u.PhoneNumber
            FROM oe.Members m
            JOIN oe.Users u ON m.UserId = u.UserId
            WHERE m.MemberId = @memberId
        `);
        
        if (result.recordset.length === 0) {
            return null;
        }
        
        return result.recordset[0];
    } catch (error) {
        console.error('❌ Error getting member by ID:', error);
        throw error;
    }
}

// Helper function to save acknowledgements
async function saveAcknowledgements(memberId, acknowledgements, digitalSignature, ipAddress, userAgent) {
    try {
        const pool = await getPool();
        
        // For now, just return a success object
        // In a full implementation, you'd save to a database table
        console.log('📝 Saving acknowledgements for member:', memberId);
        
        return {
            id: 'temp-' + Date.now(),
            memberId: memberId,
            timestamp: new Date().toISOString()
        };
    } catch (error) {
        console.error('❌ Error saving acknowledgements:', error);
        throw error;
    }
}

// GET /api/enrollment-links/:linkToken - Get enrollment link details by token
// IMPORTANT: This generic route must be LAST to avoid intercepting specific routes
// PUBLIC ENDPOINT - No authentication required
router.get('/:linkToken', async (req, res) => {
  try {
    const { linkToken } = req.params;
    
    console.log('🔍 GET /api/enrollment-links/:linkToken - Requested token:', linkToken);
    console.log('🔍 GET /api/enrollment-links/:linkToken - Public endpoint (no auth required), user:', req.user ? 'authenticated' : 'not authenticated');
    
    if (!linkToken) {
      console.error('❌ GET /api/enrollment-links/:linkToken - Link token is required');
      return res.status(400).json({
        success: false,
        message: 'Link token is required'
      });
    }

    const pool = await getPool();
    
    // Query to get enrollment link with group and template information
    const query = `
      SELECT 
        el.LinkId,
        el.GroupId,
        el.LinkToken,
        el.LinkUrl,
        el.LinkType,
        el.ShortCode,
        el.Description,
        el.ExpiresAt,
        el.IsActive,
        el.UsageCount,
        el.MaxUsage,
        el.AllowedProducts,
        el.CreatedDate,
        el.ModifiedDate,
        el.CreatedBy,
        el.ModifiedBy,
        el.EnrollmentLinkTemplateId,
        g.Name AS GroupName,
        elt.TemplateName,
        elt.TemplateType
      FROM oe.EnrollmentLinks el
      LEFT JOIN oe.Groups g ON el.GroupId = g.GroupId
      LEFT JOIN oe.EnrollmentLinkTemplates elt ON el.EnrollmentLinkTemplateId = elt.TemplateId
      WHERE el.LinkToken = @linkToken
    `;
    
    const request = pool.request();
    request.input('linkToken', sql.NVarChar, linkToken);
    
    console.log('🔍 GET /api/enrollment-links/:linkToken - Executing database query for token:', linkToken);
    const result = await request.query(query);
    
    console.log('🔍 GET /api/enrollment-links/:linkToken - Query result count:', result.recordset.length);
    
    if (result.recordset.length === 0) {
      console.error('❌ GET /api/enrollment-links/:linkToken - Enrollment link not found for token:', linkToken);
      return res.status(404).json({
        success: false,
        message: 'Enrollment link not found'
      });
    }
    
    const enrollmentLink = result.recordset[0];
    
    // Log the IsActive status for debugging
    console.log('🔍 GET /api/enrollment-links/:linkToken - Link IsActive status:', enrollmentLink.IsActive, 'Type:', typeof enrollmentLink.IsActive);
    
    // Check if link is active
    // Handle both boolean and bit types from database
    const isActive = enrollmentLink.IsActive === true || enrollmentLink.IsActive === 1 || enrollmentLink.IsActive === '1';
    
    if (!isActive) {
      console.log('⚠️ GET /api/enrollment-links/:linkToken - Link is inactive');
      return res.status(200).json({
        success: true,
        data: enrollmentLink,
        message: 'Enrollment link is inactive'
      });
    }
    
    // Check if link has expired
    if (enrollmentLink.ExpiresAt && new Date(enrollmentLink.ExpiresAt) < new Date()) {
      console.log('⚠️ GET /api/enrollment-links/:linkToken - Link has expired');
      return res.status(200).json({
        success: true,
        data: enrollmentLink,
        message: 'Enrollment link has expired'
      });
    }
    
    // Check usage limits
    if (enrollmentLink.MaxUsage && enrollmentLink.UsageCount >= enrollmentLink.MaxUsage) {
      console.log('⚠️ GET /api/enrollment-links/:linkToken - Link usage limit reached');
      return res.status(200).json({
        success: true,
        data: enrollmentLink,
        message: 'Enrollment link usage limit reached'
      });
    }
    
    console.log('✅ GET /api/enrollment-links/:linkToken - Link is valid and active');
    res.json({
      success: true,
      data: enrollmentLink,
      message: 'Enrollment link found'
    });
    
  } catch (error) {
    console.error('❌ Error fetching enrollment link:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching enrollment link'
    });
  }
});

// POST /api/enrollment-links/:linkToken/submit-acknowledgements - Submit acknowledgements only (no pricing validation or payment processing)
router.post('/:linkToken/submit-acknowledgements', async (req, res) => {
  console.log('🔍 DEBUG: Submit acknowledgements route hit for linkToken:', req.params.linkToken);
  
  try {
    const { linkToken } = req.params;
    const { 
      memberId: providedMemberId,
      acknowledgements,
      digitalSignature,
      ipAddress,
      userAgent
    } = req.body;

    console.log('🔍 DEBUG: Request body keys:', Object.keys(req.body));
    console.log('🔍 DEBUG: Provided memberId:', providedMemberId);
    console.log('🔍 DEBUG: Acknowledgements count:', acknowledgements?.length);
    console.log('🔍 DEBUG: Has digitalSignature:', !!digitalSignature);

    if (!linkToken) {
      return res.status(400).json({
        success: false,
        message: 'Link token is required'
      });
    }

    if (!acknowledgements || !Array.isArray(acknowledgements)) {
      return res.status(400).json({
        success: false,
        message: 'Acknowledgements data is required'
      });
    }

    if (!digitalSignature || digitalSignature.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'Digital signature is required'
      });
    }

    console.log('🔍 DEBUG: Validation passed, getting database pool...');
    const pool = await getPool();
    console.log('🔍 DEBUG: Creating transaction...');
    const transaction = pool.transaction();
    
    try {
      await transaction.begin();
      
      // 1. Verify enrollment link exists and get member info
      const linkQuery = `
        SELECT 
          el.LinkId,
          el.MemberId,
          el.GroupId,
          el.LinkType,
          el.AgentId,
          COALESCE(m.TenantId, a.TenantId) as TenantId,
          m.UserId,
          u.FirstName,
          u.LastName,
          u.Email
        FROM oe.EnrollmentLinks el
        LEFT JOIN oe.Members m ON el.MemberId = m.MemberId
        LEFT JOIN oe.Users u ON m.UserId = u.UserId
        LEFT JOIN oe.Agents a ON el.AgentId = a.AgentId
        WHERE el.LinkToken = @linkToken AND el.IsActive = 1
      `;
      
      const linkRequest = transaction.request();
      linkRequest.input('linkToken', sql.NVarChar, linkToken);
      const linkResult = await linkRequest.query(linkQuery);
      
      if (linkResult.recordset.length === 0) {
        await transaction.rollback();
        return res.status(404).json({
          success: false,
          message: 'Enrollment link not found or inactive'
        });
      }
      
      const linkData = linkResult.recordset[0];
      let memberId = providedMemberId || linkData.MemberId; // Use provided memberId if available
      let userId = linkData.UserId;
      let firstName = linkData.FirstName;
      let lastName = linkData.LastName;
      let email = linkData.Email;
      const linkType = linkData.LinkType;
      const tenantId = linkData.TenantId;
      
      console.log('🔍 DEBUG: Using memberId:', providedMemberId ? 'from request body' : 'from enrollment link', memberId);
      
      // If memberId was provided, we need to fetch the member's user info
      if (providedMemberId && (!userId || !firstName || !lastName || !email)) {
        console.log('🔍 Fetching member info for provided memberId:', providedMemberId);
        
        const memberInfoQuery = `
          SELECT m.MemberId, m.UserId, u.FirstName, u.LastName, u.Email
          FROM oe.Members m
          INNER JOIN oe.Users u ON m.UserId = u.UserId
          WHERE m.MemberId = @memberId
        `;
        
        const memberInfoRequest = transaction.request();
        memberInfoRequest.input('memberId', sql.UniqueIdentifier, providedMemberId);
        const memberInfoResult = await memberInfoRequest.query(memberInfoQuery);
        
        if (memberInfoResult.recordset.length > 0) {
          const memberInfo = memberInfoResult.recordset[0];
          userId = memberInfo.UserId;
          firstName = memberInfo.FirstName;
          lastName = memberInfo.LastName;
          email = memberInfo.Email;
          console.log('✅ Fetched member info:', { firstName, lastName, email });
        }
      }
      
      // For Agent-Static/Marketing links without a provided memberId, find the member with recent pending enrollments
      if ((linkType === 'Agent-Static' || linkType === 'Marketing') && !memberId) {
        console.log(`🔍 ${linkType} link - looking up member with recent pending enrollments`);
        
        // Find member who has enrollments created in the last 5 minutes with Pending Payment status
        const recentMemberQuery = `
          SELECT TOP 1 m.MemberId, m.UserId, u.FirstName, u.LastName, u.Email
          FROM oe.Members m
          INNER JOIN oe.Users u ON m.UserId = u.UserId
          INNER JOIN oe.Enrollments e ON m.MemberId = e.MemberId
          WHERE m.TenantId = @tenantId
            AND e.Status = 'Pending Payment'
            AND e.CreatedDate >= DATEADD(MINUTE, -5, GETUTCDATE())
          ORDER BY m.CreatedDate DESC
        `;
        
        const recentMemberRequest = transaction.request();
        recentMemberRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
        const recentMemberResult = await recentMemberRequest.query(recentMemberQuery);
        
        if (recentMemberResult.recordset.length === 0) {
          await transaction.rollback();
          return res.status(400).json({
            success: false,
            message: 'No member found for this enrollment. Please try again or contact support.'
          });
        }
        
        const recentMember = recentMemberResult.recordset[0];
        memberId = recentMember.MemberId;
        userId = recentMember.UserId;
        firstName = recentMember.FirstName;
        lastName = recentMember.LastName;
        email = recentMember.Email;
        
        console.log('✅ Found recent member for acknowledgements:', { memberId, firstName, lastName });
      }
      
      if (!memberId) {
        await transaction.rollback();
        return res.status(400).json({
          success: false,
          message: 'No member associated with this enrollment link'
        });
      }

      console.log('🔍 DEBUG: Processing acknowledgements for member:', { memberId, firstName, lastName, email });

      // 2. Generate PDF from acknowledgements and digital signature
      const pdfGenerator = require('../utils/pdfGenerator');
      const pdfBuffer = await pdfGenerator.generateAgreementsPDF(
        acknowledgements,
        digitalSignature,
        {
          firstName,
          lastName,
          email,
          phone: '',
          dateOfBirth: '',
          address: '',
          city: '',
          state: '',
          zip: ''
        },
        [] // productSelections - empty for acknowledgements only
      );

      // 3. Upload PDF to Azure Blob Storage
      const { BlobServiceClient } = require('@azure/storage-blob');
      const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
      
      if (!connectionString) {
        throw new Error('Azure Storage connection string not configured');
      }
      
      const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
      const containerName = 'enrollment-documents';
      const fileName = `acknowledgements-${memberId}-${Date.now()}.pdf`;
      const containerClient = blobServiceClient.getContainerClient(containerName);
      
      // Create container if it doesn't exist
      try {
        await containerClient.createIfNotExists();
        console.log('✅ Container created or already exists:', containerName);
      } catch (error) {
        console.log('⚠️ Container creation warning:', error.message);
      }
      
      const blockBlobClient = containerClient.getBlockBlobClient(fileName);
      
      // Upload the PDF buffer with metadata
      await blockBlobClient.upload(pdfBuffer, pdfBuffer.length, {
        metadata: {
          originalName: `acknowledgements-${memberId}-${Date.now()}.pdf`,
          uploadedBy: 'allaboard365-system'
        }
      });
      console.log('✅ PDF uploaded to Azure:', fileName);

      // Extract account name from connection string
      const accountNameMatch = connectionString.match(/AccountName=([^;]+)/);
      const storageAccountName = accountNameMatch ? accountNameMatch[1] : process.env.AZURE_STORAGE_ACCOUNT_NAME || 'oestorage';
      
      const pdfUrl = `https://${storageAccountName}.blob.core.windows.net/${containerName}/${fileName}`;

      // 4. Save PDF to FileUploads table
      const fileUploadQuery = `
        INSERT INTO oe.FileUploads (
          FileId, EntityId, FileName, StoredFileName, FilePath, 
          FileSize, MimeType, UploadType, UploadedBy, TenantId, Status, CreatedDate, ModifiedDate
        ) 
        OUTPUT INSERTED.FileId
        VALUES (
          NEWID(), @memberId, @fileName, @fileName, @fileUrl,
          @fileSize, 'application/pdf', 'member', @userId, @tenantId, 'Active', @createdDate, @modifiedDate
        )
      `;
      
      const fileUploadRequest = transaction.request();
      fileUploadRequest.input('memberId', sql.UniqueIdentifier, memberId);
      fileUploadRequest.input('userId', sql.UniqueIdentifier, userId);
      fileUploadRequest.input('fileName', sql.NVarChar, fileName);
      fileUploadRequest.input('fileUrl', sql.NVarChar, pdfUrl);
      fileUploadRequest.input('fileSize', sql.Int, pdfBuffer.length);
      fileUploadRequest.input('tenantId', sql.UniqueIdentifier, '1CD92AF7-B6F2-4E48-A8F3-EC6316158826'); // Default tenant ID
      fileUploadRequest.input('createdDate', sql.DateTime2, new Date());
      fileUploadRequest.input('modifiedDate', sql.DateTime2, new Date());
      
      const fileUploadResult = await fileUploadRequest.query(fileUploadQuery);
      const fileUploadId = fileUploadResult.recordset[0]?.FileId;

      // 5. Save individual acknowledgement responses to EnrollmentAcknowledgements table
      for (const acknowledgement of acknowledgements) {
        const acknowledgementQuery = `
          INSERT INTO oe.EnrollmentAcknowledgements (
            AcknowledgementId, LinkToken, MemberId, ProductId, QuestionId, 
            Response, DigitalSignature, SignedDate, CreatedDate, FileUploadId
          ) VALUES (
            NEWID(), @linkToken, @memberId, @productId, @questionId,
            @response, @digitalSignature, @signedDate, @createdDate, @fileUploadId
          )
        `;
        
        const acknowledgementRequest = transaction.request();
        acknowledgementRequest.input('linkToken', sql.NVarChar, linkToken);
        acknowledgementRequest.input('memberId', sql.UniqueIdentifier, memberId);
        acknowledgementRequest.input('productId', sql.UniqueIdentifier, acknowledgement.productId);
        acknowledgementRequest.input('questionId', sql.NVarChar, acknowledgement.questionId);
        // Convert response to string - handle both boolean and string responses
        const responseString = typeof acknowledgement.response === 'boolean' 
          ? acknowledgement.response.toString() 
          : String(acknowledgement.response || '');
        acknowledgementRequest.input('response', sql.NVarChar, responseString);
        acknowledgementRequest.input('digitalSignature', sql.NVarChar, digitalSignature);
        acknowledgementRequest.input('signedDate', sql.DateTime2, new Date());
        acknowledgementRequest.input('createdDate', sql.DateTime2, new Date());
        acknowledgementRequest.input('fileUploadId', sql.UniqueIdentifier, fileUploadId);
        
        await acknowledgementRequest.query(acknowledgementQuery);
      }

      // 6. Update Members.SignedAgreements with PDF URL (simple JSON string for SQL Server 2012)
      const agreementData = {
        type: 'acknowledgements',
        fileName: fileName,
        fileUrl: pdfUrl,
        signedAt: new Date().toISOString(),
        ipAddress: ipAddress || '127.0.0.1',
        userAgent: userAgent || 'Unknown'
      };
      
      const updateMemberQuery = `
        UPDATE oe.Members 
        SET SignedAgreements = CASE 
          WHEN SignedAgreements IS NULL THEN @agreementJson
          ELSE SignedAgreements + ',' + @agreementJson
        END
        WHERE MemberId = @memberId
      `;
      
      const updateMemberRequest = transaction.request();
      updateMemberRequest.input('memberId', sql.UniqueIdentifier, memberId);
      updateMemberRequest.input('agreementJson', sql.NVarChar, JSON.stringify(agreementData));
      
      await updateMemberRequest.query(updateMemberQuery);

      await transaction.commit();

      console.log('✅ Acknowledgements submitted successfully for member:', memberId);

      res.json({
        success: true,
        message: 'Acknowledgements submitted successfully',
        data: {
          agreementsPdfUrl: pdfUrl,
          acknowledgementsCount: acknowledgements.length,
          memberId: memberId
        }
      });

    } catch (error) {
      await transaction.rollback();
      throw error;
    }

  } catch (error) {
    console.error('❌ Error submitting acknowledgements:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while submitting acknowledgements',
      error: error.message
    });
  }
});

// POST /api/enrollment-links/:linkToken/decline-coverage - Submit decline coverage acknowledgment
router.post('/:linkToken/decline-coverage', async (req, res) => {
  console.log('🚀 DECLINE COVERAGE ENDPOINT CALLED - NEW VERSION');
  try {
    const { linkToken } = req.params;
    const { 
      declineReasons,
      digitalSignature,
      memberInfo,
      ipAddress,
      userAgent
    } = req.body;

    console.log('📝 Processing decline coverage for link:', linkToken);
    console.log('🔍 Decline reasons:', declineReasons);

    // Validate required data
    if (!declineReasons || !Array.isArray(declineReasons) || declineReasons.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'At least one decline reason is required'
      });
    }

    if (!digitalSignature || digitalSignature.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'Digital signature is required'
      });
    }

    if (!memberInfo || !memberInfo.firstName || !memberInfo.lastName) {
      return res.status(400).json({
        success: false,
        message: 'Member information is required'
      });
    }

    // Get enrollment link data to find member
    const enrollmentLink = await getEnrollmentLinkByToken(linkToken);
    if (!enrollmentLink) {
      return res.status(404).json({
        success: false,
        message: 'Enrollment link not found'
      });
    }

    console.log('🔍 Enrollment link found:', enrollmentLink);
    console.log('🔍 Looking for member with ID:', enrollmentLink.MemberId);
    console.log('🔍 Member ID type:', typeof enrollmentLink.MemberId);

    // Get member information
    const member = await getMemberById(enrollmentLink.MemberId);
    console.log('🔍 Member lookup result:', member);
    console.log('🔍 Member lookup result type:', typeof member);
    
    if (!member) {
      return res.status(404).json({
        success: false,
        message: 'Member not found'
      });
    }

    const pool = await getPool();
    const transaction = pool.transaction();
    
    try {
      await transaction.begin();
      console.log('✅ Transaction started for decline coverage');

      // Create decline acknowledgment record
      const declineId = require('crypto').randomUUID();
      const declineRequest = transaction.request();
      
      declineRequest.input('declineId', sql.UniqueIdentifier, declineId);
      declineRequest.input('linkToken', sql.NVarChar, linkToken);
      declineRequest.input('memberId', sql.UniqueIdentifier, member.MemberId);
      declineRequest.input('declineReasons', sql.NVarChar, JSON.stringify(declineReasons));
      declineRequest.input('digitalSignature', sql.NVarChar, digitalSignature);
      declineRequest.input('acknowledgmentText', sql.NVarChar, 
        'I, the undersigned, have been offered participation in the company-sponsored healthcare benefits plan. After reviewing the plan details and understanding my eligibility, I have decided to decline participation in the healthcare benefits plan.');
      declineRequest.input('signedDate', sql.DateTime2, new Date());
      declineRequest.input('createdDate', sql.DateTime2, new Date());
      declineRequest.input('ipAddress', sql.NVarChar, ipAddress || '127.0.0.1');
      declineRequest.input('userAgent', sql.NVarChar, userAgent || 'Unknown');
      declineRequest.input('status', sql.NVarChar, 'Active');

      await declineRequest.query(`
        INSERT INTO oe.DeclineAcknowledgements (
          DeclineAcknowledgementId, LinkToken, MemberId, DeclineReasons, 
          DigitalSignature, AcknowledgmentText, SignedDate, CreatedDate, 
          IpAddress, UserAgent, Status
        ) VALUES (
          @declineId, @linkToken, @memberId, @declineReasons,
          @digitalSignature, @acknowledgmentText, @signedDate, @createdDate,
          @ipAddress, @userAgent, @status
        )
      `);

      console.log('✅ Decline acknowledgment saved to database');

      // Generate PDF for decline acknowledgment
      const { generateDeclineAcknowledgmentPDF } = require('../utils/pdfGenerator');
      const pdfBuffer = await generateDeclineAcknowledgmentPDF({
        memberInfo: {
          firstName: memberInfo.firstName,
          lastName: memberInfo.lastName,
          email: memberInfo.email || member.Email
        },
        declineReasons,
        digitalSignature,
        signedDate: new Date(),
        linkToken
      });

      // Upload PDF to blob storage
      const { uploadToAzureBlob } = require('./uploads');
      const fileName = `decline-acknowledgment-${member.MemberId}-${Date.now()}.pdf`;
      
      // Create a file-like object for the upload function
      const fileObject = {
        buffer: pdfBuffer,
        mimetype: 'application/pdf',
        originalname: fileName
      };
      
      const pdfUrl = await uploadToAzureBlob(fileObject, 'documents', fileName);
      console.log('✅ PDF uploaded successfully:', pdfUrl);

      // Update member status to declined
      const memberUpdateRequest = transaction.request();
      memberUpdateRequest.input('memberId', sql.UniqueIdentifier, member.MemberId);
      memberUpdateRequest.input('status', sql.NVarChar, 'Declined');
      
      await memberUpdateRequest.query(`
        UPDATE oe.Members 
        SET Status = @status, ModifiedDate = GETUTCDATE()
        WHERE MemberId = @memberId
      `);

      console.log('✅ Member status updated to Declined');

      await transaction.commit();
      console.log('✅ Decline coverage transaction committed successfully');

      res.json({
        success: true,
        message: 'Coverage decline processed successfully',
        data: {
          declineId,
          memberId: member.MemberId,
          declineReasons,
          pdfUrl: pdfUrl
        }
      });

    } catch (error) {
      await transaction.rollback();
      console.error('❌ Error in decline coverage transaction:', error);
      throw error;
    }

  } catch (error) {
    console.error('❌ Error processing decline coverage:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to process coverage decline',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Export router for app.js
module.exports = router;
