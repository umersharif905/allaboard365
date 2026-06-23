import { apiService } from './api.service';

export async function fetchPaymentReceiptPdfBlob(
  paymentId: string,
  opts?: { download?: boolean }
): Promise<Blob> {
  const qs = opts?.download ? '?download=1' : '';
  return apiService.get(`/api/payments/${encodeURIComponent(paymentId)}/receipt/pdf${qs}`, {
    responseType: 'blob',
  }) as unknown as Promise<Blob>;
}

/** Open payment receipt PDF in a new tab (same pattern as invoice PDF). */
export async function openPaymentReceiptPdfInNewTab(paymentId: string): Promise<void> {
  const blob = await fetchPaymentReceiptPdfBlob(paymentId);
  if (blob.type === 'application/json') {
    let msg = 'Could not load payment receipt';
    try {
      const body = JSON.parse(await blob.text()) as { message?: string };
      if (body.message) msg = body.message;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  const url = URL.createObjectURL(blob);
  try {
    window.open(url, '_blank', 'noopener,noreferrer');
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 120_000);
  }
}
