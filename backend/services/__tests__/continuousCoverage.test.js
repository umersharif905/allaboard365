const {
  computeContinuousCoverageLookups,
  computeContinuousStartForEnrollments,
  mergeAdjacentRanges,
  buildRanges,
  toDayUTC,
} = require('../enrollments/continuousCoverage.service');

const MEMBER = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const PROD_A = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const PROD_B = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

function enrollmentRow({
  memberId = MEMBER,
  productId = PROD_A,
  effectiveDate,
  terminationDate = null,
  status = 'Active',
  productType = 'Healthcare',
}) {
  return {
    MemberId: memberId,
    ProductId: productId,
    EffectiveDate: effectiveDate,
    TerminationDate: terminationDate,
    Status: status,
    ProductType: productType,
  };
}

describe('continuousCoverage.service', () => {
  describe('mergeAdjacentRanges', () => {
    test('merges strictly adjacent spans (prior end + 1 = next start)', () => {
      const asOf = toDayUTC('2024-03-01');
      const ranges = buildRanges([
        enrollmentRow({ effectiveDate: '2024-01-01', terminationDate: '2024-01-31', status: 'Inactive' }),
        enrollmentRow({ effectiveDate: '2024-02-01', terminationDate: null, status: 'Active' }),
      ], asOf);

      const merged = mergeAdjacentRanges(ranges);
      expect(merged).toHaveLength(1);
      expect(merged[0].start.toISOString().slice(0, 10)).toBe('2024-01-01');
      expect(merged[0].end.toISOString().slice(0, 10)).toBe('2024-03-01');
    });

    test('does not merge when gap is more than one day', () => {
      const asOf = toDayUTC('2024-03-01');
      const ranges = buildRanges([
        enrollmentRow({ effectiveDate: '2024-01-01', terminationDate: '2024-01-31', status: 'Inactive' }),
        enrollmentRow({ effectiveDate: '2024-02-03', terminationDate: null, status: 'Active' }),
      ], asOf);

      const merged = mergeAdjacentRanges(ranges);
      expect(merged).toHaveLength(2);
    });
  });

  describe('computeContinuousStartForEnrollments', () => {
    test('returns original start across terminate+resume on same productId', () => {
      const rows = [
        enrollmentRow({ effectiveDate: '2024-01-01', terminationDate: '2024-01-31', status: 'Inactive' }),
        enrollmentRow({ effectiveDate: '2024-02-01', terminationDate: null, status: 'Active' }),
      ];
      const start = computeContinuousStartForEnrollments(rows, toDayUTC('2024-03-01'));
      expect(start).toBe('2024-01-01');
    });

    test('returns later start when coverage gap breaks the chain', () => {
      const rows = [
        enrollmentRow({ effectiveDate: '2024-01-01', terminationDate: '2024-01-31', status: 'Inactive' }),
        enrollmentRow({ effectiveDate: '2024-02-03', terminationDate: null, status: 'Active' }),
      ];
      const start = computeContinuousStartForEnrollments(rows, toDayUTC('2024-03-01'));
      expect(start).toBe('2024-02-03');
    });
  });

  describe('computeContinuousCoverageLookups', () => {
    test('scopes continuous start per productId', () => {
      const rows = [
        enrollmentRow({ productId: PROD_A, effectiveDate: '2024-01-01', terminationDate: '2024-01-31', status: 'Inactive' }),
        enrollmentRow({ productId: PROD_A, effectiveDate: '2024-02-01', terminationDate: null, status: 'Active' }),
        enrollmentRow({ productId: PROD_B, effectiveDate: '2024-06-01', terminationDate: null, status: 'Active', productType: 'Dental' }),
      ];

      const lookups = computeContinuousCoverageLookups(rows, '2024-07-01');
      expect(lookups.byMemberProduct.get(`${MEMBER}|${PROD_A}`)).toBe('2024-01-01');
      expect(lookups.byMemberProduct.get(`${MEMBER}|${PROD_B}`)).toBe('2024-06-01');
    });

    test('member-wide earliest aggregates across active products', () => {
      const rows = [
        enrollmentRow({ productId: PROD_A, effectiveDate: '2024-01-01', terminationDate: null, status: 'Active' }),
        enrollmentRow({ productId: PROD_B, effectiveDate: '2024-06-01', terminationDate: null, status: 'Active', productType: 'Dental' }),
      ];

      const lookups = computeContinuousCoverageLookups(rows, '2024-07-01');
      expect(lookups.byMemberWide.get(MEMBER)).toBe('2024-01-01');
    });

    test('Medical product type uses continuous start across terminate+resume', () => {
      const rows = [
        enrollmentRow({
          productId: PROD_A,
          effectiveDate: '2024-01-01',
          terminationDate: '2024-01-31',
          status: 'Inactive',
          productType: 'Healthcare',
        }),
        enrollmentRow({
          productId: PROD_A,
          effectiveDate: '2024-02-01',
          terminationDate: null,
          status: 'Active',
          productType: 'Healthcare',
        }),
      ];

      const lookups = computeContinuousCoverageLookups(rows, '2024-03-01');
      expect(lookups.byMemberProductType.get(`${MEMBER}|Medical`)).toBe('2024-01-01');
    });

    test('does not include terminated-only products in member-wide earliest', () => {
      const rows = [
        enrollmentRow({
          productId: PROD_A,
          effectiveDate: '2024-01-01',
          terminationDate: '2024-01-31',
          status: 'Inactive',
        }),
        enrollmentRow({
          productId: PROD_B,
          effectiveDate: '2024-06-01',
          terminationDate: null,
          status: 'Active',
          productType: 'Dental',
        }),
      ];

      const lookups = computeContinuousCoverageLookups(rows, '2024-07-01');
      expect(lookups.byMemberProduct.has(`${MEMBER}|${PROD_A}`)).toBe(false);
      expect(lookups.byMemberWide.get(MEMBER)).toBe('2024-06-01');
    });
  });
});
