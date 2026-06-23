'use strict';

const {
  enrollmentRosterLineAmount,
  isEnrollmentEligibleForMemberListPremium,
  sumMemberListMonthlyPremium,
} = require('../enrollmentRosterPremium');

describe('enrollmentRosterPremium', () => {
  const josephMcGuinnessEnrollments = [
    {
      EnrollmentType: 'Product',
      Status: 'Pending Payment',
      PremiumAmount: 278.75,
      IncludedPaymentProcessingFeeAmount: 10.25,
      IsPendingMigration: true,
      ProductId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    },
    {
      EnrollmentType: 'Product',
      Status: 'Pending Payment',
      PremiumAmount: 410,
      IncludedPaymentProcessingFeeAmount: 0,
      IsPendingMigration: true,
      ProductId: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
    },
    {
      EnrollmentType: 'SystemFee',
      Status: 'Pending Payment',
      PremiumAmount: 3.5,
      IncludedPaymentProcessingFeeAmount: 0,
      IsPendingMigration: false,
      ProductId: '00000000-0000-0000-0000-000000000000',
    },
    {
      EnrollmentType: 'SystemFee',
      Status: 'Pending Payment',
      PremiumAmount: 3.5,
      IncludedPaymentProcessingFeeAmount: 0,
      IsPendingMigration: true,
      ProductId: '00000000-0000-0000-0000-000000000000',
    },
  ];

  it('sums pending migration product premiums via PremiumAmount only (Joseph McGuinness → $688.75)', () => {
    expect(sumMemberListMonthlyPremium(josephMcGuinnessEnrollments)).toBe(688.75);
  });

  it('includes Active SystemFee and PPF remainder for live members', () => {
    const enrollments = [
      {
        EnrollmentType: 'Product',
        Status: 'Active',
        PremiumAmount: 100,
        IncludedPaymentProcessingFeeAmount: 5,
        IsPendingMigration: false,
        ProductId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      },
      {
        EnrollmentType: 'SystemFee',
        Status: 'Active',
        PremiumAmount: 3.5,
        IsPendingMigration: false,
        ProductId: '00000000-0000-0000-0000-000000000000',
      },
      {
        EnrollmentType: 'PaymentProcessingFee',
        Status: 'Active',
        PremiumAmount: 2.25,
        IsPendingMigration: false,
        ProductId: '00000000-0000-0000-0000-000000000000',
      },
    ];
    expect(sumMemberListMonthlyPremium(enrollments)).toBe(105.75);
  });

  it('does not double-count included fees on fee enrollment rows', () => {
    const row = {
      EnrollmentType: 'PaymentProcessingFee',
      PremiumAmount: 2.25,
      IncludedPaymentProcessingFeeAmount: 99,
    };
    expect(enrollmentRosterLineAmount(row)).toBe(2.25);
    expect(isEnrollmentEligibleForMemberListPremium({ ...row, Status: 'Pending Payment' })).toBe(false);
  });
});
