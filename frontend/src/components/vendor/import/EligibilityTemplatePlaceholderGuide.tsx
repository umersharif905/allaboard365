import React, { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Search } from 'lucide-react';
import {
  ELIGIBILITY_PLACEHOLDER_CATEGORIES,
  ELIGIBILITY_PLACEHOLDER_SECTION_META,
  ELIGIBILITY_TEMPLATE_SYNTAX_EXTRAS,
  type EligibilityPlaceholderCategory,
  type PlaceholderGuideSection,
  placeholderEntryHint,
  placeholderEntryName,
} from '../../../constants/eligibilityPlaceholderCategories';
import { ELIGIBILITY_TEMPLATE_VALID_PLACEHOLDERS } from '../../../utils/eligibilityRowTemplate';

function appendToken(current: string, token: string): string {
  if (!current.trim()) return token;
  const sep = current.trimEnd().endsWith(',') ? '' : ',';
  return `${current.trimEnd()}${sep}${token}`;
}

function appendPlaceholder(current: string, ph: string): string {
  return appendToken(current, `{${ph}}`);
}

function matchesQuery(text: string, query: string): boolean {
  return text.toLowerCase().includes(query.trim().toLowerCase());
}

function categoryMatchesSearch(cat: EligibilityPlaceholderCategory, query: string): boolean {
  if (!query.trim()) return true;
  if (matchesQuery(cat.label, query)) return true;
  if (cat.subtitle && matchesQuery(cat.subtitle, query)) return true;
  return cat.placeholders.some((entry) => {
    const name = placeholderEntryName(entry);
    const hint = placeholderEntryHint(entry);
    return matchesQuery(name, query) || (hint ? matchesQuery(hint, query) : false);
  });
}

function filteredPlaceholders(
  cat: EligibilityPlaceholderCategory,
  query: string
): EligibilityPlaceholderCategory['placeholders'] {
  if (!query.trim()) return cat.placeholders;
  return cat.placeholders.filter((entry) => {
    const name = placeholderEntryName(entry);
    const hint = placeholderEntryHint(entry);
    return (
      matchesQuery(name, query) ||
      (hint ? matchesQuery(hint, query) : false) ||
      matchesQuery(cat.label, query)
    );
  });
}

const SECTION_ORDER: PlaceholderGuideSection[] = ['core', 'extras'];

interface Props {
  template: string;
  onInsert: (next: string) => void;
  /** Side-panel mode: no outer card chrome (parent provides container). */
  compact?: boolean;
}

const PlaceholderChip: React.FC<{
  token: string;
  title?: string;
  onClick: () => void;
}> = ({ token, title, onClick }) => (
  <button
    type="button"
    title={title}
    onClick={onClick}
    className="px-1.5 py-0.5 text-[11px] font-mono border border-gray-200 rounded bg-white hover:bg-oe-light hover:border-oe-primary text-left max-w-full truncate"
  >
    {token}
  </button>
);

