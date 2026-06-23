const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/database');
const { authorize, requireTenantAccess, getUserRoles } = require('../middleware/auth');
const sendGridEmailService = require('../services/sendGridEmailService');
const VendorExportService = require('../services/vendorExportService');
const {
  recordNewGroupFormHistory,
  generatePdfBuffer,
  generateFormBuffer,
  buildFormDisplayTitle,
  getFormConfigAndFields,
  loadCertification,
  signaturesRequiredForGroup,
  NEW_GROUP_FORM_SYSTEM_ACTOR_ID
} = require('../services/newGroupFormGenerationService');
const { vendorUserServesGroup } = require('../services/vendorGroupAccessService');
const { appendGroupScopeForTenantUsers, GROUP_DETAIL_READ_STATUS_SQL } = require('../utils/groupRouteAccess');

const NEW_GROUP_FORM_VENDOR_ROLES = ['VendorAdmin', 'VendorAgent'];

/**
 * Verify group access (same pattern as groupProducts / groupBilling), or vendor portal user serving the group.
 */
async function verifyGroupAccess(pool, groupId, req) {
  const user = req.user;
  const userRoles = getUserRoles(user);
  const isSysAdmin = userRoles.includes('SysAdmin');
  const isVendorPortal = !isSysAdmin && NEW_GROUP_FORM_VENDOR_ROLES.some((r) => userRoles.includes(r));
  if (isVendorPortal) {
    const ok = await vendorUserServesGroup(pool, user.UserId, groupId);
    if (!ok) {
      return { hasAccess: false, group: null };
    }
    const groupResult = await pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .query(`
        SELECT g.GroupId, g.TenantId FROM oe.Groups g
        WHERE g.GroupId = @groupId AND ${GROUP_DETAIL_READ_STATUS_SQL}
      `);
    return {
      hasAccess: groupResult.recordset.length > 0,
      group: groupResult.recordset[0] || null
    };
  }

  let groupCheckQuery = `
    SELECT g.GroupId, g.TenantId FROM oe.Groups g
    WHERE g.GroupId = @groupId AND ${GROUP_DETAIL_READ_STATUS_SQL}
  `;
  const groupCheckRequest = pool.request();
  groupCheckRequest.input('groupId', sql.UniqueIdentifier, groupId);
  groupCheckQuery = appendGroupScopeForTenantUsers(groupCheckQuery, groupCheckRequest, req, userRoles);
  const groupResult = await groupCheckRequest.query(groupCheckQuery);
  return {
    hasAccess: groupResult.recordset.length > 0,
    group: groupResult.recordset[0] || null
  };
}
// GET /api/groups/:groupId/new-group-form/certification - Get current certification (agent + group admin signatures) and whether signatures are required
router.get('/:groupId/new-group-form/certification', authorize(['SysAdmin', 'TenantAdmin', 'Agent', 'GroupAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { groupId } = req.params;
    const pool = await getPool();
    const accessCheck = await verifyGroupAccess(pool, groupId, req);
    if (!accessCheck.hasAccess) {
      return res.status(404).json({ success: false, message: 'Group not found or access denied' });
    }
    const cert = await loadCertification(pool, groupId);
    const signaturesRequired = await signaturesRequiredForGroup(pool, groupId);
    const formatDate = (d) => {
      if (!d) return null;
      const x = new Date(d);
      return x.toISOString ? x.toISOString().slice(0, 19) + 'Z' : null;
    }
    res.json({
      success: true,
      data: {
        ...(cert ? {
          agentSignedAt: formatDate(cert.agentSignedAt),
          agentHasSignature: !!(cert.agentSignatureData && cert.agentSignatureData.trim()),
          groupAdminSignedAt: formatDate(cert.groupAdminSignedAt),
          groupAdminHasSignature: !!(cert.groupAdminSignatureData && cert.groupAdminSignatureData.trim())
        } : { agentSignedAt: null, agentHasSignature: false, groupAdminSignedAt: null, groupAdminHasSignature: false }),
        signaturesRequired
      }
    });
  } catch (err) {
    console.error('Error fetching new group form certification:', err);
    res.status(500).json({ success: false, message: 'Failed to load certification' });
  }
});

