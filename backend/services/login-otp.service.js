'use strict';

const crypto = require('crypto');
const { getPool, sql } = require('../config/database');
const {
  HAS_LOGIN_ELIGIBLE_ENROLLMENT_SQL,
} = require('../utils/memberEnrollmentStatusSql');
const {
  userCanCompleteAb365MemberLogin,
} = require('./mobileAb365LoginEligibility.service');
const {
  buildPhoneNumberVariants,
  normalizeEmail,
  looksLikeEmail,
} = require('../utils/phoneNumberVariants');
const UserRolesService = require('./shared/user-roles.service');
const { createSessionTokensForUser } = require('./auth-session.service');
const { sendLoginOtpEmail, sendLoginOtpSms, isSyntheticEmail } = require('./login-otp-mailer');
const { getTenantMessagingCredentials } = require('./tenant-messaging-credentials.service');
const { activateUserAfterSuccessfulLogin } = require('./activateUserAfterLogin.service');
const { getLoginMetadataForUser } = require('./memberHouseholdLoginContext.service');

const CODE_EXPIRY_MINUTES = 10;
/** Users who can request/verify OTP before first password setup (activated on successful verify). */
const OTP_ELIGIBLE_USER_STATUS_SQL = "u.Status IN (N'Active', N'Pending', N'Pending Payment')";
const MAX_ATTEMPTS = 12;
const MAX_SENDS_PER_HOUR = 10;
const MIN_RESEND_INTERVAL_SECONDS = 60;
const GENERIC_SUCCESS_MESSAGE =
  'If we found an account matching that information, we sent a verification code.';

function hashCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

function generateNumericCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function maskEmail(email) {
  if (!email) return '';
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  const vis = local.length <= 2 ? '*' : local[0] + '***';
  return `${vis}@${domain}`;
}

function maskPhone(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.length < 4) return '***';
  return `***${d.slice(-4)}`;
}

function normalizeHouseholdMemberIdInput(raw) {
  return String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
}

/** True when the user's stored phone matches any normalized variant from the login form. */
function userPhoneMatches(user, phoneVariants) {
  if (!phoneVariants?.length || !user?.PhoneNumber) return false;
  const stored = buildPhoneNumberVariants(user.PhoneNumber);
  return phoneVariants.some((p) => stored.includes(p));
}

function bindPhoneVariantInputs(request, phoneVariants, prefix = 'p') {
  const conditions = phoneVariants.map((_, i) => {
    request.input(`${prefix}${i}`, sql.NVarChar, phoneVariants[i]);
    return `@${prefix}${i}`;
  });
  return conditions;
}

/** Primary login user when a spouse in the same household has the given phone on their user record. */
async function userHasHouseholdSpousePhoneMatch(userId, phoneVariants) {
  if (!phoneVariants?.length) return false;
  const pool = await getPool();
  const request = pool.request().input('userId', sql.UniqueIdentifier, userId);
  const binds = bindPhoneVariantInputs(request, phoneVariants, 'sp');
  const result = await request.query(`
    SELECT TOP 1 1 AS ok
    FROM oe.Members pm
    INNER JOIN oe.Members sm ON sm.HouseholdId = pm.HouseholdId
      AND sm.RelationshipType = 'S'
      AND sm.Status != 'Terminated'
    INNER JOIN oe.Users su ON su.UserId = sm.UserId
    WHERE pm.UserId = @userId
      AND pm.RelationshipType = 'P'
      AND pm.Status != 'Terminated'
      AND su.Status IN (N'Active', N'Pending', N'Pending Payment')
      AND (su.PhoneNumber = ${binds.join(' OR su.PhoneNumber = ')})
  `);
  return result.recordset.length > 0;
}

/** Primary login user when a spouse in the same household has the given email on their user record. */
async function userHasHouseholdSpouseEmailMatch(userId, emailNorm) {
  if (!emailNorm) return false;
  const pool = await getPool();
  const result = await pool.request()
    .input('userId', sql.UniqueIdentifier, userId)
    .input('email', sql.NVarChar, emailNorm)
    .query(`
      SELECT TOP 1 1 AS ok
      FROM oe.Members pm
      INNER JOIN oe.Members sm ON sm.HouseholdId = pm.HouseholdId
        AND sm.RelationshipType = 'S'
        AND sm.Status != 'Terminated'
      INNER JOIN oe.Users su ON su.UserId = sm.UserId
      WHERE pm.UserId = @userId
        AND pm.RelationshipType = 'P'
        AND pm.Status != 'Terminated'
        AND su.Status IN (N'Active', N'Pending', N'Pending Payment')
        AND LOWER(su.Email) = @email
    `);
  return result.recordset.length > 0;
}

async function userPhoneOrHouseholdSpousePhoneMatches(user, phoneVariants) {
  return userPhoneMatches(user, phoneVariants) || (await userHasHouseholdSpousePhoneMatch(user.UserId, phoneVariants));
}

/** `mobile` = MightyWell app (members only). `portal` = AllAboard365 web (all roles). */
function normalizeClient(body) {
  const raw = String(body?.client || body?.audience || 'mobile').toLowerCase();
  return raw === 'portal' ? 'portal' : 'mobile';
}

