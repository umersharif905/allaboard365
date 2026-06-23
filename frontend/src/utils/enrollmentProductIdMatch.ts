/** Normalize product GUID for Map lookups (case / braces / hyphens). */
export function normalizeEnrollmentProductId(raw: unknown): string {
  return String(raw ?? '')
    .replace(/[{}-]/g, '')
    .toLowerCase();
}

export function enrollmentProductIdsMatch(a: unknown, b: unknown): boolean {
  const na = normalizeEnrollmentProductId(a);
  const nb = normalizeEnrollmentProductId(b);
  return na.length > 0 && na === nb;
}

export function findEnrollmentPricingProductRow<T extends { productId?: string }>(
  products: ReadonlyArray<T>,
  productId: string,
): { row: T | undefined; matchedBy: 'exact' | 'caseInsensitive' | null } {
  const exact = products.find((p) => String(p.productId) === String(productId));
  if (exact) return { row: exact, matchedBy: 'exact' };
  const normalized = normalizeEnrollmentProductId(productId);
  const ci = products.find((p) => normalizeEnrollmentProductId(p.productId) === normalized);
  if (ci) return { row: ci, matchedBy: 'caseInsensitive' };
  return { row: undefined, matchedBy: null };
}
