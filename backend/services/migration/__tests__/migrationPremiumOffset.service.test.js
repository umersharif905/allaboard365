'use strict';

const {
  computePremiumProcessingFeeOffset,
  resolveFeeOffsetLever,
  applyPremiumOffsetToPlan,
  computeProjectedHouseholdTotal
} = require('../migrationPremiumOffset.service');

describe('migrationPremiumOffset.service', () => {
  test('prefers PaymentProcessingFee row lever over included fee', () => {
    const lever = resolveFeeOffsetLever(
      { expectedPaymentProcessingFeeRemainder: 4.5 },
      [{ includedPaymentProcessingFeeAmount: 2 }]
    );
    expect(lever.type).toBe('ppf');
    expect(lever.currentAmount).toBe(4.5);
  });

  test('uses included fee when no separate processing fee row', () => {
    const lever = resolveFeeOffsetLever(
      { expectedPaymentProcessingFeeRemainder: 0 },
      [{ includedPaymentProcessingFeeAmount: 3.25 }]
    );
    expect(lever.type).toBe('included');
    expect(lever.productLineIndex).toBe(0);
  });

  test('applies positive offset up to $15', () => {
    const offset = computePremiumProcessingFeeOffset({
      enabled: true,
      e123Total: 120,
      projectedTotal: 110,
      feeLever: { type: 'ppf', currentAmount: 4 }
    });
    expect(offset.applied).toBe(10);
    expect(offset.newAmount).toBe(14);
    expect(offset.projectedTotalAdjusted).toBe(120);
  });

  test('skips when increase exceeds $15 cap', () => {
    const offset = computePremiumProcessingFeeOffset({
      enabled: true,
      e123Total: 130,
      projectedTotal: 110,
      feeLever: { type: 'ppf', currentAmount: 4 }
    });
    expect(offset.applied).toBe(0);
    expect(offset.reason).toBe('exceeds_max_increase');
  });

  test('applies negative offset without going below zero', () => {
    const offset = computePremiumProcessingFeeOffset({
      enabled: true,
      e123Total: 108,
      projectedTotal: 110,
      feeLever: { type: 'ppf', currentAmount: 4 }
    });
    expect(offset.applied).toBe(-2);
    expect(offset.newAmount).toBe(2);
  });

  test('skips decrease when fee cannot cover full gap', () => {
    const offset = computePremiumProcessingFeeOffset({
      enabled: true,
      e123Total: 100,
      projectedTotal: 110,
      feeLever: { type: 'ppf', currentAmount: 1 }
    });
    expect(offset.applied).toBe(0);
    expect(offset.reason).toBe('exceeds_available_decrease');
  });

  test('mutates enrollment plan included fee when lever is included', () => {
    const enrollmentPlan = {
      productLines: [{ basePremium: 100, includedPaymentProcessingFeeAmount: 3 }],
      enrollmentItems: [{ amounts: { includedPaymentProcessingFeeAmount: 3 } }]
    };
    const precomputedFees = {
      expectedSystemFeeAmount: 0,
      expectedPaymentProcessingFeeRemainder: 0,
      expectedIncludedProcessingFeeTotal: 3
    };
    applyPremiumOffsetToPlan(enrollmentPlan, precomputedFees, {
      applied: 2,
      lever: 'included',
      productLineIndex: 0,
      newAmount: 5
    });
    expect(enrollmentPlan.productLines[0].includedPaymentProcessingFeeAmount).toBe(5);
    expect(enrollmentPlan.enrollmentItems[0].amounts.includedPaymentProcessingFeeAmount).toBe(5);
    expect(computeProjectedHouseholdTotal(enrollmentPlan.productLines, precomputedFees)).toBe(105);
  });
});
