import { History } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { MembersService, type MemberHistoryRow } from '../../../services/members.service';

interface Props {
  memberId: string;
}

const formatWhen = (iso: string) => {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
};

const MemberHistoryTab: React.FC<Props> = ({ memberId }) => {
  const [rows, setRows] = useState<MemberHistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await MembersService.getMemberHistory(memberId);
        if (cancelled) return;
        if (res.success && Array.isArray(res.data)) {
          setRows(res.data);
        } else {
          setRows([]);
          setError(res.message || 'Could not load history');
        }
      } catch (e) {
        if (!cancelled) {
          setRows([]);
          setError(e instanceof Error ? e.message : 'Could not load history');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [memberId]);

  const describeRow = (r: MemberHistoryRow): string => {
    if (r.EventType === 'GROUP_CHANGED') {
      const from = r.OldGroupName || (r.OldGroupId ? r.OldGroupId : 'No group');
      const to = r.NewGroupName || (r.NewGroupId ? r.NewGroupId : 'No group');
      return `Group changed: ${from} → ${to}`;
    }
    if (r.EventType === 'PLAN_MODIFICATION_APPLIED') {
      return r.EventDetails?.trim() || r.NewGroupName?.trim() || 'Plan modification applied';
    }
    return r.EventType;
  };

  return (
    <div className="p-6">
      <div className="flex items-start gap-3 mb-4">
        <div className="flex-shrink-0 h-10 w-10 rounded-lg bg-gray-100 flex items-center justify-center">
          <History className="h-5 w-5 text-gray-600" />
        </div>
        <div>
          <h3 className="text-lg font-medium text-gray-900">Member history</h3>
          <p className="text-sm text-gray-600 mt-0.5">
            Administrative changes recorded for this member (group assignment, tenant admin plan modifications, and similar).
          </p>
        </div>
      </div>

      {loading ? (
        <div className="animate-pulse space-y-2">
          <div className="h-10 bg-gray-100 rounded-lg" />
          <div className="h-10 bg-gray-100 rounded-lg" />
        </div>
      ) : error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>
      ) : rows.length === 0 ? (
        <p className="text-sm text-gray-500">No history entries yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th scope="col" className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                  When
                </th>
                <th scope="col" className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                  Event
                </th>
                <th scope="col" className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                  By
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {rows.map((r) => (
                <tr key={r.EventId}>
                  <td className="px-4 py-2 text-sm text-gray-900 whitespace-nowrap">{formatWhen(r.CreatedDate)}</td>
                  <td className="px-4 py-2 text-sm text-gray-800">{describeRow(r)}</td>
                  <td className="px-4 py-2 text-sm text-gray-600">
                    {(r.CreatedByName && r.CreatedByName.trim()) || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default MemberHistoryTab;
