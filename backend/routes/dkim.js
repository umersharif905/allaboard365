// routes/dkim.js
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { generateKeyPairSync } = require('crypto');
const sql = require('mssql');
const { authenticateToken, checkAdminRole } = require('../middleware/auth');

// Generate DKIM keys for a tenant
router.post('/tenants/:tenantId/dkim/generate', authenticateToken, checkAdminRole, async (req, res) => {
  const { tenantId } = req.params;
  const { domain, selector } = req.body;

  try {
    // Generate RSA key pair for DKIM
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: {
        type: 'spki',
        format: 'pem'
      },
      privateKeyEncoding: {
        type: 'pkcs8',
        format: 'pem'
      }
    });

    // Extract the public key content for DNS record
    // Remove header/footer and newlines for DNS TXT record
    const publicKeyForDNS = publicKey
      .replace(/-----BEGIN PUBLIC KEY-----/, '')
      .replace(/-----END PUBLIC KEY-----/, '')
      .replace(/\n/g, '');

    // Get database connection from pool
    const pool = req.app.get('dbPool');
    
    // Check if tenant exists
    const tenantResult = await pool.request()
      .input('TenantId', sql.UniqueIdentifier, tenantId)
      .query('SELECT TenantId, AdvancedSettings FROM Tenants WHERE TenantId = @TenantId');

    if (tenantResult.recordset.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'Tenant not found' 
      });
    }

    // Parse existing AdvancedSettings
    let advancedSettings = {};
    if (tenantResult.recordset[0].AdvancedSettings) {
      try {
        advancedSettings = JSON.parse(tenantResult.recordset[0].AdvancedSettings);
      } catch (e) {
        console.error('Error parsing AdvancedSettings:', e);
      }
    }

    // Update email settings with DKIM info
    advancedSettings.email = {
      ...advancedSettings.email,
      dkimEnabled: true,
      dkimDomain: domain,
      dkimSelector: selector || `openenroll-${Date.now()}`,
      dkimPublicKey: publicKeyForDNS,
      // In production, encrypt the private key before storing
      dkimPrivateKeyEncrypted: encryptPrivateKey(privateKey)
    };

    // Update tenant with new settings
    await pool.request()
      .input('TenantId', sql.UniqueIdentifier, tenantId)
      .input('AdvancedSettings', sql.NVarChar(sql.MAX), JSON.stringify(advancedSettings))
      .query(`
        UPDATE Tenants 
        SET AdvancedSettings = @AdvancedSettings,
            ModifiedDate = GETDATE()
        WHERE TenantId = @TenantId
      `);

    // Log the action
    await pool.request()
      .input('TenantId', sql.UniqueIdentifier, tenantId)
      .input('UserId', sql.UniqueIdentifier, req.user.userId)
      .input('Action', sql.NVarChar(100), 'DKIM_KEYS_GENERATED')
      .input('Details', sql.NVarChar(sql.MAX), JSON.stringify({ domain, selector: advancedSettings.email.dkimSelector }))
      .query(`
        INSERT INTO AuditLogs (TenantId, UserId, Action, Details, CreatedDate)
        VALUES (@TenantId, @UserId, @Action, @Details, GETDATE())
      `);

    res.json({
      success: true,
      selector: advancedSettings.email.dkimSelector,
      publicKey: publicKeyForDNS,
      privateKey: privateKey, // Only for initial display, not stored in plain text
      message: 'DKIM keys generated successfully'
    });

  } catch (error) {
    console.error('Error generating DKIM keys:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to generate DKIM keys',
      error: error.message 
    });
  }
});

// Helper function to encrypt private key (implement based on your security requirements)
function encryptPrivateKey(privateKey) {
  // In production, use a proper encryption method
  // This is a placeholder - implement proper encryption using crypto module
  const algorithm = 'aes-256-gcm';
  const key = Buffer.from(process.env.ENCRYPTION_KEY || 'your-32-byte-encryption-key-here', 'utf8');
  const iv = crypto.randomBytes(16);
  
  const cipher = crypto.createCipheriv(algorithm, key, iv);
  
  let encrypted = cipher.update(privateKey, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const authTag = cipher.getAuthTag();
  
  return {
    encrypted,
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex')
  };
}

module.exports = router;