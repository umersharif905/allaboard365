const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { sql } = require('../../config/database');
const encryptionService = require('../encryptionService');

function normalizeGender(gender) {
  const raw = (gender || '').toString().trim();
  if (raw === 'M' || raw.toLowerCase() === 'male') return 'Male';
  if (raw === 'F' || raw.toLowerCase() === 'female') return 'Female';
  return '';
}

function formatSSN(ssn) {
  if (!ssn || typeof ssn !== 'string') {
    return null;
  }
  const digitsOnly = ssn.replace(/\D/g, '');
  if (digitsOnly.length !== 9) {
    return null;
  }
  return `${digitsOnly.slice(0, 3)}-${digitsOnly.slice(3, 5)}-${digitsOnly.slice(5, 9)}`;
}

function formatAndEncryptSSN(ssn) {
  const formatted = formatSSN(ssn);
  if (!formatted) {
    return null;
  }
  return encryptionService.encrypt(formatted);
}

/**
 * Create a new dependent as oe.Users + oe.Members inside an existing transaction.
 * This mirrors the enrollment-link dependent creation shape, but is intentionally minimal.
 */
async function createDependentInHousehold({
  transaction,
  tenantId,
  householdId,
  groupId = null,
  agentId = null,
  dependent
}) {
  if (!transaction) throw new Error('transaction is required');
  if (!tenantId) throw new Error('tenantId is required');
  if (!householdId) throw new Error('householdId is required');
  if (!dependent?.firstName || !dependent?.lastName || !dependent?.dateOfBirth) {
    throw new Error('Dependent firstName, lastName, and dateOfBirth are required');
  }

  const normalizedGender = normalizeGender(dependent.gender);
  if (!normalizedGender) {
    throw new Error('Dependent gender is required (Male/Female)');
  }

  // SSN is optional (when provided, must be 9 digits)
  const encryptedSSN = dependent?.ssn ? formatAndEncryptSSN(dependent.ssn) : null;
  if (dependent?.ssn && !encryptedSSN) {
    throw new Error('Dependent SSN must be 9 digits');
  }

  const relationshipType = dependent.relationshipType === 'S' || dependent.relationshipType === 'Spouse'
    ? 'S'
    : 'C';

  const dependentUserId = crypto.randomUUID();
  const dependentMemberId = crypto.randomUUID();

  // Temporary password (not communicated by this flow; dependents typically use household access)
  const dependentPassword = crypto.randomBytes(8).toString('hex');
  const passwordHash = await bcrypt.hash(dependentPassword, 10);

  const createUserReq = transaction.request();
  createUserReq.input('userId', sql.UniqueIdentifier, dependentUserId);
  createUserReq.input('firstName', sql.NVarChar, dependent.firstName);
  createUserReq.input('lastName', sql.NVarChar, dependent.lastName);
  createUserReq.input('email', sql.NVarChar, dependent.email && String(dependent.email).trim().length > 0
    ? dependent.email
    : `dependent-${dependentUserId}@noemail.com`);
  createUserReq.input('passwordHash', sql.NVarChar, passwordHash);
  createUserReq.input('tenantId', sql.UniqueIdentifier, tenantId);
  createUserReq.input('status', sql.NVarChar, 'Active');

  await createUserReq.query(`
    INSERT INTO oe.Users (UserId, FirstName, LastName, Email, PasswordHash, TenantId, Status, CreatedDate, ModifiedDate)
    VALUES (@userId, @firstName, @lastName, @email, @passwordHash, @tenantId, @status, GETUTCDATE(), GETUTCDATE())
  `);

  const createMemberReq = transaction.request();
  createMemberReq.input('memberId', sql.UniqueIdentifier, dependentMemberId);
  createMemberReq.input('userId', sql.UniqueIdentifier, dependentUserId);
  createMemberReq.input('householdId', sql.UniqueIdentifier, householdId);
  createMemberReq.input('dateOfBirth', sql.Date, dependent.dateOfBirth);
  createMemberReq.input('relationshipType', sql.NVarChar, relationshipType);
  createMemberReq.input('status', sql.NVarChar, 'Active');
  createMemberReq.input('tenantId', sql.UniqueIdentifier, tenantId);
  createMemberReq.input('agentId', sql.UniqueIdentifier, agentId);
  createMemberReq.input('enrollmentType', sql.NVarChar, 'Dependent');
  createMemberReq.input('tier', sql.NVarChar, 'EF');
  createMemberReq.input('gender', sql.NVarChar, normalizedGender);
  createMemberReq.input('ssn', sql.NVarChar, encryptedSSN);

  if (groupId) {
    createMemberReq.input('groupId', sql.UniqueIdentifier, groupId);
    await createMemberReq.query(`
      INSERT INTO oe.Members (
        MemberId, UserId, GroupId, HouseholdId, DateOfBirth,
        RelationshipType, Status, TenantId, AgentId, EnrollmentType, Tier, Gender, SSN,
        CreatedDate, ModifiedDate
      )
      VALUES (
        @memberId, @userId, @groupId, @householdId, @dateOfBirth,
        @relationshipType, @status, @tenantId, @agentId, @enrollmentType, @tier, @gender, @ssn,
        GETUTCDATE(), GETUTCDATE()
      )
    `);
  } else {
    await createMemberReq.query(`
      INSERT INTO oe.Members (
        MemberId, UserId, HouseholdId, DateOfBirth,
        RelationshipType, Status, TenantId, AgentId, EnrollmentType, Tier, Gender, SSN,
        CreatedDate, ModifiedDate
      )
      VALUES (
        @memberId, @userId, @householdId, @dateOfBirth,
        @relationshipType, @status, @tenantId, @agentId, @enrollmentType, @tier, @gender, @ssn,
        GETUTCDATE(), GETUTCDATE()
      )
    `);
  }

  return {
    userId: dependentUserId,
    memberId: dependentMemberId,
    relationshipType
  };
}

