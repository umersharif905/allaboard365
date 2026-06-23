// frontend/src/services/api.service.ts
import axios, { AxiosError, AxiosInstance, AxiosRequestConfig } from 'axios';
import { API_CONFIG, loadRuntimeConfig } from '../config/api';
import { authService } from './auth.service';

export interface ApiError {
  message: string;
  status?: number;
  code?: string;
  /** Raw JSON body from failed requests (e.g. enrollment `success: false` payloads). */
  responseData?: unknown;
  /** Nested `error` object from enrollment / payment endpoints. */
  enrollmentError?: {
    code?: string;
    message?: string;
    details?: unknown;
    reportId?: string;
  };
}

/** Axios 1.x often uses AxiosHeaders; bracket read/write can miss `x-current-tenant-id`. */
function getTenantHeaderFromConfig(config: AxiosRequestConfig): string | undefined {
  const h = config.headers as
    | Record<string, string | undefined>
    | { get?: (name: string) => string | undefined }
    | undefined;
  if (!h) return undefined;
  if (typeof (h as { get?: (name: string) => string | undefined }).get === 'function') {
    const g = (h as { get: (name: string) => string | undefined }).get;
    // Must preserve `this` (AxiosHeaders); unbound .get breaks findKey → Object.keys(undefined).
    return g.call(h, 'x-current-tenant-id') || g.call(h, 'X-Current-Tenant-Id');
  }
  return (h as Record<string, string | undefined>)['x-current-tenant-id'] ||
    (h as Record<string, string | undefined>)['X-Current-Tenant-Id'];
}

function setTenantHeaderOnConfig(config: AxiosRequestConfig, tenantId: string): void {
  if (!config.headers) {
    config.headers = {} as Record<string, string>;
  }
  const h = config.headers as
    | Record<string, string>
    | { set?: (name: string, value: string) => void }
    | undefined;
  if (h && typeof (h as { set?: (n: string, v: string) => void }).set === 'function') {
    (h as { set: (n: string, v: string) => void }).set.call(h, 'x-current-tenant-id', tenantId);
  } else {
    (config.headers as Record<string, string>)['x-current-tenant-id'] = tenantId;
  }
}

const toErrorMessageString = (value: any, fallback: string = 'An unexpected error occurred'): string => {
  if (typeof value === 'string' && value.trim()) {
    return value;
  }
  if (value instanceof Error && typeof value.message === 'string' && value.message.trim()) {
    return value.message;
  }
  if (typeof value?.message === 'string' && value.message.trim()) {
    return value.message;
  }
  try {
    const serialized = JSON.stringify(value);
    if (serialized && serialized !== '{}' && serialized !== 'null') {
      return serialized;
    }
  } catch (_e) {
    // Ignore serialization failures and return fallback
  }
  return fallback;
};

const errorMessageIncludes = (value: any, needle: string): boolean => {
  if (!needle) return false;
  const msg = toErrorMessageString(value, '');
  if (!msg) return false;
  return msg.toLowerCase().includes(needle.toLowerCase());
};

class ApiService {
  private axiosInstance: AxiosInstance;
  private isRefreshing = false;
  private failedQueue: Array<{
    resolve: (token: string | null) => void;
    reject: (error: any) => void;
  }> = [];

