import React, { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react';
import type {
  ImportProduct,
  KeyStrategy,
  ProductMatch,
  RowGrain,
  VendorImportRules,
} from '../../../types/vendor/vendorImportRules.types';
import { apiService } from '../../../services/api.service';
import type { PricingTierOption } from '../../../utils/vendorImportProductMapping';
import { normalizeVendorImportRules } from '../../../utils/vendorImportRulesNormalize';
import {
  KEY_STRATEGY_LABELS,
  MATCH_MODE_LABELS,
} from '../../../utils/importStrategy';
import {
  newImportProductId,
  defaultProductMatch,
} from '../../../utils/importProductRules';
import { strategiesForTierMode } from '../../../utils/planKeySourceConfig';

const inputClass =
  'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-oe-primary/30 focus:border-oe-primary';

const selectClass = `${inputClass} pr-8`;

interface Props {
  rules: VendorImportRules;
  onChange: (rules: VendorImportRules) => void;
  disabled?: boolean;
  /** Optional CSV headers for match field dropdowns */
  columnHeaders?: string[];
}

const ROW_GRAIN_OPTIONS: { id: RowGrain; label: string }[] = [
  { id: 'perPrimary', label: 'One enrollment per primary (Calstar, MPB, E123)' },
  { id: 'perProduct', label: 'One row per product line (Align native)' },
  { id: 'perMember', label: 'One row per member (all relationships)' },
];

function defaultKeyStrategy(): KeyStrategy {
  return {
    type: 'planCode',
    strategies: ['planCode', 'tierUa'],
    compositeFields: [],
    compositeSeparator: '_',
    tierFields: 'Plan Tier,Family Size Tier,Coverage Tier',
    tierPattern: '^(EE|ES|EC|EF)$',
    uaFields: 'UA,Deductible IUA',
    planCodeFields: 'Plan Name,Product Name',
    tierUaSuffixRegex: '(\\d{3,6})(EE|ES|EC|EF)$',
    uaRelabel: [],
    valueMap: {},
  };
}

function newProduct(): ImportProduct {
  return {
    id: newImportProductId(),
    label: 'New product',
    targetProductId: null,
    match: defaultProductMatch(),
    keyStrategy: defaultKeyStrategy(),
  };
}

const ImportRulesEditor: React.FC<Props> = ({ rules, onChange, disabled, columnHeaders = [] }) => {
  const r = normalizeVendorImportRules(rules);
  const [expandedId, setExpandedId] = useState<string | null>(r.products?.[0]?.id ?? null);
  const [pricingTiers, setPricingTiers] = useState<PricingTierOption[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiService.get<{ success: boolean; data: PricingTierOption[] }>(
          '/api/me/vendor/import/pricing-tiers',
        );
        if (!cancelled && res?.data) setPricingTiers(res.data);
      } catch {
        /* optional */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const patch = (partial: Partial<VendorImportRules>) => {
    onChange(normalizeVendorImportRules({ ...r, ...partial }));
  };

  const setProducts = (products: ImportProduct[]) => {
    patch({ products });
  };

  const updateProduct = (id: string, partial: Partial<ImportProduct>) => {
    setProducts(
      (r.products || []).map((p) => (p.id === id ? { ...p, ...partial } : p)),
    );
  };

  const updateMatch = (id: string, partial: Partial<ProductMatch>) => {
    const p = (r.products || []).find((x) => x.id === id);
    if (!p) return;
    updateProduct(id, { match: { ...p.match, ...partial } });
  };

  const updateKeyStrategy = (id: string, partial: Partial<KeyStrategy>) => {
    const p = (r.products || []).find((x) => x.id === id);
    if (!p) return;
    const next = { ...p.keyStrategy, ...partial };
    if (partial.type) {
      next.strategies = strategiesForTierMode(
        partial.type === 'composite' ? 'composite' : partial.type === 'planCode' ? 'planCode' : 'tierUa',
      );
    }
    updateProduct(id, { keyStrategy: next });
  };

  const products = r.products?.length ? r.products : [];

  return (
    <div className="space-y-4 border border-gray-200 rounded-lg p-4 bg-gray-50/80">
      <div>
        <h4 className="text-sm font-semibold text-gray-900">Product mapping</h4>
        <p className="text-xs text-gray-500 mt-0.5">
          Add each product this file can enroll. Pick how rows match the product, then how the pricing tier key is read.
        </p>
      </div>

      <label className="block text-xs text-gray-600">
        Row grain
        <select
          className={`${selectClass} mt-1`}
          value={r.rowGrain || 'perPrimary'}
          disabled={disabled}
          onChange={(e) => patch({ rowGrain: e.target.value as RowGrain })}
        >
          {ROW_GRAIN_OPTIONS.map((o) => (
            <option key={o.id} value={o.id}>{o.label}</option>
          ))}
        </select>
      </label>

      <fieldset className="space-y-1.5">
        <legend className="text-xs font-medium text-gray-700">Household member ID grouping</legend>
        <p className="text-xs text-gray-500">
          Optional regex patterns to strip dependent suffixes before grouping rows into households.
          Use a capture group for the base id (e.g. <code className="font-mono">^(\d+)(D\d+)$</code> maps 87499409D1 → 87499409).
        </p>
        <textarea
          className={`${inputClass} font-mono text-xs min-h-[3.5rem]`}
          placeholder={'^(\\d+)(D\\d+)$\n^(MPB\\d+)([A-Z])$'}
          disabled={disabled}
          value={(r.householdMemberId?.suffixStripPatterns || []).join('\n')}
          onChange={(e) => {
            const suffixStripPatterns = e.target.value
              .split('\n')
              .map((line) => line.trim())
              .filter(Boolean);
            patch({
              householdMemberId: { suffixStripPatterns },
            });
          }}
        />
      </fieldset>

      <div className="space-y-2">
        {products.map((product) => {
          const open = expandedId === product.id;
          const uniqueProducts = [...new Map(
            pricingTiers.map((t) => [t.productId, { id: t.productId, name: t.productName }]),
          ).values()];
          return (
            <div key={product.id} className="border border-gray-200 rounded-lg bg-white overflow-hidden">
              <button
                type="button"
                className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-gray-50"
                onClick={() => setExpandedId(open ? null : product.id)}
                disabled={disabled}
              >
                <span className="text-sm font-medium text-gray-900">{product.label || 'Unnamed product'}</span>
                {open ? <ChevronUp className="h-4 w-4 text-gray-400" /> : <ChevronDown className="h-4 w-4 text-gray-400" />}
              </button>
              {open && (
                <div className="px-3 pb-3 space-y-3 border-t border-gray-100">
                  <label className="block text-xs text-gray-600">
                    Label
                    <input
                      className={`${inputClass} mt-1`}
                      value={product.label}
                      disabled={disabled}
                      onChange={(e) => updateProduct(product.id, { label: e.target.value })}
                    />
                  </label>
                  <label className="block text-xs text-gray-600">
                    AllAboard product
                    <select
                      className={`${selectClass} mt-1`}
                      value={product.targetProductId || ''}
                      disabled={disabled}
                      onChange={(e) => updateProduct(product.id, {
                        targetProductId: e.target.value || null,
                      })}
                    >
                      <option value="">— Select product —</option>
                      {uniqueProducts.map((up) => (
                        <option key={up.id} value={up.id}>{up.name}</option>
                      ))}
                    </select>
                  </label>

                  <fieldset disabled={disabled} className="space-y-2 rounded-lg border border-blue-100 p-2 bg-blue-50/30">
                    <legend className="text-xs font-semibold text-gray-700 px-1">Which rows?</legend>
                    <select
                      className={selectClass}
                      value={product.match.mode}
                      onChange={(e) => updateMatch(product.id, { mode: e.target.value as ProductMatch['mode'] })}
                    >
                      {Object.entries(MATCH_MODE_LABELS).map(([id, label]) => (
                        <option key={id} value={id}>{label}</option>
                      ))}
                    </select>
                    {product.match.mode !== 'always' && (
                      <>
                        <select
                          className={selectClass}
                          value={product.match.field || ''}
                          onChange={(e) => updateMatch(product.id, { field: e.target.value })}
                        >
                          <option value="">— Column —</option>
                          {columnHeaders.map((h) => (
                            <option key={h} value={h}>{h}</option>
                          ))}
                          {!columnHeaders.length && (
                            <option value={product.match.field || ''}>{product.match.field || 'Type column name'}</option>
                          )}
                        </select>
                        {product.match.mode === 'fieldEquals' && (
                          <input
                            className={inputClass}
                            placeholder="Values (comma-separated)"
                            value={(product.match.values || []).join(', ')}
                            onChange={(e) => updateMatch(product.id, {
                              values: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                            })}
                          />
                        )}
                      </>
                    )}
                  </fieldset>

                  <fieldset disabled={disabled} className="space-y-2 rounded-lg border border-emerald-100 p-2 bg-emerald-50/30">
                    <legend className="text-xs font-semibold text-gray-700 px-1">Pricing tier key</legend>
                    <select
                      className={selectClass}
                      value={product.keyStrategy.type}
                      onChange={(e) => updateKeyStrategy(product.id, { type: e.target.value as KeyStrategy['type'] })}
                    >
                      {Object.entries(KEY_STRATEGY_LABELS).map(([id, label]) => (
                        <option key={id} value={id}>{label}</option>
                      ))}
                    </select>

                    {(product.keyStrategy.type === 'composite') && (
                      <textarea
                        className={`${inputClass} font-mono text-xs min-h-[3rem]`}
                        value={(product.keyStrategy.compositeFields || []).join('\n')}
                        placeholder={'ABProductID,Product_ID\nABBenefitIdOverride,Benefit_ID'}
                        onChange={(e) => updateKeyStrategy(product.id, {
                          compositeFields: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean),
                        })}
                      />
                    )}

                    {(product.keyStrategy.type === 'planCode'
                      || product.keyStrategy.type === 'composite') && (
                      <input
                        className={`${inputClass} font-mono text-xs`}
                        placeholder="Plan label columns"
                        value={product.keyStrategy.planCodeFields || ''}
                        onChange={(e) => updateKeyStrategy(product.id, { planCodeFields: e.target.value })}
                      />
                    )}

                    {(product.keyStrategy.type === 'planCode'
                      || product.keyStrategy.type === 'composite'
                      || product.keyStrategy.type === 'codedMap'
                      || product.keyStrategy.type === 'householdTier') && (
                      <>
                        <input
                          className={`${inputClass} font-mono text-xs`}
                          placeholder="Tier / coverage columns"
                          value={product.keyStrategy.tierFields || ''}
                          onChange={(e) => updateKeyStrategy(product.id, { tierFields: e.target.value })}
                        />
                        <input
                          className={`${inputClass} font-mono text-xs`}
                          placeholder="UA columns"
                          value={product.keyStrategy.uaFields || ''}
                          onChange={(e) => updateKeyStrategy(product.id, { uaFields: e.target.value })}
                        />
                      </>
                    )}

                    {product.keyStrategy.type === 'codedMap' && (
                      <textarea
                        className={`${inputClass} font-mono text-xs min-h-[2.5rem]`}
                        placeholder="F=EF, I=EE, C=ES, P=EC (one per line: code=tier)"
                        value={Object.entries(product.keyStrategy.valueMap || {})
                          .map(([k, v]) => `${k}=${v}`)
                          .join('\n')}
                        onChange={(e) => {
                          const vm: Record<string, string> = {};
                          for (const line of e.target.value.split('\n')) {
                            const [k, v] = line.split('=').map((s) => s.trim());
                            if (k && v) vm[k.toUpperCase()] = v.toUpperCase();
                          }
                          updateKeyStrategy(product.id, { valueMap: vm });
                        }}
                      />
                    )}
                  </fieldset>

                  <button
                    type="button"
                    className="text-xs text-red-600 hover:underline flex items-center gap-1"
                    disabled={disabled}
                    onClick={() => {
                      setProducts(products.filter((p) => p.id !== product.id));
                      if (expandedId === product.id) setExpandedId(null);
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Remove product
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <button
        type="button"
        disabled={disabled}
        className="inline-flex items-center gap-1.5 text-sm font-medium text-oe-primary hover:text-oe-dark"
        onClick={() => {
          const p = newProduct();
          setProducts([...products, p]);
          setExpandedId(p.id);
        }}
      >
        <Plus className="h-4 w-4" /> Add product
      </button>

      {!products.length && (
        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
          No products configured — legacy single plan-key rules from the format preset still apply until you add a product.
        </p>
      )}
    </div>
  );
};

export default ImportRulesEditor;
