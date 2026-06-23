// frontend/src/components/accounting/PaymentCommissionBreakdownModal.tsx
import React, { useEffect, useState } from 'react';
import { Building2, DollarSign, Star, X } from 'lucide-react';
import { apiService } from '../../services/apiServices';
import { PaymentCommissionBreakdownView } from '../billing/PaymentCommissionBreakdownView';
import { coerceCommissionTierLevelSnapshot, formatPayoutCommissionTierDisplay } from '../../constants/form-options';
import { TenantAdminAgentsService } from '../../services/tenant-admin/agents.service';
import { useCommissionLevels } from '../../hooks/useCommissionLevels';
import type {
  PaymentBreakdownAgentOverride,
  PaymentBreakdownData,
  PaymentBreakdownProduct,
} from '../../types/paymentCommissionBreakdown.types';

export type {
  PaymentBreakdownAgentOverride,
  PaymentBreakdownData,
  PaymentBreakdownProduct,
};

const formatCurrency = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
const formatDate = (d: string) =>
  d ? new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
const formatTierDisplay = (tierDisplay: string | null | undefined) => {
  const cleaned = tierDisplay?.trim();
  if (!cleaned) return '';
  if (cleaned.startsWith('(') && cleaned.endsWith(')')) return ` ${cleaned}`;
  return ` (${cleaned})`;
};

interface PaymentCommissionBreakdownModalProps {
  isOpen: boolean;
  onClose: () => void;
  paymentId: string;
  paymentDate?: string;
  amount?: number;
  agentName?: string;
  agentCommissionTierLevel?: number | null;
  /** DB snapshot label at payout time (tenant commission level name); optional. */
  agentCommissionTierLevelLabel?: string | null;
  clientName?: string;
  /** Data source endpoint for payment breakdown. */
  breakdownSource?: 'missing-preview' | 'me-agent' | 'me-agent-downline' | 'accounting';
}

