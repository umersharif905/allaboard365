// CaseProviderPicker — unified provider search for the Add Bill flow on Cases.
//
// Copied from share-requests/ProviderPicker (duplication is intentional — Case
// and Share Request finances diverge; see docs/billing-rework/case-finances-design.md).
// The only behavioral difference is the link endpoint: providers are linked to
// the CASE via /api/me/vendor/cases/:id/providers.

import { useEffect, useState } from 'react';
import { MapPin, Search, Stethoscope, UserPlus } from 'lucide-react';
import { apiService } from '../../../services/api.service';
import type { Provider } from '../../../types/shareRequest.types';
import type { CaseProviderRow } from '../../../types/case.types';
import CreateProviderModal from '../providers/CreateProviderModal';

// Full US state/territory names — used only to render the live "interpreted as"
// hint for the location box (the backend does the authoritative resolution).
const US_STATE_NAMES = new Set([
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut',
  'delaware', 'district of columbia', 'florida', 'georgia', 'hawaii', 'idaho', 'illinois',
  'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana', 'maine', 'maryland', 'massachusetts',
  'michigan', 'minnesota', 'mississippi', 'missouri', 'montana', 'nebraska', 'nevada',
  'new hampshire', 'new jersey', 'new mexico', 'new york', 'north carolina', 'north dakota',
  'ohio', 'oklahoma', 'oregon', 'pennsylvania', 'rhode island', 'south carolina',
  'south dakota', 'tennessee', 'texas', 'utah', 'vermont', 'virginia', 'washington',
  'west virginia', 'wisconsin', 'wyoming', 'puerto rico', 'guam', 'virgin islands',
]);

interface NpiResult {
  npi?: string;
  providerName?: string;
  providerType?: string;
  specialty?: string;
  address1?: string;
  address2?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  phone?: string;
  fax?: string;
}

interface ProviderSearchResponse {
  success: boolean;
  data: Provider[];
}

interface NpiSearchResponse {
  success: boolean;
  data: NpiResult[];
}

interface CaseProviderPickerProps {
  caseId: string;
  /** Providers already linked to this case (to skip in results). */
  linkedProviders: CaseProviderRow[];
  /** Called after a provider is linked + should be selected for the bill. */
  onPicked: (providerId: string) => void;
  /** Ask the parent to refetch its linked-provider list. */
  onLinkedChanged: () => Promise<void> | void;
}

