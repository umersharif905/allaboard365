// test-api.js
// Simple script to test API endpoints

const axios = require('axios');

const API_URL = 'http://localhost:3001';

async function testAPI() {
  console.log('🧪 Testing Open-Enroll API...\n');

  // Test 1: Health check
  try {
    console.log('📍 Testing health endpoint...');
    const health = await axios.get(`${API_URL}/health`);
    console.log('✅ Health check passed:', health.data);
  } catch (error) {
    console.error('❌ Health check failed:', error.message);
  }

  // Test 2: Auth endpoint (should work without token)
  try {
    console.log('\n📍 Testing auth endpoint...');
    const auth = await axios.post(`${API_URL}/api/auth/oauth/callback`, {
      code: 'test-code',
      redirect_uri: 'http://localhost:5173/auth/callback'
    });
    console.log('✅ Auth endpoint accessible');
  } catch (error) {
    // This should fail with proper error
    if (error.response && error.response.status === 500) {
      console.log('✅ Auth endpoint accessible (returns expected error)');
    } else {
      console.error('❌ Auth endpoint error:', error.message);
    }
  }

  // Test 3: Protected endpoint (should fail without token)
  try {
    console.log('\n📍 Testing protected endpoint...');
    const users = await axios.get(`${API_URL}/api/users`);
    console.log('❌ Protected endpoint accessible without token (security issue!)');
  } catch (error) {
    if (error.response && error.response.status === 401) {
      console.log('✅ Protected endpoint properly secured');
    } else {
      console.error('❌ Unexpected error:', error.message);
    }
  }

  console.log('\n✅ API tests complete!');
}

testAPI();
