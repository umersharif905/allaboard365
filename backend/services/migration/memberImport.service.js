'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { sql, getPool } = require('../../config/database');
const { ENROLLMENT_STATUS } = require('../../constants/enrollmentStatus');
const { formatAndEncryptSSN } = require('../members/dependentsWriter.service');
const { upsertMigrationPaymentMethod } = require('./migrationPaymentImport.service');
const { insertProductEnrollmentRow, terminateEnrollmentsByIds } = require('../enrollments/enrollmentWriter.service');
const UserRolesService = require('../shared/user-roles.service');
const productMapService = require('./productMap.service');
const { computeMigrationExpectedFees, insertMigrationFeeEnrollments } = require('./migrationEnrollmentFees.service');
const { classifyHouseholdMigrationStates } = require('./migrationStatus.service');
const { getMigratableProducts, pickHouseholdMigrationRecordDate } = require('./householdNormalizer');
const { resolveHouseholdAgent } = require('./migrationAgentResolver.service');
const { applyPremiumOffsetIfEnabled } = require('./migrationPremiumOffset.service');
const { buildMigrationEnrollmentPlan } = require('./migrationBundleEnrollment.service');

function normalizeGender(gender) {
  const raw = (gender || '').toString().trim();
  if (raw === 'M' || raw.toLowerCase() === 'male') return 'Male';
  if (raw === 'F' || raw.toLowerCase() === 'female') return 'Female';
  return raw || 'Male';
}

function normalizeMigrationEmailKey(email) {
  const raw = String(email || '').trim().toLowerCase();
  return raw || null;
}

/** Ensure each household member gets a distinct oe.Users email (E123 often repeats the primary email on dependents). */
function allocateMigrationUserEmail({
  preferredEmail,
  householdMemberId,
  usedEmailKeys,
  slotKey
}) {
  const key = normalizeMigrationEmailKey(preferredEmail);
  if (key && !usedEmailKeys.has(key)) {
    usedEmailKeys.add(key);
    return String(preferredEmail).trim();
  }

  const base = `${householdMemberId || 'household'}+${slotKey || uuidv4()}@noemail.com`;
  let candidate = base.toLowerCase();
  let suffix = 0;
  while (usedEmailKeys.has(candidate)) {
    suffix += 1;
    candidate = `${householdMemberId || 'household'}+${slotKey || 'dep'}-${suffix}@noemail.com`.toLowerCase();
  }
  usedEmailKeys.add(candidate);
  return candidate;
}

async function isMigrationEmailTaken(poolOrTransaction, email) {
  const key = normalizeMigrationEmailKey(email);
  if (!key) return false;
  const result = await poolOrTransaction.request()
    .input('email', sql.NVarChar, key)
    .query(`
      SELECT TOP 1 UserId
      FROM oe.Users
      WHERE LOWER(LTRIM(RTRIM(Email))) = @email
    `);
  return (result.recordset?.length ?? 0) > 0;
}

/** Agent login exists but no oe.Members row — primary can reuse email and add Member role. */
async function findAgentOnlyMigrationUser(poolOrTransaction, email, tenantId) {
  const key = normalizeMigrationEmailKey(email);
  if (!key || !tenantId) return null;
  const result = await poolOrTransaction.request()
    .input('email', sql.NVarChar, key)
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .query(`
      SELECT TOP 1 u.UserId, a.AgentId
      FROM oe.Users u
      LEFT JOIN oe.Members m ON m.UserId = u.UserId
      LEFT JOIN oe.Agents a ON a.UserId = u.UserId
      WHERE LOWER(LTRIM(RTRIM(u.Email))) = @email
        AND u.TenantId = @tenantId
        AND m.MemberId IS NULL
        AND EXISTS (
          SELECT 1
          FROM oe.UserRoles ur
          INNER JOIN oe.Roles r ON r.RoleId = ur.RoleId
          WHERE ur.UserId = u.UserId AND r.Name = N'Agent'
        )
    `);
  const row = result.recordset?.[0];
  if (!row?.UserId) return null;
  return { userId: row.UserId, agentId: row.AgentId || null };
}

/** Dependent email already belongs to an AB365 member — skip creating duplicate user/member. */
async function findExistingMemberByEmail(poolOrTransaction, email, tenantId) {
  const key = normalizeMigrationEmailKey(email);
  if (!key || !tenantId) return null;
  const result = await poolOrTransaction.request()
    .input('email', sql.NVarChar, key)
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .query(`
      SELECT TOP 1 m.MemberId, u.UserId, u.FirstName, u.LastName
      FROM oe.Users u
      INNER JOIN oe.Members m ON m.UserId = u.UserId
      WHERE LOWER(LTRIM(RTRIM(u.Email))) = @email
        AND u.TenantId = @tenantId
    `);
  const row = result.recordset?.[0];
  if (!row?.MemberId) return null;
  return {
    memberId: row.MemberId,
    userId: row.UserId,
    firstName: row.FirstName,
    lastName: row.LastName
  };
}

