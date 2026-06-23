const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const { getPool, sql } = require('../config/database');

// Azure Front Door configuration (from .env only; no fallbacks)
const AZURE_CONFIG = {
  tenantId: process.env.AZURE_TENANT_ID,
  clientId: process.env.AZURE_CLIENT_ID,
  clientSecret: process.env.AZURE_CLIENT_SECRET,
  subscriptionId: process.env.AZURE_SUBSCRIPTION_ID,
  resourceGroup: process.env.FRONTDOOR_RESOURCE_GROUP,
  profileName: process.env.FRONTDOOR_PROFILE_NAME,
  endpointName: process.env.FRONTDOOR_ENDPOINT_NAME,
  endpointHostName: process.env.FRONTDOOR_ENDPOINT_HOSTNAME,
  originGroupName: process.env.FRONTDOOR_ORIGIN_GROUP,
  preferredRouteNames: [
    'default-route',
    'appProd-cfabd0fmcmf7adec',
    'app-prod',
    'appprod',
    'appRoute',
    'app-route',
    'approute',
    'app'
  ],
  apiVersion: '2024-02-01'
};

let resolvedEndpointName = AZURE_CONFIG.endpointName;

function getEffectiveEndpointName() {
  return resolvedEndpointName || AZURE_CONFIG.endpointName;
}

function buildCustomDomainName(domainName, subdomainOption) {
  const baseDomain = domainName.split('.')[0];
  let firstWord = baseDomain;

  if (baseDomain.includes('health')) {
    firstWord = baseDomain.replace('health', '');
  } else if (baseDomain.includes('well')) {
    firstWord = baseDomain.replace('well', '');
  } else if (baseDomain.length > 8) {
    firstWord = baseDomain.substring(0, Math.min(10, baseDomain.length));
  }

  return `${firstWord}-${subdomainOption}`;
}

/**
 * Step 1: Get Azure access token
 */
async function getAzureAccessToken() {
  try {
    const response = await fetch('https://login.microsoftonline.com/' + AZURE_CONFIG.tenantId + '/oauth2/v2.0/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: AZURE_CONFIG.clientId,
        client_secret: AZURE_CONFIG.clientSecret,
        scope: 'https://management.azure.com/.default',
        grant_type: 'client_credentials'
      })
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(`Azure auth failed: ${data.error_description || data.error}`);
    }

    return data.access_token;
  } catch (error) {
    console.error('Error getting Azure access token:', error);
    throw error;
  }
}

/**
 * Step 2: Create custom domain in Azure Front Door
 */
async function createCustomDomain(accessToken, domainName, subdomainOption) {
  const customDomainName = buildCustomDomainName(domainName, subdomainOption);
  const fullDomain = `${subdomainOption}.${domainName}`;

  // Log which Azure target we are using (to debug "already exists" vs 404)
  console.log('🔧 Creating custom domain:', { customDomainName, fullDomain, domainName, subdomainOption });
  console.log('🔧 Azure target:', {
    subscriptionId: AZURE_CONFIG.subscriptionId,
    resourceGroup: AZURE_CONFIG.resourceGroup,
    profileName: AZURE_CONFIG.profileName
  });

  try {
    // Create the domain
    const response = await fetch(
      `https://management.azure.com/subscriptions/${AZURE_CONFIG.subscriptionId}/resourceGroups/${AZURE_CONFIG.resourceGroup}/providers/Microsoft.Cdn/profiles/${AZURE_CONFIG.profileName}/customDomains/${customDomainName}?api-version=${AZURE_CONFIG.apiVersion}`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          properties: {
            hostName: fullDomain,
            tlsSettings: {
              certificateType: 'ManagedCertificate',
              minimumTlsVersion: 'TLS12'
            }
          }
        })
      }
    );

    const data = await response.json();
    if (!response.ok) {
      const errMsg = data.error?.message || 'Unknown error';
      const errCode = data.error?.code || response.status;
      console.error('Azure create custom domain response:', { status: response.status, errorCode: data.error?.code, errorMessage: errMsg, fullError: data.error });
      throw new Error(`Azure Front Door domain creation failed: ${errMsg}`);
    }

    return data;
  } catch (error) {
    console.error('Error creating custom domain:', error);
    throw error;
  }
}

/**
 * Get existing custom domain from Azure Front Door
 */
