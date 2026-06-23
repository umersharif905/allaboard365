/**
 * Script to update the globalRules rule set with CORS rules for all white-labeled domains
 * This uses ONE rule set for ALL domains instead of creating one per domain
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const AZURE_CONFIG = {
  tenantId: process.env.AZURE_TENANT_ID || '915f04be-d328-48b8-bb5c-928c700dbce7',
  clientId: process.env.AZURE_CLIENT_ID || '795e605d-6d4e-416d-8667-e86c088625ad',
  clientSecret: process.env.AZURE_CLIENT_SECRET || 'a3I8Q~9-ipke4p49EUo7iyoZm43rFC4p89rgfavg',
  subscriptionId: process.env.AZURE_SUBSCRIPTION_ID || '8189966e-8ff7-4e7c-826f-215a8bb3355b',
  resourceGroup: process.env.FRONTDOOR_RESOURCE_GROUP || 'oe-Frontdoor-ResourceGroup',
  profileName: process.env.FRONTDOOR_PROFILE_NAME || 'oe-FrontDoor',
  apiVersion: '2024-02-01'
};

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

async function getAllWhiteLabeledDomains(accessToken) {
  console.log('\n📝 Getting all white-labeled domains from Azure Front Door...\n');
  
  const customDomainsUrl = `https://management.azure.com/subscriptions/${AZURE_CONFIG.subscriptionId}/resourceGroups/${AZURE_CONFIG.resourceGroup}/providers/Microsoft.Cdn/profiles/${AZURE_CONFIG.profileName}/customDomains?api-version=${AZURE_CONFIG.apiVersion}`;
  const response = await fetch(customDomainsUrl, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    }
  });
  const data = await response.json();
  
  if (!response.ok) {
    throw new Error(`Failed to get custom domains: ${data.error?.message || 'Unknown error'}`);
  }
  
  // Filter for verified/approved domains (exclude app.allaboard365.com)
  const whiteLabeledDomains = (data.value || [])
    .filter(d => {
      const hostName = d.properties?.hostName || '';
      const validationState = d.properties?.domainValidationState;
      return hostName && 
             !hostName.includes('allaboard365.com') &&
             (validationState === 'Approved' || d.properties?.endpointAssociation === 'Associated');
    })
    .map(d => d.properties.hostName);
  
  console.log(`✅ Found ${whiteLabeledDomains.length} white-labeled domain(s):`);
  whiteLabeledDomains.forEach(domain => console.log(`   - ${domain}`));
  console.log('');
  
  return whiteLabeledDomains;
}

async function updateGlobalRulesWithCORS(accessToken, domains) {
  console.log('📝 Updating globalRules with CORS configuration...\n');
  console.log(`   Domains to configure: ${domains.length}\n`);
  
  if (domains.length === 0) {
    console.log('⚠️  No white-labeled domains found. Skipping rule set update.\n');
    return null;
  }
  
  const ruleSetUrl = `https://management.azure.com/subscriptions/${AZURE_CONFIG.subscriptionId}/resourceGroups/${AZURE_CONFIG.resourceGroup}/providers/Microsoft.Cdn/profiles/${AZURE_CONFIG.profileName}/ruleSets/globalRules?api-version=${AZURE_CONFIG.apiVersion}`;
  
  // Create rules that handle CORS for all white-labeled domains
  const rules = [
    {
      name: "HandleOptionsPreflight",
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
          name: "RequestHeader",
          parameters: {
            headerName: "Origin",
            operator: "Contains",
            matchValues: domains
          }
        }
      ],
      actions: [
        {
          name: "ModifyResponseHeader",
          parameters: {
            headerAction: "Overwrite",
            headerName: "Access-Control-Allow-Origin",
            value: "{request.header.Origin}"
          }
        },
        {
          name: "ModifyResponseHeader",
          parameters: {
            headerAction: "Overwrite",
            headerName: "Access-Control-Allow-Methods",
            value: "GET, POST, PUT, PATCH, DELETE, OPTIONS"
          }
        },
        {
          name: "ModifyResponseHeader",
          parameters: {
            headerAction: "Overwrite",
            headerName: "Access-Control-Allow-Headers",
            value: "Content-Type, Authorization, X-Requested-With, Accept"
          }
        },
        {
          name: "ModifyResponseHeader",
          parameters: {
            headerAction: "Overwrite",
            headerName: "Access-Control-Allow-Credentials",
            value: "true"
          }
        },
        {
          name: "ModifyResponseHeader",
          parameters: {
            headerAction: "Overwrite",
            headerName: "Access-Control-Max-Age",
            value: "86400"
          }
        },
        {
          name: "RouteConfigurationOverride",
          parameters: {
            originGroupOverride: null,
            forwardingProtocol: "MatchRequest"
          }
        }
      ]
    },
    {
      name: "AddCorsHeadersForWhiteLabel",
      order: 2,
      conditions: [
        {
          name: "HostName",
          parameters: {
            operator: "Equal",
            matchValues: domains
          }
        }
      ],
      actions: [
        {
          name: "ModifyResponseHeader",
          parameters: {
            headerAction: "Append",
            headerName: "Access-Control-Allow-Origin",
            value: "https://{request.header.Host}"
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
  ];
  
  const ruleSetBody = {
    properties: {
      rules: rules
    }
  };
  
  console.log('   Sending PUT request to update globalRules...');
  console.log(`   Rules to create: ${rules.length}`);
  console.log(`   Domains in conditions: ${domains.length}\n`);
  
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
    console.error('   ❌ Failed to update rule set:', data.error?.message || 'Unknown error');
    console.error('   Full response:', JSON.stringify(data, null, 2));
    throw new Error(`Failed to update rule set: ${data.error?.message || 'Unknown error'}`);
  }
  
  console.log('   ✅ Rule set updated successfully!');
  console.log(`   Rule Set ID: ${data.id}`);
  console.log(`   Provisioning State: ${data.properties?.provisioningState || 'N/A'}`);
  console.log(`   Number of Rules: ${data.properties?.rules?.length || 0}\n`);
  
  // Wait and verify
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  const verifyResponse = await fetch(ruleSetUrl, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    }
  });
  const verifyData = await verifyResponse.json();
  
  if (verifyData.properties?.rules && verifyData.properties.rules.length > 0) {
    console.log('   ✅ Verification: Rules are present in rule set!');
    console.log(`   Rules: ${verifyData.properties.rules.length}`);
    verifyData.properties.rules.forEach((rule, index) => {
      console.log(`     ${index + 1}. ${rule.name} (order: ${rule.order})`);
    });
  } else {
    console.log('   ⚠️  Verification: Rules may not have been saved (check Azure Portal)');
  }
  console.log('');
  
  return data;
}

async function main() {
  try {
    console.log('🚀 Updating globalRules with CORS for All White-Labeled Domains\n');
    console.log('='.repeat(60) + '\n');
    
    const accessToken = await getAzureAccessToken();
    const domains = await getAllWhiteLabeledDomains(accessToken);
    const ruleSet = await updateGlobalRulesWithCORS(accessToken, domains);
    
    console.log('='.repeat(60) + '\n');
    if (ruleSet) {
      console.log('✅ SUCCESS: globalRules updated with CORS configuration!');
      console.log(`   All ${domains.length} white-labeled domain(s) are now configured.`);
      console.log('   The rule set will handle CORS for all domains automatically.');
      console.log('   When new domains are added, just re-run this script to update.\n');
    } else {
      console.log('⚠️  No domains to configure.\n');
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

