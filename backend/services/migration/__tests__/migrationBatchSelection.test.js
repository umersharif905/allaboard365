'use strict';

const { parseHouseholdMemberIds } = require('../migrationBatch.service');

describe('parseHouseholdMemberIds', () => {
  test('splits comma, space, semicolon, and newline separated IDs', () => {
    expect(parseHouseholdMemberIds('SW0001, SW0002\nSW0003;SW0004 SW0005')).toEqual([
      'SW0001',
      'SW0002',
      'SW0003',
      'SW0004',
      'SW0005'
    ]);
  });

  test('deduplicates IDs', () => {
    expect(parseHouseholdMemberIds('SW0001, SW0001, SW0002')).toEqual(['SW0001', 'SW0002']);
  });

  test('accepts arrays', () => {
    expect(parseHouseholdMemberIds(['SW0001', 'SW0002, SW0003'])).toEqual(['SW0001', 'SW0002', 'SW0003']);
  });
});