  constructor() {
    // Load runtime config asynchronously (will update API_CONFIG.BASE_URL getter)
    loadRuntimeConfig().then(() => {
      // Update baseURL after runtime config loads
      this.axiosInstance.defaults.baseURL = API_CONFIG.BASE_URL;
      console.log(`[ApiService] baseURL updated to: ${API_CONFIG.BASE_URL}`);
    });

    this.axiosInstance = axios.create({
      baseURL: API_CONFIG.BASE_URL || '',
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // Request interceptor to dynamically get baseURL and add auth token
    this.axiosInstance.interceptors.request.use(
      async (config) => {
        // Always use current API_CONFIG.BASE_URL (which may have been updated by runtime config)
        const currentBaseURL = API_CONFIG.BASE_URL || '';
        if (!config.baseURL || config.baseURL !== currentBaseURL) {
          config.baseURL = currentBaseURL;
          console.log(`[ApiService] Request interceptor - setting baseURL to: ${currentBaseURL}`);
        }
        
        // Handle FormData: let axios set Content-Type automatically with boundary
        // If data is FormData, delete any manual Content-Type header so axios can set it properly
        if (config.data instanceof FormData) {
          if (config.headers) {
            // Delete Content-Type header - axios will set it automatically with boundary
            delete config.headers['Content-Type'];
            delete config.headers['content-type'];
          }
        }

        // Backend requireTenantAccess uses x-current-tenant-id; if absent it falls back to primary DB TenantId.
        // Must run for ALL requests (including before needsAuth) so public URLs that still send a token carry context.
        this.applyActiveTenantHeader(config);
        
        // Check if this endpoint requires authentication
        const needsAuth = this.requiresAuth(config);
        if (!needsAuth) {
          // For public endpoints, don't add auth header and don't redirect on errors
          return config;
        }
        
        // Debug logging for production issues with uploads
        if (config.url?.includes('uploads')) {
          console.log(`[ApiService] Upload endpoint requires auth check - URL: ${config.url}, baseURL: ${config.baseURL}`);
        }

        try {
          // Get token asynchronously (handles refresh if needed)
          // For public endpoints, we can skip token retrieval entirely if there's no token
          const currentPath = window.location.pathname;
          const isPublicRoute = currentPath.startsWith('/enroll') || 
                               currentPath.startsWith('/enroll-now') ||
                               currentPath.startsWith('/group-onboarding') ||
                               currentPath.startsWith('/agent-onboarding') ||
                               currentPath.startsWith('/forms/') ||
                               currentPath === '/forms' ||
                               currentPath.startsWith('/sign-acknowledgements') ||
                               currentPath.startsWith('/setup-password') ||
                               currentPath.startsWith('/forgot-password') ||
                               currentPath.startsWith('/reset-password') ||
                               currentPath.startsWith('/terms') ||
                               currentPath.startsWith('/privacy-policy') ||
                               currentPath.startsWith('/public/');
          
          // For public routes, try to get token but don't fail if it doesn't exist
          let token: string | null = null;
          if (isPublicRoute) {
            // For public routes, try to get token without throwing errors
            try {
              token = await authService.getAccessToken();
            } catch (tokenError) {
              // Silently fail for public routes - request can proceed without token
              console.log(`[ApiService] No token available for public route, proceeding without auth: ${config.url}`);
              token = null;
            }
          } else {
            // For protected routes, token is required
            token = await authService.getAccessToken();
          }
          
          console.log(`[ApiService] Request interceptor - token ${token ? 'present' : 'missing'} for URL: ${config.url}`);
          
          if (token) {
            config.headers.Authorization = `Bearer ${token}`;
            // Backend resolves effective role (prompts/backend-system.md): roles[] alone is not enough for multi-role users.
            try {
              const activeRole = window.localStorage.getItem('currentRole');
              if (activeRole && activeRole.trim()) {
                config.headers['X-Current-Role'] = activeRole.trim();
              }
            } catch {
              /* ignore */
            }
          } else if (!isPublicRoute) {
            // If no token but endpoint requires auth, fail fast and let auth flow decide whether to redirect
            // BUT: Don't fail password reset routes that intentionally run unauthenticated
            const currentPath = window.location.pathname;
            const isPasswordResetRoute = currentPath.startsWith('/forgot-password') || 
                                         currentPath.startsWith('/reset-password');
            
            if (isPasswordResetRoute) {
              // Password reset routes - allow request without token
              console.log('[ApiService] Password reset route without token, allowing request to proceed:', config.url);
            } else {
              console.error('[ApiService] No authentication token available for protected endpoint:', config.url);
              throw new Error('No authentication token available');
            }
          } else {
            // Public route without token - allow request to proceed
            console.log('[ApiService] Public route without token, allowing request to proceed:', config.url);
          }
          
          const explicitTenantHeader = getTenantHeaderFromConfig(config);
          const resolvedTenant =
            explicitTenantHeader ||
            window.localStorage.getItem('currentTenantId') ||
            window.localStorage.getItem('tenantId');
          if (resolvedTenant) {
            console.log(
              `[ApiService] Tenant ID header for URL ${config.url}: ${resolvedTenant}${explicitTenantHeader ? ' (explicit)' : ' (localStorage)'}`
            );
          } else {
            console.log(`[ApiService] No tenant id in storage for URL: ${config.url}`);
          }
          
          return config;
        } catch (error) {
          // If token retrieval fails, redirect to login
          // But don't redirect if we're on a public route (enrollment, onboarding, password reset, etc.)
          const currentPath = window.location.pathname;
          const isPublicRoute = currentPath.startsWith('/enroll') || 
                               currentPath.startsWith('/enroll-now') ||
                               currentPath.startsWith('/group-onboarding') ||
                               currentPath.startsWith('/agent-onboarding') ||
                               currentPath.startsWith('/forms/') ||
                               currentPath === '/forms' ||
                               currentPath.startsWith('/sign-acknowledgements') ||
                               currentPath.startsWith('/setup-password') ||
                               currentPath.startsWith('/forgot-password') ||
                               currentPath.startsWith('/reset-password') ||
                               currentPath.startsWith('/terms') ||
                               currentPath.startsWith('/privacy-policy') ||
                               currentPath.startsWith('/public/');
          
          if (!isPublicRoute && !window.location.pathname.includes('/login')) {
            console.error('[ApiService] Failed to get auth token for protected endpoint:', config.url, error);
          } else if (isPublicRoute) {
            // For public routes, allow request to proceed without token
            console.log('[ApiService] Auth error on public route, allowing request without token:', currentPath);
            return config; // Return config without auth header
          }
          return Promise.reject(error);
        }
      },
      (error) => {
        return Promise.reject(error);
      }
    );

    // Response interceptor for error handling
    this.axiosInstance.interceptors.response.use(
      (response) => response,
      async (error: AxiosError) => {
        const originalRequest: any = error.config;

        // If no response, check if it's a canceled request (expected behavior with AbortController)
        if (!error.response) {
          // Check if this is a canceled request (expected when using AbortController)
          const isCanceled = error.code === 'ERR_CANCELED' || 
                            errorMessageIncludes(error, 'canceled') ||
                            axios.isCancel(error);
          
          if (isCanceled) {
            // Silently handle canceled requests - this is expected behavior
            // Don't log as error, just reject with a special code so callers can handle it
            return Promise.reject({
              message: 'Request was canceled',
              status: 0,
              code: 'ERR_CANCELED',
              isCanceled: true
            });
          }
          
          // Real network error
          console.error('Network error:', error.message);
          return Promise.reject({
            message: 'Network error. Please check your connection.',
            status: 0,
            code: 'NETWORK_ERROR'
          });
        }

        // Handle 401 Unauthorized
        if (error.response.status === 401 && !originalRequest._retry) {
          // Don't retry auth endpoints
          if (originalRequest.url?.includes('/auth/')) {
            return Promise.reject(error);
          }

          // For public endpoints, don't try to refresh token - just reject normally
          // Public endpoints should work without authentication
          const isPublicEndpoint = this.requiresAuth(originalRequest) === false;
          if (isPublicEndpoint) {
            console.log(`[ApiService] Public endpoint received 401 - not attempting token refresh for: ${originalRequest.url}`);
            return Promise.reject(this.normalizeError(error));
          }

          if (this.isRefreshing) {
            // If already refreshing, queue this request
            return new Promise((resolve, reject) => {
              this.failedQueue.push({ resolve, reject });
            }).then(token => {
              if (token) {
                originalRequest.headers.Authorization = `Bearer ${token}`;
                return this.axiosInstance(originalRequest);
              }
              return Promise.reject(error);
            }).catch(err => {
              return Promise.reject(err);
            });
          }

          originalRequest._retry = true;
          this.isRefreshing = true;

          try {
            const newToken = await authService.refreshAccessToken();
            
            if (newToken) {
              // Retry all queued requests with new token
              this.processQueue(null, newToken);
              
              // Retry the original request
              originalRequest.headers.Authorization = `Bearer ${newToken}`;
              return this.axiosInstance(originalRequest);
            } else {
              // Refresh failed, reject all queued requests
              this.processQueue(new Error('Token refresh failed'), null);
              throw new Error('Token refresh failed');
            }
          } catch (refreshError) {
            // Token refresh failed, auth service should handle redirect
            this.processQueue(refreshError, null);
            return Promise.reject(refreshError);
          } finally {
            this.isRefreshing = false;
          }
        }

        // Handle 403 Forbidden
        if (error.response.status === 403) {
          console.error('Access forbidden:', error.response.data);
          // You can dispatch an event here to show a permission denied message
          window.dispatchEvent(new CustomEvent('api-error', {
            detail: {
              type: 'forbidden',
              message: 'You do not have permission to perform this action.'
            }
          }));
        }

        // Handle 404 Not Found
        if (error.response.status === 404) {
          // Suppress logging for expected 404s (like no bank info, no agent profile, unknown email on password reset)
          const url = error.config?.url || '';
          const isExpected404 = url.includes('/bank-info') || 
                                url.includes('/agents/by-user') ||
                                url.includes('password-reset/request');
          
          if (!isExpected404) {
            console.error('Resource not found:', error.response.data);
          }
        }

        // Handle 500+ Server errors
        if (error.response.status >= 500) {
          console.error('Server error:', error.response.data);
          window.dispatchEvent(new CustomEvent('api-error', {
            detail: {
              type: 'server-error',
              message: 'Server error occurred. Please try again later.'
            }
          }));
        }

        return Promise.reject(this.normalizeError(error));
      }
    );
  }

  /**
   * Sets x-current-tenant-id for requireTenantAccess.
   * Skips if caller already set the header (e.g. withExplicitTenantScope).
   * SysAdmin on /admin/agents uses the page tenant picker only — not auth/localStorage tenant.
   */
  private applyActiveTenantHeader(config: AxiosRequestConfig): void {
    if (typeof window === 'undefined') return;
    if (getTenantHeaderFromConfig(config)) return;

    const pickerTenant = getSysAdminAgentsPickerTenantId();
    if (pickerTenant) {
      setTenantHeaderOnConfig(config, pickerTenant);
      return;
    }

    const path = window.location.pathname || '';
    const role = window.localStorage.getItem('currentRole')?.trim();
    if (path.startsWith('/admin/agents') && role === 'SysAdmin') {
      return;
    }

    const tid =
      window.localStorage.getItem('currentTenantId') || window.localStorage.getItem('tenantId');
    if (!tid) return;
    setTenantHeaderOnConfig(config, tid);
  }

  // Check if request requires authentication
  private requiresAuth(config: AxiosRequestConfig): boolean {
    // Public endpoints that don't require auth
    const publicEndpoints = [
      '/auth/login',
      '/auth/register',
      '/auth/forgot-password',
      '/auth/reset-password',
      '/health',
      '/public',
      '/api/public', // All public API endpoints
      '/api/enrollment-links', // All enrollment links endpoints are public
      '/api/group-onboarding', // All group onboarding endpoints are public
      '/api/password-setup', // Password setup endpoints are public
      '/api/password-reset', // Password reset endpoints are public
      '/api/effective-dates', // Effective dates endpoint is public (used by enrollment links)
      '/api/document-signatures/documents', // Document proxy endpoints are public (for group onboarding)
      '/api/document-signatures/apply' // Apply signatures endpoint is public (for group onboarding)
    ];

    // Method-specific public endpoints (only GET is public, POST/PUT/DELETE require auth)
    const methodSpecificPublicEndpoints = [
      '/api/document-signatures/templates' // Only GET is public (for group onboarding), POST/PUT/DELETE require auth
    ];

    const url = config.url || '';
    const method = (config.method || 'get').toLowerCase();
    
    // Extract just the path if URL includes baseURL (defensive check for production)
    let path = url;
    if (config.baseURL && url.startsWith(config.baseURL)) {
      path = url.replace(config.baseURL, '');
    } else if (API_CONFIG.BASE_URL && url.startsWith(API_CONFIG.BASE_URL)) {
      path = url.replace(API_CONFIG.BASE_URL, '');
    }
    
    // Remove query parameters for matching
    const pathWithoutQuery = path.split('?')[0];
    
    // Ensure path starts with / for matching
    const normalizedPath = pathWithoutQuery.startsWith('/') ? pathWithoutQuery : '/' + pathWithoutQuery;
    
    // Check method-specific public endpoints (only GET is public)
    const isMethodSpecificPublic = methodSpecificPublicEndpoints.some(endpoint => 
      normalizedPath.startsWith(endpoint) && method === 'get'
    );
    
    // Check general public endpoints (all methods are public)
    const isGeneralPublic = publicEndpoints.some(endpoint => normalizedPath.startsWith(endpoint));
    
    const isPublic = isMethodSpecificPublic || isGeneralPublic;
    
    // Debug logging for production issues
    if (isPublic) {
      console.log(`[ApiService] Public endpoint detected: ${normalizedPath} (method: ${method}, url: ${url}, baseURL: ${config.baseURL})`);
    } else {
      console.log(`[ApiService] Protected endpoint: ${normalizedPath} (method: ${method}, url: ${url})`);
    }
    
    return !isPublic;
  }

  // Process queued requests after token refresh
  private processQueue(error: any, token: string | null = null): void {
    this.failedQueue.forEach(prom => {
      if (error) {
        prom.reject(error);
      } else {
        prom.resolve(token);
      }
    });
    
    this.failedQueue = [];
  }

  // Normalize error responses
  private normalizeError(error: AxiosError): ApiError {
    if (error.response) {
      const data: any = error.response.data;
      const nested = data?.error;
      const nestedCode =
        nested && typeof nested === 'object' && typeof nested.code === 'string'
          ? nested.code
          : undefined;
      return {
        message: data?.message || (typeof nested?.message === 'string' ? nested.message : undefined) || error.message,
        status: error.response.status,
        code: nestedCode || data?.code || error.code,
        responseData: data,
        enrollmentError:
          nested && typeof nested === 'object' && !Array.isArray(nested) ? nested : undefined
      };
    }
    
    return {
      message: error.message || 'An unexpected error occurred',
      status: 0,
      code: error.code
    };
  }

  // Generic request methods
  public async get<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
    try {
      console.log(`[ApiService] Making GET request to: ${url}`);
      const response = await this.axiosInstance.get<T>(url, config);
      console.log(`[ApiService] ✅ GET request succeeded: ${url}`, { status: response.status });
      return response.data;
    } catch (error: any) {
      // Check if this is a canceled request (expected behavior with AbortController)
      const isCanceled = error?.code === 'ERR_CANCELED' || 
                        error?.isCanceled ||
                        errorMessageIncludes(error, 'canceled') ||
                        axios.isCancel(error);
      
      // Don't log canceled requests as errors - they're expected when React StrictMode
      // causes multiple renders or when component unmounts
      if (!isCanceled) {
        console.error(`[ApiService] ❌ GET request failed: ${url}`, {
          message: error?.message,
          status: error?.response?.status,
          statusText: error?.response?.statusText,
          data: error?.response?.data,
          config: {
            url: error?.config?.url,
            baseURL: error?.config?.baseURL,
            method: error?.config?.method
          }
        });
        this.handleRequestError(error);
      }
      throw error; // Re-throw to ensure caller can catch it
    }
  }

  public async post<T>(url: string, data?: any, config?: AxiosRequestConfig): Promise<T> {
    try {
      const response = await this.axiosInstance.post<T>(url, data, config);
      return response.data;
    } catch (error) {
      throw this.handleRequestError(error);
    }
  }

  public async put<T>(url: string, data?: any, config?: AxiosRequestConfig): Promise<T> {
    try {
      const response = await this.axiosInstance.put<T>(url, data, config);
      return response.data;
    } catch (error) {
      throw this.handleRequestError(error);
    }
  }

  public async delete<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
    try {
      const response = await this.axiosInstance.delete<T>(url, config);
      return response.data;
    } catch (error) {
      throw this.handleRequestError(error);
    }
  }

