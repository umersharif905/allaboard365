// Procedure Pricing section — sits at the top of the share-request Finances
// tab. CPT codes per share request (oe.ShareRequestProcedures) with the
// snapshotted Medicare rate and 150-200% target negotiation range; expandable
// per-code Medicare breakdown + nearby hospital asking prices.

import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Plus, RefreshCw, Stethoscope, Trash2 } from 'lucide-react';
import { cptPricingService } from '../../../services/cpt-pricing.service';
import type { ShareRequestProcedure } from '../../../types/cptPricing.types';
import CptSearchBox, { type CptSuggestion } from './CptSearchBox';
import MedicareBreakdownCard from './MedicareBreakdownCard';
import HospitalPricesTable from './HospitalPricesTable';
import TargetRangeBadge from './TargetRangeBadge';
import Skeleton from '../ui/Skeleton';

interface ProcedurePricingSectionProps {
  shareRequestId: string;
  /** When true, drop the standalone page padding (used inside the Coding grid). */
  embedded?: boolean;
  /** When false, hide the add/remove code controls — codes are managed in
   *  Request Details; this view (Finances) is pricing-only. Default true. */
  manageCodes?: boolean;
}

const fmt = (n: number | null | undefined) =>
  n == null
    ? '—'
    : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null;

const ProcedurePricingSection = ({ shareRequestId, embedded = false, manageCodes = true }: ProcedurePricingSectionProps) => {
  const [procedures, setProcedures] = useState<ShareRequestProcedure[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [zipOverride, setZipOverride] = useState('');

  const load = useCallback(async () => {
    try {
      const rows = await cptPricingService.getProcedures(shareRequestId);
      setProcedures(rows);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [shareRequestId]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  const handleAdd = async (s: CptSuggestion) => {
    try {
      // Don't persist the hospital-corpus label (often chargemaster text or a
      // "grouper" bucket) — the auto-refresh below backfills the official
      // Medicare PFS descriptor as the stored description.
      const created = await cptPricingService.addProcedure(shareRequestId, {
        cptCode: s.code,
      });
      setAdding(false);
      await load();
      // Immediately price the new code (member ZIP by default).
      await handleRefresh(created.procedureId);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const handleRefresh = async (procedureId: string) => {
    setRefreshingId(procedureId);
    setError(null);
    try {
      const updated = await cptPricingService.refreshPricing(
        shareRequestId,
        procedureId,
        /^\d{5}$/.test(zipOverride) ? zipOverride : undefined
      );
      setProcedures((prev) => prev.map((p) => (p.ProcedureId === updated.ProcedureId ? updated : p)));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRefreshingId(null);
    }
  };

  const handleDelete = async (procedureId: string) => {
    if (!window.confirm('Remove this procedure code from the share request?')) return;
    try {
      await cptPricingService.deleteProcedure(shareRequestId, procedureId);
      setProcedures((prev) => prev.filter((p) => p.ProcedureId !== procedureId));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className={embedded ? '' : 'px-4 sm:px-6 pt-4 shrink-0'}>
      <div className="bg-white rounded-lg border border-gray-200">
        <div className="px-4 py-3 border-b border-gray-200 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
            <Stethoscope className="h-4 w-4 text-oe-primary" />
            Procedure Pricing
          </h3>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={zipOverride}
              onChange={(e) => setZipOverride(e.target.value.replace(/\D/g, '').slice(0, 5))}
              placeholder="Member ZIP"
              title="ZIP used for locality-adjusted pricing. Leave empty to use the member's ZIP on file."
              className="w-28 px-2 py-1.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-transparent"
            />
            {manageCodes && (
              <button
                type="button"
                onClick={() => setAdding((a) => !a)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-oe-primary hover:bg-oe-dark text-white text-sm font-medium rounded-lg"
              >
                <Plus className="h-4 w-4" />
                Add code
              </button>
            )}
          </div>
        </div>

        {manageCodes && adding && (
          <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
            <CptSearchBox onSelect={handleAdd} zip={zipOverride || undefined} autoFocus />
            <p className="mt-1.5 text-xs text-gray-500">
              Search by procedure name or enter a CPT/HCPCS/DRG code. Selecting a code adds it to this share request and prices it.
            </p>
          </div>
        )}

        {error && <p className="px-4 py-2 text-sm text-red-600 border-b border-gray-100">{error}</p>}

        {loading ? (
          <div className="px-4 py-3 space-y-2">
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-2/3" />
          </div>
        ) : procedures.length === 0 ? (
          <p className="px-4 py-4 text-sm text-gray-500">
            No procedure codes logged yet. Add the CPT code for this request's procedure to pull Medicare rates and a target negotiation range.
          </p>
        ) : (
          <ul>
            {procedures.map((proc) => {
              const isOpen = expandedId === proc.ProcedureId;
              const isRefreshing = refreshingId === proc.ProcedureId;
              const snap = proc.PricingSnapshot;
              return (
                <li key={proc.ProcedureId} className="border-b border-gray-100 last:border-b-0">
                  <div className="px-4 py-2.5 flex flex-wrap items-center gap-x-4 gap-y-1">
                    <button
                      type="button"
                      onClick={() => setExpandedId(isOpen ? null : proc.ProcedureId)}
                      className="flex items-center gap-2 min-w-0 flex-1 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-oe-primary rounded"
                    >
                      {isOpen ? (
                        <ChevronDown className="h-4 w-4 text-gray-400 shrink-0" />
                      ) : (
                        <ChevronRight className="h-4 w-4 text-gray-400 shrink-0" />
                      )}
                      <span className="text-sm font-medium text-gray-900">{proc.CPTCode}</span>
                      <span className="text-sm text-gray-600 truncate">
                        {proc.Description || snap?.description || ''}
                      </span>
                    </button>

                    <div className="flex items-center gap-4 text-right">
                      <div>
                        <p className="text-xs text-gray-500">Medicare{snap?.headlineSite ? ` · ${snap.headlineSite}` : ''}</p>
                        <p className="text-sm font-semibold text-gray-900">{fmt(proc.MedicareTotal)}</p>
                      </div>
                      <div>
                        <p className="text-xs text-gray-500">Target (150–200%)</p>
                        <TargetRangeBadge targetMin={proc.TargetMin} targetMax={proc.TargetMax} size="sm" />
                      </div>
                      <div className="text-xs text-gray-400 w-24">
                        {proc.SnapshotDate ? (
                          <>
                            {fmtDate(proc.SnapshotDate)}
                            {proc.SnapshotZip ? ` · ${proc.SnapshotZip}` : ''}
                          </>
                        ) : (
                          'Not priced'
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => handleRefresh(proc.ProcedureId)}
                        disabled={isRefreshing}
                        title="Fetch current Medicare pricing and update the target range"
                        className="p-1.5 text-gray-500 hover:text-oe-primary hover:bg-oe-light/50 rounded disabled:opacity-50"
                      >
                        <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
                      </button>
                      {manageCodes && (
                        <button
                          type="button"
                          onClick={() => handleDelete(proc.ProcedureId)}
                          title="Remove code"
                          className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  </div>

                  {isOpen && (
                    <div className="px-4 pb-4 space-y-3 bg-gray-50/60">
                      {snap ? (
                        <MedicareBreakdownCard
                          code={snap.code}
                          description={snap.description}
                          locality={snap.locality}
                          zip={snap.zip}
                          headlineSite={snap.headlineSite}
                          medicareTotal={snap.medicareTotal}
                          targetMin={snap.targetMin}
                          targetMax={snap.targetMax}
                          totals={snap.totals}
                          sections={snap.sections}
                        />
                      ) : (
                        <p className="text-sm text-gray-500 pt-3">
                          Not priced yet — hit refresh to pull the Medicare breakdown and target range.
                        </p>
                      )}
                      <details className="bg-white rounded-lg border border-gray-200">
                        <summary className="px-4 py-2.5 text-sm font-medium text-gray-700 cursor-pointer select-none">
                          Nearby hospital asking prices
                        </summary>
                        <div className="px-4 pb-3">
                          <HospitalPricesTable
                            code={proc.CPTCode.split('-')[0]}
                            zip={(zipOverride || proc.SnapshotZip || undefined) ?? undefined}
                          />
                        </div>
                      </details>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
};

export default ProcedurePricingSection;
