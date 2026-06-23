import React from 'react';

export interface LicenseValidationProduct {
  productId: string;
  productName: string;
  productType: string;
  isBundle: boolean;
  requiredLicenses: string[];
  matchedLicenses: string[];
  missingLicenses: string[];
  /** Required license types satisfied by the direct upline agent's active, non-expired licenses */
  licensesSatisfiedByUpline?: string[];
  validationError?: string | null;
  isValid: boolean;
}

interface PerProductLicenseValidationSummaryProps {
  items: LicenseValidationProduct[];
  isLoading?: boolean;
  onFix?: () => void;
}

const PerProductLicenseValidationSummary: React.FC<PerProductLicenseValidationSummaryProps> = ({
  items,
  onFix
}) => {
  const unresolved = items.filter((item) => !item.isValid);

  if (unresolved.length === 0) {
    return null;
  }

  return (
    <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h5 className="text-sm font-semibold text-red-900">License validation</h5>
          <p className="text-xs text-red-700">
            {unresolved.length} product{unresolved.length === 1 ? '' : 's'} need license updates.
          </p>
        </div>
        {onFix && (
          <button
            type="button"
            onClick={onFix}
            className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700"
          >
            Fix
          </button>
        )}
      </div>

      <div className="mt-3 space-y-2">
        {unresolved.map((item) => (
          <div key={item.productId} className="rounded-md border border-red-300 bg-red-100/70 p-2.5">
            <p className="text-sm font-medium text-red-900">{item.productName}</p>
            {item.validationError ? (
              <p className="mt-1 text-xs text-red-700">{item.validationError}</p>
            ) : (
              <p className="mt-1 text-xs text-red-700">
                Missing: {item.missingLicenses.join(', ')}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

export default PerProductLicenseValidationSummary;
