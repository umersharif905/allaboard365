const { v4: uuidv4 } = require('uuid');
const { sql } = require('../../config/database');
const { ENROLLMENT_STATUS } = require('../../constants/enrollmentStatus');

const PRODUCT_ENROLLMENT_TYPES = ['Product', 'Bundle'];
const FEE_ENROLLMENT_TYPES = ['PaymentProcessingFee', 'SystemFee', 'Contribution'];

function isProductLikeEnrollmentType(enrollmentType) {
  if (!enrollmentType) return true;
  return PRODUCT_ENROLLMENT_TYPES.includes(enrollmentType);
}

/**
 * Select enrollments eligible for termination.
 * NOTE: This is date-only evaluation; Status is not used for eligibility.
 */
async function selectHouseholdEnrollmentsForPlanCard({ poolOrTransaction, householdId, planCard, terminationDate }) {
  const req = poolOrTransaction.request();
  req.input('householdId', sql.UniqueIdentifier, householdId);
  req.input('terminationDate', sql.Date, terminationDate);

  PRODUCT_ENROLLMENT_TYPES.forEach((t, i) => req.input(`pet${i}`, sql.NVarChar(50), t));

  if (planCard.type === 'individual') {
    req.input('productId', sql.UniqueIdentifier, planCard.productId);
  } else {
    req.input('bundleId', sql.UniqueIdentifier, planCard.bundleId);
  }

  const wherePlan =
    planCard.type === 'individual'
      ? '(e.ProductId = @productId AND (e.ProductBundleID IS NULL OR e.ProductBundleID = CAST(NULL AS uniqueidentifier)))'
      : '(e.ProductBundleID = @bundleId OR e.ProductId = @bundleId)';

  const result = await req.query(`
    SELECT
      e.EnrollmentId,
      e.MemberId,
      e.ProductId,
      e.ProductBundleID as ProductBundleId,
      e.EffectiveDate,
      e.TerminationDate,
      e.PremiumAmount,
      e.EnrollmentType
    FROM oe.Enrollments e
    INNER JOIN oe.Members m ON e.MemberId = m.MemberId
    WHERE m.HouseholdId = @householdId
      AND ${wherePlan}
      AND (e.EnrollmentType IS NULL OR e.EnrollmentType IN (${PRODUCT_ENROLLMENT_TYPES.map((_, i) => `@pet${i}`).join(', ')}))
      AND (e.TerminationDate IS NULL OR e.TerminationDate > @terminationDate)
  `);

  return result.recordset || [];
}

async function selectHouseholdProductEnrollmentsForReplacement({ poolOrTransaction, householdId, terminationDate }) {
  const req = poolOrTransaction.request();
  req.input('householdId', sql.UniqueIdentifier, householdId);
  req.input('terminationDate', sql.Date, terminationDate);

  PRODUCT_ENROLLMENT_TYPES.forEach((t, i) => req.input(`pet${i}`, sql.NVarChar(50), t));

  const result = await req.query(`
    SELECT
      e.EnrollmentId,
      e.MemberId,
      e.ProductId,
      e.ProductBundleID as ProductBundleId,
      e.EffectiveDate,
      e.TerminationDate,
      e.PremiumAmount,
      e.EnrollmentType
    FROM oe.Enrollments e
    INNER JOIN oe.Members m ON e.MemberId = m.MemberId
    WHERE m.HouseholdId = @householdId
      AND (e.EnrollmentType IS NULL OR e.EnrollmentType IN (${PRODUCT_ENROLLMENT_TYPES.map((_, i) => `@pet${i}`).join(', ')}))
      AND (e.TerminationDate IS NULL OR e.TerminationDate > @terminationDate)
      AND e.ProductId != '00000000-0000-0000-0000-000000000000'
  `);

  return result.recordset || [];
}

