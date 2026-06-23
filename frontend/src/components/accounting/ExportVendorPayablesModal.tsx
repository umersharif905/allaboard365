// frontend/src/components/accounting/ExportVendorPayablesModal.tsx
import { AlertTriangle, Download, Loader2, User, X } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { apiService } from '../../services/api.service';
import {
  nachaService,
  PayablesAllocationWarning,
  PayablesDiscrepancy,
  PayablesReconciliationSummary
} from '../../services/nachaService';
import MemberManagementModal from '../../pages/members/MemberManagementModal';
import { Member } from '../../types/member.types';

const RECONCILIATION_TOLERANCE = 0.01;

/** True when paid member-line total vs net ACH is off beyond clawbacks / explained exclusions. */
const payablesMismatchBeyondClawbacks = (
  paidTotal: number,
  nachaNet: number,
  clawbacksApplied: number,
  reconciliation?: PayablesReconciliationSummary | null
): boolean => {
  if (reconciliation?.reconciledWithClawbacks) return false;
  const unexplained =
    reconciliation?.unexplainedGap ??
    Math.round((paidTotal - nachaNet - clawbacksApplied) * 100) / 100;
  return Math.abs(unexplained) > RECONCILIATION_TOLERANCE;
};

interface VendorPayablesInfo {
  vendorId: string;
  vendorName: string;
  hasCustomFormat: boolean;
}

interface PendingExport {
  vendorId: string;
  vendorName: string;
  csv: string;
  total: number;
  contractTotal?: number;
  paidTotal?: number;
  nachaPayout: number;
  paidThroughStart?: string;
  paidThroughEnd?: string;
  nachaSentDate?: string;
  nachaGeneratedDate?: string;
  clawbacksTotalApplied?: number;
  clawbacksRowCount?: number;
  netTotal?: number;
  reconciliation?: PayablesReconciliationSummary | null;
  allocationWarnings?: PayablesAllocationWarning[];
}

interface VendorMismatchSummary {
  vendorId: string;
  vendorName: string;
  total: number;
  nachaPayout: number;
  difference: number;
  discrepancies: PayablesDiscrepancy[];
  discrepanciesError?: string | null;
  discrepanciesLoading?: boolean;
}

interface EnrollmentRow {
  EnrollmentId: string;
  ProductName: string;
  ProductType: string;
  Status: string;
  EffectiveDate: string;
  TerminationDate?: string;
  Premium: number;
  PaymentFrequency: string;
}

interface ExportVendorPayablesModalProps {
  nachaId: string;
  isOpen: boolean;
  onClose: () => void;
}

const formatMoney = (amount: number | null | undefined): string => {
  if (amount === null || amount === undefined || isNaN(amount)) return '$0.00';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(amount);
};

const formatDateShort = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  } catch {
    return '—';
  }
};

