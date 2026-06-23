// Error Tracking Utility
// Tracks API errors with detailed context for debugging production issues

interface ApiErrorLog {
  timestamp: string;
  endpoint: string;
  method: string;
  status?: number;
  error: string;
  errorType: 'network' | 'json_parse' | 'api_error' | 'timeout';
  requestUrl: string;
  userAgent: string;
  environment: string;
  additionalContext?: any;
}

class ErrorTracker {
  private errors: ApiErrorLog[] = [];
  private maxErrors = 50; // Keep last 50 errors in memory
  private loggingEnabled = true;

  /**
   * Track an API error with full context
   */
  trackApiError(config: {
    endpoint: string;
    method: string;
    requestUrl: string;
    status?: number;
    error: Error | string;
    errorType: ApiErrorLog['errorType'];
    additionalContext?: any;
  }) {
    const errorLog: ApiErrorLog = {
      timestamp: new Date().toISOString(),
      endpoint: config.endpoint,
      method: config.method,
      status: config.status,
      error: config.error instanceof Error ? config.error.message : config.error,
      errorType: config.errorType,
      requestUrl: config.requestUrl,
      userAgent: navigator.userAgent,
      environment: import.meta.env.MODE || 'production',
      additionalContext: config.additionalContext
    };

    // Add to in-memory log
    this.errors.push(errorLog);
    if (this.errors.length > this.maxErrors) {
      this.errors.shift(); // Remove oldest error
    }

    // Log to console in development
    if (this.loggingEnabled && import.meta.env.DEV) {
      console.group('🚨 API Error Tracked');
      console.error('Error Details:', errorLog);
      console.trace('Stack Trace:');
      console.groupEnd();
    }

    // Log to console in production with structured format
    if (this.loggingEnabled && !import.meta.env.DEV) {
      console.error('[API_ERROR]', JSON.stringify(errorLog));
    }

    // Send to backend logging service (optional)
    this.sendToLoggingService(errorLog);

    return errorLog;
  }

  /**
   * Send error to backend logging service
   */
  private async sendToLoggingService(errorLog: ApiErrorLog) {
    // Only send in production
    if (import.meta.env.DEV) return;

    try {
      // Send to your logging endpoint (implement this based on your needs)
      await fetch('/api/logs/frontend-errors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(errorLog),
      }).catch(() => {
        // Silently fail - don't want error tracking to cause more errors
      });
    } catch (err) {
      // Silently fail
    }
  }

  /**
   * Get recent errors for debugging
   */
  getRecentErrors(): ApiErrorLog[] {
    return [...this.errors];
  }

  /**
   * Export errors for support/debugging
   */
  exportErrors(): string {
    return JSON.stringify(this.errors, null, 2);
  }

  /**
   * Clear error log
   */
  clearErrors() {
    this.errors = [];
  }

  /**
   * Enable/disable logging
   */
  setLoggingEnabled(enabled: boolean) {
    this.loggingEnabled = enabled;
  }

  /**
   * Check if a URL is returning HTML instead of JSON
   */
  detectHtmlResponse(error: string): boolean {
    return error.includes('<!DOCTYPE') || 
           error.includes('Unexpected token \'<\'') ||
           error.includes('is not valid JSON');
  }

  /**
   * Get helpful error message based on error type
   */
  getHelpfulErrorMessage(errorLog: ApiErrorLog): string {
    if (this.detectHtmlResponse(errorLog.error)) {
      return `API endpoint returned HTML instead of JSON. This usually means:
        1. The API endpoint doesn't exist (404)
        2. There's a routing issue (frontend trying to call relative URL on wrong domain)
        3. The backend server is down or misconfigured
        
        Expected URL: ${errorLog.requestUrl}
        
        Solution:
        - Check if API_CONFIG.BASE_URL is set correctly
        - Verify the endpoint exists on the backend
        - Check browser network tab for actual URL being called`;
    }

    switch (errorLog.errorType) {
      case 'network':
        return 'Network error - check internet connection or server availability';
      case 'json_parse':
        return 'Invalid JSON response - server may be returning error page';
      case 'timeout':
        return 'Request timed out - server may be slow or unavailable';
      default:
        return `API error - ${errorLog.error}`;
    }
  }
}

// Export singleton instance
export const errorTracker = new ErrorTracker();

// Export types
export type { ApiErrorLog };

// Make available globally for debugging
if (typeof window !== 'undefined') {
  (window as any).errorTracker = errorTracker;
  console.log('✅ Error tracker available at window.errorTracker');
  console.log('   - window.errorTracker.getRecentErrors() - View recent errors');
  console.log('   - window.errorTracker.exportErrors() - Export all errors as JSON');
  console.log('   - window.errorTracker.clearErrors() - Clear error log');
}

