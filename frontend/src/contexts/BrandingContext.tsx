// frontend/src/contexts/BrandingContext.tsx
// React context for multi-branding support

import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { 
  getCurrentBrand, 
  getCurrentBrandConfig, 
  loadRuntimeBrandConfig,
  type BrandConfig 
} from '../config/branding';

interface BrandingContextType {
  brand: string;
  config: BrandConfig;
  logos: BrandConfig['logos'];
  colors: BrandConfig['colors'];
  getLogo: (type: 'main' | 'light' | 'dark' | 'icon' | 'favicon') => string;
}

const BrandingContext = createContext<BrandingContextType | undefined>(undefined);

interface BrandingProviderProps {
  children: ReactNode;
}

export const BrandingProvider: React.FC<BrandingProviderProps> = ({ children }) => {
  const [brand, setBrand] = useState<string>(getCurrentBrand());
  const [config, setConfig] = useState<BrandConfig>(getCurrentBrandConfig());
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // Load runtime brand config
    loadRuntimeBrandConfig().then(() => {
      const currentBrand = getCurrentBrand();
      const currentConfig = getCurrentBrandConfig();
      
      setBrand(currentBrand);
      setConfig(currentConfig);
      setIsLoading(false);
      
      console.log('[BrandingContext] Brand initialized:', currentBrand);
      console.log('[BrandingContext] Brand config:', currentConfig);
    }).catch((error) => {
      console.error('[BrandingContext] Failed to load brand config:', error);
      setIsLoading(false);
    });
  }, []);

  // Apply brand colors to CSS variables
  useEffect(() => {
    if (isLoading) return;

    const root = document.documentElement;
    
    // Apply brand colors as CSS variables
    root.style.setProperty('--oe-primary', config.colors.primary);
    root.style.setProperty('--oe-primary-light', config.colors.primaryLight);
    root.style.setProperty('--oe-primary-dark', config.colors.primaryDark);
    
    // Store primary color for use with Material-UI alpha function
    // Convert hex to RGB for rgba usage
    const hexToRgb = (hex: string) => {
      const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
      return result ? `${parseInt(result[1], 16)}, ${parseInt(result[2], 16)}, ${parseInt(result[3], 16)}` : '31, 141, 191';
    };
    root.style.setProperty('--oe-primary-rgb', hexToRgb(config.colors.primary));
    
    if (config.colors.secondary) {
      root.style.setProperty('--oe-secondary', config.colors.secondary);
    }
    if (config.colors.neutralLight) {
      root.style.setProperty('--oe-neutral-light', config.colors.neutralLight);
    }
    if (config.colors.neutralDark) {
      root.style.setProperty('--oe-neutral-dark', config.colors.neutralDark);
    }
    if (config.colors.success) {
      root.style.setProperty('--oe-success', config.colors.success);
    }
    if (config.colors.error) {
      root.style.setProperty('--oe-error', config.colors.error);
    }
    if (config.colors.warning) {
      root.style.setProperty('--oe-warning', config.colors.warning);
    }
    
    // Set data attribute for brand-specific CSS targeting
    root.setAttribute('data-brand', brand);
    
    console.log('[BrandingContext] Applied brand colors to CSS variables');
  }, [config, brand, isLoading]);

  // Update document title and favicon
  useEffect(() => {
    if (isLoading) return;

    // Update document title (tab title; fallback to full name)
    document.title = config.tabTitle ?? config.name;
    
    // Update favicon
    const faviconLink = document.querySelector("link[rel='icon']") as HTMLLinkElement;
    if (faviconLink) {
      faviconLink.href = config.logos.favicon;
    } else {
      // Create favicon link if it doesn't exist
      const link = document.createElement('link');
      link.rel = 'icon';
      link.type = 'image/x-icon';
      link.href = config.logos.favicon;
      document.head.appendChild(link);
    }
    
    console.log('[BrandingContext] Updated document title and favicon');
  }, [config, isLoading]);

  const getLogo = (type: 'main' | 'light' | 'dark' | 'icon' | 'favicon'): string => {
    return config.logos[type];
  };

  const value: BrandingContextType = {
    brand,
    config,
    logos: config.logos,
    colors: config.colors,
    getLogo,
  };

  // Show loading state while brand config is loading
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <BrandingContext.Provider value={value}>
      {children}
    </BrandingContext.Provider>
  );
};

/**
 * Hook to access branding context
 * @throws Error if used outside BrandingProvider
 */
export const useBranding = (): BrandingContextType => {
  const context = useContext(BrandingContext);
  if (context === undefined) {
    throw new Error('useBranding must be used within a BrandingProvider');
  }
  return context;
};
