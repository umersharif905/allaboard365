/**
 * Scheduled job: auto-generate New Group Form PDFs for groups with active enrollments on a vendor's products,
 * excluding groups that already have GroupNewGroupFormHistory for that vendor.
 * Reuses newGroupFormGenerationService + VendorGroupIdService (no duplicate PDF logic).
 */

const fs = require('fs').promises;
const path = require('path');
const jwt = require('jsonwebtoken');
const { getPool, sql } = require('../config/database');
const VendorExportService = require('./vendorExportService');
const VendorGroupIdService = require('./vendorGroupIdService');
const {
  generateFormBuffer,
  recordNewGroupFormHistory,
  NEW_GROUP_FORM_SYSTEM_ACTOR_ID
} = require('./newGroupFormGenerationService');
const sendGridEmailService = require('./sendGridEmailService');

const TEMP_SUBDIR = 'new-group-form-job-downloads';
const LINK_EXPIRES_IN = '7d';

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function createJobDownloadUrl(fileToken) {
  const secret = process.env.JWT_SECRET || 'your-secret-key';
  const token = jwt.sign(
    { sub: 'new-group-form-job', fileToken: String(fileToken) },
    secret,
    { expiresIn: LINK_EXPIRES_IN }
  );
  const apiBase = VendorExportService.getApiBaseUrl();
  return `${apiBase}/api/public/vendor-export/new-group-form-job-download?token=${encodeURIComponent(token)}`;
}

/**
 * Groups with at least one non-terminated enrollment on this vendor's products;
 * no GroupNewGroupFormHistory row yet for (GroupId, VendorId);
 * earliest qualifying enrollment effective date is within 14 days (or in the past).
 */
async function findCandidateGroups(pool, vendorId) {
  const req = pool.request();
  req.input('vendorId', sql.UniqueIdentifier, vendorId);
  const r = await req.query(`
    SELECT g.GroupId, g.Name AS GroupName
    FROM oe.Groups g
    WHERE g.Status = 'Active'
    AND (g.GroupType IS NULL OR g.GroupType <> 'ListBill')
    AND NOT EXISTS (
      SELECT 1 FROM oe.GroupNewGroupFormHistory h
      WHERE h.GroupId = g.GroupId AND h.VendorId = @vendorId
    )
    AND EXISTS (
      SELECT 1
      FROM (
        SELECT m.GroupId, MIN(e.EffectiveDate) AS MinEff
        FROM oe.Enrollments e
        INNER JOIN oe.Members m ON e.MemberId = m.MemberId
        INNER JOIN oe.Products p ON e.ProductId = p.ProductId
        WHERE p.VendorId = @vendorId
          AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
          AND e.Status = N'Active'
          AND (e.TerminationDate IS NULL OR e.TerminationDate > SYSUTCDATETIME())
          AND e.EffectiveDate IS NOT NULL
        GROUP BY m.GroupId
      ) x
      WHERE x.GroupId = g.GroupId
        AND x.MinEff <= DATEADD(DAY, 14, SYSUTCDATETIME())
    )
    ORDER BY g.Name
  `);
  return (r.recordset || []).map((row) => ({
    groupId: String(row.GroupId),
    groupName: (row.GroupName || '').trim() || 'Group'
  }));
}

