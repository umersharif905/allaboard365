'use strict';

const { v4: uuidv4 } = require('uuid');
const { sql } = require('../../config/database');
const pricingAuthority = require('../pricing/pricingAuthority.service');
const productProcessingFeesUtil = require('../../utils/productProcessingFees');
const { insertNonProductEnrollmentRow } = require('../enrollments/enrollmentWriter.service');
const { ENROLLMENT_STATUS } = require('../../constants/enrollmentStatus');

async function markEnrollmentPendingMigration(poolOrTransaction, enrollmentId) {
  await poolOrTransaction.request()
    .input('enrollmentId', sql.UniqueIdentifier, enrollmentId)
    .query(`
      UPDATE oe.Enrollments
      SET IsPendingMigration = 1
      WHERE EnrollmentId = @enrollmentId
    `);
}

async function loadTenantFeeSettings(poolOrTransaction, tenantId) {
  const req = poolOrTransaction.request();
  req.input('tenantId', sql.UniqueIdentifier, tenantId);
  const result = await req.query(`
    SELECT TOP 1 PaymentProcessorSettings, SystemFees
    FROM oe.Tenants
    WHERE TenantId = @tenantId
  `);
  const row = result.recordset?.[0] || {};
  let paymentProcessorSettings = null;
  let systemFeesSettings = null;
  if (row.PaymentProcessorSettings) {
    try {
      paymentProcessorSettings = typeof row.PaymentProcessorSettings === 'string'
        ? JSON.parse(row.PaymentProcessorSettings)
        : row.PaymentProcessorSettings;
    } catch (_) {}
  }
  if (row.SystemFees) {
    try {
      systemFeesSettings = typeof row.SystemFees === 'string'
        ? JSON.parse(row.SystemFees)
        : row.SystemFees;
    } catch (_) {}
  }
  return { paymentProcessorSettings, systemFeesSettings };
}

function mapE123PaymentMethodType(paymentMethod) {
  const raw = paymentMethod?.paymentMethodType || paymentMethod?.type || '';
  if (String(raw).toLowerCase().includes('card') || raw === 'CreditCard') return 'Card';
  return 'ACH';
}

async function computeMigrationExpectedFees({
  poolOrTransaction,
  tenantId,
  productLines = [],
  paymentMethod
}) {
  if (!productLines.length) {
    return {
      expectedSystemFeeAmount: 0,
      expectedPaymentProcessingFeeRemainder: 0,
      expectedProcessingFeeTotal: 0,
      expectedPaymentProcessingFeeAmount: 0
    };
  }

  const { paymentProcessorSettings, systemFeesSettings } = await loadTenantFeeSettings(
    poolOrTransaction,
    tenantId
  );
  const chargeFeeToMemberEnabled = paymentProcessorSettings?.chargeFeeToMember === true;

  let includedProcessingFeeTotal = 0;
  let basePremiumTotal = 0;
  const nonIncludedProducts = [];

  for (const line of productLines) {
    const base = Number(line.basePremium || 0);
    basePremiumTotal += base;
    const included = Number(line.includedPaymentProcessingFeeAmount || line.includedProcessingFeeAmount || 0);
    if (included > 0) {
      includedProcessingFeeTotal += included;
    } else if (chargeFeeToMemberEnabled && base > 0) {
      nonIncludedProducts.push({ productId: line.productId, monthlyPremium: base });
    }
  }

  const subscriptionFeeSettingsByProductId = await productProcessingFeesUtil.loadSubscriptionFeeSettingsByProductId({
    poolOrTransaction,
    tenantId,
    productIds: productLines.map((line) => line.productId)
  });

  const expectedSystemFeeAmount = Math.round(Number(productProcessingFeesUtil.calculateSystemFeeAmount({
    subscriptionFeeSettingsByProductId,
    basePremiumTotal,
    systemFeesSettings
  }) || 0) * 100) / 100;

  let nonIncludedProcessingFeeAmount = 0;
  if (chargeFeeToMemberEnabled && nonIncludedProducts.length > 0) {
    const authorityOutput = await pricingAuthority.computePricing({
      poolOrTransaction,
      tenantId,
      pricingProducts: nonIncludedProducts,
      paymentMethodType: mapE123PaymentMethodType(paymentMethod)
    });
    nonIncludedProcessingFeeAmount = Number(authorityOutput?.totals?.nonIncludedFeeTotal || 0);
  }

  const expectedPaymentProcessingFeeRemainder = Math.round(Number(nonIncludedProcessingFeeAmount || 0) * 100) / 100;
  const expectedProcessingFeeTotal = Math.round((includedProcessingFeeTotal + expectedPaymentProcessingFeeRemainder) * 100) / 100;

  return {
    expectedSystemFeeAmount,
    expectedPaymentProcessingFeeRemainder,
    expectedProcessingFeeTotal,
    expectedPaymentProcessingFeeAmount: expectedProcessingFeeTotal,
    expectedIncludedProcessingFeeTotal: Math.round(includedProcessingFeeTotal * 100) / 100
  };
}

async function insertMigrationFeeEnrollments({
  poolOrTransaction,
  tenantId,
  primaryMemberId,
  householdId,
  agentId,
  paymentMethod,
  productLines,
  createdBy,
  effectiveDate,
  status = ENROLLMENT_STATUS.PENDING_PAYMENT,
  precomputedFees = null
}) {
  const expected = precomputedFees || await computeMigrationExpectedFees({
    poolOrTransaction,
    tenantId,
    productLines,
    paymentMethod
  });

  const eps = 0.01;
  const created = [];

  if (expected.expectedSystemFeeAmount > eps) {
    const enrollmentId = uuidv4();
    await insertNonProductEnrollmentRow({
      poolOrTransaction,
      enrollmentId,
      memberId: primaryMemberId,
      householdId,
      agentId: agentId || null,
      effectiveDate,
      premiumAmount: expected.expectedSystemFeeAmount,
      enrollmentType: 'SystemFee',
      createdBy,
      modifiedBy: createdBy,
      status
    });
    await markEnrollmentPendingMigration(poolOrTransaction, enrollmentId);
    created.push('SystemFee');
  }

  if (expected.expectedPaymentProcessingFeeRemainder > eps) {
    const enrollmentId = uuidv4();
    await insertNonProductEnrollmentRow({
      poolOrTransaction,
      enrollmentId,
      memberId: primaryMemberId,
      householdId,
      agentId: agentId || null,
      effectiveDate,
      premiumAmount: expected.expectedPaymentProcessingFeeRemainder,
      enrollmentType: 'PaymentProcessingFee',
      createdBy,
      modifiedBy: createdBy,
      status
    });
    await markEnrollmentPendingMigration(poolOrTransaction, enrollmentId);
    created.push('PaymentProcessingFee');
  }

  return { ...expected, created };
}

module.exports = {
  mapE123PaymentMethodType,
  computeMigrationExpectedFees,
  insertMigrationFeeEnrollments
};
