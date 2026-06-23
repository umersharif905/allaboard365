import { Loader2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { apiService } from '../../../services/api.service';
import { Member } from '../../../types/member.types';

type AuditRow = {
  enrollmentId: string;
  productId: string;
  productBundleId?: string | null;
  productName?: string | null;
  bundleName?: string | null;
  effectiveDate: string;
  terminationDate?: string | null;
  premiumAmount: number;
  expectedPremiumAmount?: number;
  premiumAmountWrong?: boolean;
  includedPaymentProcessingFeeAmount?: number;
  includedSystemFeeAmount?: number;
  current: { netRate: number; overrideRate: number; commission: number };
  expected: { netRate: number; overrideRate: number; commission: number };
  isWrong?: boolean;
};

type AuditResponse = {
  success: boolean;
  data?: {
    primaryMemberId: string;
    householdId: string;
    scannedCount: number;
    discrepancyCount: number;
    rows?: AuditRow[];
    discrepancies: AuditRow[];
    feeSummary?: {
      currentSystemFeeAmount: number;
      currentPaymentProcessingFeeAmount: number;
      systemFeeEnrollmentId?: string | null;
      paymentProcessingFeeEnrollmentId?: string | null;
    };
    expectedFees?: {
      expectedSystemFeeAmount: number;
      expectedPaymentProcessingFeeAmount: number;
      expectedIncludedProcessingFeeTotal: number;
    } | null;
    feeDiscrepancy?: boolean;
    /** True when expected SystemFee/PaymentProcessingFee enrollment rows are missing but amounts should be > 0 */
    feeEnrollmentsMissing?: boolean;
  };
  message?: string;
};

function formatCurrency(amount: number) {
  const n = Number(amount || 0);
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

interface Props {
  member: Member;
  onClose: () => void;
  onApplied: () => Promise<void> | void;
}

export default function EnrollmentAuditModal({ member, onClose, onApplied }: Props) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [audit, setAudit] = useState<AuditResponse['data'] | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applyResult, setApplyResult] = useState<{ updated: number } | null>(null);
  const [applyingFees, setApplyingFees] = useState(false);
  const [applyFeesResult, setApplyFeesResult] = useState<{
    updated: number;
    created?: number;
    createdFeeTypes?: string[];
    updatedFeeTypes?: string[];
    message?: string;
  } | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    setApplyError(null);
    setApplyResult(null);
    setApplyFeesResult(null);
    try {
      const r = await apiService.post('/api/me/tenant-admin/enrollment-audit/dry-run', { memberId: member.MemberId }) as AuditResponse;
      if (!r.success) throw new Error(r.message || 'Audit failed');
      setAudit(r.data || null);
    } catch (e: any) {
      setError(e.message || 'Audit failed');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [member.MemberId]);

  const apply = async () => {
    setApplying(true);
    setApplyError(null);
    setApplyResult(null);
    try {
      const r = await apiService.post('/api/me/tenant-admin/enrollment-audit/apply', { memberId: member.MemberId }) as any;
      if (!r.success) throw new Error(r.message || 'Apply failed');
      setApplyResult({ updated: r.data?.applied?.updated || 0 });
      await onApplied();
      await load();
    } catch (e: any) {
      setApplyError(e.message || 'Apply failed');
    } finally {
      setApplying(false);
    }
  };

  const applyProcessingFees = async () => {
    setApplyingFees(true);
    setApplyError(null);
    setApplyFeesResult(null);
    try {
      const r = await apiService.post('/api/me/tenant-admin/enrollment-audit/apply-processing-fees', { memberId: member.MemberId }) as any;
      if (!r.success) throw new Error(r.message || 'Apply processing fees failed');
      setApplyFeesResult({ updated: r.data?.applied?.updated || 0, updatedFeeTypes: r.data?.updatedFeeTypes });
      await onApplied();
      await load();
    } catch (e: any) {
      setApplyError(e.message || 'Apply processing fees failed');
    } finally {
      setApplyingFees(false);
    }
  };

  const rows = audit?.rows || [];
  const discrepancies = audit?.discrepancies || [];

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-lg border border-gray-200 shadow-xl w-full max-w-6xl max-h-[95vh] overflow-hidden flex flex-col">
        <div className="p-6 border-b border-gray-200 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-2xl font-semibold text-gray-900 mb-1">Audit enrollment pricing snapshots</h2>
            <p className="text-gray-600 truncate">
              {member.FirstName} {member.LastName} • {member.Email}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-100 transition-colors"
            aria-label="Close"
          >
            <X className="h-6 w-6" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {loading && (
            <div className="flex items-center gap-2 text-gray-600 text-sm">
              <Loader2 className="h-4 w-4 animate-spin" />
              Auditing…
            </div>
          )}
          {error && (
            <div className="bg-red-50 border border-red-200 text-red-800 rounded-lg p-4 text-sm">
              {error}
            </div>
          )}

          {!loading && !error && audit && (
            <>
              <div className="bg-white rounded-lg border border-gray-200 p-4">
                <div className="text-sm text-gray-700">
                  Scanned <span className="font-medium text-gray-900">{audit.scannedCount}</span> primary product enrollment(s) (active or future effective).
                </div>
                <div className="text-sm text-gray-700 mt-1">
                  Discrepancies: <span className="font-medium text-gray-900">{audit.discrepancyCount}</span>
                </div>
              </div>

              {applyError && (
                <div className="bg-red-50 border border-red-200 text-red-800 rounded-lg p-4 text-sm">
                  {applyError}
                </div>
              )}
              {applyResult && (
                <div className="bg-green-50 border border-green-200 text-green-800 rounded-lg p-4 text-sm">
                  Updated {applyResult.updated} enrollment(s).
                </div>
              )}
              {applyFeesResult && ((applyFeesResult.updated ?? 0) > 0 || (applyFeesResult.created ?? 0) > 0 || applyFeesResult.message) && (
                <div className="bg-green-50 border border-green-200 text-green-800 rounded-lg p-4 text-sm">
                  {applyFeesResult.message ? (
                    <span>{applyFeesResult.message}</span>
                  ) : (
                    <>
                      {(applyFeesResult.created ?? 0) > 0 && (
                        <span>
                          Created: {applyFeesResult.createdFeeTypes?.join(', ') || `${applyFeesResult.created} row(s)`}.
                          {(applyFeesResult.updated ?? 0) > 0 ? ' ' : ''}
                        </span>
                      )}
                      {(applyFeesResult.updated ?? 0) > 0 && (
                        <span>Updated amounts: {applyFeesResult.updatedFeeTypes?.join(', ') || applyFeesResult.updated}.</span>
                      )}
                    </>
                  )}
                </div>
              )}

              {audit.expectedFees != null && (
                <div className="bg-white rounded-lg border border-gray-200 p-4">
                  <h3 className="text-lg font-medium text-gray-900 mb-2">Household fees (recalculated)</h3>
                  {audit.feeEnrollmentsMissing && (
                    <div className="mb-3 rounded-lg border border-amber-400 bg-amber-50 px-3 py-3 text-sm text-amber-900 space-y-3">
                      <p>
                        <span className="font-semibold">Missing fee enrollments.</span>{' '}
                        Expected SystemFee and/or PaymentProcessingFee rows are not in{' '}
                        <code className="text-xs bg-amber-100 px-1 rounded">oe.Enrollments</code> for the primary member. Create them
                        using the button below (same amounts as the recalculated expected fees).
                      </p>
                      <button
                        type="button"
                        onClick={applyProcessingFees}
                        disabled={loading || applyingFees}
                        className="inline-flex px-4 py-2 rounded-lg text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50"
                      >
                        {applyingFees ? 'Working…' : 'Create missing fee enrollments'}
                      </button>
                    </div>
                  )}
                  <p className="text-sm text-gray-600 mb-3">
                    Compares current SystemFee and PaymentProcessingFee enrollment amounts to expected amounts from current product premiums and tenant settings (group members use the group&apos;s default payment method for processing fee).
                  </p>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                    <div>
                      <div className="font-medium text-gray-700 mb-1">System fee</div>
                      <div className="text-gray-900">
                        Current: {formatCurrency(audit.feeSummary?.currentSystemFeeAmount ?? 0)}
                        {audit.expectedFees && (
                          <> → Expected: {formatCurrency(audit.expectedFees.expectedSystemFeeAmount)}</>
                        )}
                      </div>
                    </div>
                    <div>
                      <div className="font-medium text-gray-700 mb-1">Payment processing fee</div>
                      <div className="text-gray-900">
                        Current: {formatCurrency(audit.feeSummary?.currentPaymentProcessingFeeAmount ?? 0)}
                        {audit.expectedFees && (
                          <> → Expected: {formatCurrency(audit.expectedFees.expectedPaymentProcessingFeeAmount)}</>
                        )}
                      </div>
                    </div>
                  </div>
                  {audit.feeDiscrepancy && !audit.feeEnrollmentsMissing && (
                    <div className="mt-3 flex flex-wrap items-center gap-3">
                      <span className="text-amber-700 text-sm font-medium">Amounts differ from expected.</span>
                      <button
                        type="button"
                        onClick={applyProcessingFees}
                        disabled={loading || applyingFees}
                        className="inline-flex px-4 py-2 rounded-lg text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50"
                      >
                        {applyingFees ? 'Applying…' : 'Update fee amounts'}
                      </button>
                    </div>
                  )}
                  {audit.expectedFees && !audit.feeDiscrepancy && !audit.feeEnrollmentsMissing && (
                    <p className="mt-2 text-sm text-green-700">Fee amounts are accurate.</p>
                  )}
                </div>
              )}

              <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
                <div className="p-6 border-b border-gray-200">
                  <h3 className="text-lg font-medium text-gray-900">Audit results</h3>
                  <p className="text-sm text-gray-600">
                    Compares `oe.Enrollments` NetRate/OverrideRate/Commission and PremiumAmount to values from `oe.ProductPricing` (PremiumAmount should equal NetRate + OverrideRate + Commission). Apply fixes updates all four fields.
                  </p>
                </div>
                <div className="p-6 overflow-auto">
                  <table className="min-w-[1200px] divide-y divide-gray-200 text-xs">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium text-gray-500 uppercase tracking-wide">Status</th>
                        <th className="px-3 py-2 text-left font-medium text-gray-500 uppercase tracking-wide">EnrollmentId</th>
                        <th className="px-3 py-2 text-left font-medium text-gray-500 uppercase tracking-wide">Product</th>
                        <th className="px-3 py-2 text-left font-medium text-gray-500 uppercase tracking-wide">Effective</th>
                        <th className="px-3 py-2 text-right font-medium text-gray-500 uppercase tracking-wide">Premium</th>
                        <th className="px-3 py-2 text-right font-medium text-gray-500 uppercase tracking-wide">Expected premium</th>
                        <th className="px-3 py-2 text-right font-medium text-gray-500 uppercase tracking-wide">Incl. process fee</th>
                        <th className="px-3 py-2 text-right font-medium text-gray-500 uppercase tracking-wide">System fee</th>
                        <th className="px-3 py-2 text-right font-medium text-gray-500 uppercase tracking-wide">NetRate</th>
                        <th className="px-3 py-2 text-right font-medium text-gray-500 uppercase tracking-wide">OverrideRate</th>
                        <th className="px-3 py-2 text-right font-medium text-gray-500 uppercase tracking-wide">Commission</th>
                        <th className="px-3 py-2 text-right font-medium text-gray-500 uppercase tracking-wide">Expected NetRate</th>
                        <th className="px-3 py-2 text-right font-medium text-gray-500 uppercase tracking-wide">Expected OverrideRate</th>
                        <th className="px-3 py-2 text-right font-medium text-gray-500 uppercase tracking-wide">Expected Commission</th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                      {rows.map((d) => (
                        <tr
                          key={d.enrollmentId}
                          className={d.isWrong ? 'bg-red-50' : 'bg-green-50'}
                        >
                          <td className={`px-3 py-2 font-medium ${d.isWrong ? 'text-red-700' : 'text-green-700'}`}>
                            {d.isWrong ? 'Mismatch' : 'Accurate'}
                          </td>
                          <td className="px-3 py-2 font-mono break-all text-gray-900">{d.enrollmentId}</td>
                          <td className="px-3 py-2 text-gray-900">
                            <div className="font-medium">{d.productName || d.productId}</div>
                            {d.bundleName && <div className="text-gray-500">Bundle: {d.bundleName}</div>}
                          </td>
                          <td className="px-3 py-2 font-mono text-gray-900">{d.effectiveDate}</td>
                          <td className={`px-3 py-2 text-right font-mono ${d.premiumAmountWrong ? 'text-red-700 font-medium' : 'text-gray-900'}`}>
                            {formatCurrency(d.premiumAmount)}
                          </td>
                          <td className="px-3 py-2 text-right font-mono text-gray-900">
                            {d.expectedPremiumAmount != null ? formatCurrency(d.expectedPremiumAmount) : '—'}
                          </td>
                          <td className="px-3 py-2 text-right font-mono text-gray-900">{formatCurrency(d.includedPaymentProcessingFeeAmount ?? 0)}</td>
                          <td className="px-3 py-2 text-right font-mono text-gray-900">{formatCurrency(d.includedSystemFeeAmount ?? 0)}</td>
                          <td className="px-3 py-2 text-right font-mono text-gray-900">{formatCurrency(d.current.netRate)}</td>
                          <td className="px-3 py-2 text-right font-mono text-gray-900">{formatCurrency(d.current.overrideRate)}</td>
                          <td className="px-3 py-2 text-right font-mono text-gray-900">{formatCurrency(d.current.commission)}</td>
                          <td className="px-3 py-2 text-right font-mono text-gray-900">{formatCurrency(d.expected.netRate)}</td>
                          <td className="px-3 py-2 text-right font-mono text-gray-900">{formatCurrency(d.expected.overrideRate)}</td>
                          <td className="px-3 py-2 text-right font-mono text-gray-900">{formatCurrency(d.expected.commission)}</td>
                        </tr>
                      ))}
                      {rows.length === 0 && (
                        <tr>
                          <td className="px-3 py-3 text-gray-500" colSpan={14}>No primary enrollments found to audit.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>

        <div className="p-6 border-t border-gray-200 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
          >
            Close
          </button>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={load}
              disabled={loading || applying}
              className="inline-flex items-center px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50"
            >
              Refresh
            </button>
            <button
              type="button"
              onClick={apply}
              disabled={loading || applying || discrepancies.length === 0}
              className="inline-flex items-center px-4 py-2 rounded-lg text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {applying ? 'Applying…' : 'Apply fixes'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

