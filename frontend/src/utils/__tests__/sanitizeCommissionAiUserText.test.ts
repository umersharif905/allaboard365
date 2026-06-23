import { describe, expect, it } from 'vitest';
import { stripGuidsFromCommissionAiText } from '../sanitizeCommissionAiUserText';

describe('stripGuidsFromCommissionAiText', () => {
  it('replaces UUIDs with catalog labels when provided', () => {
    const id = 'BB909977-4305-419B-B810-D4B00319656B';
    const map = new Map([[id.toLowerCase(), 'CoPay Basic (#2)']]);
    const text = `Patch rule ${id} for Basic.`;
    expect(stripGuidsFromCommissionAiText(text, map)).toBe('Patch rule CoPay Basic (#2) for Basic.');
  });

  it('uses fallback when no label map', () => {
    const text = 'See BB909977-4305-419B-B810-D4B00319656B';
    expect(stripGuidsFromCommissionAiText(text)).toBe('See that rule');
  });
});
