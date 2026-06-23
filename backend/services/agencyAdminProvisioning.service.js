/**
 * Tenant Admin: duplicate an existing agent into a new login for another agency (or invite a new email).
 * Mirrors sql-changes/2026-04-13-clone-agent-tyler-clackum-to-mightywell-us-dry-run.sql for duplicate path.
 */

const { sql } = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const agencyAdmins = require('../utils/agencyAdmins');
const UserRolesService = require('./shared/user-roles.service');
const MessageQueueService = require('./messageQueue.service');
const CommissionLevelService = require('./commissionLevel.service');
const { generateAgentCode } = require('./agentCode.service');

const GLOBAL_COMMISSION_LEVELS_HYBRID_ENABLED = String(process.env.COMMISSION_LEVELS_HYBRID_ENABLED || 'true').toLowerCase() !== 'false';

const TIER_SQL = sql.Decimal(9, 4);

async function validateCommissionLevelId(tenantId, commissionLevelId) {
  if (!commissionLevelId) return null;
  const level = await CommissionLevelService.getCommissionLevelById(tenantId, commissionLevelId, { includeInactive: false });
  if (!level) {
    const err = new Error('Commission level was not found for this tenant.');
    err.statusCode = 400;
    throw err;
  }
  return level;
}

function normalizeEmail(e) {
  return String(e || '').trim().toLowerCase();
}

function normGuid(g) {
  if (g == null || g === '') return '';
  return String(g).replace(/[{}]/g, '').toLowerCase();
}

/**
 * Add an existing login as agency admin: safe when primary tenant matches and user is not
 * already an agent under a different agency in this tenant.
 * @param {import('mssql').ConnectionPool} pool
 * @param {object} opts
 */
