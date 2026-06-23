import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Briefcase } from 'lucide-react';
import { apiService } from '../../../../services/api.service';
import { SkeletonRows } from '../../ui/Skeleton';
import EmptyState from '../../ui/EmptyState';

interface CaseSummary {
  CaseId: string;
  CaseNumber: string;
  Title?: string | null;
  Status: string;
  CaseType?: string | null;
  CaseSubcategory?: string | null;
  SubmittedDate?: string | null;
  CreatedDate: string;
}

interface MemberCasesTabProps {
  memberId: string;
  onCountChange?: (count: number) => void;
}

const formatDate = (raw?: string | null) => {
  if (!raw) return '-';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

const statusBadge = (status: string) => {
  switch (status?.toLowerCase()) {
    case 'complete':
    case 'closed':
    case 'resolved':
      return 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200';
    case 'open':
    case 'in progress':
      return 'bg-blue-50 text-blue-700 ring-1 ring-blue-200';
    case 'new':
    case 'intake':
      return 'bg-amber-50 text-amber-700 ring-1 ring-amber-200';
    default:
      return 'bg-gray-50 text-gray-700 ring-1 ring-gray-200';
  }
};

const MemberCasesTab = ({ memberId, onCountChange }: MemberCasesTabProps) => {
  const navigate = useNavigate();
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();

    (async () => {
      setLoading(true);
      try {
        const response = await apiService.get<{ success: boolean; data: CaseSummary[] }>(
          `/api/me/vendor/cases?memberId=${memberId}&limit=50`,
          { signal: controller.signal }
        );
        if (controller.signal.aborted) return;
        if (response.success) {
          setCases(response.data);
          onCountChange?.(response.data.length);
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          console.error('Error loading cases:', err);
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

  if (cases.length === 0) {
    return (
      <EmptyState
        icon={Briefcase}
        title="No cases yet"
        description="Cases for this member will appear here."
      />
    );
  }

  return (
    <div className="p-6 animate-fade-up">
      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white shadow-soft">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">Case #</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">Title</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">Type</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">Status</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 bg-white">
            {cases.map((c) => (
              <tr
                key={c.CaseId}
                onClick={() => navigate(`/vendor/cases/${c.CaseId}`)}
                className="hover:bg-gray-50 active:bg-gray-100 cursor-pointer transition-colors"
              >
                <td className="px-4 py-3">
                  <span className="font-medium text-oe-primary hover:underline">{c.CaseNumber}</span>
                </td>
                <td className="px-4 py-3 text-sm text-gray-700">{c.Title || '—'}</td>
                <td className="px-4 py-3 text-sm text-gray-700">
                  {c.CaseType || '—'}
                  {c.CaseSubcategory ? ` · ${c.CaseSubcategory}` : ''}
                </td>
                <td className="px-4 py-3">
                  <span className={`inline-flex px-2 py-0.5 text-xs font-medium rounded-full ${statusBadge(c.Status)}`}>
                    {c.Status}
                  </span>
                </td>
                <td className="px-4 py-3 text-sm text-gray-700">{formatDate(c.SubmittedDate || c.CreatedDate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default MemberCasesTab;
