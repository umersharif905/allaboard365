import React from 'react';

interface Props {
  /** DebitCard is treated like CreditCard in the UI (same segment); use when editing an existing debit card. */
  value: 'ACH' | 'CreditCard' | 'DebitCard';
  onChange: (next: 'ACH' | 'CreditCard') => void;
  disabled?: boolean;
  /** When true (e.g. editing an existing method), switching type is not allowed */
  lockType?: boolean;
}

/**
 * Card vs ACH choice without a &lt;select&gt; dropdown — segmented buttons.
 */
export function PaymentMethodTypeToggle({ value, onChange, disabled, lockType }: Props) {
  const baseBtn =
    'flex-1 px-4 py-2.5 text-sm font-medium rounded-md transition-colors focus:outline-none focus:ring-2 focus:ring-oe-primary focus:ring-offset-1';
  const active = 'bg-white text-gray-900 shadow-sm border border-gray-200';
  const inactive = 'text-gray-600 hover:text-gray-900 hover:bg-gray-100/80';
  const isCardSelected = value === 'CreditCard' || value === 'DebitCard';

  return (
    <div>
      <span className="block text-sm font-medium text-gray-700 mb-2">Payment method</span>
      <div
        className={`flex rounded-lg border border-gray-200 p-1 bg-gray-50 gap-1 ${lockType || disabled ? 'opacity-75' : ''}`}
        role="group"
        aria-label="Payment method type"
      >
        <button
          type="button"
          disabled={disabled || lockType}
          onClick={() => {
            if (!isCardSelected) onChange('CreditCard');
          }}
          className={`${baseBtn} ${isCardSelected ? active : inactive}`}
        >
          Credit or debit card
        </button>
        <button
          type="button"
          disabled={disabled || lockType}
          onClick={() => {
            if (value !== 'ACH') onChange('ACH');
          }}
          className={`${baseBtn} ${value === 'ACH' ? active : inactive}`}
        >
          Bank account (ACH)
        </button>
      </div>
      {lockType && (
        <p className="text-xs text-gray-500 mt-1">Payment type cannot be changed when updating this method.</p>
      )}
    </div>
  );
}
