'use strict';

const TierCalculator = require('../pricing/TierCalculator');
const {
  addMemberTierCount,
  addTobaccoCount,
  computeAgeStats,
  computeAmountStats,
  computeTierInference,
  computeTobaccoInference,
  emptyTierCounts,
  emptyTobaccoCounts,
  extractFeeMetadata,
  extractTobaccoFromE123Record,
  safeMemberAge
} = require('./e123TierInference');
const {
  pickBestPaymentForUser,
  hasMaskedPaymentHint,
  computeFetchCoverageStats
} = require('./e123PaymentExtract.service');

function parseDate(value) {
  if (!value) return null;
  const d = new Date(String(value).replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : d;
}

function mapRelationship(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'spouse' || raw === 's') return 'S';
  if (raw === 'child' || raw === 'c' || raw === 'dependent') return 'C';
  return 'P';
}

function isActiveProduct(product) {
  if (!product) return false;
  // E123 often keeps a stale reasonforcancel after plan changes/re-enrollments while the
  // enrollment row is still open (no dtcancelled, still billing). Trust dtcancelled only.
  const cancelled = String(product.dtcancelled || '').trim();
  if (cancelled) return false;
  return true;
}

/**
 * Non-fee E123 product row with an open (non-cancelled) enrollment.
 * When includeTerminatedHouseholds is enabled, cancelled rows are included for terminated households.
 */
function isEnrolledE123Product(product, options = {}) {
  if (!isAggregatableE123Product(product)) return false;
  if (isActiveProduct(product)) return true;
  if (!options.includeTerminatedHouseholds) return false;
  return Boolean(String(product.dtcancelled || '').trim());
}

function productRecencyKey(product) {
  const d = pickMigrationRecordDate(product);
  return d ? d.getTime() : 0;
}

function pickLatestProductsPerPdid(products) {
  const byPdid = new Map();
  for (const product of products || []) {
    const key = String(product.pdid || '');
    const existing = byPdid.get(key);
    if (!existing || productRecencyKey(product) > productRecencyKey(existing)) {
      byPdid.set(key, product);
    }
  }
  return Array.from(byPdid.values());
}

const NON_MIGRATABLE_LABEL_PATTERNS = [
  /\bcharge\s*back\b/i,
  /\bchargeback\b/i,
  /\benrollment\s+fee\b/i,
  /\bassociation\s+fee\b/i,
  /\badmin(istrative)?\s+fee\b/i,
  /\bprocessing\s+fee\b/i,
  /\blate\s+fee\b/i,
  /\bnsf\b/i,
  /\breturned?\s+(payment|check|ach)\b/i,
  /\bsetup\s+fee\b/i,
  /\bconvenience\s+fee\b/i,
  /\bservice\s+fee\b/i,
  /\btransaction\s+fee\b/i
];

const NON_MIGRATABLE_FEE_TYPES = new Set([
  'enrollment',
  'tax',
  'association',
  'chargeback',
  'fee',
  'administrative',
  'processing'
]);

function isMigratableE123Product(product, options = {}) {
  return isEnrolledE123Product(product, options);
}

function isAggregatableE123Product(product) {
  if (!product) return false;
  const label = String(product.label || product.name || '').trim();
  for (const pattern of NON_MIGRATABLE_LABEL_PATTERNS) {
    if (pattern.test(label)) return false;
  }

  const fees = product.productfees || [];
  if (fees.length > 0) {
    const feeTypes = fees
      .map((fee) => String(fee.type || fee.feetype || fee.fee_type || '').trim().toLowerCase())
      .filter(Boolean);
    if (feeTypes.length > 0 && feeTypes.every((type) => NON_MIGRATABLE_FEE_TYPES.has(type))) {
      return false;
    }
  }

  return true;
}

function getAggregatableProducts(products) {
  return (products || []).filter(isAggregatableE123Product);
}

function getMigratableProducts(products, options = {}) {
  const eligible = (products || []).filter((product) => isEnrolledE123Product(product, options));
  if (!eligible.length) return [];

  const active = eligible.filter((product) => isActiveProduct(product));
  if (active.length) return pickLatestProductsPerPdid(active);

  if (!options.includeTerminatedHouseholds) return [];
  const cancelled = eligible.filter((product) => String(product.dtcancelled || '').trim());
  return pickLatestProductsPerPdid(cancelled);
}

function isTerminatedE123Household(household, options = {}) {
  const migratable = getMigratableProducts(household?.products, options);
  if (!migratable.length) return false;
  return migratable.every((product) => !isActiveProduct(product));
}

function deriveHouseholdTerminationDate(household, options = {}) {
  const migratable = getMigratableProducts(household?.products, options);
  const dates = migratable
    .map((product) => parseDate(product.dtcancelled))
    .filter(Boolean);
  if (!dates.length) return null;
  dates.sort((a, b) => b.getTime() - a.getTime());
  return dates[0];
}

