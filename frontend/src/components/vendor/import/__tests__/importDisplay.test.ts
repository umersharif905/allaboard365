import { describe, expect, it } from 'vitest';
import {
  collectDistinctUnmappedPlanKeys,
  formatImportErrorMessage,
  formatImportUtcInLocalTime,
  needsFormatChoice,
  sortHouseholdPreviews,
  sortPlanPreviewsForDisplay,
} from '../importDisplay';

describe('formatImportUtcInLocalTime', () => {
  it('does not append UTC suffix', () => {
    const out = formatImportUtcInLocalTime('2026-06-01T16:02:00Z');
    expect(out).not.toContain(' UTC');
    expect(out).not.toBe('—');
  });
});

describe('needsFormatChoice', () => {
  it('requires confirmation when suggested slug differs from selection', () => {
    expect(needsFormatChoice({
      matchesSelected: false,
      suggestedSlug: 'sharewell_align',
    })).toBe(true);
    expect(needsFormatChoice({ matchesSelected: true, suggestedSlug: 'sharewell_align' })).toBe(false);
    expect(needsFormatChoice(null)).toBe(false);
  });
});

describe('import preview sorting', () => {
  it('sorts all skipped households before tenant moves', () => {
    const sorted = sortHouseholdPreviews([
      { action: 'update', primaryName: 'Zebra' },
      { action: 'skip', skipReason: 'terminated_only_new_household', primaryName: 'Term' },
      { action: 'move_tenant', primaryName: 'Move' },
    ]);
    expect(sorted[0].primaryName).toBe('Term');
    expect(sorted[1].primaryName).toBe('Move');
  });

  it('sorts missing dependents before tenant moves and unmapped', () => {
    const sorted = sortHouseholdPreviews([
      { action: 'create', primaryName: 'Alpha', plans: [{ action: 'enroll_update' }] },
      { action: 'skip', primaryName: 'Needs Spouse', skipReason: 'missing_dependents', missingDependents: true, plans: [] },
      { action: 'create', primaryName: 'Zulma', unmappedProducts: ['46520_9377'], plans: [{ action: 'skip_unmapped' }] },
      { action: 'move_tenant', primaryName: 'Move First', plans: [] },
    ]);
    expect(sorted.map((h) => h.primaryName)).toEqual(['Needs Spouse', 'Move First', 'Zulma', 'Alpha']);
  });

  it('lists unmapped plan rows first within a household', () => {
    const sorted = sortPlanPreviewsForDisplay([
      { action: 'enroll_update' },
      { action: 'skip_unmapped' },
    ]);
    expect(sorted[0].action).toBe('skip_unmapped');
  });

  it('surfaces plan tier changes before unchanged enrollments', () => {
    const sorted = sortPlanPreviewsForDisplay([
      { action: 'enroll_unchanged' },
      { action: 'enroll_replace' },
      { action: 'skip_unmapped' },
    ]);
    expect(sorted.map((p) => p.action)).toEqual(['skip_unmapped', 'enroll_replace', 'enroll_unchanged']);
  });

  it('collects distinct unmapped keys', () => {
    expect(
      collectDistinctUnmappedPlanKeys([
        {
          unmappedProducts: ['46520_9377'],
          plans: [{ action: 'skip_unmapped', planKey: '46521_9377' }],
        },
      ]),
    ).toEqual(['46520_9377', '46521_9377']);
  });
});

describe('formatImportErrorMessage', () => {
  it('stringifies object errors instead of [object Object]', () => {
    expect(formatImportErrorMessage({ code: 'PLAN_MAP', message: 'Missing tier for EF_6000' }))
      .toContain('Missing tier');
  });

  it('uses nested message on Error-like objects', () => {
    expect(formatImportErrorMessage({ message: 'Agent not active' })).toBe('Agent not active');
  });

  it('falls back when value is empty object', () => {
    expect(formatImportErrorMessage({}, 'Import failed')).toBe('Import failed');
  });
});
