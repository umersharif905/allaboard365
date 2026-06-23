/**
 * Payment Information Validation Utilities
 * Credit card and ACH/bank account validation functions
 */
import valid from 'card-validator';

/** Display labels aligned with form dropdowns (DIME uses Amex on the API). */
const CARD_TYPE_TO_DISPLAY: Record<string, string> = {
  visa: 'Visa',
  mastercard: 'MasterCard',
  'american-express': 'American Express',
  discover: 'Discover',
  jcb: 'JCB',
  'diners-club': 'Diners Club',
};

/**
 * Detect credit card brand from card number (card-validator / credit-card-type)
 * @param cardNumber - Credit card number (with or without spaces/dashes)
 * @returns Card brand name for UI
 */
export const getCardBrand = (cardNumber: string): string => {
  if (!cardNumber) return 'Unknown';
  const cleanNumber = cardNumber.replace(/\D/g, '');
  const n = valid.number(cleanNumber);
  if (n.card?.type && CARD_TYPE_TO_DISPLAY[n.card.type]) {
    return CARD_TYPE_TO_DISPLAY[n.card.type];
  }
  return 'Unknown';
};

/**
 * Validate credit card number using Luhn algorithm
 * @param cardNumber - Credit card number
 * @returns Validation result with error message if invalid
 */
export const validateCreditCard = (cardNumber: string): { isValid: boolean; error?: string; brand?: string } => {
  if (!cardNumber) {
    return { isValid: false, error: 'Card number is required' };
  }

  const cleanNumber = cardNumber.replace(/\D/g, '');
  const n = valid.number(cleanNumber);

  if (cleanNumber.length < 13 || cleanNumber.length > 19) {
    return { isValid: false, error: 'Card number must be between 13-19 digits' };
  }

  const brand = getCardBrand(cardNumber);
  const isValid = n.isValid;
  return {
    isValid,
    brand,
    error: isValid ? undefined : 'Invalid card number'
  };
};

/**
 * Validate credit card expiration date
 * @param expiryDate - Expiration date in MM/YYYY format
 * @returns Validation result with error message if invalid
 */
export const validateExpiryDate = (expiryDate: string): { isValid: boolean; error?: string } => {
  if (!expiryDate) {
    return { isValid: false, error: 'Expiration date is required' };
  }

  const parts = expiryDate.split('/');
  if (parts.length !== 2) {
    return { isValid: false, error: 'Invalid format (use MM/YYYY)' };
  }

  const month = parseInt(parts[0], 10);
  const year = parseInt(parts[1], 10);

  if (isNaN(month) || isNaN(year)) {
    return { isValid: false, error: 'Invalid month or year' };
  }

  if (month < 1 || month > 12) {
    return { isValid: false, error: 'Month must be between 01 and 12' };
  }

  // Convert 2-digit year to 4-digit
  const fullYear = year < 100 ? 2000 + year : year;
  
  // Check if card is expired
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;

  if (fullYear < currentYear || (fullYear === currentYear && month < currentMonth)) {
    return { isValid: false, error: 'Card has expired' };
  }

  // Check if expiration is too far in future (10 years)
  if (fullYear > currentYear + 10) {
    return { isValid: false, error: 'Invalid expiration year' };
  }

  return { isValid: true };
};

/**
 * Validate CVV code
 * @param cvv - CVV code
 * @param cardBrand - Card brand (Amex has 4 digits, others have 3)
 * @param cardNumber - Optional; when set, CVV length follows card type from the number
 * @returns Validation result with error message if invalid
 */
export const validateCVV = (
  cvv: string,
  cardBrand?: string,
  cardNumber?: string
): { isValid: boolean; error?: string } => {
  if (!cvv) {
    return { isValid: false, error: 'CVV is required' };
  }

  const cleanCVV = cvv.replace(/\D/g, '');
  let expectedLength = 3;
  if (cardNumber) {
    const n = valid.number(cardNumber.replace(/\D/g, ''));
    if (n.card?.code?.size) {
      expectedLength = n.card.code.size;
    } else if (cardBrand === 'American Express') {
      expectedLength = 4;
    }
  } else if (cardBrand === 'American Express') {
    expectedLength = 4;
  }

  const cvvResult = valid.cvv(cleanCVV, expectedLength);
  if (!cvvResult.isValid) {
    return {
      isValid: false,
      error: `CVV must be ${expectedLength} digits${expectedLength === 4 ? ' for American Express' : ''}`
    };
  }

  return { isValid: true };
};

