// frontend/src/utils/persistentErrorLogger.ts
// Persistent error logger that stores errors in localStorage to survive page refreshes

interface PersistentError {
  id: string;
  timestamp: string;
  message: string;
  stack?: string;
  url: string;
  pathname: string;
  userAgent: string;
  userId?: string;
  tenantId?: string;
  errorType: 'React' | 'JavaScript' | 'Network' | 'UnhandledRejection' | 'Unknown';
  additionalContext?: Record<string, any>;
}

class PersistentErrorLogger {
  private readonly STORAGE_KEY = 'openenroll_errors';
  private readonly MAX_ERRORS = 20; // Keep last 20 errors

  /**
   * Log an error to localStorage (persists through page refreshes)
   */
  logError(error: Error | string, additionalContext?: Record<string, any>): string {
    const errorId = `err_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const errorLog: PersistentError = {
      id: errorId,
      timestamp: new Date().toISOString(),
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      url: window.location.href,
      pathname: window.location.pathname,
      userAgent: navigator.userAgent,
      errorType: this.determineErrorType(error),
      additionalContext
    };

    // Try to get user info from localStorage
    try {
      const userStr = localStorage.getItem('user');
      if (userStr) {
        const user = JSON.parse(userStr);
        errorLog.userId = user.userId || user.UserId;
        errorLog.tenantId = user.tenantId || user.TenantId;
      }
    } catch (e) {
      // Ignore parsing errors
    }

    // Get existing errors
    const existingErrors = this.getErrors();
    
    // Add new error
    existingErrors.unshift(errorLog);
    
    // Keep only the most recent errors
    if (existingErrors.length > this.MAX_ERRORS) {
      existingErrors.splice(this.MAX_ERRORS);
    }

    // Save to localStorage
    try {
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(existingErrors));
      console.error('🔴 Error logged to localStorage:', errorLog);
    } catch (e) {
      console.error('Failed to save error to localStorage:', e);
      // If localStorage is full, try to clear old errors
      if (e instanceof DOMException && e.code === 22) {
        this.clearOldErrors();
        try {
          localStorage.setItem(this.STORAGE_KEY, JSON.stringify([errorLog]));
        } catch (e2) {
          console.error('Failed to save error even after clearing:', e2);
        }
      }
    }

    return errorId;
  }

  /**
   * Get all stored errors
   */
  getErrors(): PersistentError[] {
    try {
      const errorsStr = localStorage.getItem(this.STORAGE_KEY);
      if (!errorsStr) return [];
      return JSON.parse(errorsStr);
    } catch (e) {
      console.error('Failed to read errors from localStorage:', e);
      return [];
    }
  }

  /**
   * Clear all stored errors
   */
  clearErrors(): void {
    localStorage.removeItem(this.STORAGE_KEY);
  }

  /**
   * Clear old errors (keep only the 10 most recent)
   */
  private clearOldErrors(): void {
    const errors = this.getErrors();
    if (errors.length > 10) {
      const recentErrors = errors.slice(0, 10);
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(recentErrors));
    }
  }

  /**
   * Determine error type from error object
   */
  private determineErrorType(error: Error | string): PersistentError['errorType'] {
    if (typeof error === 'string') return 'Unknown';

    const message = typeof (error as any)?.message === 'string'
      ? (error as any).message.toLowerCase()
      : '';
    if (message.includes('react') || message.includes('component')) return 'React';
    if (message.includes('network') || message.includes('fetch') || message.includes('axios')) return 'Network';
    if (message.includes('promise') || message.includes('rejection')) return 'UnhandledRejection';
    return 'JavaScript';
  }

  /**
   * Get the most recent error
   */
  getLatestError(): PersistentError | null {
    const errors = this.getErrors();
    return errors.length > 0 ? errors[0] : null;
  }

  /**
   * Check if there are any errors
   */
  hasErrors(): boolean {
    return this.getErrors().length > 0;
  }
}

// Export singleton instance
export const persistentErrorLogger = new PersistentErrorLogger();

// Setup global error handlers that log to localStorage
if (typeof window !== 'undefined') {
  // Catch unhandled errors
  window.addEventListener('error', (event) => {
    persistentErrorLogger.logError(event.error || new Error(event.message), {
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno
    });
  });

  // Catch unhandled promise rejections
  window.addEventListener('unhandledrejection', (event) => {
    const error = event.reason instanceof Error 
      ? event.reason 
      : new Error(String(event.reason));
    persistentErrorLogger.logError(error, {
      type: 'unhandledrejection'
    });
  });

  // Log errors before page unload
  window.addEventListener('beforeunload', () => {
    // Errors are already logged, but we can add a marker
    const latestError = persistentErrorLogger.getLatestError();
    if (latestError) {
      console.error('🔴 Latest error before unload:', latestError);
    }
  });
}

// Expose to window for debugging
if (typeof window !== 'undefined') {
  (window as any).viewErrors = () => {
    const errors = persistentErrorLogger.getErrors();
    console.table(errors);
    return errors;
  };
  
  (window as any).clearErrors = () => {
    persistentErrorLogger.clearErrors();
    console.log('✅ Errors cleared');
  };
  
  (window as any).getLatestError = () => {
    const error = persistentErrorLogger.getLatestError();
    console.log('Latest error:', error);
    return error;
  };
}

