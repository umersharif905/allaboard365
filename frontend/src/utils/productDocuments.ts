/**
 * Product document entry (single or from productDocuments array).
 */
export interface ProductDocumentItem {
  productDocumentId?: string;
  documentUrl: string;
  displayName?: string;
  sortOrder?: number;
}

/**
 * Get an array of document items from a product.
 * Uses productDocuments when present, otherwise falls back to productDocumentUrl for backward compatibility.
 */
export function getProductDocumentItems(product: {
  productDocuments?: ProductDocumentItem[];
  productDocumentUrl?: string | null;
  ProductDocumentUrl?: string | null;
}): ProductDocumentItem[] {
  const docs = product?.productDocuments;
  if (Array.isArray(docs) && docs.length > 0) {
    return [...docs].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  }
  const single = product?.productDocumentUrl ?? product?.ProductDocumentUrl;
  if (single && typeof single === 'string' && single.trim() !== '') {
    return [{ documentUrl: single.trim(), displayName: 'Document', sortOrder: 0 }];
  }
  return [];
}

/**
 * Whether the product has any document (single URL or productDocuments).
 */
export function hasProductDocuments(product: {
  productDocuments?: ProductDocumentItem[];
  productDocumentUrl?: string | null;
  ProductDocumentUrl?: string | null;
}): boolean {
  return getProductDocumentItems(product).length > 0;
}