async function countDependentsAlreadyInAb365(poolOrTransaction, household, tenantId) {
  let count = 0;
  for (const dep of household.dependents || []) {
    if (dep.email?.trim() && (await findExistingMemberByEmail(poolOrTransaction, dep.email, tenantId))) {
      count += 1;
    }
  }
  return count;
}

function formatSkippedDependentsNote(skippedDependents) {
  if (!skippedDependents?.length) return '';
  const label = skippedDependents.length === 1 ? 'dependent' : 'dependents';
  const names = skippedDependents.join(', ');
  return ` (${skippedDependents.length} ${label} already in AB365 skipped${names ? `: ${names}` : ''})`;
}

async function resolvePrimaryMigrationEmail(poolOrTransaction, household, usedEmailKeys, tenantId) {
  const preferred = household.primary?.email?.trim();
  const key = normalizeMigrationEmailKey(preferred);
  if (key && !usedEmailKeys.has(key)) {
    if (!(await isMigrationEmailTaken(poolOrTransaction, preferred))) {
      usedEmailKeys.add(key);
      return preferred;
    }
    if (tenantId && (await findAgentOnlyMigrationUser(poolOrTransaction, preferred, tenantId))) {
      usedEmailKeys.add(key);
      return preferred;
    }
  }
  return allocateMigrationUserEmail({
    preferredEmail: null,
    householdMemberId: household.householdMemberId,
    usedEmailKeys,
    slotKey: 'primary'
  });
}

const MIGRATION_BCRYPT_ROUNDS = 8;

async function hashMigrationPassword() {
  return bcrypt.hash(crypto.randomBytes(8).toString('hex'), MIGRATION_BCRYPT_ROUNDS);
}

async function resolveHouseholdMigrationEmails(poolOrTransaction, household, tenantId) {
  const usedEmailKeys = new Set();
  const primaryEmail = await resolvePrimaryMigrationEmail(
    poolOrTransaction,
    household,
    usedEmailKeys,
    tenantId
  );
  const dependentEmails = (household.dependents || []).map((dep, depIndex) =>
    allocateMigrationUserEmail({
      preferredEmail: dep.email,
      householdMemberId: household.householdMemberId,
      usedEmailKeys,
      slotKey: `dep-${dep.e123DepId || dep.e123Uuid || depIndex + 1}`
    })
  );
  return { primaryEmail, dependentEmails, passwordHash: await hashMigrationPassword() };
}

async function resolveProductMapping(instanceId, product) {
  const benefitKey = product.benefitId != null ? String(product.benefitId) : null;
  let map = await productMapService.getProductMap({
    instanceId,
    sourceSystem: 'e123',
    sourceProductKey: String(product.pdid),
    sourceBenefitKey: benefitKey
  });
  if (!map && benefitKey) {
    map = await productMapService.getProductMap({
      instanceId,
      sourceSystem: 'e123',
      sourceProductKey: String(product.pdid),
      sourceBenefitKey: null
    });
  }
  return map;
}

function isIgnoredProductMap(map) {
  return !!map?.IgnoreImport;
}

function householdMigratableProductOptions(household) {
  return { includeTerminatedHouseholds: !!household?.e123Terminated };
}

