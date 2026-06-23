const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function digitsOnly(value: string): string {
  return String(value || '').replace(/\D/g, '');
}

export function getMemberAddressValidationError(
  address: string | undefined,
  phone?: string | undefined
): string | null {
  const addr = String(address || '').trim();
  if (!addr) return null;

  if (EMAIL_RE.test(addr)) {
    return 'Address must be a street address, not an email.';
  }

  const addrDigits = digitsOnly(addr);
  const phoneDigits = digitsOnly(phone || '');
  if (addrDigits.length >= 10) {
    if (phoneDigits && addrDigits === phoneDigits) {
      return 'Address must be a street address, not a phone number.';
    }
    if (/^\d+$/.test(addr)) {
      return 'Address must be a street address, not a phone number.';
    }
  }

  if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(addr)) {
    return 'Address must be a street address, not a date.';
  }

  if (!/[a-zA-Z]/.test(addr)) {
    return 'Address must include a street name.';
  }

  return null;
}
