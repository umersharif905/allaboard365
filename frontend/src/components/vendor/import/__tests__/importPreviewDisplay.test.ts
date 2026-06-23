import { describe, expect, it } from 'vitest';
import {
  coverageTierCellDisplay,
  formatImportPreviewDate,
  formatPlanLineDisplay,
  householdSkipReasonDisplay,
  shortPricingTierLabel,
} from '../importPreviewDisplay';

describe('formatImportPreviewDate', () => {
  it('formats YYYYMMDD', () => {
    expect(formatImportPreviewDate('20250201')).toBe('2/1/2025');
  });

  it('passes through M/D/YYYY', () => {
    expect(formatImportPreviewDate('6/3/2026')).toBe('6/3/2026');
  });
});

describe('shortPricingTierLabel', () => {
  it('strips product name prefix', () => {
    expect(shortPricingTierLabel('Essential (ShareWELL) — EE · UA 2500 · EE 2500', 'EE_2500')).toBe(
      'EE · UA 2500 · EE 2500',
    );
  });
});

describe('formatPlanLineDisplay', () => {
  it('shows tier arrow for enroll_replace', () => {
    const line = formatPlanLineDisplay({
      planKey: 'EE_3000',
      action: 'enroll_replace',
      currentMappedTierLabel: 'Essential — EE · UA 1500',
      mappedTierLabel: 'Essential — EE · UA 2500',
      replacementTerminateDate: '6/3/2026',
      effectiveDate: '20250201',
    });
    expect(line.statusLabel).toBe('Changing');
    expect(line.tierLabel).toContain('→');
    expect(line.detail).toContain('Prior plan ends 6/3/2026');
    expect(line.detail).toContain('New plan starts 2/1/2025');
  });
});

describe('householdSkipReasonDisplay', () => {
  it('explains missing dependents with required tier', () => {
    const d = householdSkipReasonDisplay({
      action: 'skip',
      skipReason: 'missing_dependents',
      missingDependents: true,
      requiredCoverageTier: 'EF',
      requiredCoverageTierLabel: 'Employee + family',
      missingDependentsDetail: 'Add spouse and child row(s) to the file',
    });
    expect(d?.badge).toBe('Missing dependents');
    expect(d?.detail).toContain('Add spouse and child');
    expect(d?.detail).toContain('Not imported');
  });
});

describe('coverageTierCellDisplay', () => {
  it('shows EE → ES when Tier member field changes', () => {
    const cell = coverageTierCellDisplay({
      coverageTier: 'EE',
      coverageTierLabel: 'Employee only',
      memberFieldChanges: [{ field: 'Tier', from: 'EE', to: 'ES' }],
    });
    expect(cell.main).toBe('EE → ES');
    expect(cell.isChanging).toBe(true);
  });

  it('shows required tier when missing dependents', () => {
    const cell = coverageTierCellDisplay({
      missingDependents: true,
      requiredCoverageTier: 'ES',
      requiredCoverageTierLabel: 'Employee + spouse',
      missingDependentsDetail: 'Add spouse row(s) to the file',
    });
    expect(cell.main).toBe('Needs ES');
    expect(cell.sub).toContain('spouse');
  });
});
