/**
 * Test creating a simple rule set to understand the correct format
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

async function testSimpleRuleSet(accessToken) {
  const ruleSetName = 'testCorsRules';
  const fullDomain = 'portal.mightywellhealth.com';
  
  console.log(`\n🔍 Testing simple rule set creation: ${ruleSetName}\n`);
  
  const ruleSetUrl = `https://management.azure.com/subscriptions/${AZURE_CONFIG.subscriptionId}/resourceGroups/${AZURE_CONFIG.resourceGroup}/providers/Microsoft.Cdn/profiles/${AZURE_CONFIG.profileName}/ruleSets/${ruleSetName}?api-version=${AZURE_CONFIG.apiVersion}`;
  
  // Try the exact format from WhiteLabelDNS.md first
  const ruleSetBody = {
    properties: {
      rules: [
        {
          name: "CorsRule",
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
              name: "ModifyResponseHeader",
              parameters: {
                headerAction: "Append",
                headerName: "Access-Control-Allow-Origin",
                value: `https://${fullDomain}`
              }
            }
          ]
        }
      ]
    }
  };
  
  console.log('Request body:', JSON.stringify(ruleSetBody, null, 2));
  console.log('\nSending PUT request...\n');
  
  const response = await fetch(ruleSetUrl, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(ruleSetBody)
  });
  
  const data = await response.json();
  
  console.log('Response status:', response.status);
  console.log('Response:', JSON.stringify(data, null, 2));
  
  if (response.ok) {
    console.log('\n✅ Rule set created!');
    console.log(`Rules: ${data.properties?.rules?.length || 0}`);
    
    // Wait and check again
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    const checkResponse = await fetch(ruleSetUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });
    const checkData = await checkResponse.json();
    console.log('\nAfter 3 seconds:');
    console.log(`Rules: ${checkData.properties?.rules?.length || 0}`);
    if (checkData.properties?.rules && checkData.properties.rules.length > 0) {
      console.log('Rules:', JSON.stringify(checkData.properties.rules, null, 2));
    }
  } else {
    console.log('\n❌ Failed:', data.error?.message);
  }
}

async function main() {
  try {
    const accessToken = await getAzureAccessToken();
    await testSimpleRuleSet(accessToken);
  } catch (error) {
    console.error('\n❌ ERROR:', error.message);
    if (error.stack) console.error(error.stack);
  }
}

main();

