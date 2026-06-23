// src/utils/helpers.ts
// Utility functions for error handling and data processing

import React from 'react';
import { API_CONFIG } from '../config/api';
export const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as any).message);
  }
  return 'An unknown error occurred';
};

export const formatCurrency = (amount: number): string => {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD'
  }).format(amount);
};

/**
 * Parse calendar date (DOB, hire dates, billing dates) to avoid timezone conversion issues
 * For calendar dates, parse date parts separately to prevent timezone shifts
 * (e.g., "2025-11-05T00:00:00Z" should always be Nov 5, not Nov 4 in PST)
 * 
 * @param dateString - Date string from server (e.g., "2025-11-05T00:00:00Z" or "2025-11-05")
 * @returns Date object created from date parts (no timezone conversion)
 */
export const parseCalendarDate = (dateString: string | null | undefined): Date | null => {
  if (!dateString) return null;
  
  try {
    // Extract date part (before 'T' if ISO format)
    const [datePart] = dateString.split('T');
    const [year, month, day] = datePart.split('-');
    
    if (!year || !month || !day) {
      console.warn('Invalid date format:', dateString);
      return null;
    }
    
    // Create date from parts (month is 0-indexed in JS Date)
    return new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
  } catch (error) {
    console.error('Error parsing calendar date:', error);
    return null;
  }
};

/**
 * Whether the invoice due calendar date is strictly before today in the viewer's local calendar.
 * Avoids false "past due" on the due date itself when DueDate is stored as UTC midnight (same pattern as billing UI).
 */
export const isCalendarDueDateStrictlyBeforeToday = (dueDateIso: string | null | undefined): boolean => {
  const due = parseCalendarDate(dueDateIso);
  if (!due) return false;
  const now = new Date();
  const startOfTodayLocal = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return due.getTime() < startOfTodayLocal.getTime();
};

/**
 * Admin "must collect manually" past-due banner: backend Overdue wins; else calendar due date strictly before today.
 */
export const invoiceShowsPastDueCollectionBanner = (invoice: {
  Status?: string | null;
  DueDate?: string | null;
}): boolean => {
  const st = String(invoice?.Status || '').toLowerCase();
  if (st === 'overdue') return true;
  return isCalendarDueDateStrictlyBeforeToday(invoice?.DueDate ?? null);
};

/**
 * Format calendar date for input fields (YYYY-MM-DD format)
 * Parses date parts separately to avoid timezone conversion issues
 * 
 * @param dateString - Date string from server
 * @returns Formatted date string (YYYY-MM-DD) or empty string
 */
export const formatCalendarDateForInput = (dateString: string | null | undefined): string => {
  const date = parseCalendarDate(dateString);
  if (!date) return '';
  
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  
  return `${year}-${month}-${day}`;
};

/**
 * Format date for display
 * For calendar dates (billing, payment dates, effective dates), parse date parts separately
 * to avoid timezone conversion issues (e.g., "2025-11-05T00:00:00Z" showing as Nov 4 in PST)
 * 
 * @param date - Date string or Date object
 * @param isTimestamp - If true, treat as timestamp (use timezone conversion). If false, treat as calendar date (parse date parts)
 * @returns Formatted date string
 */
export const formatDate = (date: string | Date, isTimestamp: boolean = false): string => {
  if (!date) return '';
  
  try {
    let dateObj: Date;
    
    if (isTimestamp) {
      // For timestamps (when something was created/generated), use timezone conversion
      dateObj = typeof date === 'string' ? new Date(date) : date;
    } else {
      // For calendar dates (billing, payment dates), parse date parts separately
      // Server returns UTC dates like "2025-11-05T00:00:00Z"
      const dateString = typeof date === 'string' ? date : date.toISOString();
      const [datePart] = dateString.split('T');
      const [year, month, day] = datePart.split('-');
      dateObj = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
    }
    
    return dateObj.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  } catch (error) {
    console.error('Error formatting date:', error);
    return typeof date === 'string' ? date : date.toString();
  }
};

/**
 * Normalize date string to YYYY-MM-DD format
 * Handles various input formats: MM/DD/YYYY, DD/MM/YYYY, YYYY-MM-DD, M/D/YY, etc.
 * Uses UTC date parsing to avoid timezone conversion issues
 * 
 * @param dateString - Date string in any format
 * @returns Normalized date string (YYYY-MM-DD) or empty string if invalid
 */