/**
 * Validate routing number (US banks use 9-digit routing numbers)
 * @param routingNumber - Bank routing number
 * @returns Validation result with error message if invalid
 */
export const validateRoutingNumber = (routingNumber: string): { isValid: boolean; error?: string } => {
  if (!routingNumber) {
    return { isValid: false, error: 'Routing number is required' };
  }

  const cleanNumber = routingNumber.replace(/\D/g, '');
  
  if (cleanNumber.length !== 9) {
    return { isValid: false, error: 'Routing number must be 9 digits' };
  }

  // ABA routing number checksum validation
  const digits = cleanNumber.split('').map(Number);
  const checksum = (
    3 * (digits[0] + digits[3] + digits[6]) +
    7 * (digits[1] + digits[4] + digits[7]) +
    (digits[2] + digits[5] + digits[8])
  ) % 10;

  if (checksum !== 0) {
    return { isValid: false, error: 'Invalid routing number' };
  }

  return { isValid: true };
};

/**
 * Validate bank account number
 * @param accountNumber - Bank account number
 * @returns Validation result with error message if invalid
 */
export const validateAccountNumber = (accountNumber: string): { isValid: boolean; error?: string } => {
  if (!accountNumber) {
    return { isValid: false, error: 'Account number is required' };
  }

  const cleanNumber = accountNumber.replace(/\D/g, '');
  
  // US account numbers are typically 8-20 digits
  if (cleanNumber.length < 8 || cleanNumber.length > 20) {
    return { isValid: false, error: 'Account number must be between 8-20 digits' };
  }

  return { isValid: true };
};

/**
 * Format credit card number with spaces for display
 * @param cardNumber - Raw card number
 * @returns Formatted card number (e.g., "4111 1111 1111 1111")
 */
export const formatCardNumber = (cardNumber: string): string => {
  const cleanNumber = cardNumber.replace(/\D/g, '');
  const chunks = cleanNumber.match(/.{1,4}/g) || [];
  return chunks.join(' ');
};

/**
 * Format expiration date as MM/YYYY
 * @param value - Raw input value
 * @returns Formatted expiration date
 */
export const formatExpiryDate = (value: string): string => {
  let cleaned = value.replace(/\D/g, ''); // Remove non-digits
  
  // Format as MM/YYYY
  if (cleaned.length >= 2) {
    const month = cleaned.substring(0, 2);
    const year = cleaned.substring(2, 6);
    
    // Validate month (01-12)
    const monthNum = parseInt(month, 10);
    if (monthNum > 12) {
      cleaned = '12' + cleaned.substring(2); // Cap at 12
    }
    
    if (cleaned.length <= 2) {
      return month;
    } else {
      return month + '/' + year;
    }
  }
  
  return cleaned;
};

/**
 * Validate phone number (US format)
 * Accepts 10-digit numbers without country code
 * @param phoneNumber - Phone number
 * @returns Validation result with error message if invalid
 */
export const validatePhoneNumber = (phoneNumber: string): { isValid: boolean; error?: string } => {
  if (!phoneNumber) {
    return { isValid: false, error: 'Phone number is required' };
  }

  const cleanNumber = phoneNumber.replace(/\D/g, '');
  
  // Accept 10 digits (US without country code) or 11 digits (with +1)
  if (cleanNumber.length === 10) {
    return { isValid: true };
  }
  
  if (cleanNumber.length === 11 && cleanNumber.startsWith('1')) {
    return { isValid: true };
  }
  
  if (cleanNumber.length < 10) {
    return { isValid: false, error: `Phone number must be 10 digits (currently ${cleanNumber.length} digits)` };
  }
  
  if (cleanNumber.length > 11) {
    return { isValid: false, error: 'Phone number too long (max 11 digits with country code)' };
  }

  return { isValid: false, error: 'Invalid phone number format' };
};

/**
 * Format phone number to E.164 format for backend/API use
 * Automatically adds +1 for US numbers
 * @param phoneNumber - Raw phone number
 * @returns E.164 formatted phone number (e.g., "+18043866934")
 */
export const formatPhoneForAPI = (phoneNumber: string): string => {
  const cleanNumber = phoneNumber.replace(/\D/g, '');
  
  // If 10 digits, add +1
  if (cleanNumber.length === 10) {
    return `+1${cleanNumber}`;
  }
  
  // If 11 digits starting with 1, add +
  if (cleanNumber.length === 11 && cleanNumber.startsWith('1')) {
    return `+${cleanNumber}`;
  }
  
  // If already has +, return as is
  if (phoneNumber.startsWith('+')) {
    return phoneNumber;
  }
  
  // Otherwise, assume US and add +1
  return `+1${cleanNumber}`;
};

