import React, { useMemo } from 'react';
import {
  csvHeadersFromTemplate,
  formatTobaccoYesValuesForInput,
  parseTobaccoYesValuesInput,
} from '../../../utils/formatPresetTobacco';

const inputClass =
  'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-oe-primary/30 focus:border-oe-primary';

export interface TobaccoDetectionConfigProps {
  formatLabel?: string;
  rowTemplate: string;
  tobaccoCsvColumn: string;
  tobaccoYesValues: string[];
  onChange: (next: { tobaccoCsvColumn: string; tobaccoYesValues: string[] }) => void;
  disabled?: boolean;
  /** When product tiers include Tobacco Yes/No, explain runtime behavior */
  hasTobaccoTiers?: boolean;
}

const TobaccoDetectionConfig: React.FC<TobaccoDetectionConfigProps> = ({
  formatLabel,
  rowTemplate,
  tobaccoCsvColumn,
  tobaccoYesValues,
  onChange,
  disabled,
  hasTobaccoTiers = true,
}) => {
  const columnOptions = useMemo(() => csvHeadersFromTemplate(rowTemplate), [rowTemplate]);

  return (
    <div className="rounded-lg border border-blue-200 bg-blue-50/60 p-4 space-y-3">
      <div>
        <h4 className="text-sm font-semibold text-gray-900">Tobacco detection</h4>
        <p className="text-xs text-gray-600 mt-0.5">
          {formatLabel
            ? <>Per format <strong>{formatLabel}</strong> — </>
            : null}
          Which CSV column and value mean tobacco <strong>Yes</strong>. At import, each mapped plan code uses the
          matching <strong>Tobacco Yes</strong> or <strong>No</strong> pricing tier
          {hasTobaccoTiers ? '' : ' (when your product has tobacco tiers)'}.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-xs text-gray-700">
          CSV column
          <select
            className={`${inputClass} mt-1`}
            value={tobaccoCsvColumn}
            disabled={disabled}
            onChange={(e) =>
              onChange({ tobaccoCsvColumn: e.target.value, tobaccoYesValues })
            }
          >
            <option value="">— Select column —</option>
            {columnOptions.map((h) => (
              <option key={h} value={h}>
                {h}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs text-gray-700">
          Values that mean tobacco Yes (comma-separated)
          <input
            className={`${inputClass} mt-1`}
            value={formatTobaccoYesValuesForInput(tobaccoYesValues)}
            disabled={disabled}
            placeholder="e.g. 100"
            onChange={(e) =>
              onChange({
                tobaccoCsvColumn,
                tobaccoYesValues: parseTobaccoYesValuesInput(e.target.value),
              })
            }
          />
          <span className="text-[11px] text-gray-500 mt-1 block">
            Blank or other values = non-tobacco. Align legacy uses <code className="bg-white px-1 rounded">100</code>.
            Any positive number also counts as Yes when no exact match is listed.
          </span>
        </label>
      </div>
    </div>
  );
};

export default TobaccoDetectionConfig;