async function findPortalUsersByEmail(emailNorm) {
  const pool = await getPool();
  const result = await pool.request()
    .input('email', sql.NVarChar, emailNorm)
    .query(`
      SELECT u.UserId, u.Email, u.FirstName, u.LastName, u.PhoneNumber, u.TenantId, u.Status
      FROM oe.Users u
      WHERE ${OTP_ELIGIBLE_USER_STATUS_SQL} AND LOWER(u.Email) = @email
      UNION
      SELECT pu.UserId, pu.Email, pu.FirstName, pu.LastName, pu.PhoneNumber, pu.TenantId, pu.Status
      FROM oe.Users pu
      INNER JOIN oe.Members pm ON pm.UserId = pu.UserId AND pm.RelationshipType = 'P' AND pm.Status != 'Terminated'
      INNER JOIN oe.Members sm ON sm.HouseholdId = pm.HouseholdId AND sm.RelationshipType = 'S' AND sm.Status != 'Terminated'
      INNER JOIN oe.Users su ON su.UserId = sm.UserId
      WHERE ${OTP_ELIGIBLE_USER_STATUS_SQL.replace(/u\./g, 'pu.')}
        AND su.Status IN (N'Active', N'Pending', N'Pending Payment')
        AND LOWER(su.Email) = @email
    `);
  return result.recordset;
}

async function findPortalUsersByPhone(phoneVariants) {
  if (!phoneVariants.length) return [];
  const pool = await getPool();
  const request = pool.request();
  const binds = bindPhoneVariantInputs(request, phoneVariants, 'p');
  const spouseBinds = bindPhoneVariantInputs(request, phoneVariants, 'sp');
  const result = await request.query(`
    SELECT DISTINCT u.UserId, u.Email, u.FirstName, u.LastName, u.PhoneNumber, u.TenantId, u.Status
    FROM oe.Users u
    WHERE ${OTP_ELIGIBLE_USER_STATUS_SQL} AND (u.PhoneNumber = ${binds.join(' OR u.PhoneNumber = ')})
    UNION
    SELECT DISTINCT pu.UserId, pu.Email, pu.FirstName, pu.LastName, pu.PhoneNumber, pu.TenantId, pu.Status
    FROM oe.Users pu
    INNER JOIN oe.Members pm ON pm.UserId = pu.UserId AND pm.RelationshipType = 'P' AND pm.Status != 'Terminated'
    INNER JOIN oe.Members sm ON sm.HouseholdId = pm.HouseholdId AND sm.RelationshipType = 'S' AND sm.Status != 'Terminated'
    INNER JOIN oe.Users su ON su.UserId = sm.UserId
    WHERE ${OTP_ELIGIBLE_USER_STATUS_SQL.replace(/u\./g, 'pu.')}
      AND su.Status IN (N'Active', N'Pending', N'Pending Payment')
      AND (su.PhoneNumber = ${spouseBinds.join(' OR su.PhoneNumber = ')})
  `);
  return result.recordset;
}

async function userHasActiveMemberEnrollment(userId) {
  const pool = await getPool();
  const result = await pool.request()
    .input('userId', sql.UniqueIdentifier, userId)
    .query(`
      SELECT TOP 1 1 AS ok
      FROM oe.Members m
      WHERE m.UserId = @userId
        AND m.Status != 'Terminated'
        AND ${HAS_LOGIN_ELIGIBLE_ENROLLMENT_SQL}
    `);
  return result.recordset.length > 0;
}

/** E123 import staging — mobile should use ShareWELL legacy OTP/data, not AB365 OTP. */
function pendingMigrationDeferResponse(client) {
  // Mobile app (already shipped) falls back to ShareWELL legacy OTP only on not_found.
  // Do not expose pending_migration to clients — handle entirely on this endpoint.
  return {
    success: false,
    codeSent: false,
    failureReason: 'not_found',
    message:
      client === 'portal'
        ? "We couldn't find an active account with that email or phone number."
        : "We couldn't find an active account with that email or phone number. Check your entry or sign in with password.",
  };
}

/** Mobile AB365 OTP/password: member with linked row and not pending-migration staging. */
async function filterMobileAb365EligibleUsers(users) {
  const kept = [];
  for (const u of users) {
    if (await userCanCompleteAb365MemberLogin(u.UserId)) {
      kept.push(u);
    }
  }
  return kept;
}

async function filterUsersWithRoles(users) {
  const out = [];
  for (const u of users) {
    const roles = await UserRolesService.getUserRoleNames(u.UserId);
    if (roles.length) out.push(u);
  }
  return out;
}

async function buildPortalAccountChoiceLabel(user) {
  const roles = await UserRolesService.getUserRoleNames(user.UserId);
  const roleLabel = roles.length ? roles.join(', ') : 'User';
  const name =
    `${user.FirstName || ''} ${user.LastName || ''}`.trim() || maskEmail(user.Email);
  return `${name} (${roleLabel})`;
}

/**
 * Portal duplicates: prefer the login with an active member enrollment; otherwise ask user to choose.
 */