/**
 * US phone for storage / validation: digits only, max 10; strips leading country code 1.
 */
export const normalizeUsPhoneDigits = (input: string | null | undefined): string => {
  if (!input) return '';
  let d = String(input).replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) {
    d = d.slice(1);
  }
  return d.slice(0, 10);
};

/**
 * Format phone number for display
 * Handles various formats: NULL, empty, partial numbers, numbers with dashes, etc.
 * @param phoneNumber - Raw phone number (can be null, undefined, empty, or string)
 * @returns Formatted phone number (e.g., "(804) 386-6934") or empty string if invalid
 */
export const formatPhoneNumber = (phoneNumber: string | null | undefined): string => {
  // Handle NULL, undefined, or empty values
  if (!phoneNumber || phoneNumber.trim() === '') {
    return '';
  }
  
  // Remove all non-digit characters to get clean number
  const cleanNumber = phoneNumber.replace(/\D/g, '');
  
  // If no digits found, return empty string
  if (cleanNumber.length === 0) {
    return '';
  }
  
  // Handle 10-digit numbers (standard US format): (123) 456-7890
  if (cleanNumber.length === 10) {
    return `(${cleanNumber.substring(0, 3)}) ${cleanNumber.substring(3, 6)}-${cleanNumber.substring(6)}`;
  }
  
  // Handle 11-digit numbers with country code 1: +1 (123) 456-7890
  if (cleanNumber.length === 11 && cleanNumber.startsWith('1')) {
    return `+1 (${cleanNumber.substring(1, 4)}) ${cleanNumber.substring(4, 7)}-${cleanNumber.substring(7)}`;
  }
  
  // Handle 7-digit numbers (local number without area code): 555-1234
  if (cleanNumber.length === 7) {
    return `${cleanNumber.substring(0, 3)}-${cleanNumber.substring(3)}`;
  }
  
  // Handle 8-digit numbers (might be missing leading zero or non-US format)
  // Format as (123) 456-78 (treating first 3 as area code)
  if (cleanNumber.length === 8) {
    return `(${cleanNumber.substring(0, 3)}) ${cleanNumber.substring(3, 6)}-${cleanNumber.substring(6)}`;
  }
  
  // Handle 9-digit numbers (might be missing leading zero)
  // Format as (123) 456-789 (treating first 3 as area code)
  if (cleanNumber.length === 9) {
    return `(${cleanNumber.substring(0, 3)}) ${cleanNumber.substring(3, 6)}-${cleanNumber.substring(6)}`;
  }
  
  // For other lengths (too short or too long), return cleaned version
  // This handles edge cases and international numbers
  if (cleanNumber.length < 7) {
    // Too short, return as-is
    return cleanNumber;
  }
  
  // For longer numbers, try to format as US number if it starts with 1
  // Otherwise return cleaned version
  if (cleanNumber.length > 11) {
    // Too long, might be invalid or international - return cleaned
    return cleanNumber;
  }
  
  // Default: return cleaned number if no pattern matches
  return cleanNumber;
};

/**
 * Validate ZIP code (US format - 5 digits)
 * @param zipCode - ZIP code
 * @returns Validation result with error message if invalid
 */
export const validateZipCode = (zipCode: string): { isValid: boolean; error?: string } => {
  if (!zipCode) {
    return { isValid: false, error: 'ZIP code is required' };
  }

  const cleanZip = zipCode.replace(/\D/g, '');
  
  if (cleanZip.length !== 5) {
    return { isValid: false, error: 'ZIP code must be exactly 5 digits' };
  }

  return { isValid: true };
};

/**
 * Validate US state code (2-letter abbreviation)
 * @param stateCode - US state code
 * @returns Validation result with error message if invalid
 */
export const validateStateCode = (stateCode: string): { isValid: boolean; error?: string } => {
  if (!stateCode) {
    return { isValid: false, error: 'State is required' };
  }

  const validStates = [
    'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
    'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
    'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
    'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
    'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
    'DC', 'PR', 'VI', 'GU', 'AS', 'MP'
  ];

  if (!validStates.includes(stateCode.toUpperCase())) {
    return { isValid: false, error: 'Invalid state code' };
  }

  return { isValid: true };
};

