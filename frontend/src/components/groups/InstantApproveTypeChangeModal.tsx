import { useState } from 'react';
import { GroupBadge } from './GroupBadge';
import type { GroupType } from './GroupBadge';
import { instantApprove } from '../../services/groupTypeChangeRequests.service';

interface InstantApproveTypeChangeModalProps {
  groupId: string;
  currentType: GroupType;
  /** Called with the wizardUrl returned by the API on success. */
  onSuccess: (wizardUrl: string) => void;
  onClose: () => void;
}

const TYPE_DESCRIPTION: Record<GroupType, string> = {
  ListBill:
    'Each member enrolls in individual products, but everyone is consolidated onto one shared bill with a single payment method. Exempt from vendor employee minimums.',
  Standard:
    'Group-level enrollment. Subject to vendor minimum employees per group.',
};

const TYPE_LABEL: Record<GroupType, string> = {
  Standard: 'Standard',
  ListBill: 'List Bill',
};

/**
 * TenantAdmin / SysAdmin "Make change now" modal — bypasses the
 * agent request → tenant-admin approval flow and pre-approves a
 * type-change request, then routes the user into the wizard.
 *
 * Only the type that differs from `currentType` is offered.
 */
export function InstantApproveTypeChangeModal({
  groupId,
  currentType,
  onSuccess,
  onClose,
}: InstantApproveTypeChangeModalProps) {
  const targetType: GroupType = currentType === 'Standard' ? 'ListBill' : 'Standard';
  const [selectedType, setSelectedType] = useState<GroupType>(targetType);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string>('');

  const handleSubmit = async () => {
    setSubmitting(true);
    setErrorMessage('');
    try {
      const result = await instantApprove({ groupId, requestedType: selectedType });
      onSuccess(result.wizardUrl);
    } catch (err: any) {
      setSubmitting(false);
      setErrorMessage(
        err?.response?.data?.message || err?.message || 'Failed to start type change.'
      );
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-lg border border-gray-200 w-full max-w-lg mx-4 shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">Change Group Type Now</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors"
            aria-label="Close"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-5">
          <div className="text-sm text-gray-700">
            <span className="text-xs text-gray-500 mr-2">Current type:</span>
            {currentType === 'ListBill' ? (
              <GroupBadge type="ListBill" />
            ) : (
              <span className="font-medium text-gray-700">Standard</span>
            )}
          </div>

          <div>
            <p className="text-sm font-medium text-gray-700 mb-2">Convert to:</p>
            <label className="flex items-start gap-3 rounded-md border border-gray-200 p-3 cursor-pointer hover:bg-gray-50">
              <input
                type="radio"
                name="targetType"
                value={targetType}
                checked={selectedType === targetType}
                onChange={() => setSelectedType(targetType)}
                className="mt-1 h-4 w-4 text-oe-primary focus:ring-oe-primary"
              />
              <div className="flex-1">
                <div className="font-medium text-gray-900">{TYPE_LABEL[targetType]}</div>
                <div className="mt-1 text-xs text-gray-600">{TYPE_DESCRIPTION[targetType]}</div>
              </div>
            </label>
          </div>

          <div className="rounded-md bg-oe-light px-4 py-3 text-xs text-gray-700">
            This bypasses the agent request flow. You'll go straight into the conversion wizard
            to pick products and decide what happens to existing enrollments. The group type
            won't actually flip until you finish the wizard.
          </div>

          {errorMessage && (
            <div className="rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-800">
              {errorMessage}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 px-6 py-4 border-t border-gray-200">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            className="px-4 py-2 text-sm font-medium text-white bg-oe-primary rounded-lg hover:bg-oe-dark disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {submitting ? 'Starting...' : 'Start Conversion'}
          </button>
        </div>
      </div>
    </div>
  );
}
