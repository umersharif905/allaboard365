// backend/routes/config.js
// Public configuration endpoint for frontend runtime configuration
// Returns branding, API URLs, and other runtime config

const express = require('express');
const router = express.Router();

/**
 * GET /config.json
 * Public endpoint that returns runtime configuration
 * Used by frontend to get branding, API URLs, etc.
 * No authentication required (public endpoint)
 */
router.get('/config.json', (req, res) => {
  try {
    // Get API URL from environment variables
    const apiUrl = process.env.VITE_API_URL || process.env.API_URL || process.env.BASE_URL || null;
    const oauthUrl = process.env.VITE_OAUTH_URL || process.env.OAUTH_URL || null;
    const appUrl = process.env.VITE_APP_URL || process.env.APP_URL || null;
    
    // Get brand identifier from environment variables
    // Priority: BRAND > VITE_BRAND
    const brand = (process.env.BRAND || process.env.VITE_BRAND || 'allaboard365').trim();
    
    // Log for debugging
    console.log('[Config Route] Environment variables:', {
      BRAND: process.env.BRAND,
      VITE_BRAND: process.env.VITE_BRAND,
      selectedBrand: brand,
      allEnvKeys: Object.keys(process.env).filter(k => k.includes('BRAND'))
    });
    
    // Build config object
    const config = {
      // API Configuration
      API_URL: apiUrl,
      BASE_URL: apiUrl, // Alias for convenience
      OAUTH_URL: oauthUrl,
      APP_URL: appUrl,
      
      // Branding Configuration - ALWAYS include this
      BRAND: brand,
    };
    
    // Remove null/undefined values to keep response clean (but keep BRAND even if empty)
    Object.keys(config).forEach(key => {
      if (key !== 'BRAND' && (config[key] === null || config[key] === undefined)) {
        delete config[key];
      }
    });
    
    // Ensure BRAND is always present
    if (!config.BRAND) {
      config.BRAND = 'allaboard365';
      console.warn('[Config Route] BRAND was empty, defaulting to allaboard365');
    }
    
    console.log('[Config Route] Final config being sent:', JSON.stringify(config, null, 2));
    
    // Set headers to prevent caching
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    
    res.json(config);
  } catch (error) {
    console.error('[Config Route] Error generating config:', error);
    res.status(500).json({
      error: 'Failed to generate configuration',
      message: error.message
    });
  }
});

module.exports = router;