  public async patch<T>(url: string, data?: any, config?: AxiosRequestConfig): Promise<T> {
    try {
      const response = await this.axiosInstance.patch<T>(url, data, config);
      return response.data;
    } catch (error) {
      throw this.handleRequestError(error);
    }
  }

  // Handle request errors consistently (accepts Axios error or already-normalized ApiError from interceptor)
  private handleRequestError(error: any): never {
    const url = error.config?.url || '';
    const status = error.response?.status ?? error.status;
    const errorMessage = typeof error.message === 'string' ? error.message : '';
    const isCanceled = error.code === 'ERR_CANCELED' || 
                      errorMessageIncludes(error, 'canceled') ||
                      error.isCanceled ||
                      axios.isCancel(error);
    const isExpected404 = (status === 404 && (url.includes('/bank-info') || url.includes('/agents/by-user') || url.includes('password-reset/request'))) || 
                          (errorMessage.includes('No bank information found')) ||
                          (errorMessage.includes('Agent not found'));
    const isAlreadyNormalized = error.response === undefined && (error.message != null || error.status != null);

    // Don't log canceled requests or expected 404s; when error is already normalized (from interceptor), avoid logging undefined
    if (!isCanceled && !isExpected404) {
      if (isAlreadyNormalized) {
        console.error('API Service Error:', { message: error.message, status: error.status, code: error.code });
      } else {
        console.error('API Service Error:', error);
        if (error.response != null) {
          console.error('Error response:', error.response);
          console.error('Response data:', error.response?.data);
          console.error('Response status:', error.response?.status);
        }
      }
    }

    const apiError: ApiError = {
      message: 'An unexpected error occurred',
      status: error.response?.status ?? error.status,
    };

    if (axios.isAxiosError(error)) {
      if (error.response) {
        const responseData = error.response.data || {};
        apiError.responseData = responseData;
        const nested = responseData.error;
        let displayMessage = typeof responseData.message === 'string' && responseData.message.trim()
          ? responseData.message
          : '';
        if (!displayMessage && nested && typeof nested === 'object' && nested !== null) {
          const nm = (nested as { message?: string }).message;
          if (typeof nm === 'string' && nm.trim()) {
            displayMessage = nm;
          }
        }
        if (!displayMessage) {
          displayMessage = toErrorMessageString(
            nested !== undefined ? nested : error.message,
            'Request failed'
          );
        }
        apiError.message = displayMessage;
        apiError.code =
          nested && typeof nested === 'object' && nested !== null && typeof (nested as { code?: string }).code === 'string'
            ? (nested as { code: string }).code
            : typeof responseData.code === 'string'
              ? responseData.code
              : error.code;
        if (nested !== undefined && typeof nested === 'object' && nested !== null && !Array.isArray(nested)) {
          apiError.enrollmentError = nested as ApiError['enrollmentError'];
        }
        if (responseData && typeof responseData === 'object') {
          if ('isAlreadyTenantAdmin' in responseData) {
            (apiError as ApiError & { isAlreadyTenantAdmin?: boolean }).isAlreadyTenantAdmin =
              Boolean((responseData as { isAlreadyTenantAdmin?: boolean }).isAlreadyTenantAdmin);
          }
          if ('isDifferentTenant' in responseData) {
            (apiError as ApiError & { isDifferentTenant?: boolean }).isDifferentTenant =
              Boolean((responseData as { isDifferentTenant?: boolean }).isDifferentTenant);
          }
        }
        if (!isExpected404) {
          console.error(`API Error Response [${error.response.status}]:`, error.response.data);
        }
      } else if (error.request) {
        apiError.message = 'No response from server. Please check your network connection.';
        apiError.code = 'ERR_NETWORK';
        if (!isExpected404) {
          console.error('API Network Error:', error.request);
        }
      } else {
        apiError.message = toErrorMessageString(error.message, 'Request setup failed');
        if (!isExpected404) {
          console.error('API Request Setup Error:', error.message);
        }
      }
    } else {
      apiError.message = toErrorMessageString(error?.message || error, 'An unknown error occurred.');
      apiError.code = error.code;
      if (!isExpected404 && !isAlreadyNormalized) {
        console.error('Non-Axios Error:', error);
      }
    }

    throw apiError;
  }