async function resolvePortalDuplicateUsers(users) {
  const scored = await Promise.all(
    users.map(async (user) => ({
      user,
      hasMember: await userHasActiveMemberEnrollment(user.UserId),
    }))
  );
  const withMember = scored.filter((s) => s.hasMember).map((s) => s.user);
  if (withMember.length === 1) {
    return { single: withMember[0], choices: null };
  }
  if (withMember.length > 1) {
    const picked = await pickSingleUserByEnrollment(withMember);
    if (picked) return { single: picked, choices: null };
    return { single: null, choices: withMember };
  }
  return { single: null, choices: scored.map((s) => s.user) };
}

async function resolvePortalUserByHouseholdMemberId(householdMemberId, phoneVariants, emailNorm) {
  const norm = normalizeHouseholdMemberIdInput(householdMemberId);
  if (!norm || norm.length < 4) return null;
  const pool = await getPool();
  const request = pool.request();
  request.input('hmid', sql.NVarChar, norm);

  let extraWhere = '';
  if (phoneVariants.length) {
    const hpBinds = bindPhoneVariantInputs(request, phoneVariants, 'hp');
    const spBinds = bindPhoneVariantInputs(request, phoneVariants, 'hsp');
    extraWhere = ` AND (
      u.PhoneNumber = ${hpBinds.join(' OR u.PhoneNumber = ')}
      OR EXISTS (
        SELECT 1
        FROM oe.Members sm
        INNER JOIN oe.Users su ON su.UserId = sm.UserId
        WHERE sm.HouseholdId = m.HouseholdId
          AND sm.RelationshipType = 'S'
          AND sm.Status != 'Terminated'
          AND su.Status IN (N'Active', N'Pending', N'Pending Payment')
          AND (su.PhoneNumber = ${spBinds.join(' OR su.PhoneNumber = ')})
      )
    )`;
  } else if (emailNorm) {
    request.input('email', sql.NVarChar, emailNorm);
    extraWhere = ` AND (
      LOWER(u.Email) = @email
      OR EXISTS (
        SELECT 1
        FROM oe.Members sm
        INNER JOIN oe.Users su ON su.UserId = sm.UserId
        WHERE sm.HouseholdId = m.HouseholdId
          AND sm.RelationshipType = 'S'
          AND sm.Status != 'Terminated'
          AND su.Status IN (N'Active', N'Pending', N'Pending Payment')
          AND LOWER(su.Email) = @email
      )
    )`;
  }

  const result = await request.query(`
    SELECT TOP 1 u.UserId, u.Email, u.FirstName, u.LastName, u.PhoneNumber, u.TenantId
    FROM oe.Members m
    INNER JOIN oe.Users u ON u.UserId = m.UserId
    LEFT JOIN oe.Tenants ten ON ten.TenantId = u.TenantId
    WHERE ${OTP_ELIGIBLE_USER_STATUS_SQL}
      AND m.Status != 'Terminated'
      AND (
        UPPER(REPLACE(ISNULL(m.HouseholdMemberID, ''), ' ', '')) = @hmid
        OR UPPER(REPLACE(CONCAT(ISNULL(ten.MemberIDPrefix, ''), ISNULL(m.HouseholdMemberID, '')), ' ', '')) = @hmid
        OR UPPER(REPLACE(CONCAT(ISNULL(ten.IndividualMemberIDPrefix, ''), ISNULL(m.HouseholdMemberID, '')), ' ', '')) = @hmid
      )
      ${extraWhere}
  `);
  return result.recordset[0] || null;
}

async function logOtpEvent(req, action, success, message, userId = null) {
  try {
    const pool = await getPool();
    await pool.request()
      .input('authLogId', sql.UniqueIdentifier, crypto.randomUUID())
      .input('userId', sql.UniqueIdentifier, userId)
      .input('email', sql.NVarChar, null)
      .input('action', sql.NVarChar, action)
      .input('success', sql.Bit, success ? 1 : 0)
      .input('message', sql.NVarChar, (message || '').slice(0, 500))
      .input('ipAddress', sql.NVarChar, req.ip || req.connection?.remoteAddress || null)
      .input('userAgent', sql.NVarChar, (req.get?.('User-Agent') || req.headers?.['user-agent'] || '').slice(0, 512))
      .query(`
        INSERT INTO oe.AuthLog (AuthLogId, UserId, Email, Action, Success, Message, IPAddress, UserAgent, CreatedAt)
        VALUES (@authLogId, @userId, @email, @action, @success, @message, @ipAddress, @userAgent, GETDATE())
      `);
  } catch (e) {
    console.warn('[login-otp] AuthLog failed:', e.message);
  }
}

/**
 * Users with login-eligible enrollment + Member role candidate.
 */
/**
 * Mobile: primary member login when identifier matches primary or household spouse user contact.
 */
