import React, { useState } from 'react';
import type { AIKeyTierPairingSuggestion, AISetupProductSuggestion } from '../../types/ai/eligibilityFormatAssistant.types';
import type { EligibilityFormatPatch } from '../../utils/eligibilityFormatAiMerge';

interface Props {
  summary: string;
  products: AISetupProductSuggestion[];
  keyTierPairings: AIKeyTierPairingSuggestion[];
  patch?: EligibilityFormatPatch;
  warnings?: string[];
  onApply: (patch: EligibilityFormatPatch) => void;
  disabled?: boolean;
}

const EligibilityFormatSetupProposalPreview: React.FC<Props> = ({
  summary,
  products,
  keyTierPairings,
  patch,
  warnings,
  onApply,
  disabled,
}) => {
  const [selectedProducts, setSelectedProducts] = useState<Set<string>>(
    () => new Set(products.map((p) => p.id)),
  );
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(
    () => new Set(keyTierPairings.map((k) => k.sourceKey)),
  );

  const toggleProduct = (id: string) => {
    setSelectedProducts((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleKey = (key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="rounded-lg border border-oe-primary/30 bg-oe-light/20 p-4 space-y-4 text-sm">
      <p className="text-gray-800">{summary}</p>
      {warnings?.length ? (
        <ul className="text-xs text-amber-800 list-disc pl-4">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : null}

      {products.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-gray-700 mb-2">Products to configure</h4>
          <ul className="space-y-2">
            {products.map((p) => (
              <li key={p.id} className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={selectedProducts.has(p.id)}
                  disabled={disabled}
                  onChange={() => toggleProduct(p.id)}
                />
                <div>
                  <span className="font-medium">{p.label}</span>
                  {p.keyStrategyType && (
                    <span className="text-gray-500 ml-1">· {p.keyStrategyType}</span>
                  )}
                  {p.sampleSourceValues?.length ? (
                    <p className="text-xs text-gray-500 font-mono mt-0.5">
                      Samples: {p.sampleSourceValues.slice(0, 5).join(', ')}
                    </p>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {keyTierPairings.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-gray-700 mb-2">Suggested tier keys</h4>
          <ul className="space-y-1 max-h-48 overflow-auto">
            {keyTierPairings.map((k) => (
              <li key={k.sourceKey} className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={selectedKeys.has(k.sourceKey)}
                  disabled={disabled}
                  onChange={() => toggleKey(k.sourceKey)}
                />
                <span className="font-mono">{k.sourceKey}</span>
                {k.sampleRows != null && (
                  <span className="text-gray-500">({k.sampleRows} rows)</span>
                )}
                {k.importProductLabel && (
                  <span className="text-gray-500">· {k.importProductLabel}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {patch && Object.keys(patch).length > 0 && (
        <button
          type="button"
          disabled={disabled}
          className="px-3 py-1.5 bg-oe-primary text-white rounded-lg text-sm hover:bg-oe-dark disabled:opacity-50"
          onClick={() => onApply(patch)}
        >
          Apply import rules to format
        </button>
      )}
      <p className="text-xs text-gray-500">
        Review products above, then apply to load rules into the format editor. Map tiers on the Product mapping step.
      </p>
    </div>
  );
};

export default EligibilityFormatSetupProposalPreview;
