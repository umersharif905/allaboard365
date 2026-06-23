// CaseFinancesTab — Finances tab for a Case: 5 summary cards + Bills / Ledger
// sub-tabs. Copied from share-requests/tabs/FinancesTab; deliberately omits the
// UA-coverage banner (Cases have no unshared-amount concept). See
// docs/billing-rework/case-finances-design.md.

import { useEffect, useState } from 'react';
import { Receipt, Wallet } from 'lucide-react';
import type { IconComponent } from '../../../../types/icon';
import { apiService } from '../../../../services/api.service';
import type { FinanceSummary } from '../../../../types/shareRequest.types';
import type { CaseFinanceSummaryResponse } from '../../../../types/case.types';
import CaseBillsTab from './CaseBillsTab';
import CaseLedgerTab from './CaseLedgerTab';
import Skeleton from '../../ui/Skeleton';

interface CaseFinancesTabProps {
  caseId: string;
}

type SubTabKey = 'bills' | 'ledger';

interface SubTabDef {
  key: SubTabKey;
  label: string;
  icon: IconComponent;
}

const SUB_TABS: readonly SubTabDef[] = [
  { key: 'bills',  label: 'Bills',  icon: Receipt },
  { key: 'ledger', label: 'Ledger', icon: Wallet },
];

const fmtCurrency = (n?: number) =>
  typeof n === 'number'
    ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)
    : '$0.00';

const CaseFinancesTab = ({ caseId }: CaseFinancesTabProps) => {
  const [activeSub, setActiveSub] = useState<SubTabKey>('bills');
  const [summary, setSummary] = useState<FinanceSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  // Bumped whenever a child tab mutates bills/transactions so the cards refresh.
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    setSummaryLoading(true);
    (async () => {
      try {
        const response = await apiService.get<CaseFinanceSummaryResponse>(
          `/api/me/vendor/cases/${caseId}/finance-summary`,
          { signal: controller.signal }
        );
        if (cancelled || controller.signal.aborted) return;
        if (response.success) setSummary(response.data);
      } catch {
        // stats bar gracefully degrades if the summary fetch fails
      } finally {
        if (!cancelled && !controller.signal.aborted) setSummaryLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [caseId, refreshKey]);

  const onFinancesChanged = () => setRefreshKey((k) => k + 1);

  return (
    <div className="flex flex-col h-full min-h-0">
      <FinancesStatsBar summary={summary} loading={summaryLoading} />

      <div className="px-4 sm:px-6 pt-4 border-b border-gray-200 bg-white shrink-0">
        <nav role="tablist" aria-label="Finances sections" className="flex gap-1">
          {SUB_TABS.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeSub === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => setActiveSub(tab.key)}
                className={`group relative px-3 py-2 text-sm font-medium transition-colors flex items-center gap-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-oe-primary ${
                  isActive ? 'text-oe-primary' : 'text-gray-500 hover:text-gray-800'
                }`}
              >
                <Icon className="h-4 w-4" />
                <span>{tab.label}</span>
                <span
                  aria-hidden="true"
                  className={`pointer-events-none absolute left-2 right-2 -bottom-px h-0.5 rounded-full transition-all duration-200 ${
                    isActive
                      ? 'bg-oe-primary opacity-100 scale-x-100'
                      : 'bg-gray-300 opacity-0 group-hover:opacity-50 scale-x-50'
                  }`}
                />
              </button>
            );
          })}
        </nav>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {activeSub === 'bills' && (
          <CaseBillsTab caseId={caseId} onChanged={onFinancesChanged} />
        )}
        {activeSub === 'ledger' && (
          <CaseLedgerTab caseId={caseId} onChanged={onFinancesChanged} />
        )}
      </div>
    </div>
  );
};

interface FinancesStatsBarProps {
  summary: FinanceSummary | null;
  loading: boolean;
}

const FinancesStatsBar = ({ summary, loading }: FinancesStatsBarProps) => {
  const stats = [
    { label: 'Billed',      value: summary?.billed,     accent: false, hint: 'Provider charges' },
    { label: 'Saved',       value: summary?.saved,      accent: false, hint: 'Discounts + financial aid' },
    { label: 'Member paid', value: summary?.memberPaid, accent: false, hint: 'Member out-of-pocket payments' },
    { label: 'Reimbursed',  value: summary?.reimbursed, accent: false, hint: 'Paid back to the member' },
    { label: 'Balance',     value: summary?.balance,    accent: true,  hint: 'Outstanding' },
  ];

  return (
    <div className="px-4 sm:px-6 pt-4 pb-4 bg-gradient-to-b from-gray-50 to-white border-b border-gray-200 shrink-0">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {stats.map((s) => (
          <div key={s.label} className="bg-white border border-gray-200 rounded-lg px-3 py-2" title={s.hint}>
            <p className="text-xs text-gray-500">{s.label}</p>
            {loading ? (
              <Skeleton className="h-5 w-20 mt-1" />
            ) : (
              <p className={`text-sm font-semibold ${s.accent ? 'text-oe-primary' : 'text-gray-900'}`}>
                {fmtCurrency(s.value)}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

export default CaseFinancesTab;
