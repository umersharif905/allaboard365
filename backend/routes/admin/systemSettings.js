// backend/routes/admin/systemSettings.js
/**
 * System Settings API Routes
 * Handles system configuration, health monitoring, and maintenance operations
 */

const express = require('express');
const sql = require('mssql');
const { authenticate, authorize } = require('../../middleware/auth');
const { validateRequest } = require('../../middleware/validation');
const { logAuditEvent } = require('../../utils/audit');
const router = express.Router();

// Apply authentication and admin authorization to all routes
router.use(authenticate);
router.use(authorize(['Admin']));

// ===========================================
// SYSTEM SETTINGS ENDPOINTS
// ===========================================

/**
 * GET /api/admin/system-settings
 * Get all system configuration settings
 */
router.get('/system-settings', async (req, res) => {
  try {
    const pool = await sql.connect();
    const result = await pool.request()
      .query(`
        SELECT 
          SettingKey,
          SettingValue,
          SettingType,
          Category,
          Description,
          IsReadOnly,
          DefaultValue,
          ValidationRule,
          ModifiedDate
        FROM oe.SystemSettings 
        ORDER BY Category, SettingKey
      `);

    res.json(result.recordset);
  } catch (error) {
    console.error('Error fetching system settings:', error);
    res.status(500).json({ error: 'Failed to fetch system settings' });
  }
});

/**
 * PUT /api/admin/system-settings/:key
 * Update a specific system setting
 */
router.put('/system-settings/:key', validateRequest({
  body: {
    settingValue: { type: 'string', required: true }
  }
}), async (req, res) => {
  try {
    const { key } = req.params;
    const { settingValue } = req.body;
    const userId = req.user.userId;

    const pool = await sql.connect();
    
    // Check if setting exists and is not read-only
    const settingCheck = await pool.request()
      .input('key', sql.NVarChar, key)
      .query('SELECT IsReadOnly, ValidationRule FROM oe.SystemSettings WHERE SettingKey = @key');

    if (settingCheck.recordset.length === 0) {
      return res.status(404).json({ error: 'Setting not found' });
    }

    if (settingCheck.recordset[0].IsReadOnly) {
      return res.status(403).json({ error: 'Setting is read-only' });
    }

    // Validate setting value if validation rule exists
    const validationRule = settingCheck.recordset[0].ValidationRule;
    if (validationRule) {
      const isValid = validateSettingValue(settingValue, validationRule);
      if (!isValid) {
        return res.status(400).json({ error: 'Invalid setting value' });
      }
    }

    // Update setting
    await pool.request()
      .input('key', sql.NVarChar, key)
      .input('value', sql.NVarChar, settingValue)
      .input('userId', sql.UniqueIdentifier, userId)
      .query(`
        UPDATE oe.SystemSettings 
        SET SettingValue = @value, 
            ModifiedDate = GETDATE(),
            ModifiedBy = @userId
        WHERE SettingKey = @key
      `);

    // Log audit event
    await logAuditEvent(userId, 'UPDATE_SYSTEM_SETTING', 'SystemSettings', key, {
      settingKey: key,
      newValue: settingValue
    }, req.ip, req.get('User-Agent'));

    res.json({ success: true });
  } catch (error) {
    console.error('Error updating system setting:', error);
    res.status(500).json({ error: 'Failed to update system setting' });
  }
});

/**
 * PUT /api/admin/system-settings/batch
 * Update multiple system settings at once
 */
