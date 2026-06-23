/**
 * UNIFIED USER EMAIL SERVICE
 *
 * Used by multiple endpoints:
 * - /api/me/sysadmin/users (SysAdmin - change any user's email)
 * - /api/me/tenant-admin/users (TenantAdmin - change agent/user emails within tenant)
 * - /api/me/group-admin/users (GroupAdmin - change member emails in their group)
 * - /api/me/agent/users (Agent/AgencyOwner - change assigned/downline member emails)
 *
 * Handles email availability check and update with duplicate prevention.
 */

const { getPool, sql } = require('../../config/database');
const { isUplineAncestor } = require('../../utils/agentHierarchy');
const agencyAdmins = require('../../utils/agencyAdmins');

/**
 * Check if an email is available (not taken by another user).
 * @param {string} email - Email to check (will be normalized to lowercase)
 * @param {string|null} excludeUserId - Optional UserId to exclude (e.g. the user being updated)
 * @returns {Promise<{available: boolean, takenByUserId?: string}>}
 */
async function checkEmailAvailable(email, excludeUserId = null) {
  const pool = await getPool();
  const normalizedEmail = String(email || '').trim().toLowerCase();

  if (!normalizedEmail) {
    return { available: false };
  }

  const request = pool.request();
  request.input('email', sql.NVarChar, normalizedEmail);

  let query = `
    SELECT UserId FROM oe.Users
    WHERE LOWER(LTRIM(RTRIM(Email))) = @email
  `;

  if (excludeUserId) {
    query += ` AND UserId != @excludeUserId`;
    request.input('excludeUserId', sql.UniqueIdentifier, excludeUserId);
  }

  const result = await request.query(query);

  if (result.recordset.length > 0) {
    return {
      available: false,
      takenByUserId: result.recordset[0].UserId,
    };
  }

  return { available: true };
}

/**
 * Update a user's email in oe.Users.
 * Caller must verify authorization (SysAdmin or TenantAdmin with tenant access) before calling.
 * @param {string} userId - UserId to update
 * @param {string} newEmail - New email (will be normalized)
 * @param {string} modifiedBy - UserId of the admin making the change
 * @returns {Promise<{success: boolean, message?: string}>}
 */
async function updateUserEmail(userId, newEmail, modifiedBy) {
  const pool = await getPool();
  const normalizedEmail = String(newEmail || '').trim().toLowerCase();

  if (!normalizedEmail) {
    return { success: false, message: 'Email is required' };
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(normalizedEmail)) {
    return { success: false, message: 'Invalid email format' };
  }

  const availability = await checkEmailAvailable(normalizedEmail, userId);
  if (!availability.available) {
    return { success: false, message: 'This email is already in use by another user' };
  }

  const transaction = pool.transaction();
  try {
    await transaction.begin();

    const userRequest = transaction.request();
    userRequest.input('userId', sql.UniqueIdentifier, userId);
    userRequest.input('email', sql.NVarChar, normalizedEmail);
    userRequest.input('modifiedBy', sql.UniqueIdentifier, modifiedBy);

    await userRequest.query(`
      UPDATE oe.Users
      SET Email = @email, ModifiedDate = GETUTCDATE(), ModifiedBy = @modifiedBy
      WHERE UserId = @userId
    `);

    // Also update oe.Agents if this user is an agent (Email is denormalized there)
    const agentRequest = transaction.request();
    agentRequest.input('userId', sql.UniqueIdentifier, userId);
    agentRequest.input('email', sql.NVarChar, normalizedEmail);
    agentRequest.input('modifiedBy', sql.UniqueIdentifier, modifiedBy);
    await agentRequest.query(`
      UPDATE oe.Agents
      SET Email = @email, ModifiedDate = GETUTCDATE(), ModifiedBy = @modifiedBy
      WHERE UserId = @userId
    `);

    await transaction.commit();
    return { success: true };
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}

/**
 * Agent/AgencyOwner may change email when the target user is a member assigned to them,
 * their downline, or (agency admin) same agency.
 */
async function verifyAgentCanChangeMemberEmail(pool, callerUserId, targetUserId) {
  const agentRes = await pool.request()
    .input('userId', sql.UniqueIdentifier, callerUserId)
    .query(`
      SELECT AgentId, AgencyId
      FROM oe.Agents
      WHERE UserId = @userId AND Status = 'Active'
    `);
  if (!agentRes.recordset.length) {
    return { ok: false, message: 'Agent profile not found' };
  }

  const callerAgentId = agentRes.recordset[0].AgentId;
  const callerAgencyId = agentRes.recordset[0].AgencyId;

  const memberRes = await pool.request()
    .input('userId', sql.UniqueIdentifier, targetUserId)
    .query(`
      SELECT TOP 1 MemberId, AgentId
      FROM oe.Members
      WHERE UserId = @userId
    `);
  if (!memberRes.recordset.length) {
    return { ok: false, message: 'User not found or not a member' };
  }

  const memberAgentId = memberRes.recordset[0].AgentId;
  if (!memberAgentId) {
    return { ok: false, message: 'Member has no assigned agent' };
  }

  if (String(memberAgentId).toLowerCase() === String(callerAgentId).toLowerCase()) {
    return { ok: true };
  }

  if (await isUplineAncestor(pool, memberAgentId, callerAgentId)) {
    return { ok: true };
  }

  if (callerAgencyId && (await agencyAdmins.isAgencyAdmin(pool, callerAgencyId, callerAgentId))) {
    const sameAgency = await pool.request()
      .input('memberAgentId', sql.UniqueIdentifier, memberAgentId)
      .input('agencyId', sql.UniqueIdentifier, callerAgencyId)
      .query(`
        SELECT 1
        FROM oe.Agents
        WHERE AgentId = @memberAgentId AND AgencyId = @agencyId AND Status = 'Active'
      `);
    if (sameAgency.recordset.length > 0) {
      return { ok: true };
    }
  }

  return { ok: false, message: 'Not authorized to change this member email' };
}

/**
 * GroupAdmin may change email when the target user is a member in their group.
 */
async function verifyGroupAdminCanChangeMemberEmail(pool, callerUserId, targetUserId) {
  const memberRes = await pool.request()
    .input('userId', sql.UniqueIdentifier, targetUserId)
    .query(`
      SELECT TOP 1 MemberId, GroupId
      FROM oe.Members
      WHERE UserId = @userId
    `);
  if (!memberRes.recordset.length || !memberRes.recordset[0].GroupId) {
    return { ok: false, message: 'User not found or not a group member' };
  }

  const groupId = memberRes.recordset[0].GroupId;
  const accessRes = await pool.request()
    .input('userId', sql.UniqueIdentifier, callerUserId)
    .input('groupId', sql.UniqueIdentifier, groupId)
    .query(`
      SELECT 1
      FROM oe.GroupAdmins
      WHERE UserId = @userId AND GroupId = @groupId AND Status = 'Active'
      UNION ALL
      SELECT 1
      FROM oe.Members
      WHERE UserId = @userId AND GroupId = @groupId AND Status = 'Active'
    `);

  if (accessRes.recordset.length > 0) {
    return { ok: true };
  }

  return { ok: false, message: 'Not authorized to change this member email' };
}

const UserEmailService = {
  checkEmailAvailable,
  updateUserEmail,
  verifyAgentCanChangeMemberEmail,
  verifyGroupAdminCanChangeMemberEmail,
};

module.exports = UserEmailService;
