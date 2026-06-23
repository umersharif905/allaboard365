// Tracked Fetch - Automatically logs API errors with full context
import { API_CONFIG } from '../config/api';
import { errorTracker } from './errorTracking';

interface TrackedFetchOptions extends RequestInit {
  timeout?: number;
  skipErrorTracking?: boolean;
}

/**
 * Enhanced fetch with automatic error tracking
 * Use this instead of raw fetch for all API calls
 */
export async function trackedFetch(
  endpoint: string,
  options: TrackedFetchOptions = {}
): Promise<Response> {
  const {
    timeout = 30000,
    skipErrorTracking = false,
    ...fetchOptions
  } = options;

  // Build full URL
  const fullUrl = endpoint.startsWith('http') 
    ? endpoint 
    : `${API_CONFIG.BASE_URL}${endpoint}`;

  const method = fetchOptions.method || 'GET';
  const startTime = Date.now();

  try {
    // Create abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    // Make the fetch request
    const response = await fetch(fullUrl, {
      ...fetchOptions,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    // Track non-2xx responses
    if (!response.ok && !skipErrorTracking) {
      const responseText = await response.text().catch(() => 'Unable to read response');
      
      errorTracker.trackApiError({
        endpoint,
        method,
        requestUrl: fullUrl,
        status: response.status,
        error: `HTTP ${response.status}: ${response.statusText}`,
        errorType: 'api_error',
        additionalContext: {
          responsePreview: responseText.substring(0, 500),
          duration: Date.now() - startTime,
          isHtmlResponse: responseText.startsWith('<!DOCTYPE') || responseText.startsWith('<html'),
        },
      });
    }

    return response;
  } catch (error) {
    if (skipErrorTracking) {
      throw error;
    }

    // Determine error type
    let errorType: 'network' | 'timeout' | 'json_parse' | 'api_error' = 'network';
    let errorMessage = error instanceof Error ? error.message : String(error);

    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        errorType = 'timeout';
        errorMessage = `Request timeout after ${timeout}ms`;
      } else if (error.message.includes('Failed to fetch')) {
        errorType = 'network';
        errorMessage = 'Network error - check internet connection or CORS settings';
      }
    }

    // Track the error
    errorTracker.trackApiError({
      endpoint,
      method,
      requestUrl: fullUrl,
      error: errorMessage,
      errorType,
      additionalContext: {
        duration: Date.now() - startTime,
        timeout,
      },
    });

    throw error;
  }
}

/**
 * Tracked fetch with automatic JSON parsing and error handling
 */
export async function trackedFetchJson<T = any>(
  endpoint: string,
  options: TrackedFetchOptions = {}
): Promise<T> {
  const response = await trackedFetch(endpoint, options);

  try {
    return await response.json();
  } catch (error) {
    const responseText = await response.text().catch(() => 'Unable to read response');

    // Track JSON parse error
    if (!options.skipErrorTracking) {
      errorTracker.trackApiError({
        endpoint,
        method: options.method || 'GET',
        requestUrl: endpoint.startsWith('http') 
          ? endpoint 
          : `${API_CONFIG.BASE_URL}${endpoint}`,
        status: response.status,
        error: error instanceof Error ? error.message : 'JSON parse error',
        errorType: 'json_parse',
        additionalContext: {
          responsePreview: responseText.substring(0, 500),
          contentType: response.headers.get('content-type'),
          isHtmlResponse: responseText.startsWith('<!DOCTYPE') || responseText.startsWith('<html'),
          helpfulMessage: errorTracker.detectHtmlResponse(responseText)
            ? 'API returned HTML instead of JSON - check if endpoint exists and API_CONFIG.BASE_URL is correct'
            : 'Invalid JSON response from API',
        },
      });
    }

    throw new Error(
      errorTracker.detectHtmlResponse(responseText)
        ? `API endpoint returned HTML instead of JSON. Expected: ${endpoint.startsWith('http') ? endpoint : API_CONFIG.BASE_URL + endpoint}`
        : `Failed to parse JSON response: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Helper to build API URLs consistently
 */
export function buildApiUrl(path: string): string {
  // Remove leading slash if present
  const cleanPath = path.startsWith('/') ? path.slice(1) : path;
  
  // Ensure BASE_URL doesn't end with /api if path already includes it
  const baseUrl = API_CONFIG.BASE_URL;
  const separator = baseUrl.endsWith('/') || cleanPath.startsWith('/') ? '' : '/';
  
  return `${baseUrl}${separator}${cleanPath}`;
}