export const normalizeDateToYYYYMMDD = (dateString: string | null | undefined): string => {
  if (!dateString || typeof dateString !== 'string') return '';
  
  const trimmed = dateString.trim();
  if (!trimmed) return '';
  
  // Already in YYYY-MM-DD format - validate and return
  const yyyyMMddRegex = /^(\d{4})-(\d{2})-(\d{2})$/;
  const yyyyMMddMatch = trimmed.match(yyyyMMddRegex);
  if (yyyyMMddMatch) {
    const [, year, month, day] = yyyyMMddMatch;
    const yearNum = parseInt(year, 10);
    const monthNum = parseInt(month, 10);
    const dayNum = parseInt(day, 10);
    
    // Validate: month 1-12, day 1-31, year reasonable (1900-2100)
    if (monthNum >= 1 && monthNum <= 12 && dayNum >= 1 && dayNum <= 31 && yearNum >= 1900 && yearNum <= 2100) {
      return trimmed; // Already correct format
    }
  }
  
  // Try MM/DD/YYYY or M/D/YYYY format (US format)
  const usDateRegex = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/;
  const usDateMatch = trimmed.match(usDateRegex);
  if (usDateMatch) {
    const [, month, day, year] = usDateMatch;
    let yearNum = parseInt(year, 10);
    
    // Handle 2-digit years: assume 00-30 = 2000-2030, 31-99 = 1931-1999
    if (year.length === 2) {
      yearNum = yearNum <= 30 ? 2000 + yearNum : 1900 + yearNum;
    }
    
    const monthNum = parseInt(month, 10);
    const dayNum = parseInt(day, 10);
    
    // Validate: month 1-12, day 1-31, year reasonable
    if (monthNum >= 1 && monthNum <= 12 && dayNum >= 1 && dayNum <= 31 && yearNum >= 1900 && yearNum <= 2100) {
      // Create date using UTC to avoid timezone issues
      // Use Date.UTC to ensure no timezone conversion
      const date = new Date(Date.UTC(yearNum, monthNum - 1, dayNum));
      
      // Verify the date is valid (handles invalid dates like Feb 30)
      if (date.getUTCFullYear() === yearNum && 
          date.getUTCMonth() === monthNum - 1 && 
          date.getUTCDate() === dayNum) {
        const normalizedYear = String(yearNum);
        const normalizedMonth = String(monthNum).padStart(2, '0');
        const normalizedDay = String(dayNum).padStart(2, '0');
        return `${normalizedYear}-${normalizedMonth}-${normalizedDay}`;
      }
    }
  }
  
  // Try DD/MM/YYYY format (European format) - only if it doesn't match US format
  const euDateRegex = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
  const euDateMatch = trimmed.match(euDateRegex);
  if (euDateMatch && !usDateMatch) {
    const [, day, month, year] = euDateMatch;
    const yearNum = parseInt(year, 10);
    const monthNum = parseInt(month, 10);
    const dayNum = parseInt(day, 10);
    
    // Validate: month 1-12, day 1-31, year reasonable
    if (monthNum >= 1 && monthNum <= 12 && dayNum >= 1 && dayNum <= 31 && yearNum >= 1900 && yearNum <= 2100) {
      const date = new Date(Date.UTC(yearNum, monthNum - 1, dayNum));
      
      if (date.getUTCFullYear() === yearNum && 
          date.getUTCMonth() === monthNum - 1 && 
          date.getUTCDate() === dayNum) {
        const normalizedYear = String(yearNum);
        const normalizedMonth = String(monthNum).padStart(2, '0');
        const normalizedDay = String(dayNum).padStart(2, '0');
        return `${normalizedYear}-${normalizedMonth}-${normalizedDay}`;
      }
    }
  }
  
  // Try parsing as ISO date string
  try {
    const date = new Date(trimmed);
    if (!isNaN(date.getTime())) {
      // Extract date parts to avoid timezone issues
      const year = date.getUTCFullYear();
      const month = date.getUTCMonth() + 1;
      const day = date.getUTCDate();
      
      // Validate reasonable date
      if (year >= 1900 && year <= 2100 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        const normalizedYear = String(year);
        const normalizedMonth = String(month).padStart(2, '0');
        const normalizedDay = String(day).padStart(2, '0');
        return `${normalizedYear}-${normalizedMonth}-${normalizedDay}`;
      }
    }
  } catch (error) {
    // Ignore parsing errors
  }
  
  // If all parsing attempts fail, return empty string
  console.warn('Could not normalize date:', dateString);
  return '';
};

export const truncateText = (text: string, maxLength: number): string => {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength) + '...';
};

/**
 * Mask SSN to show only last 4 digits (no dashes).
 * Example: *****1234
 */
export const maskSSN = (ssn: string | null | undefined): string => {
  if (!ssn || ssn.trim() === '') return '';
  
  // Remove all non-digit characters
  const cleanSSN = ssn.replace(/\D/g, '');
  
  // Must have at least 4 digits to mask
  if (cleanSSN.length < 4) return '';
  
  // Get last 4 digits
  const last4 = cleanSSN.slice(-4);
  
  return `*****${last4}`;
};

/**
 * Mask when only last four digits are known (e.g. *****1234).
 */
export const maskSSNLast4 = (last4: string | null | undefined): string => {
  if (!last4) return '';
  const d = String(last4).replace(/\D/g, '');
  if (d.length < 4) return '';
  return `*****${d.slice(-4)}`;
};