async function findEligiblePrimaryUsersByPhone(phoneVariants) {
  if (!phoneVariants.length) return [];
  const pool = await getPool();
  const request = pool.request();
  const binds = bindPhoneVariantInputs(request, phoneVariants, 'p');
  const spouseBinds = bindPhoneVariantInputs(request, phoneVariants, 'sp');
  const result = await request.query(`
    SELECT DISTINCT
      u.UserId,
      u.Email,
      u.FirstName,
      u.LastName,
      u.PhoneNumber,
      u.TenantId,
      u.Status
    FROM oe.Users u
    INNER JOIN oe.Members m ON m.UserId = u.UserId AND m.RelationshipType = 'P'
    WHERE ${OTP_ELIGIBLE_USER_STATUS_SQL}
      AND m.Status != 'Terminated'
      AND ${HAS_LOGIN_ELIGIBLE_ENROLLMENT_SQL}
      AND (
        u.PhoneNumber = ${binds.join(' OR u.PhoneNumber = ')}
        OR EXISTS (
          SELECT 1
          FROM oe.Members sm
          INNER JOIN oe.Users su ON su.UserId = sm.UserId
          WHERE sm.HouseholdId = m.HouseholdId
            AND sm.RelationshipType = 'S'
            AND sm.Status != 'Terminated'
            AND su.Status IN (N'Active', N'Pending', N'Pending Payment')
            AND (su.PhoneNumber = ${spouseBinds.join(' OR su.PhoneNumber = ')})
        )
      )
  `);
  return result.recordset;
}

async function findEligiblePrimaryUsersByEmail(emailNorm) {
  const pool = await getPool();
  const result = await pool.request()
    .input('email', sql.NVarChar, emailNorm)
    .query(`
      SELECT DISTINCT
        u.UserId,
        u.Email,
        u.FirstName,
        u.LastName,
        u.PhoneNumber,
        u.TenantId,
        u.Status
      FROM oe.Users u
      INNER JOIN oe.Members m ON m.UserId = u.UserId AND m.RelationshipType = 'P'
      WHERE ${OTP_ELIGIBLE_USER_STATUS_SQL}
        AND m.Status != 'Terminated'
        AND ${HAS_LOGIN_ELIGIBLE_ENROLLMENT_SQL}
        AND (
          LOWER(u.Email) = @email
          OR EXISTS (
            SELECT 1
            FROM oe.Members sm
            INNER JOIN oe.Users su ON su.UserId = sm.UserId
            WHERE sm.HouseholdId = m.HouseholdId
              AND sm.RelationshipType = 'S'
              AND sm.Status != 'Terminated'
              AND su.Status IN (N'Active', N'Pending', N'Pending Payment')
              AND LOWER(su.Email) = @email
          )
        )
    `);
  return result.recordset;
}

async function findEligibleUsersByPhone(phoneVariants) {
  if (!phoneVariants.length) return [];
  const pool = await getPool();
  const request = pool.request();
  const binds = bindPhoneVariantInputs(request, phoneVariants, 'p');

  const result = await request.query(`
    SELECT DISTINCT
      u.UserId,
      u.Email,
      u.FirstName,
      u.LastName,
      u.PhoneNumber,
      u.TenantId,
      u.Status
    FROM oe.Users u
    INNER JOIN oe.Members m ON m.UserId = u.UserId
    WHERE ${OTP_ELIGIBLE_USER_STATUS_SQL}
      AND m.Status != 'Terminated'
      AND (u.PhoneNumber = ${binds.join(' OR u.PhoneNumber = ')})
      AND ${HAS_LOGIN_ELIGIBLE_ENROLLMENT_SQL}
  `);
  return result.recordset;
}

async function findEligibleUsersByEmail(emailNorm) {
  const pool = await getPool();
  const result = await pool.request()
    .input('email', sql.NVarChar, emailNorm)
    .query(`
      SELECT DISTINCT
        u.UserId,
        u.Email,
        u.FirstName,
        u.LastName,
        u.PhoneNumber,
        u.TenantId,
        u.Status
      FROM oe.Users u
      INNER JOIN oe.Members m ON m.UserId = u.UserId
      WHERE ${OTP_ELIGIBLE_USER_STATUS_SQL}
        AND LOWER(u.Email) = @email
        AND m.Status != 'Terminated'
        AND ${HAS_LOGIN_ELIGIBLE_ENROLLMENT_SQL}
    `);
  return result.recordset;
}

async function findMobileEligibleUsersByPhone(phoneVariants) {
  const primary = await findEligiblePrimaryUsersByPhone(phoneVariants);
  if (primary.length) return primary;
  return findEligibleUsersByPhone(phoneVariants);
}

async function findMobileEligibleUsersByEmail(emailNorm) {
  const primary = await findEligiblePrimaryUsersByEmail(emailNorm);
  if (primary.length) return primary;
  return findEligibleUsersByEmail(emailNorm);
}

async function filterMemberRoleUsers(users) {
  const out = [];
  for (const u of users) {
    const roles = await UserRolesService.getUserRoleNames(u.UserId);
    if (roles.includes('Member')) {
      out.push({ ...u, roles });
    }
  }
  return out;
}

/**
 * Tie-break: primary member with latest active enrollment effective date.
 */
