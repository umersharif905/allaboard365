import { describe, it, expect } from 'vitest';
import { mapPrefillToInitialValues } from '../prefillMapping';

describe('mapPrefillToInitialValues', () => {
  const prefill = {
    firstName: 'Ada',
    email: 'ada@example.com',
    memberId: 'SW-123',
    dateOfBirth: '1990-01-02',
    addressZip: '94016',
    relationToPrimary: 'child'
  } as Record<string, string | null>;

  it('maps semantic field types regardless of field name', () => {
    const def = {
      fields: [
        { name: 'ay_first_name', type: 'first_name' },
        { name: 'ay_email', type: 'email' },
        { name: 'ay_member_id', type: 'member_id' }
      ]
    };
    expect(mapPrefillToInitialValues(def, prefill)).toEqual({
      ay_first_name: 'Ada',
      ay_email: 'ada@example.com',
      ay_member_id: 'SW-123'
    });
  });

  it('maps generic fields by exact (canonical) key name', () => {
    const def = {
      fields: [
        { name: 'dateOfBirth', type: 'date' },
        { name: 'addressZip', type: 'text' },
        { name: 'relationToPrimary', type: 'select' }
      ]
    };
    expect(mapPrefillToInitialValues(def, prefill)).toEqual({
      dateOfBirth: '1990-01-02',
      addressZip: '94016',
      relationToPrimary: 'child'
    });
  });

  it('omits fields with no matching prefill source', () => {
    const def = { fields: [{ name: 'ay_dob', type: 'date' }, { name: 'surg_note', type: 'text' }] };
    expect(mapPrefillToInitialValues(def, prefill)).toEqual({});
  });
});