async function addExistingUserAsAgencyAdmin(pool, opts) {
  const {
    tenantId,
    targetAgencyId,
    targetEmail,
    commissionLevelId,
    createdByUserId
  } = opts;

  const emailNorm = normalizeEmail(targetEmail);
  if (!emailNorm || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm)) {
    const err = new Error('A valid email is required.');
    err.statusCode = 400;
    throw err;
  }

  const flags = await CommissionLevelService.getTenantFlags(tenantId);
  const hybrid = GLOBAL_COMMISSION_LEVELS_HYBRID_ENABLED && flags.commissionLevelsHybridEnabled;
  const useCustomOnly = flags.useCustomCommissionLevelsOnly;
  let resolvedLevel = null;
  if (commissionLevelId) {
    resolvedLevel = await validateCommissionLevelId(tenantId, commissionLevelId);
  } else if (useCustomOnly) {
    const err = new Error('CommissionLevelId is required for this tenant.');
    err.statusCode = 400;
    throw err;
  }

  const agencyCheck = await pool.request()
    .input('AgencyId', sql.UniqueIdentifier, targetAgencyId)
    .input('TenantId', sql.UniqueIdentifier, tenantId)
    .query(`SELECT AgencyId FROM oe.Agencies WHERE AgencyId = @AgencyId AND TenantId = @TenantId AND Status = N'Active'`);
  if (agencyCheck.recordset.length === 0) {
    const err = new Error('Agency not found or access denied.');
    err.statusCode = 404;
    throw err;
  }

  const userReq = await pool.request()
    .input('Email', sql.NVarChar, emailNorm)
    .query(`
      SELECT UserId, TenantId, FirstName, LastName, PhoneNumber, Email
      FROM oe.Users
      WHERE LOWER(LTRIM(RTRIM(Email))) = @Email
    `);
  if (userReq.recordset.length === 0) {
    const err = new Error('No user found with this email.');
    err.statusCode = 404;
    throw err;
  }
  const u = userReq.recordset[0];
  const userId = u.UserId;

  if (normGuid(u.TenantId) !== normGuid(tenantId)) {
    const err = new Error(
      "This person's primary organization does not match this agency's organization. Only users whose primary tenant is this organization can be added."
    );
    err.statusCode = 400;
    throw err;
  }

  const agentRowsReq = await pool.request()
    .input('UserId', sql.UniqueIdentifier, userId)
    .input('TenantId', sql.UniqueIdentifier, tenantId)
    .query(`
      SELECT AgentId, AgencyId
      FROM oe.Agents
      WHERE UserId = @UserId AND TenantId = @TenantId AND Status = N'Active'
    `);
  const agentRows = agentRowsReq.recordset || [];
  const tgt = normGuid(targetAgencyId);

  for (const row of agentRows) {
    if (!row.AgencyId) {
      const err = new Error(
        'This user has an agent profile in this organization without an agency assignment. Contact support before continuing.'
      );
      err.statusCode = 400;
      throw err;
    }
    if (normGuid(row.AgencyId) !== tgt) {
      const err = new Error(
        'This user is already an agent under another agency in this organization. Remove them from that agency first, or use a different email.'
      );
      err.statusCode = 400;
      throw err;
    }
  }

  if (agentRows.length > 0) {
    const agentId = agentRows[0].AgentId;
    const already = await agencyAdmins.isAgencyAdmin(pool, targetAgencyId, agentId);
    if (already) {
      const err = new Error('This user is already an agency admin for this agency.');
      err.statusCode = 409;
      throw err;
    }
    await agencyAdmins.appendAgencyAdmin(pool, targetAgencyId, agentId, tenantId);
    await UserRolesService.assignRoleToUser(userId, 'Agent', createdByUserId);
    await agencyAdmins.ensureAgencyOwnerRolesForAgency(pool, targetAgencyId, createdByUserId);
    return {
      userId,
      agentId,
      email: emailNorm,
      existingUser: true,
      reusedExistingAgent: true,
      addedAgencyAdminOnly: true
    };
  }

  const fn = String(u.FirstName || '').trim() || 'Agent';
  const ln = String(u.LastName || '').trim() || 'User';
  const phone = u.PhoneNumber ? String(u.PhoneNumber).trim() : null;
  const agentId = uuidv4();

  const tierCols = await pool.request().query(`
    SELECT COLUMN_NAME
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = 'oe'
      AND TABLE_NAME = 'Agents'
      AND COLUMN_NAME IN ('CommissionTierLevel', 'CommissionLevelId')
  `);
  const hasTier = new Set((tierCols.recordset || []).map((r) => r.COLUMN_NAME));

  const effectiveTier = resolvedLevel ? Number(resolvedLevel.SortOrder) : 1;

  const transaction = pool.transaction();
  await transaction.begin();
  try {
    const agentCode = await generateAgentCode(transaction, tenantId);
    const aReq = transaction.request();
    aReq.input('AgentId', sql.UniqueIdentifier, agentId);
    aReq.input('UserId', sql.UniqueIdentifier, userId);
    aReq.input('TenantId', sql.UniqueIdentifier, tenantId);
    aReq.input('AgencyId', sql.UniqueIdentifier, targetAgencyId);
    aReq.input('Email', sql.NVarChar, emailNorm);
    aReq.input('FirstName', sql.NVarChar, fn);
    aReq.input('LastName', sql.NVarChar, ln);
    aReq.input('Phone', sql.NVarChar, phone);
    aReq.input('CreatedBy', sql.UniqueIdentifier, createdByUserId);
    aReq.input('CommissionTierLevel', TIER_SQL, effectiveTier);
    aReq.input('AgentCode', sql.NVarChar(50), agentCode);
    if (resolvedLevel && hybrid && hasTier.has('CommissionLevelId')) {
      aReq.input('CommissionLevelId', sql.UniqueIdentifier, resolvedLevel.CommissionLevelId);
    }

    const insertCols = [
      'AgentId',
      'UserId',
      'TenantId',
      'Status',
      'AgencyId',
      'Email',
      'FirstName',
      'LastName',
      'Phone',
      'AgentCode',
      'CreatedDate',
      'ModifiedDate',
      'CreatedBy',
      'ModifiedBy'
    ];
    const insertVals = [
      '@AgentId',
      '@UserId',
      '@TenantId',
      "N'Active'",
      '@AgencyId',
      '@Email',
      '@FirstName',
      '@LastName',
      '@Phone',
      '@AgentCode',
      'GETUTCDATE()',
      'GETUTCDATE()',
      '@CreatedBy',
      '@CreatedBy'
    ];
    if (hasTier.has('CommissionTierLevel')) {
      insertCols.push('CommissionTierLevel');
      insertVals.push('@CommissionTierLevel');
    }
    if (resolvedLevel && hybrid && hasTier.has('CommissionLevelId')) {
      insertCols.push('CommissionLevelId');
      insertVals.push('@CommissionLevelId');
    }

    await aReq.query(
      `INSERT INTO oe.Agents (${insertCols.join(', ')}) VALUES (${insertVals.join(', ')})`
    );

    await transaction.commit();
  } catch (e) {
    try {
      await transaction.rollback();
    } catch (_r) {
      /* ignore */
    }
    throw e;
  }

  await UserRolesService.assignRoleToUser(userId, 'Agent', createdByUserId);
  await agencyAdmins.appendAgencyAdmin(pool, targetAgencyId, agentId, tenantId);
  await agencyAdmins.ensureAgencyOwnerRolesForAgency(pool, targetAgencyId, createdByUserId);

  return {
    userId,
    agentId,
    email: emailNorm,
    existingUser: true,
    reusedExistingAgent: false,
    addedAgencyAdminOnly: false
  };
}

