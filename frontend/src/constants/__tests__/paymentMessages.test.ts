import { describe, expect, it } from 'vitest';
import {
  PENDING_BANK_APPROVAL_MESSAGE,
  getManualChargeToastMessage,
} from '../paymentMessages';

describe('paymentMessages', () => {
  it('exports pending bank approval copy with coverage reassurance', () => {
    expect(PENDING_BANK_APPROVAL_MESSAGE).toContain('pending approval with your bank');
    expect(PENDING_BANK_APPROVAL_MESSAGE).toContain('24-48 hours');
    expect(PENDING_BANK_APPROVAL_MESSAGE).toContain('coverage will remain in effect');
  });

  it('getManualChargeToastMessage returns settled message for Completed', () => {
    const r = getManualChargeToastMessage({
      paymentRecordStatus: 'Completed',
      settledMessage: 'Invoice charged successfully',
    });
    expect(r).toEqual({ message: 'Invoice charged successfully', severity: 'success' });
  });

  it('getManualChargeToastMessage returns pending copy for Pending', () => {
    const r = getManualChargeToastMessage({
      paymentRecordStatus: 'Pending',
      settledMessage: 'Invoice charged successfully',
    });
    expect(r.message).toBe(PENDING_BANK_APPROVAL_MESSAGE);
    expect(r.severity).toBe('info');
  });

  it('getManualChargeToastMessage treats missing status as pending (not settled)', () => {
    const r = getManualChargeToastMessage({
      paymentRecordStatus: undefined,
      settledMessage: 'Paid',
    });
    expect(r.severity).toBe('info');
    expect(r.message).toBe(PENDING_BANK_APPROVAL_MESSAGE);
  });
});
