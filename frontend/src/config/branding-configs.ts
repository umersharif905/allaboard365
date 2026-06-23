// frontend/src/config/branding-configs.ts
// Brand configuration definitions for multi-branding support

export interface BrandColors {
  primary: string;
  primaryLight: string;
  primaryDark: string;
  secondary?: string;
  neutralLight?: string;
  neutralDark?: string;
  success?: string;
  error?: string;
  warning?: string;
}

export interface BrandLogos {
  main: string;
  light: string;
  dark: string;
  icon: string;
  favicon: string;
}

export interface BrandConfig {
  name: string;
  /** Browser tab title; if not set, uses name */
  tabTitle?: string;
  colors: BrandColors;
  logos: BrandLogos;
  tagline?: string;
  supportEmail?: string;
  companyUrl?: string;
}

/**
 * Brand configurations for all supported brands
 * Add new brands here by adding a new entry to this object
 */
export const BRAND_CONFIGS: Record<string, BrandConfig> = {
  allaboard365: {
    name: 'AllAboard365',
    colors: {
      primary: '#1f8dbf',
      primaryLight: '#d6eef8',
      primaryDark: '#125e82',
      secondary: '#0f4c75',
      neutralLight: '#f7f9fa',
      neutralDark: '#2b2b2b',
      success: '#4caf50',
      error: '#e53935',
      warning: '#ffb300',
    },
    logos: {
      // Primary: transparent horizontal logo (white-background version kept as allaboard365-logo-primary.png to swap)
      main: '/images/branding/allaboard365/allaboard365-logo-primary-transparent.png',
      light: '/images/branding/allaboard365/allaboard365-logo-primary-transparent.png',
      dark: '/images/branding/allaboard365/allaboard365-logo-primary-transparent.png',
      icon: '/images/branding/allaboard365/allaboard365-logo-transparent.png',
      favicon: '/images/branding/allaboard365/favicon-32.png',
    },
    tagline: 'Insurance enrollment made simple',
    supportEmail: 'improve@allaboard365.com',
    companyUrl: 'https://allaboard365.com',
  },
  'qenroll': {
    name: 'QEnroll',
    colors: {
      primary: '#2563EB', // CTA Blue
      primaryLight: '#E0E7FF', // Light text color for dark backgrounds (not the soft background)
      primaryDark: '#1E40AF', // CTA Blue Hover / Dark background
      secondary: '#6366F1', // Accent Indigo
      neutralLight: '#F9FAFB', // bg-main
      neutralDark: '#111827', // ink-900
      success: '#16A34A',
      error: '#DC2626',
      warning: '#F59E0B',
    },
    logos: {
      main: '/images/branding/qenroll/logo.png',
      light: '/images/branding/qenroll/logo-light.png',
      dark: '/images/branding/qenroll/logo-dark.png',
      icon: '/images/branding/qenroll/icon.png',
      favicon: '/images/branding/qenroll/favicon.ico',
    },
    tagline: 'Quick and easy enrollment',
    supportEmail: 'support@qenroll.com',
    companyUrl: 'https://qenroll.com',
  },
  // Example: Add more brands here
  // 'brand2': {
  //   name: 'Brand 2',
  //   colors: {
  //     primary: '#ff6b6b',
  //     primaryLight: '#ffe0e0',
  //     primaryDark: '#cc0000',
  //     secondary: '#4ecdc4',
  //     neutralLight: '#f7f9fa',
  //     neutralDark: '#2b2b2b',
  //     success: '#4caf50',
  //     error: '#e53935',
  //     warning: '#ffb300',
  //   },
  //   logos: {
  //     main: '/images/branding/brand2/logo.svg',
  //     light: '/images/branding/brand2/logo-light.svg',
  //     dark: '/images/branding/brand2/logo-dark.svg',
  //     icon: '/images/branding/brand2/icon.svg',
  //     favicon: '/images/branding/brand2/favicon.ico',
  //   },
  //   tagline: 'Brand 2 Tagline',
  //   supportEmail: 'support@brand2.com',
  //   companyUrl: 'https://brand2.com',
  // },
};

/**
 * Default brand identifier
 */
export const DEFAULT_BRAND = 'allaboard365';

/**
 * Get brand configuration by brand identifier
 */
export const getBrandConfig = (brandId: string): BrandConfig => {
  const id = brandId === 'open-enroll' ? 'allaboard365' : brandId;
  return BRAND_CONFIGS[id] || BRAND_CONFIGS[DEFAULT_BRAND];
};
