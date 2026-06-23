#!/usr/bin/env node
/**
 * Test Environment Variables
 *
 * Validates backend environment variables and optionally tests live connections.
 * Use locally with backend/.env or against deployed API (api.qenroll.com).
 *
 * Usage:
 *   node test-env-vars.cjs              # Test local .env
 *   node test-env-vars.cjs --remote     # Test remote API (https://api.qenroll.com)
 */

const path = require('path');
const fs = require('fs');
const https = require('https');

// Load .env for local testing (use backend's dotenv)
const envPath = path.join(__dirname, 'backend', '.env');
if (fs.existsSync(envPath)) {
  try {
    require(path.join(__dirname, 'backend', 'node_modules', 'dotenv')).config({ path: envPath, override: true });
  } catch {
    try {
      require('dotenv').config({ path: envPath, override: true });
    } catch {
      console.warn('Note: Install dotenv or run from backend context to load .env');
    }
  }
}

const REMOTE_API = process.argv.includes('--remote') ? 'https://api.qenroll.com' : null;

// Required vars (some may be optional depending on features)
const REQUIRED = [
  'DB_SERVER', 'DB_NAME', 'DB_USER', 'DB_PASSWORD',
  'JWT_SECRET', 'JWT_REFRESH_SECRET',
  'AZURE_STORAGE_CONNECTION_STRING',
  'OAUTH_BASE_URL', 'OAUTH_CLIENT_ID', 'OAUTH_CLIENT_SECRET',
  'SENDGRID_API_KEY', 'DEFAULT_FROM_EMAIL',
  'ALLOWED_ORIGINS', 'BRAND', 'BYPASS_AUTH',
];

const RECOMMENDED = [
  'AZURE_STORAGE_ACCOUNT_NAME',
  'DIME_PROD_API_TOKEN', 'DIME_PROD_SID', 'DIME_PROD_API_BASE_URL',
  'OPENAI_API_KEY', 'ENCRYPTION_KEY',
];

const PLACEHOLDER_VALUES = [
  'your-oauth-secret', 'your-refresh-token-secret', 'your_secret', 'your_secret_here',
  'your_production_api_token_here', 'your_production_sid_here', 'your-32-character-encryption-key-here',
];

function checkVar(name, value) {
  const status = { name, set: !!value, placeholder: false, formatOk: true, message: '' };
  if (!value || value.trim() === '') {
    status.set = false;
    status.message = 'Missing or empty';
    return status;
  }
  if (PLACEHOLDER_VALUES.some(p => value.toLowerCase().includes(p.toLowerCase()))) {
    status.placeholder = true;
    status.message = 'Placeholder value - replace with real secret';
    return status;
  }
  // Azure Storage: value must NOT start with "AZURE_STORAGE_CONNECTION_STRING="
  if (name === 'AZURE_STORAGE_CONNECTION_STRING' && value.startsWith('AZURE_STORAGE_CONNECTION_STRING=')) {
    status.formatOk = false;
    status.message = 'Invalid: value should NOT include "AZURE_STORAGE_CONNECTION_STRING=" prefix (name is already the key)';
    return status;
  }
  if (name === 'AZURE_STORAGE_CONNECTION_STRING') {
    status.formatOk = value.includes('AccountName=') && value.includes('AccountKey=') && value.includes('EndpointSuffix=');
    if (!status.formatOk) status.message = 'Invalid format: expect DefaultEndpointsProtocol=https;AccountName=...;AccountKey=...;EndpointSuffix=...';
  }
  if (name === 'ALLOWED_ORIGINS') {
    const origins = value.split(',').map(o => o.trim()).filter(Boolean);
    if (!origins.some(o => o.includes('app.qenroll.com'))) {
      status.message = 'Should include https://app.qenroll.com';
    }
  }
  if (name === 'BYPASS_AUTH' && value.toLowerCase() !== 'false') {
    status.message = 'Should be "false" in production';
  }
  return status;
}

function maskSecret(s) {
  if (!s || s.length < 8) return '****';
  return s.substring(0, 4) + '...' + s.substring(s.length - 2);
}

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    }).on('error', reject);
  });
}

