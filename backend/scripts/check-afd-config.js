/**
 * Script to check Azure Front Door configuration for a custom domain
 * Usage: node backend/scripts/check-afd-config.js portal.mightywellhealth.com
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

async function getAFDEndpoint(accessToken) {
  try {
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
      if (response.status === 404) {
        // Try to list endpoints and find the right one
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
          return listData.value[0]; // Return first endpoint
        }
      }
      throw new Error(`Failed to get AFD endpoint: ${data.error?.message || 'Unknown error'}`);
    }

    return data;
  } catch (error) {
    console.error('Error getting AFD endpoint:', error);
    throw error;
  }
}

async function checkAFDConfiguration(domainName) {
  try {
    console.log(`\n🔍 Checking Azure Front Door configuration for: ${domainName}\n`);
    
    // Get access token
    console.log('📝 Step 1: Getting Azure access token...');
    const accessToken = await getAzureAccessToken();
    console.log('✅ Access token obtained\n');

    // Get custom domain
    console.log('📝 Step 2: Getting custom domain information...');
    const customDomainsUrl = `https://management.azure.com/subscriptions/${AZURE_CONFIG.subscriptionId}/resourceGroups/${AZURE_CONFIG.resourceGroup}/providers/Microsoft.Cdn/profiles/${AZURE_CONFIG.profileName}/customDomains?api-version=${AZURE_CONFIG.apiVersion}`;
    const customDomainsResponse = await fetch(customDomainsUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });
    const customDomainsData = await customDomainsResponse.json();
    
    const domain = customDomainsData.value?.find(d => d.properties?.hostName === domainName);
    
    if (!domain) {
      console.log('❌ Domain not found in Azure Front Door');
      console.log('\n📋 Available domains:');
      customDomainsData.value?.forEach(d => {
        console.log(`   - ${d.properties?.hostName} (${d.name})`);
      });
      return;
    }

    console.log('✅ Domain found:');
    console.log(`   Name: ${domain.name}`);
    console.log(`   HostName: ${domain.properties?.hostName}`);
    console.log(`   Provisioning State: ${domain.properties?.provisioningState}`);
    console.log(`   Domain Validation State: ${domain.properties?.domainValidationState}`);
    console.log(`   Endpoint Association: ${domain.properties?.endpointAssociation}`);
    console.log(`   Deployment Status: ${domain.properties?.deploymentStatus}\n`);

    // Get endpoint
    console.log('📝 Step 3: Getting endpoint information...');
    const endpoint = await getAFDEndpoint(accessToken);
    console.log(`✅ Endpoint: ${endpoint.name} (${endpoint.properties?.hostName})\n`);

    // Get routes
    console.log('📝 Step 4: Getting routes...');
    const routesUrl = `https://management.azure.com/subscriptions/${AZURE_CONFIG.subscriptionId}/resourceGroups/${AZURE_CONFIG.resourceGroup}/providers/Microsoft.Cdn/profiles/${AZURE_CONFIG.profileName}/afdEndpoints/${endpoint.name}/routes?api-version=${AZURE_CONFIG.apiVersion}`;
    const routesResponse = await fetch(routesUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });
    const routesData = await routesResponse.json();
    
    console.log(`✅ Found ${routesData.value?.length || 0} routes\n`);

    // Find routes with this domain
    const routesWithDomain = [];
    for (const route of routesData.value || []) {
      const customDomains = route.properties?.customDomains || [];
      const hasDomain = customDomains.some(cd => cd.id === domain.id);
      
      if (hasDomain) {
        routesWithDomain.push(route);
      }
    }

    if (routesWithDomain.length === 0) {
      console.log('❌ ISSUE FOUND: Domain is NOT associated with any routes!\n');
      return;
    }

    console.log(`✅ Domain is associated with ${routesWithDomain.length} route(s):\n`);
    
    for (const route of routesWithDomain) {
      console.log(`📋 Route: ${route.name}`);
      console.log(`   ID: ${route.id}`);
      console.log(`   Custom Domains: ${route.properties?.customDomains?.length || 0}`);
      console.log(`   Rule Sets: ${route.properties?.ruleSets?.length || 0} ⚠️`);
      
      if (route.properties?.ruleSets && route.properties.ruleSets.length > 0) {
        console.log('   Rule Set IDs:');
        route.properties.ruleSets.forEach(rs => {
          console.log(`     - ${rs.id}`);
        });
      } else {
        console.log('   ⚠️  ISSUE: No rule sets linked to this route!');
      }
      
      console.log(`   Origin Group: ${route.properties?.originGroup?.id || 'N/A'}`);
      console.log(`   Patterns: ${route.properties?.patternsToMatch?.join(', ') || 'N/A'}`);
      console.log(`   Forwarding Protocol: ${route.properties?.forwardingProtocol || 'N/A'}`);
      console.log(`   HTTPS Redirect: ${route.properties?.httpsRedirect || 'N/A'}`);
      console.log(`   Enabled State: ${route.properties?.enabledState || 'N/A'}`);
      console.log(`   Provisioning State: ${route.properties?.provisioningState || 'N/A'}\n`);
    }

    // Get all rule sets
    console.log('📝 Step 5: Getting rule sets...');
    const ruleSetsUrl = `https://management.azure.com/subscriptions/${AZURE_CONFIG.subscriptionId}/resourceGroups/${AZURE_CONFIG.resourceGroup}/providers/Microsoft.Cdn/profiles/${AZURE_CONFIG.profileName}/ruleSets?api-version=${AZURE_CONFIG.apiVersion}`;
    const ruleSetsResponse = await fetch(ruleSetsUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });
    const ruleSetsData = await ruleSetsResponse.json();
    
    console.log(`✅ Found ${ruleSetsData.value?.length || 0} rule sets\n`);

    // Find related rule sets
    const domainNameForRuleSet = domainName.split('.')[0];
    const relatedRuleSets = (ruleSetsData.value || []).filter(rs => 
      rs.name.toLowerCase().includes(domainNameForRuleSet.toLowerCase()) ||
      rs.name.toLowerCase().includes(domainName.split('.')[1]?.split('.')[0] || '')
    );

    if (relatedRuleSets.length > 0) {
      console.log(`📋 Found ${relatedRuleSets.length} related rule set(s):\n`);
      relatedRuleSets.forEach(rs => {
        console.log(`   Rule Set: ${rs.name}`);
        console.log(`   ID: ${rs.id}`);
        console.log(`   Provisioning State: ${rs.properties?.provisioningState || 'N/A'}`);
        console.log(`   Rules: ${rs.properties?.rules?.length || 0}`);
        if (rs.properties?.rules && rs.properties.rules.length > 0) {
          rs.properties.rules.forEach(rule => {
            console.log(`     - ${rule.name} (order: ${rule.order})`);
            if (rule.conditions) {
              rule.conditions.forEach(cond => {
                if (cond.name === 'HostName') {
                  console.log(`       Condition: HostName = ${cond.parameters?.matchValues?.join(', ') || 'N/A'}`);
                }
              });
            }
          });
        }
        console.log('');
      });
    } else {
      console.log('⚠️  No rule sets found that match this domain name\n');
    }

    // Summary
    console.log('\n📊 SUMMARY:\n');
    console.log(`Domain Status: ${domain.properties?.domainValidationState === 'Approved' ? '✅ Verified' : '⚠️ Not Verified'}`);
    console.log(`Domain Association: ${domain.properties?.endpointAssociation === 'Associated' ? '✅ Associated' : '❌ Not Associated'}`);
    console.log(`Route Association: ${routesWithDomain.length > 0 ? '✅ Associated' : '❌ Not Associated'}`);
    console.log(`Rule Sets Linked: ${routesWithDomain.some(r => r.properties?.ruleSets?.length > 0) ? '✅ Yes' : '❌ NO - THIS IS THE PROBLEM!'}`);
    console.log(`Rule Sets Exist: ${relatedRuleSets.length > 0 ? '✅ Yes' : '❌ No'}`);
    
    if (!routesWithDomain.some(r => r.properties?.ruleSets?.length > 0)) {
      console.log('\n🔧 FIX NEEDED:');
      console.log('   The route needs to have ruleSets property set to link the rule set.');
      console.log('   This is Step 8 in the WhiteLabelDNS.md document.');
      if (relatedRuleSets.length > 0) {
        console.log(`   Rule set "${relatedRuleSets[0].name}" exists but is not linked to the route.`);
      } else {
        console.log('   Step 7 (Create Rule Set) may not have been executed.');
      }
    }

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

// Get domain name from command line argument
const domainName = process.argv[2] || 'portal.mightywellhealth.com';

checkAFDConfiguration(domainName)
  .then(() => {
    console.log('\n✅ Check complete\n');
    process.exit(0);
  })
  .catch(error => {
    console.error('\n❌ Failed:', error);
    process.exit(1);
  });

