import React from 'react';

/** One row in the commission preview returned by
 *  /api/me/agent/products/:productId/commission-preview.  Mirrors the type
 *  used by useAgentProductCommissionPreview without re-importing it (kept
 *  loose so the shared table doesn't drag the hook's import surface around).
 */
export interface CommissionPreviewRowLike {
  levelSortOrder: number;
  label: string;
  isAgentLevel: boolean;
  payoutMode: 'flat' | 'percent';
  flatAmount: number | null;
  percentLabel: string | null;
  familyFlat: Record<string, number> | null;
  familyPercent: Record<string, string | null> | null;
}

interface Props {
  rows: CommissionPreviewRowLike[];
  /** Marks one tier row visually. When unset, falls back to `row.isAgentLevel`
   *  (the existing AgentProducts UX where the viewer's own row pops). */
  highlightLevel?: number | null;
  /** Override the "(you)" pill label. Defaults to 'you'. Used in downline mode. */
  highlightPillLabel?: string;
  /** Tenant-mode viewers don't get the "(you)" pill, even on rows where
   *  `isAgentLevel` is true (it has no meaning for an admin reviewer). */
  viewerTenant: boolean;
  /** Used in the empty-state copy when filtering trims the list to nothing. */
  agentLevelDisplayName?: string;
  /** Override the default empty-state copy (e.g. "No commission for this
   *  level on this product"). */
  emptyMessage?: string;
}

const FAMILY_COVERAGE_TIER_LABELS: Record<string, string> = {
  EE: 'Individual',
  ES: 'Individual + Spouse',
  EC: 'Individual + Child(ren)',
  EF: 'Family'
};

const formatFamilyCoverageTierLabel = (k: string): string =>
  FAMILY_COVERAGE_TIER_LABELS[k] ?? k;

const formatCommissionMoney = (n: number): string =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

/** Card-list renderer for a CommissionPreview's per-tier rows.  Lifted out
 *  of SubscribedProductDetailsModal so the same UI can be reused by the
 *  onboarding-code preview modal without duplicating the JSX. */
export const CommissionTierTable: React.FC<Props> = ({
  rows,
  highlightLevel,
  highlightPillLabel,
  viewerTenant,
  agentLevelDisplayName,
  emptyMessage
}) => {
  if (!rows || rows.length === 0) {
    return (
      <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm text-gray-700">
        {emptyMessage
          || (viewerTenant
            ? 'No Tier commission payout is configured for this product in the selected commission group.'
            : `Your level (${agentLevelDisplayName ?? '—'}) does not have a payout row in this rule. Contact your administrator if this looks wrong.`)}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {rows.map((row, idx) => {
        const isHighlighted =
          highlightLevel != null
            ? row.levelSortOrder === highlightLevel
            : row.isAgentLevel && !viewerTenant;
        return (
          <div
            key={`${row.levelSortOrder}-${idx}`}
            className={`rounded-lg border p-4 ${
              isHighlighted ? 'border-oe-primary bg-oe-light' : 'border-gray-200 bg-white'
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className={`text-sm font-medium ${isHighlighted ? 'text-oe-dark' : 'text-gray-900'}`}>
                {row.label}
                {isHighlighted && row.isAgentLevel && !viewerTenant && (
                  <span className="ml-2 text-xs font-normal text-oe-dark">({highlightPillLabel ?? 'you'})</span>
                )}
              </span>
            </div>
            <div className="mt-2 text-sm text-gray-800">
              {row.payoutMode === 'flat' && (
                <>
                  {row.familyFlat && Object.keys(row.familyFlat).length > 0 ? (
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      {(['EE', 'ES', 'EC', 'EF'] as const).map((k) =>
                        row.familyFlat![k] != null ? (
                          <div key={k} className="rounded border border-gray-100 bg-gray-50 px-2 py-1.5">
                            <div className="text-xs text-gray-500">{formatFamilyCoverageTierLabel(k)}</div>
                            <div className="font-medium">{formatCommissionMoney(row.familyFlat![k])}</div>
                          </div>
                        ) : null
                      )}
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      {(['EE', 'ES', 'EC', 'EF'] as const).map((k) => (
                        <div key={k} className="rounded border border-gray-100 bg-gray-50 px-2 py-1.5">
                          <div className="text-xs text-gray-500">{formatFamilyCoverageTierLabel(k)}</div>
                          <div className="font-medium">
                            {row.flatAmount != null ? formatCommissionMoney(row.flatAmount) : '—'}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
              {row.payoutMode === 'percent' && (
                <>
                  {row.familyPercent && Object.keys(row.familyPercent).length > 0 ? (
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      {(['EE', 'ES', 'EC', 'EF'] as const).map((k) =>
                        row.familyPercent![k] ? (
                          <div key={k} className="rounded border border-gray-100 bg-gray-50 px-2 py-1.5">
                            <div className="text-xs text-gray-500">{formatFamilyCoverageTierLabel(k)}</div>
                            <div className="font-medium">{row.familyPercent![k]}</div>
                          </div>
                        ) : null
                      )}
                    </div>
                  ) : (
                    <span className="font-medium">{row.percentLabel ?? '—'}</span>
                  )}
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default CommissionTierTable;
