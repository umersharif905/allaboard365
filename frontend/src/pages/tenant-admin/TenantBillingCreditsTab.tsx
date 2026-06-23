import React, { useMemo, useState } from 'react';
import { AlertCircle, DollarSign, Loader2, RefreshCw, Search, X } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { useHouseholdCreditBalances, useHouseholdCredits, useGroupCredits } from '../../hooks/useHouseholdCredits';
import { householdCreditsService } from '../../services/householdCredits.service';

interface Props {
  canLoadData: boolean;
  onMemberClick?: (memberId: string) => void;
  onGroupClick?: (groupId: string) => void;
}

export default function TenantBillingCreditsTab({ canLoadData, onMemberClick, onGroupClick }: Props) {
  const [search, setSearch] = useState('');
  const [householdType, setHouseholdType] = useState<'Individual' | 'Group' | ''>('');
  const [includeApplied, setIncludeApplied] = useState(true);
  const [running, setRunning] = useState(false);
  const [drilldown, setDrilldown] = useState<
    | { kind: 'household'; id: string }
    | { kind: 'group'; id: string }
    | null
  >(null);

  const { data, isLoading, refetch, isFetching } = useHouseholdCreditBalances({ search, householdType, includeApplied });

  const totalBalance = useMemo(() => {
    return (data || []).reduce((acc, row) => acc + Number(row.Balance || 0), 0);
  }, [data]);

  const runDetectionNow = async () => {
    setRunning(true);
    try {
      const res = await householdCreditsService.runDetectionNow();
      const d = res.data;
      toast.success(`Detection complete: ${d.recognized} new credit(s), ${d.householdsTouched} household(s) touched, ${d.applicationsCount} application(s).`);
      void refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to run detection');
    } finally {
      setRunning(false);
    }
  };

  if (!canLoadData) {
    return (
      <div className="rounded-lg bg-yellow-50 border border-yellow-200 text-yellow-800 p-4 flex items-center gap-2">
        <AlertCircle className="h-5 w-5 flex-shrink-0" />
        <span>Select a tenant to view credit balances.</span>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Top stats + actions */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-full bg-oe-light flex items-center justify-center">
            <DollarSign className="h-5 w-5 text-oe-primary" />
          </div>
          <div>
            <div className="text-sm text-gray-500">Outstanding credit</div>
            <div className="text-2xl font-semibold text-gray-900">${totalBalance.toFixed(2)}</div>
            <div className="text-xs text-gray-500">{(data || []).length} account{(data || []).length === 1 ? '' : 's'} with balance</div>
          </div>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={runDetectionNow}
            disabled={running}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-oe-primary text-white hover:bg-oe-dark disabled:opacity-50"
          >
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Run credits detection now
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="h-4 w-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or group..."
            className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:outline-none"
          />
        </div>
        <select
          value={householdType}
          onChange={(e) => setHouseholdType((e.target.value as 'Individual' | 'Group' | '') || '')}
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-oe-primary focus:outline-none"
        >
          <option value="">All household types</option>
          <option value="Individual">Individual</option>
          <option value="Group">Group</option>
        </select>
        <label className="inline-flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
          <input
            type="checkbox"
            checked={includeApplied}
            onChange={(e) => setIncludeApplied(e.target.checked)}
            className="rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
          />
          Show fully applied
        </label>
        {isFetching && <Loader2 className="h-4 w-4 animate-spin text-gray-400" />}
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-gray-400" /></div>
      ) : !data || data.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          <DollarSign className="h-12 w-12 mx-auto mb-3 text-gray-300" />
          <p>No households with available credit.</p>
        </div>
      ) : (
        <div className="overflow-x-auto bg-white rounded-lg border border-gray-200">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Household / Group</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Type</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Available</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Issued</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Applied</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Entries</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Last Activity</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {data.map((row) => {
                const isGroupScope = !row.HouseholdId && !!row.GroupId;
                const displayName = row.HouseholdType === 'Group' ? (row.GroupName || '—') : (row.PrimaryName || '—');
                const rowKey = (row.HouseholdId || row.GroupId || '') + ':' + row.HouseholdType;
                const typeLabel = isGroupScope ? 'Group credit' : row.HouseholdType;
                return (
                  <tr key={rowKey} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-sm text-gray-900">
                      {row.HouseholdType === 'Group' && row.GroupId ? (
                        <button
                          type="button"
                          onClick={() => onGroupClick?.(row.GroupId as string)}
                          className="text-oe-primary hover:text-oe-dark hover:underline"
                        >
                          {displayName}
                        </button>
                      ) : row.PrimaryMemberId ? (
                        <button
                          type="button"
                          onClick={() => onMemberClick?.(row.PrimaryMemberId as string)}
                          className="text-oe-primary hover:text-oe-dark hover:underline"
                        >
                          {displayName}
                        </button>
                      ) : (
                        <span>{displayName}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm">
                      <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${row.HouseholdType === 'Group' ? 'bg-blue-100 text-blue-800' : 'bg-gray-100 text-gray-800'}`}>
                        {typeLabel}
                      </span>
                    </td>
                    <td className={`px-4 py-3 text-sm text-right font-semibold ${Number(row.Balance) > 0.005 ? 'text-oe-success' : 'text-gray-400'}`}>
                      ${Number(row.Balance).toFixed(2)}
                    </td>
                    <td className="px-4 py-3 text-sm text-right text-gray-600">
                      ${Number(row.TotalIssued || 0).toFixed(2)}
                    </td>
                    <td className="px-4 py-3 text-sm text-right text-gray-600">
                      ${Number(row.TotalApplied || 0).toFixed(2)}
                    </td>
                    <td className="px-4 py-3 text-sm text-right text-gray-600">{row.EntryCount}</td>
                    <td className="px-4 py-3 text-sm text-gray-600">
                      {row.LastActivity ? new Date(row.LastActivity).toLocaleDateString() : '—'}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => {
                          if (isGroupScope) {
                            setDrilldown({ kind: 'group', id: row.GroupId as string });
                          } else if (row.HouseholdId) {
                            setDrilldown({ kind: 'household', id: row.HouseholdId });
                          }
                        }}
                        className="text-sm text-oe-primary hover:text-oe-dark"
                      >
                        View entries
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {drilldown && (
        <CreditEntriesDrilldownModal
          scope={drilldown}
          onClose={() => setDrilldown(null)}
        />
      )}
    </div>
  );
}

function entryTypeLabel(t: string) {
  switch (t) {
    case 'OverpaymentRecognized': return 'Overpayment recognized';
    case 'AppliedToInvoice': return 'Applied to invoice';
    case 'ReversedApplication': return 'Reversed (refund)';
    case 'ManualGoodwill': return 'Manual credit';
    case 'Voided': return 'Voided';
    default: return t;
  }
}

function CreditEntriesDrilldownModal({
  scope,
  onClose
}: {
  scope: { kind: 'household'; id: string } | { kind: 'group'; id: string };
  onClose: () => void;
}) {
  const householdQuery = useHouseholdCredits(scope.kind === 'household' ? scope.id : null);
  const groupQuery = useGroupCredits(scope.kind === 'group' ? scope.id : null);
  const data = scope.kind === 'household' ? householdQuery.data : groupQuery.data;
  const isLoading = scope.kind === 'household' ? householdQuery.isLoading : groupQuery.isLoading;
  return (
    <div className="fixed inset-0 bg-gray-600 bg-opacity-50 z-50 overflow-y-auto" onClick={onClose}>
      <div className="relative top-20 mx-auto p-0 border w-[720px] max-w-[95vw] shadow-lg rounded-lg bg-white" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b border-gray-200">
          <div>
            <h3 className="text-lg font-medium text-gray-900">
              {scope.kind === 'group' ? 'Group credit ledger' : 'Household credit ledger'}
            </h3>
            <div className="text-sm text-gray-500">
              Available balance: ${Number(data?.availableCredit || 0).toFixed(2)}
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="h-5 w-5" /></button>
        </div>
        <div className="p-5 max-h-[70vh] overflow-y-auto">
          {isLoading ? (
            <div className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-gray-400" /></div>
          ) : !data || (data.byEntry || []).length === 0 ? (
            <div className="text-center py-8 text-gray-500">No credit entries</div>
          ) : (
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Type</th>
                  <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">Amount</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Notes</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {data.byEntry.map((e) => (
                  <tr key={e.EntryId}>
                    <td className="px-4 py-2 text-sm text-gray-900">{entryTypeLabel(e.EntryType)}</td>
                    <td className={`px-4 py-2 text-sm text-right font-medium ${Number(e.Amount) >= 0 ? 'text-oe-success' : 'text-gray-700'}`}>
                      {Number(e.Amount) >= 0 ? '+' : '-'}${Math.abs(Number(e.Amount)).toFixed(2)}
                    </td>
                    <td className="px-4 py-2 text-sm text-gray-600">{e.Notes || '—'}</td>
                    <td className="px-4 py-2 text-sm text-gray-600">
                      {e.CreatedDate ? new Date(e.CreatedDate).toLocaleDateString() : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