/**
 * @param {import('mssql').ConnectionPool} pool
 * @param {object} opts
 */
async function duplicateAgentAsAgencyAdmin(pool, opts) {
  const {
    tenantId,
    targetAgencyId,
    sourceAgentId,
    targetEmail,
    copyPasswordHash = false,
    sendWelcomeEmail = true,
    createdByUserId,
    baseUrl
  } = opts;

  const emailNorm = normalizeEmail(targetEmail);
  if (!emailNorm || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm)) {
    const err = new Error('A valid target email is required.');
    err.statusCode = 400;
    throw err;
  }

  const agencyCheck = await pool.request()
    .input('AgencyId', sql.UniqueIdentifier, targetAgencyId)
    .input('TenantId', sql.UniqueIdentifier, tenantId)
    .query(`SELECT AgencyId FROM oe.Agencies WHERE AgencyId = @AgencyId AND TenantId = @TenantId AND Status = N'Active'`);
  if (agencyCheck.recordset.length === 0) {
    const err = new Error('Agency not found or access denied.');
    err.statusCode = 404;
    throw err;
  }

  const srcReq = await pool.request()
    .input('AgentId', sql.UniqueIdentifier, sourceAgentId)
    .input('TenantId', sql.UniqueIdentifier, tenantId)
    .query(`
      SELECT TOP 1
        a.AgentId AS SourceAgentId,
        a.UserId AS SourceUserId,
        a.AgencyId AS SourceAgencyId,
        u.Email AS SourceEmail
      FROM oe.Agents a
      INNER JOIN oe.Users u ON u.UserId = a.UserId
      WHERE a.AgentId = @AgentId AND a.TenantId = @TenantId AND a.Status = N'Active'
    `);
  if (srcReq.recordset.length === 0) {
    const err = new Error('Source agent not found in this tenant.');
    err.statusCode = 404;
    throw err;
  }
  const { SourceUserId, SourceAgencyId } = srcReq.recordset[0];

  // If an account with this email already exists we have two outcomes:
  //   - If that user is already an active agent → reject, ask for a different email.
  //   - If that user exists but has no active oe.Agents row → attach a new agent
  //     record to their existing user (do NOT modify the existing user's name / email
  //     / password / phone / etc.). This is what the product owner asked for when
  //     duplicating from an existing agent.
  const existingUserReq = await pool.request()
    .input('Email', sql.NVarChar, emailNorm)
    .query(`
      SELECT TOP 1 UserId, FirstName
      FROM oe.Users
      WHERE LOWER(LTRIM(RTRIM(Email))) = @Email
    `);
  const existingUserRow = existingUserReq.recordset[0] || null;
  let reuseExistingUser = false;
  if (existingUserRow) {
    const existingAgentReq = await pool.request()
      .input('UserId', sql.UniqueIdentifier, existingUserRow.UserId)
      .input('TenantId', sql.UniqueIdentifier, tenantId)
      .query(`
        SELECT TOP 1 AgentId
        FROM oe.Agents
        WHERE UserId = @UserId AND TenantId = @TenantId AND Status = N'Active'
      `);
    if (existingAgentReq.recordset.length > 0) {
      const err = new Error('This email is already used by an existing agent. Please use a different email.');
      err.statusCode = 409;
      throw err;
    }
    reuseExistingUser = true;
  }

  const newUserId = reuseExistingUser ? existingUserRow.UserId : uuidv4();
  const newAgentId = uuidv4();
  const resetToken = uuidv4();
  const resetExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const transaction = pool.transaction();
  await transaction.begin();
  try {
    // Use the canonical AgentCode generator. Behavior of agent duplication is
    // otherwise unchanged — the new agent record gets a regular sequential code
    // just like any newly-created agent. Old DUP-prefixed codes (4 in prod as of
    // 2026-05-07) are replaced by the backfill in this same release.
    const agentCode = await generateAgentCode(transaction, tenantId);
    if (!reuseExistingUser) {
      const insUser = transaction.request();
      insUser.input('NewUserId', sql.UniqueIdentifier, newUserId);
      insUser.input('TargetEmail', sql.NVarChar, emailNorm);
      insUser.input('SourceUserId', sql.UniqueIdentifier, SourceUserId);
      insUser.input('CopyPwd', sql.Bit, copyPasswordHash ? 1 : 0);
      insUser.input('ResetToken', sql.NVarChar, resetToken);
      insUser.input('ResetExpiry', sql.DateTime2, resetExpiry);
      insUser.input('CreatedBy', sql.UniqueIdentifier, createdByUserId);

      await insUser.query(`
      INSERT INTO oe.Users (
        UserId,
        Email,
        PasswordHash,
        FirstName,
        LastName,
        UserType,
        Status,
        TenantId,
        PhoneNumber,
        LastLoginDate,
        MfaEnabled,
        ResetPasswordToken,
        ResetPasswordExpiry,
        UserSettings,
        CreatedDate,
        ModifiedDate,
        CreatedBy,
        ModifiedBy,
        Phone,
        Roles,
        TerminationDate,
        TenantAdminLink,
        TenantAdminLinkCreateDate,
        VendorId,
        AdditionalTenants,
        ProfileImageUrl
      )
      SELECT
        @NewUserId,
        @TargetEmail,
        CASE WHEN @CopyPwd = 1 THEN u.PasswordHash ELSE NULL END,
        u.FirstName,
        u.LastName,
        u.UserType,
        u.Status,
        u.TenantId,
        u.PhoneNumber,
        u.LastLoginDate,
        u.MfaEnabled,
        CASE
          WHEN @CopyPwd = 1 THEN u.ResetPasswordToken
          ELSE @ResetToken
        END,
        CASE
          WHEN @CopyPwd = 1 THEN u.ResetPasswordExpiry
          ELSE @ResetExpiry
        END,
        u.UserSettings,
        GETUTCDATE(),
        GETUTCDATE(),
        @CreatedBy,
        @CreatedBy,
        u.Phone,
        u.Roles,
        u.TerminationDate,
        u.TenantAdminLink,
        u.TenantAdminLinkCreateDate,
        u.VendorId,
        u.AdditionalTenants,
        u.ProfileImageUrl
      FROM oe.Users u
      WHERE u.UserId = @SourceUserId
    `);
    }

    const insAgent = transaction.request();
    insAgent.input('NewAgentId', sql.UniqueIdentifier, newAgentId);
    insAgent.input('NewUserId', sql.UniqueIdentifier, newUserId);
    insAgent.input('TargetAgencyId', sql.UniqueIdentifier, targetAgencyId);
    insAgent.input('TargetEmail', sql.NVarChar, emailNorm);
    insAgent.input('SourceAgentId', sql.UniqueIdentifier, sourceAgentId);
    insAgent.input('CreatedBy', sql.UniqueIdentifier, createdByUserId);
    insAgent.input('AgentCode', sql.NVarChar, agentCode);

    await insAgent.query(`
      INSERT INTO oe.Agents (
        AgentId,
        UserId,
        TenantId,
        Status,
        CommissionTier,
        CommissionSettings,
        CreatedDate,
        ModifiedDate,
        CreatedBy,
        ModifiedBy,
        AgencyId,
        AgentCode,
        AgentType,
        ContractStartDate,
        ContractEndDate,
        NPN,
        Phone,
        Email,
        FirstName,
        LastName,
        Address1,
        Address2,
        City,
        State,
        CommissionRole,
        ZipCode,
        IDType,
        SSNOrTaxID,
        BusinessName,
        CommissionRuleId,
        CommissionRuleModified,
        AdvanceMonths,
        CommissionTierLevel,
        CommissionGroupId,
        CommissionLevelId
      )
      SELECT
        @NewAgentId,
        @NewUserId,
        a.TenantId,
        a.Status,
        a.CommissionTier,
        a.CommissionSettings,
        GETUTCDATE(),
        GETUTCDATE(),
        @CreatedBy,
        @CreatedBy,
        @TargetAgencyId,
        @AgentCode,
        a.AgentType,
        a.ContractStartDate,
        a.ContractEndDate,
        a.NPN,
        a.Phone,
        @TargetEmail,
        a.FirstName,
        a.LastName,
        a.Address1,
        a.Address2,
        a.City,
        a.State,
        a.CommissionRole,
        a.ZipCode,
        a.IDType,
        a.SSNOrTaxID,
        a.BusinessName,
        CASE WHEN a.AgencyId <> @TargetAgencyId THEN NULL ELSE a.CommissionRuleId END,
        CASE WHEN a.AgencyId <> @TargetAgencyId THEN NULL ELSE a.CommissionRuleModified END,
        a.AdvanceMonths,
        a.CommissionTierLevel,
        CASE WHEN a.AgencyId <> @TargetAgencyId THEN NULL ELSE a.CommissionGroupId END,
        a.CommissionLevelId
      FROM oe.Agents a
      WHERE a.AgentId = @SourceAgentId
    `);

    await transaction.request()
      .input('NewAgentId', sql.UniqueIdentifier, newAgentId)
      .input('SourceAgentId', sql.UniqueIdentifier, sourceAgentId)
      .query(`
        INSERT INTO oe.AgentBankInfo (
          BankInfoId,
          AgentId,
          BankName,
          AccountName,
          AccountType,
          AccountHolderType,
          RoutingNumber,
          AccountNumberEncrypted,
          AccountNumberLast4,
          Status,
          IsDefault,
          VerificationStatus,
          VerificationDate,
          CreatedDate,
          ModifiedDate,
          CreatedBy,
          ModifiedBy
        )
        SELECT
          NEWID(),
          @NewAgentId,
          b.BankName,
          b.AccountName,
          b.AccountType,
          b.AccountHolderType,
          b.RoutingNumber,
          b.AccountNumberEncrypted,
          b.AccountNumberLast4,
          b.Status,
          b.IsDefault,
          b.VerificationStatus,
          b.VerificationDate,
          b.CreatedDate,
          b.ModifiedDate,
          b.CreatedBy,
          b.ModifiedBy
        FROM oe.AgentBankInfo b
        WHERE b.AgentId = @SourceAgentId
      `);

    await transaction.request()
      .input('NewAgentId', sql.UniqueIdentifier, newAgentId)
      .input('SourceAgentId', sql.UniqueIdentifier, sourceAgentId)
      .query(`
        INSERT INTO oe.AgentDocuments (
          DocumentId,
          AgentId,
          DocumentType,
          FileName,
          FileUrl,
          FileSize,
          FileType,
          Description,
          Status,
          CreatedDate,
          ModifiedDate,
          CreatedBy,
          ModifiedBy
        )
        SELECT
          NEWID(),
          @NewAgentId,
          d.DocumentType,
          d.FileName,
          d.FileUrl,
          d.FileSize,
          d.FileType,
          d.Description,
          d.Status,
          d.CreatedDate,
          d.ModifiedDate,
          d.CreatedBy,
          d.ModifiedBy
        FROM oe.AgentDocuments d
        WHERE d.AgentId = @SourceAgentId
      `);

    await transaction.request()
      .input('NewAgentId', sql.UniqueIdentifier, newAgentId)
      .input('SourceAgentId', sql.UniqueIdentifier, sourceAgentId)
      .query(`
        INSERT INTO oe.AgentLicenses (
          LicenseId,
          AgentId,
          StateCode,
          LicenseNumber,
          LicenseType,
          ExpirationDate,
          IssueDate,
          Status,
          UploadedDocumentUrl,
          CreatedDate,
          ModifiedDate,
          CreatedBy,
          ModifiedBy,
          EffectiveDate,
          ResidencyType,
          LOAIssueDate,
          CompanyAppointmentDate,
          RenewalDate
        )
        SELECT
          NEWID(),
          @NewAgentId,
          l.StateCode,
          l.LicenseNumber,
          l.LicenseType,
          l.ExpirationDate,
          l.IssueDate,
          l.Status,
          l.UploadedDocumentUrl,
          l.CreatedDate,
          l.ModifiedDate,
          l.CreatedBy,
          l.ModifiedBy,
          l.EffectiveDate,
          l.ResidencyType,
          l.LOAIssueDate,
          l.CompanyAppointmentDate,
          l.RenewalDate
        FROM oe.AgentLicenses l
        WHERE l.AgentId = @SourceAgentId
      `);

    await transaction.commit();
  } catch (e) {
    try {
      await transaction.rollback();
    } catch (_r) {
      /* ignore */
    }
    throw e;
  }

  await UserRolesService.assignRoleToUser(newUserId, 'Agent', createdByUserId);
  await agencyAdmins.appendAgencyAdmin(pool, targetAgencyId, newAgentId, tenantId);
  await agencyAdmins.ensureAgencyOwnerRolesForAgency(pool, targetAgencyId, createdByUserId);

  let passwordSetupLink = null;
  // If we reused an existing oe.Users row the user already has a login; skip
  // the password-setup link and welcome email entirely.
  if (!reuseExistingUser && !copyPasswordHash && baseUrl) {
    passwordSetupLink = `${baseUrl.replace(/\/$/, '')}/setup-password/${resetToken}`;
  }

  if (!reuseExistingUser && sendWelcomeEmail && passwordSetupLink && !copyPasswordHash) {
    try {
      const nameReq = await pool.request()
        .input('UserId', sql.UniqueIdentifier, newUserId)
        .query(`SELECT FirstName FROM oe.Users WHERE UserId = @UserId`);
      const firstName = nameReq.recordset[0]?.FirstName || 'there';
      await MessageQueueService.sendUserWelcome({
        tenantId,
        userId: newUserId,
        userEmail: emailNorm,
        firstName,
        userType: 'Agent',
        setupUrl: passwordSetupLink,
        createdBy: createdByUserId
      });
    } catch (emailErr) {
      console.error('duplicateAgentAsAgencyAdmin: welcome email failed', emailErr);
    }
  }

  return {
    userId: newUserId,
    agentId: newAgentId,
    email: emailNorm,
    passwordSetupLink: passwordSetupLink || undefined,
    copiedFromAgencyId: SourceAgencyId,
    reusedExistingUser: reuseExistingUser
  };
}