/**
 * Validate SSN format
 * Accepts 9 digits or XXX-XX-XXXX format
 * @param ssn - SSN string to validate
 * @returns Validation result with error message if invalid
 */
export const validateSSN = (ssn: string | null | undefined): { isValid: boolean; error?: string } => {
  if (!ssn || ssn.trim() === '') {
    return { isValid: true }; // Empty is valid (optional field)
  }
  
  // Remove all non-digit characters
  const cleanSSN = ssn.replace(/\D/g, '');
  
  // Must be exactly 9 digits
  if (cleanSSN.length !== 9) {
    return { isValid: false, error: 'SSN must be 9 digits (XXX-XX-XXXX format)' };
  }
  
  // Basic validation - cannot start with 000 or 666
  if (cleanSSN.startsWith('000') || cleanSSN.startsWith('666')) {
    return { isValid: false, error: 'SSN cannot start with 000 or 666' };
  }
  
  // Cannot be all the same digit
  if (/^(\d)\1{8}$/.test(cleanSSN)) {
    return { isValid: false, error: 'SSN cannot be all the same digit' };
  }
  
  return { isValid: true };
};

/**
 * Keystroke guard for SSN inputs. Blocks any non-digit keypress so the user
 * physically cannot enter letters or punctuation (dashes/spaces stripped on
 * paste). Allows control/navigation keys so copy/paste/backspace still work.
 *
 * Usage: <input onKeyDown={blockNonDigitKey} ... />
 */
export const blockNonDigitKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const controlKeys = new Set([
    'Backspace', 'Delete', 'Tab', 'Escape', 'Enter',
    'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
    'Home', 'End'
  ]);
  if (controlKeys.has(e.key)) return;
  if (!/^[0-9]$/.test(e.key)) {
    e.preventDefault();
  }
};

/**
 * Paste handler for SSN inputs. Strips any non-digit characters (dashes,
 * spaces, letters) from the pasted content and appends up to 9 digits total,
 * honoring the current value. Pair with `blockNonDigitKey` on the same input.
 */
export const handleSsnPaste = (
  e: React.ClipboardEvent<HTMLInputElement>,
  currentValue: string,
  setValue: (next: string) => void
): void => {
  e.preventDefault();
  const raw = e.clipboardData.getData('text') || '';
  const pastedDigits = raw.replace(/\D/g, '');
  if (!pastedDigits) return;
  const target = e.currentTarget as HTMLInputElement;
  const selStart = target.selectionStart ?? currentValue.length;
  const selEnd = target.selectionEnd ?? currentValue.length;
  const before = currentValue.slice(0, selStart);
  const after = currentValue.slice(selEnd);
  const combined = (before + pastedDigits + after).replace(/\D/g, '').slice(0, 9);
  setValue(combined);
};

/**
 * Format SSN for input (XXX-XX-XXXX)
 * Automatically adds dashes as user types
 * @param ssn - Raw SSN string
 * @returns Formatted SSN string
 */
export const formatSSN = (ssn: string): string => {
  // Remove all non-digit characters
  const cleanSSN = ssn.replace(/\D/g, '');
  
  // Limit to 9 digits
  const limited = cleanSSN.slice(0, 9);
  
  // Add dashes
  if (limited.length <= 3) {
    return limited;
  } else if (limited.length <= 5) {
    return `${limited.slice(0, 3)}-${limited.slice(3)}`;
  } else {
    return `${limited.slice(0, 3)}-${limited.slice(3, 5)}-${limited.slice(5)}`;
  }
};

/**
 * Normalize phone for DB/API: trim, strip non-digits (spaces, dashes, parentheses), then E.164 prefix.
 * Aligns with Message Center SMS normalization. Empty input returns ''.
 */
export const normalizePhoneToE164Storage = (raw: string | null | undefined): string => {
  if (raw == null || raw === '') return '';
  const s = String(raw).trim();
  if (!s) return '';
  let cleaned = s.replace(/\D/g, '');
  if (!cleaned) return '';
  if (cleaned.length === 10) cleaned = '1' + cleaned;
  if (!cleaned.startsWith('+')) cleaned = '+' + cleaned;
  return cleaned;
};

export const apiCall = async (endpoint: string, options: RequestInit = {}): Promise<any> => {
  const token = localStorage.getItem('accessToken');
  const baseUrl = process.env.NODE_ENV === 'development' 
    ? API_CONFIG.BASE_URL 
    : API_CONFIG.BASE_URL;

  const defaultOptions: RequestInit = {
    headers: {
      'Content-Type': 'application/json',
      ...(token && { 'Authorization': `Bearer ${token}` }),
      ...options.headers,
    },
    ...options,
  };

  try {
    const response = await fetch(`${baseUrl}${endpoint}`, defaultOptions);
    
    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: 'Request failed' }));
      throw new Error(error.message || `HTTP ${response.status}`);
    }
    
    return await response.json();
  } catch (error) {
    console.error('API call failed:', error);
    throw error;
  }
};