// POST /api/groups/:groupId/new-group-form/certification/agent - Agent signs (group's assigned agent or SysAdmin/TenantAdmin)
router.post('/:groupId/new-group-form/certification/agent', authorize(['SysAdmin', 'TenantAdmin', 'Agent']), requireTenantAccess, async (req, res) => {
  try {
    const { groupId } = req.params;
    const { signatureData } = req.body || {};
    if (!signatureData || typeof signatureData !== 'string' || !signatureData.trim()) {
      return res.status(400).json({ success: false, message: 'signatureData is required' });
    }
    const pool = await getPool();
    const accessCheck = await verifyGroupAccess(pool, groupId, req);
    if (!accessCheck.hasAccess) {
      return res.status(404).json({ success: false, message: 'Group not found or access denied' });
    }
    const userRoles = getUserRoles(req.user);
    const isSysOrTenant = userRoles.includes('SysAdmin') || userRoles.includes('TenantAdmin');
    if (!isSysOrTenant) {
      const groupRow = await pool.request()
        .input('groupId', sql.UniqueIdentifier, groupId)
        .query('SELECT AgentId FROM oe.Groups WHERE GroupId = @groupId');
      const groupAgentId = groupRow.recordset[0]?.AgentId;
      const agentUserRow = await pool.request()
        .input('agentId', sql.UniqueIdentifier, groupAgentId)
        .query('SELECT UserId FROM oe.Agents WHERE AgentId = @agentId');
      const agentUserId = agentUserRow.recordset[0]?.UserId;
      if (!agentUserId || String(agentUserId) !== String(req.user.UserId)) {
        return res.status(403).json({ success: false, message: 'Only the group\'s assigned agent can add the agent signature' });
      }
    }
    const userId = req.user.UserId || null;
    await pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .input('signatureData', sql.NVarChar(sql.MAX), signatureData.trim())
      .input('signedBy', sql.UniqueIdentifier, userId)
      .query(`
        MERGE oe.GroupNewGroupFormCertification AS t
        USING (SELECT @groupId AS GroupId) AS s ON t.GroupId = s.GroupId
        WHEN MATCHED THEN
          UPDATE SET AgentSignatureData = @signatureData, AgentSignedAt = GETUTCDATE(), AgentSignedBy = @signedBy, ModifiedDate = GETUTCDATE()
        WHEN NOT MATCHED BY TARGET THEN
          INSERT (GroupId, AgentSignatureData, AgentSignedAt, AgentSignedBy)
          VALUES (@groupId, @signatureData, GETUTCDATE(), @signedBy);
      `);
    res.json({ success: true, message: 'Agent signature saved' });
  } catch (err) {
    console.error('Error saving agent certification:', err);
    res.status(500).json({ success: false, message: err.message || 'Failed to save signature' });
  }
});

// POST /api/groups/:groupId/new-group-form/certification/group-admin - Group admin signs
router.post('/:groupId/new-group-form/certification/group-admin', authorize(['SysAdmin', 'TenantAdmin', 'GroupAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { groupId } = req.params;
    const { signatureData } = req.body || {};
    if (!signatureData || typeof signatureData !== 'string' || !signatureData.trim()) {
      return res.status(400).json({ success: false, message: 'signatureData is required' });
    }
    const pool = await getPool();
    const accessCheck = await verifyGroupAccess(pool, groupId, req);
    if (!accessCheck.hasAccess) {
      return res.status(404).json({ success: false, message: 'Group not found or access denied' });
    }
    const userRoles = getUserRoles(req.user);
    const isSysOrTenant = userRoles.includes('SysAdmin') || userRoles.includes('TenantAdmin');
    if (!isSysOrTenant) {
      const gaRow = await pool.request()
        .input('groupId', sql.UniqueIdentifier, groupId)
        .input('userId', sql.UniqueIdentifier, req.user.UserId)
        .query('SELECT 1 FROM oe.GroupAdmins WHERE GroupId = @groupId AND UserId = @userId AND Status = \'Active\'');
      if (!gaRow.recordset.length) {
        return res.status(403).json({ success: false, message: 'Only a group admin for this group can add the group admin signature' });
      }
    }
    const userId = req.user.UserId || null;
    await pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .input('signatureData', sql.NVarChar(sql.MAX), signatureData.trim())
      .input('signedBy', sql.UniqueIdentifier, userId)
      .query(`
        MERGE oe.GroupNewGroupFormCertification AS t
        USING (SELECT @groupId AS GroupId) AS s ON t.GroupId = s.GroupId
        WHEN MATCHED THEN
          UPDATE SET GroupAdminSignatureData = @signatureData, GroupAdminSignedAt = GETUTCDATE(), GroupAdminSignedBy = @signedBy, ModifiedDate = GETUTCDATE()
        WHEN NOT MATCHED BY TARGET THEN
          INSERT (GroupId, GroupAdminSignatureData, GroupAdminSignedAt, GroupAdminSignedBy)
          VALUES (@groupId, @signatureData, GETUTCDATE(), @signedBy);
      `);
    res.json({ success: true, message: 'Group admin signature saved' });
  } catch (err) {
    console.error('Error saving group admin certification:', err);
    res.status(500).json({ success: false, message: err.message || 'Failed to save signature' });
  }
});

