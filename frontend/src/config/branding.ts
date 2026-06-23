// frontend/src/config/branding.ts
// Branding configuration loader and utilities

import { BRAND_CONFIGS, DEFAULT_BRAND, getBrandConfig, type BrandConfig } from './branding-configs';

// Re-export BrandConfig for use in other files
export type { BrandConfig } from './branding-configs';

// Runtime config from server (set via Azure environment variables)
let runtimeBrandConfig: { BRAND?: string; BRANDING?: BrandConfig } | null = null;
let brandConfigLoadPromise: Promise<void> | null = null;

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
 * Fetch runtime branding configuration from /config.json endpoint
 * This allows the brand to be set via Azure environment variables at runtime
 */
export const loadRuntimeBrandConfig = async (): Promise<void> => {
  // If already loaded or loading, return the existing promise
  if (brandConfigLoadPromise) {
    return brandConfigLoadPromise;
  }

  brandConfigLoadPromise = (async () => {
    try {
      const configUrl = getConfigUrl();
      console.log('[Branding Config] Fetching config from:', configUrl);
      
      const response = await fetch(configUrl, {
        cache: 'no-store',
        headers: {
          'Cache-Control': 'no-cache'
        }
      });
      
      if (response.ok) {
        const config = await response.json();
        runtimeBrandConfig = config;
        console.log('[Branding Config] Loaded runtime brand config from /config.json:', config);
      } else {
        console.warn('[Branding Config] Failed to load /config.json, using build-time config');
      }
    } catch (error) {
      console.warn('[Branding Config] Error loading /config.json, using build-time config:', error);
    }
  })();

  return brandConfigLoadPromise;
};

/**
 * Get current brand identifier
 * Priority:
 * 1. Runtime config from /config.json (BRAND) - PRIMARY METHOD via Azure environment variable
 * 2. Build-time environment variable (VITE_BRAND)
 * 3. Hostname-based detection (qenroll.com -> qenroll) - FALLBACK ONLY if BRAND env var is missing
 * 4. Default brand (allaboard365)
 * 
 * NOTE: BRAND environment variable is the primary and preferred method.
 * Hostname detection is only used as a safety fallback if BRAND is not set.
 */
export const getCurrentBrand = (): string => {
  // Priority 1: Runtime config from server (BRAND environment variable) - PRIMARY METHOD
  if (runtimeBrandConfig?.BRAND) {
    return runtimeBrandConfig.BRAND;
  }
  
  // Priority 2: Build-time environment variable
  if (import.meta.env.VITE_BRAND) {
    return import.meta.env.VITE_BRAND;
  }
  
  // Priority 3: Generic hostname-based detection (FALLBACK ONLY - use BRAND env var instead)
  // This attempts to extract brand from hostname, but is NOT reliable for multi-tenant
  // NOTE: This should NOT be relied upon - always set BRAND environment variable
  const hostname = window.location.hostname;
  if (hostname.includes('.')) {
    // Try to extract brand from hostname (e.g., app.qenroll.com -> qenroll)
    // This is a generic approach but may not work for all domain structures
    const parts = hostname.split('.');
    if (parts.length >= 2) {
      // Get the root domain name (e.g., 'qenroll' from 'app.qenroll.com')
      const rootDomain = parts[parts.length - 2];
      // Check if this brand exists in our configs
      if (rootDomain && isValidBrand(rootDomain)) {
        console.warn(`⚠️ BRAND environment variable not set, using hostname-based detection: ${rootDomain} (NOT RECOMMENDED - set BRAND env var)`);
        return rootDomain;
      }
    }
  }
  
  // Priority 4: Default brand
  console.warn('⚠️ BRAND environment variable not set, using default brand:', DEFAULT_BRAND);
  return DEFAULT_BRAND;
};

/**
 * Get current brand configuration
 */
export const getCurrentBrandConfig = (): BrandConfig => {
  const brandId = getCurrentBrand();
  return getBrandConfig(brandId);
};

/**
 * Check if a brand exists
 */
export const isValidBrand = (brandId: string): boolean => {
  if (brandId === 'open-enroll') return true;
  return brandId in BRAND_CONFIGS;
};
