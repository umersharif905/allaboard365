import { apiService } from '../api.service';

/**
 * Downloads the pricing export XLSX for the given product.
 * Follows the blob-download pattern from invoices.service.ts.
 */
export async function downloadPricingExport(
  productId: string,
  productName: string,
  isSysAdmin = false
): Promise<void> {
  const exportPath = isSysAdmin
    ? `/api/products/${encodeURIComponent(productId)}/pricing-export`
    : `/api/me/tenant-admin/my-products/${encodeURIComponent(productId)}/pricing-export`;
  const blob = await apiService.get(exportPath, { responseType: 'blob' }) as unknown as Blob;

  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    const safeName = productName.replace(/[^a-z0-9]/gi, '-').toLowerCase();
    link.download = `${safeName}-pricing.xlsx`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}
