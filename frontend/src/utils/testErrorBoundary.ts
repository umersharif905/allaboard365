// frontend/src/utils/testErrorBoundary.ts
// Test utilities for the error boundary system

/**
 * Test function to trigger a React component error
 * Call this from a component to test error boundary
 */
export const triggerReactError = () => {
  throw new Error('🧪 Test React Error - This is a test error to verify error boundary');
};

/**
 * Test function to trigger a JavaScript error
 * Call this to test global error handler
 */
export const triggerJavaScriptError = () => {
  setTimeout(() => {
    // @ts-ignore - Intentionally calling undefined function
    window.nonExistentFunction();
  }, 100);
};

/**
 * Test function to trigger an unhandled promise rejection
 * Call this to test promise rejection handler
 */
export const triggerPromiseRejection = () => {
  Promise.reject(new Error('🧪 Test Promise Rejection - This is a test error'));
};

/**
 * Test function to trigger a network error
 * Call this to test API error handling
 */
export const triggerNetworkError = async () => {
  try {
    await fetch('https://invalid-domain-that-does-not-exist.com');
  } catch (error) {
    throw new Error('🧪 Test Network Error - This is a test error: ' + error);
  }
};

/**
 * Trigger all test errors in sequence
 * Use this for comprehensive testing
 */
export const runAllErrorTests = async () => {
  console.log('🧪 Starting error boundary tests...');
  
  console.log('1️⃣ Testing Promise Rejection...');
  triggerPromiseRejection();
  
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  console.log('2️⃣ Testing JavaScript Error...');
  triggerJavaScriptError();
  
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  console.log('3️⃣ Testing Network Error...');
  try {
    await triggerNetworkError();
  } catch (e) {
    console.log('Network error caught:', e);
  }
  
  console.log('✅ Error tests complete. Check error logs in database.');
  console.log('⚠️ React component error test must be called from a component');
};

// Make test functions available in browser console for manual testing
if (typeof window !== 'undefined') {
  (window as any).testErrorBoundary = {
    triggerReactError,
    triggerJavaScriptError,
    triggerPromiseRejection,
    triggerNetworkError,
    runAllErrorTests
  };
  
  console.log('🧪 Error boundary test utilities loaded!');
  console.log('📝 Available test functions:');
  console.log('  - window.testErrorBoundary.triggerJavaScriptError()');
  console.log('  - window.testErrorBoundary.triggerPromiseRejection()');
  console.log('  - window.testErrorBoundary.triggerNetworkError()');
  console.log('  - window.testErrorBoundary.runAllErrorTests()');
  console.log('  - window.testErrorBoundary.triggerReactError() (use in component)');
}

