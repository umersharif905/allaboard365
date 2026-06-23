// src/constants/images.ts
// Centralized image path management
// NOTE: Branding logos should be accessed via useBranding() hook from BrandingContext
// These constants are kept for backward compatibility and fallback purposes

export const IMAGES = {
  // AllAboard365 branding (fallback/default)
  // Use useBranding() hook to get current brand logos
  BRANDING: {
    LOGO_MAIN: '/images/branding/allaboard365/allaboard365-logo-primary-transparent.png',
    LOGO_LIGHT: '/images/branding/allaboard365/allaboard365-logo-primary-transparent.png',
    LOGO_DARK: '/images/branding/allaboard365/allaboard365-logo-primary-transparent.png',
    LOGO_ICON: '/images/branding/allaboard365/allaboard365-logo-transparent.png',
    FAVICON: '/images/branding/allaboard365/favicon-32.png',
  },

  // UI Icons & Graphics
  UI: {
    DEFAULT_AVATAR: '/images/placeholders/default-avatar.svg',
    COMPANY_PLACEHOLDER: '/images/placeholders/company-placeholder.svg',
    PRODUCT_PLACEHOLDER: '/images/placeholders/product-placeholder.svg',
    LOADING_SPINNER: '/images/ui/loading-spinner.svg',
  },

  // Product Categories (Static)
  PRODUCTS: {
    HEALTHCARE: '/images/products/healthcare-category.svg',
    DENTAL: '/images/products/dental-category.svg', 
    VISION: '/images/products/vision-category.svg',
    LIFE: '/images/products/life-category.svg',
    DISABILITY: '/images/products/disability-category.svg',
  },

  // System Icons
  ICONS: {
    SUCCESS: '/images/icons/success.svg',
    ERROR: '/images/icons/error.svg',
    WARNING: '/images/icons/warning.svg',
    INFO: '/images/icons/info.svg',
  }
} as const;

// Helper function for dynamic tenant logos (from Azure Blob)
export const getTenantLogo = (logoUrl: string | null): string => {
  return logoUrl || IMAGES.UI.COMPANY_PLACEHOLDER;
};

// Helper function for product images (from Azure Blob)
export const getProductImage = (imageUrl: string | null, productType: string): string => {
  if (imageUrl) return imageUrl;
  
  // Fallback to category image based on product type
  switch (productType.toLowerCase()) {
    case 'healthcare': return IMAGES.PRODUCTS.HEALTHCARE;
    case 'dental': return IMAGES.PRODUCTS.DENTAL;
    case 'vision': return IMAGES.PRODUCTS.VISION;
    case 'life': return IMAGES.PRODUCTS.LIFE;
    case 'disability': return IMAGES.PRODUCTS.DISABILITY;
    default: return IMAGES.UI.PRODUCT_PLACEHOLDER;
  }
};