async function terminateEnrollmentsByIds({ poolOrTransaction, enrollmentIds, terminationDate, modifiedBy }) {
  if (!enrollmentIds || enrollmentIds.length === 0) return { updated: 0 };

  const req = poolOrTransaction.request();
  req.input('terminationDate', sql.Date, terminationDate);
  req.input('modifiedBy', sql.UniqueIdentifier, modifiedBy);

  const params = enrollmentIds.map((_, i) => `@id${i}`).join(', ');
  enrollmentIds.forEach((id, i) => req.input(`id${i}`, sql.UniqueIdentifier, id));

  const result = await req.query(`
    UPDATE oe.Enrollments
    SET
      TerminationDate = @terminationDate,
      Status = 'Inactive',
      ModifiedDate = GETUTCDATE(),
      ModifiedBy = @modifiedBy
    WHERE EnrollmentId IN (${params})
  `);

  return { updated: result.rowsAffected?.[0] || 0 };
}

async function insertProductEnrollmentRow({
  poolOrTransaction,
  enrollmentId,
  memberId,
  productId,
  agentId,
  policyNumber,
  effectiveDate,
  premiumAmount,
  enrollmentDetails,
  householdId,
  groupId = null,
  productBundleId = null,
  enrollmentType = 'Product',
  paymentFrequency = 'Monthly',
  employerContributionAmount = 0,
  contributionId = null,
  productPricingId = null,
  netRate = 0,
  overrideRate = 0,
  commission = 0,
  createdBy,
  modifiedBy,
  status = ENROLLMENT_STATUS.ACTIVE,
  createdDate = null,
  modifiedDate = null
}) {
  const req = poolOrTransaction.request();

  req.input('enrollmentId', sql.UniqueIdentifier, enrollmentId);
  req.input('memberId', sql.UniqueIdentifier, memberId);
  req.input('productId', sql.UniqueIdentifier, productId);
  req.input('agentId', sql.UniqueIdentifier, agentId || null);
  req.input('policyNumber', sql.NVarChar, policyNumber || null);
  req.input('effectiveDate', sql.Date, effectiveDate);
  req.input('premiumAmount', sql.Decimal(19, 4), Number(premiumAmount || 0));
  req.input('paymentFrequency', sql.NVarChar, paymentFrequency);
  req.input('enrollmentDetails', sql.NVarChar(sql.MAX), JSON.stringify(enrollmentDetails || {}));
  req.input('employerContribution', sql.Decimal(19, 4), Number(employerContributionAmount || 0));
  req.input('contributionId', sql.UniqueIdentifier, contributionId || null);
  req.input('householdId', sql.UniqueIdentifier, householdId || null);
  req.input('productPricingId', sql.UniqueIdentifier, productPricingId || null);
  req.input('netRate', sql.Decimal(19, 4), Number(netRate || 0));
  req.input('overrideRate', sql.Decimal(19, 4), Number(overrideRate || 0));
  req.input('commission', sql.Decimal(19, 4), Number(commission || 0));
  // NOTE: SystemFees field is deprecated in codebase; keep at 0
  req.input('systemFees', sql.Decimal(19, 4), 0);
  req.input('createdBy', sql.UniqueIdentifier, createdBy);
  req.input('modifiedBy', sql.UniqueIdentifier, modifiedBy);
  req.input('status', sql.NVarChar(50), status || ENROLLMENT_STATUS.ACTIVE);

  const createdDateExpr = createdDate ? '@createdDate' : 'GETUTCDATE()';
  const modifiedDateExpr = modifiedDate ? '@modifiedDate' : 'GETUTCDATE()';
  if (createdDate) req.input('createdDate', sql.DateTime2, createdDate);
  if (modifiedDate) req.input('modifiedDate', sql.DateTime2, modifiedDate);

  const insertFields = [
    'EnrollmentId', 'MemberId', 'ProductId', 'AgentId', 'PolicyNumber', 'Status', 'EffectiveDate',
    'PremiumAmount', 'PaymentFrequency', 'EnrollmentDetails',
    'EmployerContributionAmount', 'ContributionId',
    'HouseholdId', 'ProductPricingId', 'NetRate', 'OverrideRate', 'Commission', 'SystemFees',
    'EnrollmentType',
    'CreatedDate', 'ModifiedDate', 'CreatedBy', 'ModifiedBy'
  ];
  const insertValues = [
    '@enrollmentId', '@memberId', '@productId', '@agentId', '@policyNumber', '@status', '@effectiveDate',
    '@premiumAmount', '@paymentFrequency', '@enrollmentDetails',
    '@employerContribution', '@contributionId',
    '@householdId', '@productPricingId', '@netRate', '@overrideRate', '@commission', '@systemFees',
    `'${enrollmentType}'`,
    createdDateExpr, modifiedDateExpr, '@createdBy', '@modifiedBy'
  ];

  if (groupId) {
    insertFields.push('GroupId');
    insertValues.push('@groupId');
    req.input('groupId', sql.UniqueIdentifier, groupId);
  }

  if (productBundleId) {
    insertFields.push('ProductBundleId');
    insertValues.push('@productBundleId');
    req.input('productBundleId', sql.UniqueIdentifier, productBundleId);
  }

  await req.query(`
    INSERT INTO oe.Enrollments
    (${insertFields.join(', ')})
    VALUES
    (${insertValues.join(', ')})
  `);

  // History-timeline log — fire-and-forget on its own connection. It never
  // throws and is intentionally not awaited, so enrollment cannot depend on
  // it and a logging failure cannot abort this caller's transaction.
  require('../memberEventLogService').logMemberEvent({
    memberId,
    eventType: 'ENROLLMENT_CREATED',
    eventDetails: `Enrolled in a product${effectiveDate ? ` effective ${effectiveDate}` : ''}`,
    userId: createdBy
  });

  return enrollmentId;
}

