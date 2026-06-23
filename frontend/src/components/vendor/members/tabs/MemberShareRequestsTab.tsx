import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ClipboardList, Plus } from 'lucide-react';
import { apiService } from '../../../../services/api.service';
import { SkeletonRows } from '../../ui/Skeleton';
import EmptyState from '../../ui/EmptyState';

interface ShareRequestSummary {
  ShareRequestId: string;
  RequestNumber: string;
  RequestType: string;
  Status: string;
  Determination: string;
  DateOfService?: string;
  TotalBilledAmount: number;
  CreatedDate: string;
}

interface MemberShareRequestsTabProps {
  memberId: string;
  onCountChange?: (count: number) => void;
}

const formatDate = (raw?: string) => {
  if (!raw) return '-';
  try {
    const [datePart] = raw.split('T');
    if (datePart) {
      const [y, m, d] = datePart.split('-');
      if (y && m && d) {
        return new Date(parseInt(y), parseInt(m) - 1, parseInt(d)).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        });
      }
    }
    return new Date(raw).toLocaleDateString('en-US');
  } catch {
    return raw;
  }
};

const formatCurrency = (amount?: number) => {
  if (amount === undefined || amount === null) return '$0.00';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
};

const statusBadge = (status: string) => {
  switch (status?.toLowerCase()) {
    case 'complete':
      return 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200';
    case 'pending payment':
      return 'bg-blue-50 text-blue-700 ring-1 ring-blue-200';
    case 'new':
    case 'intake':
      return 'bg-amber-50 text-amber-700 ring-1 ring-amber-200';
    default:
      return 'bg-gray-50 text-gray-700 ring-1 ring-gray-200';
  }
};

const determinationBadge = (det: string) => {
  switch (det?.toLowerCase()) {
    case 'eligible':
      return 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200';
    case 'not eligible':
      return 'bg-red-50 text-red-700 ring-1 ring-red-200';
    case 'pending':
      return 'bg-amber-50 text-amber-700 ring-1 ring-amber-200';
    default:
      return 'bg-gray-50 text-gray-700 ring-1 ring-gray-200';
  }
};

const MemberShareRequestsTab = ({ memberId, onCountChange }: MemberShareRequestsTabProps) => {
  const navigate = useNavigate();
  const [requests, setRequests] = useState<ShareRequestSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();

    (async () => {
      setLoading(true);
      try {
        const response = await apiService.get<{ success: boolean; data: ShareRequestSummary[] }>(
          `/api/me/vendor/share-requests?memberId=${memberId}&limit=50`,
          { signal: controller.signal }
        );
        if (controller.signal.aborted) return;
        if (response.success) {
          setRequests(response.data);
          onCountChange?.(response.data.length);
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          console.error('Error loading share requests:', err);
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [memberId, onCountChange]);

  if (loading) {
    return (
      <div className="p-6">
        <SkeletonRows count={5} rowClassName="h-12" />
      </div>
    );
  }

  if (requests.length === 0) {
    return (
      <EmptyState
        icon={ClipboardList}
        title="No share requests yet"
        description="Create the first share request for this member."
        action={
          <button
            type="button"
            onClick={() => navigate(`/vendor/share-requests/new?memberId=${memberId}`)}
            className="inline-flex items-center gap-2 px-4 py-2 bg-oe-primary text-white text-sm font-medium rounded-md shadow-soft hover:bg-oe-dark hover:shadow-medium active:scale-[0.98] transition-all"
          >
            <Plus className="h-4 w-4" />
            Create First Request
          </button>
        }
      />
    );
  }

  return (
    <div className="p-6 animate-fade-up">
      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white shadow-soft">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">Request #</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">Type</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">Status</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">Determination</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">Date of Service</th>
              <th className="px-4 py-3 text-right text-xs font-semibold text-gray-600 uppercase tracking-wider">Billed Amount</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 bg-white">
            {requests.map((request) => (
              <tr
                key={request.ShareRequestId}
                onClick={() => navigate(`/vendor/share-requests/${request.ShareRequestId}`)}
                className="hover:bg-gray-50 active:bg-gray-100 cursor-pointer transition-colors"
              >
                <td className="px-4 py-3">
                  <span className="font-medium text-oe-primary hover:underline">{request.RequestNumber}</span>
                </td>
                <td className="px-4 py-3 text-sm text-gray-700">{request.RequestType || '—'}</td>
                <td className="px-4 py-3">
                  <span className={`inline-flex px-2 py-0.5 text-xs font-medium rounded-full ${statusBadge(request.Status)}`}>
                    {request.Status}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <span className={`inline-flex px-2 py-0.5 text-xs font-medium rounded-full ${determinationBadge(request.Determination)}`}>
                    {request.Determination}
                  </span>
                </td>
                <td className="px-4 py-3 text-sm text-gray-700">{formatDate(request.DateOfService)}</td>
                <td className="px-4 py-3 text-sm text-gray-900 text-right tabular-nums font-medium">{formatCurrency(request.TotalBilledAmount)}</td>
                <td className="px-4 py-3 text-sm text-gray-700">{formatDate(request.CreatedDate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default MemberShareRequestsTab;