// GET /api/groups/:groupId/new-group-form/preview/:vendorId - Resolved field values for review/edit before generate
router.get('/:groupId/new-group-form/preview/:vendorId', authorize(['SysAdmin', 'TenantAdmin', 'Agent', 'GroupAdmin', 'VendorAdmin', 'VendorAgent']), requireTenantAccess, async (req, res) => {
  try {
    const { groupId, vendorId } = req.params;
    const pool = await getPool();

    const accessCheck = await verifyGroupAccess(pool, groupId, req);
    if (!accessCheck.hasAccess) {
      return res.status(404).json({ success: false, message: 'Group not found or access denied' });
    }

    const { config, group, vendor, fields, mergedFieldDefs, payload, error } = await getFormConfigAndFields(pool, groupId, vendorId, {
      actorUserId: req.user?.UserId || req.user?.userId || NEW_GROUP_FORM_SYSTEM_ACTOR_ID
    });
    if (error) {
      return res.status(400).json({ success: false, message: error });
    }

    const groupAddress = (payload && (payload['group.PhysicalAddress'] ?? payload['group.Address'])) ? String(payload['group.PhysicalAddress'] ?? payload['group.Address']).trim() : '';
    const groupName = payload ? String(payload['group.Name'] ?? payload['group.LegalName'] ?? '').trim() : '';
    const primaryContactName = payload ? String(payload['group.PrimaryContact'] ?? '').trim() : '';
    const configFields = mergedFieldDefs || config.fields || [];
    const fieldsWithMissing = (fields || []).map((f, i) => {
      const cf = configFields[i];
      const isLabelHeader = f.fieldType === 'labelHeader';
      const rawDefault = cf?.defaultValue;
      const defaultValue = rawDefault != null && String(rawDefault).trim() !== '' ? String(rawDefault).trim() : undefined;
      let value = f.value != null ? String(f.value).trim() : '';
      const sv = (cf?.systemVariable ?? '').trim().toLowerCase();
      if (!isLabelHeader && (sv === 'group.name' || sv === 'group.legalname')) {
        value = groupName;
      }
      if (!isLabelHeader && groupName && primaryContactName && value === primaryContactName) {
        const label = (f.label || '').trim().toLowerCase();
        const looksLikeGroupName = label.includes('company') || label.includes('group name') || label.includes('legal name');
        if (looksLikeGroupName || sv === 'group.name' || sv === 'group.legalname') value = groupName;
      }
      if (!isLabelHeader && value === '' && groupAddress && cf) {
        if (sv === 'group.physicaladdress' || sv === 'group.address') value = groupAddress;
      }
      if (!isLabelHeader && value === '' && groupAddress) {
        const label = (f.label || '').trim().toLowerCase();
        if (label === 'address' || label === 'physical address' || label === 'group address') value = groupAddress;
      }
      return {
        key: f.key,
        label: f.label,
        value,
        missing: isLabelHeader ? !(f.label && String(f.label).trim()) : !(value !== ''),
        fieldType: isLabelHeader ? 'labelHeader' : (f.fieldType || 'field'),
        defaultValue: defaultValue || undefined
      };
    });
    const defaultEmail = (vendor.Email || '').trim() || '';
    res.json({
      success: true,
      formTitle: buildFormDisplayTitle(config, group),
      fields: fieldsWithMissing,
      vendorName: vendor.VendorName,
      defaultEmail
    });
  } catch (err) {
    console.error('Error fetching new group form preview:', err);
    res.status(500).json({ success: false, message: 'Failed to load preview' });
  }
});

