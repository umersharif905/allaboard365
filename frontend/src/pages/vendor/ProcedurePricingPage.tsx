// Procedure Pricing — full pricing explorer for the care team.
// Two-tab finder (Search | Anatomy), filter row (ZIP / radius / state),
// parallel fetch of Medicare PFS breakdown + hospital MRF chargemaster data,
// summary stats, and a detail table. Read-only; nothing persisted.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Calculator, Loader2, MapPin, Search, Stethoscope } from 'lucide-react';
import CptSearchBox, { type CptSuggestion } from '../../components/vendor/pricing/CptSearchBox';
import MedicareBreakdownCard from '../../components/vendor/pricing/MedicareBreakdownCard';
import HospitalPricesTable from '../../components/vendor/pricing/HospitalPricesTable';
import ChargemasterSummaryPanel from '../../components/vendor/pricing/ChargemasterSummaryPanel';
import AnatomySurgerySelector, {
  type ProcedureSelection,
} from '../../components/forms/anatomy/AnatomySurgerySelector';
import { cptPricingService } from '../../services/cpt-pricing.service';
import type { CptPriceResult, HospitalPricesResult } from '../../types/cptPricing.types';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ActiveCode {
  code: string;
  label: string;
}

type ViewMode = 'both' | 'medicare' | 'chargemaster';
type FinderTab = 'search' | 'anatomy';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const US_STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY','DC',
];

// ─── Sub-components ───────────────────────────────────────────────────────────

