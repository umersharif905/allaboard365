const express = require('express');
const sql = require('mssql');
const { getPool } = require('../config/database');
const { authorize, requireTenantAccess, getUserRoles } = require('../middleware/auth');
const { appendGroupScopeForTenantUsers, GROUP_DETAIL_READ_STATUS_SQL } = require('../utils/groupRouteAccess');
const service = require('../services/employeeFacingDoc.service');

const router = express.Router();

const ALLOWED_ROLES = ['SysAdmin', 'TenantAdmin', 'Agent', 'GroupAdmin'];

/**
 * Loads the group identified by :groupId and 404s if the caller can't access it.
 * Mirrors the pattern in backend/routes/groupProducts.js — role is enforced by `authorize`,
 * tenant scope + GroupAdmin assignment by `appendGroupScopeForTenantUsers`.
 */
async function loadAccessibleGroup(req) {
  const { groupId } = req.params;
  const pool = await getPool();
  const userRoles = getUserRoles(req.user);
  let query = `
    SELECT g.GroupId, g.TenantId, g.AgentId, g.Name, g.Status
    FROM oe.Groups g
    WHERE g.GroupId = @groupId AND ${GROUP_DETAIL_READ_STATUS_SQL}
  `;
  const request = pool.request();
  request.input('groupId', sql.UniqueIdentifier, groupId);
  query = appendGroupScopeForTenantUsers(query, request, req, userRoles);

  const result = await request.query(query);
  if (result.recordset.length === 0) {
    const err = new Error('Group not found or access denied');
    err.statusCode = 404;
    throw err;
  }
  return result.recordset[0];
}

router.get('/api/groups/:groupId/employee-docs',
  authorize(ALLOWED_ROLES),
  requireTenantAccess,
  async (req, res) => {
    try {
      const group = await loadAccessibleGroup(req);
      const data = await service.getApplicableEmployeeDocsForGroup(group.GroupId, group.TenantId);
      res.json({ success: true, data });
    } catch (err) {
      console.error('[employee-docs route]', err.statusCode || 500, err.message, err.stack);
      res.status(err.statusCode || 500).json({ success: false, message: err.message });
    }
  }
);

router.get('/api/groups/:groupId/employee-docs/:proposalDocumentId/download',
  authorize(ALLOWED_ROLES),
  requireTenantAccess,
  async (req, res) => {
    try {
      const group = await loadAccessibleGroup(req);
      const baseUrl = req.get('origin') || `${req.protocol}://${req.get('host')}`;
      const { buffer, filename } = await service.generateEmployeeFacingPDF(
        group.GroupId,
        req.params.proposalDocumentId,
        req.user?.UserId,
        { baseUrl }
      );
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
      res.setHeader('Cache-Control', 'no-store');
      res.send(buffer);
    } catch (err) {
      console.error('[employee-docs route]', err.statusCode || 500, err.message, err.stack);
      res.status(err.statusCode || 500).json({ success: false, message: err.message });
    }
  }
);

module.exports = router;