function attachHouseholdE123TerminationMeta(household, options = {}) {
  const e123Terminated = isTerminatedE123Household(household, options);
  const terminationDate = e123Terminated ? deriveHouseholdTerminationDate(household, options) : null;
  return {
    ...household,
    e123Terminated,
    e123TerminationDate: terminationDate ? terminationDate.toISOString() : null
  };
}

function pickMigrationRecordDate(product) {
  return parseDate(product.dtcreated)
    || parseDate(product.dteffective)
    || null;
}

function pickProductModifiedDate(product) {
  return pickMigrationRecordDate(product) || new Date();
}

function pickHouseholdMigrationRecordDate(household) {
  const options = { includeTerminatedHouseholds: !!household?.e123Terminated };
  const dates = getMigratableProducts(household?.products, options)
    .map((product) => pickMigrationRecordDate(product))
    .filter(Boolean);
  if (!dates.length) return new Date();
  dates.sort((a, b) => a - b);
  return dates[0];
}

function formatShortDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function computeDateRangeStats(values = []) {
  const dates = values.map((value) => parseDate(value)).filter(Boolean);
  if (!dates.length) return null;
  dates.sort((a, b) => a - b);
  const min = dates[0];
  const max = dates[dates.length - 1];
  return {
    min: min.toISOString().slice(0, 10),
    max: max.toISOString().slice(0, 10),
    minLabel: formatShortDate(min),
    maxLabel: formatShortDate(max),
    sampleSize: dates.length
  };
}

function formatDateRangeLabel(range) {
  if (!range?.minLabel) return null;
  if (range.minLabel === range.maxLabel) return range.minLabel;
  return `${range.minLabel} – ${range.maxLabel}`;
}

function isTruthyFlag(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'y' || raw === 'yes';
}

function buildEnrollmentStats(group) {
  const enrollmentCreatedRange = computeDateRangeStats(group.enrollmentCreatedDates);
  const effectiveDateRange = computeDateRangeStats(group.effectiveDates);
  const billingDateRange = computeDateRangeStats(group.billingDates);

  const parts = [];
  if (enrollmentCreatedRange) {
    parts.push(`Enrolled ${formatDateRangeLabel(enrollmentCreatedRange)}`);
  }
  if (effectiveDateRange) {
    parts.push(`Effective ${formatDateRangeLabel(effectiveDateRange)}`);
  }
  if (group.activeEnrollmentCount) {
    parts.push(`${group.activeEnrollmentCount.toLocaleString()} active`);
  }
  if (group.cancelledEnrollmentCount) {
    parts.push(`${group.cancelledEnrollmentCount.toLocaleString()} cancelled`);
  }
  if (group.onHoldEnrollmentCount) {
    parts.push(`${group.onHoldEnrollmentCount.toLocaleString()} on hold`);
  }
  if (group.unpaidEnrollmentCount) {
    parts.push(`${group.unpaidEnrollmentCount.toLocaleString()} unpaid`);
  }

  return {
    enrollmentCreatedRange,
    effectiveDateRange,
    billingDateRange,
    activeEnrollmentCount: group.activeEnrollmentCount || 0,
    cancelledEnrollmentCount: group.cancelledEnrollmentCount || 0,
    onHoldEnrollmentCount: group.onHoldEnrollmentCount || 0,
    unpaidEnrollmentCount: group.unpaidEnrollmentCount || 0,
    enrollmentSummaryLabel: parts.join(' · ') || null
  };
}

function normalizeGender(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (raw === 'M' || raw === 'MALE') return 'Male';
  if (raw === 'F' || raw === 'FEMALE') return 'Female';
  return '';
}

function pickE123Ssn(record) {
  if (!record || typeof record !== 'object') return null;
  const raw = record.ssn ?? record.SSN ?? record.socialsecuritynumber ?? record.social_security_number;
  if (raw == null || raw === '') return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length !== 9) return null;
  return digits;
}

function mapE123ProductRow(product) {
  return {
    upid: product.upid,
    pdid: product.pdid,
    label: product.label,
    description: product.description || null,
    policynumber: product.policynumber,
    dteffective: product.dteffective,
    dtcreated: product.dtcreated,
    dtbilling: product.dtbilling,
    dtrecurring: product.dtrecurring,
    dttransfer: product.dttransfer,
    dtupdated: product.dtupdated,
    dtfulfillment: product.dtfulfillment,
    dtcancelled: product.dtcancelled,
    reasonforcancel: product.reasonforcancel,
    bhold: product.bhold,
    bpaid: product.bpaid,
    holdtype: product.holdtype,
    holdreason: product.holdreason,
    modifiedDate: pickProductModifiedDate(product),
    benefitId: product.productfees?.[0]?.benefitid || product.productfees?.[0]?.periodid || null,
    productfees: product.productfees || []
  };
}

