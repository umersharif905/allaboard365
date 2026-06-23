// Centralized API configuration
// Runtime config loaded from /config.json endpoint (set by Azure environment variables)
// Falls back to build-time config if runtime config is unavailable

/** Ensure URL has a scheme so it is never treated as a relative path (e.g. in fetch). */
const ensureAbsoluteUrl = (url: string): string => {
  const s = (url || '').trim();
  if (!s) return s;
  if (s.startsWith('http://') || s.startsWith('https://')) return s;
  return `https://${s}`;
};

// Build-time fallback config
const getBuildTimeApiUrl = () => {
  // Check for explicit environment variable first
  if (import.meta.env.VITE_API_URL) {
    console.log('🔍 VITE_API_URL:', import.meta.env.VITE_API_URL);
    return import.meta.env.VITE_API_URL;
  } else {
    console.log('🔍 No VITE_API_URL found, using build-time config');
  }
  
  // Fall back to mode-based config
  // NOTE: Use VITE_API_URL environment variable for multi-tenant deployments
  // Auth is co-located with API (same backend serves /auth and /api)
  const config = {
    development: 'http://localhost:3001',
    qa: 'https://allaboard365-backend-ctehcsb5cbedauc0.centralus-01.azurewebsites.net',
    production: 'https://api.allaboard365.com'
  };
  
  const environment = import.meta.env.MODE || 'development';
  return config[environment as keyof typeof config] || config.development;
};

// Runtime config from server (set via Azure environment variables)
let runtimeConfig: { API_URL?: string; BASE_URL?: string; OAUTH_URL?: string; APP_URL?: string; columbusUrl?: string } | null = null;
let configLoadPromise: Promise<void> | null = null;

/**
 * Get config endpoint URL
 * Fetches from the current origin (frontend server.js serves /config.json)
 * This allows the frontend app service to provide runtime config via environment variables
 */
const getConfigUrl = (): string => {
  // Always fetch from current origin - server.js in frontend serves /config.json
  // This allows Azure App Service environment variables to be used at runtime
  return '/config.json';
};

/**
 * Fetch runtime configuration from /config.json endpoint
 * This allows the API URL to be set via Azure environment variables at runtime
 */
export const loadRuntimeConfig = async (): Promise<void> => {
  // If already loaded or loading, return the existing promise
  if (configLoadPromise) {
    return configLoadPromise;
  }

  configLoadPromise = (async () => {
    try {
      const configUrl = getConfigUrl();
      console.log('[API Config] Fetching config from:', configUrl);
      
      const response = await fetch(configUrl, {
        cache: 'no-store',
        headers: {
          'Cache-Control': 'no-cache'
        }
      });
      
      if (response.ok) {
        const config = await response.json();
        runtimeConfig = config;
        console.log('[API Config] Loaded runtime config from /config.json:', config);
      } else {
        console.warn('[API Config] Failed to load /config.json, using build-time config');
      }
    } catch (error) {
      console.warn('[API Config] Error loading /config.json, using build-time config:', error);
    }
  })();

  return configLoadPromise;
};

/**
 * True when the SPA is served from a local dev host (Vite :5173, Cypress :5273, etc.).
 * public/config.json ships production URLs for Azure; local dev must hit localhost:3001.
 */
const isLocalDevHost = (): boolean => {
  if (typeof window === 'undefined') return import.meta.env.DEV;
  const hostname = window.location.hostname;
  return hostname === 'localhost' || hostname === '127.0.0.1';
};

/**
 * Get the API URL, preferring runtime config over build-time config
 */
export const getApiUrl = (): string => {
  // Local dev: ignore runtime /config.json prod URLs — same pattern as OAuth hostname fallback below.
  if (import.meta.env.DEV && isLocalDevHost()) {
    return ensureAbsoluteUrl(getBuildTimeApiUrl());
  }

  // Use runtime config if available (Azure App Service /config.json)
  if (runtimeConfig?.API_URL || runtimeConfig?.BASE_URL) {
    return ensureAbsoluteUrl(runtimeConfig.API_URL || runtimeConfig.BASE_URL || '');
  }

  // Fall back to build-time config
  return ensureAbsoluteUrl(getBuildTimeApiUrl());
};

/**
 * Get the OAuth URL, preferring runtime config over build-time config
 */
