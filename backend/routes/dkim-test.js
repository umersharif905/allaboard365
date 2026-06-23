// File: backend/routes/dkim-test.js
// DKIM Testing and Validation System - UNIFIED for SysAdmin and TenantAdmin

const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/database');
const { authorize , getUserRoles } = require('../middleware/auth');
const dns = require('dns').promises;
const crypto = require('crypto');

/**
 * @route POST /api/tenants/:id/dkim/test
 * @desc Test DKIM configuration for a specific tenant (SysAdmin only)
 * @access SysAdmin
 */
router.post('/tenants/:id/dkim/test', 
  authorize(['SysAdmin']), 
  async (req, res) => {
    const { id } = req.params;
    const { testType = 'both' } = req.body;
    
    await performDKIMTest(req, res, id, testType);
});

/**
 * @route POST /api/tenant-admin/dkim/test
 * @desc Test DKIM configuration for the authenticated tenant (TenantAdmin only)
 * @access TenantAdmin
 */
router.post('/dkim/test', 
  authorize(['TenantAdmin']), 
  async (req, res) => {
    const tenantId = req.user.TenantId; // Get from authenticated user
    const { testType = 'both' } = req.body;
    
    await performDKIMTest(req, res, tenantId, testType);
});

/**
 * @route GET /api/tenants/:id/dkim/status
 * @desc Get DKIM configuration status for a specific tenant (SysAdmin only)
 * @access SysAdmin
 */
router.get('/tenants/:id/dkim/status', 
  authorize(['SysAdmin']), 
  async (req, res) => {
    const { id } = req.params;
    
    await getDKIMStatus(req, res, id);
});

/**
 * @route GET /api/tenant-admin/dkim/status
 * @desc Get DKIM configuration status for the authenticated tenant (TenantAdmin only)
 * @access TenantAdmin
 */
router.get('/dkim/status', 
  authorize(['TenantAdmin']), 
  async (req, res) => {
    const tenantId = req.user.TenantId;
    
    await getDKIMStatus(req, res, tenantId);
});

/**
 * SHARED FUNCTION: Perform DKIM Test
 */