function buildHouseholdsFromE123Pages({ users, dependents, products, transactions }, options = {}) {
  const depsByUser = new Map();
  for (const dep of dependents || []) {
    const uid = String(dep.userid || '');
    if (!depsByUser.has(uid)) depsByUser.set(uid, []);
    depsByUser.get(uid).push(dep);
  }

  const productsByUser = new Map();
  for (const product of products || []) {
    if (!isAggregatableE123Product(product)) continue;
    const uid = String(product.userid || '');
    if (!productsByUser.has(uid)) productsByUser.set(uid, []);
    productsByUser.get(uid).push(mapE123ProductRow(product));
  }

  const households = [];

  for (const user of users || []) {
    const userId = String(user.userid || '');
    const memberProducts = productsByUser.get(userId) || [];
    if (getMigratableProducts(memberProducts, options).length === 0) continue;

    const userDeps = (depsByUser.get(userId) || []).map((dep) => ({
      e123DepId: dep.depid,
      e123Uuid: dep.uuid,
      firstName: dep.firstname,
      lastName: dep.lastname,
      middleName: dep.middlename,
      dateOfBirth: parseDate(dep.dob),
      gender: normalizeGender(dep.gender),
      relationshipType: mapRelationship(dep.relationship),
      ssn: pickE123Ssn(dep),
      email: dep.email || null,
      phone: dep.phone1 || null,
      address1: dep.address || null,
      address2: dep.address2 || null,
      city: dep.city || null,
      state: dep.state || null,
      zip: dep.zip || null
    }));

    const hasSpouse = userDeps.some((d) => d.relationshipType === 'S');
    const childrenCount = userDeps.filter((d) => d.relationshipType === 'C').length;
    const tier = TierCalculator.calculateMemberTier(hasSpouse, childrenCount);
    const tobaccoUse = extractTobaccoFromE123Record(user);

    const paymentMethod = pickBestPaymentForUser(transactions, userId);
    const paymentMethodMeta = paymentMethod
      ? null
      : (hasMaskedPaymentHint(transactions, userId) ? { maskedOnly: true } : null);

    households.push(attachHouseholdE123TerminationMeta({
      e123UserId: Number(user.userid),
      householdMemberId: String(user.memberid || '').trim(),
      brokerId: Number(user.brokerid) || null,
      sellingAgentId: Number(user.sellingagentid) || null,
      primary: {
        firstName: user.firstname,
        lastName: user.lastname,
        email: user.email || null,
        phone: user.phone1 || null,
        address1: user.address || null,
        address2: user.address2 || null,
        city: user.city || null,
        state: user.state || null,
        zip: user.zip || null,
        dateOfBirth: parseDate(user.dob),
        gender: normalizeGender(user.gender),
        ssn: pickE123Ssn(user),
        relationshipType: 'P',
        tier,
        tobaccoUse
      },
      dependents: userDeps,
      products: memberProducts,
      paymentMethod: paymentMethod || null,
      paymentMethodMeta
    }, options));
  }

  return households;
}

function aggregateProductKeys(households) {
  return aggregateProductGroups(households).flatMap((group) =>
    group.tiers.map((tier) => ({
      sourceProductKey: group.sourceProductKey,
      sourceBenefitKey: tier.sourceBenefitKey,
      sourceBenefitLabel: tier.sourceBenefitLabel,
      sourceProductLabel: group.sourceProductLabel,
      memberCount: tier.memberCount
    }))
  );
}

