// File: backend/routes/enroll-now.js
// Public route for resolving short codes to enrollment links

const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/database');
const posthog = require('../config/posthog');

/**
 * @route   GET /api/enroll-now/:shortCode
 * @desc    Resolve short code to enrollment link token (public endpoint)
 * @access  Public
 */
router.get('/:shortCode', async (req, res) => {
  try {
    const { shortCode } = req.params;

    console.log('🔍 Resolving short code:', shortCode);

    // Validate short code format
    if (!shortCode || typeof shortCode !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'Invalid short code format'
      });
    }

    const pool = await getPool();

    // Look up enrollment link by short code
    const linkQuery = `
      SELECT 
        LinkId,
        LinkToken,
        LinkUrl,
        LinkType,
        ShortCode,
        IsActive,
        ExpiresAt,
        MaxUsage,
        UsageCount
      FROM oe.EnrollmentLinks
      WHERE ShortCode = @shortCode
    `;

    const linkRequest = pool.request();
    linkRequest.input('shortCode', sql.NVarChar, shortCode);
    const linkResult = await linkRequest.query(linkQuery);

    if (linkResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Enrollment link not found',
        error: {
          code: 'LINK_NOT_FOUND',
          message: 'No enrollment link found with this short code'
        }
      });
    }

    const link = linkResult.recordset[0];

    // Validate link is active
    if (!link.IsActive) {
      return res.status(400).json({
        success: false,
        message: 'Enrollment link is inactive',
        error: {
          code: 'LINK_INACTIVE',
          message: 'This enrollment link has been deactivated'
        }
      });
    }

    // Validate link hasn't expired (only for links with expiration)
    if (link.ExpiresAt && new Date(link.ExpiresAt) < new Date()) {
      return res.status(400).json({
        success: false,
        message: 'Enrollment link has expired',
        error: {
          code: 'LINK_EXPIRED',
          message: 'This enrollment link has expired'
        }
      });
    }

    // Validate usage limits (only for links with usage limits)
    if (link.MaxUsage && link.UsageCount >= link.MaxUsage) {
      return res.status(400).json({
        success: false,
        message: 'Enrollment link usage limit reached',
        error: {
          code: 'USAGE_LIMIT_REACHED',
          message: 'This enrollment link has reached its maximum usage limit'
        }
      });
    }

    // Validate this is an Agent-Static or Marketing link (these use short codes)
    if (link.LinkType !== 'Agent-Static' && link.LinkType !== 'Marketing') {
      return res.status(400).json({
        success: false,
        message: 'Invalid link type for short code access',
        error: {
          code: 'INVALID_LINK_TYPE',
          message: 'Only Agent-Static and Marketing links can be accessed via short codes'
        }
      });
    }

    console.log('✅ Short code resolved to link token:', link.LinkToken);

    posthog.capture({
      distinctId: link.LinkToken,
      event: 'enrollment link resolved',
      properties: {
        short_code: link.ShortCode,
        link_type: link.LinkType,
        $process_person_profile: false,
      },
    });

    // Return the link token for the wizard to use
    res.json({
      success: true,
      data: {
        linkToken: link.LinkToken,
        linkType: link.LinkType,
        shortCode: link.ShortCode
      }
    });

  } catch (error) {
    console.error('❌ Error resolving short code:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to resolve short code',
      error: {
        message: error.message,
        code: 'RESOLVE_SHORTCODE_ERROR'
      }
    });
  }
});

module.exports = router;