const PaymentCommissionBreakdownModal: React.FC<PaymentCommissionBreakdownModalProps> = ({
  isOpen,
  onClose,
  paymentId,
  paymentDate: initialPaymentDate,
  amount: initialAmount,
  agentName: initialAgentName,
  agentCommissionTierLevel: initialAgentCommissionTierLevel,
  agentCommissionTierLevelLabel: initialAgentCommissionTierLevelLabel,
  clientName: initialClientName,
  breakdownSource = 'missing-preview'
}) => {
  const [data, setData] = useState<PaymentBreakdownData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agentContext, setAgentContext] = useState<{ agencyName: string | null; commissionGroupName: string | null; isPrimary?: boolean } | null>(null);
  const { displayNameByLevel: tierLevelDisplayNames } = useCommissionLevels();
  const tierLevelRaw = data?.agentCommissionTierLevel ?? initialAgentCommissionTierLevel ?? null;
  const tierLabelRaw =
    data?.agentCommissionTierLevelSnapshotLabel ?? initialAgentCommissionTierLevelLabel ?? null;
  const agentTierDisplay = formatPayoutCommissionTierDisplay(
    coerceCommissionTierLevelSnapshot(tierLevelRaw) ?? undefined,
    tierLabelRaw
  );

  // Load selling agent context (agency, commission group) for the header.
  useEffect(() => {
    if (!isOpen) return;
    const sellingAgentId = data?.sellingAgentId;
    if (!sellingAgentId) {
      setAgentContext(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const resp = await TenantAdminAgentsService.getAgentDetails(sellingAgentId);
        if (cancelled || !resp?.success || !resp.data) return;
        const d = resp.data as any;
        setAgentContext({
          agencyName: d.AgencyName || null,
          commissionGroupName: d.CommissionGroupName || null,
          isPrimary: d.IsPrimary === true
        });
      } catch {
        // best-effort.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, data?.sellingAgentId]);

  useEffect(() => {
    if (!isOpen || !paymentId) return;
    setError(null);
    setData(null);
    setLoading(true);
    const breakdownUrl =
      breakdownSource === 'me-agent'
        ? `/api/me/agent/payments/${encodeURIComponent(paymentId)}/commission-breakdown`
        : breakdownSource === 'me-agent-downline'
          ? `/api/me/agent/payments/${encodeURIComponent(paymentId)}/commission-breakdown?perspective=downline`
          : breakdownSource === 'accounting'
            ? `/api/accounting/commission-breakdown/payment/${encodeURIComponent(paymentId)}`
            : `/api/commissions/missing-preview/${encodeURIComponent(paymentId)}/breakdown`;
    apiService
      .get<{ success: boolean; data: PaymentBreakdownData; message?: string }>(breakdownUrl)
      .then((res) => {
        if (res.success && res.data) setData(res.data);
        else setError(res.message || 'Failed to load breakdown');
      })
      .catch((err: any) => setError(err.message || 'Failed to load breakdown'))
      .finally(() => setLoading(false));
  }, [isOpen, paymentId, breakdownSource]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center">
      <div className="fixed inset-0 bg-black/50" onClick={onClose} aria-hidden="true" />
      <div className="relative bg-white rounded-lg shadow-xl border border-gray-200 max-w-3xl w-full mx-4 max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between p-6 border-b border-gray-200 flex-shrink-0">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">
              {breakdownSource === 'me-agent'
                ? 'Your commission breakdown'
                : 'Commission breakdown – who gets paid what'}
            </h2>
            <div className="mt-2 space-y-2">
              {data ? (
                <>
                  {/* Agent identity row — name + pills (tier / agency / group / primary). */}
                  {data.agentName && (
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-base font-semibold text-gray-900">{data.agentName}</span>
                      {agentTierDisplay ? (
                        <span
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-oe-primary border border-blue-100"
                          title="Commission level"
                        >
                          <DollarSign className="h-3 w-3" />
                          {agentTierDisplay}
                        </span>
                      ) : null}
                      {agentContext?.agencyName && (
                        <span
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-800 border border-gray-200"
                          title="Agency"
                        >
                          <Building2 className="h-3 w-3" />
                          {agentContext.agencyName}
                        </span>
                      )}
                      {agentContext?.commissionGroupName && (
                        <span
                          className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-800 border border-gray-200"
                          title="Commission group"
                        >
                          {agentContext.commissionGroupName}
                        </span>
                      )}
                      {agentContext?.isPrimary && (
                        <span
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-50 text-amber-800 border border-amber-200"
                          title="Primary agency"
                        >
                          <Star className="h-3 w-3" />
                          Primary
                        </span>
                      )}
                    </div>
                  )}
                  {/* Payment + commission summary. */}
                  <p className="text-sm text-gray-600">
                    Payment {formatDate(data.paymentDate)} · {formatCurrency(data.amount)} ·{' '}
                    {breakdownSource === 'me-agent' ? 'Your commission' : 'Commission'}{' '}
                    {breakdownSource === 'me-agent' && data.commissionAfterOverrides != null && data.commissionBeforeOverrides != null && data.commissionAfterOverrides !== data.commissionBeforeOverrides ? (
                      <>
                        {formatCurrency(data.commissionAfterOverrides)}{' '}
                        <span className="text-gray-500">
                          (was {formatCurrency(data.commissionBeforeOverrides)} before overrides)
                        </span>
                      </>
                    ) : (
                      formatCurrency(data.commission)
                    )}
                  </p>
                  {initialClientName && (
                    <p className="text-sm text-gray-600">
                      Client: {initialClientName}
                      {formatTierDisplay(data.clientTierDisplay)}
                    </p>
                  )}
                </>
              ) : (
                (initialPaymentDate || initialAmount || initialAgentName) && (
                  <p className="text-sm text-gray-600">
                    {initialPaymentDate && formatDate(initialPaymentDate)}
                    {initialAmount != null && ` · ${formatCurrency(initialAmount)}`}
                    {initialAgentName && ` · ${initialAgentName}`}
                    {initialClientName && ` · ${initialClientName}`}
                  </p>
                )
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-700"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <PaymentCommissionBreakdownView
          data={data}
          loading={loading}
          error={error}
          breakdownSource={breakdownSource}
          clientName={initialClientName}
          suppressAccountingIntro={breakdownSource !== 'me-agent'}
          tierLevelDisplayNames={tierLevelDisplayNames}
        />
      </div>
    </div>
  );
};

export default PaymentCommissionBreakdownModal;