function parseHouseholdTerminationDate(household) {
  if (!household?.e123TerminationDate) return null;
  const parsed = new Date(household.e123TerminationDate);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseProductTerminationDate(product) {
  const raw = product?.dtcancelled;
  if (!raw) return null;
  const parsed = new Date(String(raw).replace(' ', 'T'));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

async function validateHouseholdMappings(household, instanceId) {
  const migratableProducts = getMigratableProducts(
    household.products,
    householdMigratableProductOptions(household)
  );
  let mappedCount = 0;
  let skippedUnmappedCount = 0;
  let ignoredCount = 0;

  for (const product of migratableProducts) {
    const map = await resolveProductMapping(instanceId, product);
    if (isIgnoredProductMap(map)) {
      ignoredCount += 1;
      continue;
    }
    if (!map?.ProductId) {
      skippedUnmappedCount += 1;
      continue;
    }
    mappedCount += 1;
  }

  return {
    ok: true,
    migratableProducts,
    mappedCount,
    skippedUnmappedCount,
    ignoredCount
  };
}

async function precomputeMigrationFeePlan(pool, { tenantId, enrollmentPlan, paymentMethod }) {
  if (!enrollmentPlan?.productLines?.length || !tenantId) return null;
  return computeMigrationExpectedFees({
    poolOrTransaction: pool,
    tenantId,
    productLines: enrollmentPlan.productLines,
    paymentMethod
  });
}

async function planMigrationEnrollmentsWithOptions({
  household,
  migratableProducts,
  instanceId,
  tenantId,
  offsetProcessingFeeForPremiumMatch = false
}) {
  const enrollmentPlan = await buildMigrationEnrollmentPlan(
    household,
    migratableProducts,
    instanceId
  );
  const pool = await getPool();
  const precomputedFees = tenantId
    ? await precomputeMigrationFeePlan(pool, {
      tenantId,
      enrollmentPlan,
      paymentMethod: household.paymentMethod
    })
    : null;
  const premiumOffset = precomputedFees
    ? applyPremiumOffsetIfEnabled({
      enabled: offsetProcessingFeeForPremiumMatch === true,
      household,
      enrollmentPlan,
      precomputedFees
    })
    : {
      applied: 0,
      projectedTotal: null,
      projectedTotalAdjusted: null,
      e123Total: null,
      reason: 'incomplete'
    };
  return { enrollmentPlan, precomputedFees, premiumOffset };
}

async function insertPendingMigrationEnrollments({
  transaction,
  primaryMemberId,
  enrollmentPlan,
  household,
  tenantId,
  createdBy,
  agentId = null,
  precomputedFees = null
}) {
  const { productLines, enrollmentItems, earliestEffectiveDate } = enrollmentPlan;

  for (const item of enrollmentItems) {
    const {
      enrollmentId,
      product,
      productId,
      productBundleId,
      amounts,
      effectiveDate,
      recordDate,
      productPricingId,
      tobaccoUse
    } = item;

    await insertProductEnrollmentRow({
      poolOrTransaction: transaction,
      enrollmentId,
      memberId: primaryMemberId,
      productId,
      agentId,
      policyNumber: product?.policynumber || null,
      effectiveDate,
      premiumAmount: amounts.premiumAmount,
      enrollmentDetails: {
        migrationSource: 'e123',
        upid: product?.upid != null ? String(product.upid) : '',
        pdid: product?.pdid ?? null,
        migrationAuditDate: recordDate.toISOString(),
        inferredTobaccoUse: tobaccoUse || null,
        productBundleId: productBundleId || null
      },
      householdId: primaryMemberId,
      productPricingId: productPricingId || null,
      productBundleId: productBundleId || null,
      netRate: amounts.netRate,
      overrideRate: amounts.overrideRate,
      commission: amounts.commission,
      createdBy,
      modifiedBy: createdBy,
      status: ENROLLMENT_STATUS.PENDING_PAYMENT,
      createdDate: recordDate,
      modifiedDate: recordDate
    });

    if (amounts.includedPaymentProcessingFeeAmount > 0) {
      await transaction.request()
        .input('enrollmentId', sql.UniqueIdentifier, enrollmentId)
        .input('includedFee', sql.Decimal(19, 4), amounts.includedPaymentProcessingFeeAmount)
        .query(`
          UPDATE oe.Enrollments
          SET IncludedPaymentProcessingFeeAmount = @includedFee
          WHERE EnrollmentId = @enrollmentId
        `);
    }

    await transaction.request()
      .input('enrollmentId', sql.UniqueIdentifier, enrollmentId)
      .input('recordDate', sql.DateTime2, recordDate)
      .input('upid', sql.NVarChar, String(product?.upid || ''))
      .query(`
        UPDATE oe.Enrollments
        SET CreatedDate = @recordDate,
            ModifiedDate = @recordDate,
            IsPendingMigration = 1,
            MigrationSourceRecordId = @upid
        WHERE EnrollmentId = @enrollmentId
      `);
  }

  if (productLines.length > 0 && tenantId) {
    await insertMigrationFeeEnrollments({
      poolOrTransaction: transaction,
      tenantId,
      primaryMemberId,
      householdId: primaryMemberId,
      agentId,
      paymentMethod: household.paymentMethod,
      productLines,
      createdBy,
      effectiveDate: earliestEffectiveDate,
      status: ENROLLMENT_STATUS.PENDING_PAYMENT,
      precomputedFees
    });
  }
}

async function insertTerminatedE123Enrollments({
  transaction,
  primaryMemberId,
  enrollmentPlan,
  household,
  tenantId,
  createdBy,
  agentId = null,
  precomputedFees = null
}) {
  const { productLines, enrollmentItems, earliestEffectiveDate } = enrollmentPlan;
  const fallbackTerminationDate = parseHouseholdTerminationDate(household) || new Date();

  for (const item of enrollmentItems) {
    const {
      enrollmentId,
      product,
      productId,
      productBundleId,
      amounts,
      effectiveDate,
      recordDate,
      productPricingId,
      tobaccoUse
    } = item;

    await insertProductEnrollmentRow({
      poolOrTransaction: transaction,
      enrollmentId,
      memberId: primaryMemberId,
      productId,
      agentId,
      policyNumber: product?.policynumber || null,
      effectiveDate,
      premiumAmount: amounts.premiumAmount,
      enrollmentDetails: {
        migrationSource: 'e123',
        upid: product?.upid != null ? String(product.upid) : '',
        pdid: product?.pdid ?? null,
        migrationAuditDate: recordDate.toISOString(),
        inferredTobaccoUse: tobaccoUse || null,
        productBundleId: productBundleId || null,
        historicalTermination: true
      },
      householdId: primaryMemberId,
      productPricingId: productPricingId || null,
      productBundleId: productBundleId || null,
      netRate: amounts.netRate,
      overrideRate: amounts.overrideRate,
      commission: amounts.commission,
      createdBy,
      modifiedBy: createdBy,
      status: ENROLLMENT_STATUS.ACTIVE,
      createdDate: recordDate,
      modifiedDate: recordDate
    });

    const terminationDate = parseProductTerminationDate(product) || fallbackTerminationDate;
    await terminateEnrollmentsByIds({
      poolOrTransaction: transaction,
      enrollmentIds: [enrollmentId],
      terminationDate,
      modifiedBy: createdBy
    });

    await transaction.request()
      .input('enrollmentId', sql.UniqueIdentifier, enrollmentId)
      .input('recordDate', sql.DateTime2, recordDate)
      .input('upid', sql.NVarChar, String(product?.upid || ''))
      .query(`
        UPDATE oe.Enrollments
        SET CreatedDate = @recordDate,
            ModifiedDate = @recordDate,
            IsPendingMigration = 0,
            MigrationSourceRecordId = @upid
        WHERE EnrollmentId = @enrollmentId
      `);
  }

  if (productLines.length > 0 && tenantId) {
    await insertMigrationFeeEnrollments({
      poolOrTransaction: transaction,
      tenantId,
      primaryMemberId,
      householdId: primaryMemberId,
      agentId,
      paymentMethod: household.paymentMethod,
      productLines,
      createdBy,
      effectiveDate: earliestEffectiveDate,
      status: ENROLLMENT_STATUS.ACTIVE,
      precomputedFees
    });
  }
}

async function deleteHouseholdPendingMigrationEnrollments(transaction, householdId) {
  await transaction.request()
    .input('householdId', sql.UniqueIdentifier, householdId)
    .query(`
      DELETE e
      FROM oe.Enrollments e
      INNER JOIN oe.Members m ON m.MemberId = e.MemberId
      WHERE m.HouseholdId = @householdId
        AND ISNULL(e.IsPendingMigration, 0) = 1
    `);
}

async function updatePendingMigrationHousehold({
  household,
  tenantId,
  instanceId,
  createdBy,
  primaryMemberId,
  agentCache = null,
  offsetProcessingFeeForPremiumMatch = false
}) {
  const validation = await validateHouseholdMappings(household, instanceId);
  const { agentId } = await resolveHouseholdAgent({
    household,
    tenantId,
    instanceId,
    cache: agentCache,
    skipE123Api: true
  });

  const { enrollmentPlan, precomputedFees } = await planMigrationEnrollmentsWithOptions({
    household,
    migratableProducts: validation.migratableProducts,
    instanceId,
    tenantId,
    offsetProcessingFeeForPremiumMatch
  });

  const isTerminatedImport = household.e123Terminated === true;
  const householdTerminationDate = parseHouseholdTerminationDate(household);
  const memberStatus = isTerminatedImport ? 'Terminated' : 'Active';
  const pendingMigrationBit = isTerminatedImport ? 0 : 1;

  const pool = await getPool();
  const householdRow = await pool.request()
    .input('memberId', sql.UniqueIdentifier, primaryMemberId)
    .query(`
      SELECT HouseholdId
      FROM oe.Members
      WHERE MemberId = @memberId
    `);
  const householdId = householdRow.recordset?.[0]?.HouseholdId || primaryMemberId;

  const transaction = pool.transaction();
  await transaction.begin();

  try {
    const encryptedSSN = household.primary.ssn ? formatAndEncryptSSN(household.primary.ssn) : null;
    const householdRecordDate = pickHouseholdMigrationRecordDate(household);

    await transaction.request()
      .input('memberId', sql.UniqueIdentifier, primaryMemberId)
      .input('dob', sql.Date, household.primary.dateOfBirth || null)
      .input('gender', sql.NVarChar, normalizeGender(household.primary.gender))
      .input('address', sql.NVarChar, household.primary.address1 || null)
      .input('city', sql.NVarChar, household.primary.city || null)
      .input('state', sql.NVarChar, household.primary.state || null)
      .input('zip', sql.NVarChar, household.primary.zip || null)
      .input('tier', sql.NVarChar, household.primary.tier || 'EE')
      .input('ssn', sql.NVarChar, encryptedSSN)
      .input('tobaccoUse', sql.NVarChar, household.primary.tobaccoUse === 'Yes' ? 'Y' : 'N')
      .input('e123UserId', sql.NVarChar, String(household.e123UserId || ''))
      .input('recordDate', sql.DateTime2, householdRecordDate)
      .input('agentId', sql.UniqueIdentifier, agentId || null)
      .input('memberStatus', sql.NVarChar, memberStatus)
      .input('pendingMigration', sql.Bit, pendingMigrationBit)
      .input('terminationDate', sql.Date, householdTerminationDate || null)
      .query(`
        UPDATE oe.Members
        SET DateOfBirth = @dob,
            Gender = @gender,
            Address = @address,
            City = @city,
            State = @state,
            Zip = @zip,
            Tier = @tier,
            SSN = COALESCE(@ssn, SSN),
            TobaccoUse = @tobaccoUse,
            AgentId = COALESCE(@agentId, AgentId),
            Status = @memberStatus,
            IsPendingMigration = @pendingMigration,
            MigrationSourceSystem = 'e123',
            MigrationSourceRecordId = @e123UserId,
            TerminationDate = CASE WHEN @terminationDate IS NOT NULL THEN @terminationDate ELSE TerminationDate END,
            ModifiedDate = @recordDate
        WHERE MemberId = @memberId
      `);

    if (isTerminatedImport) {
      await transaction.request()
        .input('householdId', sql.UniqueIdentifier, householdId)
        .input('memberStatus', sql.NVarChar, memberStatus)
        .input('pendingMigration', sql.Bit, pendingMigrationBit)
        .input('terminationDate', sql.Date, householdTerminationDate || null)
        .input('recordDate', sql.DateTime2, householdRecordDate)
        .query(`
          UPDATE oe.Members
          SET Status = @memberStatus,
              IsPendingMigration = @pendingMigration,
              TerminationDate = CASE WHEN @terminationDate IS NOT NULL THEN @terminationDate ELSE TerminationDate END,
              ModifiedDate = @recordDate
          WHERE HouseholdId = @householdId
            AND RelationshipType <> 'P'
        `);
    }

    await deleteHouseholdPendingMigrationEnrollments(transaction, householdId);

    if (isTerminatedImport) {
      await insertTerminatedE123Enrollments({
        transaction,
        primaryMemberId,
        enrollmentPlan,
        household,
        tenantId,
        createdBy,
        agentId,
        precomputedFees
      });
    } else {
      await insertPendingMigrationEnrollments({
        transaction,
        primaryMemberId,
        enrollmentPlan,
        household,
        tenantId,
        createdBy,
        agentId,
        precomputedFees
      });

      await upsertMigrationPaymentMethod({
        transaction,
        memberId: primaryMemberId,
        tenantId,
        paymentMethod: household.paymentMethod,
        createdBy
      });
    }

    await transaction.commit();
    const skipNote = validation.skippedUnmappedCount > 0
      ? ` (${validation.skippedUnmappedCount} unmapped product(s) skipped)`
      : '';
    const agentNote = agentId ? '' : ' (agent not matched — will retry on re-apply)';
    const termNote = isTerminatedImport && householdTerminationDate
      ? ` (termination ${householdTerminationDate.toISOString().slice(0, 10)})`
      : isTerminatedImport ? ' (terminated in E123)' : '';
    if (isTerminatedImport) {
      return {
        action: 'terminated',
        message: `Re-synced terminated household with ${validation.mappedCount} historical enrollment(s) rebuilt${termNote}${skipNote}${agentNote}`,
        primaryMemberId,
        agentId
      };
    }
    return {
      action: 'update',
      message: `Updated pending migration household with ${validation.mappedCount} product enrollment(s) rebuilt (household staging cleared)${skipNote}${agentNote}`,
      primaryMemberId,
      agentId
    };
  } catch (err) {
    await transaction.rollback();
    return { action: 'error', message: err.message };
  }
}

async function importHousehold({
  household,
  tenantId,
  instanceId,
  createdBy,
  dryRun = false,
  agentCache = null,
  resyncPending = false,
  offsetProcessingFeeForPremiumMatch = false
}) {
  const importStartedAt = Date.now();
  const logImport = (phase, extra = '') => {
    const ms = Date.now() - importStartedAt;
    console.log(
      `[migration-import] ${household?.householdMemberId || '?'} ${phase}${extra ? ` ${extra}` : ''} (+${ms}ms)`
    );
  };

  if (!household?.householdMemberId) {
    return { action: 'error', message: 'Missing HouseholdMemberID' };
  }
  if (!instanceId) {
    return { action: 'error', message: 'Migration instance is required for product mapping' };
  }

  logImport('start', dryRun ? 'dry-run' : 'apply');
  const states = await classifyHouseholdMigrationStates([household.householdMemberId]);
  const migrationState = states.get(household.householdMemberId)?.state || 'new';
  logImport('classified', migrationState);

  if (migrationState === 'locked') {
    const activeCount = states.get(household.householdMemberId)?.activeEnrollmentCount || 0;
    return {
      action: 'locked',
      message: activeCount > 0
        ? `Member is active in AB365 with ${activeCount} live enrollment(s) — not modified`
        : 'Member is active in AB365 — not modified'
    };
  }

  if (migrationState === 'pending_update') {
    // Preview without resyncPending shows informational only; apply always rebuilds staging.
    if (dryRun && !resyncPending) {
      return {
        action: 'imported',
        message: 'Already imported — pending migration (select and apply to re-sync)'
      };
    }
    const validation = await validateHouseholdMappings(household, instanceId);
    const skipNote = validation.skippedUnmappedCount > 0
      ? ` (${validation.skippedUnmappedCount} unmapped product(s) will be skipped)`
      : '';
    const isTerminatedImport = household.e123Terminated === true;
    const termDate = parseHouseholdTerminationDate(household);
    const termNote = isTerminatedImport && termDate
      ? ` (E123 termination ${termDate.toISOString().slice(0, 10)})`
      : isTerminatedImport ? ' (terminated in E123)' : '';
    if (dryRun) {
      return isTerminatedImport
        ? {
          action: 'terminated',
          message: `Would re-sync terminated household with ${validation.mappedCount} historical enrollment(s)${termNote}${skipNote} (clears all household staging enrollments)`
        }
        : {
          action: 'update',
          message: `Would rebuild pending migration with ${validation.mappedCount} product enrollment(s)${skipNote} (clears all household staging enrollments)`
        };
    }
    const primaryMemberId = states.get(household.householdMemberId)?.primaryMemberId;
    if (!primaryMemberId) {
      return { action: 'error', message: 'Pending migration member record not found' };
    }
    logImport('resync', isTerminatedImport ? 'rebuild terminated household' : 'rebuild pending migration');
    return updatePendingMigrationHousehold({
      household,
      tenantId,
      instanceId,
      createdBy,
      primaryMemberId,
      agentCache,
      offsetProcessingFeeForPremiumMatch
    });
  }

  const validation = await validateHouseholdMappings(household, instanceId);
  logImport('mappings', `${validation.mappedCount} mapped`);
  const { agentId } = dryRun
    ? { agentId: null }
    : await resolveHouseholdAgent({
      household,
      tenantId,
      instanceId,
      cache: agentCache,
      skipE123Api: true
    });
  if (!dryRun) logImport('agent', agentId ? `resolved ${agentId}` : 'none');

  const mappedEnrollmentCount = validation.mappedCount;
  const skipNote = validation.skippedUnmappedCount > 0
    ? ` (${validation.skippedUnmappedCount} unmapped product(s) will be skipped)`
    : '';

  if (dryRun) {
    const pool = await getPool();
    const preferred = household.primary?.email?.trim();
    const agentOnlyPrimary = tenantId && preferred
      ? await findAgentOnlyMigrationUser(pool, preferred, tenantId)
      : null;
    const skippedDepCount = tenantId
      ? await countDependentsAlreadyInAb365(pool, household, tenantId)
      : 0;
    const agentNote = agentOnlyPrimary
      ? ' (existing agent login will receive Member role and pending migration record)'
      : '';
    const depSkipNote = skippedDepCount > 0
      ? ` (${skippedDepCount} dependent(s) already in AB365 will be skipped)`
      : '';
    const memberCount = 1 + (household.dependents?.length || 0) - skippedDepCount;
    const isTerminatedImport = household.e123Terminated === true;
    const termDate = parseHouseholdTerminationDate(household);
    const termNote = isTerminatedImport && termDate
      ? ` (E123 termination ${termDate.toISOString().slice(0, 10)})`
      : isTerminatedImport ? ' (terminated in E123)' : '';
    return {
      action: isTerminatedImport ? 'terminated' : 'create',
      message: isTerminatedImport
        ? `Would import terminated household with ${memberCount} member(s) and ${mappedEnrollmentCount} historical enrollment(s)${termNote}${depSkipNote}${skipNote}`
        : `Would create household with ${memberCount} member(s) and ${mappedEnrollmentCount} product enrollment(s)${agentNote}${depSkipNote}${skipNote}`
    };
  }

  const isTerminatedImport = household.e123Terminated === true;
  const householdTerminationDate = parseHouseholdTerminationDate(household);
  const memberStatus = isTerminatedImport ? 'Terminated' : 'Active';
  const pendingMigrationBit = isTerminatedImport ? 0 : 1;

  const pool = await getPool();
  logImport('resolve emails');
  const { primaryEmail, dependentEmails, passwordHash } = await resolveHouseholdMigrationEmails(
    pool,
    household,
    tenantId
  );
  const agentOnlyPrimary = await findAgentOnlyMigrationUser(pool, primaryEmail, tenantId);

  logImport('enrollment plan');
  const { enrollmentPlan, precomputedFees } = await planMigrationEnrollmentsWithOptions({
    household,
    migratableProducts: validation.migratableProducts,
    instanceId,
    tenantId,
    offsetProcessingFeeForPremiumMatch
  });

  const transaction = pool.transaction();
  let committed = false;
  await transaction.begin();
  logImport('transaction', 'begin');

  try {
    const primaryMemberId = uuidv4();
    const primaryUserId = agentOnlyPrimary ? agentOnlyPrimary.userId : uuidv4();
    const householdRecordDate = pickHouseholdMigrationRecordDate(household);

    if (!agentOnlyPrimary) {
      await transaction.request()
        .input('userId', sql.UniqueIdentifier, primaryUserId)
        .input('firstName', sql.NVarChar, household.primary.firstName || '')
        .input('lastName', sql.NVarChar, household.primary.lastName || '')
        .input('email', sql.NVarChar, primaryEmail)
        .input('passwordHash', sql.NVarChar, passwordHash)
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('recordDate', sql.DateTime2, householdRecordDate)
        .query(`
          INSERT INTO oe.Users (UserId, FirstName, LastName, Email, PasswordHash, TenantId, Status, CreatedDate, ModifiedDate)
          VALUES (@userId, @firstName, @lastName, @email, @passwordHash, @tenantId, 'Active', @recordDate, @recordDate)
        `);
    } else {
      logImport('primary', 'reuse agent-only user');
    }

    const encryptedSSN = household.primary.ssn ? formatAndEncryptSSN(household.primary.ssn) : null;

    await transaction.request()
      .input('memberId', sql.UniqueIdentifier, primaryMemberId)
      .input('userId', sql.UniqueIdentifier, primaryUserId)
      .input('householdId', sql.UniqueIdentifier, primaryMemberId)
      .input('dob', sql.Date, household.primary.dateOfBirth || null)
      .input('gender', sql.NVarChar, normalizeGender(household.primary.gender))
      .input('address', sql.NVarChar, household.primary.address1 || null)
      .input('city', sql.NVarChar, household.primary.city || null)
      .input('state', sql.NVarChar, household.primary.state || null)
      .input('zip', sql.NVarChar, household.primary.zip || null)
      .input('tier', sql.NVarChar, household.primary.tier || 'EE')
      .input('ssn', sql.NVarChar, encryptedSSN)
      .input('tobaccoUse', sql.NVarChar, household.primary.tobaccoUse === 'Yes' ? 'Y' : 'N')
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('e123UserId', sql.NVarChar, String(household.e123UserId || ''))
      .input('recordDate', sql.DateTime2, householdRecordDate)
      .input('agentId', sql.UniqueIdentifier, agentId || null)
      .input('memberStatus', sql.NVarChar, memberStatus)
      .input('pendingMigration', sql.Bit, pendingMigrationBit)
      .input('terminationDate', sql.Date, householdTerminationDate || null)
      .query(`
        INSERT INTO oe.Members (
          MemberId, UserId, HouseholdId, DateOfBirth, Gender, Address, City, State, Zip,
          RelationshipType, Status, TenantId, EnrollmentType, Tier, SSN, TobaccoUse,
          AgentId, IsPendingMigration, MigrationSourceSystem, MigrationSourceRecordId,
          TerminationDate, MemberSequence, CreatedDate, ModifiedDate
        ) VALUES (
          @memberId, @userId, @householdId, @dob, @gender, @address, @city, @state, @zip,
          'P', @memberStatus, @tenantId, 'Individual', @tier, @ssn, @tobaccoUse,
          @agentId, @pendingMigration, 'e123', @e123UserId,
          @terminationDate, 1, @recordDate, @recordDate
        )
      `);

    await transaction.request()
      .input('memberId', sql.UniqueIdentifier, primaryMemberId)
      .input('householdMemberId', sql.NVarChar, household.householdMemberId)
      .query(`
        UPDATE oe.Members SET HouseholdMemberID = @householdMemberId WHERE MemberId = @memberId
      `);

    await UserRolesService.assignRoleToUser(primaryUserId, 'Member', createdBy, transaction);

    const skippedExistingDependents = [];
    for (const [depIndex, dep] of (household.dependents || []).entries()) {
      const preferredDepEmail = dep.email?.trim();
      if (preferredDepEmail && tenantId) {
        const existingMember = await findExistingMemberByEmail(transaction, preferredDepEmail, tenantId);
        if (existingMember) {
          const name = `${dep.firstName || existingMember.firstName || ''} ${dep.lastName || existingMember.lastName || ''}`.trim()
            || preferredDepEmail;
          skippedExistingDependents.push(name);
          logImport('dependent', `skip existing member ${preferredDepEmail}`);
          continue;
        }
      }

      const depUserId = uuidv4();
      const depMemberId = uuidv4();
      const depPasswordHash = passwordHash;
      const depEmail = dependentEmails[depIndex];
      const depSSN = dep.ssn ? formatAndEncryptSSN(dep.ssn) : null;

      await transaction.request()
        .input('userId', sql.UniqueIdentifier, depUserId)
        .input('firstName', sql.NVarChar, dep.firstName || '')
        .input('lastName', sql.NVarChar, dep.lastName || '')
        .input('email', sql.NVarChar, depEmail)
        .input('passwordHash', sql.NVarChar, depPasswordHash)
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('recordDate', sql.DateTime2, householdRecordDate)
        .query(`
          INSERT INTO oe.Users (UserId, FirstName, LastName, Email, PasswordHash, TenantId, Status, CreatedDate, ModifiedDate)
          VALUES (@userId, @firstName, @lastName, @email, @passwordHash, @tenantId, 'Active', @recordDate, @recordDate)
        `);

      await transaction.request()
        .input('memberId', sql.UniqueIdentifier, depMemberId)
        .input('userId', sql.UniqueIdentifier, depUserId)
        .input('householdId', sql.UniqueIdentifier, primaryMemberId)
        .input('dob', sql.Date, dep.dateOfBirth || null)
        .input('relationshipType', sql.NVarChar, dep.relationshipType || 'C')
        .input('gender', sql.NVarChar, normalizeGender(dep.gender))
        .input('ssn', sql.NVarChar, depSSN)
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('e123DepId', sql.NVarChar, String(dep.e123DepId || dep.e123Uuid || ''))
        .input('recordDate', sql.DateTime2, householdRecordDate)
        .input('memberStatus', sql.NVarChar, memberStatus)
        .input('pendingMigration', sql.Bit, pendingMigrationBit)
        .input('terminationDate', sql.Date, householdTerminationDate || null)
        .query(`
          INSERT INTO oe.Members (
            MemberId, UserId, HouseholdId, DateOfBirth, Gender,
            RelationshipType, Status, TenantId, EnrollmentType, Tier, SSN, TobaccoUse,
            IsPendingMigration, MigrationSourceSystem, MigrationSourceRecordId,
            TerminationDate, MemberSequence, CreatedDate, ModifiedDate
          ) VALUES (
            @memberId, @userId, @householdId, @dob, @gender,
            @relationshipType, @memberStatus, @tenantId, 'Dependent', 'EF', @ssn, 'N',
            @pendingMigration, 'e123', @e123DepId,
            @terminationDate, 2, @recordDate, @recordDate
          )
        `);

      await UserRolesService.assignRoleToUser(depUserId, 'Member', createdBy, transaction);
    }

    logImport('members', 'inserted');
    if (isTerminatedImport) {
      await insertTerminatedE123Enrollments({
        transaction,
        primaryMemberId,
        enrollmentPlan,
        household,
        tenantId,
        createdBy,
        agentId,
        precomputedFees
      });
    } else {
      await insertPendingMigrationEnrollments({
        transaction,
        primaryMemberId,
        enrollmentPlan,
        household,
        tenantId,
        createdBy,
        agentId,
        precomputedFees
      });
    }
    logImport('enrollments', 'inserted');

    if (!isTerminatedImport) {
      await upsertMigrationPaymentMethod({
        transaction,
        memberId: primaryMemberId,
        tenantId,
        paymentMethod: household.paymentMethod,
        createdBy
      });
    }

    await transaction.commit();
    committed = true;
    logImport('done', isTerminatedImport ? 'terminated' : 'create');
    const createSkipNote = validation.skippedUnmappedCount > 0
      ? ` (${validation.skippedUnmappedCount} unmapped product(s) skipped)`
      : '';
    const agentUpgradeNote = agentOnlyPrimary ? ' (agent account upgraded with Member role)' : '';
    const depSkipNote = formatSkippedDependentsNote(skippedExistingDependents);
    const termNote = isTerminatedImport && householdTerminationDate
      ? ` (termination ${householdTerminationDate.toISOString().slice(0, 10)})`
      : '';
    return {
      action: isTerminatedImport ? 'terminated' : 'create',
      message: isTerminatedImport
        ? `Imported terminated household${termNote}${depSkipNote}${createSkipNote}`
        : `Imported successfully${agentUpgradeNote}${depSkipNote}${createSkipNote}`,
      primaryMemberId,
      agentId
    };
  } catch (err) {
    logImport('error', err.message);
    return { action: 'error', message: err.message };
  } finally {
    if (!committed) {
      try {
        await transaction.rollback();
      } catch (_) {
        // ignore rollback failures on dead transactions
      }
    }
  }
}

module.exports = {
  importHousehold,
  planMigrationEnrollmentsWithOptions,
  validateHouseholdMappings,
  resolveProductMapping,
  isIgnoredProductMap,
  classifyHouseholdMigrationStates,
  normalizeMigrationEmailKey,
  allocateMigrationUserEmail,
  resolvePrimaryMigrationEmail,
  findAgentOnlyMigrationUser,
  findExistingMemberByEmail,
  countDependentsAlreadyInAb365,
  formatSkippedDependentsNote,
  isMigrationEmailTaken
};
