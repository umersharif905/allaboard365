/**
 * Script to test Step 7 (Create Rule Set) and Step 8 (Link Rule Set to Route)
 * for portal.mightywellhealth.com
 * 
 * This will:
 * 1. Create a rule set with CORS headers for the domain
 * 2. Link the rule set to the route
 * 3. Verify the configuration
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const AZURE_CONFIG = {
  tenantId: process.env.AZURE_TENANT_ID || '915f04be-d328-48b8-bb5c-928c700dbce7',
  clientId: process.env.AZURE_CLIENT_ID || '795e605d-6d4e-416d-8667-e86c088625ad',
  clientSecret: process.env.AZURE_CLIENT_SECRET || 'a3I8Q~9-ipke4p49EUo7iyoZm43rFC4p89rgfavg',
  subscriptionId: process.env.AZURE_SUBSCRIPTION_ID || '8189966e-8ff7-4e7c-826f-215a8bb3355b',
  resourceGroup: process.env.FRONTDOOR_RESOURCE_GROUP || 'oe-Frontdoor-ResourceGroup',
  profileName: process.env.FRONTDOOR_PROFILE_NAME || 'oe-FrontDoor',
  endpointName: process.env.FRONTDOOR_ENDPOINT_NAME || 'appProd-cfabd0fmcmf7adec',
  apiVersion: '2024-02-01'
};

// Domain configuration
const DOMAIN_CONFIG = {
  domainName: 'mightywellhealth.com',
  subdomainOption: 'portal',
  fullDomain: 'portal.mightywellhealth.com'
};

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

  // Rule set names must start with a letter and contain only numbers and letters (no hyphens)
  // So we'll use camelCase or just concatenate
  return `${firstWord}${subdomainOption.charAt(0).toUpperCase() + subdomainOption.slice(1)}`;
}

async function getAzureAccessToken() {
  const response = await fetch('https://login.microsoftonline.com/' + AZURE_CONFIG.tenantId + '/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: AZURE_CONFIG.clientId,
      client_secret: AZURE_CONFIG.clientSecret,
      scope: 'https://management.azure.com/.default',
      grant_type: 'client_credentials'
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`Azure auth failed: ${data.error_description || data.error}`);
  return data.access_token;
}

async function getAFDEndpoint(accessToken) {
  const endpointUrl = `https://management.azure.com/subscriptions/${AZURE_CONFIG.subscriptionId}/resourceGroups/${AZURE_CONFIG.resourceGroup}/providers/Microsoft.Cdn/profiles/${AZURE_CONFIG.profileName}/afdEndpoints/${AZURE_CONFIG.endpointName}?api-version=${AZURE_CONFIG.apiVersion}`;
  let response = await fetch(endpointUrl, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    }
  });
  let data = await response.json();
  if (!response.ok) {
    // Try listing endpoints
    const listUrl = `https://management.azure.com/subscriptions/${AZURE_CONFIG.subscriptionId}/resourceGroups/${AZURE_CONFIG.resourceGroup}/providers/Microsoft.Cdn/profiles/${AZURE_CONFIG.profileName}/afdEndpoints?api-version=${AZURE_CONFIG.apiVersion}`;
    const listResponse = await fetch(listUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });
    const listData = await listResponse.json();
    if (listResponse.ok && Array.isArray(listData.value) && listData.value.length > 0) {
      return listData.value[0];
    }
    throw new Error(`Failed to get AFD endpoint: ${data.error?.message || 'Unknown error'}`);
  }
  return data;
}

async function getCurrentRoute(accessToken, endpointName) {
  const routesUrl = `https://management.azure.com/subscriptions/${AZURE_CONFIG.subscriptionId}/resourceGroups/${AZURE_CONFIG.resourceGroup}/providers/Microsoft.Cdn/profiles/${AZURE_CONFIG.profileName}/afdEndpoints/${endpointName}/routes?api-version=${AZURE_CONFIG.apiVersion}`;
  const routesResponse = await fetch(routesUrl, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    }
  });
  const routesData = await routesResponse.json();
  
  if (!routesResponse.ok || !routesData.value || routesData.value.length === 0) {
    throw new Error('No routes found');
  }
  
  // Find route that has the domain
  const domainUrl = `https://management.azure.com/subscriptions/${AZURE_CONFIG.subscriptionId}/resourceGroups/${AZURE_CONFIG.resourceGroup}/providers/Microsoft.Cdn/profiles/${AZURE_CONFIG.profileName}/customDomains?api-version=${AZURE_CONFIG.apiVersion}`;
  const domainResponse = await fetch(domainUrl, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    }
  });
  const domainData = await domainResponse.json();
  const domain = domainData.value?.find(d => d.properties?.hostName === DOMAIN_CONFIG.fullDomain);
  
  if (!domain) {
    throw new Error(`Domain ${DOMAIN_CONFIG.fullDomain} not found`);
  }
  
  // Find route with this domain
  const routeWithDomain = routesData.value.find(route => {
    const customDomains = route.properties?.customDomains || [];
    return customDomains.some(cd => cd.id === domain.id);
  });
  
  if (!routeWithDomain) {
    throw new Error(`No route found with domain ${DOMAIN_CONFIG.fullDomain}`);
  }
  
  const routeName = routeWithDomain.name;
  const routeUrl = `https://management.azure.com/subscriptions/${AZURE_CONFIG.subscriptionId}/resourceGroups/${AZURE_CONFIG.resourceGroup}/providers/Microsoft.Cdn/profiles/${AZURE_CONFIG.profileName}/afdEndpoints/${endpointName}/routes/${routeName}?api-version=${AZURE_CONFIG.apiVersion}`;
  const routeResponse = await fetch(routeUrl, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    }
  });
  const routeData = await routeResponse.json();
  
  return { route: routeData, routeName };
}

async function step7_CreateRuleSet(accessToken) {
  console.log('\n📝 STEP 7: Creating Rule Set...\n');
  
  const customDomainName = buildCustomDomainName(DOMAIN_CONFIG.domainName, DOMAIN_CONFIG.subdomainOption);
  const fullDomain = DOMAIN_CONFIG.fullDomain;
  
  console.log(`   Rule Set Name: ${customDomainName}`);
  console.log(`   Domain: ${fullDomain}\n`);
  
  const ruleSetUrl = `https://management.azure.com/subscriptions/${AZURE_CONFIG.subscriptionId}/resourceGroups/${AZURE_CONFIG.resourceGroup}/providers/Microsoft.Cdn/profiles/${AZURE_CONFIG.profileName}/ruleSets/${customDomainName}?api-version=${AZURE_CONFIG.apiVersion}`;
  
  const ruleSetBody = {
    properties: {
      rules: [
        {
          name: "CorsHeaders",
          order: 1,
          conditions: [
            {
              name: "RequestMethod",
              parameters: {
                operator: "Equal",
                matchValues: ["OPTIONS"]
              }
            },
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
              name: "ModifyResponseHeader",
              parameters: {
                headerAction: "Append",
                headerName: "Access-Control-Allow-Origin",
                value: `https://${fullDomain}`
              }
            },
            {
              name: "ModifyResponseHeader",
              parameters: {
                headerAction: "Append",
                headerName: "Access-Control-Allow-Methods",
                value: "GET, POST, PUT, PATCH, DELETE, OPTIONS"
              }
            },
            {
              name: "ModifyResponseHeader",
              parameters: {
                headerAction: "Append",
                headerName: "Access-Control-Allow-Headers",
                value: "Content-Type, Authorization, X-Requested-With, Accept"
              }
            },
            {
              name: "ModifyResponseHeader",
              parameters: {
                headerAction: "Append",
                headerName: "Access-Control-Allow-Credentials",
                value: "true"
              }
            },
            {
              name: "UrlRedirect",
              parameters: {
                redirectType: "Found",
                destinationProtocol: "MatchRequest",
                customPath: "/",
                customQueryString: "",
                customFragment: ""
              }
            }
          ]
        },
        {
          name: "CorsHeadersForAll",
          order: 2,
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
              name: "ModifyResponseHeader",
              parameters: {
                headerAction: "Append",
                headerName: "Access-Control-Allow-Origin",
                value: `https://${fullDomain}`
              }
            },
            {
              name: "ModifyResponseHeader",
              parameters: {
                headerAction: "Append",
                headerName: "Access-Control-Allow-Methods",
                value: "GET, POST, PUT, PATCH, DELETE, OPTIONS"
              }
            },
            {
              name: "ModifyResponseHeader",
              parameters: {
                headerAction: "Append",
                headerName: "Access-Control-Allow-Headers",
                value: "Content-Type, Authorization, X-Requested-With, Accept"
              }
            },
            {
              name: "ModifyResponseHeader",
              parameters: {
                headerAction: "Append",
                headerName: "Access-Control-Allow-Credentials",
                value: "true"
              }
            }
          ]
        }
      ]
    }
  };
  
  console.log('   Sending PUT request to create rule set...');
  const response = await fetch(ruleSetUrl, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(ruleSetBody)
  });
  
  const data = await response.json();
  
  if (!response.ok) {
    console.error('   ❌ Failed to create rule set:', data.error?.message || 'Unknown error');
    console.error('   Response:', JSON.stringify(data, null, 2));
    throw new Error(`Failed to create rule set: ${data.error?.message || 'Unknown error'}`);
  }
  
  console.log('   ✅ Rule set created successfully!');
  console.log(`   Rule Set ID: ${data.id}`);
  console.log(`   Provisioning State: ${data.properties?.provisioningState || 'N/A'}`);
  console.log(`   Number of Rules: ${data.properties?.rules?.length || 0}\n`);
  
  return data;
}

async function step8_LinkRuleSetToRoute(accessToken, ruleSetId) {
  console.log('📝 STEP 8: Linking Rule Set to Route...\n');
  
  const endpoint = await getAFDEndpoint(accessToken);
  const endpointName = endpoint.name;
  
  console.log(`   Endpoint: ${endpointName}\n`);
  
  const { route: currentRoute, routeName } = await getCurrentRoute(accessToken, endpointName);
  
  console.log(`   Route: ${routeName}`);
  console.log(`   Current Rule Sets: ${currentRoute.properties?.ruleSets?.length || 0}\n`);
  
  // Merge existing rule sets with new one
  const existingRuleSets = currentRoute.properties?.ruleSets?.map(rs => rs.id) || [];
  const mergedRuleSets = Array.from(new Set([...existingRuleSets, ruleSetId]));
  
  console.log(`   Existing Rule Sets: ${existingRuleSets.length}`);
  console.log(`   Adding Rule Set: ${ruleSetId.split('/').pop()}`);
  console.log(`   Total Rule Sets after merge: ${mergedRuleSets.length}\n`);
  
  const routeUrl = `https://management.azure.com/subscriptions/${AZURE_CONFIG.subscriptionId}/resourceGroups/${AZURE_CONFIG.resourceGroup}/providers/Microsoft.Cdn/profiles/${AZURE_CONFIG.profileName}/afdEndpoints/${endpointName}/routes/${routeName}?api-version=${AZURE_CONFIG.apiVersion}`;
  
  const routeRequestBody = {
    properties: {
      ...currentRoute.properties,
      ruleSets: mergedRuleSets.map(id => ({ id }))
    }
  };
  
  // Remove read-only properties
  delete routeRequestBody.properties?.id;
  delete routeRequestBody.properties?.resourceState;
  delete routeRequestBody.properties?.deploymentStatus;
  delete routeRequestBody.properties?.provisioningState;
  
  console.log('   Sending PATCH request to update route...');
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
    console.error('   ❌ Failed to update route:', err);
    throw new Error(`Route update failed: ${routeResponse.status} ${err}`);
  }
  
  const routeData = await routeResponse.json();
  
  console.log('   ✅ Route updated successfully!');
  console.log(`   Route Rule Sets: ${routeData.properties?.ruleSets?.length || 0}`);
  if (routeData.properties?.ruleSets && routeData.properties.ruleSets.length > 0) {
    console.log('   Linked Rule Sets:');
    routeData.properties.ruleSets.forEach(rs => {
      console.log(`     - ${rs.id.split('/').pop()}`);
    });
  }
  console.log(`   Provisioning State: ${routeData.properties?.provisioningState || 'N/A'}\n`);
  
  return routeData;
}

async function verifyConfiguration(accessToken, ruleSetId) {
  console.log('📝 VERIFICATION: Checking final configuration...\n');
  
  const endpoint = await getAFDEndpoint(accessToken);
  const { route } = await getCurrentRoute(accessToken, endpoint.name);
  
  const hasRuleSet = route.properties?.ruleSets?.some(rs => rs.id === ruleSetId);
  
  if (hasRuleSet) {
    console.log('   ✅ Rule set is linked to the route!');
  } else {
    console.log('   ❌ Rule set is NOT linked to the route!');
  }
  
  console.log(`   Total Rule Sets on Route: ${route.properties?.ruleSets?.length || 0}\n`);
  
  // Check rule set
  const customDomainName = buildCustomDomainName(DOMAIN_CONFIG.domainName, DOMAIN_CONFIG.subdomainOption);
  const ruleSetUrl = `https://management.azure.com/subscriptions/${AZURE_CONFIG.subscriptionId}/resourceGroups/${AZURE_CONFIG.resourceGroup}/providers/Microsoft.Cdn/profiles/${AZURE_CONFIG.profileName}/ruleSets/${customDomainName}?api-version=${AZURE_CONFIG.apiVersion}`;
  const ruleSetResponse = await fetch(ruleSetUrl, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    }
  });
  const ruleSetData = await ruleSetResponse.json();
  
  if (ruleSetResponse.ok) {
    console.log(`   ✅ Rule set exists with ${ruleSetData.properties?.rules?.length || 0} rules`);
    console.log(`   Provisioning State: ${ruleSetData.properties?.provisioningState || 'N/A'}\n`);
  }
  
  return hasRuleSet;
}

async function main() {
  try {
    console.log('🚀 Testing Steps 7 & 8 for Azure Front Door Configuration\n');
    console.log(`Domain: ${DOMAIN_CONFIG.fullDomain}\n`);
    console.log('='.repeat(60) + '\n');
    
    // Get access token
    const accessToken = await getAzureAccessToken();
    
    // Step 7: Create Rule Set
    const ruleSet = await step7_CreateRuleSet(accessToken);
    const ruleSetId = ruleSet.id;
    
    // Wait a moment for Azure to process
    console.log('⏳ Waiting 2 seconds for Azure to process...\n');
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Step 8: Link Rule Set to Route
    const route = await step8_LinkRuleSetToRoute(accessToken, ruleSetId);
    
    // Wait a moment for Azure to process
    console.log('⏳ Waiting 3 seconds for Azure to process...\n');
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Verify
    const verified = await verifyConfiguration(accessToken, ruleSetId);
    
    console.log('='.repeat(60) + '\n');
    if (verified) {
      console.log('✅ SUCCESS: Steps 7 & 8 completed successfully!');
      console.log('   The rule set has been created and linked to the route.');
      console.log('   CORS headers should now be configured for the domain.\n');
    } else {
      console.log('⚠️  WARNING: Configuration may not be complete.');
      console.log('   Please check Azure Portal to verify the configuration.\n');
    }
    
  } catch (error) {
    console.error('\n❌ ERROR:', error.message);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

main();

