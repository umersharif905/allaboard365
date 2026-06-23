/**
 * Script to check a specific rule set in Azure Front Door
 * Usage: node backend/scripts/check-ruleset.js globalRules
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

async function checkRuleSet(ruleSetName) {
  try {
    console.log(`\n🔍 Checking rule set: ${ruleSetName}\n`);
    
    const accessToken = await getAzureAccessToken();
    
    const ruleSetUrl = `https://management.azure.com/subscriptions/${AZURE_CONFIG.subscriptionId}/resourceGroups/${AZURE_CONFIG.resourceGroup}/providers/Microsoft.Cdn/profiles/${AZURE_CONFIG.profileName}/ruleSets/${ruleSetName}?api-version=${AZURE_CONFIG.apiVersion}`;
    
    const response = await fetch(ruleSetUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });
    
    const data = await response.json();
    
    if (!response.ok) {
      console.error('❌ Error:', data.error?.message || 'Unknown error');
      return;
    }
    
    console.log('✅ Rule Set Details:');
    console.log(`   Name: ${data.name}`);
    console.log(`   ID: ${data.id}`);
    console.log(`   Provisioning State: ${data.properties?.provisioningState || 'N/A'}`);
    console.log(`   Number of Rules: ${data.properties?.rules?.length || 0}\n`);
    
    if (data.properties?.rules && data.properties.rules.length > 0) {
      console.log('📋 Rules:\n');
      data.properties.rules.forEach((rule, index) => {
        console.log(`   Rule ${index + 1}: ${rule.name} (order: ${rule.order})`);
        
        if (rule.conditions && rule.conditions.length > 0) {
          console.log('   Conditions:');
          rule.conditions.forEach(cond => {
            if (cond.name === 'HostName') {
              console.log(`     - HostName: ${cond.parameters?.operator || 'N/A'} ${cond.parameters?.matchValues?.join(', ') || 'N/A'}`);
            } else {
              console.log(`     - ${cond.name}: ${JSON.stringify(cond.parameters)}`);
            }
          });
        }
        
        if (rule.actions && rule.actions.length > 0) {
          console.log('   Actions:');
          rule.actions.forEach(action => {
            console.log(`     - ${action.name}: ${JSON.stringify(action.parameters)}`);
          });
        }
        
        console.log('');
      });
    } else {
      console.log('⚠️  No rules found in this rule set\n');
    }
    
    // Check if it has CORS-related actions
    const hasCorsActions = data.properties?.rules?.some(rule => 
      rule.actions?.some(action => 
        action.name === 'ModifyResponseHeader' && 
        (action.parameters?.headerName?.toLowerCase().includes('access-control') ||
         action.parameters?.headerName?.toLowerCase() === 'cors')
      )
    );
    
    if (!hasCorsActions) {
      console.log('⚠️  ISSUE: This rule set does NOT have CORS headers configured!');
      console.log('   This is likely why CORS preflight requests are failing.\n');
    }
    
  } catch (error) {
    console.error('\n❌ Error:', error.message);
    if (error.stack) console.error(error.stack);
  }
}

const ruleSetName = process.argv[2] || 'globalRules';
checkRuleSet(ruleSetName);