async function getCustomDomain(accessToken, domainName, subdomainOption) {
  const customDomainName = buildCustomDomainName(domainName, subdomainOption);
  
  console.log('🔍 Looking for custom domain:', { customDomainName, domainName, subdomainOption });
  
  try {
    const response = await fetch(
      `https://management.azure.com/subscriptions/${AZURE_CONFIG.subscriptionId}/resourceGroups/${AZURE_CONFIG.resourceGroup}/providers/Microsoft.Cdn/profiles/${AZURE_CONFIG.profileName}/customDomains/${customDomainName}?api-version=${AZURE_CONFIG.apiVersion}`,
      {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const data = await response.json();
    
    if (response.status === 404) {
      console.log('❌ Custom domain not found (404):', customDomainName);
      return null; // Domain doesn't exist
    }

    if (!response.ok) {
      console.error('❌ Azure API error:', {
        status: response.status,
        statusText: response.statusText,
        error: data,
        url: `https://management.azure.com/subscriptions/${AZURE_CONFIG.subscriptionId}/resourceGroups/${AZURE_CONFIG.resourceGroup}/providers/Microsoft.Cdn/profiles/${AZURE_CONFIG.profileName}/customDomains/${customDomainName}`
      });
      throw new Error(`Failed to get custom domain: ${data.error?.message || data.message || 'Unknown error'}`);
    }

    console.log('✅ Custom domain found:', customDomainName);
    return data;
  } catch (error) {
    if (error.message.includes('404') || error.message.includes('Not Found')) {
      return null; // Domain doesn't exist
    }
    console.error('Error getting custom domain:', error);
    throw error;
  }
}

async function refreshValidationToken(accessToken, domainName, subdomainOption) {
  try {
    const customDomainName = buildCustomDomainName(domainName, subdomainOption);
    const url = `https://management.azure.com/subscriptions/${AZURE_CONFIG.subscriptionId}/resourceGroups/${AZURE_CONFIG.resourceGroup}/providers/Microsoft.Cdn/profiles/${AZURE_CONFIG.profileName}/customDomains/${customDomainName}/refreshValidationToken?api-version=${AZURE_CONFIG.apiVersion}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(`Failed to refresh validation token: ${data.error?.message || 'Unknown error'}`);
    }

    return data;
  } catch (error) {
    console.error('Error refreshing validation token:', error);
    throw error;
  }
}

async function fetchTenantAdvancedSettings(pool, tenantId) {
  const tenantResult = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .query('SELECT AdvancedSettings FROM oe.Tenants WHERE TenantId = @tenantId');

  if (tenantResult.recordset.length === 0) {
    return {};
  }

  const rawSettings = tenantResult.recordset[0].AdvancedSettings;
  if (!rawSettings) {
    return {};
  }

  try {
    return JSON.parse(rawSettings);
  } catch (error) {
    console.warn('⚠️ Invalid AdvancedSettings JSON, resetting structure');
    return {};
  }
}

async function saveTenantAdvancedSettings(pool, tenantId, advancedSettings) {
  await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('advancedSettings', sql.NVarChar, JSON.stringify(advancedSettings))
    .query('UPDATE oe.Tenants SET AdvancedSettings = @advancedSettings WHERE TenantId = @tenantId');
}
/**
 * Update tenant's verification status in database
 */
async function updateTenantVerificationStatus(tenantId, status, hostName, extraUpdates = {}) {
  try {
    const pool = await getPool();
    const advancedSettings = await fetchTenantAdvancedSettings(pool, tenantId);

    const domainSettings = advancedSettings.domain || {};
    const timestamp = new Date().toISOString();

    if (hostName) {
      domainSettings.hostName = hostName;
    }

    if (!domainSettings.createdAt && extraUpdates.createdAt === undefined) {
      domainSettings.createdAt = timestamp;
    }

    if (extraUpdates.createdAt !== undefined) {
      domainSettings.createdAt = extraUpdates.createdAt;
    }

    domainSettings.verificationStatus = status;
    domainSettings.statusUpdatedAt = timestamp;
    domainSettings.verifiedAt = status === 'verified' ? timestamp : null;

    Object.entries(extraUpdates || {}).forEach(([key, value]) => {
      if (value !== undefined) {
        domainSettings[key] = value;
      }
    });

    if (extraUpdates.lastUpdated !== undefined) {
      domainSettings.lastUpdated = extraUpdates.lastUpdated;
    } else {
      domainSettings.lastUpdated = timestamp;
    }

    advancedSettings.domain = domainSettings;
    await saveTenantAdvancedSettings(pool, tenantId, advancedSettings);

    console.log(`✅ Updated tenant verification status: ${status} for ${hostName}`);
  } catch (error) {
    console.error('❌ Error updating tenant verification status:', error);
  }
}

/**
 * Step 3: Get AFD endpoint hostname for CNAME
 */
async function getAFDEndpoint(accessToken) {
  try {
    const baseUrl = `https://management.azure.com/subscriptions/${AZURE_CONFIG.subscriptionId}/resourceGroups/${AZURE_CONFIG.resourceGroup}/providers/Microsoft.Cdn`;
    const endpointUrl = `${baseUrl}/profiles/${AZURE_CONFIG.profileName}/afdEndpoints/${getEffectiveEndpointName()}?api-version=${AZURE_CONFIG.apiVersion}`;

    let response = await fetch(endpointUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    let data = await response.json();

    if (!response.ok) {
      // If the endpoint isn't found, list all endpoints and try to match by name/host name (case-insensitive)
      if (response.status === 404) {
        console.warn(`⚠️ Endpoint ${AZURE_CONFIG.endpointName} not found directly. Listing available endpoints...`);

        const listResponse = await fetch(`${baseUrl}/profiles/${AZURE_CONFIG.profileName}/afdEndpoints?api-version=${AZURE_CONFIG.apiVersion}`, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          }
        });

        const listData = await listResponse.json();
        if (listResponse.ok && Array.isArray(listData.value)) {
          const normalizedTargetName = (AZURE_CONFIG.endpointName || '').toLowerCase();
          const normalizedTargetHost = (AZURE_CONFIG.endpointHostName || '').toLowerCase();

          const matchedEndpoint = listData.value.find((endpoint) => {
            const endpointName = (endpoint.name || '').toLowerCase();
            const endpointHost = (endpoint.properties?.hostName || '').toLowerCase();
            return endpointName === normalizedTargetName || endpointHost === normalizedTargetHost;
          });

          if (matchedEndpoint) {
            resolvedEndpointName = matchedEndpoint.name || resolvedEndpointName;
            console.log('✅ Got AFD endpoint via list:', {
              name: matchedEndpoint.name,
              hostName: matchedEndpoint.properties?.hostName
            });
            return matchedEndpoint;
          }

          console.warn('⚠️ Available endpoints:', listData.value.map(ep => ({
            name: ep.name,
            hostName: ep.properties?.hostName
          })));
        } else {
          console.warn('⚠️ Unable to list AFD endpoints:', listData);
        }
      }

      throw new Error(`Failed to get AFD endpoint: ${data.error?.message || 'Unknown error'}`);
    }

    resolvedEndpointName = data.name || resolvedEndpointName;
    console.log('✅ Got AFD endpoint:', {
      name: data.name,
      hostName: data.properties?.hostName
    });
    return data;
  } catch (error) {
    console.error('Error getting AFD endpoint:', error);
    throw error;
  }
}

/**
 * Step 5: Fetch the app routes in Front Door endpoint
 */
async function getAppRoutes(accessToken) {
  try {
    const response = await fetch(
      `https://management.azure.com/subscriptions/${AZURE_CONFIG.subscriptionId}/resourceGroups/${AZURE_CONFIG.resourceGroup}/providers/Microsoft.Cdn/profiles/${AZURE_CONFIG.profileName}/afdEndpoints/${getEffectiveEndpointName()}/routes?api-version=${AZURE_CONFIG.apiVersion}`,
      {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const data = await response.json();
    if (!response.ok) {
      throw new Error(`Failed to get app routes: ${data.error?.message || 'Unknown error'}`);
    }

    return data.value; // Azure returns routes in the 'value' property
  } catch (error) {
    console.error('Error getting app routes:', error);
    throw error;
  }
}

/**
 * Step 6: Patch the app routes to include the new domain name
 */
async function patchAppRoutes(accessToken, customDomainId, routeName) {
  try {
    const response = await fetch(
      `https://management.azure.com/subscriptions/${AZURE_CONFIG.subscriptionId}/resourceGroups/${AZURE_CONFIG.resourceGroup}/providers/Microsoft.Cdn/profiles/${AZURE_CONFIG.profileName}/afdEndpoints/${AZURE_CONFIG.endpointName}/routes/${routeName}?api-version=${AZURE_CONFIG.apiVersion}`,
      {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          properties: {
            customDomains: [
              {
                id: customDomainId
              }
            ]
          }
        })
      }
    );

    const data = await response.json();
    if (!response.ok) {
      throw new Error(`Failed to patch app routes: ${data.error?.message || 'Unknown error'}`);
    }

    return data;
  } catch (error) {
    console.error('Error patching app routes:', error);
    throw error;
  }
}

/**
 * Step 7: Create Rule Set
 */

/**
 * Step 8A: Get the actual domain resource ID from Azure
 */
async function getDomainResourceId(accessToken, domainName, subdomainOption) {
  try {
    console.log('🔍 Step 8A: Getting domain resource ID...');
    
    // Construct the full domain name (e.g., "portal.sharewellpartners.com")
    const fullDomain = `${subdomainOption}.${domainName}`;
    
    const url = `https://management.azure.com/subscriptions/${AZURE_CONFIG.subscriptionId}/resourceGroups/${AZURE_CONFIG.resourceGroup}/providers/Microsoft.Cdn/profiles/${AZURE_CONFIG.profileName}/customDomains?api-version=${AZURE_CONFIG.apiVersion}`;
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    const responseData = await response.json();
    
    if (!response.ok) {
      console.error('❌ Failed to get domain list:', responseData);
      throw new Error(`Failed to get domain list: ${responseData.error?.message || response.statusText}`);
    }

    // Find the domain by full hostName (e.g., "portal.sharewellpartners.com")
    const domain = responseData.value?.find(d => d.properties?.hostName === fullDomain);
    if (!domain) {
      console.error('❌ Available domains:', responseData.value?.map(d => ({ name: d.name, hostName: d.properties?.hostName })));
      throw new Error(`Domain with hostName ${fullDomain} not found in Azure Front Door`);
    }

    console.log('✅ Found domain resource ID:', domain.id);
    return domain.id;
    
  } catch (error) {
    console.error('❌ Error getting domain resource ID:', error);
    throw error;
  }
}

/**
 * Step 8B: GET current route to preserve existing domain associations
 */
async function getCurrentRoute(accessToken, preferredRouteName) {
  try {
    console.log('🔍 Step 8B: Getting current route configuration...');

    const routes = await getAppRoutes(accessToken);
    if (!Array.isArray(routes) || routes.length === 0) {
      throw new Error('No routes found in Azure Front Door endpoint');
    }

    const preferredNames = (AZURE_CONFIG.preferredRouteNames || [])
      .map(name => name.toLowerCase());
    if (preferredRouteName) {
      preferredNames.unshift(preferredRouteName.toLowerCase());
    }
    const effectiveEndpointName = getEffectiveEndpointName();
    if (effectiveEndpointName) {
      preferredNames.push(effectiveEndpointName.toLowerCase());
    }

    let targetRoute = routes.find(route => {
      const routeName = route.name || (route.id ? route.id.split('/').pop() : '');
      return routeName && preferredNames.includes(routeName.toLowerCase());
    });

    if (!targetRoute && AZURE_CONFIG.originGroupName) {
      targetRoute = routes.find(route =>
        route.properties?.originGroup?.id?.toLowerCase()
          ?.includes(`/${AZURE_CONFIG.originGroupName.toLowerCase()}`)
      );
    }

    if (!targetRoute) {
      targetRoute = routes[0];
    }

    const routeName = targetRoute.name || (targetRoute.id ? targetRoute.id.split('/').pop() : null);
    if (!routeName) {
      throw new Error('Unable to determine Azure Front Door route name');
    }

    const url = `https://management.azure.com/subscriptions/${AZURE_CONFIG.subscriptionId}/resourceGroups/${AZURE_CONFIG.resourceGroup}/providers/Microsoft.Cdn/profiles/${AZURE_CONFIG.profileName}/afdendpoints/${getEffectiveEndpointName()}/routes/${routeName}?api-version=${AZURE_CONFIG.apiVersion}`;
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    const responseData = await response.json();
    
    if (!response.ok) {
      console.error('❌ Failed to get current route:', responseData);
      throw new Error(`Failed to get current route: ${responseData.error?.message || response.statusText}`);
    }

    console.log('✅ Current route retrieved successfully:', routeName);
    return {
      route: responseData,
      routeName
    };
    
  } catch (error) {
    console.error('❌ Error getting current route:', error);
    throw error;
  }
}

/**
 * Step 8C: PATCH route to associate domain (merge-safe)
 */
async function associateDomainWithEndpoint(accessToken, domainName, subdomainOption) {
  try {
    console.log('🔗 Step 8: Associating domain with endpoint and routes...');
    
    // Ensure we have the latest endpoint name resolved before working with routes
    await getAFDEndpoint(accessToken);
    
    // Step 8A: Get the actual domain resource ID
    const domainResourceId = await getDomainResourceId(accessToken, domainName, subdomainOption);
    
    // Step 8B: Ensure custom route includes the domain reference (merge-safe)
    const { route: currentRoute, routeName } = await getCurrentRoute(accessToken);
    console.log('🔍 Route retrieved for domain association:', routeName);

    const routeUrl = `https://management.azure.com/subscriptions/${AZURE_CONFIG.subscriptionId}/resourceGroups/${AZURE_CONFIG.resourceGroup}/providers/Microsoft.Cdn/profiles/${AZURE_CONFIG.profileName}/afdendpoints/${getEffectiveEndpointName()}/routes/${routeName}?api-version=${AZURE_CONFIG.apiVersion}`;
    const existingRouteDomains = currentRoute.properties?.customDomains?.map(domain => domain.id) || [];
    const mergedRouteDomains = Array.from(new Set([...existingRouteDomains, domainResourceId]));

    // Ensure globalRules rule set is always included (merge-safe)
    const globalRulesId = `/subscriptions/${AZURE_CONFIG.subscriptionId}/resourceGroups/${AZURE_CONFIG.resourceGroup}/providers/Microsoft.Cdn/profiles/${AZURE_CONFIG.profileName}/ruleSets/globalRules`;
    const existingRuleSets = currentRoute.properties?.ruleSets?.map(rs => rs.id) || [];
    const hasGlobalRules = existingRuleSets.some(id => id.toLowerCase() === globalRulesId.toLowerCase());
    const mergedRuleSets = Array.from(new Set([...existingRuleSets, globalRulesId]));
    
    if (!hasGlobalRules) {
      console.log('✅ Adding globalRules rule set to route (for CORS support)');
    } else {
      console.log('✅ Route already has globalRules rule set');
    }

    const routeRequestBody = {
      properties: {
        ...currentRoute.properties,
        customDomains: mergedRouteDomains.map(id => ({ id })),
        ruleSets: mergedRuleSets.map(id => ({ id }))
      }
    };

    delete routeRequestBody.properties?.id;
    delete routeRequestBody.properties?.resourceState;
    delete routeRequestBody.properties?.deploymentStatus;
    delete routeRequestBody.properties?.provisioningState;

    console.log(`🔗 PATCH route to include custom domain: ${routeUrl}`);

    const routeResponse = await fetch(routeUrl, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(routeRequestBody)
    });

    if (!routeResponse.ok) {
      const err = await routeResponse.text();
      console.error('❌ Route association failed:', err);
      throw new Error(`Route association failed: ${routeResponse.status} ${err}`);
    }

    console.log('✅ Route patch accepted. Domain now associated with the route.');

    // Step 8C: Verify the association on the route
    const refreshedRoute = await getCurrentRoute(accessToken, routeName);
    const associatedDomains = refreshedRoute.route.properties?.customDomains || [];
    const isAssociated = associatedDomains.some(domain => domain.id === domainResourceId);

    console.log('🔍 Route association verification:', {
      domainResourceId,
      associatedDomains: associatedDomains.map(d => d.id),
      isAssociated
    });

    return {
      success: isAssociated,
      associationStatus: {
        endpointAssociation: isAssociated ? 'Associated' : 'Unassociated',
        provisioningState: refreshedRoute.route.properties?.provisioningState,
        deploymentStatus: refreshedRoute.route.properties?.deploymentStatus
      },
      route: refreshedRoute.route,
      routeName,
      endpointName: getEffectiveEndpointName()
    };
    
  } catch (error) {
    console.error('❌ Error associating domain with endpoint:', error);
    throw error;
  }
}
async function createRuleSet(accessToken, customDomainName, fullDomain) {
  try {
    const response = await fetch(
      `https://management.azure.com/subscriptions/${AZURE_CONFIG.subscriptionId}/resourceGroups/${AZURE_CONFIG.resourceGroup}/providers/Microsoft.Cdn/profiles/${AZURE_CONFIG.profileName}/ruleSets/${customDomainName}?api-version=${AZURE_CONFIG.apiVersion}`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          properties: {
            rules: [
              {
                name: "RedirectRoot",
                order: 1,
                conditions: [
                  {
                    name: "HostName",
                    parameters: {
                      operator: "Equal",
                      matchValues: [fullDomain]
                    }
                  }
                ],
                actions: [
                  {
                    name: "UrlRewrite",
                    parameters: {
                      sourcePattern: "/",
                      destination: "/clientLanding",
                      preserveUnmatchedPath: true
                    }
                  }
                ]
              }
            ]
          }
        })
      }
    );

    const data = await response.json();
    if (!response.ok) {
      throw new Error(`Failed to create rule set: ${data.error?.message || 'Unknown error'}`);
    }

    return data;
  } catch (error) {
    console.error('Error creating rule set:', error);
    throw error;
  }
}

