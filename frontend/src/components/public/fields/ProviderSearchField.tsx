// frontend/src/components/public/fields/ProviderSearchField.tsx
// Public-form widget: search the NPI registry for a provider, or enter one manually.

import { useEffect, useState } from 'react';
import { ChevronDown, Search, Stethoscope } from 'lucide-react';
import type { FieldDef } from '../../../types/publicFormDefinition';
import type { NpiProvider, ProviderFieldValue, PriorProvider } from '../../../types/providerSearch';
import { priorToProviderValue } from '../../../types/providerSearch';
import { findCoLocatedProviders, searchPublicProviders } from '../../../services/npiPublicSearch.service';
import { isProviderValue, formatProviderValue } from '../../../utils/providerFieldValue';

type Props = {
  field: FieldDef;
  formId?: string;
  value: unknown;
  onChange: (v: ProviderFieldValue | undefined) => void;
  disabled?: boolean;
  /** The doctor selected elsewhere on the form — drives the co-located suggestion. */
  linkedProvider?: ProviderFieldValue;
  /** Providers the signed-in member's household has used before. */
  priorProviders?: PriorProvider[];
};

const US_ZIP = /^\d{5}$/;

export default function ProviderSearchField({ field, formId, value, onChange, disabled, linkedProvider, priorProviders }: Props) {
  const mode = field.providerSearchMode || 'individual';
  const nameLabel =
    mode === 'organization'
      ? 'Hospital / facility name'
      : mode === 'both'
        ? 'Provider or facility name'
        : 'Provider last name';

  const [name, setName] = useState('');
  const [zip, setZip] = useState('');
  const [results, setResults] = useState<NpiProvider[]>([]);
  const [searching, setSearching] = useState(false);
  const [widened, setWidened] = useState(false);
  const [error, setError] = useState('');
  const [manualOpen, setManualOpen] = useState(false);
  const [manual, setManual] = useState({
    name: '', providerType: '', npi: '', phone: '', fax: '',
    address1: '', address2: '', city: '', state: '', zip: ''
  });
  const [coLocated, setCoLocated] = useState<NpiProvider[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // The doctor's practice address, when a registry doctor is linked.
  const doctorAddr =
    linkedProvider && linkedProvider.source === 'registry' && linkedProvider.address1 && linkedProvider.zip
      ? { npi: linkedProvider.npi, address1: linkedProvider.address1, zip: linkedProvider.zip }
      : null;

  const selected = isProviderValue(value) ? value : null;

  useEffect(() => {
    if (mode !== 'organization' || !formId || selected || !doctorAddr) {
      setCoLocated([]);
      return;
    }
    let alive = true;
    findCoLocatedProviders({ formId, address1: doctorAddr.address1, zip: doctorAddr.zip })
      .then((res) => {
        if (alive) setCoLocated(res.data || []);
      })
      .catch(() => {
        if (alive) setCoLocated([]);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, formId, !!selected, doctorAddr?.npi, doctorAddr?.address1, doctorAddr?.zip]);
  const canSearch = !!formId && !disabled && name.trim().length > 0 && US_ZIP.test(zip.trim());

  const runSearch = async () => {
    if (!canSearch || !formId) return;
    setSearching(true);
    setError('');
    setResults([]);
    try {
      const res = await searchPublicProviders({
        formId,
        mode,
        lastName: mode !== 'organization' ? name.trim() : undefined,
        organizationName: mode !== 'individual' ? name.trim() : undefined,
        zip: zip.trim()
      });
      setWidened(!!res.widened);
      setResults(res.data || []);
      if (!res.data || res.data.length === 0) {
        setError('No providers found. Try a different spelling, or enter your provider manually below.');
      }
    } catch {
      setError('Provider search is unavailable right now. You can enter your provider manually below.');
    } finally {
      setSearching(false);
    }
  };

  const submitManual = () => {
    if (!manual.name.trim()) return;
    onChange({
      source: 'manual',
      name: manual.name.trim(),
      providerType: manual.providerType.trim() || undefined,
      npi: manual.npi.trim() || undefined,
      phone: manual.phone.trim() || undefined,
      fax: manual.fax.trim() || undefined,
      address1: manual.address1.trim() || undefined,
      address2: manual.address2.trim() || undefined,
      city: manual.city.trim() || undefined,
      state: manual.state.trim() || undefined,
      zip: manual.zip.trim() || undefined
    });
  };

  if (selected) {
    return (
      <div className="border border-oe-primary/40 rounded-lg bg-oe-light/40 p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-start gap-2">
            <Stethoscope className="h-4 w-4 text-oe-primary mt-0.5 shrink-0" />
            <div className="text-sm text-slate-800">{formatProviderValue(selected)}</div>
          </div>
          {!disabled && (
            <button
              type="button"
              onClick={() => onChange(undefined)}
              className="text-xs text-oe-primary hover:underline shrink-0"
            >
              Change
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {!disabled && priorProviders && priorProviders.length > 0 && (
        <div className="border border-oe-light rounded-lg bg-oe-light/30 p-2 space-y-1">
          <p className="text-xs font-medium text-oe-dark">Your providers</p>
          {priorProviders.map((p, i) => (
            <button
              key={`${p.npi || p.name}-${i}`}
              type="button"
              onClick={() => onChange(priorToProviderValue(p))}
              className="block w-full px-2 py-1.5 text-left rounded hover:bg-oe-light text-sm"
            >
              <span className="font-medium text-gray-900">{p.name}</span>
              {(p.city || p.state) && (
                <span className="text-xs text-gray-500">
                  {' '}· {p.city}{p.city && p.state ? ', ' : ''}{p.state}
                </span>
              )}
              {p.role && <span className="text-xs text-oe-dark"> · {p.role}</span>}
            </button>
          ))}
        </div>
      )}
      {coLocated.length > 0 && (
        <div className="border border-oe-primary/30 rounded-lg bg-oe-light/30 p-2 space-y-1">
          <p className="text-xs font-medium text-oe-primary">Facilities at your provider's office</p>
          {coLocated.map((r) => {
            const depts = r.departments || [];
            const isOpen = expanded.has(r.npi);
            return (
              <div key={r.npi} className="rounded">
                <div className="flex items-center flex-wrap gap-x-2 gap-y-0.5">
                  <button
                    type="button"
                    onClick={() => onChange({ ...r, departments: undefined })}
                    className="px-2 py-1.5 text-left rounded hover:bg-oe-light text-sm"
                  >
                    <span className="font-medium text-gray-900">{r.name}</span>
                    {(r.city || r.state) && (
                      <span className="text-xs text-gray-500"> · {r.city}{r.city && r.state ? ', ' : ''}{r.state}</span>
                    )}
                  </button>
                  {depts.length > 0 && (
                    <button
                      type="button"
                      onClick={() =>
                        setExpanded((prev) => {
                          const next = new Set(prev);
                          if (next.has(r.npi)) next.delete(r.npi);
                          else next.add(r.npi);
                          return next;
                        })
                      }
                      aria-expanded={isOpen}
                      title={isOpen ? 'Hide departments' : 'Show departments'}
                      className="inline-flex items-center gap-1 shrink-0 rounded-full border border-oe-primary/40 bg-white px-2 py-0.5 text-xs text-oe-primary hover:bg-oe-light focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oe-primary/40"
                    >
                      <span>{depts.length} departments</span>
                      <ChevronDown
                        className={`h-3 w-3 transition-transform ${isOpen ? 'rotate-180' : ''}`}
                        aria-hidden="true"
                      />
                    </button>
                  )}
                </div>
                {isOpen && depts.length > 0 && (
                  <div className="pl-3 pt-0.5 space-y-0.5">
                    {depts.map((dept) => (
                      <button
                        key={dept.npi}
                        type="button"
                        onClick={() =>
                          onChange({
                            ...r,
                            npi: dept.npi,
                            specialty: dept.specialty ?? r.specialty,
                            providerType: dept.providerType ?? r.providerType,
                            departments: undefined
                          })
                        }
                        className="w-full px-2 py-1 text-left text-xs text-gray-700 hover:bg-oe-light rounded"
                      >
                        <span className="text-gray-400">·</span> {dept.specialty || 'Provider'}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <input
          type="text"
          className="sm:col-span-2 w-full border border-slate-300 rounded px-2 py-2 text-sm"
          placeholder={nameLabel}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              runSearch();
            }
          }}
          disabled={disabled}
        />
        <input
          type="text"
          inputMode="numeric"
          maxLength={5}
          className="w-full border border-slate-300 rounded px-2 py-2 text-sm"
          placeholder="Your ZIP code"
          value={zip}
          onChange={(e) => setZip(e.target.value.replace(/\D/g, ''))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              runSearch();
            }
          }}
          disabled={disabled}
        />
      </div>

      <button
        type="button"
        onClick={runSearch}
        disabled={!canSearch || searching}
        className="w-full px-4 py-2 bg-oe-primary text-white rounded hover:bg-oe-dark disabled:opacity-50 flex items-center justify-center gap-2 text-sm"
      >
        {searching ? (
          <>
            <span className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full" />
            Searching…
          </>
        ) : (
          <>
            <Search className="h-4 w-4" />
            Search
          </>
        )}
      </button>

      {!formId && (
        <p className="text-xs text-slate-400">Provider search is available on the live form.</p>
      )}

      {widened && results.length > 0 && (
        <p className="text-xs text-slate-500">
          No exact matches in {zip} — showing providers in the surrounding area.
        </p>
      )}

      {results.length > 0 && (
        <div className="border border-oe-primary/30 rounded-lg max-h-64 overflow-y-auto bg-white">
          <div className="sticky top-0 bg-oe-light px-3 py-1.5 text-xs text-oe-primary font-medium border-b border-oe-primary/30">
            {results.length} result{results.length !== 1 ? 's' : ''} — tap to select
          </div>
          {results.map((r) => (
            <button
              key={r.npi}
              type="button"
              onClick={() => onChange(r)}
              className="w-full px-3 py-2.5 text-left hover:bg-oe-light border-b border-gray-100 last:border-0"
            >
              <div className="flex justify-between items-start gap-2">
                <span className="font-medium text-gray-900">{r.name}</span>
                <span className="font-mono text-xs text-oe-primary bg-oe-light px-2 py-0.5 rounded shrink-0">
                  {r.npi}
                </span>
              </div>
              <div className="text-xs text-gray-500 mt-0.5">
                {r.providerType && (
                  <span className="inline-block bg-gray-100 text-gray-700 px-1.5 py-0.5 rounded mr-2">
                    {r.providerType}
                  </span>
                )}
                {r.specialty}
              </div>
              {(r.address1 || r.city || r.state) && (
                <div className="text-xs text-gray-400 mt-1">
                  {r.address1 ? `${r.address1}, ` : ''}
                  {r.city ? `${r.city}, ` : ''}
                  {r.state} {r.zip}
                </div>
              )}
            </button>
          ))}
        </div>
      )}

      {error && <p className="text-xs text-amber-700">{error}</p>}

      <div>
        <button
          type="button"
          onClick={() => setManualOpen((o) => !o)}
          className="text-xs text-oe-primary hover:underline"
          disabled={disabled}
        >
          {manualOpen ? 'Hide manual entry' : "Can't find your provider? Enter it manually"}
        </button>
      </div>

      {manualOpen && (
        <div className="border border-slate-200 rounded-lg p-3 space-y-2 bg-slate-50">
          <input
            type="text"
            className="w-full border border-slate-300 rounded px-2 py-2 text-sm"
            placeholder="Provider / facility name"
            value={manual.name}
            onChange={(e) => setManual({ ...manual, name: e.target.value })}
            disabled={disabled}
          />
          <div className="grid grid-cols-2 gap-2">
            <select
              aria-label="Provider type"
              className="w-full border border-slate-300 rounded px-2 py-2 text-sm bg-white"
              value={manual.providerType}
              onChange={(e) => setManual({ ...manual, providerType: e.target.value })}
              disabled={disabled}
            >
              <option value="">Provider type…</option>
              {['Physician', 'Hospital', 'Clinic', 'Lab', 'Imaging', 'Pharmacy', 'Nurse Practitioner', 'Specialist', 'Facility', 'Other'].map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
            <input
              type="text"
              inputMode="numeric"
              maxLength={10}
              className="w-full border border-slate-300 rounded px-2 py-2 text-sm"
              placeholder="NPI number (if you have it)"
              value={manual.npi}
              onChange={(e) => setManual({ ...manual, npi: e.target.value.replace(/\D/g, '') })}
              disabled={disabled}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <input
              type="tel"
              className="w-full border border-slate-300 rounded px-2 py-2 text-sm"
              placeholder="Phone"
              value={manual.phone}
              onChange={(e) => setManual({ ...manual, phone: e.target.value })}
              disabled={disabled}
            />
            <input
              type="tel"
              className="w-full border border-slate-300 rounded px-2 py-2 text-sm"
              placeholder="Fax"
              value={manual.fax}
              onChange={(e) => setManual({ ...manual, fax: e.target.value })}
              disabled={disabled}
            />
          </div>
          <input
            type="text"
            className="w-full border border-slate-300 rounded px-2 py-2 text-sm"
            placeholder="Street address (optional)"
            value={manual.address1}
            onChange={(e) => setManual({ ...manual, address1: e.target.value })}
            disabled={disabled}
          />
          <input
            type="text"
            className="w-full border border-slate-300 rounded px-2 py-2 text-sm"
            placeholder="Suite, unit, floor (optional)"
            value={manual.address2}
            onChange={(e) => setManual({ ...manual, address2: e.target.value })}
            disabled={disabled}
          />
          <div className="grid grid-cols-3 gap-2">
            <input
              type="text"
              className="w-full border border-slate-300 rounded px-2 py-2 text-sm"
              placeholder="City"
              value={manual.city}
              onChange={(e) => setManual({ ...manual, city: e.target.value })}
              disabled={disabled}
            />
            <input
              type="text"
              maxLength={2}
              className="w-full border border-slate-300 rounded px-2 py-2 text-sm uppercase"
              placeholder="State"
              value={manual.state}
              onChange={(e) => setManual({ ...manual, state: e.target.value.toUpperCase() })}
              disabled={disabled}
            />
            <input
              type="text"
              inputMode="numeric"
              maxLength={5}
              className="w-full border border-slate-300 rounded px-2 py-2 text-sm"
              placeholder="ZIP"
              value={manual.zip}
              onChange={(e) => setManual({ ...manual, zip: e.target.value.replace(/\D/g, '') })}
              disabled={disabled}
            />
          </div>
          <button
            type="button"
            onClick={submitManual}
            disabled={disabled || !manual.name.trim()}
            className="w-full px-4 py-2 border border-oe-primary text-oe-primary rounded hover:bg-oe-light disabled:opacity-50 text-sm"
          >
            Use this provider
          </button>
        </div>
      )}
    </div>
  );
}