/**
 * @param {import('mssql').ConnectionPool} pool
 * @param {object} opts
 */
async function inviteAgentAsAgencyAdmin(pool, opts) {
  const {
    tenantId,
    targetAgencyId,
    targetEmail,
    firstName,
    lastName,
    phoneNumber,
    commissionLevelId,
    sendWelcomeEmail = true,
    createdByUserId,
    baseUrl
  } = opts;

  const emailNorm = normalizeEmail(targetEmail);
  if (!emailNorm || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm)) {
    const err = new Error('A valid email is required.');
    err.statusCode = 400;
    throw err;
  }
  if (!String(firstName || '').trim() || !String(lastName || '').trim()) {
    const err = new Error('First name and last name are required.');
    err.statusCode = 400;
    throw err;
  }

  const flags = await CommissionLevelService.getTenantFlags(tenantId);
  const hybrid = GLOBAL_COMMISSION_LEVELS_HYBRID_ENABLED && flags.commissionLevelsHybridEnabled;
  const useCustomOnly = flags.useCustomCommissionLevelsOnly;
  let resolvedLevel = null;
  if (commissionLevelId) {
    resolvedLevel = await validateCommissionLevelId(tenantId, commissionLevelId);
  } else if (useCustomOnly) {
    const err = new Error('CommissionLevelId is required for this tenant.');
    err.statusCode = 400;
    throw err;
  }

  const agencyCheck = await pool.request()
    .input('AgencyId', sql.UniqueIdentifier, targetAgencyId)
    .input('TenantId', sql.UniqueIdentifier, tenantId)
    .query(`SELECT AgencyId FROM oe.Agencies WHERE AgencyId = @AgencyId AND TenantId = @TenantId AND Status = N'Active'`);
  if (agencyCheck.recordset.length === 0) {
    const err = new Error('Agency not found or access denied.');
    err.statusCode = 404;
    throw err;
  }

  const userId = uuidv4();
  const agentId = uuidv4();
  const resetToken = uuidv4();
  const resetExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const fn = String(firstName).trim();
  const ln = String(lastName).trim();

  const transaction = pool.transaction();
  await transaction.begin();
  try {
    const uReq = transaction.request();
    uReq.input('UserId', sql.UniqueIdentifier, userId);
    uReq.input('Email', sql.NVarChar, emailNorm);
    uReq.input('FirstName', sql.NVarChar, fn);
    uReq.input('LastName', sql.NVarChar, ln);
    uReq.input('PhoneNumber', sql.NVarChar, phoneNumber ? String(phoneNumber).trim() : null);
    uReq.input('TenantId', sql.UniqueIdentifier, tenantId);
    uReq.input('CreatedBy', sql.UniqueIdentifier, createdByUserId);
    uReq.input('ResetToken', sql.NVarChar, resetToken);
    uReq.input('ResetExpiry', sql.DateTime2, resetExpiry);

    await uReq.query(`
      INSERT INTO oe.Users (
        UserId,
        Email,
        FirstName,
        LastName,
        PhoneNumber,
        TenantId,
        Status,
        CreatedDate,
        ModifiedDate,
        CreatedBy,
        ModifiedBy,
        MfaEnabled,
        ResetPasswordToken,
        ResetPasswordExpiry
      ) VALUES (
        @UserId,
        @Email,
        @FirstName,
        @LastName,
        @PhoneNumber,
        @TenantId,
        N'Active',
        GETUTCDATE(),
        GETUTCDATE(),
        @CreatedBy,
        @CreatedBy,
        0,
        @ResetToken,
        @ResetExpiry
      )
    `);

    const tierCols = await transaction.request().query(`
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = 'oe'
        AND TABLE_NAME = 'Agents'
        AND COLUMN_NAME IN ('CommissionTierLevel', 'CommissionLevelId')
    `);
    const hasTier = new Set((tierCols.recordset || []).map((r) => r.COLUMN_NAME));

    const agentCode = await generateAgentCode(transaction, tenantId);
    const aReq = transaction.request();
    aReq.input('AgentId', sql.UniqueIdentifier, agentId);
    aReq.input('UserId', sql.UniqueIdentifier, userId);
    aReq.input('TenantId', sql.UniqueIdentifier, tenantId);
    aReq.input('AgencyId', sql.UniqueIdentifier, targetAgencyId);
    aReq.input('Email', sql.NVarChar, emailNorm);
    aReq.input('FirstName', sql.NVarChar, fn);
    aReq.input('LastName', sql.NVarChar, ln);
    aReq.input('Phone', sql.NVarChar, phoneNumber ? String(phoneNumber).trim() : null);
    aReq.input('CreatedBy', sql.UniqueIdentifier, createdByUserId);
    aReq.input('AgentCode', sql.NVarChar(50), agentCode);

    const effectiveTier = resolvedLevel ? Number(resolvedLevel.SortOrder) : 1;
    aReq.input('CommissionTierLevel', TIER_SQL, effectiveTier);
    if (resolvedLevel && hybrid && hasTier.has('CommissionLevelId')) {
      aReq.input('CommissionLevelId', sql.UniqueIdentifier, resolvedLevel.CommissionLevelId);
    }

    const insertCols = [
      'AgentId',
      'UserId',
      'TenantId',
      'Status',
      'AgencyId',
      'Email',
      'FirstName',
      'LastName',
      'Phone',
      'AgentCode',
      'CreatedDate',
      'ModifiedDate',
      'CreatedBy',
      'ModifiedBy'
    ];
    const insertVals = [
      '@AgentId',
      '@UserId',
      '@TenantId',
      "N'Active'",
      '@AgencyId',
      '@Email',
      '@FirstName',
      '@LastName',
      '@Phone',
      '@AgentCode',
      'GETUTCDATE()',
      'GETUTCDATE()',
      '@CreatedBy',
      '@CreatedBy'
    ];
    if (hasTier.has('CommissionTierLevel')) {
      insertCols.push('CommissionTierLevel');
      insertVals.push('@CommissionTierLevel');
    }
    if (resolvedLevel && hybrid && hasTier.has('CommissionLevelId')) {
      insertCols.push('CommissionLevelId');
      insertVals.push('@CommissionLevelId');
    }

    await aReq.query(
      `INSERT INTO oe.Agents (${insertCols.join(', ')}) VALUES (${insertVals.join(', ')})`
    );

    await transaction.commit();
  } catch (e) {
    try {
      await transaction.rollback();
    } catch (_r) {
      /* ignore */
    }
    throw e;
  }

  await UserRolesService.assignRoleToUser(userId, 'Agent', createdByUserId);
  await agencyAdmins.appendAgencyAdmin(pool, targetAgencyId, agentId, tenantId);
  await agencyAdmins.ensureAgencyOwnerRolesForAgency(pool, targetAgencyId, createdByUserId);

  let passwordSetupLink = null;
  if (baseUrl) {
    passwordSetupLink = `${baseUrl.replace(/\/$/, '')}/setup-password/${resetToken}`;
  }

  if (sendWelcomeEmail && passwordSetupLink) {
    try {
      await MessageQueueService.sendUserWelcome({
        tenantId,
        userId,
        userEmail: emailNorm,
        firstName: fn,
        userType: 'Agent',
        setupUrl: passwordSetupLink,
        createdBy: createdByUserId
      });
    } catch (emailErr) {
      console.error('inviteAgentAsAgencyAdmin: welcome email failed', emailErr);
    }
  }

  return {
    userId,
    agentId,
    email: emailNorm,
    passwordSetupLink: passwordSetupLink || undefined
  };
}

module.exports = {
  duplicateAgentAsAgencyAdmin,
  inviteAgentAsAgencyAdmin,
  addExistingUserAsAgencyAdmin
};