async function insertNonProductEnrollmentRow({
  poolOrTransaction,
  enrollmentId,
  memberId,
  householdId,
  agentId,
  groupId = null,
  effectiveDate,
  premiumAmount,
  enrollmentType,
  paymentFrequency = 'Monthly',
  createdBy,
  modifiedBy,
  nonProductProductId = '00000000-0000-0000-0000-000000000000',
  status = ENROLLMENT_STATUS.ACTIVE
}) {
  const req = poolOrTransaction.request();
  req.input('enrollmentId', sql.UniqueIdentifier, enrollmentId);
  req.input('memberId', sql.UniqueIdentifier, memberId);
  req.input('productId', sql.UniqueIdentifier, nonProductProductId);
  req.input('agentId', sql.UniqueIdentifier, agentId || null);
  req.input('effectiveDate', sql.Date, effectiveDate);
  req.input('premiumAmount', sql.Decimal(19, 4), Number(premiumAmount || 0));
  req.input('paymentFrequency', sql.NVarChar, paymentFrequency);
  req.input('householdId', sql.UniqueIdentifier, householdId || null);
  req.input('enrollmentType', sql.NVarChar(50), enrollmentType);
  req.input('createdBy', sql.UniqueIdentifier, createdBy);
  req.input('modifiedBy', sql.UniqueIdentifier, modifiedBy);
  req.input('status', sql.NVarChar(50), status || ENROLLMENT_STATUS.ACTIVE);

  const insertFields = [
    'EnrollmentId', 'MemberId', 'ProductId', 'AgentId', 'Status', 'EffectiveDate',
    'PremiumAmount', 'PaymentFrequency', 'HouseholdId', 'EnrollmentType',
    'CreatedDate', 'ModifiedDate', 'CreatedBy', 'ModifiedBy'
  ];
  const insertValues = [
    '@enrollmentId', '@memberId', '@productId', '@agentId', '@status', '@effectiveDate',
    '@premiumAmount', '@paymentFrequency', '@householdId', '@enrollmentType',
    'GETUTCDATE()', 'GETUTCDATE()', '@createdBy', '@modifiedBy'
  ];

  if (groupId) {
    insertFields.splice(8, 0, 'GroupId'); // before HouseholdId
    insertValues.splice(8, 0, '@groupId');
    req.input('groupId', sql.UniqueIdentifier, groupId);
  }

  await req.query(`
    INSERT INTO oe.Enrollments
    (${insertFields.join(', ')})
    VALUES
    (${insertValues.join(', ')})
  `);

  return enrollmentId;
}