  // Upload file with progress tracking
  public async uploadFile<T>(
    url: string, 
    file: File, 
    onProgress?: (percentCompleted: number) => void
  ): Promise<T> {
    const formData = new FormData();
    formData.append('file', file);

    const config: AxiosRequestConfig = {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
      onUploadProgress: (progressEvent) => {
        if (onProgress && progressEvent.total) {
          const percentCompleted = Math.round((progressEvent.loaded * 100) / progressEvent.total);
          onProgress(percentCompleted);
        }
      },
    };

    return this.post<T>(url, formData, config);
  }

  // Download file
  public async downloadFile(url: string, filename?: string): Promise<void> {
    try {
      const response = await this.axiosInstance.get(url, {
        responseType: 'blob',
      });

      const blob = new Blob([response.data]);
      const downloadUrl = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = filename || 'download';
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(downloadUrl);
    } catch (error) {
      throw this.handleRequestError(error);
    }
  }
}

export const apiService = new ApiService();

/**
 * Merge into axios `config` so `x-current-tenant-id` is always set for tenant-scoped routes.
 * Prefer localStorage `currentTenantId` first — it updates synchronously on tenant switch; React
 * `user.currentTenantId` can lag one tick and would otherwise override with a stale id.
 */
export function withTenantScope(activeTenantId?: string | null): Pick<AxiosRequestConfig, 'headers'> {
  const storedCurrent =
    typeof window !== 'undefined' ? window.localStorage.getItem('currentTenantId') : null;
  const storedPrimary =
    typeof window !== 'undefined' ? window.localStorage.getItem('tenantId') : null;
  const fromAuth =
    activeTenantId != null && String(activeTenantId).trim() !== '' ? String(activeTenantId).trim() : '';
  const resolved =
    (storedCurrent && storedCurrent.trim()) ||
    fromAuth ||
    (storedPrimary && storedPrimary.trim()) ||
    '';
  if (!resolved) return {};
  return { headers: { 'x-current-tenant-id': resolved } };
}

