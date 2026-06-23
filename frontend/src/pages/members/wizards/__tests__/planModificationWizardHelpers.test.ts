import { describe, expect, it } from 'vitest';
import {
  hasDimeApplyWarning,
  isPrimaryEnrollmentPreviewRow,
  shouldSkipDimeRecurringForMember
} from '../planModificationWizardHelpers';

describe('shouldSkipDimeRecurringForMember', () => {
  it('skips when member has GroupId', () => {
    expect(shouldSkipDimeRecurringForMember({ GroupId: 'g-1', BillType: 'IB' })).toBe(true);
  });

  it('skips for list-bill without group', () => {
    expect(shouldSkipDimeRecurringForMember({ GroupId: null, BillType: 'LB' })).toBe(true);
  });

  it('does not skip direct individual', () => {
    expect(shouldSkipDimeRecurringForMember({ GroupId: null, BillType: 'IB' })).toBe(false);
  });

  it('prefers dry-run flag when provided', () => {
    expect(shouldSkipDimeRecurringForMember({ GroupId: null, BillType: 'IB' }, true)).toBe(true);
  });
});

describe('isPrimaryEnrollmentPreviewRow', () => {
  it('treats dependent terminate rows as non-primary', () => {
    expect(isPrimaryEnrollmentPreviewRow({ isDependentRow: true, enrollmentType: 'Product' })).toBe(false);
  });

  it('keeps fee rows visible', () => {
    expect(isPrimaryEnrollmentPreviewRow({ enrollmentType: 'SystemFee', rel: '' })).toBe(true);
  });
});

describe('hasDimeApplyWarning', () => {
  it('returns false when dime is skipped for group member', () => {
    expect(
      hasDimeApplyWarning({ dimeUpdate: { success: false, message: 'x' } }, true)
    ).toBe(false);
  });

  it('returns true when dime update failed', () => {
    expect(hasDimeApplyWarning({ dimeUpdate: { success: false } }, false)).toBe(true);
  });
});
