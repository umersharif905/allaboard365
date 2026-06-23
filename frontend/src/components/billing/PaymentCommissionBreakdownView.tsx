import { ArrowRight, Loader2 } from 'lucide-react';
import React from 'react';
import { getTierLevelLabel, getTierName } from '../../constants/form-options';
import type { PaymentBreakdownData } from '../../types/paymentCommissionBreakdown.types';

const formatCurrency = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

const formatTierDisplay = (tierDisplay: string | null | undefined) => {
  const cleaned = tierDisplay?.trim();
  if (!cleaned) return '';
  if (cleaned.startsWith('(') && cleaned.endsWith(')')) return ` ${cleaned}`;
  return ` (${cleaned})`;
};

export interface PaymentCommissionBreakdownViewProps {
  data: PaymentBreakdownData | null;
  loading: boolean;
  error: string | null;
  /** Same semantics as PaymentCommissionBreakdownModal */
  breakdownSource: 'accounting' | 'me-agent' | 'me-agent-downline' | 'missing-preview';
  /** Optional client line (me-agent / compact headers) */
  clientName?: string | null;
  compact?: boolean;
  /** Hide selling-agent / commission-pool subtitle (fullscreen modal repeats this in its header). */
  suppressAccountingIntro?: boolean;
  /** Optional SortOrder → DisplayName map from oe.CommissionLevels for the
   *  active tenant. When provided, tier columns use the configured DB names
   *  instead of the global hardcoded fallback. */
  tierLevelDisplayNames?: Map<number, string>;
}

