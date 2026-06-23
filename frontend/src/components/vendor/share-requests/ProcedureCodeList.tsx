// ProcedureCodeList — the CPT procedure codes for one share request, rendered
// as a bare sub-section (no card chrome) so it sits inside the "Coding" card on
// the Request Details tab. Just codes (code + description); Medicare rates and
// nearby-hospital prices for these codes live on the Finances tab.
import { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { cptPricingService } from '../../../services/cpt-pricing.service';
import type { ShareRequestProcedure } from '../../../types/cptPricing.types';
import CptSearchBox, { type CptSuggestion } from '../pricing/CptSearchBox';
import Skeleton from '../ui/Skeleton';

interface ProcedureCodeListProps {
  shareRequestId: string;
}

const ProcedureCodeList = ({ shareRequestId }: ProcedureCodeListProps) => {
  const [rows, setRows] = useState<ShareRequestProcedure[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      setRows(await cptPricingService.getProcedures(shareRequestId));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [shareRequestId]);

  useEffect(() => { setLoading(true); load(); }, [load]);

  const handleAdd = async (s: CptSuggestion) => {
    try {
      await cptPricingService.addProcedure(shareRequestId, { cptCode: s.code, description: s.description });
      setAdding(false);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const handleDelete = async (proc: ShareRequestProcedure) => {
    if (!window.confirm(`Remove CPT ${proc.CPTCode}?`)) return;
    try {
      await cptPricingService.deleteProcedure(shareRequestId, proc.ProcedureId);
      setRows((p) => p.filter((r) => r.ProcedureId !== proc.ProcedureId));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-gray-500">Procedures (CPT)</span>
        <button
          type="button"
          onClick={() => setAdding((a) => !a)}
          className="inline-flex items-center gap-1 text-xs font-medium text-oe-primary hover:text-oe-dark"
        >
          <Plus className="h-3.5 w-3.5" />
          Add code
        </button>
      </div>

      {adding && (
        <div className="mt-2">
          <CptSearchBox onSelect={handleAdd} autoFocus />
          <p className="mt-1 text-xs text-gray-500">Search by procedure name or enter a CPT/HCPCS code. Medicare rates and hospital prices are on the Finances tab.</p>
        </div>
      )}

      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}

      {loading ? (
        <div className="mt-2"><Skeleton className="h-5 w-full" /></div>
      ) : rows.length === 0 ? (
        <p className="mt-1 text-sm text-gray-400">No codes yet.</p>
      ) : (
        <ul className="mt-1 space-y-1">
          {rows.map((proc) => (
            <li key={proc.ProcedureId} className="flex items-center gap-2 text-sm">
              <span className="font-mono font-medium text-gray-900">{proc.CPTCode}</span>
              <span className="text-gray-600 truncate flex-1">{proc.Description || ''}</span>
              <button
                type="button"
                onClick={() => handleDelete(proc)}
                title="Remove code"
                className="p-1 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded shrink-0"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default ProcedureCodeList;
