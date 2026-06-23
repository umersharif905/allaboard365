// backend/routes/group-type-change-requests.js
const express = require('express');
const router = express.Router();
const svc = require('../services/groupTypeChangeRequestService');

// authenticate + requireTenantAccess are applied globally in app.js at mount time

router.post('/', async (req, res) => {
  try {
    const roles = req.user?.roles || [];
    const isAgent = roles.includes('Agent');
    const isTenantAdmin = roles.includes('TenantAdmin');
    const isSysAdmin = roles.includes('SysAdmin');
    const isGroupAdmin = roles.includes('GroupAdmin');
    // GroupAdmins are not permitted to request a group-type change.
    // Allow only if the caller has Agent / TenantAdmin / SysAdmin in their role set.
    if (!isAgent && !isTenantAdmin && !isSysAdmin) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }
    if (isGroupAdmin && !isAgent && !isTenantAdmin && !isSysAdmin) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }
    const { groupId, requestedType, reason } = req.body;
    const result = await svc.createRequest({
      groupId,
      tenantId: req.tenantId,
      requestedBy: req.user.UserId,
      requestedType,
      reason
    });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

router.get('/', async (req, res) => {
  try {
    if (!req.user.roles.includes('TenantAdmin') && !req.user.roles.includes('SysAdmin')) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }
    const isSysAdmin = req.user.roles.includes('SysAdmin');
    const data = await svc.listRequests({
      tenantId: req.tenantId,
      status: req.query.status,
      groupId: req.query.groupId,
      includeAllTenants: isSysAdmin
    });
    res.json({ success: true, data });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

router.post('/:id/approve', async (req, res) => {
  try {
    if (!req.user.roles.includes('TenantAdmin') && !req.user.roles.includes('SysAdmin')) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }
    const result = await svc.approveRequest({
      requestId: req.params.id,
      tenantId: req.tenantId,
      reviewerId: req.user.UserId,
      notes: req.body.notes
    });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

router.post('/:id/deny', async (req, res) => {
  try {
    if (!req.user.roles.includes('TenantAdmin') && !req.user.roles.includes('SysAdmin')) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }
    const result = await svc.denyRequest({
      requestId: req.params.id,
      tenantId: req.tenantId,
      reviewerId: req.user.UserId,
      notes: req.body.notes
    });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

module.exports = router;
