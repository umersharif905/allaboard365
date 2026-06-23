'use strict';

const { getPool, sql } = require('../config/database');
const UserRolesService = require('./shared/user-roles.service');
const { userShouldDeferMobileLoginToLegacy } = require('./mobileLoginDeferLegacy.service');

/**
 * True when this user may complete AllAboard365 member login (OTP or password):
 * - Member role
 * - Non-terminated oe.Members row linked to UserId
 * - Not pending E123 migration staging (defer to ShareWELL legacy)
 */
async function userHasLinkedNonTerminatedMember(userId) {
  const pool = await getPool();
  const result = await pool.request()
    .input('userId', sql.UniqueIdentifier, userId)
    .query(`
      SELECT TOP 1 1 AS ok
      FROM oe.Members m
      WHERE m.UserId = @userId
        AND (m.Status IS NULL OR m.Status != N'Terminated')
    `);
  return result.recordset.length > 0;
}

async function userCanCompleteAb365MemberLogin(userId) {
  const roles = await UserRolesService.getUserRoleNames(userId);
  if (!roles.includes('Member')) {
    return false;
  }
  if (!(await userHasLinkedNonTerminatedMember(userId))) {
    return false;
  }
  if (await userShouldDeferMobileLoginToLegacy(userId)) {
    return false;
  }
  return true;
}

/** Portal / staff roles — may log in even when Member eligibility fails (e.g. tenant admin test user). */
const PORTAL_STAFF_ROLES = new Set([
  'SysAdmin',
  'TenantAdmin',
  'VendorAdmin',
  'VendorAgent',
  'Agent',
  'AgencyOwner',
  'GroupAdmin',
]);

function hasPortalStaffRole(roles) {
  return Array.isArray(roles) && roles.some((r) => PORTAL_STAFF_ROLES.has(r));
}

/**
 * Apply AB365 member password gate only for member-only accounts (mobile defer / orphan UserId).
 * Users with TenantAdmin, Agent, etc. must not be blocked because they also have Member.
 */
function shouldGateAb365MemberPasswordLogin(roles) {
  return Array.isArray(roles) && roles.includes('Member') && !hasPortalStaffRole(roles);
}

module.exports = {
  userCanCompleteAb365MemberLogin,
  userHasLinkedNonTerminatedMember,
  hasPortalStaffRole,
  shouldGateAb365MemberPasswordLogin,
};
