import React, { useCallback, useRef } from 'react';
import { normalizeUsPhoneDigits } from '../../../utils/payment-validation';

type Props = {
  value: string;
  onChange: (digits: string) => void;
  invalid?: boolean;
  disabled?: boolean;
  /** id for first input — associate with external <label htmlFor> */
  firstInputId?: string;
};

/**
 * +1 (US) phone entry as numeric segments 3-3-4. Value is 10 digits only (no country code in state).
 * Prefill passes normalized digits; paste of full numbers is supported.
 */
export function UsPhoneSlotsInput({
  value,
  onChange,
  invalid,
  disabled,
  firstInputId,
}: Props) {
  const d = normalizeUsPhoneDigits(value);
  const a = d.slice(0, 3);
  const b = d.slice(3, 6);
  const c = d.slice(6, 10);

  const refA = useRef<HTMLInputElement>(null);
  const refB = useRef<HTMLInputElement>(null);
  const refC = useRef<HTMLInputElement>(null);

  const emit = useCallback(
    (nextA: string, nextB: string, nextC: string) => {
      const merged = normalizeUsPhoneDigits(nextA + nextB + nextC).slice(0, 10);
      onChange(merged);
    },
    [onChange]
  );

  const handleSegment = (index: 0 | 1 | 2, raw: string) => {
    if (disabled) return;
    const digits = raw.replace(/\D/g, '');

    // First box: accept paste / autofill of full national number
    if (index === 0 && digits.length > 3) {
      const full = digits.slice(0, 10);
      onChange(full);
      if (full.length >= 6) refC.current?.focus();
      else if (full.length >= 3) refB.current?.focus();
      return;
    }

    let nextA = a;
    let nextB = b;
    let nextC = c;
    if (index === 0) nextA = digits.slice(0, 3);
    else if (index === 1) nextB = digits.slice(0, 3);
    else nextC = digits.slice(0, 4);

    emit(nextA, nextB, nextC);

    const cap = index === 0 ? 3 : index === 1 ? 3 : 4;
    const seg = index === 0 ? nextA : index === 1 ? nextB : nextC;
    if (seg.length >= cap) {
      if (index === 0) refB.current?.focus();
      if (index === 1) refC.current?.focus();
    }
  };

  const onKeyDown = (index: 0 | 1 | 2, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Backspace') return;
    const seg = index === 0 ? a : index === 1 ? b : c;
    if (seg.length > 0) return;

    e.preventDefault();
    if (index === 1) {
      refA.current?.focus();
      emit(a.slice(0, -1), b, c);
    } else if (index === 2) {
      refB.current?.focus();
      emit(a, b.slice(0, -1), c);
    }
  };

  const onPaste = (e: React.ClipboardEvent) => {
    if (disabled) return;
    const text = e.clipboardData.getData('text/plain');
    const full = normalizeUsPhoneDigits(text);
    if (full.length === 0) return;
    e.preventDefault();
    onChange(full.slice(0, 10));
    if (full.length >= 6) refC.current?.focus();
    else if (full.length >= 3) refB.current?.focus();
    else refA.current?.focus();
  };

  const slotClass = `w-[4.25rem] text-center font-mono text-sm tracking-wider px-2 py-2 border rounded-lg focus:ring-2 focus:ring-oe-primary focus:outline-none disabled:bg-gray-50 disabled:text-gray-500 ${
    invalid ? 'border-red-300' : 'border-gray-300'
  }`;
  const slotClassLine = `${slotClass} w-[5.25rem]`;

  return (
    <div className="flex flex-wrap items-center gap-2" onPaste={onPaste}>
      <span
        className={`inline-flex items-center px-3 py-2 rounded-lg border text-sm font-medium tabular-nums shrink-0 ${
          invalid ? 'border-red-300 bg-red-50 text-gray-800' : 'border-gray-200 bg-gray-50 text-gray-700'
        }`}
        aria-hidden
      >
        +1
      </span>
      <div className="inline-flex items-center gap-1.5 sm:gap-2">
        <input
          ref={refA}
          id={firstInputId}
          type="text"
          inputMode="numeric"
          autoComplete="tel-national"
          name="phone-area"
          disabled={disabled}
          value={a}
          onChange={(e) => handleSegment(0, e.target.value)}
          onKeyDown={(e) => onKeyDown(0, e)}
          placeholder="•••"
          className={slotClass}
          aria-label="Area code, 3 digits"
        />
        <input
          ref={refB}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          disabled={disabled}
          value={b}
          onChange={(e) => handleSegment(1, e.target.value)}
          onKeyDown={(e) => onKeyDown(1, e)}
          placeholder="•••"
          className={slotClass}
          aria-label="Phone prefix, 3 digits"
        />
        <input
          ref={refC}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          disabled={disabled}
          value={c}
          onChange={(e) => handleSegment(2, e.target.value)}
          onKeyDown={(e) => onKeyDown(2, e)}
          placeholder="••••"
          className={slotClassLine}
          aria-label="Line number, 4 digits"
        />
      </div>
    </div>
  );
}
