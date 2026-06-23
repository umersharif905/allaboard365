export interface QuickQuoteOptionTotals {
  subtotalPremium: number;
  processingFee: number;
  systemFees: number;
  totalPremium: number;
}

export interface QuickQuoteBreakdownItem {
  quoteItemId?: string;
  productId: string;
  productName: string;
  isBundle: boolean;
  basePremium: number;
  includedProcessingFee: number;
  premiumWithIncludedFee: number;
  selectedConfigValues?: Record<string, string> | null;
  selectedConfigDetails?: Array<{ key: string; label: string; value: string }> | null;
  /** Per-option Total + Fees, sourced from the pricing authority for this product+amount. */
  optionTotals?: QuickQuoteOptionTotals | null;
}

export interface QuickQuoteProductGroup {
  productId: string;
  productName: string;
  items: QuickQuoteBreakdownItem[];
}

/**
 * Group a flat breakdown (one entry per product x unshared-amount) into per-product
 * sections, preserving first-seen product order. This is what lets the quote render
 * "split by product" instead of as a cartesian list of cross-product combinations.
 */
export function groupBreakdownByProduct(
  breakdown: QuickQuoteBreakdownItem[]
): QuickQuoteProductGroup[] {
  const groups: QuickQuoteProductGroup[] = [];
  const indexByProductId = new Map<string, number>();

  for (const item of breakdown || []) {
    const key = String(item.productId);
    const existingIndex = indexByProductId.get(key);
    if (existingIndex === undefined) {
      indexByProductId.set(key, groups.length);
      groups.push({ productId: key, productName: item.productName, items: [item] });
    } else {
      groups[existingIndex].items.push(item);
    }
  }

  return groups;
}
