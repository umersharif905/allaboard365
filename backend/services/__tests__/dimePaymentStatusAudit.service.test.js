/**
 * @jest-environment node
 */

const { mergeRowsByPaymentId, runAudit } = require('../dimePaymentStatusAudit.service');

describe('dimePaymentStatusAudit.service', () => {
  describe('mergeRowsByPaymentId', () => {
    it('keeps primary order and appends secondary-only ids without duplicates', () => {
      const a = [{ PaymentId: 'a' }, { PaymentId: 'b' }];
      const b = [{ PaymentId: 'b' }, { PaymentId: 'c' }];
      const merged = mergeRowsByPaymentId(a, b);
      expect(merged.map((r) => r.PaymentId)).toEqual(['a', 'b', 'c']);
    });

    it('dedupes numeric-like ids consistently as strings', () => {
      const primary = [{ PaymentId: '1' }];
      const secondary = [{ PaymentId: 1 }];
      const merged = mergeRowsByPaymentId(primary, secondary);
      expect(merged).toHaveLength(1);
      expect(merged[0].PaymentId).toBe('1');
    });
  });

  describe('runAudit', () => {
    it('rejects hoursBack together with calendar dates', async () => {
      await expect(
        runAudit({
          tenantId: '00000000-0000-0000-0000-000000000001',
          hoursBack: 24,
          startDate: '2026-01-01',
          endDate: null,
          dryRun: true,
          limit: 10
        })
      ).rejects.toThrow(/hoursBack|startDate/);
    });
  });
});
