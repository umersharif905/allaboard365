'use strict';

const express = require('express');
const router = express.Router();
const requireTenantE123Migration = require('../../../middleware/requireTenantE123Migration');
const migrationInstance = require('../../../services/migration/migrationInstance.service');
const adminMigrationRoutes = require('../../admin/migration');

router.get('/portal-status', async (req, res) => {
  try {
    const ctx = await migrationInstance.getTenantPortalContext(req.tenantId);
    res.json({ success: true, data: ctx });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.use(requireTenantE123Migration);
router.use(adminMigrationRoutes);

module.exports = router;