const EligibilityTemplatePlaceholderGuide: React.FC<Props> = ({ template, onInsert, compact }) => {
  const [query, setQuery] = useState('');
  const [openCats, setOpenCats] = useState<Set<string>>(() => new Set(['Member & identity']));
  const [extrasOpen, setExtrasOpen] = useState(false);
  const [syntaxOpen, setSyntaxOpen] = useState(false);

  const trimmedQuery = query.trim();
  const isSearching = trimmedQuery.length > 0;

  const filteredBySection = useMemo(() => {
    const map: Record<PlaceholderGuideSection, EligibilityPlaceholderCategory[]> = {
      core: [],
      extras: [],
    };
    for (const cat of ELIGIBILITY_PLACEHOLDER_CATEGORIES) {
      if (!categoryMatchesSearch(cat, trimmedQuery)) continue;
      const placeholders = filteredPlaceholders(cat, trimmedQuery);
      if (isSearching && placeholders.length === 0) continue;
      map[cat.section].push({ ...cat, placeholders });
    }
    return map;
  }, [trimmedQuery, isSearching]);

  const resultCount = useMemo(
    () =>
      SECTION_ORDER.reduce(
        (n, section) =>
          n + filteredBySection[section].reduce((c, cat) => c + cat.placeholders.length, 0),
        0
      ),
    [filteredBySection]
  );

  useEffect(() => {
    if (!isSearching) return;
    const labels = ELIGIBILITY_PLACEHOLDER_CATEGORIES.filter((c) =>
      categoryMatchesSearch(c, trimmedQuery)
    ).map((c) => c.label);
    setOpenCats(new Set(labels));
    setExtrasOpen(true);
  }, [trimmedQuery, isSearching]);

  const toggle = (label: string) => {
    setOpenCats((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  };

  const expandAllInSection = (section: PlaceholderGuideSection) => {
    const labels = filteredBySection[section].map((c) => c.label);
    setOpenCats((prev) => {
      const next = new Set(prev);
      labels.forEach((l) => next.add(l));
      return next;
    });
    if (section === 'extras') setExtrasOpen(true);
  };

  const renderCategory = (cat: EligibilityPlaceholderCategory) => {
    const expanded = isSearching || openCats.has(cat.label);
    const count = cat.placeholders.length;
    if (count === 0) return null;

    return (
      <div key={cat.label} className="border-t border-gray-100 first:border-t-0">
        <button
          type="button"
          onClick={() => toggle(cat.label)}
          className="w-full flex items-center gap-1.5 px-2 py-1.5 text-left text-xs font-medium text-gray-800 hover:bg-gray-50"
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-gray-400" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-gray-400" />
          )}
          <span className="flex-1 truncate">{cat.label}</span>
          <span className="text-[10px] text-gray-400 font-normal tabular-nums">{count}</span>
        </button>
        {expanded && (
          <div className="px-2 pb-2 pt-0">
            {cat.subtitle && !isSearching && (
              <p className="text-[10px] text-gray-500 mb-1.5">{cat.subtitle}</p>
            )}
            <div className="flex flex-wrap gap-1">
              {cat.placeholders.map((entry) => {
                const ph = placeholderEntryName(entry);
                const hint = placeholderEntryHint(entry);
                return (
                  <PlaceholderChip
                    key={`${cat.label}-${ph}`}
                    token={`{${ph}}`}
                    title={hint}
                    onClick={() => onInsert(appendPlaceholder(template, ph))}
                  />
                );
              })}
            </div>
          </div>
        )}
      </div>
    );
  };

  const renderSection = (section: PlaceholderGuideSection) => {
    const cats = filteredBySection[section];
    if (cats.length === 0) return null;
    const meta = ELIGIBILITY_PLACEHOLDER_SECTION_META[section];
    const sectionCount = cats.reduce((n, c) => n + c.placeholders.length, 0);
    const isExtras = section === 'extras';

    if (isExtras) {
      return (
        <div key={section} className="border-t border-gray-200">
          <button
            type="button"
            onClick={() => setExtrasOpen((v) => !v)}
            className="w-full flex items-center gap-1.5 px-2 py-2 text-left bg-gray-50/80 hover:bg-gray-100"
          >
            {extrasOpen || isSearching ? (
              <ChevronDown className="h-4 w-4 shrink-0 text-gray-500" />
            ) : (
              <ChevronRight className="h-4 w-4 shrink-0 text-gray-500" />
            )}
            <div className="flex-1 min-w-0">
              <div className="text-xs font-semibold text-gray-800">{meta.title}</div>
              {!isSearching && (
                <div className="text-[10px] text-gray-500 truncate">{meta.description}</div>
              )}
            </div>
            <span className="text-[10px] text-gray-400 tabular-nums">{sectionCount}</span>
          </button>
          {(extrasOpen || isSearching) && (
            <div className="bg-white">
              {cats.map(renderCategory)}
              {!isSearching && (
                <div className="px-2 pb-1">
                  <button
                    type="button"
                    onClick={() => expandAllInSection('extras')}
                    className="text-[10px] text-oe-primary hover:underline"
                  >
                    Expand all extras
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      );
    }

    return (
      <div key={section}>
        <div className="px-2 py-1.5 bg-gray-50 border-b border-gray-100 flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-xs font-semibold text-gray-800">{meta.title}</div>
            {!isSearching && (
              <div className="text-[10px] text-gray-500">{meta.description}</div>
            )}
          </div>
          <span className="text-[10px] text-gray-400 shrink-0 tabular-nums">{sectionCount}</span>
        </div>
        {cats.map(renderCategory)}
      </div>
    );
  };

  const filteredSyntax = useMemo(() => {
    if (!isSearching) return ELIGIBILITY_TEMPLATE_SYNTAX_EXTRAS;
    return ELIGIBILITY_TEMPLATE_SYNTAX_EXTRAS.filter(
      (x) =>
        matchesQuery(x.label, trimmedQuery) ||
        matchesQuery(x.insert, trimmedQuery) ||
        (x.hint ? matchesQuery(x.hint, trimmedQuery) : false)
    );
  }, [trimmedQuery, isSearching]);

  return (
    <div
      className={
        compact
          ? 'overflow-hidden text-sm'
          : 'border border-gray-200 rounded-lg overflow-hidden text-sm bg-white'
      }
    >
      <div className={`p-2 space-y-2 ${compact ? 'pb-2' : 'bg-gray-50 border-b border-gray-100'}`}>
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search fields…"
            className="w-full pl-7 pr-2 py-1.5 text-xs border border-gray-300 rounded-md bg-white focus:ring-1 focus:ring-oe-primary focus:border-oe-primary"
          />
        </div>
        <p className="text-[11px] text-gray-500 leading-snug">
          {isSearching ? (
            <>
              <span className="font-medium text-gray-700">{resultCount}</span> matching field
              {resultCount === 1 ? '' : 's'}
            </>
          ) : (
            <>
              <span className="font-medium text-gray-700">{ELIGIBILITY_TEMPLATE_VALID_PLACEHOLDERS.size}</span>{' '}
              placeholders — click to append
            </>
          )}
        </p>
      </div>

      {resultCount === 0 && isSearching ? (
        <p className="px-3 py-4 text-xs text-gray-500 text-center">No fields match your search.</p>
      ) : (
        <>
          {SECTION_ORDER.map(renderSection)}
        </>
      )}

      {/* Syntax / literals — not in placeholder validation set */}
      {(filteredSyntax.length > 0 || !isSearching) && (
        <div className="border-t border-gray-200">
          <button
            type="button"
            onClick={() => setSyntaxOpen((v) => !v)}
            className="w-full flex items-center gap-1.5 px-2 py-2 text-left bg-amber-50/60 hover:bg-amber-50"
          >
            {syntaxOpen || isSearching ? (
              <ChevronDown className="h-4 w-4 shrink-0 text-amber-700/70" />
            ) : (
              <ChevronRight className="h-4 w-4 shrink-0 text-amber-700/70" />
            )}
            <div className="flex-1 min-w-0">
              <div className="text-xs font-semibold text-amber-950">Special & syntax</div>
              <div className="text-[10px] text-amber-900/70 truncate">
                Import uses headers + placeholders; (replace)/(dateOffset)/(nocomma) are export-only
              </div>
            </div>
            <span className="text-[10px] text-amber-800/60 tabular-nums">{filteredSyntax.length}</span>
          </button>
          {(syntaxOpen || isSearching) && filteredSyntax.length > 0 && (
            <div className="px-2 pb-2 flex flex-wrap gap-1">
              {filteredSyntax.map((extra) => (
                <span key={extra.label} className="inline-flex items-center gap-0.5 max-w-full">
                  <PlaceholderChip
                    token={extra.insert}
                    title={extra.hint || extra.label}
                    onClick={() => onInsert(appendToken(template, extra.insert))}
                  />
                  {extra.exportOnly && (
                    <span className="text-[9px] text-amber-800/80 shrink-0" title="Export only">
                      exp
                    </span>
                  )}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default EligibilityTemplatePlaceholderGuide;