async function pickSingleUserByEnrollment(users) {
  if (users.length <= 1) return users[0] || null;
  const pool = await getPool();
  let best = null;
  let bestDate = null;
  for (const u of users) {
    const r = await pool.request()
      .input('userId', sql.UniqueIdentifier, u.UserId)
      .query(`
        SELECT TOP 1 e.EffectiveDate, m.RelationshipType
        FROM oe.Members m
        INNER JOIN oe.Enrollments e ON e.MemberId = m.MemberId
        WHERE m.UserId = @userId
          AND m.RelationshipType = 'P'
          AND e.Status IN ('Active', 'Pending', 'PaymentHold', 'Pending Payment')
          AND (
            (e.EffectiveDate <= GETUTCDATE() AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE()))
            OR e.EffectiveDate > GETUTCDATE()
          )
        ORDER BY e.EffectiveDate DESC
      `);
    const row = r.recordset[0];
    if (!row) continue;
    const d = new Date(row.EffectiveDate).getTime();
    if (bestDate == null || d > bestDate) {
      bestDate = d;
      best = u;
    }
  }
  return best;
}

async function resolveUserByHouseholdMemberId(householdMemberId, phoneVariants, emailNorm) {
  const norm = normalizeHouseholdMemberIdInput(householdMemberId);
  if (!norm || norm.length < 4) return null;
  const pool = await getPool();
  const request = pool.request();
  request.input('hmid', sql.NVarChar, norm);

  let extraWhere = '';
  if (phoneVariants.length) {
    const hpBinds = bindPhoneVariantInputs(request, phoneVariants, 'hp');
    const spBinds = bindPhoneVariantInputs(request, phoneVariants, 'hsp');
    extraWhere = ` AND (
      u.PhoneNumber = ${hpBinds.join(' OR u.PhoneNumber = ')}
      OR EXISTS (
        SELECT 1
        FROM oe.Members sm
        INNER JOIN oe.Users su ON su.UserId = sm.UserId
        WHERE sm.HouseholdId = m.HouseholdId
          AND sm.RelationshipType = 'S'
          AND sm.Status != 'Terminated'
          AND su.Status IN (N'Active', N'Pending', N'Pending Payment')
          AND (su.PhoneNumber = ${spBinds.join(' OR su.PhoneNumber = ')})
      )
    )`;
  } else if (emailNorm) {
    request.input('email', sql.NVarChar, emailNorm);
    extraWhere = ` AND (
      LOWER(u.Email) = @email
      OR EXISTS (
        SELECT 1
        FROM oe.Members sm
        INNER JOIN oe.Users su ON su.UserId = sm.UserId
        WHERE sm.HouseholdId = m.HouseholdId
          AND sm.RelationshipType = 'S'
          AND sm.Status != 'Terminated'
          AND su.Status IN (N'Active', N'Pending', N'Pending Payment')
          AND LOWER(su.Email) = @email
      )
    )`;
  }

  const result = await request.query(`
    SELECT TOP 1 u.UserId, u.Email, u.FirstName, u.LastName, u.PhoneNumber, u.TenantId
    FROM oe.Members m
    INNER JOIN oe.Users u ON u.UserId = m.UserId
    LEFT JOIN oe.Tenants ten ON ten.TenantId = u.TenantId
    WHERE ${OTP_ELIGIBLE_USER_STATUS_SQL}
      AND m.Status != 'Terminated'
      AND ${HAS_LOGIN_ELIGIBLE_ENROLLMENT_SQL}
      AND (
        UPPER(REPLACE(ISNULL(m.HouseholdMemberID, ''), ' ', '')) = @hmid
        OR UPPER(REPLACE(CONCAT(ISNULL(ten.MemberIDPrefix, ''), ISNULL(m.HouseholdMemberID, '')), ' ', '')) = @hmid
        OR UPPER(REPLACE(CONCAT(ISNULL(ten.IndividualMemberIDPrefix, ''), ISNULL(m.HouseholdMemberID, '')), ' ', '')) = @hmid
      )
      ${extraWhere}
  `);
  return result.recordset[0] || null;
}

async function getPrimaryMemberForUser(userId) {
  const pool = await getPool();
  const result = await pool.request()
    .input('userId', sql.UniqueIdentifier, userId)
    .query(`
      SELECT TOP 1
        m.MemberId,
        m.HouseholdMemberID
      FROM oe.Members m
      WHERE m.UserId = @userId
        AND m.Status != 'Terminated'
      ORDER BY
        CASE WHEN m.RelationshipType = 'P' THEN 0 ELSE 1 END,
        m.MemberSequence ASC,
        m.CreatedDate ASC
    `);
  return result.recordset[0] || null;
}

async function isRateLimited(userId) {
  const pool = await getPool();
  const result = await pool.request()
    .input('userId', sql.UniqueIdentifier, userId)
    .query(`
      SELECT COUNT(*) AS Cnt
      FROM oe.LoginOtpCodes
      WHERE UserId = @userId
        AND CreatedDate > DATEADD(HOUR, -1, GETUTCDATE())
    `);
  return result.recordset[0].Cnt >= MAX_SENDS_PER_HOUR;
}

/** Seconds until another OTP may be sent to this user (minimum gap between sends). */
async function getSecondsUntilResendAllowed(userId) {
  const pool = await getPool();
  const result = await pool.request()
    .input('userId', sql.UniqueIdentifier, userId)
    .query(`
      SELECT TOP 1 CreatedDate
      FROM oe.LoginOtpCodes
      WHERE UserId = @userId
      ORDER BY CreatedDate DESC
    `);
  if (!result.recordset[0]?.CreatedDate) return 0;
  const last = new Date(result.recordset[0].CreatedDate);
  const elapsedSec = (Date.now() - last.getTime()) / 1000;
  const remaining = MIN_RESEND_INTERVAL_SECONDS - elapsedSec;
  return remaining > 0 ? Math.ceil(remaining) : 0;
}

