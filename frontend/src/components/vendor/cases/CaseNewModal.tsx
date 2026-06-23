// CaseNewModal — search a member, capture title + type/subcategory/detail
// + description, submit POST /api/me/vendor/cases. Used from the
// workspace's "New Case" button.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Search, User, X } from 'lucide-react';
import { apiService } from '../../../services/api.service';
import type {
  MemberSearchResult,
  CaseRow,
  CaseType,
  CaseSubcategory,
} from '../../../types/case.types';
import { useCaseTaxonomy } from '../../../hooks/useCaseTaxonomy';

interface CaseNewModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (created: CaseRow) => void;
}

interface SearchResp { success: boolean; data: MemberSearchResult[] }
interface CreateResp { success: boolean; data: CaseRow; message?: string }

const CaseNewModal = ({ open, onClose, onCreated }: CaseNewModalProps) => {
  const { types, subcategoriesForType } = useCaseTaxonomy();
  const defaultType = types[0]?.code || 'reimbursement';

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MemberSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<MemberSearchResult | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [caseType, setTicketType] = useState<CaseType>(defaultType);
  const [caseSubcategory, setTicketSubcategory] = useState<CaseSubcategory | ''>('');
  const [subcategoryDetail, setSubcategoryDetail] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Once taxonomy resolves, snap to the first active type if the current value
  // isn't in the active set (e.g., admin disabled what was selected).
  useEffect(() => {
    if (types.length > 0 && !types.some((t) => t.code === caseType)) {
      setTicketType(types[0].code);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [types]);

  const debounceRef = useRef<number | null>(null);

  const reset = useCallback(() => {
    setQuery('');
    setResults([]);
    setSelected(null);
    setTitle('');
    setDescription('');
    setTicketType(defaultType);
    setTicketSubcategory('');
    setSubcategoryDetail('');
    setError(null);
  }, [defaultType]);

  useEffect(() => {
    if (!open) reset();
  }, [open, reset]);

  // Clear subcategory + detail when type changes.
  useEffect(() => {
    setTicketSubcategory('');
    setSubcategoryDetail('');
  }, [caseType]);

  useEffect(() => {
    if (!open || selected) return;
    if (!query || query.trim().length < 2) {
      setResults([]);
      return;
    }
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(async () => {
      setSearching(true);
      try {
        const resp = await apiService.get<SearchResp>(
          `/api/me/vendor/members/search?q=${encodeURIComponent(query.trim())}&limit=10`
        );
        if (resp.success) setResults(resp.data);
      } catch {
        // soft-fail; search isn't blocking
      } finally {
        setSearching(false);
      }
    }, 200);

    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [query, selected, open]);

  const handleSubmit = useCallback(async () => {
    if (!selected) {
      setError('Please select a member.');
      return;
    }
    if (!description.trim()) {
      setError('Please enter ticket details.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const resp = await apiService.post<CreateResp>('/api/me/vendor/cases', {
        memberId: selected.MemberId,
        title: title.trim() || null,
        description: description.trim(),
        caseType,
        caseSubcategory: caseSubcategory || null,
        subcategoryDetail: subcategoryDetail.trim() || null,
      });
      if (resp.success && resp.data) {
        onCreated(resp.data);
      } else {
        setError(resp.message || 'Failed to create case');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create case');
    } finally {
      setSaving(false);
    }
  }, [selected, title, description, caseType, caseSubcategory, subcategoryDetail, onCreated]);

  if (!open) return null;

  const subcategoryOptions = subcategoriesForType(caseType);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className="w-full max-w-2xl bg-white rounded-lg shadow-xl border border-gray-200 max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">New Case</h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-gray-400 hover:text-gray-700 rounded"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          <section>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Member
            </label>
            {selected ? (
              <div className="flex items-start justify-between gap-3 p-3 bg-oe-light/40 rounded-lg border border-oe-light">
                <div className="flex items-start gap-3">
                  <div className="h-10 w-10 rounded-full bg-white border border-oe-light flex items-center justify-center text-oe-primary">
                    <User className="h-5 w-5" />
                  </div>
                  <div className="text-sm">
                    <div className="font-medium text-gray-900">
                      {selected.FirstName} {selected.LastName}
                    </div>
                    <div className="text-gray-600">
                      {selected.Email || '—'}{selected.Phone ? ` · ${selected.Phone}` : ''}
                    </div>
                    {selected.HouseholdMemberID && (
                      <div className="text-xs text-gray-500 mt-0.5">
                        Member ID: {selected.HouseholdMemberID}
                      </div>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => { setSelected(null); setQuery(''); }}
                  className="text-xs text-gray-500 hover:text-oe-primary"
                >
                  Change
                </button>
              </div>
            ) : (
              <>
                <div className="relative">
                  <Search className="h-4 w-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search by name, email, or member ID..."
                    className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-oe-primary"
                    autoFocus
                  />
                </div>
                {searching && <p className="text-xs text-gray-500 mt-2">Searching...</p>}
                {results.length > 0 && (
                  <ul className="mt-2 max-h-64 overflow-y-auto border border-gray-200 rounded-md divide-y divide-gray-100">
                    {results.map((m) => (
                      <li key={m.MemberId}>
                        <button
                          type="button"
                          onClick={() => { setSelected(m); setResults([]); }}
                          className="w-full text-left px-3 py-2 text-sm hover:bg-oe-light/30 transition-colors"
                        >
                          <div className="font-medium text-gray-900">
                            {m.FirstName} {m.LastName}
                          </div>
                          <div className="text-xs text-gray-500">
                            {m.Email || '—'}{m.HouseholdMemberID ? ` · #${m.HouseholdMemberID}` : ''}
                          </div>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {!searching && query.trim().length >= 2 && results.length === 0 && (
                  <p className="text-xs text-gray-500 mt-2">No matching members.</p>
                )}
              </>
            )}
          </section>

          <section className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Type <span className="text-red-500">*</span>
              </label>
              <select
                value={caseType}
                onChange={(e) => setTicketType(e.target.value as CaseType)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-oe-primary"
              >
                {types.map((t) => (
                  <option key={t.code} value={t.code}>{t.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Subcategory <span className="text-gray-400 font-normal">(optional)</span>
              </label>
              <select
                value={caseSubcategory}
                onChange={(e) => setTicketSubcategory(e.target.value as CaseSubcategory | '')}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-oe-primary"
              >
                <option value="">— None —</option>
                {subcategoryOptions.map((s) => (
                  <option key={s.code} value={s.code}>{s.label}</option>
                ))}
              </select>
            </div>
          </section>

          {caseSubcategory && (
            <section>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Subcategory detail <span className="text-gray-400 font-normal">(optional)</span>
              </label>
              <input
                type="text"
                value={subcategoryDetail}
                onChange={(e) => setSubcategoryDetail(e.target.value)}
                placeholder="e.g. rotator cuff repair, denied claim 2025-04…"
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-oe-primary"
              />
            </section>
          )}

          <section>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Title <span className="text-gray-400 font-normal">(optional)</span>
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Short label for this case"
              maxLength={200}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-oe-primary"
            />
          </section>

          <section>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Case details <span className="text-red-500">*</span>
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe what this case is about..."
              rows={6}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-oe-primary"
            />
          </section>

          {error && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-6 py-3 border-t border-gray-200">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2 text-sm border border-gray-300 rounded-md bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={saving || !selected || !description.trim()}
            className="px-4 py-2 text-sm font-medium text-white bg-oe-primary hover:bg-oe-dark rounded-md disabled:opacity-60"
          >
            {saving ? 'Creating...' : 'Create case'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default CaseNewModal;
