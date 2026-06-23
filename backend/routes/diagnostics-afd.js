const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const customDomainModule = require('./custom-domains');

const AZURE_CONFIG = customDomainModule.AZURE_CONFIG;
const getAzureAccessToken = customDomainModule.getAzureAccessToken;
const getAFDEndpoint = customDomainModule.getAFDEndpoint;

/**
 * GET /api/diagnostics/afd/route-config
 * Get detailed route configuration including custom domains and rule sets
 * Requires authentication (SysAdmin only)
 */
router.get('/route-config', authenticate, authorize(['SysAdmin']), async (req, res) => {
  try {
    const { domainName } = req.query; // e.g., "portal.mightywellhealth.com"
    
    if (!domainName) {
      return res.status(400).json({
        success: false,
        message: 'domainName query parameter is required (e.g., ?domainName=portal.mightywellhealth.com)'
      });
    }

    const accessToken = await getAzureAccessToken();
    
    // Get all custom domains
    const customDomainsUrl = `https://management.azure.com/subscriptions/${AZURE_CONFIG.subscriptionId}/resourceGroups/${AZURE_CONFIG.resourceGroup}/providers/Microsoft.Cdn/profiles/${AZURE_CONFIG.profileName}/customDomains?api-version=${AZURE_CONFIG.apiVersion}`;
    const customDomainsResponse = await fetch(customDomainsUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });
    const customDomainsData = await customDomainsResponse.json();
    
    // Find the specific domain
    const domain = customDomainsData.value?.find(d => d.properties?.hostName === domainName);
    
    if (!domain) {
      return res.status(404).json({
        success: false,
        message: `Domain ${domainName} not found in Azure Front Door`,
        availableDomains: customDomainsData.value?.map(d => ({
          name: d.name,
          hostName: d.properties?.hostName,
          provisioningState: d.properties?.provisioningState,
          domainValidationState: d.properties?.domainValidationState,
          endpointAssociation: d.properties?.endpointAssociation
        })) || []
      });
    }

    // Get endpoint
    const endpoint = await getAFDEndpoint(accessToken);
    
    // Get all routes
    const routesUrl = `https://management.azure.com/subscriptions/${AZURE_CONFIG.subscriptionId}/resourceGroups/${AZURE_CONFIG.resourceGroup}/providers/Microsoft.Cdn/profiles/${AZURE_CONFIG.profileName}/afdEndpoints/${endpoint.name}/routes?api-version=${AZURE_CONFIG.apiVersion}`;
    const routesResponse = await fetch(routesUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });
    const routesData = await routesResponse.json();
    
    // Find routes that include this domain
    const routesWithDomain = [];
    for (const route of routesData.value || []) {
      const customDomains = route.properties?.customDomains || [];
      const hasDomain = customDomains.some(cd => cd.id === domain.id);
      
      if (hasDomain) {
        routesWithDomain.push({
          name: route.name,
          id: route.id,
          customDomains: customDomains.map(cd => ({
            id: cd.id,
            name: cd.id.split('/').pop()
          })),
          ruleSets: route.properties?.ruleSets || [],
          originGroup: route.properties?.originGroup?.id,
          patternsToMatch: route.properties?.patternsToMatch,
          forwardingProtocol: route.properties?.forwardingProtocol,
          httpsRedirect: route.properties?.httpsRedirect,
          enabledState: route.properties?.enabledState,
          provisioningState: route.properties?.provisioningState
        });
      }
    }

    // Get all rule sets
    const ruleSetsUrl = `https://management.azure.com/subscriptions/${AZURE_CONFIG.subscriptionId}/resourceGroups/${AZURE_CONFIG.resourceGroup}/providers/Microsoft.Cdn/profiles/${AZURE_CONFIG.profileName}/ruleSets?api-version=${AZURE_CONFIG.apiVersion}`;
    const ruleSetsResponse = await fetch(ruleSetsUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });
    const ruleSetsData = await ruleSetsResponse.json();
    
    // Find rule sets that might be related to this domain
    const domainNameForRuleSet = domainName.split('.')[0]; // e.g., "portal" from "portal.mightywellhealth.com"
    const relatedRuleSets = (ruleSetsData.value || []).filter(rs => 
      rs.name.toLowerCase().includes(domainNameForRuleSet.toLowerCase()) ||
      rs.name.toLowerCase().includes(domainName.split('.')[1]?.split('.')[0] || '') // e.g., "mightywellhealth"
    );

    res.json({
      success: true,
      data: {
        domain: {
          name: domain.name,
          id: domain.id,
          hostName: domain.properties?.hostName,
          provisioningState: domain.properties?.provisioningState,
          domainValidationState: domain.properties?.domainValidationState,
          endpointAssociation: domain.properties?.endpointAssociation,
          deploymentStatus: domain.properties?.deploymentStatus,
          tlsSettings: domain.properties?.tlsSettings
        },
        endpoint: {
          name: endpoint.name,
          hostName: endpoint.properties?.hostName,
          enabledState: endpoint.properties?.enabledState,
          provisioningState: endpoint.properties?.provisioningState
        },
        routes: routesWithDomain,
        relatedRuleSets: relatedRuleSets.map(rs => ({
          name: rs.name,
          id: rs.id,
          provisioningState: rs.properties?.provisioningState,
          rules: rs.properties?.rules?.map(r => ({
            name: r.name,
            order: r.order,
            conditions: r.conditions,
            actions: r.actions
          })) || []
        })),
        issues: {
          domainNotAssociated: routesWithDomain.length === 0,
          ruleSetsNotLinked: routesWithDomain.some(r => r.ruleSets.length === 0),
          missingRuleSet: relatedRuleSets.length === 0
        }
      }
    });
  } catch (error) {
    console.error('❌ Error getting Azure Front Door route config:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to get Azure Front Door configuration'
    });
  }
});

module.exports = router;