async function testLocal() {
  console.log('\n=== Environment Variable Validation (Local) ===\n');

  let hasErrors = false;

  for (const name of REQUIRED) {
    const value = process.env[name];
    const status = checkVar(name, value);
    const icon = status.set && !status.placeholder && status.formatOk ? '✅' : '❌';
    const display = status.set ? maskSecret(value) : '(empty)';
    console.log(`${icon} ${name.padEnd(35)} ${display}`);
    if (status.message) {
      console.log(`   └─ ${status.message}`);
      hasErrors = true;
    }
  }

  console.log('\n--- Recommended ---\n');
  for (const name of RECOMMENDED) {
    const value = process.env[name];
    const status = checkVar(name, value);
    const icon = status.set && !status.placeholder ? '✅' : '⚠️';
    const display = status.set ? maskSecret(value) : '(not set)';
    console.log(`${icon} ${name.padEnd(35)} ${display}`);
    if (status.message) console.log(`   └─ ${status.message}`);
  }

  // Test DB connection
  console.log('\n--- Connection Tests ---\n');
  try {
    const { testConnection } = require('./backend/config/database');
    const dbOk = await testConnection();
    console.log(dbOk ? '✅ Database: connected' : '❌ Database: failed');
  } catch (e) {
    console.log('❌ Database: ' + e.message);
    hasErrors = true;
  }

  // Test Azure Storage (if blob client initializes)
  try {
    const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
    if (connectionString && !connectionString.startsWith('AZURE_STORAGE_CONNECTION_STRING=')) {
      const blobPath = path.join(__dirname, 'backend', 'node_modules', '@azure', 'storage-blob');
      const { BlobServiceClient } = require(fs.existsSync(blobPath) ? blobPath : '@azure/storage-blob');
      const client = BlobServiceClient.fromConnectionString(connectionString);
      await client.getProperties();
      console.log('✅ Azure Storage: connected');
    } else {
      console.log('⚠️ Azure Storage: skipped (invalid connection string format)');
    }
  } catch (e) {
    if (e.code === 'MODULE_NOT_FOUND') {
      console.log('⚠️ Azure Storage: skipped (run from backend: npm run test:env)');
    } else {
      console.log('❌ Azure Storage: ' + (e.message || 'failed'));
      hasErrors = true;
    }
  }

  return hasErrors;
}

async function testRemote() {
  console.log(`\n=== Testing Remote API: ${REMOTE_API} ===\n`);

  try {
    const { status, data } = await fetchUrl(`${REMOTE_API}/health`);
    console.log('Health:', data.status || data);
    console.log('Database:', data.database || 'unknown');
    console.log('Auth Bypass:', data.auth_bypass);
    if (data.status === 'healthy') console.log('✅ Backend health OK');
    else console.log('⚠️ Backend health degraded');
  } catch (e) {
    console.log('❌ Health check failed:', e.message);
  }

  try {
    const { status, data } = await fetchUrl(`${REMOTE_API}/api/public/uploads/health`);
    if (status === 200) {
      console.log('\n✅ Azure Storage:', data.status || 'healthy');
    } else {
      console.log('\n⚠️ Storage health endpoint returned', status);
    }
  } catch (e) {
    console.log('\n⚠️ Storage check:', e.message);
  }

  try {
    const { status, data } = await fetchUrl(`${REMOTE_API}/config.json`);
    console.log('\nConfig:', JSON.stringify(data, null, 2));
    if (data.BRAND === 'qenroll') console.log('✅ BRAND=qenroll');
    else console.log('⚠️ BRAND=' + (data.BRAND || 'missing'));
  } catch (e) {
    console.log('\n⚠️ Config check:', e.message);
  }

  console.log('');
}

async function main() {
  if (REMOTE_API) {
    await testRemote();
  } else {
    const hasErrors = await testLocal();
    console.log(hasErrors ? '\n❌ Fix issues above and re-run.\n' : '\n✅ All checks passed.\n');
    process.exit(hasErrors ? 1 : 0);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