async function insertContributionEnrollmentRow({
  poolOrTransaction,
  enrollmentId,
  memberId,
  householdId,
  agentId,
  groupId,
  effectiveDate,
  employerContributionAmount,
  contributionId = null,
  paymentFrequency = 'Monthly',
  createdBy,
  modifiedBy,
  nonProductProductId = '00000000-0000-0000-0000-000000000000'
}) {
  const req = poolOrTransaction.request();
  req.input('enrollmentId', sql.UniqueIdentifier, enrollmentId);
  req.input('memberId', sql.UniqueIdentifier, memberId);
  req.input('productId', sql.UniqueIdentifier, nonProductProductId);
  req.input('agentId', sql.UniqueIdentifier, agentId || null);
  req.input('effectiveDate', sql.Date, effectiveDate);
  req.input('premiumAmount', sql.Decimal(19, 4), 0);
  req.input('paymentFrequency', sql.NVarChar, paymentFrequency);
  req.input('employerContribution', sql.Decimal(19, 4), Number(employerContributionAmount || 0));
  req.input('contributionId', sql.UniqueIdentifier, contributionId || null);
  req.input('groupId', sql.UniqueIdentifier, groupId);
  req.input('householdId', sql.UniqueIdentifier, householdId || null);
  req.input('createdBy', sql.UniqueIdentifier, createdBy);
  req.input('modifiedBy', sql.UniqueIdentifier, modifiedBy);

  await req.query(`
    INSERT INTO oe.Enrollments (
      EnrollmentId, MemberId, ProductId, AgentId, Status, EffectiveDate,
      PremiumAmount, PaymentFrequency, EmployerContributionAmount, ContributionId,
      GroupId, HouseholdId, EnrollmentType,
      CreatedDate, ModifiedDate, CreatedBy, ModifiedBy
    )
    VALUES (
      @enrollmentId, @memberId, @productId, @agentId, 'Active', @effectiveDate,
      @premiumAmount, @paymentFrequency, @employerContribution, @contributionId,
      @groupId, @householdId, 'Contribution',
      GETUTCDATE(), GETUTCDATE(), @createdBy, @modifiedBy
    )
  `);

  return enrollmentId;
}

async function createHouseholdEnrollmentsForSelections({
  poolOrTransaction,
  householdMembers,
  selections,
  effectiveDate,
  createdBy,
  modifiedBy,
  householdId,
  agentId,
  groupId
}) {
  const created = [];

  for (const sel of selections) {
    for (const hm of householdMembers) {
      const isPrimary = hm.RelationshipType === 'P';
      const premium = isPrimary ? Number(sel.premiumAmount || 0) : 0;

      const enrollmentId = uuidv4();
      await insertProductEnrollmentRow({
        poolOrTransaction,
        enrollmentId,
        memberId: hm.MemberId,
        productId: sel.productId,
        agentId,
        policyNumber: sel.policyNumber || null,
        effectiveDate,
        premiumAmount: premium,
        enrollmentDetails: sel.enrollmentDetails || {},
        householdId,
        groupId: groupId || null,
        productBundleId: sel.productBundleId || null,
        enrollmentType: 'Product',
        paymentFrequency: 'Monthly',
        employerContributionAmount: isPrimary ? Number(sel.employerContributionAmount || 0) : 0,
        contributionId: isPrimary ? (sel.contributionId || null) : null,
        productPricingId: isPrimary ? (sel.productPricingId || null) : null,
        netRate: isPrimary ? Number(sel.netRate || 0) : 0,
        overrideRate: isPrimary ? Number(sel.overrideRate || 0) : 0,
        commission: isPrimary ? Number(sel.commission || 0) : 0,
        createdBy,
        modifiedBy
      });

      created.push({
        enrollmentId,
        memberId: hm.MemberId,
        productId: sel.productId,
        productBundleId: sel.productBundleId || null,
        effectiveDate,
        premiumAmount: premium,
        isDependentRow: !isPrimary
      });
    }
  }

  return created;
}

module.exports = {
  isProductLikeEnrollmentType,
  selectHouseholdEnrollmentsForPlanCard,
  selectHouseholdProductEnrollmentsForReplacement,
  terminateEnrollmentsByIds,
  insertProductEnrollmentRow,
  insertNonProductEnrollmentRow,
  insertContributionEnrollmentRow,
  createHouseholdEnrollmentsForSelections,
  PRODUCT_ENROLLMENT_TYPES,
  FEE_ENROLLMENT_TYPES
};

