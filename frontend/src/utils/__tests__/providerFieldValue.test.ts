import { describe, it, expect } from 'vitest';
import { isProviderValue, formatProviderValue } from '../providerFieldValue';

describe('isProviderValue', () => {
  it('accepts a registry provider', () => {
    expect(isProviderValue({ source: 'registry', name: 'Jane Smith', npi: '1234567890' })).toBe(true);
  });
  it('accepts a manual provider', () => {
    expect(isProviderValue({ source: 'manual', name: 'Town Clinic' })).toBe(true);
  });
  it('rejects non-provider values', () => {
    expect(isProviderValue(null)).toBe(false);
    expect(isProviderValue('Jane')).toBe(false);
    expect(isProviderValue({ name: 'x' })).toBe(false);
    expect(isProviderValue({ source: 'registry' })).toBe(false);
  });
});

describe('formatProviderValue', () => {
  it('formats a registry provider with NPI and verified tag', () => {
    const s = formatProviderValue({
      source: 'registry', name: 'Jane Smith, MD', npi: '1234567890',
      address1: '1 Main St', city: 'Naugatuck', state: 'CT', zip: '06770'
    });
    expect(s).toBe('Jane Smith, MD — NPI 1234567890 — 1 Main St Naugatuck, CT 06770 — (registry-verified)');
  });
  it('formats a manual provider as manually entered', () => {
    expect(formatProviderValue({ source: 'manual', name: 'Town Clinic' }))
      .toBe('Town Clinic — (manually entered)');
  });
});
