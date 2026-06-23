const express = require('express');
const router = express.Router();
const { authorize, authenticate , getUserRoles } = require('../middleware/auth');
const TenantIdentificationService = require('../services/tenantIdentification.service');
const { authenticateUrls } = require('./uploads');

/**
 * UNIFIED TENANT IDENTIFICATION API
 * 
 * Handles tenant identification for both custom domains and default domain paths
 * Used by frontend route handler to determine tenant branding
 */

// GET /api/tenant-identification
// Get tenant information by current hostname and path
router.get('/', async (req, res) => {
  try {
    // Get hostname from multiple sources (query param, headers, or request)
    let hostname = req.query.hostname; // Frontend can pass it explicitly
    if (!hostname) {
      hostname = req.get('host') || req.hostname;
    }
    // Remove port number if present (e.g., "portal.mightywellhealth.com:443" -> "portal.mightywellhealth.com")
    if (hostname && hostname.includes(':')) {
      hostname = hostname.split(':')[0];
    }
    // Also check x-forwarded-host header (used by Azure Front Door)
    if (!hostname || hostname === 'localhost' || hostname.includes('allaboard365.com')) {
      const forwardedHost = req.get('x-forwarded-host');
      if (forwardedHost) {
        hostname = forwardedHost.split(':')[0]; // Remove port if present
        console.log(`🔍 Using x-forwarded-host: ${hostname}`);
      }
    }
    
    const path = req.query.path || '/';
    
    console.log(`🔍 TENANT IDENTIFICATION API - Request received`);
    console.log(`🔍 Normalized Hostname: ${hostname}`);
    console.log(`🔍 Path: ${path}`);
    console.log(`🔍 Query params:`, req.query);
    console.log(`🔍 Headers:`, {
      host: req.get('host'),
      hostname: req.hostname,
      'x-forwarded-host': req.get('x-forwarded-host')
    });
    
    const tenant = await TenantIdentificationService.getTenantByHostnameAndPath(hostname, path);
    console.log(`🔍 Service result:`, tenant ? 'Found tenant' : 'No tenant found');
    
    if (!tenant) {
      console.log(`❌ TENANT IDENTIFICATION API - No tenant found, returning 404`);
      return res.status(404).json({
        success: false,
        message: 'Tenant not found',
        data: null
      });
    }
    
    console.log(`✅ TENANT IDENTIFICATION API - Tenant found, preparing response`);
    console.log(`✅ Tenant ID: ${tenant.TenantId}`);
    console.log(`✅ Tenant Name: ${tenant.Name}`);
    console.log(`✅ Logo URL from tenant object: ${tenant.LogoUrl}`);
    console.log(`✅ Logo URL type: ${typeof tenant.LogoUrl}`);
    console.log(`✅ Logo URL length: ${tenant.LogoUrl ? tenant.LogoUrl.length : 0}`);
    
    // Ensure logoUrl is not empty or default before sending
    let finalLogoUrl = tenant.LogoUrl;
    if (!finalLogoUrl || finalLogoUrl === '/images/branding/allaboard365/allaboard365-logo-transparent.png' || finalLogoUrl.trim() === '') {
      console.log(`⚠️ Logo URL is empty or default, attempting to extract from AdvancedSettings...`);
      try {
        if (tenant.AdvancedSettings) {
          const advancedSettings = typeof tenant.AdvancedSettings === 'string' 
            ? JSON.parse(tenant.AdvancedSettings) 
            : tenant.AdvancedSettings;
          
          if (advancedSettings?.branding?.logoUrl) {
            finalLogoUrl = advancedSettings.branding.logoUrl;
            console.log(`✅ Logo URL extracted from AdvancedSettings: ${finalLogoUrl}`);
          }
        }
      } catch (parseError) {
        console.error(`❌ Error parsing AdvancedSettings for logo:`, parseError.message);
      }
    }
    
    // No authentication needed for image URLs (logos, product images)
    const tenantData = {
      tenantId: tenant.TenantId,
      name: tenant.Name,
      urlPath: tenant.UrlPath,
      customDomain: tenant.CustomDomain,
      logoUrl: finalLogoUrl, // Use the final logo URL
      primaryColorHex: tenant.PrimaryColorHex,
      secondaryColorHex: tenant.SecondaryColorHex
    };
    
    console.log(`✅ TENANT IDENTIFICATION API - Final response data:`, JSON.stringify(tenantData, null, 2));
    console.log(`✅ TENANT IDENTIFICATION API - Sending successful response`);
    res.json({
      success: true,
      data: tenantData
    });
    
  } catch (error) {
    console.error('❌ ERROR in tenant identification endpoint:', error);
    console.error('❌ Error details:', {
      message: error.message,
      stack: error.stack,
      hostname: req.get('host') || req.hostname,
      path: req.query.path || '/'
    });
    res.status(500).json({
      success: false,
      message: 'Failed to identify tenant',
      error: {
        message: error.message,
        code: 'TENANT_IDENTIFICATION_ERROR'
      }
    });
  }
});

