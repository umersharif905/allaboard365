import { describe, expect, it } from 'vitest';
import { buildGroupsExportCsv, formatGroupEffectiveDate } from '../groupsExport';
import type { Group } from '../../services/groups.service';

const baseGroup = (overrides: Partial<Group> = {}): Group =>
  ({
    GroupId: 'g1',
    Name: 'Acme Corp',
    State: 'TX',
    ActiveEnrollments: 12,
    ...overrides,
  }) as Group;

describe('formatGroupEffectiveDate', () => {
  it('prefers future effective date over active', () => {
    expect(
      formatGroupEffectiveDate(
        baseGroup({
          EarliestFutureEffectiveDate: '2026-06-01T00:00:00.000Z',
          EarliestActiveEffectiveDate: '2025-01-01T00:00:00.000Z',
        })
      )
    ).toBe('2026-06-01');
  });

  it('falls back to active effective date', () => {
    expect(
      formatGroupEffectiveDate(
        baseGroup({ EarliestActiveEffectiveDate: '2025-03-15T00:00:00.000Z' })
      )
    ).toBe('2025-03-15');
  });

  it('returns empty when no dates', () => {
    expect(formatGroupEffectiveDate(baseGroup())).toBe('');
  });
});

describe('buildGroupsExportCsv', () => {
  it('includes header and row columns', () => {
    const csv = buildGroupsExportCsv([
      baseGroup({
        Name: 'Beta, LLC',
        ActiveEnrollments: 3,
        State: 'CA',
        EarliestFutureEffectiveDate: '2026-07-01T00:00:00.000Z',
      }),
    ]);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('Group name,Number of households,State,Effective date');
    expect(lines[1]).toBe('"Beta, LLC",3,CA,2026-07-01');
  });

  it('handles empty list with header only', () => {
    expect(buildGroupsExportCsv([])).toBe(
      'Group name,Number of households,State,Effective date'
    );
  });
});
