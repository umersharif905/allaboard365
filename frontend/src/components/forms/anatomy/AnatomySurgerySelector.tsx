// frontend/src/components/forms/anatomy/AnatomySurgerySelector.tsx
// Member-facing procedure selector: 3-step drill-down navigator.
// Step 1 — "Where is it?" (choose a body area or "Something else")
// Step 2 — "What part?"   (choose a sub-region within that area)
// Step 3 — "Which procedure?" (choose from a grouped <select>)
// No CPT codes are ever shown to the member.

import { useState, useEffect, useMemo, type ChangeEvent } from 'react';
import { ChevronDown, ChevronRight, CheckCircle, RotateCcw, Search, Pencil, X } from 'lucide-react';
import SvgRegionPicker from './SvgRegionPicker';
import { ANATOMY_SVGS } from './svgRegistry';
import { ANATOMY_IMAGES, VIEW_REGION_COLORS, COLOR_BADGE_BG } from './anatomyImages';
import type { BodyArea, SubRegion, SurgeryOption } from '../../../data/surgeryTaxonomy';
import { BODY_AREAS, OTHER_GROUPS, subRegionById } from '../../../data/surgeryTaxonomy';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface ProcedureSelection {
  region: string;       // subRegion id
  procedureName: string;
  cptCodes: string[];
}

