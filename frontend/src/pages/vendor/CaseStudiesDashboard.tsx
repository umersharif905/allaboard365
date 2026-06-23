// pages/vendor/CaseStudiesDashboard.tsx
// Vendor back-office "Case Studies" management page: list all saved case studies,
// create new ones, edit, and delete existing ones. Available to VendorAdmin + VendorAgent
// (route is gated by the /vendor/* ProtectedRoute).

import { useCallback, useEffect, useState } from 'react';
import { CircleAlert, FileText, Plus, Trash2 } from 'lucide-react';
import { CaseStudyService } from '../../services/case-study.service';
import type { CaseStudy } from '../../types/caseStudy.types';
import CaseStudyModal from '../../components/vendor/share-requests/CaseStudyModal';

const fmtCurrency = (n?: number | null) =>
  n == null ? '—' : `$${Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

const fmtDate = (v?: string | null) => {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

const statusClass = (s?: string) => {
  switch (s) {
    case 'Published':
      return 'bg-green-100 text-green-800';
    case 'Review':
      return 'bg-yellow-100 text-yellow-800';
    case 'Archived':
      return 'bg-gray-100 text-gray-600';
    default:
      return 'bg-oe-light text-oe-dark'; // Draft
  }
};

const CaseStudiesDashboard = () => {
  const [items, setItems] = useState<CaseStudy[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await CaseStudyService.list();
      if (res.success) setItems(res.data);
      else setError(res.message ?? 'Failed to load case studies');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load case studies');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const openNew = () => {
    setEditingId(null);
    setShowModal(true);
  };
  const openEdit = (id: string) => {
    setEditingId(id);
    setShowModal(true);
  };
  const handleSaved = () => {
    setShowModal(false);
    setEditingId(null);
    load();
  };
  const handleDelete = async (c: CaseStudy) => {
    const label = c.headline || 'this case study';
    if (!window.confirm(`Delete "${label}"? This permanently removes it from the websites and can't be undone.`)) return;
    setDeletingId(c.caseStudyId);
    setError(null);
    try {
      const res = await CaseStudyService.remove(c.caseStudyId);
      if (!res.success) throw new Error(res.message ?? 'Failed to delete case study');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete case study');
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Case Studies</h1>
          <p className="text-sm text-gray-600">Patient/client success stories used on the MightyWELL & ShareWELL websites</p>
        </div>
        <button
          type="button"
          onClick={openNew}
          className="inline-flex items-center gap-2 px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-dark"
        >
          <Plus className="h-4 w-4" />
          New Case Study
        </button>
      </div>

      {loading ? (
        <div className="text-center py-12 text-gray-500">Loading case studies…</div>
      ) : error ? (
        <div className="flex items-center gap-2 text-red-600 text-sm">
          <CircleAlert className="h-4 w-4" />
          <span>{error}</span>
        </div>
      ) : items.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 p-10 text-center">
          <FileText className="mx-auto mb-3 h-10 w-10 text-gray-400" />
          <p className="text-gray-700 font-medium">No case studies yet</p>
          <p className="text-sm text-gray-500 mt-1">Create one here, or use “Create Case Study” from a completed share request.</p>
        </div>
      ) : (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr className="text-left text-xs font-medium text-gray-500 uppercase tracking-wide">
                <th className="px-4 py-3">Headline</th>
                <th className="px-4 py-3">Brand</th>
                <th className="px-4 py-3">Category</th>
                <th className="px-4 py-3">Saved</th>
                <th className="px-4 py-3">Bill → Paid</th>
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {items.map((c) => (
                <tr
                  key={c.caseStudyId}
                  onClick={() => openEdit(c.caseStudyId)}
                  className="cursor-pointer hover:bg-gray-50 text-sm text-gray-700"
                >
                  <td className="px-4 py-3 max-w-md">
                    <div className="font-medium text-gray-900 truncate">{c.headline || '(untitled)'}</div>
                    {c.procedureType && <div className="text-xs text-gray-500 truncate">{c.procedureType}</div>}
                  </td>
                  <td className="px-4 py-3">{c.brand ?? '—'}</td>
                  <td className="px-4 py-3">{c.category ?? '—'}</td>
                  <td className="px-4 py-3">
                    {c.percentValue != null ? `${c.percentValue}% ${c.percentLabel ?? ''}`.trim() : '—'}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    {fmtCurrency(c.totalBilledAmount)} → {fmtCurrency(c.patientPaidAmount)}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">{fmtDate(c.storyDate)}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex px-2 py-0.5 text-xs font-medium rounded-full ${statusClass(c.status)}`}>
                      {c.status ?? 'Draft'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(c);
                      }}
                      disabled={deletingId === c.caseStudyId}
                      title="Delete case study"
                      aria-label="Delete case study"
                      className="inline-flex items-center justify-center p-1.5 text-gray-400 rounded hover:text-red-600 hover:bg-red-50 disabled:opacity-50"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showModal && (
        <CaseStudyModal
          caseStudyId={editingId ?? undefined}
          onClose={() => {
            setShowModal(false);
            setEditingId(null);
          }}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
};

export default CaseStudiesDashboard;