async function createChallenge(userId, code, channel, identifier, req) {
  const pool = await getPool();
  const challengeId = crypto.randomUUID();
  await pool.request()
    .input('challengeId', sql.UniqueIdentifier, challengeId)
    .input('userId', sql.UniqueIdentifier, userId)
    .input('codeHash', sql.NVarChar, hashCode(code))
    .input('channel', sql.NVarChar, channel)
    .input('identifier', sql.NVarChar, identifier)
    .input('expiry', sql.Int, CODE_EXPIRY_MINUTES)
    .input('ip', sql.NVarChar, req.ip || req.connection?.remoteAddress || null)
    .input('ua', sql.NVarChar, (req.headers['user-agent'] || '').slice(0, 512))
    .query(`
      UPDATE oe.LoginOtpCodes SET ConsumedAt = GETUTCDATE()
      WHERE UserId = @userId AND Verified = 0 AND ConsumedAt IS NULL;
      INSERT INTO oe.LoginOtpCodes (
        ChallengeId, UserId, CodeHash, Channel, Identifier, ExpiresAt, RequestIp, UserAgent
      ) VALUES (
        @challengeId, @userId, @codeHash, @channel, @identifier,
        DATEADD(MINUTE, @expiry, GETUTCDATE()), @ip, @ua
      )
    `);
  return challengeId;
}

class LoginOtpService {
  static getGenericMessage() {
    return GENERIC_SUCCESS_MESSAGE;
  }