export interface AnatomySurgerySelectorProps {
  value?: ProcedureSelection | null;
  onChange: (v: ProcedureSelection | null) => void;
  disabled?: boolean;
  label?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Group SurgeryOptions by subGroup, preserving insertion order. */
function groupBySubGroup(options: SurgeryOption[]): Map<string, SurgeryOption[]> {
  const map = new Map<string, SurgeryOption[]>();
  for (const opt of options) {
    const key = opt.subGroup ?? '';
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(opt);
  }
  return map;
}

/** "Something else" sentinel — identifies the OTHER_GROUPS path. */
const OTHER_AREA_ID = '__other__';

// ─── Sub-components ───────────────────────────────────────────────────────────

/** Breadcrumb + Back bar shown at the top of steps 2 and 3. */
function Breadcrumb({
  areaLabel,
  subRegionLabel,
  onBackToAreas,
  onBackToSubRegions,
  disabled,
}: {
  areaLabel: string;
  subRegionLabel?: string;
  onBackToAreas: () => void;
  onBackToSubRegions?: () => void;
  disabled: boolean;
}) {
  return (
    <nav aria-label="Selection breadcrumb" className="flex items-center gap-1 text-sm flex-wrap">
      <button
        type="button"
        disabled={disabled}
        onClick={onBackToAreas}
        className="text-oe-primary hover:text-oe-dark hover:underline font-medium disabled:opacity-50 disabled:cursor-not-allowed"
      >
        Body area
      </button>
      <ChevronRight size={14} className="text-gray-400 shrink-0" />
      {subRegionLabel ? (
        <>
          <button
            type="button"
            disabled={disabled}
            onClick={onBackToSubRegions}
            className="text-oe-primary hover:text-oe-dark hover:underline font-medium disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {areaLabel}
          </button>
          <ChevronRight size={14} className="text-gray-400 shrink-0" />
          <span className="text-gray-700 font-medium">{subRegionLabel}</span>
        </>
      ) : (
        <span className="text-gray-700 font-medium">{areaLabel}</span>
      )}
    </nav>
  );
}

/** Reference image with a graceful fallback when the file isn't present yet. */
function RefImage({ src, alt }: { src?: string; alt: string }) {
  const [errored, setErrored] = useState(false);
  if (!src || errored) {
    return (
      <div className="flex items-center justify-center rounded-lg border border-dashed border-gray-300 bg-gray-50 text-xs text-gray-400 text-center p-6 min-h-[10rem]">
        {src ? `Add image at public${src}` : 'No image yet'}
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      onError={() => setErrored(true)}
      className="max-h-[60vh] w-auto max-w-full object-contain rounded-lg border border-gray-200 bg-white"
    />
  );
}

/** Right-hand visual: clickable SVG if registered, otherwise the reference image. */
function Visual({
  viewKey,
  alt,
  selectedRegion,
  onSelect,
}: {
  viewKey: string;
  alt: string;
  selectedRegion: string | null;
  onSelect: (id: string) => void;
}) {
  if (viewKey && ANATOMY_SVGS[viewKey]) {
    return <SvgRegionPicker registryKey={viewKey} selectedRegion={selectedRegion} onSelect={onSelect} />;
  }
  return <RefImage src={ANATOMY_IMAGES[viewKey]} alt={alt} />;
}

/** A numbered, color-coded selectable row (the left-hand list). */
function NumberedButton({
  index,
  color,
  label,
  selected,
  onClick,
  disabled,
}: {
  index: number;
  color: string;
  label: string;
  selected: boolean;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center gap-3 w-full px-3 py-2.5 rounded-lg border-2 text-left transition-colors focus:outline-none focus:ring-2 focus:ring-oe-primary disabled:opacity-50 ${
        selected ? 'border-oe-primary bg-oe-light' : 'border-gray-200 bg-white hover:border-oe-primary hover:bg-oe-light'
      }`}
    >
      <span
        className={`flex items-center justify-center w-7 h-7 rounded-full text-white text-sm font-bold shrink-0 ${COLOR_BADGE_BG[color] ?? COLOR_BADGE_BG.gray}`}
      >
        {index}
      </span>
      <span className="text-sm font-medium text-gray-800">{label}</span>
    </button>
  );
}

interface SearchEntry {
  option: SurgeryOption;
  subRegionId: string;
  subRegionLabel: string;
  areaLabel: string;
  haystack: string;
}

/** Free-text search across every procedure (name, body part, specialty) plus a
 *  manual-entry fallback for anything not in the list. */
function ProcedureSearch({
  index,
  onSelect,
  disabled,
}: {
  index: SearchEntry[];
  onSelect: (e: SearchEntry) => void;
  disabled: boolean;
}) {
  const [query, setQuery] = useState('');

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    const tokens = q.split(/\s+/);
    return index
      .filter((e) => tokens.every((t) => e.haystack.includes(t)))
      .map((e) => {
        const n = e.option.name.toLowerCase();
        return { e, score: n.startsWith(q) ? 0 : n.includes(q) ? 1 : 2 };
      })
      .sort((a, b) => a.score - b.score || a.e.option.name.localeCompare(b.e.option.name))
      .slice(0, 25)
      .map((x) => x.e);
  }, [query, index]);

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          disabled={disabled}
          placeholder="Search a surgery or body part — e.g. “ACL”, “elbow”, “gallbladder”"
          className="w-full pl-9 pr-9 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-oe-primary disabled:bg-gray-50"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery('')}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-600"
            aria-label="Clear search"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {query.trim().length >= 2 && (
        <div className="border border-gray-200 rounded-lg divide-y divide-gray-100 max-h-72 overflow-y-auto">
          {results.length > 0 ? (
            results.map((e) => (
              <button
                key={`${e.subRegionId}-${e.option.name}`}
                type="button"
                onClick={() => { onSelect(e); setQuery(''); }}
                className="flex flex-col items-start w-full text-left px-3 py-2 hover:bg-oe-light transition-colors"
              >
                <span className="text-sm font-medium text-gray-800">{e.option.name}</span>
                <span className="text-xs text-gray-500">{e.areaLabel} › {e.subRegionLabel}</span>
              </button>
            ))
          ) : (
            <div className="px-3 py-3 text-sm text-gray-500">
              No matches for “{query.trim()}”. Try the body diagram below, or enter it manually at the bottom.
            </div>
          )}
        </div>
      )}

    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function AnatomySurgerySelector({
  value,
  onChange,
  disabled = false,
  label = 'Procedure',
}: AnatomySurgerySelectorProps) {
  // ── Navigation state ──────────────────────────────────────────────────────
  // selectedAreaId: one of BODY_AREAS[].id or OTHER_AREA_ID or null (step 1)
  const [selectedAreaId, setSelectedAreaId] = useState<string | null>(null);
  // selectedSubRegionId: a SubRegion.id or null (step 2)
  const [selectedSubRegionId, setSelectedSubRegionId] = useState<string | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualText, setManualText] = useState('');

  // ── Restore from value prop on mount / when value changes externally ──────
  useEffect(() => {
    if (!value?.region) return;
    const resolved = subRegionById(value.region);
    if (!resolved) return;
    if (resolved.area) {
      setSelectedAreaId(resolved.area.id);
    } else {
      // SubRegion lives in OTHER_GROUPS
      setSelectedAreaId(OTHER_AREA_ID);
    }
    setSelectedSubRegionId(resolved.subRegion.id);
  }, [value?.region]);

  // ── Derived data ──────────────────────────────────────────────────────────

  /** Which BodyArea object is currently active (null for OTHER or none). */
  const activeArea: BodyArea | null = useMemo(() => {
    if (!selectedAreaId || selectedAreaId === OTHER_AREA_ID) return null;
    return BODY_AREAS.find((a) => a.id === selectedAreaId) ?? null;
  }, [selectedAreaId]);

  /** SubRegions visible at step 2. */
  const subRegions: SubRegion[] = useMemo(() => {
    if (selectedAreaId === OTHER_AREA_ID) return OTHER_GROUPS;
    return activeArea?.subRegions ?? [];
  }, [activeArea, selectedAreaId]);

  /** Active SubRegion object at step 3. */
  const activeSubRegion: SubRegion | null = useMemo(() => {
    if (!selectedSubRegionId) return null;
    return subRegions.find((sr) => sr.id === selectedSubRegionId) ?? null;
  }, [subRegions, selectedSubRegionId]);

  /** Label of the active area for breadcrumbs. */
  const areaLabel: string = useMemo(() => {
    if (selectedAreaId === OTHER_AREA_ID) return 'Other / not sure';
    return activeArea?.label ?? '';
  }, [activeArea, selectedAreaId]);

  /** Grouped procedures for the step-3 dropdown. */
  const procedureGroups = useMemo(() => {
    if (!activeSubRegion) return null;
    return groupBySubGroup(activeSubRegion.options);
  }, [activeSubRegion]);

  /** Flat index for free-text search across every procedure. */
  const searchIndex = useMemo<SearchEntry[]>(() => {
    const out: SearchEntry[] = [];
    const add = (area: BodyArea | null, sr: SubRegion) => {
      for (const opt of sr.options) {
        out.push({
          option: opt,
          subRegionId: sr.id,
          subRegionLabel: sr.label,
          areaLabel: area?.label ?? 'Other',
          haystack: [opt.name, opt.subGroup ?? '', sr.label, area?.label ?? '', opt.specialty ?? '']
            .join(' ')
            .toLowerCase(),
        });
      }
    };
    for (const area of BODY_AREAS) for (const sr of area.subRegions) add(area, sr);
    for (const sr of OTHER_GROUPS) add(null, sr);
    return out;
  }, []);

  // ── Step determination ────────────────────────────────────────────────────
  // step 1: no area chosen
  // step 2: area chosen, no sub-region chosen
  // step 3: both chosen (procedure dropdown)
  const step: 1 | 2 | 3 =
    selectedAreaId === null ? 1 : selectedSubRegionId === null ? 2 : 3;

  // ── Handlers ─────────────────────────────────────────────────────────────

  function handleAreaSelect(areaId: string) {
    if (disabled) return;
    setSelectedAreaId(areaId);
    setSelectedSubRegionId(null);
    // If value was for a different area, clear it
    if (value) onChange(null);
  }

  function handleSubRegionSelect(subRegionId: string) {
    if (disabled) return;
    setSelectedSubRegionId(subRegionId);
    // Clear procedure if sub-region changed
    if (value && value.region !== subRegionId) onChange(null);
  }

  function handleSvgAreaSelect(dataRegion: string) {
    // SVG overview tags areas as "area-head", "area-torso", etc.
    // Map to BODY_AREAS ids.
    const areaId = dataRegion.startsWith('area-') ? dataRegion.slice(5) : dataRegion;
    handleAreaSelect(areaId);
  }

  function handleSvgSubRegionSelect(dataRegion: string) {
    handleSubRegionSelect(dataRegion);
  }

  function handleProcedureChange(e: ChangeEvent<HTMLSelectElement>) {
    if (disabled || !activeSubRegion) return;
    const name = e.target.value;
    if (!name) { onChange(null); return; }
    const opt = activeSubRegion.options.find((o) => o.name === name);
    if (!opt) return;
    onChange({
      region: activeSubRegion.id,
      procedureName: opt.name,
      cptCodes: opt.cptCodes,
    });
  }

  /** "Change" from the confirmed card: clear the value but keep the drill-down
   *  position so the picker reopens where they left off. */
  function handleChange() {
    if (disabled) return;
    onChange(null);
  }

  /** Pick a result from the search box: jump the drill-down to it + emit value. */
  function selectSearchResult(e: SearchEntry) {
    if (disabled) return;
    const resolved = subRegionById(e.subRegionId);
    if (resolved) {
      setSelectedAreaId(resolved.area ? resolved.area.id : OTHER_AREA_ID);
      setSelectedSubRegionId(resolved.subRegion.id);
    }
    onChange({ region: e.subRegionId, procedureName: e.option.name, cptCodes: e.option.cptCodes });
  }

  /** Manual free-text procedure (not in the list). region='manual', no CPT. */
  function submitManual(text: string) {
    if (disabled) return;
    const t = text.trim();
    if (!t) return;
    setSelectedAreaId(null);
    setSelectedSubRegionId(null);
    onChange({ region: 'manual', procedureName: t, cptCodes: [] });
  }

  function goBackToAreas() {
    if (disabled) return;
    setSelectedAreaId(null);
    setSelectedSubRegionId(null);
    if (value) onChange(null);
  }

  function goBackToSubRegions() {
    if (disabled) return;
    setSelectedSubRegionId(null);
    if (value) onChange(null);
  }

  // ── Confirmation banner ───────────────────────────────────────────────────
  const hasProcedureSelected = !!value?.procedureName;

  // ── SVG registry keys ─────────────────────────────────────────────────────
  // Overview uses key "overview"; each area uses its id (head/torso/arm/leg).
  const areaSvgKey = selectedAreaId && selectedAreaId !== OTHER_AREA_ID ? selectedAreaId : '';

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className={`flex flex-col gap-4 ${disabled ? 'opacity-60 pointer-events-none' : ''}`}>
      {label && (
        <span className="block text-sm font-medium text-gray-700">{label}</span>
      )}

      {hasProcedureSelected && value ? (
        /* ── Collapsed: a procedure is chosen ───────────────────────────── */
        <div className="flex items-center gap-3 bg-oe-light border border-oe-primary/30 rounded-lg px-4 py-3">
          <CheckCircle size={18} className="text-oe-primary shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-gray-900 break-words">{value.procedureName}</p>
            {activeSubRegion && (
              <p className="text-xs text-gray-500">{areaLabel} &rsaquo; {activeSubRegion.label}</p>
            )}
          </div>
          {!disabled && (
            <button
              type="button"
              onClick={handleChange}
              className="shrink-0 text-sm font-medium text-oe-primary hover:text-oe-dark hover:underline"
            >
              Change
            </button>
          )}
        </div>
      ) : (
      /* ── Picker: search → browse → manual ───────────────────────────── */
      <>
      <ProcedureSearch index={searchIndex} onSelect={selectSearchResult} disabled={disabled} />

      {step === 1 && (
        <div className="flex items-center gap-3 text-xs text-gray-400">
          <span className="h-px flex-1 bg-gray-200" />
          or choose on the body
          <span className="h-px flex-1 bg-gray-200" />
        </div>
      )}

      {/* ── Breadcrumb (steps 2 + 3) ───────────────────────────────────── */}
      {step >= 2 && (
        <div className="flex items-center justify-between gap-2">
          <Breadcrumb
            areaLabel={areaLabel}
            subRegionLabel={step === 3 ? (activeSubRegion?.label ?? undefined) : undefined}
            onBackToAreas={goBackToAreas}
            onBackToSubRegions={goBackToSubRegions}
            disabled={disabled}
          />
          <button
            type="button"
            onClick={goBackToAreas}
            disabled={disabled}
            className="flex items-center gap-1 text-xs text-gray-500 hover:text-oe-primary disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            aria-label="Start over"
          >
            <RotateCcw size={12} />
            Start over
          </button>
        </div>
      )}

      {/* ── Step 1: "Where is it?" ─────────────────────────────────────── */}
      {step === 1 && (
        <div className="flex flex-col gap-3">
          <p className="text-sm font-semibold text-gray-800">Where is it?</p>
          <div className="flex flex-col sm:flex-row gap-4">
            {/* Left: numbered, color-coded area list */}
            <div className="flex flex-col gap-2 sm:w-1/2">
              {BODY_AREAS.map((area, i) => (
                <NumberedButton
                  key={area.id}
                  index={i + 1}
                  color={(VIEW_REGION_COLORS.overview ?? [])[i] ?? 'gray'}
                  label={area.label}
                  selected={selectedAreaId === area.id}
                  onClick={() => handleAreaSelect(area.id)}
                  disabled={disabled}
                />
              ))}
              <button
                type="button"
                onClick={() => handleAreaSelect(OTHER_AREA_ID)}
                disabled={disabled}
                className="mt-1 w-full text-sm text-gray-500 hover:text-oe-primary hover:underline py-1 transition-colors disabled:opacity-50"
              >
                Something else / not sure
              </button>
            </div>
            {/* Right: body image (becomes a clickable SVG once registered) */}
            <div className="sm:w-1/2 flex items-start justify-center">
              <Visual
                viewKey="overview"
                alt="Body overview"
                selectedRegion={selectedAreaId ? `area-${selectedAreaId}` : null}
                onSelect={handleSvgAreaSelect}
              />
            </div>
          </div>
        </div>
      )}

      {/* ── Step 2: "What part?" ──────────────────────────────────────── */}
      {step === 2 && (
        <div className="flex flex-col gap-3">
          <p className="text-sm font-semibold text-gray-800">What part?</p>
          <div className="flex flex-col sm:flex-row gap-4">
            {/* Left: numbered, color-coded sub-region list */}
            <div className="flex flex-col gap-2 sm:w-1/2">
              {subRegions.map((sr, i) => (
                <NumberedButton
                  key={sr.id}
                  index={i + 1}
                  color={(VIEW_REGION_COLORS[areaSvgKey] ?? [])[i] ?? 'gray'}
                  label={sr.label}
                  selected={selectedSubRegionId === sr.id}
                  onClick={() => handleSubRegionSelect(sr.id)}
                  disabled={disabled}
                />
              ))}
            </div>
            {/* Right: area image (becomes a clickable SVG once registered); hidden for the OTHER path */}
            {selectedAreaId !== OTHER_AREA_ID && (
              <div className="sm:w-1/2 flex items-start justify-center">
                <Visual
                  viewKey={areaSvgKey}
                  alt={`${areaLabel} detail`}
                  selectedRegion={selectedSubRegionId}
                  onSelect={handleSvgSubRegionSelect}
                />
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Step 3: a single procedure dropdown (no duplicate headings) ── */}
      {step === 3 && activeSubRegion && (
        <div className="relative">
          <select
            id="anatomy-procedure-select"
            value={value?.procedureName ?? ''}
            onChange={handleProcedureChange}
            disabled={disabled}
            aria-label="Select procedure or surgery"
            className="w-full appearance-none bg-white border border-gray-300 rounded-lg px-3 py-2 pr-9 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-oe-primary disabled:bg-gray-50"
          >
            <option value="">— Choose a procedure in {activeSubRegion.label} —</option>
            {procedureGroups &&
              Array.from(procedureGroups.entries()).map(([group, options]) =>
                group ? (
                  <optgroup key={group} label={group}>
                    {options.map((opt) => (
                      <option key={opt.name} value={opt.name}>{opt.name}</option>
                    ))}
                  </optgroup>
                ) : (
                  options.map((opt) => (
                    <option key={opt.name} value={opt.name}>{opt.name}</option>
                  ))
                ),
              )}
          </select>
          <ChevronDown
            size={16}
            className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-gray-400"
          />
        </div>
      )}

      {/* ── Manual entry footer (fallback) ─────────────────────────────── */}
      {!manualOpen ? (
        <button
          type="button"
          onClick={() => setManualOpen(true)}
          disabled={disabled}
          className="self-start inline-flex items-center gap-1.5 text-xs text-gray-500 hover:text-oe-primary disabled:opacity-50"
        >
          <Pencil size={12} />
          Can’t find your procedure? Enter it manually
        </button>
      ) : (
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={manualText}
            onChange={(e) => setManualText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { submitManual(manualText); setManualText(''); setManualOpen(false); } }}
            disabled={disabled}
            placeholder="Type the procedure or surgery"
            className="flex-1 min-w-0 px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
          />
          <button
            type="button"
            onClick={() => { submitManual(manualText); setManualText(''); setManualOpen(false); }}
            disabled={disabled || !manualText.trim()}
            className="shrink-0 px-3 py-2 bg-oe-primary hover:bg-oe-dark text-white text-sm font-medium rounded-lg disabled:opacity-50"
          >
            Add
          </button>
          <button
            type="button"
            onClick={() => { setManualOpen(false); setManualText(''); }}
            className="shrink-0 p-2 text-gray-400 hover:text-gray-600"
            aria-label="Cancel"
          >
            <X size={16} />
          </button>
        </div>
      )}
      </>
      )}
    </div>
  );
}
