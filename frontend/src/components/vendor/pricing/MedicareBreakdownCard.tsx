// Medicare pricing breakdown: per-site comparison (ASC / HOPD / inpatient)
// with 150-200% target ranges, plus the component sections (professional /
// facility / anesthesia) with their formula steps. Renders either a live
// CptPriceResult or a persisted PricingSnapshot — both carry the same fields.

import { useState } from 'react';
import { ChevronDown, ChevronRight, Info } from 'lucide-react';
import type { PriceSection, SiteTotal } from '../../../types/cptPricing.types';
import TargetRangeBadge from './TargetRangeBadge';

interface MedicareBreakdownCardProps {
  code: string;
  description?: string | null;
  locality?: string | null;
  zip?: string | null;
  headlineSite: string | null;
  medicareTotal: number | null;
  targetMin: number | null;
  targetMax: number | null;
  totals: SiteTotal[];
  sections: PriceSection[];
}

const fmt = (n: number | null | undefined) =>
  n == null
    ? '—'
    : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

const MedicareBreakdownCard = (props: MedicareBreakdownCardProps) => {
  const { code, description, locality, zip, headlineSite, medicareTotal, targetMin, targetMax, totals, sections } = props;

  return (
    <div className="bg-white rounded-lg border border-gray-200">
      {/* Headline */}
      <div className="px-4 py-3 border-b border-gray-200 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-gray-900">
            {code}
            {description ? <span className="font-normal text-gray-600"> — {description}</span> : null}
          </p>
          <p className="text-xs text-gray-500">
            Medicare allowed{headlineSite ? ` · ${headlineSite}` : ''}
            {locality ? ` · locality ${locality}` : ''}
            {zip ? ` · ZIP ${zip}` : ' · national'}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <p className="text-xs text-gray-500">Medicare all-in</p>
            <p className="text-sm font-semibold text-gray-900">{fmt(medicareTotal)}</p>
          </div>
          <div className="text-right">
            <p className="text-xs text-gray-500">Target (150–200%)</p>
            <TargetRangeBadge targetMin={targetMin} targetMax={targetMax} size="sm" />
          </div>
        </div>
      </div>

      {/* Per-site comparison */}
      {totals.length > 0 && (
        <div className="px-4 py-3 border-b border-gray-200 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-gray-500 text-left">
                <th className="py-1 pr-4 font-medium">Site of care</th>
                <th className="py-1 pr-4 font-medium text-right">Professional</th>
                <th className="py-1 pr-4 font-medium text-right">Facility</th>
                <th className="py-1 pr-4 font-medium text-right">Anesthesia</th>
                <th className="py-1 pr-4 font-medium text-right">Medicare all-in</th>
                <th className="py-1 font-medium text-right">Target range</th>
              </tr>
            </thead>
            <tbody>
              {totals.map((t) => (
                <tr key={t.site} className="border-t border-gray-100">
                  <td className="py-1.5 pr-4 text-gray-900">{t.site}</td>
                  <td className="py-1.5 pr-4 text-right text-gray-700">{fmt(t.professional)}</td>
                  <td className="py-1.5 pr-4 text-right text-gray-700">{fmt(t.facility)}</td>
                  <td className="py-1.5 pr-4 text-right text-gray-700">{fmt(t.anesthesia)}</td>
                  <td className="py-1.5 pr-4 text-right font-semibold text-gray-900">{fmt(t.total)}</td>
                  <td className="py-1.5 text-right">
                    <TargetRangeBadge targetMin={t.targetMin} targetMax={t.targetMax} size="sm" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Component sections with formula detail */}
      <div className="px-4 py-2">
        {sections.length === 0 ? (
          <p className="text-sm text-gray-500 py-2">No payable Medicare components for this code.</p>
        ) : (
          sections.map((s) => <SectionRow key={s.kind} section={s} />)
        )}
      </div>
    </div>
  );
};

const SectionRow = ({ section }: { section: PriceSection }) => {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-gray-100 last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between py-2 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-oe-primary rounded"
      >
        <span className="flex items-center gap-2 text-sm text-gray-800">
          {open ? <ChevronDown className="h-4 w-4 text-gray-400" /> : <ChevronRight className="h-4 w-4 text-gray-400" />}
          {section.title}
          {!section.payable && (
            <span className="text-xs text-gray-400">(not payable)</span>
          )}
        </span>
        <span className="text-sm font-medium text-gray-900">{fmt(section.result)}</span>
      </button>
      {open && (
        <div className="pb-3 pl-6 text-xs text-gray-600 space-y-2">
          {section.result_label && <p className="text-gray-500">{section.result_label}</p>}
          {section.formula && (
            <p className="font-mono text-gray-700 bg-gray-50 rounded px-2 py-1 inline-block">{section.formula}</p>
          )}
          {section.steps && section.steps.length > 0 && (
            <ul className="space-y-0.5">
              {section.steps.map((step, i) => (
                <li key={i} className="flex justify-between gap-4 max-w-md">
                  <span className="font-mono">{step.expr}</span>
                  <span className="text-gray-900">{step.value}</span>
                </li>
              ))}
            </ul>
          )}
          {section.legend && (
            <p className="flex items-start gap-1 text-gray-400 max-w-2xl">
              <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              {section.legend}
            </p>
          )}
        </div>
      )}
    </div>
  );
};

export default MedicareBreakdownCard;
