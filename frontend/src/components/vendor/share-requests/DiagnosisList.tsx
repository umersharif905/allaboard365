// DiagnosisList — the ICD-10 diagnoses for one share request, rendered as a bare
// sub-section (no card chrome) so it sits inside the "Coding" card on the Request
// Details tab. Manual entry — code + description, one markable Primary.
import { useCallback, useEffect, useState } from 'react';
import { Plus, Star, Trash2 } from 'lucide-react';
import { srDiagnosesService } from '../../../services/sr-diagnoses.service';
import type { ShareRequestDiagnosis } from '../../../types/shareRequest.types';
import Skeleton from '../ui/Skeleton';

interface DiagnosisListProps {
  shareRequestId: string;
}

const ICD10 = /^[A-Z]\d{2}\.?\d{0,4}[A-Z]?$/i;

const DiagnosisList = ({ shareRequestId }: DiagnosisListProps) => {
  const [rows, setRows] = useState<ShareRequestDiagnosis[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [code, setCode] = useState('');
  const [desc, setDesc] = useState('');

  const load = useCallback(async () => {
    try {
      setRows(await srDiagnosesService.list(shareRequestId));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [shareRequestId]);

  useEffect(() => { setLoading(true); load(); }, [load]);

  const handleAdd = async () => {
    const trimmed = code.trim();
    if (!ICD10.test(trimmed)) { setError('Enter a valid ICD-10 code (e.g. M17.11 or E119).'); return; }
    try {
      await srDiagnosesService.add(shareRequestId, {
        icd10Code: trimmed,
        description: desc.trim() || undefined,
        isPrimary: rows.length === 0,
      });
      setCode(''); setDesc(''); setAdding(false);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const setPrimary = async (d: ShareRequestDiagnosis) => {
    if (d.IsPrimary) return;
    try { await srDiagnosesService.update(shareRequestId, d.DiagnosisId, { isPrimary: true }); await load(); }
    catch (e) { setError((e as Error).message); }
  };

  const handleDelete = async (d: ShareRequestDiagnosis) => {
    if (!window.confirm(`Remove diagnosis ${d.ICD10Code}?`)) return;
    try { await srDiagnosesService.remove(shareRequestId, d.DiagnosisId); setRows((p) => p.filter((r) => r.DiagnosisId !== d.DiagnosisId)); }
    catch (e) { setError((e as Error).message); }
  };

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-gray-500">Diagnoses (ICD-10)</span>
        <button
          type="button"
          onClick={() => setAdding((a) => !a)}
          className="inline-flex items-center gap-1 text-xs font-medium text-oe-primary hover:text-oe-dark"
        >
          <Plus className="h-3.5 w-3.5" />
          Add diagnosis
        </button>
      </div>

      {adding && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={code}
            onChange={(e) => { setCode(e.target.value); if (error) setError(null); }}
            placeholder="ICD-10 code"
            className="w-28 px-2 py-1.5 border border-gray-300 rounded text-sm font-mono focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-transparent"
          />
          <input
            type="text"
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            placeholder="Description (optional)"
            className="flex-1 min-w-[10rem] px-2 py-1.5 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-transparent"
          />
          <button type="button" onClick={handleAdd} className="px-3 py-1.5 bg-oe-primary hover:bg-oe-dark text-white text-sm font-medium rounded">Add</button>
        </div>
      )}

      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}

      {loading ? (
        <div className="mt-2"><Skeleton className="h-5 w-full" /></div>
      ) : rows.length === 0 ? (
        <p className="mt-1 text-sm text-gray-400">No diagnoses yet.</p>
      ) : (
        <ul className="mt-1 space-y-1">
          {rows.map((d) => (
            <li key={d.DiagnosisId} className="flex items-center gap-2 text-sm">
              <button
                type="button"
                onClick={() => setPrimary(d)}
                title={d.IsPrimary ? 'Primary diagnosis' : 'Mark as primary'}
                className={`p-0.5 rounded shrink-0 ${d.IsPrimary ? 'text-amber-500' : 'text-gray-300 hover:text-amber-400'}`}
              >
                <Star className={`h-3.5 w-3.5 ${d.IsPrimary ? 'fill-amber-500' : ''}`} />
              </button>
              <span className="font-mono font-medium text-gray-900">{d.ICD10Code}</span>
              <span className="text-gray-600 truncate flex-1">{d.Description || ''}</span>
              <button
                type="button"
                onClick={() => handleDelete(d)}
                title="Remove diagnosis"
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

export default DiagnosisList;
