/**
 * Script to update the existing mightywellPortal rule set with CORS rules
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

const DOMAIN_CONFIG = {
  fullDomain: 'portal.mightywellhealth.com',
  ruleSetName: 'mightywellPortal'
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

async function updateRuleSetWithCORS(accessToken) {
  console.log('\n📝 Updating Rule Set with CORS Rules...\n');
  console.log(`   Rule Set: ${DOMAIN_CONFIG.ruleSetName}`);
  console.log(`   Domain: ${DOMAIN_CONFIG.fullDomain}\n`);
  
  const ruleSetUrl = `https://management.azure.com/subscriptions/${AZURE_CONFIG.subscriptionId}/resourceGroups/${AZURE_CONFIG.resourceGroup}/providers/Microsoft.Cdn/profiles/${AZURE_CONFIG.profileName}/ruleSets/${DOMAIN_CONFIG.ruleSetName}?api-version=${AZURE_CONFIG.apiVersion}`;
  
  // First, get the current rule set to see its structure
  console.log('   Getting current rule set...');
  const getResponse = await fetch(ruleSetUrl, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    }
  });
  const currentData = await getResponse.json();
  console.log(`   Current rules: ${currentData.properties?.rules?.length || 0}\n`);
  
  // Create rule set with CORS rules
  // Note: Using the format from Azure Front Door API documentation
  const ruleSetBody = {
    properties: {
      rules: [
        {
          name: "HandleOptions",
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
                matchValues: [DOMAIN_CONFIG.fullDomain]
              }
            }
          ],
          actions: [
            {
              name: "ModifyResponseHeader",
              parameters: {
                headerAction: "Overwrite",
                headerName: "Access-Control-Allow-Origin",
                value: `https://${DOMAIN_CONFIG.fullDomain}`
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
                forwardingProtocol: "MatchRequest",
                cacheConfiguration: {
                  queryStringCachingBehavior: "IgnoreQueryString",
                  queryParameters: "",
                  compressionSettings: {
                    isCompressionEnabled: false
                  }
                }
              }
            }
          ]
        },
        {
          name: "AddCorsHeaders",
          order: 2,
          conditions: [
            {
              name: "HostName",
              parameters: {
                operator: "Equal",
                matchValues: [DOMAIN_CONFIG.fullDomain]
              }
            }
          ],
          actions: [
            {
              name: "ModifyResponseHeader",
              parameters: {
                headerAction: "Append",
                headerName: "Access-Control-Allow-Origin",
                value: `https://${DOMAIN_CONFIG.fullDomain}`
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
  
  console.log('   Sending PUT request to update rule set with CORS rules...');
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
  
  if (data.properties?.rules && data.properties.rules.length > 0) {
    console.log('   Rules created:');
    data.properties.rules.forEach((rule, index) => {
      console.log(`     ${index + 1}. ${rule.name} (order: ${rule.order})`);
      if (rule.conditions) {
        rule.conditions.forEach(cond => {
          if (cond.name === 'HostName') {
            console.log(`        Condition: HostName = ${cond.parameters?.matchValues?.join(', ')}`);
          } else if (cond.name === 'RequestMethod') {
            console.log(`        Condition: RequestMethod = ${cond.parameters?.matchValues?.join(', ')}`);
          }
        });
      }
      if (rule.actions) {
        const corsActions = rule.actions.filter(a => a.name === 'ModifyResponseHeader' && 
          a.parameters?.headerName?.includes('Access-Control'));
        if (corsActions.length > 0) {
          console.log(`        CORS Headers: ${corsActions.length} configured`);
        }
      }
    });
    console.log('');
  }
  
  return data;
}

async function main() {
  try {
    console.log('🚀 Updating Rule Set with CORS Configuration\n');
    console.log('='.repeat(60) + '\n');
    
    const accessToken = await getAzureAccessToken();
    const ruleSet = await updateRuleSetWithCORS(accessToken);
    
    console.log('='.repeat(60) + '\n');
    console.log('✅ SUCCESS: Rule set updated with CORS rules!');
    console.log('   The rule set should now handle CORS preflight requests.');
    console.log('   Please wait a few minutes for Azure to propagate the changes.\n');
    
  } catch (error) {
    console.error('\n❌ ERROR:', error.message);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

main();

