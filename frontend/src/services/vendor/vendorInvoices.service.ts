import { apiService } from '../api.service';

export interface VendorInvoiceTenantPreview {
  tenantId: string;
  tenantName: string;
  isExternal: boolean;
  expectedAmount: number;
  lineCount: number;
  /** Active vendor enrollments today (ignores period effective-date filter). */
  activeLineCount?: number;
  activeRosterAmount?: number;
  /** Active enrollments with EffectiveDate after period end. */
  excludedByEffectiveDate?: number;
}

export interface VendorInvoicePreviewResponse {
  periodStart: string;
  periodEnd: string;
  tenants: VendorInvoiceTenantPreview[];
  summary: {
    tenantCount: number;
    lineCount: number;
    grandTotal: number;
  };
  warnings: string[];
}

export async function fetchVendorInvoicePreview(params: {
  periodStart: string;
  periodEnd: string;
}): Promise<VendorInvoicePreviewResponse> {
  const qs = new URLSearchParams({
    periodStart: params.periodStart,
    periodEnd: params.periodEnd,
  });
  const res = await apiService.get<{ success: boolean; data: VendorInvoicePreviewResponse }>(
    `/api/me/vendor/invoices/preview?${qs.toString()}`
  );
  if (!res.success || !res.data) {
    throw new Error('Failed to load invoice preview');
  }
  return res.data;
}

export async function downloadVendorInvoicesZip(params: {
  periodStart: string;
  periodEnd: string;
  tenantIds: string[];
}): Promise<{ blob: Blob; warnings: string[] }> {
  const token = localStorage.getItem('accessToken') || localStorage.getItem('token');
  const base = import.meta.env.VITE_API_URL || '';
  const res = await fetch(`${base}/api/me/vendor/invoices/generate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    credentials: 'include',
    body: JSON.stringify(params),
  });

  const warningsHeader = res.headers.get('X-Invoice-Warning-Detail');
  const warnings: string[] = [];
  if (warningsHeader) {
    try {
      warnings.push(decodeURIComponent(warningsHeader));
    } catch {
      warnings.push(warningsHeader);
    }
  }

  if (!res.ok) {
    let message = 'Invoice generation failed';
    try {
      const json = await res.json();
      message = json.message || message;
    } catch {
      /* keep default */
    }
    throw new Error(message);
  }

  const blob = await res.blob();
  return { blob, warnings };
}
