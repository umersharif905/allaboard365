/**
 * Bundle Pricing Display Utilities
 * 
 * This module provides utilities for calculating DISPLAY prices for bundle products
 * where certain included products have hidden pricing that should be consolidated
 * into a "main" linked product's displayed price.
 * 
 * IMPORTANT: This is PURELY for visual display. All backend communication, validation,
 * and calculations MUST use actual prices, not display prices.
 */

export interface BundleProduct {
  productId: string;
  productName: string;
  monthlyPremium: number;
  hidePricing?: boolean;
  linkedToProductId?: string | null;
  pricingVariations?: Array<{
    configValue: string;
    monthlyPremium: number;
  }>;
}

export interface DisplayPriceResult {
  productId: string;
  displayPrice: number | null; // null means hide this product's price
  actualPrice: number; // Always store the actual price for backend use
  isHidden: boolean;
  linkedToProductId?: string | null;
}

export interface BundleDisplayPrices {
  displayPrices: Map<string, DisplayPriceResult>;
  hiddenProductIds: Set<string>;
}

/**
 * Calculate display prices for bundle products.
 * 
 * Products with hidePricing=true and a valid linkedToProductId will have their
 * price added to the linked product's display price and their own price hidden.
 * 
 * @param bundleProducts - Array of products in the bundle
 * @param selectedConfigs - Optional map of productId -> selected configuration value
 * @returns Object containing display prices and set of hidden product IDs
 */
export function calculateBundleDisplayPrices(
  bundleProducts: BundleProduct[],
  selectedConfigs?: Record<string, string>
): BundleDisplayPrices {
  const displayPrices = new Map<string, DisplayPriceResult>();
  const hiddenProductIds = new Set<string>();
  
  // First pass: identify hidden products and their linked products
  const hiddenProductsByLinkedId = new Map<string, BundleProduct[]>();
  
  bundleProducts.forEach(product => {
    // Get the actual price for this product (considering configuration if applicable)
    const actualPrice = getActualPrice(product, selectedConfigs?.[product.productId]);
    
    // Check if this product should have hidden pricing
    if (product.hidePricing && product.linkedToProductId) {
      // This product's price should be hidden and added to the linked product
      hiddenProductIds.add(product.productId);
      
      // Group hidden products by their linked product
      if (!hiddenProductsByLinkedId.has(product.linkedToProductId)) {
        hiddenProductsByLinkedId.set(product.linkedToProductId, []);
      }
      hiddenProductsByLinkedId.get(product.linkedToProductId)!.push(product);
      
      // Store as hidden (displayPrice = null)
      displayPrices.set(product.productId, {
        productId: product.productId,
        displayPrice: null,
        actualPrice,
        isHidden: true,
        linkedToProductId: product.linkedToProductId
      });
    } else {
      // Regular product - display its actual price (will be adjusted if it has linked hidden products)
      displayPrices.set(product.productId, {
        productId: product.productId,
        displayPrice: actualPrice,
        actualPrice,
        isHidden: false
      });
    }
  });
  
  // Second pass: add hidden product prices to their linked products
  hiddenProductsByLinkedId.forEach((hiddenProducts, linkedProductId) => {
    const linkedProduct = displayPrices.get(linkedProductId);
    
    if (linkedProduct) {
      // Calculate total price from all hidden products linked to this product
      const hiddenTotal = hiddenProducts.reduce((sum, hiddenProduct) => {
        const hiddenPrice = getActualPrice(hiddenProduct, selectedConfigs?.[hiddenProduct.productId]);
        return sum + hiddenPrice;
      }, 0);
      
      // Update the display price to include hidden products
      linkedProduct.displayPrice = linkedProduct.actualPrice + hiddenTotal;
    }
  });
  
  return {
    displayPrices,
    hiddenProductIds
  };
}

/**
 * Get the actual price for a product, considering configuration if applicable.
 * 
 * @param product - The product to get price for
 * @param selectedConfig - Optional selected configuration value
 * @returns The actual monthly premium for this product
 */
function getActualPrice(product: BundleProduct, selectedConfig?: string): number {
  // If product has pricing variations and a config is selected, use that price
  if (product.pricingVariations && product.pricingVariations.length > 0 && selectedConfig) {
    const variation = product.pricingVariations.find(v => v.configValue === selectedConfig);
    if (variation) {
      return variation.monthlyPremium;
    }
  }
  
  // Otherwise use the base monthly premium
  return product.monthlyPremium || 0;
}

/**
 * Get the display price for a specific product.
 * Returns null if the product's price should be hidden.
 * 
 * @param productId - The product ID to get display price for
 * @param displayPrices - The display prices map from calculateBundleDisplayPrices
 * @returns The display price or null if hidden
 */
export function getDisplayPrice(
  productId: string,
  displayPrices: Map<string, DisplayPriceResult>
): number | null {
  const result = displayPrices.get(productId);
  return result?.displayPrice ?? null;
}

/**
 * Check if a product's price should be hidden.
 * 
 * @param productId - The product ID to check
 * @param hiddenProductIds - The set of hidden product IDs from calculateBundleDisplayPrices
 * @returns True if the product's price should be hidden
 */
export function isProductPriceHidden(
  productId: string,
  hiddenProductIds: Set<string>
): boolean {
  return hiddenProductIds.has(productId);
}

/**
 * Get the actual price for a product (for backend communication).
 * This should ALWAYS be used when sending data to the backend.
 * 
 * @param productId - The product ID to get actual price for
 * @param displayPrices - The display prices map from calculateBundleDisplayPrices
 * @returns The actual monthly premium (not the display price)
 */
export function getActualPriceForBackend(
  productId: string,
  displayPrices: Map<string, DisplayPriceResult>
): number {
  const result = displayPrices.get(productId);
  return result?.actualPrice ?? 0;
}

