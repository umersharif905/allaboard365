// frontend/src/utils/productTypeOrdering.ts

/**
 * Custom ordering for product types in the enrollment wizard
 * Order: Health, Dental, Vision, Life, Accidents, Critical Illness, Telemed, Other
 */
const PRODUCT_TYPE_ORDER = [
  'Healthcare', // Maps to "Health" 
  'Dental',
  'Vision', 
  'Life Insurance', // Maps to "Life"
  'Accident', // Maps to "Accidents"
  'Critical Illness',
  'Telemedicine', // Telemedicine products
  'Other'
];

/**
 * Get the sort priority for a product type
 * Lower numbers = higher priority (appears first)
 */
export const getProductTypePriority = (productType: string): number => {
  // Normalize the product type for comparison
  const normalizedType = productType.trim();
  
  // Find the index in our desired order
  const index = PRODUCT_TYPE_ORDER.findIndex(orderType => {
    // Handle exact matches
    if (orderType === normalizedType) return true;
    
    // Handle common variations
    if (orderType === 'Healthcare' && (normalizedType === 'Health' || normalizedType === 'Medical')) return true;
    if (orderType === 'Life Insurance' && normalizedType === 'Life') return true;
    if (orderType === 'Accident' && normalizedType === 'Accidents') return true;
    if (orderType === 'Telemedicine' && normalizedType === 'Telemed') return true;
    
    return false;
  });
  
  // If found, return the index. If not found, return a high number to put it at the end
  return index === -1 ? 999 : index;
};

/**
 * Sort an array of product types according to the custom order
 */
export const sortProductTypes = <T extends { productType: string }>(items: T[]): T[] => {
  return items.sort((a, b) => {
    const priorityA = getProductTypePriority(a.productType);
    const priorityB = getProductTypePriority(b.productType);
    
    // If priorities are the same, sort alphabetically
    if (priorityA === priorityB) {
      return a.productType.localeCompare(b.productType);
    }
    
    return priorityA - priorityB;
  });
};