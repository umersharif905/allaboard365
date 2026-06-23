import React, { useState } from 'react';
import { GroupBadge } from './GroupBadge';
import type { GroupType } from './GroupBadge';
import { createRequest } from '../../services/groupTypeChangeRequests.service';

interface RequestTypeChangeModalProps {
  groupId: string;
  currentType: GroupType;
  onClose: () => void;
  onSuccess?: () => void;
}

type SubmitState = 'idle' | 'submitting' | 'pending' | 'approved' | 'error';

const TARGET_TYPE: Record<GroupType, GroupType> = {
  Standard: 'ListBill',
  ListBill: 'Standard',
};

const TARGET_LABEL: Record<GroupType, string> = {
  Standard: 'List Bill',
  ListBill: 'Standard',
};

const TYPE_DESCRIPTION: Record<GroupType, string> = {
  ListBill:
    'Each member enrolls in individual products, but everyone is consolidated onto one shared bill with a single payment method. Exempt from vendor employee minimums.',
  Standard:
    'Group-level enrollment. Subject to vendor minimum employees per group.',
};

export function RequestTypeChangeModal({
  groupId,
  currentType,
  onClose,
  onSuccess,
}: RequestTypeChangeModalProps) {
  const [reason, setReason] = useState('');
  const [submitState, setSubmitState] = useState<SubmitState>('idle');
  const [errorMessage, setErrorMessage] = useState<string>('');

  const targetType = TARGET_TYPE[currentType];
  const canSubmit = reason.trim().length >= 5 && submitState === 'idle';

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitState('submitting');
    setErrorMessage('');

    try {
      const result = await createRequest({
        groupId,
        requestedType: targetType,
        reason: reason.trim(),
      });

      if (result.Status === 'Approved') {
        setSubmitState('approved');
        onSuccess?.();
      } else {
        setSubmitState('pending');
      }
    } catch (err: any) {
      setSubmitState('error');
      setErrorMessage(
        err?.message || err?.response?.data?.message || 'An error occurred. Please try again.'
      );
    }
  };

  return (
    /* Backdrop */
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-lg border border-gray-200 w-full max-w-lg mx-4 shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">Request Group Type Change</h2>
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
          {/* Current → Target */}
          <div className="flex items-center gap-3 text-sm">
            <div className="flex flex-col items-start">
              <span className="text-xs text-gray-500 mb-1">Current type</span>
              {currentType === 'ListBill' ? (
                <GroupBadge type="ListBill" />
              ) : (
                <span className="font-medium text-gray-700">Standard</span>
              )}
            </div>
            <svg className="w-4 h-4 text-gray-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
            <div className="flex flex-col items-start">
              <span className="text-xs text-gray-500 mb-1">Requested type</span>
              {targetType === 'ListBill' ? (
                <GroupBadge type="ListBill" />
              ) : (
                <span className="font-medium text-gray-700">Standard</span>
              )}
            </div>
          </div>

          {/* Target type description */}
          <div className="rounded-md bg-oe-light px-4 py-3 text-sm text-gray-700">
            <span className="font-medium">{TARGET_LABEL[currentType]}:</span>{' '}
            {TYPE_DESCRIPTION[targetType]}
          </div>

          {/* Success states */}
          {submitState === 'pending' && (
            <div className="rounded-md bg-yellow-50 border border-yellow-200 px-4 py-3 text-sm text-yellow-800">
              <p className="font-medium">Request submitted — pending approval</p>
              <p className="mt-1 text-yellow-700">
                A TenantAdmin will review your request. You will be notified once a decision is made.
              </p>
            </div>
          )}

          {submitState === 'approved' && (
            <div className="rounded-md bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-800">
              <p className="font-medium">Approved — your group type has been updated</p>
              <p className="mt-1 text-green-700">
                Continue to the conversion wizard to select products and resend enrollment links.
              </p>
            </div>
          )}

          {/* Error */}
          {submitState === 'error' && errorMessage && (
            <div className="rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-800">
              {errorMessage}
            </div>
          )}

          {/* Reason field — only shown before final success */}
          {submitState !== 'pending' && submitState !== 'approved' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Reason for change <span className="text-red-600">*</span>
              </label>
              <textarea
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value);
                  if (submitState === 'error') setSubmitState('idle');
                }}
                rows={3}
                placeholder="Describe why you need to change the group type (minimum 5 characters)"
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-oe-primary resize-none"
              />
              {reason.trim().length > 0 && reason.trim().length < 5 && (
                <p className="mt-1 text-xs text-red-600">Reason must be at least 5 characters.</p>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 px-6 py-4 border-t border-gray-200">
          {submitState !== 'pending' && submitState !== 'approved' ? (
            <>
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={!canSubmit}
                className="px-4 py-2 text-sm font-medium text-white bg-oe-primary rounded-lg hover:bg-oe-dark disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {submitState === 'submitting' ? 'Submitting...' : 'Submit Request'}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