/**
 * @route   POST /api/custom-domains/configure
 * @desc    Configure custom domain in Azure Front Door
 * @access  Private (TenantAdmin, SysAdmin)
 */
router.post('/configure', authenticate, authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const { tenantId, subdomainOption, domainName } = req.body;

    if (!tenantId || !subdomainOption || !domainName) {
      return res.status(400).json({
        success: false,
        message: 'TenantId, subdomainOption, and domainName are required'
      });
    }

    if (!['app', 'portal', 'enroll'].includes(subdomainOption)) {
      return res.status(400).json({
        success: false,
        message: 'subdomainOption must be one of: app, portal, enroll'
      });
    }

    console.log('🔧 Configuring custom domain:', { tenantId, subdomainOption, domainName });

    // Check if tenant already has a custom domain configured
    const pool = await getPool();
    
    const tenantResult = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .query('SELECT CustomDomain FROM oe.Tenants WHERE TenantId = @tenantId');

    if (tenantResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Tenant not found'
      });
    }

    const existingCustomDomain = tenantResult.recordset[0].CustomDomain;
    const newFullDomain = `${subdomainOption}.${domainName}`;

    // If tenant already has a custom domain and it's different from the new one
    if (existingCustomDomain && existingCustomDomain !== newFullDomain) {
      return res.status(400).json({
        success: false,
        message: `Domain is already configured. Current domain: ${existingCustomDomain}. Please delete the current domain before configuring a new one.`
      });
    }

    // If the domain is the same, return DNS records so the UI can show them after refresh
    if (existingCustomDomain === newFullDomain) {
      console.log('✅ Custom domain already configured for tenant:', existingCustomDomain);
      const responseData = {
        hostName: existingCustomDomain,
        isExisting: true,
        needsVerification: true
      };
      try {
        const accessToken = await getAzureAccessToken();
        const afdEndpoint = await getAFDEndpoint(accessToken);
        const cnameRecord = {
          name: subdomainOption,
          value: afdEndpoint.properties?.hostName || AZURE_CONFIG.endpointHostName
        };
        responseData.cname = cnameRecord;
        let domainResult = await getCustomDomain(accessToken, domainName, subdomainOption);
        let validationToken = domainResult?.properties?.validationProperties?.validationToken;
        if (!validationToken) {
          try {
            const refreshed = await refreshValidationToken(accessToken, domainName, subdomainOption);
            validationToken = refreshed?.properties?.validationProperties?.validationToken;
          } catch (e) {
            console.warn('Could not refresh validation token for existing domain:', e.message);
          }
        }
        if (validationToken) {
          responseData.txt = {
            name: `_dnsauth.${subdomainOption}`,
            value: validationToken
          };
        }
      } catch (dnsErr) {
        console.warn('Could not fetch DNS records for existing domain:', dnsErr.message);
      }
      return res.json({
        success: true,
        message: 'Domain is already configured. Use the Verify button to check DNS status.',
        data: responseData
      });
    }

    // Step 1: Get Azure access token
    const accessToken = await getAzureAccessToken();
    
    // Step 2: Create custom domain in Azure Front Door
    const domainResult = await createCustomDomain(accessToken, domainName, subdomainOption);
    
    console.log('🔍 FULL AZURE RESPONSE JSON:', JSON.stringify(domainResult, null, 2));
    
    // Step 3: Get DNS records for verification (fetch CNAME from AFD endpoint)
    const afdEndpoint = await getAFDEndpoint(accessToken);
    const cnameRecord = {
      name: subdomainOption,
      value: afdEndpoint.properties?.hostName || AZURE_CONFIG.endpointHostName
    };

    // Poll for validation token if not immediately available
    // Poll up to 60 times with 10-second intervals (10 minutes total)
    let validationToken = domainResult.properties?.validationProperties?.validationToken;
    let polledDomain = domainResult;
    
    if (!validationToken) {
      console.log('⏳ Validation token not available, polling for it...');
      
      // Poll up to 60 times with 10-second intervals (10 minutes total)
      for (let i = 0; i < 60; i++) {
        await new Promise(resolve => setTimeout(resolve, 10000)); // Wait 10 seconds
        
        try {
          polledDomain = await getCustomDomain(accessToken, domainName, subdomainOption);
          validationToken = polledDomain?.properties?.validationProperties?.validationToken;
          
          console.log(`🔄 Poll attempt ${i + 1}/60: validationToken = ${validationToken ? 'found' : 'still null'}`);
          
          if (validationToken) {
            console.log('✅ Validation token found!');
            break;
          }
        } catch (error) {
          console.log(`❌ Poll attempt ${i + 1} failed:`, error.message);
        }
      }
      
      if (!validationToken) {
        console.log('⏰ Timeout: Validation token not found after polling. Requesting refresh from Azure...');
        try {
          const refreshedDomain = await refreshValidationToken(accessToken, domainName, subdomainOption);
          validationToken = refreshedDomain?.properties?.validationProperties?.validationToken;
          if (validationToken) {
            console.log('✅ Validation token retrieved after refresh!');
            polledDomain = refreshedDomain;
          } else {
            console.warn('⚠️ Refresh token call returned but validation token still missing.');
          }
        } catch (refreshError) {
          console.error('❌ Failed to refresh validation token:', refreshError.message);
        }
      }
    }

    const txtRecord = validationToken ? {
      name: `_dnsauth.${subdomainOption}`,
      value: validationToken
    } : null;

    if (txtRecord) {
      console.log('📋 TXT Record being created:', {
        name: txtRecord.name,
        value: txtRecord.value,
        validationTokenPath: 'domainResult.properties?.validationProperties?.validationToken',
        hasValidationProperties: !!domainResult.properties?.validationProperties,
        validationPropertiesKeys: domainResult.properties?.validationProperties ? Object.keys(domainResult.properties.validationProperties) : 'null'
      });
    } else {
      console.warn('⚠️ No validation token returned by Azure yet (validationProperties is null)');
    }

    const statusSource = polledDomain || domainResult;

    console.log('✅ Custom domain created successfully:', {
      hostName: statusSource.properties?.hostName,
      provisioningState: statusSource.properties?.provisioningState,
      validationToken: statusSource.properties?.validationProperties?.validationToken,
      fullProperties: statusSource.properties
    });

    // Steps 6-8 (route association) will be done in /verify endpoint after DNS is configured
    // For now, just create the domain and return DNS records (Steps 1-5)

    // Update tenant database with custom domain
    await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('customDomain', sql.NVarChar, domainResult.properties.hostName)
      .query('UPDATE oe.Tenants SET CustomDomain = @customDomain WHERE TenantId = @tenantId');

    // Refresh CORS cache after domain configuration (even if not yet verified)
    // This ensures the domain is available in CORS as soon as it's configured
    try {
      const { refreshCustomDomainsCache } = require('../middleware/cors');
      await refreshCustomDomainsCache();
      console.log('✅ CORS cache refreshed after domain configuration');
    } catch (corsError) {
      console.warn('⚠️ Failed to refresh CORS cache after domain configuration:', corsError.message);
      // Don't fail the request if CORS cache refresh fails
    }

    const now = new Date().toISOString();
    const customDomainName = buildCustomDomainName(domainName, subdomainOption);
    const dnsRecords = [
      {
        type: 'cname',
        host: cnameRecord.name,
        value: cnameRecord.value,
        ttl: 3600,
        status: 'pending'
      }
    ];

    if (txtRecord) {
      dnsRecords.push({
        type: 'txt',
        host: txtRecord.name,
        value: txtRecord.value,
        ttl: 3600,
        status: 'pending'
      });
    }

    const certificateSecretId = statusSource.properties?.tlsSettings?.secret?.id || null;

    await updateTenantVerificationStatus(tenantId, 'pending', statusSource.properties?.hostName, {
      domainName,
      subdomainOption,
      customDomainName,
      domainResourceId: statusSource.id,
      endpointName: getEffectiveEndpointName(),
      validationToken,
      provisioningState: statusSource.properties?.provisioningState,
      domainValidationState: statusSource.properties?.domainValidationState,
      deploymentStatus: statusSource.properties?.deploymentStatus,
      endpointAssociation: 'Unassociated', // Will be associated in /verify endpoint (Steps 6-8)
      certificateSecretId,
      dnsRecords,
      cnameRecord,
      txtRecord,
      createdAt: now,
      lastUpdated: now
    });

    // Return DNS instructions immediately - do NOT verify yet
    const responseData = {
      success: true,
      message: 'Custom domain created successfully. Please add both DNS records below and then click Verify.',
      data: {
        cname: cnameRecord,
        ...(txtRecord ? { txt: txtRecord } : {}),
        hostName: statusSource.properties?.hostName,
        validationToken,
        provisioningState: statusSource.properties?.provisioningState,
        domainId: statusSource.id
      }
    };

    console.log('📤 RESPONSE BEING SENT TO FRONTEND:', JSON.stringify(responseData, null, 2));
    
    res.json(responseData);

  } catch (error) {
    console.error('❌ Error configuring custom domain:', error);

    // Adopt existing domain: Azure says it already exists (e.g. same subscription, or DB was reset)
    if (error.message && error.message.includes('Another custom domain with the same host name already exists')) {
      console.log('ℹ️ Domain already exists in Azure; adopting and updating DB...');
      try {
        const { tenantId: adoptTenantId, subdomainOption: adoptSubdomainOption, domainName: adoptDomainName } = req.body;
        if (!adoptTenantId || !adoptSubdomainOption || !adoptDomainName) {
          return res.status(400).json({
            success: false,
            message: 'TenantId, subdomainOption, and domainName are required'
          });
        }
        const adoptPool = await getPool();
        const accessToken = await getAzureAccessToken();
        const afdEndpoint = await getAFDEndpoint(accessToken);
        let existingDomain = await getCustomDomain(accessToken, adoptDomainName, adoptSubdomainOption);
        if (!existingDomain) {
          return res.status(400).json({
            success: false,
            message: 'Domain exists in Azure but could not be retrieved. You may need to remove it from the other Front Door first.'
          });
        }
        let validationToken = existingDomain.properties?.validationProperties?.validationToken;
        if (!validationToken) {
          try {
            const refreshed = await refreshValidationToken(accessToken, adoptDomainName, adoptSubdomainOption);
            if (refreshed) {
              existingDomain = refreshed;
              validationToken = refreshed.properties?.validationProperties?.validationToken;
            }
          } catch (e) {
            console.warn('Could not refresh validation token:', e.message);
          }
        }
        const fullDomain = `${adoptSubdomainOption}.${adoptDomainName}`;
        const cnameRecord = {
          name: adoptSubdomainOption,
          value: afdEndpoint.properties?.hostName || AZURE_CONFIG.endpointHostName
        };
        const txtRecord = validationToken ? {
          name: `_dnsauth.${adoptSubdomainOption}`,
          value: validationToken
        } : null;
        const customDomainName = buildCustomDomainName(adoptDomainName, adoptSubdomainOption);

        await adoptPool.request()
          .input('tenantId', sql.UniqueIdentifier, adoptTenantId)
          .input('customDomain', sql.NVarChar, fullDomain)
          .query('UPDATE oe.Tenants SET CustomDomain = @customDomain WHERE TenantId = @tenantId');

        const now = new Date().toISOString();
        await updateTenantVerificationStatus(adoptTenantId, 'pending', fullDomain, {
          domainName: adoptDomainName,
          subdomainOption: adoptSubdomainOption,
          customDomainName,
          domainResourceId: existingDomain.id,
          endpointName: getEffectiveEndpointName(),
          validationToken,
          provisioningState: existingDomain.properties?.provisioningState,
          domainValidationState: existingDomain.properties?.domainValidationState,
          deploymentStatus: existingDomain.properties?.deploymentStatus,
          endpointAssociation: existingDomain.properties?.endpointAssociation || 'Unassociated',
          certificateSecretId: existingDomain.properties?.tlsSettings?.secret?.id || null,
          dnsRecords: [
            { type: 'cname', host: cnameRecord.name, value: cnameRecord.value, ttl: 3600, status: 'pending' },
            ...(txtRecord ? [{ type: 'txt', host: txtRecord.name, value: txtRecord.value, ttl: 3600, status: 'pending' }] : [])
          ],
          cnameRecord,
          txtRecord,
          createdAt: now,
          lastUpdated: now
        });

        try {
          const { refreshCustomDomainsCache } = require('../middleware/cors');
          await refreshCustomDomainsCache();
        } catch (corsError) {
          console.warn('⚠️ CORS refresh failed:', corsError.message);
        }

        return res.json({
          success: true,
          message: 'Custom domain already existed in Azure; tenant updated. Add DNS records if needed, then click Verify.',
          data: {
            cname: cnameRecord,
            ...(txtRecord ? { txt: txtRecord } : {}),
            hostName: fullDomain,
            validationToken,
            provisioningState: existingDomain.properties?.provisioningState,
            domainId: existingDomain.id
          }
        });
      } catch (adoptError) {
        console.error('❌ Failed to adopt existing domain:', adoptError);
        return res.status(400).json({
          success: false,
          message: adoptError.message || 'Domain already exists in Azure but could not be adopted. Remove it from the other Front Door or use the same instance.'
        });
      }
    }

    res.status(500).json({
      success: false,
      message: error.message || 'Failed to configure custom domain'
    });
  }
});

