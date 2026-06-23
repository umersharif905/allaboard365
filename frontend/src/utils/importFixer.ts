// src/utils/importFixer.ts
/**
 * Utility to help with import/export fixes
 * This file helps resolve common import issues
 */

// Re-export React for components that need it
import React from 'react';
export { React };

// Mock implementations for missing modules
export const mockImplementations = {
  performance: {
    now: () => Date.now(),
    mark: () => {},
    measure: () => {},
  },
  
  console: {
    log: console.log,
    error: console.error,
    warn: console.warn,
  },
};

// Type guards
export const isError = (error: unknown): error is Error => {
  return error instanceof Error;
};

export const isString = (value: unknown): value is string => {
  return typeof value === 'string';
};

export const isNumber = (value: unknown): value is number => {
  return typeof value === 'number' && !isNaN(value);
};
