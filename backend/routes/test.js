// DEBUG BACKEND ROUTES - Step by Step Debugging
// Run these tests to identify the exact issues

// 1. FIRST - Check if backend server is running and basic routes work
console.log('🔍 DEBUGGING BACKEND ROUTES');
console.log('==========================');

// Test 1: Basic health check
async function testHealthCheck() {
  try {
    const response = await fetch('http://localhost:3001/health');
    console.log('🏥 Health Check:', response.status === 200 ? '✅ WORKING' : '❌ FAILED');
    if (response.status === 200) {
      const data = await response.json();
      console.log('   Response:', data);
    }
    return response.status === 200;
  } catch (error) {
    console.log('❌ Health Check FAILED:', error.message);
    return false;
  }
}

// Test 2: Check if routes are mounted correctly
async function testRoutesMounting() {
  try {
    const response = await fetch('http://localhost:3001/api/debug/routes');
    console.log('🛣️ Routes Debug:', response.status === 200 ? '✅ WORKING' : '❌ FAILED');
    if (response.status === 200) {
      const data = await response.json();
      console.log('   Found routes:', data.routes.length);
      
      // Check if our specific routes are mounted
      const marketplaceRoutes = data.routes.filter(r => r.path?.includes('marketplace'));
      const productRoutes = data.routes.filter(r => r.path?.includes('products'));
      
      console.log('   Marketplace routes:', marketplaceRoutes.length);
      console.log('   Product routes:', productRoutes.length);
      
      return true;
    }
    return false;
  } catch (error) {
    console.log('❌ Routes Debug FAILED:', error.message);
    return false;
  }
}

// Test 3: Check authentication token
async function testAuthToken() {
  const token = localStorage.getItem('accessToken');
  console.log('🔑 Auth Token:', token ? '✅ FOUND' : '❌ MISSING');
  
  if (!token) {
    console.log('   ⚠️ No access token found in localStorage');
    console.log('   💡 Try logging in again or check browser Application tab');
    return false;
  }
  
  console.log('   Token length:', token.length);
  console.log('   Token preview:', token.substring(0, 20) + '...');
  return true;
}

// Test 4: Test marketplace tenants endpoint with detailed logging
async function testMarketplaceTenants() {
  console.log('\n🏢 TESTING MARKETPLACE TENANTS ENDPOINT');
  console.log('========================================');
  
  const token = localStorage.getItem('accessToken');
  if (!token) {
    console.log('❌ No token available for testing');
    return false;
  }
  
  try {
    const response = await fetch('http://localhost:3001/api/marketplace/tenants', {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });
    
    console.log('📬 Response Status:', response.status);
    console.log('📬 Response OK:', response.ok);
    
    const responseText = await response.text();
    console.log('📬 Response Text:', responseText);
    
    if (response.status === 500) {
      console.log('❌ SERVER ERROR (500)');
      console.log('   Possible causes:');
      console.log('   - Database connection failed');
      console.log('   - Table oe.Tenants does not exist');
      console.log('   - Authentication middleware error');
      console.log('   - SQL query error');
      
      try {
        const errorData = JSON.parse(responseText);
        console.log('   Error details:', errorData);
      } catch (e) {
        console.log('   Raw error response:', responseText);
      }
    }
    
    return response.ok;
  } catch (error) {
    console.log('❌ Network Error:', error.message);
    return false;
  }
}