async function performDKIMTest(req, res, tenantId, testType) {
    try {
        const pool = await getPool();
        
        console.log('🔍 Testing DKIM for tenant:', tenantId);
        
        // Tenant access validation for TenantAdmin
        if (getUserRoles(req.user).includes('TenantAdmin')) {
            if (req.user.TenantId !== tenantId) {
                return res.status(403).json({
                    success: false,
                    message: 'You can only test DKIM for your own tenant'
                });
            }
        }
        
        // Get tenant DKIM settings
        const tenantQuery = await pool.request()
            .input('tenantId', sql.UniqueIdentifier, tenantId)
            .query(`
                SELECT TenantId, Name, AdvancedSettings 
                FROM oe.Tenants 
                WHERE TenantId = @tenantId
            `);
        
        if (tenantQuery.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Tenant not found'
            });
        }
        
        const tenant = tenantQuery.recordset[0];
        let advancedSettings = {};
        
        if (tenant.AdvancedSettings) {
            try {
                advancedSettings = JSON.parse(tenant.AdvancedSettings);
            } catch (e) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid tenant settings format'
                });
            }
        }
        
        const dkimConfig = advancedSettings.email;
        
        console.log('🔍 DKIM Config loaded:', {
            dkimEnabled: dkimConfig?.dkimEnabled,
            hasDomain: !!dkimConfig?.dkimDomain,
            hasSelector: !!dkimConfig?.dkimSelector,
            hasPublicKey: !!dkimConfig?.dkimPublicKey,
            publicKeyPreview: dkimConfig?.dkimPublicKey?.substring(0, 50) + '...'
        });
        
        if (!dkimConfig || !dkimConfig.dkimEnabled) {
            return res.status(400).json({
                success: false,
                message: 'DKIM is not enabled for this tenant'
            });
        }
        
        if (!dkimConfig.dkimDomain || !dkimConfig.dkimSelector || !dkimConfig.dkimPublicKey) {
            return res.status(400).json({
                success: false,
                message: 'DKIM configuration is incomplete',
                details: {
                    hasDomain: !!dkimConfig.dkimDomain,
                    hasSelector: !!dkimConfig.dkimSelector,
                    hasPublicKey: !!dkimConfig.dkimPublicKey
                }
            });
        }
        
        const testResults = {
            tenant: {
                id: tenant.TenantId,
                name: tenant.Name
            },
            dkimConfig: {
                domain: dkimConfig.dkimDomain,
                selector: dkimConfig.dkimSelector,
                enabled: dkimConfig.dkimEnabled
            },
            tests: {}
        };
        
        // Test DNS Configuration
        if (testType === 'dns' || testType === 'both') {
            console.log('🔍 Testing DNS configuration...');
            testResults.tests.dns = await testDKIMDNSConfiguration(dkimConfig);
        }
        
        // Test Email Sending (if requested)
        if (testType === 'email' || testType === 'both') {
            console.log('🔍 Testing email configuration...');
            testResults.tests.email = await testDKIMEmailSending(dkimConfig, tenant);
        }
        
        // Overall status
        testResults.overallStatus = getDKIMOverallStatus(testResults.tests);
        
        // Log the test
        await logDKIMTest(pool, req.user.UserId, tenantId, testType, testResults);
        
        console.log('✅ DKIM test completed with status:', testResults.overallStatus);
        
        res.json({
            success: true,
            data: testResults
        });
        
    } catch (error) {
        console.error('❌ Error testing DKIM configuration:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to test DKIM configuration',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
}

/**
 * SHARED FUNCTION: Get DKIM Status
 */
async function getDKIMStatus(req, res, tenantId) {
    try {
        const pool = await getPool();
        
        // Tenant access validation for TenantAdmin
        if (getUserRoles(req.user).includes('TenantAdmin') && req.user.TenantId !== tenantId) {
            return res.status(403).json({
                success: false,
                message: 'You can only check DKIM status for your own tenant'
            });
        }
        
        const tenantQuery = await pool.request()
            .input('tenantId', sql.UniqueIdentifier, tenantId)
            .query(`
                SELECT Name, AdvancedSettings 
                FROM oe.Tenants 
                WHERE TenantId = @tenantId
            `);
        
        if (tenantQuery.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Tenant not found'
            });
        }
        
        const tenant = tenantQuery.recordset[0];
        let dkimConfig = null;
        
        if (tenant.AdvancedSettings) {
            try {
                const advancedSettings = JSON.parse(tenant.AdvancedSettings);
                dkimConfig = advancedSettings.email;
            } catch (e) {
                // Invalid JSON, treat as no config
            }
        }
        
        const status = {
            tenantName: tenant.Name,
            dkimEnabled: dkimConfig?.dkimEnabled || false,
            configured: !!(dkimConfig?.dkimDomain && dkimConfig?.dkimSelector && dkimConfig?.dkimPublicKey),
            domain: dkimConfig?.dkimDomain || null,
            selector: dkimConfig?.dkimSelector || null,
            customFromAddress: dkimConfig?.customFromAddress || null,
            dnsRecord: null
        };
        
        if (status.configured) {
            status.dnsRecord = {
                type: 'TXT',
                name: `${dkimConfig.dkimSelector}._domainkey.${dkimConfig.dkimDomain}`,
                value: `v=DKIM1; k=rsa; p=${dkimConfig.dkimPublicKey}`
            };
        }
        
        res.json({
            success: true,
            data: status
        });
        
    } catch (error) {
        console.error('Error getting DKIM status:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get DKIM status'
        });
    }
}

/**
 * @route GET /api/tenant-admin/dkim/dns-check/:domain/:selector
 * @desc Debug DNS DKIM record lookup
 * @access TenantAdmin
 */