/** sessionStorage key for SysAdmin tenant picker on /admin/agents */
export const SYSADMIN_AGENTS_TENANT_STORAGE_KEY = 'sysadmin.agents.tenantId';

/** Tenant selected on SysAdmin Agents & Agencies page (only when pathname is /admin/agents). */
export function getSysAdminAgentsPickerTenantId(): string | null {
  if (typeof window === 'undefined') return null;
  if (!(window.location.pathname || '').startsWith('/admin/agents')) return null;
  const tid = sessionStorage.getItem(SYSADMIN_AGENTS_TENANT_STORAGE_KEY)?.trim();
  return tid || null;
}

/** Caller override, then SysAdmin picker, then localStorage (unless SysAdmin on /admin/agents with no picker). */
export function resolveTenantScopeId(explicitTenantId?: string | null): string | null {
  const explicit =
    explicitTenantId != null && String(explicitTenantId).trim() !== ''
      ? String(explicitTenantId).trim()
      : null;
  if (explicit) return explicit;
  const picker = getSysAdminAgentsPickerTenantId();
  if (picker) return picker;
  if (typeof window === 'undefined') return null;
  const path = window.location.pathname || '';
  const role = window.localStorage.getItem('currentRole')?.trim();
  if (path.startsWith('/admin/agents') && role === 'SysAdmin') {
    return null;
  }
  const stored =
    (window.localStorage.getItem('currentTenantId') || '').trim() ||
    (window.localStorage.getItem('tenantId') || '').trim();
  return stored || null;
}

/** Force tenant header for this request (e.g. enrollment wizard row tenant). Overrides localStorage order in withTenantScope. */
export function withExplicitTenantScope(
  tenantId: string | null | undefined
): Pick<AxiosRequestConfig, 'headers'> {
  const tid = tenantId != null && String(tenantId).trim() !== '' ? String(tenantId).trim() : '';
  if (!tid) return {};
  return { headers: { 'x-current-tenant-id': tid } };
}

/**
 * For raw `fetch()` calls that bypass axios — must include active tenant (same as applyActiveTenantHeader).
 */
export function getAuthHeadersWithTenant(
  token: string | null | undefined,
  explicitTenantId?: string | null
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const tid = resolveTenantScopeId(explicitTenantId);
  if (tid) {
    headers['x-current-tenant-id'] = tid;
  }
  return headers;
}

// Event types for global error handling
declare global {
  interface WindowEventMap {
    'api-error': CustomEvent<{
      type: 'forbidden' | 'server-error' | 'network-error';
      message: string;
    }>;
  }
}