export const getOAuthUrl = (): string => {
  // Local dev: co-locate auth with API on localhost:3001 (ignore prod /config.json)
  if (import.meta.env.DEV && isLocalDevHost()) {
    return ensureAbsoluteUrl(getBuildTimeApiUrl());
  }

  // Priority 1: Runtime config from Azure (via /config.json)
  if (runtimeConfig?.OAUTH_URL) {
    console.log('✅ Using OAuth URL from Azure runtime config:', runtimeConfig.OAUTH_URL);
    return runtimeConfig.OAUTH_URL;
  }

  // Priority 2: Build-time environment variable
  if (import.meta.env.VITE_OAUTH_URL) {
    console.warn('⚠️ Runtime config unavailable, using build-time VITE_OAUTH_URL:', import.meta.env.VITE_OAUTH_URL);
    return import.meta.env.VITE_OAUTH_URL;
  }

  // Priority 3: Hostname-based fallback (auth is co-located with API - same backend)
  const hostname = typeof window !== 'undefined' ? window.location.hostname : '';
  console.warn('⚠️ No OAuth URL configured, using hostname-based fallback:', hostname);

  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return 'http://localhost:3001';
  }
  if (hostname.includes('dev') || hostname.includes('azurewebsites.net')) {
    return 'https://allaboard365-backend-ctehcsb5cbedauc0.centralus-01.azurewebsites.net';
  }
  if (hostname.includes('allaboard365.com')) {
    return 'https://api.allaboard365.com';
  }
  if (hostname.includes('.')) {
    const parts = hostname.split('.');
    if (parts.length >= 2) {
      const domain = parts.slice(-2).join('.');
      const constructedUrl = `https://api.${domain}`;
      console.warn(`⚠️ Constructed OAuth URL from hostname: ${constructedUrl} (set VITE_OAUTH_URL for production)`);
      return constructedUrl;
    }
  }
  console.warn('⚠️ Using default OAuth URL: api.allaboard365.com (SET VITE_OAUTH_URL ENVIRONMENT VARIABLE!)');
  return 'https://api.allaboard365.com';
};

/**
 * Get the Columbus URL, preferring runtime config over build-time config
 */
export const getColumbusUrl = (): string => {
  // Priority 1: Runtime config from Azure (via /config.json)
  if (runtimeConfig?.columbusUrl) {
    console.log('✅ Using Columbus URL from Azure runtime config:', runtimeConfig.columbusUrl);
    return runtimeConfig.columbusUrl;
  }

  // Priority 2: Build-time environment variable
  if (import.meta.env.VITE_COLUMBUS_URL) {
    console.warn('⚠️ Runtime config unavailable, using build-time VITE_COLUMBUS_URL:', import.meta.env.VITE_COLUMBUS_URL);
    return import.meta.env.VITE_COLUMBUS_URL;
  }

  // Priority 3: Default URL
  console.warn('⚠️ No Columbus URL configured, using default: https://mightywellhealth.com/api/columbus');
  return 'https://mightywellhealth.com/api/columbus';
};

// Initialize with build-time config (will be updated when runtime config loads)
// const apiUrl = getBuildTimeApiUrl();

export const API_CONFIG = {
  get BASE_URL() {
    return getApiUrl();
  },
  get OAUTH_URL() {
    return getOAuthUrl();
  },
  ENDPOINTS: {
    // Auth
    AUTH: '/api/auth',
    
    // Admin
    ADMIN_DASHBOARD: '/api/admin/dashboard',
    ADMIN_TENANTS: '/api/admin/tenants',
    ADMIN_PRODUCTS: '/api/admin/products',
    
    // Core entities
    MEMBERS: '/api/members',
    GROUPS: '/api/groups',
    ENROLLMENTS: '/api/enrollments',
    UPLOADS: '/api/uploads',
    
    // Message Center
    MESSAGE_CENTER: '/api/message-center',

    // Health check
    HEALTH: '/health'
  }
};

// Helper function for making API calls
export const apiCall = async (endpoint: string, options: RequestInit = {}) => {
  const url = `${API_CONFIG.BASE_URL}${endpoint}`;
  
  const defaultHeaders = {
    'Content-Type': 'application/json',
    ...options.headers,
  };
  
  const response = await fetch(url, {
    ...options,
    headers: defaultHeaders,
  });
  
  if (!response.ok) {
    throw new Error(`API call failed: ${response.status} ${response.statusText}`);
  }
  
  return response.json();
};