// GET /api/groups/:groupId/new-group-form/history - List history of generated/sent forms
router.get('/:groupId/new-group-form/history', authorize(['SysAdmin', 'TenantAdmin', 'Agent', 'GroupAdmin', 'VendorAdmin', 'VendorAgent']), requireTenantAccess, async (req, res) => {
  try {
    const { groupId } = req.params;
    const pool = await getPool();
    const accessCheck = await verifyGroupAccess(pool, groupId, req);
    if (!accessCheck.hasAccess) {
      return res.status(404).json({ success: false, message: 'Group not found or access denied' });
    }
    const reqDb = pool.request();
    reqDb.input('groupId', sql.UniqueIdentifier, groupId);
    const result = await reqDb.query(`
      SELECT h.Id, h.GroupId, h.VendorId, h.ActionType, h.OccurredAt, h.RecipientEmail, h.MarkedAsSent, h.CreatedBy, h.CreatedDate,
             v.VendorName
      FROM oe.GroupNewGroupFormHistory h
      INNER JOIN oe.Vendors v ON h.VendorId = v.VendorId
      WHERE h.GroupId = @groupId
      ORDER BY h.OccurredAt DESC
    `);
    const list = (result.recordset || []).map((r) => ({
      id: r.Id,
      groupId: r.GroupId,
      vendorId: r.VendorId,
      vendorName: r.VendorName,
      actionType: r.ActionType,
      occurredAt: r.OccurredAt,
      recipientEmail: r.RecipientEmail,
      markedAsSent: !!r.MarkedAsSent,
      createdBy: r.CreatedBy,
      createdDate: r.CreatedDate
    }));
    res.json({ success: true, data: list });
  } catch (err) {
    console.error('Error listing new group form history:', err);
    res.status(500).json({ success: false, message: 'Failed to load history' });
  }
});

// POST /api/groups/:groupId/new-group-form/history - Record a generate/send (called server-side after success, or by client)
router.post('/:groupId/new-group-form/history', authorize(['SysAdmin', 'TenantAdmin', 'Agent', 'GroupAdmin', 'VendorAdmin', 'VendorAgent']), requireTenantAccess, async (req, res) => {
  try {
    const { groupId } = req.params;
    const { vendorId, actionType, recipientEmail } = req.body;
    if (!vendorId || !actionType) {
      return res.status(400).json({ success: false, message: 'vendorId and actionType are required' });
    }
    if (!['Download', 'Email'].includes(actionType)) {
      return res.status(400).json({ success: false, message: 'actionType must be Download or Email' });
    }
    const pool = await getPool();
    const accessCheck = await verifyGroupAccess(pool, groupId, req);
    if (!accessCheck.hasAccess) {
      return res.status(404).json({ success: false, message: 'Group not found or access denied' });
    }
    const id = require('crypto').randomUUID();
    const ins = pool.request();
    ins.input('id', sql.UniqueIdentifier, id);
    ins.input('groupId', sql.UniqueIdentifier, groupId);
    ins.input('vendorId', sql.UniqueIdentifier, vendorId);
    ins.input('actionType', sql.NVarChar(20), actionType);
    ins.input('recipientEmail', sql.NVarChar(255), recipientEmail && String(recipientEmail).trim() ? String(recipientEmail).trim() : null);
    ins.input('markedAsSent', sql.Bit, actionType === 'Email' ? 1 : 0);
    ins.input('createdBy', sql.UniqueIdentifier, req.user && req.user.UserId ? req.user.UserId : null);
    await ins.query(`
      INSERT INTO oe.GroupNewGroupFormHistory (Id, GroupId, VendorId, ActionType, RecipientEmail, MarkedAsSent, CreatedBy)
      VALUES (@id, @groupId, @vendorId, @actionType, @recipientEmail, @markedAsSent, @createdBy)
    `);
    res.status(201).json({ success: true, data: { id } });
  } catch (err) {
    console.error('Error creating new group form history:', err);
    res.status(500).json({ success: false, message: 'Failed to record history' });
  }
});