export const PaymentCommissionBreakdownView: React.FC<PaymentCommissionBreakdownViewProps> = ({
  data,
  loading,
  error,
  breakdownSource,
  clientName,
  compact,
  suppressAccountingIntro = false,
  tierLevelDisplayNames
}) => {
  const isAccountingLike = breakdownSource === 'accounting' || breakdownSource === 'missing-preview';
  const agentTierLevel = data?.agentCommissionTierLevel ?? null;
  const dynamicTierName = (level: number | null | undefined): string => {
    if (level == null) return '';
    return tierLevelDisplayNames?.get(Number(level)) || getTierName(Number(level));
  };
  const dynamicTierLabel = (level: number | null | undefined): string => {
    if (level == null) return '';
    const dyn = tierLevelDisplayNames?.get(Number(level));
    return dyn ? `Level ${level}: ${dyn}` : getTierLevelLabel(level);
  };
  const agentTierLabel = dynamicTierLabel(agentTierLevel);
  const pyMain = compact ? 'py-2' : 'py-12';

  return (
    <div className={compact ? '' : 'p-6 overflow-y-auto flex-1 min-h-0'}>
      {loading && (
        <div className={`flex items-center justify-center ${pyMain}`}>
          <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
          <span className="ml-2 text-gray-600">Loading breakdown...</span>
        </div>
      )}

      {error && (
        <div className={`p-4 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800 ${compact ? 'mb-2' : ''}`}>
          {error}
        </div>
      )}

      {!loading && data && isAccountingLike && !suppressAccountingIntro && (
        <div className={`text-xs text-gray-600 ${compact ? 'mb-3' : 'mb-4'} space-y-0.5`}>
          <p>
            Selling agent: {data.agentName || '—'}
            {agentTierLevel != null ? ` (${agentTierLabel})` : ''}
            {' · '}Commission pool: {formatCurrency(data.commission)}
          </p>
          {clientName ? (
            <p>
              Client: {clientName}
              {formatTierDisplay(data.clientTierDisplay)}
            </p>
          ) : null}
        </div>
      )}

      {!loading && data && data.products.length === 0 && (
        <p className={`text-gray-600 ${compact ? 'text-xs' : 'text-sm'}`}>
          No product breakdown available for this payment.
        </p>
      )}

      {!loading && data && Array.isArray(data.agentOverrides) && data.agentOverrides.length > 0 ? (
        breakdownSource === 'me-agent' ? (
          (() => {
            const baseTotal =
              data.commissionBeforeOverrides != null ? data.commissionBeforeOverrides : data.commission;
            const netTotal =
              data.commissionAfterOverrides != null ? data.commissionAfterOverrides : data.commission;
            const viewerImpacting = data.agentOverrides!.filter(
              (ov) => ov.viewerRole === 'source' || ov.viewerRole === 'recipient'
            );
            return (
              <div className={`mb-6 border border-blue-200 rounded-lg overflow-hidden ${compact ? 'text-xs' : ''}`}>
                <div className="bg-blue-50 px-4 py-3 border-b border-blue-200">
                  <h3 className="text-sm font-medium text-blue-900">Your commission after overrides</h3>
                  <p className="text-xs text-blue-800 mt-0.5">
                    Agent-to-agent overrides redirect a portion of your per-payment commission.
                  </p>
                </div>
                <div className="px-4 py-3 bg-white space-y-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-gray-700">Total</span>
                    <span className="font-medium text-gray-900">{formatCurrency(baseTotal)}</span>
                  </div>
                  {viewerImpacting.map((ov) => {
                    const giving = ov.viewerRole === 'source';
                    const counterpart = giving
                      ? ov.recipientAgentName || 'Unknown'
                      : ov.sourceAgentName || 'Unknown';
                    const sign = giving ? '-' : '+';
                    const color = giving ? 'text-red-600' : 'text-green-700';
                    return (
                      <div key={ov.overrideId} className="flex items-center justify-between">
                        <span className="text-gray-600">
                          {giving ? 'To' : 'From'} {counterpart}
                        </span>
                        <span className={`font-medium ${color}`}>
                          {sign}
                          {formatCurrency(ov.amount)}
                        </span>
                      </div>
                    );
                  })}
                  <div className="border-t border-gray-200 pt-2 flex items-center justify-between">
                    <span className="font-semibold text-gray-900">Total After Overrides</span>
                    <span className="font-semibold text-gray-900">{formatCurrency(netTotal)}</span>
                  </div>
                </div>
              </div>
            );
          })()
        ) : (
          <div className={`mb-6 border border-blue-200 rounded-lg overflow-hidden ${compact ? 'text-xs' : ''}`}>
            <div className="bg-blue-50 px-4 py-3 border-b border-blue-200">
              <h3 className="text-sm font-medium text-blue-900">Agent overrides applied</h3>
              <p className="text-xs text-blue-800 mt-0.5">
                Portions of one agent&apos;s per-payment commission redirected to another agent.
              </p>
            </div>
            <div className="overflow-x-auto bg-white">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      From
                    </th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      To
                    </th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Type
                    </th>
                    <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Amount
                    </th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {data.agentOverrides.map((ov) => (
                    <tr key={ov.overrideId}>
                      <td className="px-4 py-2 text-sm text-gray-900">{ov.sourceAgentName}</td>
                      <td className="px-4 py-2 text-sm text-gray-900">
                        <div className="flex items-center">
                          <ArrowRight className="h-3.5 w-3.5 text-gray-400 mr-1.5" />
                          {ov.recipientAgentName || 'Unknown'}
                        </div>
                      </td>
                      <td className="px-4 py-2 text-sm text-gray-600">{ov.overrideType}</td>
                      <td
                        className={`px-4 py-2 text-sm text-right font-medium ${
                          ov.skipped ? 'text-gray-400 line-through' : 'text-green-700'
                        }`}
                      >
                        {formatCurrency(ov.amount)}
                      </td>
                      <td className="px-4 py-2 text-sm">
                        {ov.skipped ? (
                          <span
                            className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-yellow-100 text-yellow-800"
                            title={ov.skipReason}
                          >
                            Skipped
                          </span>
                        ) : (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-green-100 text-green-800">
                            Applied
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      ) : null}

      {!loading && data && data.products.length > 0 ? (
        <div className="space-y-6">
          {data.products.map((product) => (
            <div key={product.productId} className="border border-gray-200 rounded-lg overflow-hidden">
              <div className="bg-gray-50 px-4 py-3 border-b border-gray-200 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="font-medium text-gray-900">{product.productName}</h3>
                  {product.tierDisplay ? (
                    <p className="text-xs text-gray-500 mt-0.5">{product.tierDisplay}</p>
                  ) : null}
                </div>
                <span className="text-sm text-green-700 font-medium whitespace-nowrap">
                  Commission: {formatCurrency(product.commissionAmount)}
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Recipient
                      </th>
                      <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Amount
                      </th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Rule
                      </th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Tier
                      </th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {product.breakdown.map((row, idx) => (
                      <tr key={idx}>
                        <td className="px-4 py-2 text-sm text-gray-900">{row.recipientName}</td>
                        <td className="px-4 py-2 text-sm text-right font-medium text-green-700">
                          {formatCurrency(row.amount)}
                        </td>
                        <td className="px-4 py-2 text-sm text-gray-600">{row.ruleName ?? '—'}</td>
                        <td className="px-4 py-2 text-sm text-gray-600">
                          {row.tierLevel != null
                            ? `(${row.tierLevel}) ${dynamicTierName(row.tierLevel)}`
                            : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
};
