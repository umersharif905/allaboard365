// Support ticket providers tab. Mirrors share-request ProvidersTab: list providers in
// a table + an "Add provider" modal with autocomplete search against
// /api/me/vendor/providers/search and a role picker.

import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { CircleAlert, Plus, Search, Stethoscope, Trash2, X } from 'lucide-react';
import { apiService } from '../../../../services/api.service';
import type { CaseProviderRow } from '../../../../types/case.types';
import type { Provider } from '../../../../types/shareRequest.types';
import Skeleton from '../../ui/Skeleton';
import EmptyState from '../../ui/EmptyState';

interface CaseProvidersTabProps { caseId: string }

interface ListResp { success: boolean; data: CaseProviderRow[] }
interface ProviderSearchResp { success: boolean; data: Provider[] }

const PROVIDER_ROLES = [
  'Primary Provider',
  'Facility',
  'Lab',
  'Specialist',
  'Pharmacy',
  'Imaging',
  'Referring Provider',
  'Surgeon',
  'Anesthesiologist',
  'Emergency',
  'Urgent Care',
  'Other',
];

const CaseProvidersTab = ({ caseId }: CaseProvidersTabProps) => {
  const [providers, setProviders] = useState<CaseProviderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showAdd, setShowAdd] = useState(false);
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<Provider[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<Provider | null>(null);
  const [role, setRole] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const resp = await apiService.get<ListResp>(
        `/api/me/vendor/cases/${caseId}/providers`,
        signal ? { signal } : undefined
      );
      if (signal?.aborted) return;
      if (resp.success) setProviders(resp.data);
      else setError('Failed to load providers');
    } catch (err) {
      if (signal?.aborted) return;
      setError(err instanceof Error ? err.message : 'Failed to load providers');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [caseId]);

  useEffect(() => {
    const ac = new AbortController();
    load(ac.signal);
    return () => ac.abort();
  }, [load]);

  // Debounced provider search (only when modal is open).
  useEffect(() => {
    if (!showAdd) return;
    if (search.length < 2) {
      setSearchResults([]);
      return;
    }
    const ac = new AbortController();
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const resp = await apiService.get<ProviderSearchResp>(
          `/api/me/vendor/providers/search?q=${encodeURIComponent(search)}&limit=10`,
          { signal: ac.signal }
        );
        if (ac.signal.aborted) return;
        if (resp.success) {
          const filtered = resp.data.filter(
            (p) => !providers.some((linked) => linked.ProviderId === p.ProviderId)
          );
          setSearchResults(filtered);
        }
      } catch {
        // ignored — soft fail
      } finally {
        if (!ac.signal.aborted) setSearching(false);
      }
    }, 300);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [search, showAdd, providers]);

  const resetModal = () => {
    setShowAdd(false);
    setSearch('');
    setSearchResults([]);
    setSelected(null);
    setRole('');
  };

  const handleLink = async () => {
    if (!selected) {
      window.alert('Pick a provider first');
      return;
    }
    if (!role) {
      window.alert('Select a role');
      return;
    }
    setSaving(true);
    try {
      await apiService.post(`/api/me/vendor/cases/${caseId}/providers`, {
        providerId: selected.ProviderId,
        providerRole: role,
      });
      resetModal();
      await load();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Failed to link provider');
    } finally {
      setSaving(false);
    }
  };

  const handleUnlink = async (ticketProviderId: string) => {
    if (!window.confirm('Remove this provider from the case?')) return;
    try {
      await apiService.delete(`/api/me/vendor/cases/${caseId}/providers/${ticketProviderId}`);
      await load();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Failed to remove provider');
    }
  };

  return (
    <div className="p-4 sm:p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-900">Providers</h2>
        <button
          type="button"
          onClick={() => setShowAdd(true)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-oe-primary hover:bg-oe-dark rounded-lg transition-colors"
        >
          <Plus className="h-4 w-4" />
          Add provider
        </button>
      </div>

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
        </div>
      ) : error ? (
        <div className="flex items-center gap-2 text-red-600 text-sm">
          <CircleAlert className="h-4 w-4" />
          <span>{error}</span>
        </div>
      ) : providers.length === 0 ? (
        <EmptyState
          icon={Stethoscope}
          title="No providers"
          description="Link a provider to this case."
          tone="subtle"
        />
      ) : (
        <div className="overflow-x-auto bg-white border border-gray-200 rounded-lg">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                <Th>Role</Th>
                <Th>Provider</Th>
                <Th>NPI</Th>
                <Th>Phone</Th>
                <Th>City / State</Th>
                <Th />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 bg-white">
              {providers.map((p) => (
                <tr key={p.CaseProviderId}>
                  <Td>{p.ProviderRole ?? '—'}</Td>
                  <Td className="font-medium text-gray-900">{p.ProviderName ?? '—'}</Td>
                  <Td className="font-mono text-[12px]">{p.NPI ?? '—'}</Td>
                  <Td>{p.Phone ?? '—'}</Td>
                  <Td>{[p.City, p.State].filter(Boolean).join(', ') || '—'}</Td>
                  <Td>
                    <button
                      type="button"
                      onClick={() => handleUnlink(p.CaseProviderId)}
                      className="p-1 text-gray-400 hover:text-red-600 rounded"
                      aria-label="Remove provider"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showAdd && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="add-ticket-provider-title"
          className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 px-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) resetModal();
          }}
        >
          <div className="w-full max-w-lg bg-white rounded-lg shadow-xl p-4 space-y-3 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h3 id="add-ticket-provider-title" className="text-base font-semibold text-gray-900">
                Add provider
              </h3>
              <button
                type="button"
                onClick={resetModal}
                className="p-1 text-gray-400 hover:text-gray-600 rounded"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <Field label="Search providers">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                <input
                  type="search"
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setSelected(null);
                  }}
                  placeholder="Type a provider name (min 2 chars)…"
                  className="w-full pl-9 pr-3 py-1.5 text-sm border border-gray-300 rounded"
                  autoFocus
                />
              </div>
            </Field>

            {searching && <p className="text-xs text-gray-400">Searching…</p>}

            {!selected && searchResults.length > 0 && (
              <ul className="max-h-48 overflow-y-auto border border-gray-200 rounded-lg divide-y divide-gray-100">
                {searchResults.map((p) => (
                  <li key={p.ProviderId}>
                    <button
                      type="button"
                      onClick={() => setSelected(p)}
                      className="w-full text-left px-3 py-2 hover:bg-oe-light/50 text-sm"
                    >
                      <div className="font-medium text-gray-900">{p.ProviderName}</div>
                      <div className="text-xs text-gray-500">
                        {p.NPI && <span className="font-mono mr-2">NPI: {p.NPI}</span>}
                        {[p.City, p.State].filter(Boolean).join(', ')}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {selected && (
              <div className="bg-oe-light/50 border border-oe-light rounded-lg p-3 text-sm">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium text-gray-900">{selected.ProviderName}</div>
                    <div className="text-xs text-gray-500">
                      {selected.NPI && <span className="font-mono mr-2">NPI: {selected.NPI}</span>}
                      {[selected.City, selected.State].filter(Boolean).join(', ')}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSelected(null)}
                    className="text-xs text-gray-500 hover:text-gray-800"
                  >
                    Change
                  </button>
                </div>
              </div>
            )}

            <Field label="Role *">
              <select
                value={role}
                onChange={(e) => setRole(e.target.value)}
                className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded"
              >
                <option value="">Select a role…</option>
                {PROVIDER_ROLES.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </Field>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={resetModal}
                className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 rounded-lg"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleLink}
                disabled={saving || !selected || !role}
                className="px-3 py-1.5 text-sm font-medium text-white bg-oe-primary hover:bg-oe-dark rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {saving ? 'Linking…' : 'Link provider'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const Th = ({ children }: { children?: ReactNode }) => (
  <th className="px-4 py-2 text-left text-[11px] font-medium text-gray-500 uppercase tracking-wider">
    {children}
  </th>
);

const Td = ({ children, className = '' }: { children?: ReactNode; className?: string }) => (
  <td className={`px-4 py-2 text-gray-700 ${className}`}>{children}</td>
);

const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <div>
    <label className="block text-xs font-medium text-gray-500 mb-1">{label}</label>
    {children}
  </div>
);

export default CaseProvidersTab;
