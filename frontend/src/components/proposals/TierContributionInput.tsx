import React, { useCallback, useEffect, useState } from 'react';

type Tier = 'EE' | 'E1' | 'EC' | 'EF';
type ValueType = 'dollar' | 'percentage';

type TierMap<T> = { EE: T; E1: T; EC?: T; EF: T };

interface TierContributionInputProps {
  label: string;
  tierPrices: TierMap<number>;
  values: TierMap<number>;
  valueTypes: TierMap<ValueType>;
  onValueChange: (tier: Tier, value: number) => void;
  onValueTypeChange: (tier: Tier, type: ValueType) => void;
  /** When true, render the EC (Employee+Children) column. Defaults to false. */
  includeEC?: boolean;
}

const TIER_LABELS: Record<Tier, string> = {
  EE: 'Employee Only',
  E1: 'Employee + One',
  EC: 'Employee + Children',
  EF: 'Employee + Family',
};

function computeEquivalent(
  valueType: ValueType,
  value: number,
  tierPrice: number
): { text: string; show: boolean } {
  if (tierPrice <= 0 || value < 0) return { text: '', show: false };
  if (valueType === 'percentage') {
    const dollarAmt = Math.round(tierPrice * value / 100);
    return { text: `($${dollarAmt.toLocaleString()})`, show: true };
  }
  const pct = Math.round((value / tierPrice) * 100);
  return { text: `(${pct}%)`, show: true };
}

function resolveEEDollar(
  eeValueType: ValueType,
  eeValue: number,
  eeTierPrice: number
): number {
  if (eeValueType === 'dollar') return eeValue;
  return Math.round(eeTierPrice * eeValue / 100);
}

const TierContributionInput: React.FC<TierContributionInputProps> = ({
  label,
  tierPrices,
  values,
  valueTypes,
  onValueChange,
  onValueTypeChange,
  includeEC = false,
}) => {
  const [applyEEToAll, setApplyEEToAll] = useState(false);
  const tiers: Tier[] = includeEC ? ['EE', 'E1', 'EC', 'EF'] : ['EE', 'E1', 'EF'];
  const gridColsClass = includeEC ? 'grid grid-cols-4 gap-3' : 'grid grid-cols-3 gap-3';
  const applyEELabel = includeEC ? 'Apply EE value to E1, EC & EF' : 'Apply EE value to E1 & EF';

  const propagateEE = useCallback(() => {
    if (!applyEEToAll) return;
    const dollarAmt = resolveEEDollar(valueTypes.EE, values.EE, tierPrices.EE);
    onValueTypeChange('E1', 'dollar');
    onValueTypeChange('EF', 'dollar');
    onValueChange('E1', dollarAmt);
    onValueChange('EF', dollarAmt);
    if (includeEC) {
      onValueTypeChange('EC', 'dollar');
      onValueChange('EC', dollarAmt);
    }
  }, [applyEEToAll, valueTypes.EE, values.EE, tierPrices.EE, includeEC, onValueChange, onValueTypeChange]);

  useEffect(() => {
    propagateEE();
  }, [propagateEE]);

  const handleToggleApplyEE = (checked: boolean) => {
    setApplyEEToAll(checked);
    if (checked) {
      const dollarAmt = resolveEEDollar(valueTypes.EE, values.EE, tierPrices.EE);
      onValueTypeChange('E1', 'dollar');
      onValueTypeChange('EF', 'dollar');
      onValueChange('E1', dollarAmt);
      onValueChange('EF', dollarAmt);
      if (includeEC) {
        onValueTypeChange('EC', 'dollar');
        onValueChange('EC', dollarAmt);
      }
    }
  };

  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-2">{label}</label>
      <div className={gridColsClass}>
        {tiers.map((tier) => {
          const vt = (valueTypes[tier] || 'percentage') as ValueType;
          const val = values[tier] ?? 0;
          const price = tierPrices[tier] ?? 0;
          const eq = computeEquivalent(vt, val, price);
          const isLocked = applyEEToAll && tier !== 'EE';

          return (
            <div key={tier}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-medium text-gray-600">
                  {tier} ({TIER_LABELS[tier]})
                </span>
                {eq.show && (
                  <span className="text-xs text-gray-400 italic">{eq.text}</span>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                {/* $/% segmented toggle */}
                <div className="inline-flex rounded-md shadow-sm flex-shrink-0">
                  <button
                    type="button"
                    className={`w-7 py-1.5 text-xs font-medium rounded-l-md border text-center ${
                      vt === 'percentage'
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'bg-gray-100 text-gray-600 border-gray-300 hover:bg-gray-200'
                    }`}
                    onClick={() => {
                      if (!isLocked) onValueTypeChange(tier, 'percentage');
                    }}
                    disabled={isLocked}
                  >
                    %
                  </button>
                  <button
                    type="button"
                    className={`w-7 py-1.5 text-xs font-medium rounded-r-md border-t border-b border-r text-center ${
                      vt === 'dollar'
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'bg-gray-100 text-gray-600 border-gray-300 hover:bg-gray-200'
                    }`}
                    onClick={() => {
                      if (!isLocked) onValueTypeChange(tier, 'dollar');
                    }}
                    disabled={isLocked}
                  >
                    $
                  </button>
                </div>
                {/* Number input with prefix/suffix */}
                <div className="relative flex-1 min-w-0">
                  {vt === 'dollar' && (
                    <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 text-sm pointer-events-none">$</span>
                  )}
                  <input
                    type="number"
                    min={0}
                    max={vt === 'percentage' ? 100 : undefined}
                    value={val || ''}
                    onChange={(e) => onValueChange(tier, Number(e.target.value) || 0)}
                    readOnly={isLocked}
                    className={`w-full border border-gray-300 rounded-md text-sm py-1.5 text-center ${
                      vt === 'dollar' ? 'pl-5 pr-2' : 'pl-2 pr-6'
                    } ${isLocked ? 'bg-gray-100 text-gray-500 cursor-not-allowed' : ''}`}
                    placeholder="0"
                  />
                  {vt === 'percentage' && (
                    <span className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 text-sm pointer-events-none">%</span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {/* "Apply EE to all" checkbox — below the row */}
      <label className="flex items-center gap-1.5 mt-2 cursor-pointer">
        <input
          type="checkbox"
          checked={applyEEToAll}
          onChange={(e) => handleToggleApplyEE(e.target.checked)}
          className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 h-3.5 w-3.5"
        />
        <span className="text-xs text-gray-500">{applyEELabel}</span>
      </label>
    </div>
  );
};

export default TierContributionInput;