function aggregateProductGroups(households) {
  const products = new Map();

  for (const hh of households) {
    const productOptions = { includeTerminatedHouseholds: !!hh.e123Terminated };
    for (const product of getMigratableProducts(hh.products, productOptions)) {
      const pdid = String(product.pdid);
      if (!products.has(pdid)) {
        products.set(pdid, {
          sourceProductKey: pdid,
          sourceProductLabel: product.label || `E123 Product ${pdid}`,
          memberCount: 0,
          enrollmentCreatedDates: [],
          effectiveDates: [],
          billingDates: [],
          activeEnrollmentCount: 0,
          cancelledEnrollmentCount: 0,
          onHoldEnrollmentCount: 0,
          unpaidEnrollmentCount: 0,
          tiers: new Map()
        });
      }
      const group = products.get(pdid);
      group.memberCount += 1;
      if (product.dtcreated) group.enrollmentCreatedDates.push(product.dtcreated);
      if (product.dteffective) group.effectiveDates.push(product.dteffective);
      if (product.dtbilling) group.billingDates.push(product.dtbilling);

      const cancelled = String(product.dtcancelled || '').trim();
      if (cancelled) group.cancelledEnrollmentCount += 1;
      else group.activeEnrollmentCount += 1;
      if (isTruthyFlag(product.bhold)) group.onHoldEnrollmentCount += 1;
      if (!isTruthyFlag(product.bpaid)) group.unpaidEnrollmentCount += 1;

      const fees = (product.productfees && product.productfees.length > 0)
        ? product.productfees
        : [{ benefitid: product.benefitId }];

      for (const fee of fees) {
        const benefitKey = fee.benefitid != null ? String(fee.benefitid)
          : (fee.periodid != null ? String(fee.periodid) : null);
        const tierKey = benefitKey || '__default__';
        const feeHints = extractFeeMetadata(fee);
        const benefitLabel = feeHints.benefitLabel
          || fee.periodlabel
          || fee.periodname
          || null;
        if (!group.tiers.has(tierKey)) {
          group.tiers.set(tierKey, {
            sourceBenefitKey: benefitKey,
            sourceBenefitLabel: benefitLabel,
            memberCount: 0,
            memberTierCounts: emptyTierCounts(),
            tobaccoCounts: emptyTobaccoCounts(),
            memberAges: [],
            feeAmounts: [],
            commissionableAmounts: [],
            feeHints
          });
        }
        const tier = group.tiers.get(tierKey);
        tier.memberCount += 1;
        tier.memberTierCounts = addMemberTierCount(tier.memberTierCounts, hh.primary?.tier);
        tier.tobaccoCounts = addTobaccoCount(tier.tobaccoCounts, hh.primary?.tobaccoUse);
        const memberAge = safeMemberAge(hh.primary?.dateOfBirth);
        if (memberAge != null) tier.memberAges.push(memberAge);
        if (feeHints.amount != null) tier.feeAmounts.push(feeHints.amount);
        if (feeHints.commissionableAmount != null) {
          tier.commissionableAmounts.push(feeHints.commissionableAmount);
        }
        if (benefitLabel && !tier.sourceBenefitLabel) {
          tier.sourceBenefitLabel = benefitLabel;
        }
        if (!tier.feeHints?.benefitLabel && feeHints.benefitLabel) {
          tier.feeHints = feeHints;
        } else if (feeHints.unsharedAmount != null && tier.feeHints?.unsharedAmount == null) {
          tier.feeHints = { ...tier.feeHints, ...feeHints };
        }
      }
    }
  }

  return Array.from(products.values()).map((group) => ({
    sourceProductKey: group.sourceProductKey,
    sourceProductLabel: group.sourceProductLabel,
    memberCount: group.memberCount,
    enrollmentStats: buildEnrollmentStats(group),
    tiers: Array.from(group.tiers.values()).map((tier) => {
      const inference = computeTierInference(tier.memberTierCounts || emptyTierCounts());
      const tobaccoInference = computeTobaccoInference(tier.tobaccoCounts || emptyTobaccoCounts());
      const memberAgeRange = computeAgeStats(tier.memberAges || []);
      const feeAmountStats = computeAmountStats(tier.feeAmounts || []);
      const commissionableAmountStats = computeAmountStats(tier.commissionableAmounts || []);
      return {
        sourceBenefitKey: tier.sourceBenefitKey,
        sourceBenefitLabel: tier.sourceBenefitLabel,
        memberCount: tier.memberCount,
        memberTierCounts: inference.memberTierCounts,
        inferredMemberTier: inference.inferredMemberTier,
        tierConfidence: inference.tierConfidence,
        tierBreakdownLabel: inference.tierBreakdownLabel,
        tobaccoCounts: tobaccoInference.tobaccoCounts,
        inferredTobaccoUse: tobaccoInference.inferredTobaccoUse,
        tobaccoConfidence: tobaccoInference.tobaccoConfidence,
        tobaccoBreakdownLabel: tobaccoInference.tobaccoBreakdownLabel,
        memberAgeRange,
        feeHints: tier.feeHints || null,
        feeAmountStats,
        commissionableAmountStats
      };
    }).sort((a, b) =>
      String(a.sourceBenefitKey || '').localeCompare(String(b.sourceBenefitKey || ''))
    )
  })).sort((a, b) => a.sourceProductLabel.localeCompare(b.sourceProductLabel));
}

module.exports = {
  buildHouseholdsFromE123Pages,
  aggregateProductKeys,
  aggregateProductGroups,
  isActiveProduct,
  isEnrolledE123Product,
  isMigratableE123Product,
  isAggregatableE123Product,
  isTerminatedE123Household,
  deriveHouseholdTerminationDate,
  attachHouseholdE123TerminationMeta,
  getMigratableProducts,
  mapE123ProductRow,
  getAggregatableProducts,
  pickMigrationRecordDate,
  pickHouseholdMigrationRecordDate,
  mapRelationship,
  parseDate,
  computeDateRangeStats,
  buildEnrollmentStats,
  formatDateRangeLabel,
  pickE123Ssn,
  computeFetchCoverageStats
};