router.put('/system-settings/batch', validateRequest({
  body: {
    settings: { 
      type: 'array', 
      required: true,
      items: {
        type: 'object',
        properties: {
          settingKey: { type: 'string', required: true },
          settingValue: { type: 'string', required: true }
        }
      }
    }
  }
}), async (req, res) => {
  try {
    const { settings } = req.body;
    const userId = req.user.userId;

    const pool = await sql.connect();
    const transaction = new sql.Transaction(pool);
    
    try {
      await transaction.begin();

      for (const setting of settings) {
        const { settingKey, settingValue } = setting;

        // Check if setting exists and is not read-only
        const settingCheck = await transaction.request()
          .input('key', sql.NVarChar, settingKey)
          .query('SELECT IsReadOnly, ValidationRule FROM oe.SystemSettings WHERE SettingKey = @key');

        if (settingCheck.recordset.length === 0 || settingCheck.recordset[0].IsReadOnly) {
          continue; // Skip invalid or read-only settings
        }

        // Update setting
        await transaction.request()
          .input('key', sql.NVarChar, settingKey)
          .input('value', sql.NVarChar, settingValue)
          .input('userId', sql.UniqueIdentifier, userId)
          .query(`
            UPDATE oe.SystemSettings 
            SET SettingValue = @value, 
                ModifiedDate = GETDATE(),
                ModifiedBy = @userId
            WHERE SettingKey = @key
          `);

        // Log audit event
        await logAuditEvent(userId, 'UPDATE_SYSTEM_SETTING', 'SystemSettings', settingKey, {
          settingKey,
          newValue: settingValue
        }, req.ip, req.get('User-Agent'));
      }

      await transaction.commit();
      res.json({ success: true });
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  } catch (error) {
    console.error('Error batch updating system settings:', error);
    res.status(500).json({ error: 'Failed to update system settings' });
  }
});

// ===========================================
// SYSTEM HEALTH ENDPOINTS
// ===========================================

/**
 * GET /api/admin/system-health
 * Get overall system health status
 */
router.get('/system-health', async (req, res) => {
  try {
    const healthChecks = await performSystemHealthChecks();
    
    // Determine overall status
    const hascritical = healthChecks.some(check => check.status === 'critical' || check.status === 'down');
    const hasWarning = healthChecks.some(check => check.status === 'warning');
    
    const overallStatus = hasCritical ? 'critical' : hasWarning ? 'warning' : 'healthy';

    res.json({
      overallStatus,
      checks: healthChecks,
      lastUpdated: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error checking system health:', error);
    res.status(500).json({ error: 'Failed to check system health' });
  }
});

/**
 * GET /api/admin/health-checks
 * Get detailed health check results
 */
router.get('/health-checks', async (req, res) => {
  try {
    const pool = await sql.connect();
    const result = await pool.request()
      .query(`
        SELECT TOP 100
          ServiceName,
          ServiceUrl,
          Status,
          ResponseTime,
          ErrorMessage,
          CheckedDate,
          Details
        FROM oe.SystemHealth 
        ORDER BY CheckedDate DESC
      `);

    res.json(result.recordset);
  } catch (error) {
    console.error('Error fetching health checks:', error);
    res.status(500).json({ error: 'Failed to fetch health checks' });
  }
});

/**
 * POST /api/admin/health-checks/all
 * Trigger health checks for all services
 */
router.post('/health-checks/all', async (req, res) => {
  try {
    const userId = req.user.userId;
    const healthChecks = await performSystemHealthChecks();

    // Store results in database
    const pool = await sql.connect();
    for (const check of healthChecks) {
      await pool.request()
        .input('serviceName', sql.NVarChar, check.serviceName)
        .input('serviceUrl', sql.NVarChar, check.serviceUrl)
        .input('status', sql.NVarChar, check.status)
        .input('responseTime', sql.Int, check.responseTime)
        .input('errorMessage', sql.NVarChar, check.errorMessage)
        .input('details', sql.NVarChar, JSON.stringify(check.details))
        .query(`
          INSERT INTO oe.SystemHealth 
          (ServiceName, ServiceUrl, Status, ResponseTime, ErrorMessage, Details, CheckedDate)
          VALUES (@serviceName, @serviceUrl, @status, @responseTime, @errorMessage, @details, GETDATE())
        `);
    }

    // Log audit event
    await logAuditEvent(userId, 'TRIGGER_HEALTH_CHECK', 'SystemHealth', 'all', {
      checksPerformed: healthChecks.length
    }, req.ip, req.get('User-Agent'));

    res.json({ success: true, results: healthChecks });
  } catch (error) {
    console.error('Error performing health checks:', error);
    res.status(500).json({ error: 'Failed to perform health checks' });
  }
});

/**
 * GET /api/admin/system-metrics
 * Get current system performance metrics
 */
router.get('/system-metrics', async (req, res) => {
  try {
    const metrics = await collectSystemMetrics();
    res.json(metrics);
  } catch (error) {
    console.error('Error collecting system metrics:', error);
    res.status(500).json({ error: 'Failed to collect system metrics' });
  }
});

// ===========================================
// BACKUP MANAGEMENT ENDPOINTS
// ===========================================

/**
 * GET /api/admin/backup-history
 * Get backup history from Azure
 */
router.get('/backup-history', async (req, res) => {
  try {
    const pool = await sql.connect();
    const result = await pool.request()
      .query(`
        SELECT TOP 50
          BackupId,
          BackupType,
          DatabaseName,
          Status,
          StartTime,
          EndTime,
          SizeInMB,
          BackupLocation,
          ErrorMessage,
          AzureBackupId
        FROM oe.BackupHistory 
        ORDER BY StartTime DESC
      `);

    res.json(result.recordset);
  } catch (error) {
    console.error('Error fetching backup history:', error);
    res.status(500).json({ error: 'Failed to fetch backup history' });
  }
});

/**
 * POST /api/admin/backup
 * Trigger a manual backup
 */
router.post('/backup', validateRequest({
  body: {
    backupType: { type: 'string', enum: ['Full', 'Differential'], required: true }
  }
}), async (req, res) => {
  try {
    const { backupType } = req.body;
    const userId = req.user.userId;

    // Record backup initiation
    const pool = await sql.connect();
    const backupId = require('crypto').randomUUID();
    
    await pool.request()
      .input('backupId', sql.UniqueIdentifier, backupId)
      .input('backupType', sql.NVarChar, backupType)
      .input('databaseName', sql.NVarChar, 'allaboard-prod')
      .input('status', sql.NVarChar, 'InProgress')
      .query(`
        INSERT INTO oe.BackupHistory 
        (BackupId, BackupType, DatabaseName, Status, StartTime)
        VALUES (@backupId, @backupType, @databaseName, @status, GETDATE())
      `);

    // Trigger Azure backup (implementation depends on Azure setup)
    triggerAzureBackup(backupType, backupId);

    // Log audit event
    await logAuditEvent(userId, 'TRIGGER_BACKUP', 'BackupHistory', backupId, {
      backupType
    }, req.ip, req.get('User-Agent'));

    res.json({ success: true, backupId });
  } catch (error) {
    console.error('Error triggering backup:', error);
    res.status(500).json({ error: 'Failed to trigger backup' });
  }
});

// ===========================================
// AUDIT LOG ENDPOINTS
// ===========================================

/**
 * GET /api/admin/audit-logs
 * Search and retrieve audit logs
 */
router.get('/audit-logs', async (req, res) => {
  try {
    const { 
      searchTerm, 
      startDate, 
      endDate, 
      entityType, 
      action, 
      userId: searchUserId,
      page = 1, 
      limit = 50 
    } = req.query;

    const pool = await sql.connect();
    let query = `
      SELECT 
        a.AuditLogId,
        a.UserId,
        u.Email as UserEmail,
        u.FirstName + ' ' + u.LastName as UserName,
        a.Action,
        a.EntityType,
        a.EntityId,
        a.Details,
        a.IpAddress,
        a.UserAgent,
        a.CreatedDate
      FROM oe.AuditLogs a
      LEFT JOIN oe.Users u ON a.UserId = u.UserId
      WHERE 1=1
    `;

    const request = pool.request();
    
    if (searchTerm) {
      query += ` AND (u.Email LIKE @searchTerm OR a.Action LIKE @searchTerm OR a.EntityType LIKE @searchTerm)`;
      request.input('searchTerm', sql.NVarChar, `%${searchTerm}%`);
    }
    
    if (startDate) {
      query += ` AND a.CreatedDate >= @startDate`;
      request.input('startDate', sql.DateTime2, startDate);
    }
    
    if (endDate) {
      query += ` AND a.CreatedDate <= @endDate`;
      request.input('endDate', sql.DateTime2, endDate);
    }
    
    if (entityType) {
      query += ` AND a.EntityType = @entityType`;
      request.input('entityType', sql.NVarChar, entityType);
    }
    
    if (action) {
      query += ` AND a.Action = @action`;
      request.input('action', sql.NVarChar, action);
    }
    
    if (searchUserId) {
      query += ` AND a.UserId = @searchUserId`;
      request.input('searchUserId', sql.UniqueIdentifier, searchUserId);
    }

    // Add pagination
    const offset = (page - 1) * limit;
    query += ` ORDER BY a.CreatedDate DESC OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`;
    request.input('offset', sql.Int, offset);
    request.input('limit', sql.Int, parseInt(limit));

    const result = await request.query(query);

    // Get total count
    let countQuery = query.replace(/SELECT.*FROM/, 'SELECT COUNT(*) as TotalCount FROM').split('ORDER BY')[0];
    const countResult = await pool.request().query(countQuery);

    res.json({
      logs: result.recordset,
      totalCount: countResult.recordset[0].TotalCount,
      page: parseInt(page),
      limit: parseInt(limit)
    });
  } catch (error) {
    console.error('Error searching audit logs:', error);
    res.status(500).json({ error: 'Failed to search audit logs' });
  }
});

/**
 * GET /api/admin/audit-logs/export
 * Export audit logs as CSV
 */
router.get('/audit-logs/export', async (req, res) => {
  try {
    const { searchTerm, startDate, endDate, entityType, action, userId: searchUserId } = req.query;
    
    // Similar query to audit-logs but without pagination
    const pool = await sql.connect();
    let query = `
      SELECT 
        u.Email as UserEmail,
        a.Action,
        a.EntityType,
        a.EntityId,
        a.Details,
        a.IpAddress,
        a.CreatedDate
      FROM oe.AuditLogs a
      LEFT JOIN oe.Users u ON a.UserId = u.UserId
      WHERE 1=1
    `;

    const request = pool.request();
    
    // Apply same filters as audit-logs endpoint
    if (searchTerm) {
      query += ` AND (u.Email LIKE @searchTerm OR a.Action LIKE @searchTerm OR a.EntityType LIKE @searchTerm)`;
      request.input('searchTerm', sql.NVarChar, `%${searchTerm}%`);
    }
    
    // ... apply other filters ...

    query += ` ORDER BY a.CreatedDate DESC`;
    
    const result = await request.query(query);

    // Convert to CSV
    const csv = convertToCSV(result.recordset);
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=audit-logs-${new Date().toISOString().split('T')[0]}.csv`);
    res.send(csv);
  } catch (error) {
    console.error('Error exporting audit logs:', error);
    res.status(500).json({ error: 'Failed to export audit logs' });
  }
});

// ===========================================
// TENANT SETTINGS ENDPOINTS
// ===========================================

/**
 * GET /api/admin/tenant-settings/:tenantId?
 * Get tenant-specific settings (DKIM, etc.)
 */
router.get('/tenant-settings/:tenantId?', async (req, res) => {
  try {
    const { tenantId } = req.params;
    
    const pool = await sql.connect();
    const request = pool.request();
    
    let query = `
      SELECT 
        ts.TenantSettingId,
        ts.TenantId,
        t.Name as TenantName,
        ts.SettingKey,
        ts.SettingValue,
        ts.SettingType,
        ts.IsEncrypted,
        ts.ModifiedDate
      FROM oe.TenantSettings ts
      JOIN oe.Tenants t ON ts.TenantId = t.TenantId
    `;
    
    if (tenantId) {
      query += ` WHERE ts.TenantId = @tenantId`;
      request.input('tenantId', sql.UniqueIdentifier, tenantId);
    }
    
    query += ` ORDER BY t.Name, ts.SettingKey`;
    
    const result = await request.query(query);
    res.json(result.recordset);
  } catch (error) {
    console.error('Error fetching tenant settings:', error);
    res.status(500).json({ error: 'Failed to fetch tenant settings' });
  }
});

// ===========================================
// UTILITY FUNCTIONS
// ===========================================

/**
 * Validate setting value against validation rule
 */
function validateSettingValue(value, validationRule) {
  if (!validationRule) return true;
  
  try {
    const rules = validationRule.split(',').map(rule => rule.trim());
    
    for (const rule of rules) {
      if (rule.startsWith('min:')) {
        const min = parseInt(rule.substring(4));
        if (parseInt(value) < min) return false;
      } else if (rule.startsWith('max:')) {
        const max = parseInt(rule.substring(4));
        if (parseInt(value) > max) return false;
      } else if (rule === 'email') {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(value)) return false;
      } else if (rule === 'url') {
        try {
          new URL(value);
        } catch {
          return false;
        }
      }
    }
    
    return true;
  } catch {
    return true; // If validation rule is malformed, allow the value
  }
}

/**
 * Perform system health checks
 */
async function performSystemHealthChecks() {
  const checks = [];
  
  try {
    // API Server Health
    checks.push(await checkApiHealth());
    
    // Database Health
    checks.push(await checkDatabaseHealth());
    
    // OAuth Service Health
    checks.push(await checkOAuthHealth());
    
    // Azure Blob Storage Health
    checks.push(await checkBlobStorageHealth());
    
    // Email Service Health
    checks.push(await checkEmailServiceHealth());
    
  } catch (error) {
    console.error('Error during health checks:', error);
  }
  
  return checks;
}

/**
 * Collect current system metrics
 */
async function collectSystemMetrics() {
  return {
    cpuUsage: Math.random() * 50 + 20, // Mock data - replace with actual monitoring
    memoryUsage: Math.random() * 40 + 30,
    diskUsage: Math.random() * 30 + 50,
    activeConnections: Math.floor(Math.random() * 200 + 100),
    avgResponseTime: Math.random() * 100 + 50,
    databaseStatus: 'healthy',
    lastUpdated: new Date().toISOString()
  };
}

/**
 * Convert array of objects to CSV
 */
function convertToCSV(data) {
  if (data.length === 0) return '';
  
  const headers = Object.keys(data[0]);
  const csvHeaders = headers.join(',');
  
  const csvRows = data.map(row => 
    headers.map(header => {
      const value = row[header];
      return typeof value === 'string' && value.includes(',') ? `"${value}"` : value;
    }).join(',')
  );
  
  return [csvHeaders, ...csvRows].join('\n');
}

/**
 * Trigger Azure backup (placeholder - implement based on Azure setup)
 */
async function triggerAzureBackup(backupType, backupId) {
  // Implementation depends on Azure backup configuration
  // This could use Azure REST APIs or Azure CLI commands
  console.log(`Triggering Azure ${backupType} backup with ID: ${backupId}`);
}

// Individual health check functions (implement based on your infrastructure)
async function checkApiHealth() {
  return {
    serviceName: 'API Server',
    serviceUrl: 'https://api.allaboard365.com',
    status: 'healthy',
    responseTime: 150,
    lastChecked: new Date().toISOString()
  };
}

async function checkDatabaseHealth() {
  try {
    const pool = await sql.connect();
    const start = Date.now();
    await pool.request().query('SELECT 1');
    const responseTime = Date.now() - start;
    
    return {
      serviceName: 'Azure SQL Database',
      serviceUrl: 'pvt-sql-server.database.windows.net.',
      status: responseTime < 1000 ? 'healthy' : 'warning',
      responseTime,
      lastChecked: new Date().toISOString()
    };
  } catch (error) {
    return {
      serviceName: 'Azure SQL Database',
      serviceUrl: 'pvt-sql-server.database.windows.net.',
      status: 'critical',
      errorMessage: error.message,
      lastChecked: new Date().toISOString()
    };
  }
}

async function checkOAuthHealth() {
  // Implement OAuth service health check
  return {
    serviceName: 'OAuth Service',
    serviceUrl: 'https://api.allaboard365.com',
    status: 'healthy',
    responseTime: 200,
    lastChecked: new Date().toISOString()
  };
}

async function checkBlobStorageHealth() {
  // Implement Azure Blob Storage health check
  return {
    serviceName: 'Azure Blob Storage',
    serviceUrl: 'Azure Blob Storage',
    status: 'healthy',
    responseTime: 300,
    lastChecked: new Date().toISOString()
  };
}

async function checkEmailServiceHealth() {
  // Implement email service health check
  return {
    serviceName: 'Email Service',
    serviceUrl: 'SMTP Provider',
    status: 'healthy',
    responseTime: 500,
    lastChecked: new Date().toISOString()
  };
}

module.exports = router;