async function terminateDependentMember({ transaction, memberId, modifiedBy = null }) {
  if (!transaction) throw new Error('transaction is required');
  if (!memberId) throw new Error('memberId is required');

  const req = transaction.request();
  req.input('memberId', sql.UniqueIdentifier, memberId);
  req.input('modifiedBy', sql.UniqueIdentifier, modifiedBy);

  await req.query(`
    UPDATE oe.Members
    SET Status = 'Terminated',
        ModifiedDate = GETUTCDATE(),
        ModifiedBy = @modifiedBy
    WHERE MemberId = @memberId
      AND Status != 'Terminated'
  `);
}

/**
 * Reactivate dependent: set oe.Members.Status = 'Active', oe.Users.Status = 'Active'.
 * Use when re-adding an inactive dependent to the household/plans.
 */
async function reactivateDependentMember({ transaction, memberId, modifiedBy = null }) {
  if (!transaction) throw new Error('transaction is required');
  if (!memberId) throw new Error('memberId is required');

  const getReq = transaction.request();
  getReq.input('memberId', sql.UniqueIdentifier, memberId);
  const res = await getReq.query(`SELECT UserId FROM oe.Members WHERE MemberId = @memberId`);
  const row = res.recordset?.[0];
  if (!row?.UserId) throw new Error(`Dependent member not found: ${memberId}`);

  const userId = row.UserId;

  const memberReq = transaction.request();
  memberReq.input('memberId', sql.UniqueIdentifier, memberId);
  memberReq.input('modifiedBy', sql.UniqueIdentifier, modifiedBy);
  await memberReq.query(`
    UPDATE oe.Members
    SET Status = 'Active',
        ModifiedDate = GETUTCDATE(),
        ModifiedBy = @modifiedBy
    WHERE MemberId = @memberId
  `);

  const userReq = transaction.request();
  userReq.input('userId', sql.UniqueIdentifier, userId);
  userReq.input('modifiedBy', sql.UniqueIdentifier, modifiedBy);
  await userReq.query(`
    UPDATE oe.Users
    SET Status = 'Active',
        ModifiedDate = GETUTCDATE(),
        ModifiedBy = @modifiedBy
    WHERE UserId = @userId
  `);
}

/**
 * Disable dependent: set oe.Members.Status = 'Inactive', oe.Users.Status = 'Inactive'.
 * Enrollments are assumed already terminated in the same transaction.
 */