  static async requestOtp(req, body) {
    const client = normalizeClient(body);
    const {
      identifier,
      email: bodyEmail,
      phone: bodyPhone,
      channel = 'auto',
      userId: selectedUserId,
      householdMemberId,
    } = body || {};

    const emailField = bodyEmail != null ? String(bodyEmail).trim() : '';
    const phoneField = bodyPhone != null ? String(bodyPhone).trim() : '';
    const hasDualIdentifier = !!(emailField && phoneField);
    const idTrim = identifier != null ? String(identifier).trim() : '';

    if (!selectedUserId && !householdMemberId) {
      if (hasDualIdentifier) {
        if (!looksLikeEmail(emailField)) {
          return { success: false, status: 400, message: 'Enter a valid email address.' };
        }
      } else if (!idTrim) {
        return {
          success: false,
          status: 400,
          message:
            client === 'portal'
              ? 'Enter your email or phone number.'
              : 'Identifier is required',
        };
      }
    }

    const isEmail = hasDualIdentifier ? true : looksLikeEmail(idTrim);
    const emailNorm = hasDualIdentifier
      ? normalizeEmail(emailField)
      : isEmail
        ? normalizeEmail(idTrim)
        : null;
    const phoneVariants = hasDualIdentifier
      ? buildPhoneNumberVariants(phoneField)
      : isEmail
        ? []
        : buildPhoneNumberVariants(idTrim);

    let candidates = [];

    if (selectedUserId) {
      const pool = await getPool();
      const one = await pool.request()
        .input('userId', sql.UniqueIdentifier, selectedUserId)
        .query(`
          SELECT u.UserId, u.Email, u.FirstName, u.LastName, u.PhoneNumber, u.TenantId
          FROM oe.Users u
          WHERE u.UserId = @userId AND ${OTP_ELIGIBLE_USER_STATUS_SQL}
        `);
      if (one.recordset[0]) candidates = [one.recordset[0]];
    } else if (householdMemberId) {
      const u =
        client === 'portal'
          ? await resolvePortalUserByHouseholdMemberId(
              householdMemberId,
              phoneVariants,
              emailNorm
            )
          : await resolveUserByHouseholdMemberId(
              householdMemberId,
              phoneVariants,
              emailNorm
            );
      if (u) candidates = [u];
    } else if (hasDualIdentifier) {
      const byEmail =
        client === 'portal'
          ? await findPortalUsersByEmail(emailNorm)
          : await findMobileEligibleUsersByEmail(emailNorm);
      const filtered = [];
      for (const u of byEmail) {
        if (await userPhoneOrHouseholdSpousePhoneMatches(u, phoneVariants)) {
          filtered.push(u);
        }
      }
      candidates = filtered;
    } else if (isEmail) {
      candidates =
        client === 'portal'
          ? await findPortalUsersByEmail(emailNorm)
          : await findMobileEligibleUsersByEmail(emailNorm);
    } else {
      candidates =
        client === 'portal'
          ? await findPortalUsersByPhone(phoneVariants)
          : await findMobileEligibleUsersByPhone(phoneVariants);
    }

    if (client === 'mobile') {
      candidates = await filterMemberRoleUsers(candidates);
      const beforeDeferFilter = candidates.length;
      if (beforeDeferFilter > 0) {
        candidates = await filterMobileAb365EligibleUsers(candidates);
        if (candidates.length === 0) {
          await logOtpEvent(req, 'OTP_REQUEST', false, 'pending_migration_defer_legacy', null);
          return pendingMigrationDeferResponse(client);
        }
      }
    } else {
      candidates = await filterUsersWithRoles(candidates);
    }

    if (candidates.length === 0) {
      await logOtpEvent(req, 'OTP_REQUEST', false, 'no_eligible_user', null);
      return {
        success: false,
        codeSent: false,
        failureReason: 'not_found',
        message:
          client === 'portal'
            ? hasDualIdentifier
              ? "We couldn't find an active account matching that email and phone number."
              : "We couldn't find an active account with that email or phone number."
            : hasDualIdentifier
              ? "We couldn't find an active account matching that email and phone number. Check your entry or sign in with password."
              : "We couldn't find an active account with that email or phone number. Check your entry or sign in with password.",
      };
    }

    if (candidates.length > 1 && !selectedUserId && !householdMemberId) {
      let picked = null;
      let choiceUsers = candidates;

      if (client === 'portal') {
        const resolved = await resolvePortalDuplicateUsers(candidates);
        picked = resolved.single;
        choiceUsers = resolved.choices || [];
      } else {
        picked = await pickSingleUserByEnrollment(candidates);
      }

      if (picked) {
        candidates = [picked];
      } else if (choiceUsers.length > 0) {
        const labels = await Promise.all(
          choiceUsers.map((c) =>
            client === 'portal'
              ? buildPortalAccountChoiceLabel(c)
              : Promise.resolve(
                  `${(c.FirstName || '')[0] || '?'}*** ${(c.LastName || '').slice(0, 1)}***`
                )
          )
        );
        await logOtpEvent(req, 'OTP_REQUEST', true, 'needs_account_choice', null);
        return {
          success: true,
          codeSent: false,
          failureReason: 'needs_account_choice',
          message:
            client === 'portal'
              ? 'Multiple accounts match. Choose yours to continue.'
              : 'Multiple accounts use this phone. Choose yours to continue.',
          needsAccountChoice: true,
          accountChoices: choiceUsers.map((c, i) => ({
            userId: String(c.UserId),
            label: labels[i],
          })),
        };
      }
    }

    const user = candidates[0];

    if (client === 'mobile' && !(await userCanCompleteAb365MemberLogin(user.UserId))) {
      await logOtpEvent(req, 'OTP_REQUEST', false, 'pending_migration_defer_legacy', user.UserId);
      return pendingMigrationDeferResponse(client);
    }

    if (await isRateLimited(user.UserId)) {
      await logOtpEvent(req, 'OTP_REQUEST', false, 'rate_limited_hourly', user.UserId);
      return {
        success: false,
        codeSent: false,
        failureReason: 'rate_limited',
        retryAfterSeconds: 3600,
        message:
          'Too many sign-in codes requested. Try again in about an hour, or sign in with password.',
      };
    }

    const resendWaitSec = await getSecondsUntilResendAllowed(user.UserId);
    if (resendWaitSec > 0) {
      await logOtpEvent(req, 'OTP_REQUEST', false, 'resend_too_soon', user.UserId);
      return {
        success: false,
        codeSent: false,
        failureReason: 'resend_too_soon',
        retryAfterSeconds: resendWaitSec,
        message: `Please wait ${resendWaitSec} seconds before requesting another code.`,
      };
    }

    let sendChannel = channel;
    if (sendChannel === 'auto') {
      if (hasDualIdentifier) {
        sendChannel = 'sms';
      } else {
        sendChannel = isEmail ? 'email' : 'sms';
      }
    }

    const deliveryPhone = hasDualIdentifier
      ? phoneField
      : !isEmail
        ? idTrim
        : user.PhoneNumber;
    const deliveryEmail = hasDualIdentifier
      ? emailNorm
      : isEmail
        ? emailNorm
        : user.Email;

    const code = generateNumericCode();
    const pool = await getPool();
    let tenantName = 'AllAboard365';
    if (user.TenantId) {
      const t = await pool.request()
        .input('tid', sql.UniqueIdentifier, user.TenantId)
        .query(`SELECT Name, CustomDomain FROM oe.Tenants WHERE TenantId = @tid`);
      if (t.recordset[0]) {
        tenantName = t.recordset[0].Name || tenantName;
      }
    }

    const messaging = await getTenantMessagingCredentials(user.TenantId);

    try {
      if (sendChannel === 'sms' && deliveryPhone) {
        const autofillDomain = process.env.LOGIN_OTP_SMS_DOMAIN || '';
        await sendLoginOtpSms({
          tenantId: user.TenantId,
          messaging,
          toPhone: deliveryPhone,
          code,
          autofillDomain,
        });
      } else if (deliveryEmail && !isSyntheticEmail(deliveryEmail)) {
        await sendLoginOtpEmail({
          tenantId: user.TenantId,
          messaging,
          toEmail: deliveryEmail,
          code,
          tenantName,
        });
        sendChannel = 'email';
      } else {
        await logOtpEvent(req, 'OTP_REQUEST', false, 'no_delivery_channel', user.UserId);
        return {
          success: false,
          codeSent: false,
          failureReason: 'no_delivery_channel',
          message:
            "We couldn't send a code — your account needs a valid phone or email. Try signing in with password.",
        };
      }
    } catch (sendErr) {
      console.error('[login-otp] send failed:', sendErr.message);
      await logOtpEvent(req, 'OTP_REQUEST', false, 'send_failed', user.UserId);
      return {
        success: false,
        codeSent: false,
        failureReason: 'send_failed',
        message:
          "We couldn't send your sign-in code right now. Please try again in a few minutes.",
      };
    }

    const challengeId = await createChallenge(
      user.UserId,
      code,
      sendChannel,
      isEmail ? emailNorm : idTrim,
      req
    );

    await logOtpEvent(req, 'OTP_REQUEST', true, `sent_${sendChannel}`, user.UserId);

    return {
      success: true,
      codeSent: true,
      message: GENERIC_SUCCESS_MESSAGE,
      challengeId,
      channelUsed: sendChannel,
      maskedDestination:
        sendChannel === 'sms' ? maskPhone(deliveryPhone) : maskEmail(deliveryEmail),
      retryAfterSeconds: MIN_RESEND_INTERVAL_SECONDS,
    };
  }

