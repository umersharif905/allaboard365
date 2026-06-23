'use strict';

const {
  resolveBatchHouseholdMemberId,
  collectBatchMemberIds,
  partitionSelectedRows
} = require('../migrationPreview.service');

describe('migration preview pending re-sync selection', () => {
  test('resolveBatchHouseholdMemberId prefers HouseholdMemberID column', () => {
    expect(resolveBatchHouseholdMemberId(
      { HouseholdMemberID: 'SW100' },
      { householdMemberId: 'SW200' }
    )).toBe('SW100');
  });

  test('resolveBatchHouseholdMemberId falls back to JSON householdMemberId', () => {
    expect(resolveBatchHouseholdMemberId(
      { HouseholdMemberID: '' },
      { householdMemberId: 'SW200' }
    )).toBe('SW200');
  });

  test('collectBatchMemberIds dedupes column and JSON ids', () => {
    const ids = collectBatchMemberIds([
      {
        HouseholdMemberID: 'SW1',
        HouseholdJson: JSON.stringify({ householdMemberId: 'SW1' })
      },
      {
        HouseholdMemberID: 'SW2',
        HouseholdJson: JSON.stringify({ householdMemberId: 'SW2' })
      }
    ]);
    expect(ids.sort()).toEqual(['SW1', 'SW2']);
  });

  test('partitionSelectedRows routes pending_update households to resync when selected', () => {
    const row = {
      BatchHouseholdId: 'batch-row-1',
      HouseholdMemberID: 'SW999',
      HouseholdJson: JSON.stringify({ householdMemberId: 'SW999', primary: { firstName: 'A' } }),
      IncludedInImport: 1
    };
    const states = new Map([
      ['SW999', { state: 'pending_update', primaryMemberId: 'member-1' }]
    ]);

    const { importableRows, resyncRows, skipRows } = partitionSelectedRows([row], states);
    expect(importableRows).toHaveLength(0);
    expect(skipRows).toHaveLength(0);
    expect(resyncRows).toHaveLength(1);
    expect(resyncRows[0].memberId).toBe('SW999');
  });

  test('partitionSelectedRows still resyncs when JSON id missing but column is set', () => {
    const row = {
      BatchHouseholdId: 'batch-row-2',
      HouseholdMemberID: 'SW888',
      HouseholdJson: JSON.stringify({ primary: { firstName: 'B' } }),
      IncludedInImport: 1
    };
    const states = new Map([
      ['SW888', { state: 'pending_update', primaryMemberId: 'member-2' }]
    ]);

    const { resyncRows } = partitionSelectedRows([row], states);
    expect(resyncRows).toHaveLength(1);
    expect(resyncRows[0].memberId).toBe('SW888');
  });

  test('partitionSelectedRows ignores deselected pending households', () => {
    const row = {
      BatchHouseholdId: 'batch-row-3',
      HouseholdMemberID: 'SW777',
      HouseholdJson: JSON.stringify({ householdMemberId: 'SW777' }),
      IncludedInImport: 0
    };
    const states = new Map([
      ['SW777', { state: 'pending_update', primaryMemberId: 'member-3' }]
    ]);

    const { resyncRows } = partitionSelectedRows([row], states);
    expect(resyncRows).toHaveLength(0);
  });
});