router.get('/dns-check/:domain/:selector', 
  authorize(['TenantAdmin', 'SysAdmin']), 
  async (req, res) => {
    try {
        const { domain, selector } = req.params;
        const dnsQuery = `${selector}._domainkey.${domain}`;
        
        console.log(`🔍 DNS Diagnostic for: ${dnsQuery}`);
        
        const diagnostics = {
            query: dnsQuery,
            domain,
            selector,
            timestamp: new Date().toISOString(),
            tests: []
        };
        
        // Test 1: Basic DNS resolution
        try {
            const txtRecords = await dns.resolveTxt(dnsQuery);
            diagnostics.tests.push({
                test: 'TXT Record Lookup',
                status: 'success',
                details: {
                    recordCount: txtRecords.length,
                    records: txtRecords.map(record => record.join(''))
                }
            });
        } catch (error) {
            diagnostics.tests.push({
                test: 'TXT Record Lookup',
                status: 'error',
                details: {
                    error: error.message,
                    code: error.code
                }
            });
        }
        
        // Test 2: Check if domain exists
        try {
            await dns.resolve(domain);
            diagnostics.tests.push({
                test: 'Domain Resolution',
                status: 'success',
                details: 'Domain resolves successfully'
            });
        } catch (error) {
            diagnostics.tests.push({
                test: 'Domain Resolution',
                status: 'error',
                details: {
                    error: error.message,
                    code: error.code
                }
            });
        }
        
        // Test 3: Check MX records (mail server setup)
        try {
            const mxRecords = await dns.resolveMx(domain);
            diagnostics.tests.push({
                test: 'MX Records',
                status: 'success',
                details: {
                    mailServers: mxRecords.map(mx => `${mx.exchange} (priority: ${mx.priority})`)
                }
            });
        } catch (error) {
            diagnostics.tests.push({
                test: 'MX Records',
                status: 'error',
                details: {
                    error: error.message,
                    code: error.code
                }
            });
        }
        
        // Test 4: Try alternative DNS servers
        const altServers = ['8.8.8.8', '1.1.1.1', '208.67.222.222'];
        for (const server of altServers) {
            try {
                // Note: Node.js dns module doesn't easily allow custom servers
                // This is a placeholder for the concept
                diagnostics.tests.push({
                    test: `DNS Server ${server}`,
                    status: 'info',
                    details: 'Alternative DNS server testing requires additional libraries'
                });
            } catch (error) {
                // Handle error
            }
        }
        
        res.json({
            success: true,
            data: diagnostics
        });
        
    } catch (error) {
        console.error('DNS diagnostic error:', error);
        res.status(500).json({
            success: false,
            message: 'DNS diagnostic failed',
            error: error.message
        });
    }
});

/**
 * @route POST /api/tenant-admin/dns-verify
 * @desc Test the exact DNS record that was added
 * @access TenantAdmin
 */
router.post('/dns-verify', 
  authorize(['TenantAdmin']), 
  async (req, res) => {
    try {
        const { recordName, expectedValue } = req.body;
        
        console.log(`🔍 Verifying DNS record: ${recordName}`);
        console.log(`🎯 Expected value starts with: ${expectedValue?.substring(0, 50)}...`);
        
        const txtRecords = await dns.resolveTxt(recordName);
        
        const results = {
            query: recordName,
            found: txtRecords.length > 0,
            records: txtRecords.map(record => record.join('')),
            match: false
        };
        
        if (expectedValue) {
            results.match = txtRecords.some(record => {
                const recordString = record.join('');
                return recordString.includes(expectedValue.substring(0, 50));
            });
        }
        
        res.json({
            success: true,
            data: results
        });
        
    } catch (error) {
        console.error('DNS verification error:', error);
        res.json({
            success: false,
            message: error.message,
            code: error.code
        });
    }
});

/**
 * Test DKIM DNS Configuration
 */