  static async verifyOtp(req, body) {
    const client = normalizeClient(body);
    const { challengeId, code, deviceId, deviceName, keepMeSignedIn } = body || {};
    if (!challengeId || !code) {
      return { success: false, status: 400, message: 'Challenge and code are required' };
    }

    const pool = await getPool();
    const lookup = await pool.request()
      .input('challengeId', sql.UniqueIdentifier, challengeId)
      .query(`
        SELECT TOP 1 ChallengeId, UserId, CodeHash, ExpiresAt, Verified, Attempts, ConsumedAt
        FROM oe.LoginOtpCodes
        WHERE ChallengeId = @challengeId
      `);

    if (lookup.recordset.length === 0) {
      await logOtpEvent(req, 'OTP_VERIFY', false, 'invalid_challenge', null);
      return { success: false, status: 401, message: 'Invalid or expired code' };
    }

    const row = lookup.recordset[0];
    if (row.ConsumedAt || row.Verified) {
      return { success: false, status: 401, message: 'Invalid or expired code' };
    }
    if (new Date() > new Date(row.ExpiresAt)) {
      return { success: false, status: 401, message: 'Invalid or expired code' };
    }
    if (row.Attempts >= MAX_ATTEMPTS) {
      return { success: false, status: 401, message: 'Too many attempts. Request a new code.' };
    }

    await pool.request()
      .input('challengeId', sql.UniqueIdentifier, challengeId)
      .query(`UPDATE oe.LoginOtpCodes SET Attempts = Attempts + 1 WHERE ChallengeId = @challengeId`);

    const codeNorm = String(code).trim().replace(/\D/g, '');
    if (hashCode(codeNorm) !== row.CodeHash) {
      await logOtpEvent(req, 'OTP_VERIFY', false, 'bad_code', row.UserId);
      return { success: false, status: 401, message: 'Invalid or expired code' };
    }

    const userResult = await pool.request()
      .input('userId', sql.UniqueIdentifier, row.UserId)
      .query(`
        SELECT UserId, Email, FirstName, LastName, PhoneNumber, TenantId, Status
        FROM oe.Users u
        WHERE u.UserId = @userId AND ${OTP_ELIGIBLE_USER_STATUS_SQL}
      `);
    if (userResult.recordset.length === 0) {
      return { success: false, status: 401, message: 'Invalid or expired code' };
    }

    if (client === 'mobile' && !(await userCanCompleteAb365MemberLogin(row.UserId))) {
      await logOtpEvent(req, 'OTP_VERIFY', false, 'pending_migration_defer_legacy', row.UserId);
      return { success: false, status: 401, message: 'Invalid or expired code' };
    }

    try {
      await activateUserAfterSuccessfulLogin(row.UserId);
    } catch (activateErr) {
      console.warn('[login-otp] activate after verify failed (non-fatal):', activateErr.message);
    }

    const roles = await UserRolesService.getUserRoleNames(row.UserId);
    if (client === 'mobile' && !roles.includes('Member')) {
      return { success: false, status: 403, message: 'This sign-in method is for members only.' };
    }
    if (!roles.length) {
      return { success: false, status: 403, message: 'This account has no assigned roles.' };
    }

    await pool.request()
      .input('challengeId', sql.UniqueIdentifier, challengeId)
      .query(`
        UPDATE oe.LoginOtpCodes
        SET Verified = 1, ConsumedAt = GETUTCDATE()
        WHERE ChallengeId = @challengeId
      `);

    const user = { ...userResult.recordset[0], Status: 'Active' };
    const ua = [
      req.headers['user-agent'] || '',
      deviceId ? `deviceId:${deviceId}` : '',
      deviceName ? `device:${deviceName}` : '',
    ]
      .filter(Boolean)
      .join(' ');

    const tokens = await createSessionTokensForUser(user, {
      userAgent: ua,
      persistentSession: client === 'portal' ? keepMeSignedIn === true : true,
    });

    const loginMeta = await getLoginMetadataForUser(user.UserId);

    await logOtpEvent(req, 'OTP_VERIFY', true, 'success', user.UserId);

    return {
      success: true,
      ...tokens,
      memberId: loginMeta.memberId,
      householdMemberId: loginMeta.householdMemberId,
    };
  }
}

module.exports = LoginOtpService;
