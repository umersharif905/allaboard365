// src/components/common/ErrorBoundary.tsx
import { Component, ErrorInfo, ReactNode } from 'react';
import { errorLoggingService } from '../../services/errorLogging.service';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
}

interface State {
  hasError: boolean;
  error?: Error;
  errorInfo?: ErrorInfo;
  errorId?: string;
}

/**
 * Enhanced Error Boundary Component
 * 
 * Catches React component errors and logs them to the backend with comprehensive context:
 * - URL path and query parameters
 * - User and tenant information
 * - Browser and device information
 * - Component stack trace
 * - Error stack trace
 * - Timestamp and session info
 * 
 * Usage: Wrap your app or components with <ErrorBoundary>
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    // Update state so the next render will show the fallback UI
    return { hasError: true, error };
  }

  async componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // Log error to console for development
    console.error('🔴 ErrorBoundary caught an error:', error, errorInfo);

    try {
      // Gather comprehensive error context
      const errorContext = this.gatherErrorContext(error, errorInfo);
      
      // Log to backend API
      const errorId = await errorLoggingService.logError({
        errorType: 'React',
        message: error.message,
        stack: error.stack || '',
        componentStack: errorInfo.componentStack || '',
        ...errorContext
      });

      // Update state with error ID
      this.setState({ errorInfo, errorId });

      // Call optional error callback
      if (this.props.onError) {
        this.props.onError(error, errorInfo);
      }

      console.log(`✅ Error logged to backend with ID: ${errorId}`);
    } catch (loggingError) {
      console.error('❌ Failed to log error to backend:', loggingError);
      // Still update state even if logging fails
      this.setState({ errorInfo });
    }
  }

  /**
   * Gather comprehensive error context for debugging and reproduction
   */
  private gatherErrorContext(_error: Error, _errorInfo: ErrorInfo) {
    try {
      // Get current user from localStorage (if available)
      let userId: string | undefined;
      let userEmail: string | undefined;
      let tenantId: string | undefined;

      try {
        const userStr = localStorage.getItem('user');
        if (userStr) {
          const user = JSON.parse(userStr);
          userId = user.userId;
          userEmail = user.email;
          tenantId = user.tenantId;
        }
      } catch (e) {
        // Ignore parsing errors
      }

      // Get browser and device information
      const userAgent = navigator.userAgent;
      const browserInfo = this.parseBrowserInfo(userAgent);

      // Get current URL and routing info
      const url = window.location.href;
      const pathname = window.location.pathname;
      const search = window.location.search;
      const hash = window.location.hash;

      // Get viewport and screen info
      const viewport = {
        width: window.innerWidth,
        height: window.innerHeight
      };

      const screen = {
        width: window.screen.width,
        height: window.screen.height,
        colorDepth: window.screen.colorDepth
      };

      // Get timing information
      const timestamp = new Date().toISOString();

      // Get any additional session info
      const sessionInfo = {
        referrer: document.referrer,
        language: navigator.language,
        platform: navigator.platform,
        cookieEnabled: navigator.cookieEnabled,
        onLine: navigator.onLine
      };

      return {
        userId,
        userEmail,
        tenantId,
        url,
        pathname,
        search,
        hash,
        userAgent,
        browserInfo,
        viewport,
        screen,
        sessionInfo,
        timestamp
      };
    } catch (contextError) {
      console.error('Error gathering context:', contextError);
      return {};
    }
  }

  /**
   * Parse browser information from user agent
   */
  private parseBrowserInfo(userAgent: string) {
    const browsers = [
      { name: 'Chrome', pattern: /Chrome\/(\d+\.\d+)/ },
      { name: 'Firefox', pattern: /Firefox\/(\d+\.\d+)/ },
      { name: 'Safari', pattern: /Safari\/(\d+\.\d+)/ },
      { name: 'Edge', pattern: /Edg\/(\d+\.\d+)/ },
      { name: 'Opera', pattern: /Opera\/(\d+\.\d+)/ }
    ];

    for (const browser of browsers) {
      const match = userAgent.match(browser.pattern);
      if (match) {
        return {
          name: browser.name,
          version: match[1],
          isMobile: /Mobile|Android|iPhone|iPad/i.test(userAgent)
        };
      }
    }

    return {
      name: 'Unknown',
      version: 'Unknown',
      isMobile: /Mobile|Android|iPhone|iPad/i.test(userAgent)
    };
  }

  render() {
    if (this.state.hasError) {
      // Show custom fallback if provided
      if (this.props.fallback) {
        return this.props.fallback;
      }

      // Default error UI
      return (
        <div className="min-h-screen flex items-center justify-center bg-gray-50 p-6">
          <div className="max-w-md w-full bg-white rounded-lg border border-red-200 p-8 text-center">
            <div className="mb-4">
              <div className="mx-auto w-16 h-16 bg-red-100 rounded-full flex items-center justify-center">
                <svg className="w-8 h-8 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              </div>
            </div>
            
            <h2 className="text-2xl font-semibold text-gray-900 mb-2">
              Something went wrong
            </h2>
            
            <p className="text-gray-600 mb-6">
              We've logged this error and will look into it. Please try refreshing the page.
            </p>

            {this.state.errorId && (
              <p className="text-sm text-gray-500 mb-4">
                Error ID: <code className="bg-gray-100 px-2 py-1 rounded">{this.state.errorId}</code>
              </p>
            )}

            {process.env.NODE_ENV === 'development' && this.state.error && (
              <div className="mb-6 p-4 bg-red-50 rounded text-left">
                <p className="text-xs font-mono text-red-800 break-all">
                  {this.state.error.message}
                </p>
              </div>
            )}

            <div className="flex gap-3">
              <button 
                onClick={() => window.location.reload()}
                className="flex-1 px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-primary-dark transition-colors"
              >
                Reload Page
              </button>
              
              <button 
                onClick={() => window.location.href = '/'}
                className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
              >
                Go Home
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

/**
 * Hook for manually reporting errors from anywhere in the app
 */
export const useErrorReporting = () => {
  return {
    reportError: async (error: Error, additionalContext?: Record<string, any>) => {
      try {
        const errorId = await errorLoggingService.logError({
          errorType: 'Manual',
          message: error.message,
          stack: error.stack || '',
          url: window.location.href,
          pathname: window.location.pathname,
          timestamp: new Date().toISOString(),
          ...additionalContext
        });
        return errorId;
      } catch (loggingError) {
        console.error('Failed to report error:', loggingError);
        return null;
      }
    }
  };
};

export default ErrorBoundary;