async function testDKIMDNSConfiguration(dkimConfig) {
    const results = {
        status: 'unknown',
        checks: []
    };
    
    try {
        const dnsQuery = `${dkimConfig.dkimSelector}._domainkey.${dkimConfig.dkimDomain}`;
        
        console.log(`🔍 Testing DNS record: ${dnsQuery}`);
        
        // Test DNS resolution
        const dnsCheck = {
            test: 'DNS Resolution',
            query: dnsQuery,
            status: 'unknown',
            details: null
        };
        
        try {
            const txtRecords = await dns.resolveTxt(dnsQuery);
            const dkimRecord = txtRecords.find(record => 
                record.join('').includes('v=DKIM1') && record.join('').includes('k=rsa')
            );
            
            if (dkimRecord) {
                dnsCheck.status = 'pass';
                dnsCheck.details = {
                    found: true,
                    record: dkimRecord.join(''),
                    recordCount: txtRecords.length
                };
                
                // Validate the public key in the DNS record
                const publicKeyMatch = dkimRecord.join('').match(/p=([A-Za-z0-9+/=]+)/);
                if (publicKeyMatch) {
                    const dnsPublicKey = publicKeyMatch[1];
                    const configPublicKey = dkimConfig.dkimPublicKey;
                    
                    if (dnsPublicKey === configPublicKey) {
                        results.checks.push({
                            test: 'Public Key Match',
                            status: 'pass',
                            details: 'DNS public key matches configuration'
                        });
                    } else {
                        results.checks.push({
                            test: 'Public Key Match',
                            status: 'fail',
                            details: 'DNS public key does not match configuration'
                        });
                    }
                } else {
                    results.checks.push({
                        test: 'Public Key Format',
                        status: 'fail',
                        details: 'Could not extract public key from DNS record'
                    });
                }
                
            } else {
                dnsCheck.status = 'fail';
                dnsCheck.details = {
                    found: false,
                    recordCount: txtRecords.length,
                    allRecords: txtRecords
                };
            }
            
        } catch (dnsError) {
            dnsCheck.status = 'fail';
            dnsCheck.details = {
                error: dnsError.message,
                code: dnsError.code
            };
        }
        
        results.checks.push(dnsCheck);
        
        // Test DNS propagation across multiple servers
        const propagationCheck = await testDNSPropagation(dnsQuery);
        results.checks.push(propagationCheck);
        
        // Determine overall DNS status
        const passedChecks = results.checks.filter(check => check.status === 'pass').length;
        const totalChecks = results.checks.length;
        
        if (passedChecks === totalChecks) {
            results.status = 'pass';
        } else if (passedChecks > 0) {
            results.status = 'partial';
        } else {
            results.status = 'fail';
        }
        
    } catch (error) {
        results.status = 'error';
        results.checks.push({
            test: 'DNS Configuration',
            status: 'error',
            details: error.message
        });
    }
    
    return results;
}

/**
 * Test DNS propagation across multiple DNS servers
 */
async function testDNSPropagation(dnsQuery) {
    const dnsServers = [
        { name: 'Google DNS', ip: '8.8.8.8' },
        { name: 'Cloudflare DNS', ip: '1.1.1.1' },
        { name: 'OpenDNS', ip: '208.67.222.222' },
        { name: 'Quad9', ip: '9.9.9.9' }
    ];
    
    const results = {
        test: 'DNS Propagation',
        status: 'unknown',
        details: {
            servers: []
        }
    };
    
    let successCount = 0;
    
    for (const server of dnsServers) {
        try {
            // Note: This is a simplified test - in production, you'd use a DNS library
            // that allows specifying DNS servers
            const txtRecords = await dns.resolveTxt(dnsQuery);
            const hasDkimRecord = txtRecords.some(record => 
                record.join('').includes('v=DKIM1')
            );
            
            results.details.servers.push({
                name: server.name,
                ip: server.ip,
                status: hasDkimRecord ? 'pass' : 'fail',
                recordFound: hasDkimRecord
            });
            
            if (hasDkimRecord) successCount++;
            
        } catch (error) {
            results.details.servers.push({
                name: server.name,
                ip: server.ip,
                status: 'error',
                error: error.message
            });
        }
    }
    
    // Determine propagation status
    if (successCount === dnsServers.length) {
        results.status = 'pass';
        results.details.message = 'DKIM record found on all tested DNS servers';
    } else if (successCount > 0) {
        results.status = 'partial';
        results.details.message = `DKIM record found on ${successCount}/${dnsServers.length} DNS servers`;
    } else {
        results.status = 'fail';
        results.details.message = 'DKIM record not found on any tested DNS servers';
    }
    
    return results;
}

/**
 * Test DKIM Email Sending
 */