const CaseProviderPicker = ({
  caseId,
  linkedProviders,
  onPicked,
  onLinkedChanged,
}: CaseProviderPickerProps) => {
  const [query, setQuery] = useState('');
  // Optional location filter for the NPI registry search — ZIP, city, or state.
  const [location, setLocation] = useState('');

  const [dbResults, setDbResults] = useState<Provider[]>([]);
  const [searchingDb, setSearchingDb] = useState(false);

  const [npiResults, setNpiResults] = useState<NpiResult[] | null>(null); // null = not searched yet
  const [searchingNpi, setSearchingNpi] = useState(false);
  const [npiError, setNpiError] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [showManual, setShowManual] = useState(false);

  const linkedIds = new Set(linkedProviders.map((p) => p.ProviderId));

  useEffect(() => {
    setNpiResults(null);
    setNpiError(null);
    if (query.trim().length < 2) {
      setDbResults([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setSearchingDb(true);
      try {
        const res = await apiService.get<ProviderSearchResponse>(
          `/api/me/vendor/providers/search?q=${encodeURIComponent(query)}&limit=10`,
          { signal: controller.signal }
        );
        if (controller.signal.aborted) return;
        if (res.success) setDbResults(res.data.filter((p) => !linkedIds.has(p.ProviderId)));
      } catch {
        // best-effort
      } finally {
        if (!controller.signal.aborted) setSearchingDb(false);
      }
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, caseId]);

  const linkAndPick = async (providerId: string, alreadyLinked: boolean) => {
    setBusy(true);
    try {
      if (!alreadyLinked) {
        await apiService.post(`/api/me/vendor/cases/${caseId}/providers`, {
          providerId,
          providerRole: 'Provider',
        });
        await onLinkedChanged();
      }
      onPicked(providerId);
      setQuery('');
      setDbResults([]);
      setNpiResults(null);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Failed to attach provider');
    } finally {
      setBusy(false);
    }
  };

  const searchNpi = async () => {
    if (query.trim().length < 2) return;
    setSearchingNpi(true);
    setNpiError(null);
    try {
      const params = new URLSearchParams({ q: query.trim(), limit: '15' });
      if (location.trim()) params.set('location', location.trim());
      const res = await apiService.get<NpiSearchResponse>(
        `/api/me/vendor/npi/search?${params.toString()}`
      );
      setNpiResults(res.success ? res.data : []);
    } catch (err) {
      setNpiResults([]);
      setNpiError(err instanceof Error ? err.message : 'NPI search failed');
    } finally {
      setSearchingNpi(false);
    }
  };

  const createFromNpiAndPick = async (r: NpiResult) => {
    setBusy(true);
    try {
      const res = await apiService.post<{ success: boolean; data?: { providerId: string }; message?: string }>(
        '/api/me/vendor/providers',
        {
          providerName: r.providerName,
          providerType: r.providerType || null,
          npi: r.npi || null,
          specialty: r.specialty || null,
          phone: r.phone || null,
          fax: r.fax || null,
          address1: r.address1 || null,
          address2: r.address2 || null,
          city: r.city || null,
          state: r.state || null,
          zipCode: r.zipCode || null,
          isActive: true,
        }
      );
      if (!res.success || !res.data?.providerId) {
        throw new Error(res.message || 'Failed to create provider');
      }
      await linkAndPick(res.data.providerId, false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to create provider';
      window.alert(
        /already exists|duplicate/i.test(msg)
          ? `${msg}\n\nIt's already in your directory — search for it by name above.`
          : msg
      );
    } finally {
      setBusy(false);
    }
  };

  const handleManualCreated = async (provider: Provider) => {
    setShowManual(false);
    await linkAndPick(provider.ProviderId, false);
  };

  const hasQuery = query.trim().length >= 2;

  const locationHint = (() => {
    const loc = location.trim();
    if (!loc) return null;
    if (/^\d{5}$/.test(loc)) return `ZIP ${loc} (exact)`;
    if (/^\d{1,4}$/.test(loc)) return `ZIP starting ${loc}…`;
    if (/^[A-Za-z]{2}$/.test(loc)) return `state ${loc.toUpperCase()}`;
    if (US_STATE_NAMES.has(loc.toLowerCase())) return `state ${loc}`;
    return `city “${loc}”`;
  })();

  return (
    <div className="space-y-2">
      {/* Already-linked providers (quick select) */}
      {linkedProviders.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {linkedProviders.map((p) => (
            <button
              key={p.CaseProviderId}
              type="button"
              disabled={busy}
              onClick={() => onPicked(p.ProviderId)}
              className="px-2.5 py-1 text-xs rounded-full border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              {p.ProviderName}
            </button>
          ))}
        </div>
      )}

      {/* Single unified search box */}
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search provider by name, organization, or NPI…"
          className="w-full pl-8 pr-2 py-1.5 text-sm border border-gray-300 rounded"
        />
      </div>

      {hasQuery && (
        <div className="border border-gray-200 rounded-lg divide-y divide-gray-100 overflow-hidden">
          {/* DB results */}
          <div className="bg-gray-50 px-3 py-1 text-[11px] font-medium uppercase tracking-wider text-gray-500">
            Your providers
          </div>
          {searchingDb ? (
            <div className="px-3 py-2 text-sm text-gray-500">Searching…</div>
          ) : dbResults.length === 0 ? (
            <div className="px-3 py-2 text-sm text-gray-500">No matches in your directory.</div>
          ) : (
            dbResults.map((p) => (
              <button
                key={p.ProviderId}
                type="button"
                disabled={busy}
                onClick={() => linkAndPick(p.ProviderId, linkedIds.has(p.ProviderId))}
                className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 disabled:opacity-50 flex items-center gap-2"
              >
                <Stethoscope className="h-3.5 w-3.5 text-gray-400 shrink-0" />
                <span>
                  <span className="font-medium text-gray-900">{p.ProviderName}</span>
                  {(p.City || p.State || p.NPI) && (
                    <span className="text-gray-500">
                      {' — '}
                      {[p.City, p.State].filter(Boolean).join(', ')}
                      {p.NPI ? ` · NPI ${p.NPI}` : ''}
                    </span>
                  )}
                </span>
              </button>
            ))
          )}

          {/* NPI registry section */}
          <div className="bg-gray-50 px-3 py-2 space-y-2">
            <div className="text-[11px] font-medium uppercase tracking-wider text-gray-500">
              National NPI registry
            </div>
            <div className="flex items-center gap-2">
              <div className="relative w-40 shrink-0">
                <MapPin className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
                <input
                  type="text"
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') searchNpi(); }}
                  placeholder="ZIP, city, or state"
                  title="Narrow by ZIP (full or partial), city, or state (2-letter code or full name)"
                  className="w-full pl-7 pr-2 py-1.5 text-sm border border-gray-300 rounded"
                />
              </div>
              <button
                type="button"
                onClick={searchNpi}
                disabled={searchingNpi || busy || query.trim().length < 2}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-sm font-medium text-white bg-oe-primary hover:bg-oe-dark rounded disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Search className="h-3.5 w-3.5" />
                {searchingNpi ? 'Searching…' : npiResults === null ? 'Search registry' : 'Re-search'}
              </button>
            </div>
            {locationHint ? (
              <p className="text-xs text-gray-500">Filtering by {locationHint}.</p>
            ) : (
              <p className="text-xs text-gray-400">
                Optional: add a ZIP, city, or state (e.g. <span className="font-medium">WY</span> or{' '}
                <span className="font-medium">Wyoming</span>) to narrow a common name.
              </p>
            )}
            {npiResults === null && !searchingNpi && (
              <p className="text-xs text-gray-500">
                Not in your directory? Search the national registry for “{query.trim()}”
                {' '}(add a ZIP or city to narrow a common name).
              </p>
            )}
          </div>
          {npiResults !== null && (
            <>
              {searchingNpi ? (
                <div className="px-3 py-2 text-sm text-gray-500">Searching…</div>
              ) : npiError ? (
                <div className="px-3 py-2 text-sm text-red-600">{npiError}</div>
              ) : npiResults.length === 0 ? (
                <div className="px-3 py-2 text-sm text-gray-500">
                  No registry matches{location.trim() ? ' — try removing or changing the location.' : '.'}
                </div>
              ) : (
                npiResults.map((r, i) => (
                  <button
                    key={`${r.npi}-${i}`}
                    type="button"
                    disabled={busy}
                    onClick={() => createFromNpiAndPick(r)}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 disabled:opacity-50"
                  >
                    <span className="font-medium text-gray-900">{r.providerName}</span>
                    <span className="text-gray-500">
                      {(r.city || r.state) && ` — ${[r.city, r.state].filter(Boolean).join(', ')}`}
                      {r.specialty ? ` · ${r.specialty}` : ''}
                      {r.npi ? ` · NPI ${r.npi}` : ''}
                    </span>
                  </button>
                ))
              )}
            </>
          )}
        </div>
      )}

      {/* Manual entry fallback */}
      <button
        type="button"
        onClick={() => setShowManual(true)}
        disabled={busy}
        className="inline-flex items-center gap-1 px-2.5 py-1.5 text-sm font-medium text-gray-600 hover:text-gray-900 disabled:opacity-50"
      >
        <UserPlus className="h-4 w-4" />
        Enter provider manually
      </button>

      <CreateProviderModal
        isOpen={showManual}
        onClose={() => setShowManual(false)}
        onCreated={handleManualCreated}
        initialName={query.trim()}
      />
    </div>
  );
};

export default CaseProviderPicker;
