'use strict';

const { getMigrationAuditDate, migrationAuditDateSetClause } = require('../migrationAuditDates');

describe('migrationAuditDates', () => {
  test('getMigrationAuditDate reads ISO string from enrollment details', () => {
    const date = getMigrationAuditDate({
      migrationSource: 'e123',
      migrationAuditDate: '2024-09-03T10:15:57.000Z'
    });
    expect(date.toISOString()).toBe('2024-09-03T10:15:57.000Z');
  });

  test('getMigrationAuditDate parses JSON enrollment details', () => {
    const date = getMigrationAuditDate(JSON.stringify({
      migrationAuditDate: '2024-09-11T00:00:00.000Z'
    }));
    expect(date.toISOString()).toBe('2024-09-11T00:00:00.000Z');
  });

  test('migrationAuditDateSetClause preserves historical dates on finalize', () => {
    expect(migrationAuditDateSetClause()).toContain('CreatedDate = COALESCE(@migrationAuditDate, CreatedDate)');
    expect(migrationAuditDateSetClause()).toContain('ModifiedDate = COALESCE(@migrationAuditDate, ModifiedDate)');
  });
});
