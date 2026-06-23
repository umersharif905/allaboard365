/**
 * Bulk attempt DIME recurring setup for members on the missing-recurring audit list.
 */
import { AlertCircle, CreditCard, Loader2, X } from 'lucide-react';
import React, { useCallback, useState } from 'react';
import {
  billingService,
  type SetupMissingRecurringResult
} from '../../services/billing.service';

export interface MissingRecurringSetupModalProps {
  open: boolean;
  onClose: () => void;
  currentRole: string;
  tenantId?: string;
  memberIds: string[];
  onComplete?: () => void;
}

function formatOutcomeLabel(outcome: string): string {
  switch (outcome) {
    case 'created':
      return 'Created / updated';
    case 'already_correct':
      return 'Already correct';
    case 'would_sync':
      return 'Would set up';
    case 'would_skip_already_correct':
      return 'Would skip (already correct)';
    case 'skipped_group_billed':
      return 'Skipped (group billed)';
    case 'skipped_no_payment_method':
      return 'Skipped (no card on file)';
    case 'skipped_no_billable_invoice':
      return 'Skipped (no billable invoice)';
    case 'failed':
      return 'Failed';
    default:
      return outcome;
  }
}

export function MissingRecurringSetupModal({
  open,
  onClose,
  currentRole,
  tenantId,
  memberIds,
  onComplete
}: MissingRecurringSetupModalProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SetupMissingRecurringResult | null>(null);

  const run = useCallback(
    async (dryRun: boolean) => {
      if (memberIds.length === 0) return;
      setLoading(true);
      setError(null);
      if (!dryRun) setResult(null);
      try {
        const res = await billingService.setupMissingRecurring(
          currentRole,
          { dryRun, memberIds },
          tenantId
        );
        if (!res.success || !res.data) {
          setError(res.message || 'Request failed');
          return;
        }
        setResult(res.data);
        if (!dryRun) {
          onComplete?.();
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Request failed');
      } finally {
        setLoading(false);
      }
    },
    [currentRole, tenantId, memberIds, onComplete]
  );

  const handleClose = () => {
    if (loading) return;
    setResult(null);
    setError(null);
    onClose();
  };

  if (!open) return null;

  const isPreview = result?.dryRun === true;
  const setupLabel = isPreview ? 'Would set up' : 'Set up';

  const skippedTotal =
    (result?.skipped.group_billed ?? 0) +
    (result?.skipped.no_payment_method ?? 0) +
    (result?.skipped.no_billable_invoice ?? 0);

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="flex min-h-full items-center justify-center p-4">
        <button type="button" className="fixed inset-0 bg-gray-500 bg-opacity-75" aria-label="Close" onClick={handleClose} />
        <div className="relative bg-white rounded-lg shadow-xl max-w-2xl w-full p-6 max-h-[90vh] overflow-y-auto z-10">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h3 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
                <CreditCard className="h-5 w-5 text-gray-600" aria-hidden />
                Set up recurring payments
              </h3>
              <p className="mt-1 text-sm text-gray-600">
                Creates or updates DIME recurring schedules for individual members on the filtered list who have a
                card on file and a billable invoice. Group-billed members are skipped.
              </p>
            </div>
            <button type="button" onClick={handleClose} disabled={loading} className="rounded-lg p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-700 shrink-0 disabled:opacity-50" aria-label="Close">
              <X className="h-5 w-5" />
            </button>
          </div>
          <p className="mt-4 text-sm text-gray-700">
            <strong>{memberIds.length}</strong> member{memberIds.length === 1 ? '' : 's'} on the current filtered list.
          </p>
          {error && (
            <div className="mt-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              <AlertCircle className="h-5 w-5 shrink-0" aria-hidden />
              <span>{error}</span>
            </div>
          )}
          {result && (
            <div className="mt-4 rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm text-gray-800 space-y-2">
              <p className="font-medium text-gray-900">{isPreview ? 'Preview' : 'Results'} — {result.attempted} attempted</p>
              <ul className="list-disc list-inside space-y-1">
                <li>{setupLabel}: <strong>{result.created}</strong></li>
                <li>Already correct: <strong>{result.alreadyCorrect}</strong></li>
                <li>Skipped: <strong>{skippedTotal}</strong>{skippedTotal > 0 && (<span className="text-gray-600"> (group {result.skipped.group_billed}, no card {result.skipped.no_payment_method}, no invoice {result.skipped.no_billable_invoice})</span>)}</li>
                {result.failed.length > 0 && <li className="text-red-700">Failed: <strong>{result.failed.length}</strong></li>}
              </ul>
              {result.details.length > 0 && result.details.length <= 25 && (
                <div className="mt-3 max-h-48 overflow-y-auto border-t border-gray-200 pt-2">
                  <table className="w-full text-xs"><thead><tr className="text-left text-gray-500"><th className="pb-1 pr-2">Member</th><th className="pb-1">Outcome</th></tr></thead><tbody>
                    {result.details.map((row) => (
                      <tr key={row.memberId} className="border-t border-gray-100"><td className="py-1 pr-2 align-top">{row.memberName || row.memberId.slice(0, 8)}</td><td className="py-1 align-top">{row.outcome ? formatOutcomeLabel(row.outcome) : '—'}{row.error ? `: ${row.error}` : ''}</td></tr>
                    ))}
                  </tbody></table>
                </div>
              )}
            </div>
          )}
          <div className="mt-6 flex flex-wrap justify-end gap-2">
            <button type="button" onClick={handleClose} disabled={loading} className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 text-sm disabled:opacity-50">Close</button>
            <button type="button" onClick={() => void run(true)} disabled={loading || memberIds.length === 0} className="px-4 py-2 rounded-lg border border-gray-300 text-gray-800 hover:bg-gray-50 text-sm disabled:opacity-50">{loading ? 'Working…' : 'Preview'}</button>
            <button type="button" onClick={() => void run(false)} disabled={loading || memberIds.length === 0} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 text-sm disabled:opacity-50">{loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}{loading ? 'Setting up…' : 'Set up recurring'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
