// frontend/src/components/accounting/RetryBouncesModal.tsx
import { AlertTriangle, CheckCircle, Loader2, RefreshCcw, X } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import {
  NACHAGeneration,
  RetryPreviewLine,
  nachaService
} from '../../services/nachaService';

interface RetryBouncesModalProps {
  nacha: NACHAGeneration;
  isOpen: boolean;
  onClose: () => void;
  /** Called with the new retry NACHA's id when generation succeeds */
  onSuccess: (newNachaId: string) => void;
}

interface AchOption {
  achAccountId: string;
  accountHolderName: string;
  bankName: string;
  accountNumberLast4?: string;
  accountType: string;
  label: string;
  isDefault: boolean;
  accountSource: string;
  companyIdentification?: string | null;
}

const formatCurrency = (amount: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount || 0);

const formatRoutingDot = (routing: string | null | undefined, last4: string | null | undefined) => {
  const r = (routing || '').trim();
  const l = (last4 || '').trim();
  if (!r && !l) return '—';
  return `${r || 'no routing'} • ${l ? `••••${l}` : 'no account'}`;
};

const RetryBouncesModal: React.FC<RetryBouncesModalProps> = ({
  nacha,
  isOpen,
  onClose,
  onSuccess
}) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lines, setLines] = useState<RetryPreviewLine[]>([]);
  const [tenantId, setTenantId] = useState<string | null>(null);

  // Selection is per-recipient (one row per agent in the table).
  // Submission expands the chosen recipient keys back into all underlying detail ids.
  const [selectedRecipientKeys, setSelectedRecipientKeys] = useState<Set<string>>(new Set());

  const [achOptions, setAchOptions] = useState<AchOption[]>([]);
  const [loadingAch, setLoadingAch] = useState(false);
  const [fundingAchAccountId, setFundingAchAccountId] = useState<string>('');
  const [companyIdentification, setCompanyIdentification] = useState<string>('');

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await nachaService.getRetryPreview(nacha.nachaId);
        if (cancelled) return;
        setLines(res.lines || []);
        setTenantId(res.original?.tenantId || null);
        // No recipients are pre-selected — admin explicitly opts in to who to retry.
        setSelectedRecipientKeys(new Set());
      } catch (e: any) {
        if (!cancelled) setError(e?.message || 'Failed to load retry preview');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, nacha.nachaId]);

  // Load ACH options once we know which tenant + payoutType to look up.
  useEffect(() => {
    if (!isOpen) return;
    if (!tenantId || !nacha.payoutType) return;
    let cancelled = false;
    (async () => {
      setLoadingAch(true);
      try {
        const res = await nachaService.getACHOptions(tenantId, nacha.payoutType as string);
        if (cancelled) return;
        const opts = res.options || [];
        setAchOptions(opts);
        const defaultOpt = opts.find((o) => o.isDefault) || opts[0];
        if (defaultOpt) {
          setFundingAchAccountId(defaultOpt.achAccountId);
          const cid = (defaultOpt.companyIdentification || '').replace(/\D/g, '').slice(0, 10);
          if (cid) setCompanyIdentification(cid);
        }
      } catch (e) {
        if (!cancelled) setAchOptions([]);
      } finally {
        if (!cancelled) setLoadingAch(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, tenantId, nacha.payoutType]);

  // Group every detail line by recipient so the table shows ONE row per agent
  // with their summed total, not one row per individual commission line.
  const recipientGroups = useMemo(() => {
    const map = new Map<
      string,
      {
        key: string;
        recipientEntityType: string;
        recipientEntityId: string;
        recipientName: string;
        totalAmount: number;
        lineCount: number;
        detailIds: string[];
        // Bank info / status are per-recipient (the preview already looks them up
        // per recipient), so safely take the first line's values for display.
        original: RetryPreviewLine['original'];
        current: RetryPreviewLine['current'];
        hasCurrentBankInfo: boolean;
        bankInfoChanged: boolean;
      }
    >();
    for (const line of lines) {
      const key = `${line.recipientEntityType}:${line.recipientEntityId}`;
      const existing = map.get(key);
      if (existing) {
        existing.totalAmount += line.amount || 0;
        existing.lineCount += 1;
        existing.detailIds.push(line.nachaPaymentDetailId);
      } else {
        map.set(key, {
          key,
          recipientEntityType: line.recipientEntityType,
          recipientEntityId: line.recipientEntityId,
          recipientName: line.recipientName,
          totalAmount: line.amount || 0,
          lineCount: 1,
          detailIds: [line.nachaPaymentDetailId],
          original: line.original,
          current: line.current,
          hasCurrentBankInfo: line.hasCurrentBankInfo,
          bankInfoChanged: line.bankInfoChanged
        });
      }
    }
    // Sort: actionable rows (has bank info) first, then by name.
    return Array.from(map.values()).sort((a, b) => {
      if (a.hasCurrentBankInfo !== b.hasCurrentBankInfo) {
        return a.hasCurrentBankInfo ? -1 : 1;
      }
      return a.recipientName.localeCompare(b.recipientName);
    });
  }, [lines]);

  const toggleSelect = (key: string) => {
    setSelectedRecipientKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectAllUpdated = () => {
    setSelectedRecipientKeys(
      new Set(
        recipientGroups
          .filter((g) => g.hasCurrentBankInfo && g.bankInfoChanged)
          .map((g) => g.key)
      )
    );
  };

  const selectAllAvailable = () => {
    setSelectedRecipientKeys(
      new Set(recipientGroups.filter((g) => g.hasCurrentBankInfo).map((g) => g.key))
    );
  };

  const clearSelection = () => setSelectedRecipientKeys(new Set());

  const selectedTotal = useMemo(() => {
    return recipientGroups
      .filter((g) => selectedRecipientKeys.has(g.key))
      .reduce((sum, g) => sum + (g.totalAmount || 0), 0);
  }, [recipientGroups, selectedRecipientKeys]);

  const updatedCount = useMemo(
    () => recipientGroups.filter((g) => g.hasCurrentBankInfo && g.bankInfoChanged).length,
    [recipientGroups]
  );

  const canSubmit =
    !submitting &&
    selectedRecipientKeys.size > 0 &&
    !!fundingAchAccountId &&
    /^\d{9}$|^\d{10}$/.test((companyIdentification || '').replace(/\D/g, ''));

  const handleSubmit = async () => {
    setSubmitError(null);
    if (selectedRecipientKeys.size === 0) {
      setSubmitError('Select at least one recipient to retry.');
      return;
    }
    if (!fundingAchAccountId) {
      setSubmitError('Please pick a funding account.');
      return;
    }
    const cid = (companyIdentification || '').replace(/\D/g, '');
    if (!/^\d{9}$|^\d{10}$/.test(cid)) {
      setSubmitError('Company Identification must be a 9 or 10 digit number.');
      return;
    }

    const selectedGroups = recipientGroups.filter((g) => selectedRecipientKeys.has(g.key));

    // Block selection of "Missing" rows defensively (UI already disables them).
    const missing = selectedGroups.filter((g) => !g.hasCurrentBankInfo);
    if (missing.length > 0) {
      setSubmitError(
        `Cannot retry ${missing.length} recipient(s) without active bank info on file. ` +
        `Have them update banking, then try again.`
      );
      return;
    }

    // Expand recipient selections back to the full set of underlying detail ids.
    const paymentDetailIds = selectedGroups.flatMap((g) => g.detailIds);

    setSubmitting(true);
    try {
      const result = await nachaService.retryBounces(nacha.nachaId, {
        paymentDetailIds,
        fundingAchAccountId,
        companyIdentification: cid
      });
      onSuccess(result.nachaId);
      onClose();
    } catch (e: any) {
      setSubmitError(e?.message || 'Failed to generate retry NACHA');
    } finally {
      setSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[95]">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-5xl mx-4 max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <div className="flex items-center gap-3">
            <RefreshCcw className="h-6 w-6 text-oe-primary" />
            <div>
              <h3 className="text-lg font-semibold text-gray-900">Retry Bounces</h3>
              <p className="text-sm text-gray-600 mt-1">
                Generate a new NACHA file with the selected payouts from{' '}
                <span className="font-medium text-gray-900">{nacha.fileName}</span>{' '}
                using each recipient's <span className="font-medium">current</span> banking info.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors"
          >
            <X className="h-6 w-6" />
          </button>
        </div>

        <div className="p-6 overflow-y-auto flex-1">
          {/* Banner */}
          <div className="bg-blue-50 border border-blue-200 rounded-md p-4 mb-4 text-sm text-blue-900">
            <p className="font-medium mb-1">How this works</p>
            <ul className="list-disc pl-5 space-y-1 text-blue-900">
              <li>The original NACHA file is unchanged. Commissions stay marked as paid.</li>
              <li>This retry file is a new payment instrument; it won't double-count anywhere.</li>
              <li>Each recipient is re-paid using whatever banking info they currently have on file.</li>
            </ul>
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-md p-4 mb-4">
              <p className="text-sm text-red-700">{error}</p>
            </div>
          )}

          {loading ? (
            <div className="text-center py-12">
              <Loader2 className="animate-spin h-8 w-8 text-oe-primary mx-auto mb-4" />
              <p className="text-gray-600">Loading recipients...</p>
            </div>
          ) : recipientGroups.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-gray-600">No recipients found on this NACHA file.</p>
            </div>
          ) : (
            <>
              {/* Funding ACH + Company ID — top of modal so admin picks paying account first */}
              <div className="mb-4 p-4 bg-blue-50 border border-blue-200 rounded-md">
                <label className="block text-sm font-medium text-blue-900 mb-2">Paying From</label>
                {loadingAch ? (
                  <div className="text-sm text-gray-600">Loading ACH options…</div>
                ) : achOptions.length === 0 ? (
                  <div className="text-sm text-yellow-800 bg-yellow-50 border border-yellow-300 rounded p-2">
                    No funding ACH accounts available for this tenant.
                  </div>
                ) : (
                  <select
                    value={fundingAchAccountId}
                    onChange={(e) => {
                      const id = e.target.value;
                      setFundingAchAccountId(id);
                      const opt = achOptions.find((o) => o.achAccountId === id);
                      const cid = (opt?.companyIdentification || '').replace(/\D/g, '').slice(0, 10);
                      if (cid) setCompanyIdentification(cid);
                    }}
                    className="w-full px-3 py-2 text-sm border border-blue-300 rounded-lg bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  >
                    {achOptions.map((opt) => (
                      <option key={opt.achAccountId} value={opt.achAccountId}>
                        {opt.label} - {opt.accountHolderName}
                        {opt.bankName && ` • ${opt.bankName}`}
                        {opt.accountNumberLast4 && ` • ****${opt.accountNumberLast4}`}
                      </option>
                    ))}
                  </select>
                )}

                <div className="mt-4">
                  <label className="block text-sm font-medium text-blue-900 mb-1">
                    Company Identification (EIN 9 digits or 10)
                  </label>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={companyIdentification}
                    onChange={(e) =>
                      setCompanyIdentification(e.target.value.replace(/\D/g, '').slice(0, 10))
                    }
                    placeholder="e.g. 123456789 or 1234567890"
                    className="w-full px-3 py-2 text-sm border border-blue-300 rounded-lg bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
              </div>

              {/* Bulk actions + selection summary */}
              <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={selectAllUpdated}
                    className="px-3 py-1.5 text-sm border border-green-300 text-green-800 bg-green-50 rounded-md hover:bg-green-100"
                    disabled={updatedCount === 0}
                    title="Select recipients whose banking info has changed since the original NACHA"
                  >
                    Select all with updated bank info ({updatedCount})
                  </button>
                  <button
                    type="button"
                    onClick={selectAllAvailable}
                    className="px-3 py-1.5 text-sm border border-gray-300 text-gray-700 bg-white rounded-md hover:bg-gray-50"
                  >
                    Select all with bank info on file
                  </button>
                  <button
                    type="button"
                    onClick={clearSelection}
                    className="px-3 py-1.5 text-sm border border-gray-300 text-gray-700 bg-white rounded-md hover:bg-gray-50"
                  >
                    Clear
                  </button>
                </div>
                <div className="text-sm text-gray-700">
                  <span className="font-medium">{selectedRecipientKeys.size}</span> recipient
                  {selectedRecipientKeys.size === 1 ? '' : 's'} selected •{' '}
                  <span className="font-medium">{formatCurrency(selectedTotal)}</span>
                </div>
              </div>

              {/* Recipients table — one row per agent, summed across all their commissions */}
              <div className="overflow-x-auto border border-gray-200 rounded-lg">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-8"></th>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Recipient</th>
                      <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Total Amount</th>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Original Bank</th>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Current Bank</th>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {recipientGroups.map((group) => {
                      const checked = selectedRecipientKeys.has(group.key);
                      const disabled = !group.hasCurrentBankInfo;

                      let statusBadge: React.ReactNode = null;
                      if (!group.hasCurrentBankInfo) {
                        statusBadge = (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-800">
                            <AlertTriangle size={12} /> Missing
                          </span>
                        );
                      } else if (group.bankInfoChanged) {
                        statusBadge = (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-green-100 text-green-800">
                            <CheckCircle size={12} /> Updated
                          </span>
                        );
                      } else {
                        statusBadge = (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-yellow-100 text-yellow-800">
                            Unchanged
                          </span>
                        );
                      }

                      return (
                        <tr
                          key={group.key}
                          className={disabled ? 'bg-gray-50 opacity-70' : 'hover:bg-gray-50'}
                        >
                          <td className="px-3 py-2">
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={disabled}
                              onChange={() => toggleSelect(group.key)}
                            />
                          </td>
                          <td className="px-3 py-2 text-sm text-gray-900">
                            <div className="font-medium">{group.recipientName}</div>
                            <div className="text-xs text-gray-500">
                              {group.recipientEntityType}
                              {group.lineCount > 1
                                ? ` • ${group.lineCount} commission lines`
                                : ''}
                            </div>
                          </td>
                          <td className="px-3 py-2 text-sm text-right font-medium text-gray-900 whitespace-nowrap">
                            {formatCurrency(group.totalAmount)}
                          </td>
                          <td className="px-3 py-2 text-xs text-gray-700 font-mono whitespace-nowrap">
                            {formatRoutingDot(
                              group.original?.routingNumber,
                              group.original?.accountNumberLast4
                            )}
                          </td>
                          <td className="px-3 py-2 text-xs text-gray-700 font-mono whitespace-nowrap">
                            {group.current
                              ? formatRoutingDot(
                                  group.current.routingNumber,
                                  group.current.accountNumberLast4
                                )
                              : '—'}
                          </td>
                          <td className="px-3 py-2 text-sm">{statusBadge}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {submitError && (
                <div className="mt-4 bg-red-50 border border-red-200 rounded-md p-4">
                  <p className="text-sm text-red-700">{submitError}</p>
                </div>
              )}
            </>
          )}
        </div>

        <div className="border-t border-gray-200 p-4 bg-gray-50 flex items-center justify-between">
          <div className="text-sm text-gray-600">
            {selectedRecipientKeys.size > 0 ? (
              <>
                Will generate a new NACHA file paying{' '}
                <span className="font-medium">{selectedRecipientKeys.size}</span> recipient
                {selectedRecipientKeys.size === 1 ? '' : 's'},{' '}
                <span className="font-medium">{formatCurrency(selectedTotal)}</span> total.
              </>
            ) : (
              <>Select at least one recipient to enable retry.</>
            )}
          </div>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={!canSubmit}
              className="px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-primary-dark disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {submitting ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  Generating…
                </>
              ) : (
                <>
                  <RefreshCcw size={16} />
                  Generate Retry NACHA
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default RetryBouncesModal;
