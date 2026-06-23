const express = require('express');
const router = express.Router();
const { authorize } = require('../middleware/auth');
const dns = require('dns').promises;

const FRONTDOOR_ENDPOINT_HOSTNAME = process.env.FRONTDOOR_ENDPOINT_HOSTNAME || 'appProd-cfabd0fmcmf7adec.z01.azurefd.net';
const PRIMARY_CUSTOM_DOMAIN = process.env.PRIMARY_CUSTOM_DOMAIN || 'app.allaboard365.com';
const EXPECTED_CNAME_TARGETS = [
  FRONTDOOR_ENDPOINT_HOSTNAME.toLowerCase(),
  PRIMARY_CUSTOM_DOMAIN.toLowerCase()
];

// POST /api/tenants/:id/domain/verify
// Verify domain ownership and configuration
router.post('/:id/domain/verify', 
  authorize(['SysAdmin', 'TenantAdmin']), 
  async (req, res) => {
    try {
      const { id } = req.params;
      const { domain, subdomain } = req.body;
      
      console.log(`🔍 Domain verification request for tenant ${id}`);
      console.log(`🌐 Domain: ${subdomain}.${domain}`);
      
      // Basic validation
      if (!domain || !subdomain) {
        return res.status(400).json({
          success: false,
          message: 'Domain and subdomain are required'
        });
      }
      
      const fullDomain = `${subdomain}.${domain}`;
      
      console.log(`🔍 Starting DNS verification for ${fullDomain}`);
      
      // Resolve reference endpoints to gather valid IPs
      const referenceIPs = new Set();
      for (const referenceHost of [FRONTDOOR_ENDPOINT_HOSTNAME, PRIMARY_CUSTOM_DOMAIN]) {
        try {
          const records = await dns.resolve4(referenceHost);
          records.forEach(ip => referenceIPs.add(ip));
          console.log(`📍 ${referenceHost} resolves to: ${records.join(', ')}`);
        } catch (error) {
          console.warn(`⚠️ Failed to resolve ${referenceHost}:`, error.message);
        }
      }

      if (referenceIPs.size === 0) {
        console.error('❌ Unable to resolve any reference Front Door endpoints');
        return res.status(500).json({
          success: false,
          message: 'Unable to verify domain - could not resolve Azure Front Door reference host'
        });
      }

      const referenceIPExample = Array.from(referenceIPs)[0];
      
      // Check if the custom domain resolves to the same IP
      let customDomainIP;
      let cnameRecord;
      let verificationResult;
      
      try {
        // First try to resolve the custom domain directly
        try {
          const customDomainRecords = await dns.resolve4(fullDomain);
          customDomainIP = customDomainRecords[0];
          console.log(`📍 ${fullDomain} resolves to: ${customDomainIP}`);
        } catch (ipError) {
          // If direct IP resolution fails, check for CNAME record
          try {
            const cnameRecords = await dns.resolveCname(fullDomain);
            cnameRecord = cnameRecords[0];
            console.log(`🔗 ${fullDomain} has CNAME record pointing to: ${cnameRecord}`);
            
            // Check if CNAME points to expected Front Door endpoints
            if (EXPECTED_CNAME_TARGETS.includes(cnameRecord.toLowerCase())) {
              customDomainIP = customDomainIP || referenceIPExample;
              console.log(`✅ CNAME record correctly points to an approved Front Door endpoint (${cnameRecord})`);
            } else {
              console.log(`❌ CNAME record points to ${cnameRecord}, expected ${FRONTDOOR_ENDPOINT_HOSTNAME}`);
            }
          } catch (cnameError) {
            console.log(`❌ No CNAME record found for ${fullDomain}`);
          }
        }
        
        // Verify the IP addresses match any known Front Door IP
        const ipMatch = customDomainIP && referenceIPs.has(customDomainIP);
        
        if (ipMatch) {
          verificationResult = {
            success: true,
            message: 'Domain verified successfully! Your custom domain is now active.',
            details: {
              dnsRecords: {
                cname: cnameRecord ? {
                  name: fullDomain,
                  value: cnameRecord,
                  status: 'verified'
                } : {
                  name: fullDomain,
                  value: 'Direct A record',
                  status: 'verified'
                },
                ip: {
                  customDomain: customDomainIP,
                  referenceDomain: referenceIPExample,
                  status: 'verified'
                }
              },
              ssl: {
                status: 'pending',
                certificate: 'not_installed',
                note: 'SSL certificate will be provisioned automatically'
              }
            }
          };
        } else {
          verificationResult = {
            success: false,
            message: 'Domain verification failed. Please ensure your DNS records are configured correctly.',
            details: {
              dnsRecords: {
                cname: cnameRecord ? {
                  name: fullDomain,
                  value: cnameRecord,
                  status: 'incorrect'
                } : {
                  name: fullDomain,
                  value: 'No CNAME record found',
                  status: 'missing'
                },
                ip: {
                  customDomain: customDomainIP || 'Not resolved',
                  referenceDomain: referenceIPExample,
                  status: 'mismatch'
                }
              },
              instructions: {
                cname: `Create a CNAME record: ${subdomain} → ${FRONTDOOR_ENDPOINT_HOSTNAME} (or ${PRIMARY_CUSTOM_DOMAIN})`,
                a: `Or create an A record: ${subdomain} → ${referenceIPExample}`
              }
            }
          };
        }
        
      } catch (error) {
        console.error(`❌ DNS verification error for ${fullDomain}:`, error);
        verificationResult = {
          success: false,
          message: 'Domain verification failed. Please check your DNS settings and try again.',
          details: {
            error: error.message,
            dnsRecords: {
              cname: {
                name: fullDomain,
                value: 'DNS lookup failed',
                status: 'error'
              }
            }
          }
        };
      }
      
      console.log(`✅ Domain verification completed for ${fullDomain}:`, verificationResult.success ? 'SUCCESS' : 'FAILED');
      
      res.json({
        success: verificationResult.success,
        data: {
          domain: fullDomain,
          subdomain,
          baseDomain: domain,
          verificationStatus: verificationResult.success ? 'verified' : 'failed',
          message: verificationResult.message,
          details: verificationResult.details
        }
      });
      
    } catch (error) {
      console.error('❌ Error verifying domain:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error during domain verification',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  }
);

module.exports = router;
