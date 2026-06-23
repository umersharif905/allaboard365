import React from 'react';
import { getCardBrand } from '../../utils/payment-validation';

interface Props {
  cardNumber: string;
  className?: string;
}

/**
 * Read-only line showing card network detected from the PAN (no manual brand dropdown).
 */
export function DetectedCardBrandLine({ cardNumber, className = '' }: Props) {
  const digits = (cardNumber || '').replace(/\D/g, '');
  if (digits.length < 4) return null;
  const brand = getCardBrand(digits);
  if (brand === 'Unknown') {
    if (digits.length >= 13) {
      return (
        <p className={`text-sm text-amber-700 ${className}`}>Card type could not be recognized</p>
      );
    }
    return null;
  }
  return (
    <p className={`text-sm text-gray-600 ${className}`}>
      Card type:{' '}
      <span className="font-medium text-gray-900">{brand}</span>
    </p>
  );
}