// GET /api/tenant-identification/suggestions/:tenantName
// Generate URL path suggestions for a tenant
router.get('/suggestions/:tenantName', authenticate, authorize(['SysAdmin', 'TenantAdmin']), async (req, res) => {
  try {
    const { tenantName } = req.params;
    const tenantId = req.user.TenantId; // For TenantAdmin, exclude their own tenant
    
    const suggestions = await TenantIdentificationService.generateUrlPathSuggestions(tenantName, tenantId);
    
    res.json({
      success: true,
      data: suggestions
    });
    
  } catch (error) {
    console.error('❌ Error generating URL path suggestions:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to generate URL path suggestions',
      error: {
        message: error.message,
        code: 'SUGGESTIONS_ERROR'
      }
    });
  }
});

// POST /api/tenant-identification/set-url-path
// Set tenant URL path
router.post('/set-url-path', authenticate, authorize(['SysAdmin', 'TenantAdmin']), async (req, res) => {
  try {
    const { tenantId, urlPath } = req.body;
    
    // Validate required fields
    if (!tenantId || !urlPath) {
      return res.status(400).json({
        success: false,
        message: 'TenantId and urlPath are required'
      });
    }
    
    // Verify tenant access
    if (getUserRoles(req.user).includes('TenantAdmin') && req.user.TenantId !== tenantId) {
      return res.status(403).json({
        success: false,
        message: 'You can only set URL path for your own tenant'
      });
    }
    
    // Check availability
    const isAvailable = await TenantIdentificationService.isUrlPathAvailable(urlPath, tenantId);
    if (!isAvailable) {
      return res.status(400).json({
        success: false,
        message: 'URL path is not available'
      });
    }
    
    // Set the URL path
    const success = await TenantIdentificationService.setTenantUrlPath(tenantId, urlPath);
    
    if (success) {
      res.json({
        success: true,
        message: 'URL path set successfully'
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'Failed to set URL path'
      });
    }
    
  } catch (error) {
    console.error('❌ Error setting URL path:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to set URL path',
      error: {
        message: error.message,
        code: 'SET_URL_PATH_ERROR'
      }
    });
  }
});

// POST /api/tenant-identification/generate-path
// Generate the best available URL path for a tenant name
router.post('/generate-path', async (req, res) => {
  try {
    const { tenantName } = req.body;
    
    if (!tenantName || !tenantName.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Tenant name is required'
      });
    }

    const urlPath = await TenantIdentificationService.generateUrlPath(tenantName);
    
    res.json({
      success: true,
      data: {
        urlPath,
        isAvailable: true
      }
    });
    
  } catch (error) {
    console.error('❌ Error generating URL path:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to generate URL path'
    });
  }
});

// GET /api/tenant-identification/check-availability/:urlPath
// Check if URL path is available
router.get('/check-availability/:urlPath', async (req, res) => {
  try {
    const { urlPath } = req.params;
    const excludeTenantId = req.query.excludeTenantId || null;
    
    const isAvailable = await TenantIdentificationService.isUrlPathAvailable(urlPath, excludeTenantId);
    
    res.json({
      success: true,
      data: {
        urlPath,
        isAvailable
      }
    });
    
  } catch (error) {
    console.error('❌ Error checking URL path availability:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to check URL path availability',
      error: {
        message: error.message,
        code: 'AVAILABILITY_CHECK_ERROR'
      }
    });
  }
});

module.exports = router;
