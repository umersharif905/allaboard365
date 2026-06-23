import React from 'react';
import type { ConfigurationField } from '../types/sysadmin/addproductswizard.types';
import type { ProductFieldChange } from './productAiMerge';

export function formatValueForDisplay(
  value: unknown,
  fieldName?: string,
  existingValue?: unknown,
  configurationFields?: ConfigurationField[]
): React.ReactNode {
  if (value === null || value === undefined) {
    return <span className="text-gray-500 italic">(empty)</span>;
  }
  if (typeof value === 'boolean') return <span>{value ? 'Yes' : 'No'}</span>;

  if (fieldName === 'pricingTiers' && Array.isArray(value)) {
    if (value.length === 0) return <span className="text-gray-500 italic">(empty)</span>;

    const existingTierIds = new Set<string>();
    if (Array.isArray(existingValue)) {
      existingValue.forEach((tier: { id?: string }) => {
        if (tier.id) existingTierIds.add(tier.id);
      });
    }

    return (
      <div className="space-y-2">
        {value.map((tier: Record<string, unknown>, index: number) => {
          const tierId = tier.id as string | undefined;
          const isNew = !tierId || !existingTierIds.has(tierId);
          const isModified = Boolean(tierId && existingTierIds.has(tierId));
          const existingTier =
            isModified && Array.isArray(existingValue)
              ? (existingValue as Array<{ id?: string; label?: string; tierType?: string }>).find(
                  (t) => t.id === tierId
                )
              : null;
          const ageBands = tier.ageBands as Array<Record<string, unknown>> | undefined;

          return (
            <div key={index} className="text-xs bg-white p-2 rounded border border-gray-200">
              <div className="flex items-center justify-between mb-1">
                <div className="font-medium text-gray-900">
                  {(tier.label as string) ||
                    ((tier.tierType as string) && tier.tierType !== 'N/A'
                      ? (tier.tierType as string)
                      : existingTier?.tierType || existingTier?.label || `Tier ${index + 1}`)}
                </div>
                {isNew && (
                  <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800 border border-green-300">
                    NEW
                  </span>
                )}
                {isModified && (
                  <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800 border border-blue-300">
                    MODIFIED
                  </span>
                )}
              </div>
              {isModified && existingTier && (
                <div className="text-xs text-gray-500 mb-1">
                  Existing: {existingTier.label || existingTier.tierType || 'Unnamed'} → New:{' '}
                  {(tier.label as string) || (tier.tierType as string) || 'Unnamed'}
                </div>
              )}
              <div className="text-gray-600 mt-1">{ageBands?.length || 0} age band(s)</div>

              {configurationFields &&
                configurationFields.length > 0 &&
                ageBands &&
                ageBands.length > 0 &&
                (() => {
                  const configValues = new Map<string, string>();
                  ageBands.forEach((band) => {
                    configurationFields.forEach((configField, configIndex) => {
                      const configValue = band[`configValue${configIndex + 1}`];
                      if (configValue && configValue !== '' && !configValues.has(configField.fieldName)) {
                        configValues.set(configField.fieldName, String(configValue));
                      }
                    });
                  });
                  if (configValues.size === 0) return null;
                  return (
                    <div className="text-xs text-purple-600 font-medium mt-1">
                      Configuration Options:
                      <div className="mt-0.5 space-y-0.5">
                        {Array.from(configValues.entries()).map(([fname, val], i) => (
                          <div key={i} className="text-xs text-purple-700 pl-2">
                            • {fname}: {val}
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}

              {ageBands && ageBands.length > 0 && (
                <div className="mt-2 space-y-1">
                  {ageBands.slice(0, 3).map((band, bandIndex) => (
                    <div
                      key={bandIndex}
                      className="text-xs text-gray-600 pl-2 border-l-2 border-gray-300"
                    >
                      Ages {String(band.minAge)}-{String(band.maxAge)} ({String(band.tobaccoStatus || 'N/A')}) - $
                      {Number(band.msrpRate || 0).toFixed(2)}/mo
                    </div>
                  ))}
                  {ageBands.length > 3 && (
                    <div className="text-xs text-gray-500 pl-2">
                      ... and {ageBands.length - 3} more
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-gray-500 italic">(empty)</span>;
    if (value.length <= 10) {
      return (
        <ul className="list-disc list-inside space-y-1 text-xs">
          {value.map((item, index) => (
            <li key={index} className="break-words">
              {typeof item === 'object' ? (
                <code className="text-xs bg-gray-100 px-1 rounded">
                  {JSON.stringify(item).substring(0, 100)}
                  {JSON.stringify(item).length > 100 ? '...' : ''}
                </code>
              ) : (
                String(item)
              )}
            </li>
          ))}
        </ul>
      );
    }
    return (
      <div>
        <div className="text-xs font-medium mb-1">{value.length} items:</div>
        <ul className="list-disc list-inside space-y-1 text-xs">
          {value.slice(0, 10).map((item, index) => (
            <li key={index} className="break-words">
              {typeof item === 'object' ? (
                <code className="text-xs bg-gray-100 px-1 rounded">
                  {JSON.stringify(item).substring(0, 80)}...
                </code>
              ) : (
                String(item)
              )}
            </li>
          ))}
        </ul>
        <div className="text-xs text-gray-500 mt-1">... and {value.length - 10} more</div>
      </div>
    );
  }

  if (typeof value === 'object') {
    const str = JSON.stringify(value, null, 2);
    if (str.length > 500) {
      return (
        <pre className="text-xs bg-gray-100 p-2 rounded overflow-auto max-h-40 whitespace-pre-wrap break-words">
          {str.substring(0, 500)}...
        </pre>
      );
    }
    return (
      <pre className="text-xs bg-gray-100 p-2 rounded overflow-auto max-h-40 whitespace-pre-wrap break-words">
        {str}
      </pre>
    );
  }

  if (typeof value === 'string' && value.length > 200) {
    return (
      <div className="text-sm whitespace-pre-wrap break-words">
        {value.substring(0, 200)}...
        <span className="text-gray-500 text-xs"> ({value.length} characters total)</span>
      </div>
    );
  }

  return <span className="text-sm">{String(value)}</span>;
}

export function ProductAiChangesPreview({
  changes,
  configurationFields,
}: {
  changes: ProductFieldChange[];
  configurationFields?: ConfigurationField[];
}) {
  if (changes.length === 0) {
    return <p className="text-sm text-gray-600">No field changes detected in this proposal.</p>;
  }

  return (
    <div className="space-y-3">
      <div className="text-sm font-semibold text-gray-900">
        {changes.length} field(s) will be changed:
      </div>
      {changes.map((change, index) => (
        <div key={index} className="bg-gray-50 border border-gray-200 rounded-lg p-3">
          <div className="font-medium text-sm text-gray-900 mb-2">{change.field}</div>
          <div>
            <div className="text-gray-600 mb-1 text-xs font-medium">New Value:</div>
            <div className="bg-green-50 p-3 rounded border border-green-300 text-gray-800">
              {formatValueForDisplay(
                change.newValue,
                change.field,
                change.oldValue,
                configurationFields
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
