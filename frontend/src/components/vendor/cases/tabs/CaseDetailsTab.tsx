// Case Details — shows the case description + member summary, lets users
// edit the title and description inline.

import { useEffect, useState } from 'react';
import { Pencil, Save, X } from 'lucide-react';
import { apiService } from '../../../../services/api.service';
import type {
  CaseRow,
  CaseType,
  CaseSubcategory,
} from '../../../../types/case.types';
import { useCaseTaxonomy } from '../../../../hooks/useCaseTaxonomy';

interface UpdateResp { success: boolean; data: CaseRow; message?: string }

interface CaseDetailsTabProps {
  caseRow: CaseRow;
  onCaseUpdated: (next: CaseRow) => void;
}

const fmtDateTime = (v?: string | null) => {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
};

const CaseDetailsTab = ({ caseRow, onCaseUpdated }: CaseDetailsTabProps) => {
  const { types, subcategoriesForType, typeLabel, subcategoryLabel } = useCaseTaxonomy();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(caseRow.Title || '');
  const [description, setDescription] = useState(caseRow.Description || '');
  const [caseType, setTicketType] = useState<CaseType>(caseRow.CaseType);
  const [caseSubcategory, setTicketSubcategory] = useState<CaseSubcategory | ''>(caseRow.CaseSubcategory || '');
  const [subcategoryDetail, setSubcategoryDetail] = useState(caseRow.SubcategoryDetail || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset edits if the case row changes underneath us.
  useEffect(() => {
    setTitle(caseRow.Title || '');
    setDescription(caseRow.Description || '');
    setTicketType(caseRow.CaseType);
    setTicketSubcategory(caseRow.CaseSubcategory || '');
    setSubcategoryDetail(caseRow.SubcategoryDetail || '');
  }, [caseRow]);

  // Clear subcategory if the type changes to one that doesn't include it.
  useEffect(() => {
    if (!caseSubcategory) return;
    const subs = subcategoriesForType(caseType);
    if (!subs.some((s) => s.code === caseSubcategory)) {
      setTicketSubcategory('');
      setSubcategoryDetail('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseType, caseSubcategory]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const resp = await apiService.put<UpdateResp>(`/api/me/vendor/cases/${caseRow.CaseId}`, {
        title: title.trim() || null,
        description: description.trim() || null,
        caseType,
        caseSubcategory: caseSubcategory || null,
        subcategoryDetail: subcategoryDetail.trim() || null,
      });
      if (resp.success && resp.data) {
        onCaseUpdated(resp.data);
        setEditing(false);
      } else {
        setError(resp.message || 'Failed to save');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setTitle(caseRow.Title || '');
    setDescription(caseRow.Description || '');
    setTicketType(caseRow.CaseType);
    setTicketSubcategory(caseRow.CaseSubcategory || '');
    setSubcategoryDetail(caseRow.SubcategoryDetail || '');
    setEditing(false);
    setError(null);
  };

  return (
    <div className="p-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
      <section className="lg:col-span-2 bg-white rounded-lg border border-gray-200 p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-gray-900">Case Details</h3>
          {!editing && (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="inline-flex items-center gap-1.5 text-xs text-oe-primary hover:text-oe-dark"
            >
              <Pencil className="h-3.5 w-3.5" /> Edit
            </button>
          )}
        </div>

        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Type</label>
              {editing ? (
                <select
                  value={caseType}
                  onChange={(e) => setTicketType(e.target.value as CaseType)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-oe-primary"
                >
                  {types.map((t) => (
                    <option key={t.code} value={t.code}>{t.label}</option>
                  ))}
                </select>
              ) : (
                <div className="text-sm text-gray-900">{typeLabel(caseRow.CaseType)}</div>
              )}
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Subcategory</label>
              {editing ? (
                <select
                  value={caseSubcategory}
                  onChange={(e) => setTicketSubcategory(e.target.value as CaseSubcategory | '')}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-oe-primary"
                >
                  <option value="">— None —</option>
                  {subcategoriesForType(caseType).map((s) => (
                    <option key={s.code} value={s.code}>{s.label}</option>
                  ))}
                </select>
              ) : (
                <div className="text-sm text-gray-900">
                  {caseRow.CaseSubcategory
                    ? subcategoryLabel(caseRow.CaseSubcategory)
                    : <span className="text-gray-400">—</span>}
                </div>
              )}
            </div>
          </div>

          {(editing ? caseSubcategory : caseRow.CaseSubcategory) && (
            <div>
              <label className="block text-xs text-gray-500 mb-1">Subcategory detail</label>
              {editing ? (
                <input
                  type="text"
                  value={subcategoryDetail}
                  onChange={(e) => setSubcategoryDetail(e.target.value)}
                  placeholder="e.g. rotator cuff repair, denied claim 2025-04…"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-oe-primary"
                />
              ) : (
                <div className="text-sm text-gray-900 whitespace-pre-wrap">
                  {caseRow.SubcategoryDetail || <span className="text-gray-400">—</span>}
                </div>
              )}
            </div>
          )}

          <div>
            <label className="block text-xs text-gray-500 mb-1">Title</label>
            {editing ? (
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={200}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-oe-primary"
              />
            ) : (
              <div className="text-sm text-gray-900">{caseRow.Title || <span className="text-gray-400">—</span>}</div>
            )}
          </div>

          <div>
            <label className="block text-xs text-gray-500 mb-1">Description</label>
            {editing ? (
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={8}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-oe-primary"
              />
            ) : (
              <div className="text-sm text-gray-900 whitespace-pre-wrap">
                {caseRow.Description || <span className="text-gray-400">No description.</span>}
              </div>
            )}
          </div>

          {error && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">{error}</div>
          )}

          {editing && (
            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={handleCancel}
                disabled={saving}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-300 rounded-md bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-60"
              >
                <X className="h-4 w-4" /> Cancel
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-oe-primary hover:bg-oe-dark rounded-md disabled:opacity-60"
              >
                <Save className="h-4 w-4" /> {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          )}
        </div>
      </section>

      <section className="bg-white rounded-lg border border-gray-200 p-5 space-y-4">
        <h3 className="text-sm font-semibold text-gray-900">Member</h3>
        <Field label="Name">{`${caseRow.MemberFirstName || ''} ${caseRow.MemberLastName || ''}`.trim() || '—'}</Field>
        <Field label="Email">{caseRow.MemberEmail || '—'}</Field>
        <Field label="Phone">{caseRow.MemberPhone || '—'}</Field>
        <Field label="Date of birth">{caseRow.MemberDOB ? fmtDateTime(caseRow.MemberDOB).split(',')[0] : '—'}</Field>

        <h3 className="text-sm font-semibold text-gray-900 pt-3 border-t border-gray-100">Case meta</h3>
        <Field label="Submitted">{fmtDateTime(caseRow.SubmittedDate)}</Field>
        <Field label="Last modified">{fmtDateTime(caseRow.ModifiedDate)}</Field>
        <Field label="Created by">
          {`${caseRow.CreatedByFirstName || ''} ${caseRow.CreatedByLastName || ''}`.trim() || '—'}
        </Field>
        {caseRow.CompletedDate && <Field label="Completed">{fmtDateTime(caseRow.CompletedDate)}</Field>}
      </section>
    </div>
  );
};

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div>
    <div className="text-xs text-gray-500">{label}</div>
    <div className="text-sm text-gray-900 break-words">{children}</div>
  </div>
);

export default CaseDetailsTab;
