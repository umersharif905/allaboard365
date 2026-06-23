'use strict';

const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../../../middleware/auth');
const sftpConnectionService = require('../../../services/sftpConnectionService');

router.use(authenticate);
router.use(authorize(['VendorAdmin']));

function getVendorId(req) {
  return req.user?.VendorId || null;
}

// GET /api/me/vendor/sftp-connections
router.get('/', async (req, res) => {
  try {
    const vendorId = getVendorId(req);
    if (!vendorId) return res.status(403).json({ success: false, message: 'Vendor required' });
    const data = await sftpConnectionService.listConnections(vendorId);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/me/vendor/sftp-connections
router.post('/', async (req, res) => {
  try {
    const vendorId = getVendorId(req);
    if (!vendorId) return res.status(403).json({ success: false, message: 'Vendor required' });
    const b = req.body || {};
    const data = await sftpConnectionService.createConnection({
      vendorId,
      displayName: b.displayName,
      host: b.host,
      port: b.port,
      username: b.username,
      authType: b.authType,
      password: b.password,
      privateKey: b.privateKey,
      passphrase: b.passphrase,
      baseDirectory: b.baseDirectory,
      createdBy: req.user?.UserId || null,
    });
    res.status(201).json({ success: true, data });
  } catch (err) {
    const status = /required/i.test(err.message) ? 400 : 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

// POST /api/me/vendor/sftp-connections/test — draft credentials (create modal)
router.post('/test', async (req, res) => {
  try {
    const vendorId = getVendorId(req);
    if (!vendorId) return res.status(403).json({ success: false, message: 'Vendor required' });
    const b = req.body || {};
    const result = await sftpConnectionService.testConnection(null, vendorId, {
      host: b.host,
      port: b.port,
      username: b.username,
      authType: b.authType,
      password: b.password,
      privateKey: b.privateKey,
      passphrase: b.passphrase,
    });
    res.json({ success: true, data: result });
  } catch (err) {
    const status = /required/i.test(err.message) ? 400 : 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

// GET /api/me/vendor/sftp-connections/:connectionId
router.get('/:connectionId', async (req, res) => {
  try {
    const vendorId = getVendorId(req);
    if (!vendorId) return res.status(403).json({ success: false, message: 'Vendor required' });
    const data = await sftpConnectionService.getConnection(req.params.connectionId, vendorId);
    if (!data) return res.status(404).json({ success: false, message: 'Connection not found' });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/me/vendor/sftp-connections/:connectionId
router.put('/:connectionId', async (req, res) => {
  try {
    const vendorId = getVendorId(req);
    if (!vendorId) return res.status(403).json({ success: false, message: 'Vendor required' });
    const b = req.body || {};
    const data = await sftpConnectionService.updateConnection(req.params.connectionId, vendorId, {
      displayName: b.displayName,
      host: b.host,
      port: b.port,
      username: b.username,
      authType: b.authType,
      password: b.password,
      privateKey: b.privateKey,
      passphrase: b.passphrase,
      baseDirectory: b.baseDirectory,
    });
    if (!data) return res.status(404).json({ success: false, message: 'Connection not found' });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/me/vendor/sftp-connections/:connectionId
router.delete('/:connectionId', async (req, res) => {
  try {
    const vendorId = getVendorId(req);
    if (!vendorId) return res.status(403).json({ success: false, message: 'Vendor required' });
    await sftpConnectionService.deleteConnection(req.params.connectionId, vendorId);
    res.json({ success: true, message: 'Connection deleted' });
  } catch (err) {
    const status = err.statusCode === 409 ? 409 : 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

// POST /api/me/vendor/sftp-connections/:connectionId/test
router.post('/:connectionId/test', async (req, res) => {
  try {
    const vendorId = getVendorId(req);
    if (!vendorId) return res.status(403).json({ success: false, message: 'Vendor required' });
    const b = req.body || {};
    const result = await sftpConnectionService.testConnection(req.params.connectionId, vendorId, {
      host: b.host,
      port: b.port,
      username: b.username,
      authType: b.authType,
      password: b.password,
      privateKey: b.privateKey,
      passphrase: b.passphrase,
    });
    res.json({ success: true, data: result });
  } catch (err) {
    const status = /not found/i.test(err.message) ? 404 : /required/i.test(err.message) ? 400 : 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

module.exports = router;
