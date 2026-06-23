import { describe, it, expect } from 'vitest';
import {
  PALETTE_FIELD_TYPES,
  KNOWN_FIELD_TYPES,
  newFieldFromPalette,
  parseFormDefinition
} from '../publicFormDefinition';

describe('provider_search field type', () => {
  it('is registered in the palette and known types', () => {
    expect(PALETTE_FIELD_TYPES).toContain('provider_search');
    expect(KNOWN_FIELD_TYPES.has('provider_search')).toBe(true);
  });

  it('newFieldFromPalette creates a provider_search field defaulting to individual mode', () => {
    const f = newFieldFromPalette('provider_search', new Set<string>());
    expect(f.type).toBe('provider_search');
    expect(f.providerSearchMode).toBe('individual');
    expect(f.label).toBe('Find your provider');
    expect(typeof f.name).toBe('string');
    expect(f.name.length).toBeGreaterThan(0);
  });

  it('parseFormDefinition preserves providerSearchMode through normalizeField', () => {
    const raw = JSON.stringify({
      fields: [
        {
          name: 'find_provider',
          type: 'provider_search',
          label: 'Find your provider',
          required: false,
          providerSearchMode: 'organization'
        }
      ]
    });
    const def = parseFormDefinition(raw);
    const field = def.fields[0];
    expect(field.providerSearchMode).toBe('organization');
  });
});