const formatDateTime = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return `${d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })} ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
  } catch {
    return '—';
  }
};

const getStatusColor = (status: string) => {
  switch (status) {
    case 'Active': return 'bg-green-100 text-green-800';
    case 'Inactive': return 'bg-gray-100 text-gray-800';
    case 'Pending': return 'bg-yellow-100 text-yellow-800';
    case 'Terminated': return 'bg-red-100 text-red-800';
    case 'Suspended': return 'bg-orange-100 text-orange-800';
    default: return 'bg-gray-100 text-gray-800';
  }
};

const getRelationshipIcon = (relationshipType?: string) => {
  const color =
    relationshipType === 'P'
      ? 'text-blue-600'
      : relationshipType === 'S'
        ? 'text-pink-500'
        : relationshipType === 'C'
          ? 'text-green-600'
          : 'text-gray-500';
  return <User className={`h-4 w-4 ${color}`} />;
};

const getRelationshipColor = (relationshipType?: string) => {
  switch (relationshipType) {
    case 'P': return 'bg-blue-100 text-blue-800';
    case 'S': return 'bg-pink-100 text-pink-800';
    case 'C': return 'bg-green-100 text-green-800';
    default: return 'bg-gray-100 text-gray-800';
  }
};

const ExportVendorPayablesModal: React.FC<ExportVendorPayablesModalProps> = ({
  nachaId,
  isOpen,
  onClose
}) => {
  const [vendors, setVendors] = useState<VendorPayablesInfo[]>([]);
  const [selectedVendorIds, setSelectedVendorIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingExports, setPendingExports] = useState<PendingExport[] | null>(null);
  const [mismatchSummaries, setMismatchSummaries] = useState<VendorMismatchSummary[]>([]);
  /** When set, show per-file download buttons (browsers often block back-to-back downloads). */
  const [downloadBundles, setDownloadBundles] = useState<PendingExport[] | null>(null);

  // Member drill-down state (opens MemberManagementModal on primary-member click)
  const [memberModalMember, setMemberModalMember] = useState<Member | null>(null);
  const [memberModalHousehold, setMemberModalHousehold] = useState<Member[]>([]);
  const [memberModalEnrollments, setMemberModalEnrollments] = useState<EnrollmentRow[]>([]);
  const [memberModalLoading, setMemberModalLoading] = useState(false);

  useEffect(() => {
    if (isOpen && nachaId) {
      fetchVendors();
      setDownloadBundles(null);
    }
  }, [isOpen, nachaId]);

  const fetchVendors = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await nachaService.getVendorPayablesInfo(nachaId);
      if (response.success && response.vendors) {
        setVendors(response.vendors);
        setSelectedVendorIds(new Set(response.vendors.map((v) => v.vendorId)));
      } else {
        setVendors([]);
        setSelectedVendorIds(new Set());
      }
    } catch (err: any) {
      setError(err.message || 'Failed to load vendors');
      setVendors([]);
    } finally {
      setLoading(false);
    }
  };

  const toggleVendor = (vendorId: string) => {
    setSelectedVendorIds((prev) => {
      const next = new Set(prev);
      if (next.has(vendorId)) {
        next.delete(vendorId);
      } else {
        next.add(vendorId);
      }
      return next;
    });
  };

  /** Browser download name only — matches NACHA SentDate, else GeneratedDate (YYYYMMDD, no paid-through range). */
  const buildPayablesFilename = (vendorName: string, nachaSentDate?: string, nachaGeneratedDate?: string) => {
    const safeName = vendorName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const ymd = (nachaSentDate || '').trim() || (nachaGeneratedDate || '').trim();
    const tail = ymd ? ymd.replace(/-/g, '') : 'unknown';
    return `${safeName}_payables_${tail}.csv`;
  };

  const triggerBrowserDownload = (csv: string, filename: string) => {
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadPayablesCsv = (p: PendingExport) => {
    triggerBrowserDownload(
      p.csv,
      buildPayablesFilename(p.vendorName, p.nachaSentDate, p.nachaGeneratedDate)
    );
  };

  const needsManualDownloadStep = (exports: PendingExport[]) => exports.length > 1;

  const finishExports = (exports: PendingExport[]) => {
    if (needsManualDownloadStep(exports)) {
      setDownloadBundles(exports);
      setPendingExports(null);
      setMismatchSummaries([]);
      return;
    }
    downloadPayablesCsv(exports[0]);
    onClose();
  };

  const downloadAllBundlesSequential = async (bundles: PendingExport[]) => {
    for (let i = 0; i < bundles.length; i++) {
      downloadPayablesCsv(bundles[i]);
      if (i < bundles.length - 1) {
        await new Promise((r) => setTimeout(r, 400));
      }
    }
  };

  const loadDiscrepanciesForVendor = async (summary: VendorMismatchSummary) => {
    setMismatchSummaries((prev) =>
      prev.map((s) => (s.vendorId === summary.vendorId ? { ...s, discrepanciesLoading: true, discrepanciesError: null } : s))
    );
    try {
      const response = await nachaService.getVendorPayablesDiscrepancies(nachaId, summary.vendorId);
      const discrepancies = response.success && Array.isArray(response.discrepancies) ? response.discrepancies : [];
      setMismatchSummaries((prev) =>
        prev.map((s) => (s.vendorId === summary.vendorId
          ? { ...s, discrepancies, discrepanciesLoading: false, discrepanciesError: null }
          : s))
      );
    } catch (err: any) {
      setMismatchSummaries((prev) =>
        prev.map((s) => (s.vendorId === summary.vendorId
          ? { ...s, discrepanciesLoading: false, discrepanciesError: err?.message || 'Failed to load discrepancies' }
          : s))
      );
    }
  };

  const handleExportSelected = async () => {
    if (selectedVendorIds.size === 0) return;
    setExporting(true);
    setError(null);
    const exports: PendingExport[] = [];
    const mismatches: VendorMismatchSummary[] = [];

    try {
      for (const vendorId of selectedVendorIds) {
        const vendor = vendors.find((v) => v.vendorId === vendorId);
        const vendorName = vendor?.vendorName || 'Unknown';
        const response = await nachaService.exportVendorPayables(nachaId, vendorId);
        if (!response.success || !response.csv) {
          setError(`Failed to export payables for ${vendorName}`);
          setExporting(false);
          return;
        }
        const total = response.total ?? 0;
        const contractTotal = response.contractTotal ?? response.reconciliation?.contractTotal ?? total;
        const paidTotal =
          response.paidTotal ??
          response.reconciliation?.paidTotal ??
          total;
        const nachaPayout = response.nachaPayout ?? 0;
        const clawbacksApplied =
          response.clawbacks?.totalApplied ?? response.reconciliation?.clawbacksApplied ?? 0;
        const mismatch = payablesMismatchBeyondClawbacks(
          paidTotal,
          nachaPayout,
          clawbacksApplied,
          response.reconciliation ?? null
        );
        exports.push({
          vendorId,
          vendorName,
          csv: response.csv,
          total,
          contractTotal,
          paidTotal,
          nachaPayout,
          paidThroughStart: response.paidThroughStart,
          paidThroughEnd: response.paidThroughEnd,
          nachaSentDate: response.nachaSentDate,
          nachaGeneratedDate: response.nachaGeneratedDate,
          clawbacksTotalApplied: response.clawbacks?.totalApplied,
          clawbacksRowCount: response.clawbacks?.rowCount,
          netTotal: response.netTotal ?? response.nachaPayout,
          allocationWarnings: response.allocationWarnings ?? [],
          reconciliation: response.reconciliation ?? null
        });
        if (mismatch) {
          mismatches.push({
            vendorId,
            vendorName,
            total,
            nachaPayout,
            difference: nachaPayout - total,
            discrepancies: [],
            discrepanciesLoading: true,
            discrepanciesError: null
          });
        }
      }

      const hasAllocationWarnings = exports.some((e) => (e.allocationWarnings?.length ?? 0) > 0);

      if (mismatches.length > 0 || hasAllocationWarnings) {
        setPendingExports(exports);
        setMismatchSummaries(mismatches);
        mismatches.forEach((m) => loadDiscrepanciesForVendor(m));
      } else {
        finishExports(exports);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to export payables');
    } finally {
      setExporting(false);
    }
  };

  const handleConfirmExportAnyway = () => {
    if (!pendingExports) return;
    finishExports(pendingExports);
  };

  const handleCancelWarning = () => {
    setPendingExports(null);
    setMismatchSummaries([]);
  };

  const openMemberModal = async (memberId: string) => {
    if (!memberId) return;
    setMemberModalLoading(true);
    setMemberModalMember(null);
    setMemberModalHousehold([]);
    setMemberModalEnrollments([]);
    try {
      const [householdRes, enrollmentsRes] = await Promise.all([
        apiService.get<{ success: boolean; data: { member: Member; householdMembers: Member[] } }>(
          `/api/members/${memberId}/with-household`
        ),
        apiService.get<{ success: boolean; data: any[] }>(`/api/enrollments?memberId=${memberId}`)
      ]);

      if (householdRes.success && householdRes.data) {
        setMemberModalMember(householdRes.data.member);
        setMemberModalHousehold(householdRes.data.householdMembers || []);
      }
      if (enrollmentsRes.success && enrollmentsRes.data) {
        setMemberModalEnrollments(
          (enrollmentsRes.data as any[]).map((e: any) => ({
            EnrollmentId: e.EnrollmentId,
            ProductName: e.ProductName ?? '',
            ProductType: e.ProductType ?? '',
            Status: e.Status ?? '',
            EffectiveDate: e.EffectiveDate ?? '',
            TerminationDate: e.TerminationDate,
            Premium: e.Premium ?? e.PremiumAmount ?? 0,
            PaymentFrequency: e.PaymentFrequency ?? 'Monthly'
          }))
        );
      }
    } catch (err) {
      console.error('Failed to load member for modal', err);
    } finally {
      setMemberModalLoading(false);
    }
  };

  const closeMemberModal = () => {
    setMemberModalMember(null);
    setMemberModalHousehold([]);
    setMemberModalEnrollments([]);
  };

  if (!isOpen) return null;

  const reconciliationOpen =
    !!pendingExports &&
    (mismatchSummaries.length > 0 ||
      (pendingExports.some((e) => (e.allocationWarnings?.length ?? 0) > 0) ?? false));
  const hasPayablesMismatch = mismatchSummaries.length > 0;
  const vendorsWithAllocationWarnings =
    pendingExports?.filter((e) => (e.allocationWarnings?.length ?? 0) > 0) ?? [];
  const vendorsWithClawbacksOnlyReconciled =
    pendingExports?.filter((e) => {
      const claw = e.clawbacksTotalApplied ?? e.reconciliation?.clawbacksApplied ?? 0;
      if (claw <= RECONCILIATION_TOLERANCE) return false;
      return !payablesMismatchBeyondClawbacks(
        e.total,
        e.nachaPayout,
        claw,
        e.reconciliation ?? null
      );
    }) ?? [];

  return (
    <>
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
        <div className="bg-white rounded-lg shadow-xl w-full max-w-lg">
          <div className="flex items-center justify-between p-6 border-b border-gray-200">
            <h2 className="text-xl font-semibold text-gray-900">Export Vendor Payables</h2>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors">
              <X size={24} />
            </button>
          </div>
          <div className="p-6">
            {error && (
              <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
                {error}
              </div>
            )}
            <p className="text-sm text-gray-600 mb-4">
              Select vendors to export payables CSV. Each vendor gets one file. Clawbacks applied on this NACHA appear as
              negative rows in the same CSV, with a net ACH total at the bottom.
            </p>
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="animate-spin h-8 w-8 text-oe-primary" />
              </div>
            ) : vendors.length === 0 ? (
              <p className="text-gray-500 text-center py-6">No vendors in this NACHA file.</p>
            ) : (
              <div className="space-y-3 max-h-64 overflow-y-auto">
                {vendors.map((v) => (
                  <label
                    key={v.vendorId}
                    className="flex items-center gap-3 p-3 rounded-lg border border-gray-200 hover:bg-gray-50 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={selectedVendorIds.has(v.vendorId)}
                      onChange={() => toggleVendor(v.vendorId)}
                      className="rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
                    />
                    <span className="flex-1 font-medium text-gray-900">{v.vendorName}</span>
                    <span
                      className={`inline-flex px-2 py-0.5 text-xs font-medium rounded-full ${
                        v.hasCustomFormat ? 'bg-oe-light text-oe-dark' : 'bg-gray-100 text-gray-700'
                      }`}
                    >
                      {v.hasCustomFormat ? 'Custom' : 'Default'}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>
          <div className="flex justify-end gap-2 p-6 border-t border-gray-200">
            <button
              onClick={onClose}
              className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              onClick={handleExportSelected}
              disabled={loading || exporting || selectedVendorIds.size === 0}
              className="flex items-center px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-dark disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {exporting ? (
                <Loader2 size={16} className="mr-2 animate-spin" />
              ) : (
                <Download size={16} className="mr-2" />
              )}
              Export selected
            </button>
          </div>
        </div>
      </div>

      {/* Reconciliation warning modal – hidden (but kept mounted) while MemberManagementModal is open so the member modal takes focus */}
      {reconciliationOpen && !memberModalMember && !memberModalLoading && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[60] p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-5xl max-h-[90vh] flex flex-col">
            <div className="flex items-start justify-between p-6 border-b border-gray-200">
              <div className="flex items-start gap-3">
                <AlertTriangle className="h-6 w-6 text-yellow-600 flex-shrink-0 mt-0.5" />
                <div>
                  <h3 className="text-lg font-semibold text-gray-900">
                    {hasPayablesMismatch ? 'Reconciliation Warning' : 'Payables allocation notice'}
                  </h3>
                  <p className="text-sm text-gray-600 mt-1">
                    {hasPayablesMismatch
                      ? mismatchSummaries.length === 1
                        ? `Payables total doesn't match NACHA payout for ${mismatchSummaries[0].vendorName}.`
                        : `Payables totals don't match NACHA payout for ${mismatchSummaries.length} vendors.`
                      : vendorsWithAllocationWarnings.length === 1
                        ? `A few notes to review for ${vendorsWithAllocationWarnings[0].vendorName}. Totals match what was paid.`
                        : `A few notes to review for ${vendorsWithAllocationWarnings.length} vendors. Totals match what was paid.`}
                  </p>
                </div>
              </div>
              <button onClick={handleCancelWarning} className="text-gray-400 hover:text-gray-600 transition-colors">
                <X size={20} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-6">
              {vendorsWithClawbacksOnlyReconciled.map((bundle) => {
                const claw =
                  bundle.clawbacksTotalApplied ?? bundle.reconciliation?.clawbacksApplied ?? 0;
                const gross =
                  bundle.reconciliation?.nachaPayoutGross ?? bundle.total;
                return (
                  <div
                    key={`claw-${bundle.vendorId}`}
                    className="rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-950"
                  >
                    <p className="font-semibold text-blue-900">{bundle.vendorName}</p>
                    <p className="mt-1">
                      Payables CSV totals <strong>{formatMoney(bundle.total)}</strong> (member lines at gross vendor
                      credits). Net ACH on this NACHA is <strong>{formatMoney(bundle.nachaPayout)}</strong> because{' '}
                      <strong>{formatMoney(claw)}</strong> in clawbacks is included as negative row(s) in the payables CSV,
                      with <strong>Net ACH (this NACHA)</strong> at the bottom — not a payables error.
                    </p>
                    <p className="mt-1 text-xs text-blue-800">
                      {formatMoney(gross)} gross − {formatMoney(claw)} clawbacks = {formatMoney(bundle.nachaPayout)} net ACH.
                    </p>
                  </div>
                );
              })}

              {mismatchSummaries.map((summary) => {
                const bundle = pendingExports?.find((e) => e.vendorId === summary.vendorId);
                const recon = bundle?.reconciliation;
                const clawbacksApplied = recon?.clawbacksApplied ?? bundle?.clawbacksTotalApplied ?? 0;
                const paidLineTotal = bundle?.paidTotal ?? recon?.paidTotal ?? summary.total;
                const unexplainedGap =
                  recon?.unexplainedGap ??
                  Math.round((paidLineTotal - summary.nachaPayout - clawbacksApplied) * 100) / 100;
                return (
                <div key={summary.vendorId} className="border border-gray-200 rounded-lg overflow-hidden">
                  <div className="bg-gray-50 p-4 border-b border-gray-200">
                    <div className="flex items-center justify-between flex-wrap gap-2">
                      <div>
                        <h4 className="text-base font-semibold text-gray-900">{summary.vendorName}</h4>
                        {recon ? (
                          <div className="text-sm text-gray-700 mt-2 space-y-1 max-w-2xl">
                            <p>
                              Contract total (enrollment rates): <strong>{formatMoney(recon.contractTotal ?? recon.payablesTotal)}</strong>.
                              Paid total (invoice/NACHA): <strong>{formatMoney(recon.paidTotal ?? recon.payablesTotal)}</strong>.
                              Net ACH sent: <strong>{formatMoney(recon.nachaPayout)}</strong>.
                            </p>
                            {(recon.contractVsPaidVariance ?? 0) !== 0 && (
                              <p className="text-xs text-gray-600">
                                Contract vs paid variance: <strong>{formatMoney(recon.contractVsPaidVariance ?? 0)}</strong>
                                {' '}(negative = vendor underpaid vs contract).
                              </p>
                            )}
                            {clawbacksApplied > 0.01 && (
                              <p className="text-xs text-gray-600">
                                Gross vendor credits{' '}
                                <strong>
                                  {formatMoney(
                                    recon.nachaPayoutGross ?? recon.nachaPayout + clawbacksApplied
                                  )}
                                </strong>
                                ; clawbacks applied <strong>{formatMoney(clawbacksApplied)}</strong>.
                              </p>
                            )}
                            {(recon.notOnPayablesFile ?? 0) > 0.01 && (
                              <p>
                                <strong>{formatMoney(recon.notOnPayablesFile)}</strong> on invoices could not be placed on
                                member payables rows (itemized in the invoice list below) and is already excluded from the
                                unexplained gap — not duplicate people on the file.
                              </p>
                            )}
                            {Math.abs(unexplainedGap) > RECONCILIATION_TOLERANCE && (
                              <p>
                                After clawbacks and itemized exclusions, {formatMoney(Math.abs(unexplainedGap))} still does
                                not match — likely proration or rounding on the invoices below.
                              </p>
                            )}
                            {clawbacksApplied > 0.01 && (
                              <p className="text-xs text-gray-600">
                                Clawbacks ({formatMoney(clawbacksApplied)}) are negative rows in the payables CSV; member
                                lines total {formatMoney(summary.total)} before clawbacks.
                              </p>
                            )}
                          </div>
                        ) : (
                          <p className="text-xs text-gray-500 mt-0.5">
                            Payables CSV totals member-level lines; NACHA is what was sent to the vendor on this file.
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-4 text-sm">
                        <div>
                          <div className="text-xs text-gray-500">Payables (gross)</div>
                          <div className="font-semibold text-gray-900">{formatMoney(summary.total)}</div>
                        </div>
                        <div>
                          <div className="text-xs text-gray-500">ACH sent (net)</div>
                          <div className="font-semibold text-gray-900">{formatMoney(summary.nachaPayout)}</div>
                        </div>
                        {clawbacksApplied > 0.01 && (
                          <div>
                            <div className="text-xs text-gray-500">Clawbacks (in CSV)</div>
                            <div className="font-semibold text-blue-800">−{formatMoney(clawbacksApplied)}</div>
                          </div>
                        )}
                        <div>
                          <div className="text-xs text-gray-500">Unexplained gap</div>
                          <div
                            className={`font-semibold ${
                              Math.abs(unexplainedGap) > RECONCILIATION_TOLERANCE
                                ? 'text-red-600'
                                : 'text-gray-600'
                            }`}
                          >
                            {Math.abs(unexplainedGap) <= RECONCILIATION_TOLERANCE
                              ? '—'
                              : `${unexplainedGap > 0 ? '+' : ''}${formatMoney(unexplainedGap)}`}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {summary.discrepanciesLoading ? (
                    <div className="flex items-center justify-center py-8">
                      <Loader2 className="animate-spin h-6 w-6 text-oe-primary" />
                      <span className="ml-2 text-sm text-gray-500">Investigating…</span>
                    </div>
                  ) : summary.discrepanciesError ? (
                    <div className="p-4 bg-red-50 border-t border-red-200 text-sm text-red-700">
                      {summary.discrepanciesError}
                    </div>
                  ) : summary.discrepancies.length === 0 ? (
                    <div className="p-4 text-sm text-gray-500">
                      No per-member payout discrepancies found. The gap is from invoice product amounts that could not be mapped to member lines.
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="min-w-full divide-y divide-gray-200">
                        <thead className="bg-gray-50">
                          <tr>
                            <th className="px-4 py-2 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">Member</th>
                            <th className="px-4 py-2 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">Product</th>
                            <th className="px-4 py-2 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">Terminated</th>
                            <th className="px-4 py-2 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">Changed</th>
                            <th className="px-4 py-2 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">Reason</th>
                            <th className="px-4 py-2 text-right text-xs font-semibold text-gray-600 uppercase tracking-wider">Amount</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                          {summary.discrepancies.map((d) => (
                            <tr key={d.nachaPaymentDetailId} className="hover:bg-gray-50">
                              <td className="px-4 py-3 whitespace-nowrap">
                                {d.primaryMemberId ? (
                                  <button
                                    type="button"
                                    onClick={() => openMemberModal(d.primaryMemberId!)}
                                    className="text-oe-primary hover:text-oe-dark hover:underline font-medium text-sm"
                                  >
                                    {d.primaryName || d.primaryHouseholdMemberID || 'View member'}
                                  </button>
                                ) : (
                                  <span className="text-sm text-gray-700">{d.primaryName || '—'}</span>
                                )}
                                {d.primaryHouseholdMemberID && (
                                  <div className="text-xs text-gray-500">{d.primaryHouseholdMemberID}</div>
                                )}
                                {d.primaryMemberStatus && (
                                  <span className={`inline-flex px-2 py-0.5 text-xs font-medium rounded-full mt-1 ${getStatusColor(d.primaryMemberStatus)}`}>
                                    {d.primaryMemberStatus}
                                  </span>
                                )}
                              </td>
                              <td className="px-4 py-3 text-sm text-gray-700">
                                {d.productName || '—'}
                                {d.enrollmentStatus && (
                                  <div>
                                    <span className={`inline-flex px-2 py-0.5 text-xs font-medium rounded-full mt-1 ${getStatusColor(d.enrollmentStatus)}`}>
                                      {d.enrollmentStatus}
                                    </span>
                                  </div>
                                )}
                              </td>
                              <td className="px-4 py-3 text-sm text-gray-700 whitespace-nowrap">
                                {formatDateShort(d.enrollmentTerminationDate)}
                              </td>
                              <td className="px-4 py-3 text-sm text-gray-700 whitespace-nowrap">
                                <div>{formatDateTime(d.enrollmentModifiedDate)}</div>
                                {d.enrollmentModifiedByName && (
                                  <div className="text-xs text-gray-500">by {d.enrollmentModifiedByName}</div>
                                )}
                              </td>
                              <td className="px-4 py-3 text-sm text-gray-700">
                                <ul className="list-disc pl-4 space-y-0.5">
                                  {d.reasons.map((reason, i) => (
                                    <li key={i}>{reason}</li>
                                  ))}
                                </ul>
                                {d.invoiceCreatedAfterNacha && (
                                  <div className="mt-1 text-xs text-yellow-700 bg-yellow-50 border border-yellow-200 rounded px-2 py-1 inline-block">
                                    Invoice attached {formatDateShort(d.invoiceCreatedDate)} — after NACHA generation
                                  </div>
                                )}
                              </td>
                              <td className="px-4 py-3 text-sm font-semibold text-right whitespace-nowrap text-gray-900">
                                {formatMoney(d.vendorAmount)}
                                {d.refundAmount > 0 && (
                                  <div className="text-xs text-red-600 font-normal">refunded {formatMoney(d.refundAmount)}</div>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
                );
              })}

              {vendorsWithAllocationWarnings.map((bundle) => (
                <div key={`alloc-${bundle.vendorId}`} className="border border-amber-200 rounded-lg overflow-hidden">
                  <div className="bg-amber-50 p-4 border-b border-amber-200">
                    <h4 className="text-base font-semibold text-gray-900">{bundle.vendorName}</h4>
                    <p className="text-xs text-amber-900 mt-0.5">
                      A few invoices need a look — amounts shown could not go on member lines. Vendor payout totals are
                      unchanged.
                    </p>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-amber-100">
                      <thead className="bg-amber-50/80">
                        <tr>
                          <th className="px-4 py-2 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">
                            Invoice
                          </th>
                          <th className="px-4 py-2 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">
                            Account
                          </th>
                          <th className="px-4 py-2 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">
                            Details
                          </th>
                          <th className="px-4 py-2 text-right text-xs font-semibold text-gray-600 uppercase tracking-wider">
                            Not on payables
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-amber-50">
                        {(bundle.allocationWarnings || []).map((w, i) => (
                          <tr key={i} className="text-sm text-gray-800 hover:bg-amber-50/50">
                            <td className="px-4 py-3 whitespace-nowrap font-medium text-gray-900">
                              {w.invoiceNumber || '—'}
                            </td>
                            <td className="px-4 py-3">
                              <div>{w.accountLabel || w.groupName || '—'}</div>
                              {w.billingPeriodLabel ? (
                                <div className="text-xs text-gray-500">{w.billingPeriodLabel}</div>
                              ) : null}
                            </td>
                            <td className="px-4 py-3">
                              <div className="font-medium text-gray-900">{w.title || 'Note'}</div>
                              <div className="text-xs text-gray-600 mt-0.5 whitespace-pre-line">{w.message}</div>
                            </td>
                            <td className="px-4 py-3 text-right whitespace-nowrap tabular-nums">
                              {(w.notOnPayablesFile ?? 0) > 0 ? formatMoney(w.notOnPayablesFile) : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}

              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-sm text-blue-800">
                <p>
                  {hasPayablesMismatch
                    ? 'Exporting downloads the payables CSV as-is (one row per member/product that could be allocated). Use the invoice list below to see amounts that could not be mapped to members.'
                    : 'The CSV matches what was paid per invoice. Safe to export.'}
                </p>
              </div>
            </div>

            <div className="flex justify-end gap-2 p-4 border-t border-gray-200 bg-gray-50">
              <button
                onClick={handleCancelWarning}
                className="px-4 py-2 border border-gray-300 text-gray-700 bg-white rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmExportAnyway}
                className="px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-dark"
              >
                {needsManualDownloadStep(pendingExports || []) ? 'Continue to downloads' : 'Export anyway'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Loading spinner while fetching a member's details */}
      {memberModalLoading && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[70]">
          <div className="bg-white rounded-lg shadow-xl p-6 flex items-center gap-3">
            <Loader2 className="animate-spin h-5 w-5 text-oe-primary" />
            <span className="text-sm text-gray-700">Loading member…</span>
          </div>
        </div>
      )}

      {downloadBundles && downloadBundles.length > 0 && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[70] p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between p-6 border-b border-gray-200">
              <div>
                <h3 className="text-lg font-semibold text-gray-900">Download files</h3>
                <p className="text-sm text-gray-600 mt-1">
                  Some browsers block multiple downloads at once. Use the buttons below to download each file.
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setDownloadBundles(null);
                  onClose();
                }}
                className="text-gray-400 hover:text-gray-600 transition-colors"
              >
                <X size={20} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              {downloadBundles.map((p) => (
                <div key={p.vendorId} className="border border-gray-200 rounded-lg p-4">
                  <h4 className="font-medium text-gray-900 mb-3">{p.vendorName}</h4>
                  <button
                    type="button"
                    onClick={() => downloadPayablesCsv(p)}
                    className="inline-flex items-center px-3 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50"
                  >
                    <Download size={14} className="mr-2" />
                    Download CSV
                    {(p.clawbacksRowCount ?? 0) > 0
                      ? ` (includes ${p.clawbacksRowCount} clawback row${p.clawbacksRowCount === 1 ? '' : 's'})`
                      : ''}
                  </button>
                </div>
              ))}
            </div>
            <div className="flex justify-end gap-2 p-4 border-t border-gray-200 bg-gray-50">
              <button
                type="button"
                onClick={() => downloadAllBundlesSequential(downloadBundles)}
                className="px-4 py-2 border border-gray-300 text-gray-700 bg-white rounded-lg hover:bg-gray-50 text-sm"
              >
                Download all
              </button>
              <button
                type="button"
                onClick={() => {
                  setDownloadBundles(null);
                  onClose();
                }}
                className="px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-dark"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {memberModalMember && (
        <MemberManagementModal
          member={memberModalMember}
          householdMembers={memberModalHousehold}
          memberEnrollments={memberModalEnrollments}
          enrollmentsLoading={memberModalLoading}
          onClose={closeMemberModal}
          onEdit={() => {}}
          formatCurrency={formatMoney}
          getStatusColor={getStatusColor}
          getRelationshipIcon={getRelationshipIcon}
          getRelationshipColor={getRelationshipColor}
          canEdit={false}
          canDelete={false}
        />
      )}
    </>
  );
};

export default ExportVendorPayablesModal;
