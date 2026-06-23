// Procedure name / billing code typeahead against the pricing proxy.
// Suggestions are deduped billing codes from hospital MRF matches.

import { useEffect, useRef, useState } from 'react';
import { Loader2, Search } from 'lucide-react';
import { cptPricingService } from '../../../services/cpt-pricing.service';

export interface CptSuggestion {
  code: string;
  codeType: string;
  description: string;
}

interface CptSearchBoxProps {
  onSelect: (suggestion: CptSuggestion) => void;
  placeholder?: string;
  zip?: string;
  autoFocus?: boolean;
}

const CptSearchBox = ({ onSelect, placeholder = 'Search procedure name or CPT code…', zip, autoFocus }: CptSearchBoxProps) => {
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<CptSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const onClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim();
    if (q.length < 2) {
      setSuggestions([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const result = await cptPricingService.search(q, zip);
        // Dedupe hospital matches by billing code; prefer standard code types.
        // The MRF corpus's layman_description is sometimes a payment-grouping
        // bucket ("Outpatient Grouper - 7"), not a procedure name — skip those.
        const isGrouperLabel = (s: string | null | undefined) => !s || /grouper/i.test(s);
        const seen = new Map<string, CptSuggestion>();
        for (const m of result.hospitalMatches) {
          if (!m.billing_code || seen.has(m.billing_code)) continue;
          seen.set(m.billing_code, {
            code: m.billing_code,
            codeType: m.code_type,
            description:
              (!isGrouperLabel(m.layman_description) ? m.layman_description : null) ||
              (!isGrouperLabel(m.raw_description) ? m.raw_description : null) ||
              '',
          });
        }
        setSuggestions(Array.from(seen.values()).slice(0, 10));
        setOpen(true);
      } catch {
        setSuggestions([]);
      } finally {
        setLoading(false);
      }
    }, 350);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, zip]);

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
        <input
          type="text"
          value={query}
          autoFocus={autoFocus}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => suggestions.length > 0 && setOpen(true)}
          placeholder={placeholder}
          className="w-full pl-9 pr-9 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-transparent"
        />
        {loading && <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 animate-spin" />}
      </div>

      {open && suggestions.length > 0 && (
        <ul className="absolute z-20 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-72 overflow-y-auto">
          {suggestions.map((s) => (
            <li key={s.code}>
              <button
                type="button"
                onClick={() => {
                  onSelect(s);
                  setOpen(false);
                  setQuery('');
                }}
                className="w-full text-left px-3 py-2 hover:bg-oe-light/50 focus:bg-oe-light/50 focus:outline-none"
              >
                <span className="text-sm font-medium text-gray-900">{s.code}</span>
                <span className="ml-2 text-xs text-gray-400">{s.codeType}</span>
                {s.description && <p className="text-xs text-gray-600 truncate">{s.description}</p>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default CptSearchBox;