// PATCH /api/groups/:groupId/new-group-form/history/:id - Toggle MarkedAsSent
router.patch('/:groupId/new-group-form/history/:id', authorize(['SysAdmin', 'TenantAdmin', 'Agent', 'GroupAdmin', 'VendorAdmin', 'VendorAgent']), requireTenantAccess, async (req, res) => {
  try {
    const { groupId, id } = req.params;
    const { markedAsSent } = req.body;
    if (typeof markedAsSent !== 'boolean') {
      return res.status(400).json({ success: false, message: 'markedAsSent (boolean) is required' });
    }
    const pool = await getPool();
    const accessCheck = await verifyGroupAccess(pool, groupId, req);
    if (!accessCheck.hasAccess) {
      return res.status(404).json({ success: false, message: 'Group not found or access denied' });
    }
    const upd = pool.request();
    upd.input('id', sql.UniqueIdentifier, id);
    upd.input('groupId', sql.UniqueIdentifier, groupId);
    upd.input('markedAsSent', sql.Bit, markedAsSent ? 1 : 0);
    const result = await upd.query(`
      UPDATE oe.GroupNewGroupFormHistory SET MarkedAsSent = @markedAsSent
      WHERE Id = @id AND GroupId = @groupId
    `);
    if (result.rowsAffected[0] === 0) {
      return res.status(404).json({ success: false, message: 'History record not found' });
    }
    res.json({ success: true, message: 'Updated' });
  } catch (err) {
    console.error('Error updating new group form history:', err);
    res.status(500).json({ success: false, message: 'Failed to update' });
  }
});

// DELETE /api/groups/:groupId/new-group-form/history/:id - Delete a history record
router.delete('/:groupId/new-group-form/history/:id', authorize(['SysAdmin', 'TenantAdmin', 'Agent', 'GroupAdmin', 'VendorAdmin', 'VendorAgent']), requireTenantAccess, async (req, res) => {
  try {
    const { groupId, id } = req.params;
    const pool = await getPool();
    const accessCheck = await verifyGroupAccess(pool, groupId, req);
    if (!accessCheck.hasAccess) {
      return res.status(404).json({ success: false, message: 'Group not found or access denied' });
    }
    const del = pool.request();
    del.input('id', sql.UniqueIdentifier, id);
    del.input('groupId', sql.UniqueIdentifier, groupId);
    const result = await del.query(`
      DELETE FROM oe.GroupNewGroupFormHistory WHERE Id = @id AND GroupId = @groupId
    `);
    if (result.rowsAffected[0] === 0) {
      return res.status(404).json({ success: false, message: 'History record not found' });
    }
    res.json({ success: true, message: 'Deleted' });
  } catch (err) {
    console.error('Error deleting new group form history:', err);
    res.status(500).json({ success: false, message: 'Failed to delete' });
  }
});

