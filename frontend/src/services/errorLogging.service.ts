// frontend/src/services/errorLogging.service.ts
import { apiService } from './api.service';

/**
 * Error data structure sent to backend
 */
export interface ErrorLogData {
  errorType: 'React' | 'JavaScript' | 'Network' | 'Manual' | 'UnhandledRejection';
  message: string;
  stack: string;
  componentStack?: string;
  url?: string;
  pathname?: string;
  search?: string;
  hash?: string;
  userId?: string;
  userEmail?: string;
  tenantId?: string;
  userAgent?: string;
  browserInfo?: {
    name: string;
    version: string;
    isMobile: boolean;
  };
  viewport?: {
    width: number;
    height: number;
  };
  screen?: {
    width: number;
    height: number;
    colorDepth: number;
  };
  sessionInfo?: {
    referrer: string;
    language: string;
    platform: string;
    cookieEnabled: boolean;
    onLine: boolean;
  };
  timestamp?: string;
  severity?: 'low' | 'medium' | 'high' | 'critical';
  [key: string]: any; // Allow additional custom fields
}

/**
 * Response from error logging API
 */
interface ErrorLogResponse {
  success: boolean;
  errorId: string;
  message?: string;
}

class ErrorLoggingService {
  private readonly endpoint = '/api/errors/log';
  private readonly batchSize = 10;
  private readonly batchDelay = 5000; // 5 seconds
  private errorQueue: ErrorLogData[] = [];
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private isProcessing = false;

  /**
   * Log a single error to the backend
   */
  async logError(errorData: ErrorLogData): Promise<string> {
    try {
      const response = await this.sendToBackend(errorData);
      return response.errorId;
    } catch (error) {
      // If immediate send fails, try queueing for batch send
      console.warn('Failed to send error immediately, queuing for batch send:', error);
      this.queueError(errorData);
      return 'queued';
    }
  }

  /**
   * Log multiple errors in batch
   */
  async logErrorBatch(errors: ErrorLogData[]): Promise<string[]> {
    try {
      const data = await apiService.post<{ errorIds: string[] }>('/api/errors/log-batch', { errors });
      return data.errorIds || [];
    } catch (error) {
      console.error('Failed to send error batch:', error);
      return [];
    }
  }

  /**
   * Queue error for batch sending (fallback when immediate send fails)
   */
  private queueError(errorData: ErrorLogData): void {
    this.errorQueue.push(errorData);

    // Start batch timer if not already running
    if (!this.batchTimer) {
      this.batchTimer = setTimeout(() => this.processBatch(), this.batchDelay);
    }

    // If queue is full, process immediately
    if (this.errorQueue.length >= this.batchSize) {
      this.processBatch();
    }
  }

  /**
   * Process queued errors in batch
   */
  private async processBatch(): Promise<void> {
    if (this.isProcessing || this.errorQueue.length === 0) {
      return;
    }

    this.isProcessing = true;

    // Clear timer
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }

    // Take batch from queue
    const batch = this.errorQueue.splice(0, this.batchSize);

    try {
      await this.logErrorBatch(batch);
    } catch (error) {
      console.error('Failed to process error batch:', error);
      // Could implement retry logic here if needed
    } finally {
      this.isProcessing = false;

      // If there are more errors, schedule next batch
      if (this.errorQueue.length > 0) {
        this.batchTimer = setTimeout(() => this.processBatch(), this.batchDelay);
      }
    }
  }

  /**
   * Send error to backend API
   */
  private async sendToBackend(errorData: ErrorLogData): Promise<ErrorLogResponse> {
    return await apiService.post<ErrorLogResponse>(this.endpoint, errorData);
  }

  /**
   * Get authentication headers if token exists
   */
  private getAuthHeaders(): HeadersInit {
    const token = localStorage.getItem('accessToken');
    if (token) {
      return {
        'Authorization': `Bearer ${token}`
      };
    }
    return {};
  }

  /**
   * Flush all queued errors immediately
   */
  async flush(): Promise<void> {
    if (this.errorQueue.length > 0) {
      await this.processBatch();
    }
  }
}

// Export singleton instance
export const errorLoggingService = new ErrorLoggingService();

// Import test utilities in development
if (process.env.NODE_ENV === 'development' && typeof window !== 'undefined') {
  import('../utils/testErrorBoundary').then(() => {
    console.log('✅ Error boundary test utilities loaded (check window.testErrorBoundary)');
  });
}

// Setup global error handlers
if (typeof window !== 'undefined') {
  /**
   * Catch unhandled JavaScript errors
   */
  window.addEventListener('error', (event) => {
    console.error('🔴 Global error caught:', event.error);
    
    errorLoggingService.logError({
      errorType: 'JavaScript',
      message: event.message,
      stack: event.error?.stack || '',
      url: window.location.href,
      pathname: window.location.pathname,
      timestamp: new Date().toISOString(),
      severity: 'high',
      // Additional context
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno
    } as ErrorLogData);
  });

  /**
   * Catch unhandled Promise rejections
   */
  window.addEventListener('unhandledrejection', (event) => {
    console.error('🔴 Unhandled promise rejection:', event.reason);

    const error = event.reason;
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : '';

    errorLoggingService.logError({
      errorType: 'UnhandledRejection',
      message: `Unhandled Promise Rejection: ${message}`,
      stack: stack || '',
      url: window.location.href,
      pathname: window.location.pathname,
      timestamp: new Date().toISOString(),
      severity: 'high'
    });
  });

  /**
   * Flush errors before page unload
   */
  window.addEventListener('beforeunload', () => {
    errorLoggingService.flush();
  });

  /**
   * Optional: Override console.error to catch logged errors
   * (Commented out by default to avoid noise, uncomment if needed)
   */
  // const originalConsoleError = console.error;
  // console.error = (...args: any[]) => {
  //   originalConsoleError.apply(console, args);
  //   
  //   // Only log if first argument looks like an error
  //   if (args[0] instanceof Error) {
  //     errorLoggingService.logError({
  //       errorType: 'Manual',
  //       message: args[0].message,
  //       stack: args[0].stack || '',
  //       url: window.location.href,
  //       pathname: window.location.pathname,
  //       timestamp: new Date().toISOString(),
  //       severity: 'medium'
  //     });
  //   }
  // };
}

