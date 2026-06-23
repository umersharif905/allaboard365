// API Configuration Verification Utility
import { API_CONFIG } from '../config/api';

interface ApiConfigVerification {
  isValid: boolean;
  environment: string;
  baseUrl: string;
  issues: string[];
  recommendations: string[];
}

/**
 * Verify API configuration is set up correctly
 */
export function verifyApiConfig(): ApiConfigVerification {
  const issues: string[] = [];
  const recommendations: string[] = [];
  
  // Get environment
  const environment = import.meta.env.MODE || 'unknown';
  const baseUrl = API_CONFIG.BASE_URL;

  // Check 1: Environment is set
  if (!import.meta.env.MODE) {
    issues.push('import.meta.env.MODE is not set');
    recommendations.push('Set MODE environment variable during build');
  }

  // Check 2: BASE_URL exists
  if (!baseUrl) {
    issues.push('API_CONFIG.BASE_URL is undefined or empty');
    recommendations.push('Check config/api.ts configuration');
  }

  // Check 3: BASE_URL is not localhost in production
  if (environment === 'production' && baseUrl?.includes('localhost')) {
    issues.push('Production is using localhost URL');
    recommendations.push('Update production config to use https://api.allaboard365.com');
  }

  // Check 4: BASE_URL uses correct protocol
  if (baseUrl && !baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
    issues.push('BASE_URL does not start with http:// or https://');
    recommendations.push('Add protocol to BASE_URL');
  }

  // Check 5: BASE_URL doesn't end with /api (to avoid double /api)
  if (baseUrl?.endsWith('/api')) {
    issues.push('BASE_URL ends with /api - this will cause issues');
    recommendations.push('Remove /api from BASE_URL (it should be added in fetch calls)');
  }

  // Check 6: Development uses localhost
  // if (environment === 'development' && !baseUrl?.includes('localhost')) {
  //   issues.push('Development is not using localhost');
  //   recommendations.push('Development should use http://localhost:3001');
  // }

  return {
    isValid: issues.length === 0,
    environment,
    baseUrl,
    issues,
    recommendations
  };
}

/**
 * Log configuration verification to console
 */
export function logApiConfigVerification() {
  const verification = verifyApiConfig();
  
  console.group('🔍 API Configuration Verification');
  
  console.log('Environment:', verification.environment);
  console.log('API Base URL:', verification.baseUrl);
  console.log('OAuth URL:', API_CONFIG.OAUTH_URL);
  console.log('Status:', verification.isValid ? '✅ VALID' : '❌ INVALID');
  
  if (verification.issues.length > 0) {
    console.group('⚠️ Issues Found:');
    verification.issues.forEach(issue => console.error(`  - ${issue}`));
    console.groupEnd();
  }
  
  if (verification.recommendations.length > 0) {
    console.group('💡 Recommendations:');
    verification.recommendations.forEach(rec => console.log(`  - ${rec}`));
    console.groupEnd();
  }
  
  if (verification.isValid) {
    console.log('✅ Configuration is correct!');
  }
  
  console.groupEnd();
  
  return verification;
}

/**
 * Test if API is reachable
 */
export async function testApiConnection(): Promise<{
  success: boolean;
  status?: number;
  message: string;
  responseUrl?: string;
}> {
  const baseUrl = API_CONFIG.BASE_URL;
  
  if (!baseUrl) {
    return {
      success: false,
      message: 'BASE_URL is not configured'
    };
  }

  try {
    // Test health endpoint
    const testUrl = `${baseUrl}/health`;
    console.log('🧪 Testing API connection:', testUrl);
    
    const response = await fetch(testUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json'
      }
    });

    return {
      success: response.ok,
      status: response.status,
      message: response.ok 
        ? 'API is reachable' 
        : `API returned status ${response.status}`,
      responseUrl: response.url
    };
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : 'Connection failed'
    };
  }
}

/**
 * Full diagnostic check
 */
export async function runFullDiagnostic() {
  console.group('🏥 Running Full API Diagnostic');
  
  // Step 1: Verify configuration
  console.log('\n📋 Step 1: Verify Configuration');
  const configCheck = logApiConfigVerification();
  
  // Step 2: Test connection
  console.log('\n🌐 Step 2: Test API Connection');
  const connectionTest = await testApiConnection();
  console.log('Result:', connectionTest.success ? '✅' : '❌', connectionTest.message);
  if (connectionTest.responseUrl) {
    console.log('Response URL:', connectionTest.responseUrl);
  }
  
  // Step 3: Show expected vs actual
  console.log('\n🎯 Step 3: Expected vs Actual');
  console.table({
    Environment: {
      Expected: import.meta.env.DEV ? 'development' : 'production',
      Actual: import.meta.env.MODE || 'unknown'
    },
    'Base URL': {
      Expected: import.meta.env.DEV ? 'http://localhost:3001' : 'https://api.allaboard365.com',
      Actual: API_CONFIG.BASE_URL
    }
  });
  
  console.groupEnd();
  
  return {
    configValid: configCheck.isValid,
    apiReachable: connectionTest.success,
    overallStatus: configCheck.isValid && connectionTest.success
  };
}

// Make available globally for debugging
if (typeof window !== 'undefined') {
  (window as any).verifyApiConfig = {
    check: verifyApiConfig,
    log: logApiConfigVerification,
    test: testApiConnection,
    full: runFullDiagnostic
  };
  
  console.log('✅ API verification available:');
  console.log('   - window.verifyApiConfig.check() - Get verification object');
  console.log('   - window.verifyApiConfig.log() - Log verification to console');
  console.log('   - window.verifyApiConfig.test() - Test API connection');
  console.log('   - window.verifyApiConfig.full() - Run full diagnostic');
}

