const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/database');
const { authorize } = require('../middleware/auth');

/**
 * Generate the best available URL path for a tenant name
 * POST /api/tenant-identification/generate-path
 * Body: { tenantName: string }
 */
router.post('/generate-path', authorize(['SysAdmin']), async (req, res) => {
  try {
    const { tenantName } = req.body;
    
    if (!tenantName || !tenantName.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Tenant name is required'
      });
    }

    const pool = await getPool();
    const request = pool.request();
    
    // Generate URL path candidates in order of preference
    const generateCandidates = (name) => {
      const cleanName = name
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '') // Remove special characters
        .replace(/\s+/g, '-') // Replace spaces with hyphens
        .replace(/-+/g, '-') // Replace multiple hyphens with single
        .replace(/^-|-$/g, ''); // Remove leading/trailing hyphens
      
      const candidates = [
        cleanName, // e.g., "mighty-well-health"
        cleanName.replace(/-/g, ''), // e.g., "mightywellhealth"
        `${cleanName}-1`, // e.g., "mighty-well-health-1"
        `${cleanName.replace(/-/g, '')}-1`, // e.g., "mightywellhealth-1"
        `${cleanName}-2`, // e.g., "mighty-well-health-2"
        `${cleanName.replace(/-/g, '')}-2` // e.g., "mightywellhealth-2"
      ];
      
      return candidates.filter(candidate => candidate.length > 0);
    };

    const candidates = generateCandidates(tenantName);
    
    // Check availability of each candidate
    for (const candidate of candidates) {
      const checkQuery = `
        SELECT COUNT(*) as count 
        FROM oe.Tenants 
        WHERE DefaultUrlPath = @urlPath AND Status = 'Active'
      `;
      
      request.input('urlPath', sql.NVarChar(100), candidate);
      const result = await request.query(checkQuery);
      
      if (result.recordset[0].count === 0) {
        // Found available URL path
        return res.json({
          success: true,
          data: {
            urlPath: candidate,
            isAvailable: true
          }
        });
      }
    }
    
    // If no candidates are available, generate a unique one with timestamp
    const timestamp = Date.now().toString().slice(-6); // Last 6 digits
    const fallbackCandidate = `${candidates[0]}-${timestamp}`;
    
    res.json({
      success: true,
      data: {
        urlPath: fallbackCandidate,
        isAvailable: true,
        isFallback: true
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

/**
 * Check if a specific URL path is available
 * GET /api/tenant-identification/check-availability/:urlPath
 */
router.get('/check-availability/:urlPath', async (req, res) => {
  try {
    const { urlPath } = req.params;
    
    if (!urlPath || !urlPath.trim()) {
      return res.status(400).json({
        success: false,
        message: 'URL path is required'
      });
    }

    const pool = await getPool();
    const request = pool.request();
    
    const checkQuery = `
      SELECT COUNT(*) as count 
      FROM oe.Tenants 
      WHERE DefaultUrlPath = @urlPath AND Status = 'Active'
    `;
    
    request.input('urlPath', sql.NVarChar(100), urlPath);
    const result = await request.query(checkQuery);
    
    const isAvailable = result.recordset[0].count === 0;
    
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
      message: 'Failed to check URL path availability'
    });
  }
});

module.exports = router;