// Test 5: Test product details endpoint
async function testProductDetails() {
  console.log('\n📦 TESTING PRODUCT DETAILS ENDPOINT');
  console.log('===================================');
  
  const token = localStorage.getItem('accessToken');
  if (!token) {
    console.log('❌ No token available for testing');
    return false;
  }
  
  const productId = '55048551-4A36-4CC7-BF6A-5CDE8B130326'; // From your error log
  
  try {
    const response = await fetch(`http://localhost:3001/api/products/${productId}/details`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });
    
    console.log('📬 Response Status:', response.status);
    console.log('📬 Response OK:', response.ok);
    
    const responseText = await response.text();
    console.log('📬 Response Text:', responseText);
    
    if (response.status === 404) {
      console.log('❌ NOT FOUND (404)');
      console.log('   Possible causes:');
      console.log('   - Route not properly mounted');
      console.log('   - Authentication middleware blocking request');
      console.log('   - Product ID format invalid');
      console.log('   - Database record not found');
      
      // Try the fallback endpoint
      console.log('\n🔄 Trying fallback endpoint...');
      const fallbackResponse = await fetch(`http://localhost:3001/api/products/${productId}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });
      
      console.log('📬 Fallback Status:', fallbackResponse.status);
      if (fallbackResponse.ok) {
        console.log('✅ Fallback endpoint works! Use /api/products/:id instead');
      }
    }
    
    return response.ok;
  } catch (error) {
    console.log('❌ Network Error:', error.message);
    return false;
  }
}

// Test 6: Test database connection directly
async function testDatabaseConnection() {
  console.log('\n🗄️ TESTING DATABASE CONNECTION');
  console.log('==============================');
  
  const token = localStorage.getItem('accessToken');
  if (!token) {
    console.log('❌ No token available for testing');
    return false;
  }
  
  try {
    // Test with a simple endpoint that should work
    const response = await fetch('http://localhost:3001/api/tenants', {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });
    
    console.log('📬 Regular Tenants Endpoint Status:', response.status);
    
    if (response.ok) {
      console.log('✅ Database connection works with /api/tenants');
      const data = await response.json();
      console.log('   Found tenants:', data.data?.length || 0);
    } else {
      console.log('❌ Database connection issues');
      const errorText = await response.text();
      console.log('   Error:', errorText);
    }
    
    return response.ok;
  } catch (error) {
    console.log('❌ Database test failed:', error.message);
    return false;
  }
}

// Main debugging function
async function runDebugging() {
  console.log('🚀 STARTING BACKEND DEBUGGING');
  console.log('============================\n');
  
  const results = {
    health: await testHealthCheck(),
    routes: await testRoutesMounting(),
    auth: await testAuthToken(),
    marketplaceTenants: await testMarketplaceTenants(),
    productDetails: await testProductDetails(),
    database: await testDatabaseConnection()
  };
  
  console.log('\n📊 DEBUGGING RESULTS SUMMARY');
  console.log('============================');
  console.log('Health Check:        ', results.health ? '✅' : '❌');
  console.log('Routes Mounted:      ', results.routes ? '✅' : '❌');
  console.log('Auth Token:          ', results.auth ? '✅' : '❌');
  console.log('Marketplace Tenants: ', results.marketplaceTenants ? '✅' : '❌');
  console.log('Product Details:     ', results.productDetails ? '✅' : '❌');
  console.log('Database Connection: ', results.database ? '✅' : '❌');
  
  console.log('\n🎯 NEXT STEPS');
  console.log('============');
  
  if (!results.health) {
    console.log('1. ⚠️ Backend server not running - Start with: npm run dev');
  } else if (!results.auth) {
    console.log('1. ⚠️ Login required - Go to login page and authenticate');
  } else if (!results.database) {
    console.log('1. ⚠️ Database connection issues - Check .env file and database');
  } else if (!results.marketplaceTenants) {
    console.log('1. ⚠️ Marketplace tenants endpoint failing - Check server logs');
  } else if (!results.productDetails) {
    console.log('1. ⚠️ Product details endpoint failing - Check route mounting');
  } else {
    console.log('1. ✅ All tests passed - Issue might be in frontend code');
  }
}

// INSTRUCTIONS FOR USAGE:
// 1. Open browser console (F12)
// 2. Copy and paste this entire code
// 3. Run: runDebugging()
// 4. Check the results and follow the next steps

console.log('🛠️ DEBUGGING TOOLS LOADED');
console.log('To run debugging: runDebugging()');