async function ensureTempDir() {
  const dir = path.join(__dirname, '../temp', TEMP_SUBDIR);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * @param {string} vendorId
 * @param {{ emailRecipients?: string[], tenantId?: string, createdBy?: string|null, generateVendorGroupIdsIfNeeded?: boolean }} options
 * @returns {Promise<{ success: boolean, message?: string, groupsProcessed: number, rows: Array, errors: string[], skippedNoForm?: boolean }>}
 */
async function executeNewGroupFormScheduledJob(vendorId, options = {}) {
  const pool = await getPool();
  const generateVendorGroupIdsIfNeeded = options.generateVendorGroupIdsIfNeeded === true;
  const createdBy = options.createdBy || null;
  const emailOverride = Array.isArray(options.emailRecipients) ? options.emailRecipients.filter(Boolean) : [];

  const { tenantId: resolvedTenantId, displayName: brandName } = await VendorExportService.getPrimaryTenantInfoForVendor(vendorId);
  const effectiveTenantId = options.tenantId || resolvedTenantId;

  const vendorRow = await pool.request()
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .query(`SELECT VendorId, VendorName, Email, NewGroupFormConfig FROM oe.Vendors WHERE VendorId = @vendorId`);
  const vendor = vendorRow.recordset && vendorRow.recordset[0];
  if (!vendor || !vendor.NewGroupFormConfig || !String(vendor.NewGroupFormConfig).trim()) {
    return {
      success: false,
      message: 'Vendor has no New Group Form configured (Integration → New Group Form).',
      groupsProcessed: 0,
      rows: [],
      errors: []
    };
  }

  const candidates = await findCandidateGroups(pool, vendorId);
  if (candidates.length === 0) {
    return {
      success: true,
      message: 'No groups need a new group form at this time; email not sent.',
      groupsProcessed: 0,
      rows: [],
      errors: [],
      exportSkipped: true
    };
  }

  const tempDir = await ensureTempDir();
  const rows = [];
  const errors = [];

  for (const { groupId, groupName } of candidates) {
    try {
      if (generateVendorGroupIdsIfNeeded) {
        const uid = createdBy || NEW_GROUP_FORM_SYSTEM_ACTOR_ID;
        await VendorGroupIdService.ensureGroupProductsForBundleComponents(groupId, uid);
        await VendorGroupIdService.ensureGroupProductsForVendorProducts(groupId, vendorId, uid);
        const genResult = await VendorGroupIdService.applyGenerateForGroup(groupId, vendorId, uid);
        if (!genResult.success && genResult.error) {
          errors.push(`${groupName}: vendor group IDs — ${genResult.error}`);
        } else if (genResult.errors && genResult.errors.length) {
          genResult.errors.forEach((err) => errors.push(`${groupName}: ${err}`));
        }
      }

      const { buffer, group, vendor: vRow, error } = await generateFormBuffer(pool, groupId, vendorId, null, 'pdf', {
        actorUserId: createdBy || NEW_GROUP_FORM_SYSTEM_ACTOR_ID
      });
      if (error || !buffer) {
        errors.push(`${groupName}: ${error || 'PDF generation failed'}`);
        continue;
      }

      const fileToken = require('crypto').randomUUID();
      const safeName = (group && group.Name ? group.Name : groupName).replace(/[^a-zA-Z0-9-_]/g, '_');
      const safeVendor = (vRow && vRow.VendorName ? vRow.VendorName : vendor.VendorName || 'Vendor').replace(/[^a-zA-Z0-9-_]/g, '_');
      const fileName = `NewGroupForm-${safeName}-${safeVendor}.pdf`;
      const diskPath = path.join(tempDir, `${fileToken}.pdf`);
      await fs.writeFile(diskPath, buffer);

      const downloadUrl = createJobDownloadUrl(fileToken);
      rows.push({
        groupId,
        groupName: group && group.Name ? group.Name : groupName,
        fileName,
        downloadUrl,
        fileToken
      });

      await recordNewGroupFormHistory(pool, {
        groupId,
        vendorId,
        actionType: 'Email',
        recipientEmail: (emailOverride[0] || vendor.Email || '').trim() || null,
        userId: createdBy
      });
    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e);
      errors.push(`${groupName}: ${msg}`);
    }
  }

  if (rows.length === 0) {
    return {
      success: true,
      message:
        errors.length > 0
          ? 'No PDFs generated; email not sent. See job run details for errors.'
          : 'No PDFs generated this run; email not sent.',
      groupsProcessed: 0,
      rows: [],
      errors,
      exportSkipped: true
    };
  }

  const recipients = [];
  if (emailOverride.length > 0) {
    emailOverride.forEach((e) => {
      const x = String(e).trim();
      if (x && !recipients.some((r) => r.toLowerCase() === x.toLowerCase())) recipients.push(x);
    });
  } else {
    if (vendor.Email && String(vendor.Email).trim()) recipients.push(String(vendor.Email).trim());
    const contacts = await VendorExportService.getVendorNotificationContacts(vendorId);
    for (const c of contacts || []) {
      const em = (c.email || '').trim();
      if (em && !recipients.some((r) => r.toLowerCase() === em.toLowerCase())) recipients.push(em);
    }
  }

  if (recipients.length === 0) {
    return {
      success: false,
      message: 'No email recipients (set job email list or vendor Email / notification contacts).',
      groupsProcessed: rows.length,
      rows,
      errors
    };
  }

  const recipientListHtml = recipients.map((e) => `<li style="margin:4px 0;">${escapeHtml(e)}</li>`).join('');
  const tableRows = rows
    .map(
      (r) => `
    <tr>
      <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;">${escapeHtml(r.groupName)}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;word-break:break-all;"><a href="${escapeHtml(r.downloadUrl)}" style="color:#2563eb;">Download PDF</a></td>
    </tr>`
    )
    .join('');

  const htmlContent = `<!DOCTYPE html>
<html><head><meta charset="utf-8"/></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
<table width="100%" cellspacing="0" cellpadding="0" style="padding:20px 12px;"><tr><td align="center">
<table width="100%" style="max-width:640px;background:#fff;border-radius:10px;border:1px solid #e5e7eb;padding:22px;">
<tr><td>
  <div style="font-size:18px;font-weight:700;color:#111827;margin-bottom:8px;">New Group Form — ${escapeHtml(vendor.VendorName || 'Vendor')}</div>
  <p style="font-size:14px;color:#4b5563;margin:0 0 16px;">Automated job generated <strong>${rows.length}</strong> form(s). Each PDF link expires in 7 days.</p>
  <div style="font-size:13px;font-weight:600;color:#374151;margin-bottom:6px;">Recipients</div>
  <ul style="margin:0 0 18px;padding-left:20px;color:#374151;font-size:14px;">${recipientListHtml}</ul>
  <table width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
    <thead><tr style="background:#f9fafb;">
      <th align="left" style="padding:10px 12px;font-size:13px;color:#6b7280;">Group</th>
      <th align="left" style="padding:10px 12px;font-size:13px;color:#6b7280;">PDF (7-day link)</th>
    </tr></thead>
    <tbody>${tableRows}</tbody>
  </table>
  ${errors.length ? `<div style="margin-top:16px;padding:12px;background:#fffbeb;border:1px solid #fcd34d;border-radius:8px;font-size:13px;color:#92400e;"><strong>Notes</strong><ul style="margin:8px 0 0;padding-left:18px;">${errors.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul></div>` : ''}
  <p style="font-size:12px;color:#9ca3af;margin-top:18px;">${escapeHtml(brandName)}</p>
</td></tr>
</table>
</td></tr></table>
</body></html>`;

  const textLines = [
    `New Group Form — ${vendor.VendorName || 'Vendor'}`,
    '',
    `Generated ${rows.length} PDF(s). Links expire in 7 days.`,
    '',
    'Recipients:',
    ...recipients.map((e) => `- ${e}`),
    '',
    'Downloads:'
  ];
  for (const r of rows) {
    textLines.push(`- ${r.groupName}: ${r.downloadUrl}`);
  }
  if (errors.length) {
    textLines.push('', 'Notes:', ...errors.map((e) => `- ${e}`));
  }

  try {
    if (recipients.length > 1) {
      await sendGridEmailService.sendEmail({
        ...(effectiveTenantId ? { tenantId: effectiveTenantId } : {}),
        to: recipients,
        subject: `New Group Form — ${vendor.VendorName || 'Vendor'} (${rows.length} group${rows.length === 1 ? '' : 's'})`,
        html: htmlContent,
        text: textLines.join('\n'),
        metadata: { fromName: brandName }
      });
    } else {
      await sendGridEmailService.sendEmail({
        ...(effectiveTenantId ? { tenantId: effectiveTenantId } : {}),
        to: recipients[0],
        subject: `New Group Form — ${vendor.VendorName || 'Vendor'} (${rows.length} group${rows.length === 1 ? '' : 's'})`,
        html: htmlContent,
        text: textLines.join('\n'),
        metadata: { fromName: brandName }
      });
    }
  } catch (emailErr) {
    return {
      success: false,
      message: emailErr.message || 'Email send failed',
      groupsProcessed: rows.length,
      rows,
      errors: [...errors, emailErr.message || 'Email failed']
    };
  }

  return {
    success: true,
    message: `Emailed ${rows.length} form link(s).`,
    groupsProcessed: rows.length,
    rows,
    errors
  };
}

module.exports = {
  executeNewGroupFormScheduledJob,
  createJobDownloadUrl,
  findCandidateGroups,
  TEMP_SUBDIR
};