/**
 * @route   POST /api/custom-domains/verify
 * @desc    Step 4: Poll until DNS approved + Step 8: Associate domain with endpoint
 * @access  Private (TenantAdmin, SysAdmin)
 * 
 * Complete 8-Step Azure Front Door Domain Configuration Process:
 * 1. Get Azure access token
 * 2. Create custom domain in Azure Front Door
 * 3. Get AFD endpoint hostname for CNAME
 * 4. Poll until DNS approved (this endpoint)
 * 5. Fetch the app routes in Front Door endpoint
 * 6. Patch the app routes to include the new domain name
 * 7. Create Rule Set
 * 8. Associate custom domain with endpoint and routes (merge-safe pattern)
 *    - 8A: Get domain resource ID from Azure
 *    - 8B: GET current route to preserve existing associations
 *    - 8C: Merge existing domains with new domain
 *    - 8D: PATCH route with merged domain list
 */
router.post('/verify', authenticate, authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const { tenantId, subdomainOption, domainName } = req.body;

    if (!tenantId || !subdomainOption || !domainName) {
      return res.status(400).json({
        success: false,
        message: 'TenantId, subdomainOption, and domainName are required'
      });
    }

    console.log('🔍 Verifying custom domain (Step 4):', { tenantId, subdomainOption, domainName });

    // Step 1: Get Azure access token
    const accessToken = await getAzureAccessToken();
    
    // Step 4: Poll until DNS approved
    const domainResult = await getCustomDomain(accessToken, domainName, subdomainOption);

    if (!domainResult) {
      return res.status(404).json({
        success: false,
        message: 'Custom domain not found. Please configure the domain first.'
      });
    }

    const provisioningState = domainResult.properties?.provisioningState;
    const domainValidationState = domainResult.properties?.domainValidationState;
    const deploymentStatus = domainResult.properties?.deploymentStatus;
    let validationToken = domainResult.properties?.validationProperties?.validationToken;

    console.log('📊 Domain verification status (Step 4):', {
      provisioningState,
      domainValidationState,
      deploymentStatus,
      hostName: domainResult.properties?.hostName,
      fullResponse: JSON.stringify(domainResult, null, 2)
    });

    // If validation token is missing, try to get it from Azure (domain might still be creating)
    if (!validationToken) {
      console.log('⚠️ Validation token not found in domain result, attempting to fetch...');
      try {
        // Try refreshing the validation token
        const refreshedDomain = await refreshValidationToken(accessToken, domainName, subdomainOption);
        validationToken = refreshedDomain?.properties?.validationProperties?.validationToken;
        if (validationToken) {
          console.log('✅ Validation token retrieved from Azure');
        }
      } catch (refreshError) {
        console.warn('⚠️ Could not refresh validation token:', refreshError.message);
      }
    }

    // Get DNS records to return to user (in case they need to see them again)
    const fullDomain = `${subdomainOption}.${domainName}`;
    const afdEndpoint = await getAFDEndpoint(accessToken);
    const cnameRecord = {
      name: subdomainOption,
      value: afdEndpoint.properties?.hostName || AZURE_CONFIG.endpointHostName
    };
    const txtRecord = validationToken ? {
      name: `_dnsauth.${subdomainOption}`,
      value: validationToken
    } : null;

    let status = 'pending';
    let message = 'Domain verification is pending';
    let endpointAssociation = domainResult.properties?.endpointAssociation || 'Unassociated';
    let associationResult = null;
    let associationErrorMessage = null;

    if (domainValidationState === 'Approved') {
      status = 'verified';
      message = 'Domain verified successfully';

      console.log('✅ Domain verification successful - DNS is properly configured');

      if (endpointAssociation !== 'Associated') {
        try {
          console.log('🔗 Proceeding to Step 8: Domain association (verify flow)...');
          const fullDomainName = `${subdomainOption}.${domainName}`;
          console.log('🔗 Using full domain name for association:', fullDomainName);
          // Pass domainName and subdomainOption separately, not fullDomainName
          associationResult = await associateDomainWithEndpoint(accessToken, domainName, subdomainOption);

          if (associationResult && associationResult.success) {
            console.log('✅ Domain association completed successfully during verify');
            message = 'Domain verified and associated successfully';

            if (associationResult.associationStatus) {
              endpointAssociation = associationResult.associationStatus.endpointAssociation || endpointAssociation;
              domainResult.properties.endpointAssociation = endpointAssociation;
              console.log('✅ Updated domain result with association status:', endpointAssociation);
            }
          }
        } catch (associationError) {
          console.warn('⚠️ Domain verification succeeded but association failed:', associationError.message);
          associationErrorMessage = associationError.message || 'Route association failed';
          message = 'Domain verified (DNS OK) but route association failed. Traffic may not reach your app until the domain is added to the route in Azure.';
        }
      } else {
        console.log('🔗 Domain already associated; skipping association step during verify.');
      }
    } else if (provisioningState === 'Failed' || domainValidationState === 'Failed') {
      status = 'failed';
      message = 'Domain verification failed. Please check your DNS configuration.';
      endpointAssociation = 'Unassociated';
    } else if (provisioningState === 'Creating' || domainValidationState === 'Pending') {
      status = 'pending';
      message = 'Domain verification is pending. Please wait for DNS propagation (up to 24 hours).';
    }

    if (endpointAssociation === 'Unassociated') {
      try {
        const associationCheck = await getCustomDomain(accessToken, domainName, subdomainOption);
        if (associationCheck && associationCheck.properties) {
          endpointAssociation = associationCheck.properties.endpointAssociation || 'Unassociated';
          if (endpointAssociation === 'Associated') {
            associationErrorMessage = null;
            message = 'Domain verified and associated successfully';
          }
        }
      } catch (error) {
        console.warn('⚠️ Could not check association status:', error.message);
      }
    }

    const now = new Date().toISOString();
    const domainUpdates = {
      provisioningState,
      domainValidationState,
      deploymentStatus,
      endpointAssociation,
      validationToken,
      routeName: associationResult?.routeName,
      endpointName: associationResult?.endpointName,
      certificateSecretId: domainResult.properties?.tlsSettings?.secret?.id || null,
      lastUpdated: now
    };

    await updateTenantVerificationStatus(tenantId, status, domainResult.properties?.hostName, domainUpdates);

    // Refresh CORS cache when domain is verified to immediately allow requests from the new domain
    if (status === 'verified') {
      try {
        const { refreshCustomDomainsCache } = require('../middleware/cors');
        await refreshCustomDomainsCache();
        console.log('✅ CORS cache refreshed after domain verification');
      } catch (corsError) {
        console.warn('⚠️ Failed to refresh CORS cache after domain verification:', corsError.message);
        // Don't fail the request if CORS cache refresh fails
      }
    }

    // Build response with DNS records if domain is not yet verified (so user can see what to add)
    const responseData = {
      status,
      message,
      provisioningState,
      domainValidationState,
      deploymentStatus,
      endpointAssociation,
      hostName: domainResult.properties?.hostName,
      validationToken: validationToken,
      id: domainResult.id
    };
    if (typeof associationErrorMessage === 'string') {
      responseData.associationError = associationErrorMessage;
    }

    // Include DNS records if domain is not yet verified (so user can see what to add)
    if (status !== 'verified') {
      responseData.cname = cnameRecord;
      if (txtRecord) {
        responseData.txt = txtRecord;
      }
      responseData.message = message + (txtRecord ? ' Please add the DNS records below to complete verification.' : ' DNS records are still being generated. Please try again in a few moments.');
    }

    res.json({
      success: true,
      data: responseData
    });

  } catch (error) {
    console.error('❌ Error verifying custom domain:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to verify custom domain'
    });
  }
});

