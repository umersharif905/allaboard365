import { useEffect, useState } from 'react';
import { apiService } from '../../../../services/api.service';
import type { ShareRequestBill } from '../../../../types/shareRequest.types';

export interface BillSummary {
  BillId: string;
  BillNumber: string;
  BilledAmount: number;
  Balance: number;
  ProviderId?: string;
  ProviderName?: string;
}

interface BillsResponse {
  success: boolean;
  data: ShareRequestBill[];
}

export const useShareRequestBills = (shareRequestId: string) => {
  const [bills, setBills] = useState<BillSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const response = await apiService.get<BillsResponse>(
          `/api/me/vendor/share-requests/${shareRequestId}/bills`,
          { signal: controller.signal }
        );
        if (cancelled || controller.signal.aborted) return;
        if (response.success) {
          setBills(
            response.data.map((b) => ({
              BillId: b.BillId,
              BillNumber: b.BillNumber ?? '',
              BilledAmount: b.BilledAmount,
              Balance: b.Balance,
              ProviderId: b.ProviderId,
              ProviderName: b.ProviderName,
            }))
          );
        } else {
          setError('Failed to load bills');
        }
      } catch (err) {
        if (cancelled || controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : 'Failed to load bills');
      } finally {
        if (!cancelled && !controller.signal.aborted) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [shareRequestId]);

  return { bills, loading, error };
};