function FinderTabs({
  active,
  onChange,
}: {
  active: FinderTab;
  onChange: (t: FinderTab) => void;
}) {
  const tabs: { key: FinderTab; label: string }[] = [
    { key: 'search', label: 'Search' },
    { key: 'anatomy', label: 'Anatomy browser' },
  ];
  return (
    <nav className="flex gap-1 border-b border-gray-200 mb-4" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={active === t.key}
          onClick={() => onChange(t.key)}
          className={`px-3 py-2 text-sm font-medium border-b-2 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-oe-primary ${
            active === t.key
              ? 'border-oe-primary text-oe-primary'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          {t.label}
        </button>
      ))}
    </nav>
  );
}

function ViewToggle({
  value,
  onChange,
}: {
  value: ViewMode;
  onChange: (v: ViewMode) => void;
}) {
  const opts: { key: ViewMode; label: string }[] = [
    { key: 'both', label: 'Both' },
    { key: 'medicare', label: 'Medicare only' },
    { key: 'chargemaster', label: 'Chargemaster only' },
  ];
  return (
    <div className="inline-flex rounded-lg border border-gray-300 overflow-hidden text-sm">
      {opts.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => onChange(o.key)}
          className={`px-3 py-1.5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-oe-primary ${
            value === o.key
              ? 'bg-oe-primary text-white font-medium'
              : 'bg-white text-gray-600 hover:bg-gray-50'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function SectionError({ message }: { message: string }) {
  return (
    <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">
      {message}
    </div>
  );
}

function SectionLoader({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-gray-500 py-4">
      <Loader2 className="h-4 w-4 animate-spin" /> {label}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

const ProcedurePricingPage = () => {
  // Finder
  const [finderTab, setFinderTab] = useState<FinderTab>('search');
  const [anatomyValue, setAnatomyValue] = useState<ProcedureSelection | null>(null);

  // Active selected code
  const [active, setActive] = useState<ActiveCode | null>(null);

  // Filters
  const [zip, setZip] = useState('');
  const [radius, setRadius] = useState('50');
  const [state, setState] = useState('');

  // Display mode
  const [viewMode, setViewMode] = useState<ViewMode>('both');

  // Medicare fetch
  const [medicareData, setMedicareData] = useState<CptPriceResult | null>(null);
  const [medicareLoading, setMedicareLoading] = useState(false);
  const [medicareError, setMedicareError] = useState<string | null>(null);

  // Hospital/chargemaster fetch
  const [hospitalData, setHospitalData] = useState<HospitalPricesResult | null>(null);
  const [hospitalLoading, setHospitalLoading] = useState(false);
  const [hospitalError, setHospitalError] = useState<string | null>(null);

  // Debounce ref for filter changes
  const fetchAbortRef = useRef<{ medicare?: AbortController; hospital?: AbortController }>({});

  // Stable filter values (used in fetch)
  const validZip = /^\d{5}$/.test(zip) ? zip : undefined;
  const validRadius = parseInt(radius, 10) > 0 ? parseInt(radius, 10) : 50;
  const validState = /^[A-Z]{2}$/.test(state.toUpperCase()) ? state.toUpperCase() : undefined;

  const fetchAll = useCallback(
    async (code: string, opts: { zip?: string; radius: number; state?: string }) => {
      // Cancel any in-flight requests
      fetchAbortRef.current.medicare?.abort();
      fetchAbortRef.current.hospital?.abort();

      setMedicareData(null);
      setHospitalData(null);
      setMedicareError(null);
      setHospitalError(null);
      setMedicareLoading(true);
      setHospitalLoading(true);

      // Parallel fetches
      const medicarePromise = cptPricingService
        .getCptPrice(code, { zip: opts.zip })
        .then((res) => {
          setMedicareData(res);
          if (!res.found) setMedicareError(`No Medicare pricing found for ${code}.`);
        })
        .catch((e: Error) => setMedicareError(e.message))
        .finally(() => setMedicareLoading(false));

      const hospitalPromise = cptPricingService
        .getHospitalPrices(code, {
          zip: opts.zip,
          radius: opts.radius,
          state: opts.state,
          limit: 50,
        })
        .then((res) => setHospitalData(res))
        .catch((e: Error) => setHospitalError(e.message))
        .finally(() => setHospitalLoading(false));

      await Promise.allSettled([medicarePromise, hospitalPromise]);
    },
    []
  );

  // Re-fetch whenever active code or filters change
  useEffect(() => {
    if (!active) return;
    fetchAll(active.code, { zip: validZip, radius: validRadius, state: validState });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.code, validZip, validRadius, validState]);

  // Handle selection from the Search tab
  const handleSearchSelect = (s: CptSuggestion) => {
    const code = s.code.split('-')[0];
    setActive({ code, label: s.description || s.code });
  };

  // Handle selection from the Anatomy tab
  const handleAnatomyChange = (v: ProcedureSelection | null) => {
    setAnatomyValue(v);
    if (!v) return;
    if (v.cptCodes.length > 0) {
      const code = v.cptCodes[0].split('-')[0];
      setActive({ code, label: v.procedureName });
    } else {
      // Manual / no CPT — show note but don't trigger lookup
      setActive(null);
    }
  };

  const showMedicare = viewMode === 'both' || viewMode === 'medicare';
  const showChargemaster = viewMode === 'both' || viewMode === 'chargemaster';

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
          <Calculator className="h-6 w-6 text-oe-primary" />
          Procedure Pricing
        </h1>
        <p className="mt-1 text-sm text-gray-600">
          Look up Medicare rates, target negotiation ranges (150%–200% of Medicare), and nearby hospital
          chargemaster prices for any procedure or billing code.
        </p>
      </div>

      {/* Finder card */}
      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <FinderTabs active={finderTab} onChange={setFinderTab} />

        {finderTab === 'search' && (
          <div className="space-y-2">
            <label className="block text-xs font-medium text-gray-500">
              <Search className="inline h-3.5 w-3.5 mr-1" />
              Procedure name or CPT / HCPCS / DRG code
            </label>
            <CptSearchBox onSelect={handleSearchSelect} zip={validZip} />
          </div>
        )}

        {finderTab === 'anatomy' && (
          <div className="space-y-2">
            <AnatomySurgerySelector
              value={anatomyValue}
              onChange={handleAnatomyChange}
              label="Select a procedure by body area"
            />
            {finderTab === 'anatomy' &&
              anatomyValue &&
              anatomyValue.cptCodes.length === 0 && (
                <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  No CPT code for "{anatomyValue.procedureName}" — pick a coded procedure from the list to see pricing.
                </p>
              )}
          </div>
        )}
      </div>

      {/* Filters row */}
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">
              <MapPin className="inline h-3.5 w-3.5 mr-0.5" />
              ZIP code
            </label>
            <input
              type="text"
              value={zip}
              onChange={(e) => setZip(e.target.value.replace(/\D/g, '').slice(0, 5))}
              placeholder="e.g. 28202"
              className="w-28 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-transparent"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Radius (miles)</label>
            <select
              value={radius}
              onChange={(e) => setRadius(e.target.value)}
              className="w-28 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-transparent bg-white"
            >
              <option value="25">25 mi</option>
              <option value="50">50 mi</option>
              <option value="100">100 mi</option>
              <option value="200">200 mi</option>
              <option value="500">500 mi</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">State (optional)</label>
            <select
              value={state}
              onChange={(e) => setState(e.target.value)}
              className="w-28 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-transparent bg-white"
            >
              <option value="">All states</option>
              {US_STATES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
        </div>
        <p className="mt-2 text-xs text-gray-400">
          ZIP adjusts Medicare to local costs and ranks hospitals by distance. Leave empty for national rates.
        </p>
      </div>

      {/* Empty state before a code is chosen */}
      {!active && (
        <div className="flex flex-col items-center justify-center py-16 text-center text-gray-400 space-y-3">
          <Stethoscope className="h-10 w-10 text-gray-300" />
          <p className="text-sm">
            Search for a procedure or browse by anatomy to see Medicare and chargemaster pricing.
          </p>
        </div>
      )}

      {/* Results */}
      {active && (
        <>
          {/* Active code label + view toggle */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs text-gray-500 uppercase tracking-wide font-medium">Selected procedure</p>
              <p className="text-sm font-semibold text-gray-900">
                {active.code}
                {active.label && active.label !== active.code && (
                  <span className="font-normal text-gray-600"> — {active.label}</span>
                )}
              </p>
            </div>
            <ViewToggle value={viewMode} onChange={setViewMode} />
          </div>

          {/* Medicare section */}
          {showMedicare && (
            <section>
              <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-3">
                Medicare / PFS pricing
              </h2>
              {medicareLoading && <SectionLoader label={`Loading Medicare pricing for ${active.code}…`} />}
              {medicareError && !medicareLoading && <SectionError message={medicareError} />}
              {medicareData?.found && !medicareLoading && (
                <MedicareBreakdownCard
                  code={medicareData.code}
                  description={medicareData.description}
                  locality={medicareData.locality}
                  zip={medicareData.zip}
                  headlineSite={medicareData.headlineSite}
                  medicareTotal={medicareData.medicareTotal}
                  targetMin={medicareData.targetMin}
                  targetMax={medicareData.targetMax}
                  totals={medicareData.totals}
                  sections={medicareData.sections}
                />
              )}
            </section>
          )}

          {/* Chargemaster section */}
          {showChargemaster && (
            <section>
              <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-3">
                Chargemaster / hospital MRF pricing
              </h2>
              {hospitalLoading && <SectionLoader label={`Loading hospital prices for ${active.code}…`} />}
              {hospitalError && !hospitalLoading && <SectionError message={hospitalError} />}
              {!hospitalLoading && !hospitalError && hospitalData && (
                <div className="space-y-4">
                  {hospitalData.results.length > 0 ? (
                    <>
                      <ChargemasterSummaryPanel rows={hospitalData.results} code={active.code} />
                      <div className="bg-white rounded-lg border border-gray-200 p-6">
                        <h3 className="text-sm font-semibold text-gray-900 mb-3">
                          Hospital price detail
                        </h3>
                        <HospitalPricesTable
                          code={active.code}
                          data={hospitalData}
                        />
                      </div>
                    </>
                  ) : (
                    <p className="text-sm text-gray-500 py-4">
                      No hospital MRF data found for {active.code}
                      {validZip ? ` near ${validZip}` : ''}
                      {validState ? ` in ${validState}` : ''}.
                    </p>
                  )}
                </div>
              )}
              {!hospitalLoading && !hospitalError && !hospitalData && (
                <p className="text-sm text-gray-500 py-4">
                  No hospital price data available yet.
                </p>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
};

export default ProcedurePricingPage;