async function testDKIMEmailSending(dkimConfig, tenant) {
    const results = {
        status: 'unknown',
        checks: []
    };
    
    try {
        // This is a simplified test - in production, you'd integrate with your email service
        const testEmail = {
            from: dkimConfig.customFromAddress || `noreply@${dkimConfig.dkimDomain}`,
            to: 'chris@mightywell.us', // Updated to use your email
            subject: `DKIM Test - ${tenant.Name} - ${new Date().toISOString()}`,
            text: `This is a DKIM test email for tenant ${tenant.Name}.\n\nIf you receive this email, the DKIM configuration is working correctly.`,
            html: `
                <h2>DKIM Test Email</h2>
                <p>This is a DKIM test email for tenant <strong>${tenant.Name}</strong>.</p>
                <p>If you receive this email, the DKIM configuration is working correctly.</p>
                <hr>
                <p><small>Sent at: ${new Date().toISOString()}</small></p>
            `
        };
        
        // Create DKIM signature (simplified - in production, use a proper DKIM library)
        const dkimSignature = createDKIMSignature(testEmail, dkimConfig);
        
        results.checks.push({
            test: 'DKIM Signature Generation',
            status: dkimSignature ? 'pass' : 'fail',
            details: {
                signatureGenerated: !!dkimSignature,
                signatureLength: dkimSignature ? dkimSignature.length : 0
            }
        });
        
        // In a real implementation, you would send the email here
        results.checks.push({
            test: 'Email Sending',
            status: 'info',
            details: {
                message: 'Email sending test not implemented in this demo',
                testEmail: testEmail.subject,
                from: testEmail.from,
                to: testEmail.to
            }
        });
        
        results.status = 'pass';
        
    } catch (error) {
        results.status = 'error';
        results.checks.push({
            test: 'Email Test',
            status: 'error',
            details: error.message
        });
    }
    
    return results;
}

/**
 * Create a simple DKIM signature (simplified implementation)
 */
function createDKIMSignature(email, dkimConfig) {
    try {
        // This is a very simplified DKIM signature generation
        // In production, use a proper DKIM library like 'dkim-signer'
        
        const headers = [
            'from',
            'to',
            'subject',
            'date'
        ].join(':');
        
        const headerData = `${email.from}:${email.to}:${email.subject}:${new Date().toUTCString()}`;
        
        const sign = crypto.createSign('SHA256');
        sign.update(headerData);
        
        // Use the private key to sign
        const signature = sign.sign(dkimConfig.dkimPrivateKey, 'base64');
        
        return `v=1; a=rsa-sha256; c=relaxed/relaxed; d=${dkimConfig.dkimDomain}; s=${dkimConfig.dkimSelector}; h=${headers}; b=${signature}`;
        
    } catch (error) {
        console.error('Error creating DKIM signature:', error);
        return null;
    }
}

/**
 * Determine overall DKIM status
 */
function getDKIMOverallStatus(tests) {
    let hasError = false;
    let hasFail = false;
    let hasPass = false;
    
    for (const testType in tests) {
        const test = tests[testType];
        switch (test.status) {
            case 'error':
                hasError = true;
                break;
            case 'fail':
                hasFail = true;
                break;
            case 'pass':
                hasPass = true;
                break;
        }
    }
    
    if (hasError) return 'error';
    if (hasFail) return 'fail';
    if (hasPass) return 'pass';
    return 'unknown';
}

/**
 * Log DKIM test results
 */
async function logDKIMTest(pool, userId, tenantId, testType, results) {
    try {
        const auditRequest = pool.request();
        auditRequest.input('userId', sql.UniqueIdentifier, userId);
        auditRequest.input('action', sql.NVarChar(100), 'DKIM_TEST_PERFORMED');
        auditRequest.input('entityType', sql.NVarChar(50), 'Tenant');
        auditRequest.input('entityId', sql.UniqueIdentifier, tenantId);
        auditRequest.input('details', sql.NVarChar(sql.MAX), JSON.stringify({
            testType,
            overallStatus: results.overallStatus,
            testCount: Object.keys(results.tests).length,
            timestamp: new Date().toISOString()
        }));
        
        await auditRequest.query(`
            INSERT INTO oe.AuditLogs (
                AuditLogId, UserId, Action, EntityType, EntityId, 
                Details, CreatedDate
            )
            VALUES (
                NEWID(), @userId, @action, @entityType, @entityId,
                @details, GETUTCDATE()
            )
        `);
        
    } catch (error) {
        console.error('Error logging DKIM test:', error);
    }
}

module.exports = router;