async function disableDependentMember({ transaction, memberId, modifiedBy = null }) {
  if (!transaction) throw new Error('transaction is required');
  if (!memberId) throw new Error('memberId is required');

  const getReq = transaction.request();
  getReq.input('memberId', sql.UniqueIdentifier, memberId);
  const res = await getReq.query(`SELECT UserId FROM oe.Members WHERE MemberId = @memberId`);
  const row = res.recordset?.[0];
  if (!row?.UserId) throw new Error(`Dependent member not found: ${memberId}`);

  const userId = row.UserId;

  const memberReq = transaction.request();
  memberReq.input('memberId', sql.UniqueIdentifier, memberId);
  memberReq.input('modifiedBy', sql.UniqueIdentifier, modifiedBy);
  await memberReq.query(`
    UPDATE oe.Members
    SET Status = 'Inactive',
        ModifiedDate = GETUTCDATE(),
        ModifiedBy = @modifiedBy
    WHERE MemberId = @memberId
  `);

  const userReq = transaction.request();
  userReq.input('userId', sql.UniqueIdentifier, userId);
  userReq.input('modifiedBy', sql.UniqueIdentifier, modifiedBy);
  await userReq.query(`
    UPDATE oe.Users
    SET Status = 'Inactive',
        ModifiedDate = GETUTCDATE(),
        ModifiedBy = @modifiedBy
    WHERE UserId = @userId
  `);
}

/**
 * Hard delete dependent: DELETE oe.Enrollments (for MemberId), then oe.Members, then oe.Users.
 * Also removes UserRoles and MemberPaymentMethods. Dangerous and irreversible.
 */
async function hardDeleteDependentMember({ transaction, memberId, modifiedBy = null }) {
  if (!transaction) throw new Error('transaction is required');
  if (!memberId) throw new Error('memberId is required');

  const getReq = transaction.request();
  getReq.input('memberId', sql.UniqueIdentifier, memberId);
  const res = await getReq.query(`SELECT UserId FROM oe.Members WHERE MemberId = @memberId`);
  const row = res.recordset?.[0];
  if (!row?.UserId) throw new Error(`Dependent member not found: ${memberId}`);

  const userId = row.UserId;

  // Delete enrollments for this member (FK from Enrollments to Members)
  const delEnrollReq = transaction.request();
  delEnrollReq.input('memberId', sql.UniqueIdentifier, memberId);
  await delEnrollReq.query(`DELETE FROM oe.Enrollments WHERE MemberId = @memberId`);

  // Remove user roles (FK from UserRoles to Users)
  const delRolesReq = transaction.request();
  delRolesReq.input('userId', sql.UniqueIdentifier, userId);
  await delRolesReq.query(`DELETE FROM oe.UserRoles WHERE UserId = @userId`);

  // MemberPaymentMethods if table exists and has MemberId
  try {
    const delPmReq = transaction.request();
    delPmReq.input('memberId', sql.UniqueIdentifier, memberId);
    await delPmReq.query(`DELETE FROM oe.MemberPaymentMethods WHERE MemberId = @memberId`);
  } catch (_) {
    // Table or column may not exist
  }

  // MemberIDIncrement (ID card / sequence rows) — FK to Members blocks hard delete without this
  try {
    const delIncReq = transaction.request();
    delIncReq.input('memberId', sql.UniqueIdentifier, memberId);
    await delIncReq.query(`DELETE FROM oe.MemberIDIncrement WHERE MemberId = @memberId`);
  } catch (_) {
    // Table may not exist in all environments
  }

  // Delete member then user
  const delMemberReq = transaction.request();
  delMemberReq.input('memberId', sql.UniqueIdentifier, memberId);
  await delMemberReq.query(`DELETE FROM oe.Members WHERE MemberId = @memberId`);

  const delUserReq = transaction.request();
  delUserReq.input('userId', sql.UniqueIdentifier, userId);
  await delUserReq.query(`DELETE FROM oe.Users WHERE UserId = @userId`);
}

module.exports = {
  createDependentInHousehold,
  terminateDependentMember,
  disableDependentMember,
  hardDeleteDependentMember,
  reactivateDependentMember,
  /** Reused by product-changes-complete and other flows that insert oe.Members.SSN */
  formatAndEncryptSSN
};

