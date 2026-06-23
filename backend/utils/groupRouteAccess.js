'use strict';

const sql = require('mssql');

/** oe.Groups alias `g`: allow reads for active and soft-removed (Archived) groups on detail APIs. */
const GROUP_DETAIL_READ_STATUS_SQL = "(g.Status = 'Active' OR g.Status = 'Archived')";

/**
 * Append tenant scope and, when the user is acting as GroupAdmin, require a row in oe.GroupAdmins.
 * Users with both Agent and GroupAdmin roles use tenant scope only unless currentRole === 'GroupAdmin'.
 *
 * Tenant isolation + GroupAdmin assignment must already constrain GroupId (and typically Status via GROUP_DETAIL_READ_STATUS_SQL).
 * @param {import('mssql').Request} request - Request with any prior inputs; adds @userTenantId and/or @userId.
 * @param {import('express').Request} req - Must have req.user.TenantId, UserId, currentRole (from auth + requireTenantAccess).
 * @param {string[]} userRoles - From getUserRoles(req.user).
 * @returns {string} Updated query string.
 */
function appendGroupScopeForTenantUsers(groupQuery, request, req, userRoles) {
  const isSysAdmin = userRoles.includes('SysAdmin');
  if (!isSysAdmin) {
    groupQuery += ' AND g.TenantId = @userTenantId';
    request.input('userTenantId', sql.UniqueIdentifier, req.user.TenantId);
  }
  if (
    userRoles.includes('GroupAdmin') &&
    !isSysAdmin &&
    req.user?.currentRole === 'GroupAdmin'
  ) {
    request.input('userId', sql.UniqueIdentifier, req.user.UserId);
    groupQuery +=
      ' AND EXISTS (SELECT 1 FROM oe.GroupAdmins ga WHERE ga.GroupId = g.GroupId AND ga.UserId = @userId AND ga.Status = \'Active\')';
  }
  return groupQuery;
}

module.exports = {
  appendGroupScopeForTenantUsers,
  GROUP_DETAIL_READ_STATUS_SQL
};