/**
 * @route   DELETE /api/custom-domains
 * @desc    Remove custom domain from Azure Front Door
 * @access  Private (TenantAdmin, SysAdmin)
 */
router.delete('/', authenticate, authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const { tenantId, subdomainOption, domainName, removeFromAzure } = req.body;

    if (!tenantId || !subdomainOption || !domainName) {
      return res.status(400).json({
        success: false,
        message: 'TenantId, subdomainOption, and domainName are required'
      });
    }

    const fromAzure = removeFromAzure !== false; // default true for backward compatibility
    console.log('🗑️ Removing custom domain:', { tenantId, subdomainOption, domainName, removeFromAzure: fromAzure });

    const pool = await getPool();
    const advancedSettings = await fetchTenantAdvancedSettings(pool, tenantId);
    const domainSettings = advancedSettings.domain || null;

    if (domainSettings?.endpointName) {
      resolvedEndpointName = domainSettings.endpointName;
    }

    const customDomainName = domainSettings?.customDomainName || buildCustomDomainName(domainName, subdomainOption);
    let domainResourceId = domainSettings?.domainResourceId;
    const preferredRouteName = domainSettings?.routeName;

    if (fromAzure) {
      const accessToken = await getAzureAccessToken();
      await getAFDEndpoint(accessToken);

      if (!domainResourceId) {
        console.warn('⚠️ Domain resource ID not stored; attempting to retrieve from Azure');
        const domainResult = await getCustomDomain(accessToken, domainName, subdomainOption);
        if (domainResult) {
          domainResourceId = domainResult.id;
        }
      }

      if (domainResourceId) {
        try {
          const { route: currentRoute, routeName } = await getCurrentRoute(accessToken, preferredRouteName);
          const existingRouteDomains = currentRoute.properties?.customDomains || [];
          const filteredDomains = existingRouteDomains.filter(domain => (domain.id || '').toLowerCase() !== domainResourceId.toLowerCase());

          if (filteredDomains.length !== existingRouteDomains.length) {
            const routeUrl = `https://management.azure.com/subscriptions/${AZURE_CONFIG.subscriptionId}/resourceGroups/${AZURE_CONFIG.resourceGroup}/providers/Microsoft.Cdn/profiles/${AZURE_CONFIG.profileName}/afdendpoints/${getEffectiveEndpointName()}/routes/${routeName}?api-version=${AZURE_CONFIG.apiVersion}`;

            const routeRequestBody = {
              properties: {
                ...currentRoute.properties,
                customDomains: filteredDomains
              }
            };

            delete routeRequestBody.properties?.id;
            delete routeRequestBody.properties?.resourceState;
            delete routeRequestBody.properties?.deploymentStatus;
            delete routeRequestBody.properties?.provisioningState;

            console.log('🔗 Removing domain association from route:', routeUrl);

            const routeResponse = await fetch(routeUrl, {
              method: 'PATCH',
              headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify(routeRequestBody)
            });

            if (!routeResponse.ok) {
              const errText = await routeResponse.text();
              throw new Error(`Failed to update route while removing domain association: ${routeResponse.status} ${errText}`);
            }

            console.log('✅ Domain association removed from route', routeName);
          } else {
            console.log('ℹ️ Domain not associated with route; no removal needed.');
          }
        } catch (associationRemovalError) {
          console.warn('⚠️ Failed to remove domain association from route (continuing with deletion):', associationRemovalError.message);
        }
      } else {
        console.warn('⚠️ Unable to determine domain resource ID; skipping route cleanup.');
      }

      // Delete the custom domain from Azure Front Door
      const deleteUrl = `https://management.azure.com/subscriptions/${AZURE_CONFIG.subscriptionId}/resourceGroups/${AZURE_CONFIG.resourceGroup}/providers/Microsoft.Cdn/profiles/${AZURE_CONFIG.profileName}/customDomains/${customDomainName}?api-version=${AZURE_CONFIG.apiVersion}`;
      
      console.log('🗑️ Deleting custom domain from Azure:', deleteUrl);
      
      const response = await fetch(deleteUrl, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        // If domain doesn't exist (404), that's okay - it may have been deleted already
        if (response.status === 404) {
          console.log('ℹ️ Custom domain not found in Azure (may have been deleted already)');
        } else {
          const errorData = await response.json().catch(() => ({ error: { message: 'Unknown error' } }));
          throw new Error(`Failed to delete custom domain: ${errorData.error?.message || 'Unknown error'}`);
        }
      } else {
        console.log('✅ Custom domain deleted from Azure Front Door');
      }
    } else {
      console.log('ℹ️ Skipping Azure removal (remove from DB only)');
    }

    await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('customDomain', sql.NVarChar, '')
      .query('UPDATE oe.Tenants SET CustomDomain = @customDomain WHERE TenantId = @tenantId');

    if (advancedSettings.domain) {
      delete advancedSettings.domain;
      await saveTenantAdvancedSettings(pool, tenantId, advancedSettings);
    }

    // Refresh CORS cache after domain deletion to remove it from allowed origins
    try {
      const { refreshCustomDomainsCache } = require('../middleware/cors');
      await refreshCustomDomainsCache();
      console.log('✅ CORS cache refreshed after domain deletion');
    } catch (corsError) {
      console.warn('⚠️ Failed to refresh CORS cache after domain deletion:', corsError.message);
      // Don't fail the request if CORS cache refresh fails
    }

    console.log('✅ Custom domain removed successfully and database updated');

    res.json({
      success: true,
      message: 'Custom domain removed successfully'
    });

  } catch (error) {
    console.error('❌ Error removing custom domain:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to remove custom domain'
    });
  }
});

module.exports = router;
module.exports.AZURE_CONFIG = AZURE_CONFIG;
module.exports.getAzureAccessToken = getAzureAccessToken;
module.exports.getAFDEndpoint = getAFDEndpoint;