// GET /api/groups/:groupId/new-group-form/generate/:vendorId - Generate PDF (no overrides)
router.get('/:groupId/new-group-form/generate/:vendorId', authorize(['SysAdmin', 'TenantAdmin', 'Agent', 'GroupAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { groupId, vendorId } = req.params;
    const pool = await getPool();

    const accessCheck = await verifyGroupAccess(pool, groupId, req);
    if (!accessCheck.hasAccess) {
      return res.status(404).json({ success: false, message: 'Group not found or access denied' });
    }

    const { buffer, group, vendor, error } = await generatePdfBuffer(pool, groupId, vendorId, null, {
      actorUserId: req.user?.UserId || req.user?.userId || NEW_GROUP_FORM_SYSTEM_ACTOR_ID
    });
    if (error || !buffer) {
      return res.status(400).json({ success: false, message: error || 'Failed to generate PDF' });
    }

    const safeName = (group.Name || 'Group').replace(/[^a-zA-Z0-9]/g, '_');
    const safeVendor = (vendor.VendorName || 'Vendor').replace(/[^a-zA-Z0-9]/g, '_');
    const filename = `NewGroupForm-${safeName}-${safeVendor}.pdf`;

    await recordNewGroupFormHistory(pool, { groupId, vendorId, actionType: 'Download', userId: req.user && req.user.UserId });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (err) {
    console.error('Error generating new group form PDF:', err);
    res.status(500).json({ success: false, message: 'Failed to generate form PDF' });
  }
});

// POST /api/groups/:groupId/new-group-form/generate/:vendorId - Generate PDF or TXT with optional field overrides
// Body: { fieldOverrides?: object, format?: 'pdf' | 'txt' } (default format: 'pdf')
router.post('/:groupId/new-group-form/generate/:vendorId', authorize(['SysAdmin', 'TenantAdmin', 'Agent', 'GroupAdmin', 'VendorAdmin', 'VendorAgent']), requireTenantAccess, async (req, res) => {
  try {
    const { groupId, vendorId } = req.params;
    const fieldOverrides = req.body && req.body.fieldOverrides ? req.body.fieldOverrides : null;
    const format = (req.body && req.body.format === 'txt') ? 'txt' : 'pdf';
    const pool = await getPool();

    const accessCheck = await verifyGroupAccess(pool, groupId, req);
    if (!accessCheck.hasAccess) {
      return res.status(404).json({ success: false, message: 'Group not found or access denied' });
    }

    const { buffer, group, vendor, error, contentType, ext } = await generateFormBuffer(pool, groupId, vendorId, fieldOverrides, format, {
      actorUserId: req.user?.UserId || req.user?.userId || NEW_GROUP_FORM_SYSTEM_ACTOR_ID
    });
    if (error || !buffer) {
      return res.status(400).json({ success: false, message: error || 'Failed to generate form' });
    }

    const safeName = (group.Name || 'Group').replace(/[^a-zA-Z0-9]/g, '_');
    const safeVendor = (vendor.VendorName || 'Vendor').replace(/[^a-zA-Z0-9]/g, '_');
    const filename = `NewGroupForm-${safeName}-${safeVendor}.${ext || 'pdf'}`;

    await recordNewGroupFormHistory(pool, { groupId, vendorId, actionType: 'Download', userId: req.user && req.user.UserId });

    res.setHeader('Content-Type', contentType || 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (err) {
    console.error('Error generating new group form:', err);
    res.status(500).json({ success: false, message: 'Failed to generate form' });
  }
});

// POST /api/groups/:groupId/new-group-form/send-email
router.post('/:groupId/new-group-form/send-email', authorize(['SysAdmin', 'TenantAdmin', 'Agent', 'GroupAdmin', 'VendorAdmin', 'VendorAgent']), requireTenantAccess, async (req, res) => {
  try {
    const { groupId } = req.params;
    const { vendorId, recipientEmail, fieldOverrides } = req.body;
    if (!vendorId) {
      return res.status(400).json({ success: false, message: 'vendorId is required' });
    }

    const pool = await getPool();
    const accessCheck = await verifyGroupAccess(pool, groupId, req);
    if (!accessCheck.hasAccess) {
      return res.status(404).json({ success: false, message: 'Group not found or access denied' });
    }

    const { buffer, group, vendor, error } = await generatePdfBuffer(pool, groupId, vendorId, fieldOverrides || null, {
      actorUserId: req.user?.UserId || req.user?.userId || NEW_GROUP_FORM_SYSTEM_ACTOR_ID
    });
    if (error || !buffer) {
      return res.status(400).json({ success: false, message: error || 'Failed to generate PDF' });
    }

    let toEmail = recipientEmail && recipientEmail.trim() ? recipientEmail.trim() : (vendor.Email || '').trim();
    if (!toEmail) {
      return res.status(400).json({ success: false, message: 'No recipient email (provide recipientEmail or configure vendor default Email)' });
    }

    const additionalContacts = await VendorExportService.getVendorNotificationContacts(vendorId);
    const bccEmails = (additionalContacts || [])
      .map(c => (c.email && c.email.trim()) || '')
      .filter(e => e && e.toLowerCase() !== toEmail.toLowerCase());

    const safeName = (group.Name || 'Group').replace(/[^a-zA-Z0-9]/g, '_');
    const safeVendor = (vendor.VendorName || 'Vendor').replace(/[^a-zA-Z0-9]/g, '_');
    const filename = `NewGroupForm-${safeName}-${safeVendor}.pdf`;

    const senderName = (req.tenantName && String(req.tenantName).trim()) || 'AllAboard365';
    const emailOptions = {
      tenantId: accessCheck.group.TenantId,
      to: toEmail,
      subject: `New Group Form – ${group.Name || 'Group'}`,
      html: `<p>Please find attached the New Group Form for <strong>${group.Name || 'Group'}</strong>.</p>`,
      attachments: [{
        content: buffer.toString('base64'),
        filename,
        type: 'application/pdf',
        disposition: 'attachment'
      }],
      metadata: { fromName: senderName }
    };
    if (bccEmails.length > 0) {
      emailOptions.bcc = bccEmails;
    }
    await sendGridEmailService.sendEmail(emailOptions);

    await recordNewGroupFormHistory(pool, { groupId, vendorId, actionType: 'Email', recipientEmail: toEmail, userId: req.user && req.user.UserId });

    res.json({ success: true, message: 'Email sent successfully' });
  } catch (err) {
    console.error('Error sending new group form email:', err);
    res.status(500).json({ success: false, message: err.message || 'Failed to send email' });
  }
});

module.exports = router;
