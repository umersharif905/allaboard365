'use strict';

const {
  buildHouseholdsFromE123Pages,
  aggregateProductKeys,
  aggregateProductGroups,
  getMigratableProducts,
  isActiveProduct,
  isEnrolledE123Product,
  isMigratableE123Product,
  mapRelationship,
  pickMigrationRecordDate,
  pickHouseholdMigrationRecordDate
} = require('../householdNormalizer');

describe('householdNormalizer', () => {
  test('maps relationships and filters cancelled products', () => {
    expect(mapRelationship('Spouse')).toBe('S');
    expect(mapRelationship('CHILD')).toBe('C');
    expect(isActiveProduct({ dtcancelled: '' })).toBe(true);
    expect(isActiveProduct({ dtcancelled: '2020-01-01' })).toBe(false);
  });

  test('builds households from flat E123 collections', () => {
    const households = buildHouseholdsFromE123Pages({
      users: [{
        userid: '100',
        memberid: 'SW123',
        firstname: 'Jane',
        lastname: 'Doe',
        email: 'jane@example.com',
        brokerid: '999'
      }],
      dependents: [{
        userid: '100',
        depid: '200',
        uuid: 'dep-uuid',
        firstname: 'John',
        lastname: 'Doe',
        relationship: 'Spouse',
        dob: '1980-01-01',
        gender: 'M'
      }],
      products: [{
        userid: '100',
        upid: '5001',
        pdid: '42',
        label: 'Plan 1500',
        dteffective: '2024-01-01',
        dtcancelled: '',
        productfees: [{ benefitid: '7' }]
      }]
    });

    expect(households).toHaveLength(1);
    expect(households[0].householdMemberId).toBe('SW123');
    expect(households[0].dependents).toHaveLength(1);
    expect(households[0].primary.tier).toBe('ES');
    expect(households[0].products[0].pdid).toBe('42');
  });

  test('excludes cancelled-only households unless includeTerminatedHouseholds is enabled', () => {
    const products = [{
      userid: '100',
      upid: '5001',
      pdid: '42',
      label: 'Essential (Sharewell)',
      dteffective: '2024-09-11',
      dtcancelled: '2025-03-05 00:00:00.0',
      bpaid: '1',
      productfees: [{ benefitid: '9392' }]
    }];

    expect(getMigratableProducts(products)).toHaveLength(0);
    expect(getMigratableProducts(products, { includeTerminatedHouseholds: true })).toHaveLength(1);

    const households = buildHouseholdsFromE123Pages({
      users: [{ userid: '100', memberid: 'SW7149470', firstname: 'Lori', lastname: 'Erickson' }],
      dependents: [],
      products
    });
    expect(households).toHaveLength(0);

    const withTerminated = buildHouseholdsFromE123Pages({
      users: [{ userid: '100', memberid: 'SW7149470', firstname: 'Lori', lastname: 'Erickson' }],
      dependents: [],
      products
    }, { includeTerminatedHouseholds: true });
    expect(withTerminated).toHaveLength(1);
    expect(withTerminated[0].e123Terminated).toBe(true);
    expect(withTerminated[0].e123TerminationDate).toContain('2025-03-05');
  });

  test('skips households when all E123 products are cancelled and unpaid', () => {
    const products = [{
      userid: '100',
      upid: '5001',
      pdid: '42',
      label: 'Essential (Sharewell)',
      dtcancelled: '2025-01-01',
      bpaid: '0',
      productfees: [{ benefitid: '9392' }]
    }];

    expect(isEnrolledE123Product(products[0])).toBe(false);
    expect(getMigratableProducts(products)).toHaveLength(0);

    const households = buildHouseholdsFromE123Pages({
      users: [{ userid: '100', memberid: 'SW999', firstname: 'Dead', lastname: 'Member' }],
      dependents: [],
      products
    });

    expect(households).toHaveLength(0);
  });

  test('treats enrollment as active when reasonforcancel is set but dtcancelled is empty', () => {
    const products = [{
      userid: '100',
      upid: '30756840',
      pdid: '45042',
      label: 'Essential (Sharewell)',
      dteffective: '2025-04-01',
      dtcancelled: '',
      reasonforcancel: 'Canceled per ShareWELL',
      bpaid: '1',
      productfees: [{ benefitid: '9392' }]
    }];

    expect(isActiveProduct(products[0])).toBe(true);
    expect(getMigratableProducts(products)).toHaveLength(1);

    const households = buildHouseholdsFromE123Pages({
      users: [{ userid: '100', memberid: 'SW3057692', firstname: 'Korey', lastname: 'Gouin' }],
      dependents: [],
      products
    });
    expect(households).toHaveLength(1);
    expect(households[0].e123Terminated).toBe(false);
  });

  test('getMigratableProducts prefers open enrollments over cancelled history on same pdid', () => {
    const products = [
      {
        pdid: '42',
        label: 'Essential (Sharewell)',
        dteffective: '2024-01-01',
        dtcancelled: '2025-03-01',
        bpaid: '1',
        productfees: [{ benefitid: '1' }]
      },
      {
        pdid: '42',
        label: 'Essential (Sharewell)',
        dteffective: '2025-04-01',
        dtcancelled: '',
        productfees: [{ benefitid: '1' }]
      }
    ];

    const migratable = getMigratableProducts(products);
    expect(migratable).toHaveLength(1);
    expect(migratable[0].dteffective).toContain('2025-04-01');
  });

  test('aggregateProductKeys counts members per product', () => {
    const keys = aggregateProductKeys([
      { products: [{ pdid: '1', label: 'A', benefitId: '10' }] },
      { products: [{ pdid: '1', label: 'A', benefitId: '10' }] }
    ]);
    expect(keys).toHaveLength(1);
    expect(keys[0].memberCount).toBe(2);
  });

  test('aggregateProductGroups tracks enrollment dates for open products only', () => {
    const groups = aggregateProductGroups([
      {
        primary: { tier: 'EE', tobaccoUse: 'No' },
        products: [{
          pdid: '45042',
          label: 'Essential (Sharewell)',
          dtcreated: '2024-09-03 10:15:57.0',
          dteffective: '2024-09-11 00:00:00.0',
          dtbilling: '2024-09-03 00:00:00.0',
          dtcancelled: '',
          bhold: '0',
          bpaid: '1',
          productfees: [{ benefitid: '9392', amount: '220' }]
        }]
      },
      {
        primary: { tier: 'EE', tobaccoUse: 'No' },
        products: [{
          pdid: '45256',
          label: 'Essential (Sharewell)',
          dtcreated: '2024-09-13 15:35:08.0',
          dteffective: '2024-09-14 00:00:00.0',
          dtcancelled: '2025-03-05 00:00:00.0',
          bhold: '1',
          bpaid: '1',
          productfees: [{ benefitid: '9392', amount: '220' }]
        }]
      }
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].sourceProductKey).toBe('45042');
    expect(groups[0].enrollmentStats.activeEnrollmentCount).toBe(1);
    expect(groups[0].enrollmentStats.cancelledEnrollmentCount).toBe(0);
  });

  test('aggregateProductGroups tracks tobacco mix per benefit tier', () => {
    const groups = aggregateProductGroups([
      {
        primary: { tier: 'EE', dateOfBirth: new Date('1990-01-01'), tobaccoUse: 'No' },
        products: [{
          pdid: '45042',
          label: 'Essential (Sharewell)',
          productfees: [{ benefitid: '9392', periodlabel: 'Monthly', amount: '220' }]
        }]
      },
      {
        primary: { tier: 'EE', dateOfBirth: new Date('1988-01-01'), tobaccoUse: 'Yes' },
        products: [{
          pdid: '45042',
          label: 'Essential (Sharewell)',
          productfees: [{ benefitid: '9392', periodlabel: 'Monthly', amount: '294' }]
        }]
      },
      {
        primary: { tier: 'EE', dateOfBirth: new Date('1987-01-01'), tobaccoUse: 'No' },
        products: [{
          pdid: '45042',
          label: 'Essential (Sharewell)',
          productfees: [{ benefitid: '9392', periodlabel: 'Monthly', amount: '220' }]
        }]
      },
      {
        primary: { tier: 'EE', dateOfBirth: new Date('1986-01-01'), tobaccoUse: 'No' },
        products: [{
          pdid: '45042',
          label: 'Essential (Sharewell)',
          productfees: [{ benefitid: '9392', periodlabel: 'Monthly', amount: '220' }]
        }]
      }
    ]);

    const eeTier = groups[0].tiers.find((tier) => tier.sourceBenefitKey === '9392');
    expect(eeTier.inferredTobaccoUse).toBe('No');
    expect(eeTier.tobaccoCounts.yes).toBe(1);
    expect(eeTier.tobaccoCounts.no).toBe(3);
  });

  test('aggregateProductGroups infers member tier per benefit', () => {
    const groups = aggregateProductGroups([
      {
        primary: { tier: 'ES', dateOfBirth: new Date('1985-05-01') },
        products: [{
          pdid: '51226',
          label: 'Connected Wellness',
          productfees: [{ benefitid: '9402', periodlabel: 'Monthly' }]
        }]
      },
      {
        primary: { tier: 'EE', dateOfBirth: new Date('1990-01-01') },
        products: [{
          pdid: '51226',
          label: 'Connected Wellness',
          productfees: [{ benefitid: '9392', periodlabel: 'Monthly' }]
        }]
      }
    ]);

    expect(groups).toHaveLength(1);
    const esTier = groups[0].tiers.find((tier) => tier.sourceBenefitKey === '9402');
    const eeTier = groups[0].tiers.find((tier) => tier.sourceBenefitKey === '9392');
    expect(esTier.inferredMemberTier).toBe('ES');
    expect(eeTier.inferredMemberTier).toBe('EE');
    expect(esTier.memberAgeRange?.sampleSize).toBe(1);
  });

  test('isMigratableE123Product excludes chargeback and fee products', () => {
    expect(isMigratableE123Product({ label: 'Plan 1500', dtcancelled: '' })).toBe(true);
    expect(isMigratableE123Product({
      label: 'Essential (Sharewell)',
      dtcancelled: '2025-03-05',
      bpaid: '1',
      productfees: [{ benefitid: '9392' }]
    }, { includeTerminatedHouseholds: true })).toBe(true);
    expect(isMigratableE123Product({
      label: 'Essential (Sharewell)',
      dtcancelled: '2025-03-05',
      bpaid: '0',
      productfees: [{ benefitid: '9392' }]
    })).toBe(false);
    expect(isMigratableE123Product({ label: 'Chargeback Fee', dtcancelled: '' })).toBe(false);
    expect(isMigratableE123Product({ label: 'Enrollment Fee', dtcancelled: '' })).toBe(false);
    expect(isMigratableE123Product({
      label: 'Misc',
      dtcancelled: '',
      productfees: [{ benefitid: '1', type: 'Enrollment' }]
    })).toBe(false);
  });

  test('aggregateProductGroups skips non-migratable products', () => {
    const groups = aggregateProductGroups([
      {
        primary: { tier: 'EE' },
        products: [
          { pdid: '49782', label: 'Chargeback Fee', productfees: [{ benefitid: '1' }] },
          { pdid: '42', label: 'Plan 1500', productfees: [{ benefitid: '7' }] }
        ]
      }
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].sourceProductKey).toBe('42');
  });

  test('pickMigrationRecordDate prefers dtcreated then dteffective over dtupdated', () => {
    const fromCreated = pickMigrationRecordDate({
      dtcreated: '2023-06-01 10:00:00.0',
      dteffective: '2024-01-01 00:00:00.0',
      dtupdated: '2025-01-01 00:00:00.0'
    });
    expect(fromCreated.toISOString()).toBe(new Date('2023-06-01 10:00:00.0').toISOString());

    const fromEffective = pickMigrationRecordDate({
      dteffective: '2024-01-01 00:00:00.0',
      dtupdated: '2025-01-01 00:00:00.0'
    });
    expect(fromEffective.toISOString()).toBe(new Date('2024-01-01 00:00:00.0').toISOString());
  });

  test('pickHouseholdMigrationRecordDate uses earliest migratable product date', () => {
    const household = {
      products: [
        { pdid: '1', label: 'Plan A', dtcreated: '2024-03-01', dtcancelled: '' },
        { pdid: '2', label: 'Plan B', dteffective: '2023-12-01', dtcancelled: '' }
      ]
    };
    const date = pickHouseholdMigrationRecordDate(household);
    expect(date.toISOString()).toBe(new Date('2023-12-01').toISOString());
  });
});
