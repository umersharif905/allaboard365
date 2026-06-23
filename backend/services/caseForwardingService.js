// services/caseForwardingService.js
// TPA case forwarding — resolve a reimbursement case's plan vendor to a
// configured forwarding target, build a previewable email, send + record it.
// See sql-changes/2026-06-01-case-forwarding-targets.sql.

const { getPool, sql } = require('../config/database');
const CaseService = require('./caseService');
const sendGridEmailService = require('./sendGridEmailService');
const { downloadBlobBuffer } = require('./caseDocumentBlob');
const STARTER_TEMPLATES = require('../constants/tpaStarterTemplates');

// Enrollment statuses that count as the member "having" a plan.
const ACTIVE_ENROLLMENT_STATUSES = ['Active', 'Pending'];

/**
 * For a set of case IDs (already scoped to vendorId), return a map of
 * caseId -> { targetId, label, planVendorId } for reimbursement cases whose
 * member has an active/pending enrollment in a configured plan vendor.
 */
async function resolveTargetsForCases(vendorId, caseIds) {
  if (!Array.isArray(caseIds) || caseIds.length === 0) return {};
  const pool = await getPool();
  const req = pool.request().input('vendorId', sql.UniqueIdentifier, vendorId);

  const idParams = caseIds.map((id, i) => {
    req.input(`c${i}`, sql.UniqueIdentifier, id);
    return `@c${i}`;
  });
  const statusParams = ACTIVE_ENROLLMENT_STATUSES.map((s, i) => {
    req.input(`s${i}`, sql.NVarChar, s);
    return `@s${i}`;
  });

  const r = await req.query(`
    SELECT DISTINCT t.CaseId, ft.TargetId, ft.Label, ft.PlanVendorId
    FROM oe.Cases t
    INNER JOIN oe.Enrollments e ON e.MemberId = t.MemberId
        AND e.Status IN (${statusParams.join(', ')})
    INNER JOIN oe.Products p ON p.ProductId = e.ProductId
    INNER JOIN oe.CaseForwardingTargets ft
        ON ft.VendorId = @vendorId
       AND ft.PlanVendorId = p.VendorId
       AND ft.IsActive = 1
    WHERE t.VendorId = @vendorId
      AND t.CaseType = 'reimbursement'
      AND t.CaseId IN (${idParams.join(', ')})
  `);

  const map = {};
  for (const row of r.recordset) {
    if (!map[row.CaseId]) {
      map[row.CaseId] = { targetId: row.TargetId, label: row.Label, planVendorId: row.PlanVendorId };
    }
  }
  return map;
}

/** Resolve the single forwarding target for one case, or null. */
async function resolveTargetForCase(vendorId, caseId) {
  const map = await resolveTargetsForCases(vendorId, [caseId]);
  return map[caseId] || null;
}

async function listTargets(vendorId) {
  const pool = await getPool();
  const r = await pool.request()
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .query(`
      SELECT ft.TargetId, ft.VendorId, ft.PlanVendorId, ft.Label, ft.ForwardingEmails,
             ft.TemplateId, ft.IsActive, ft.CreatedDate, ft.ModifiedDate,
             v.VendorName AS PlanVendorName,
             mt.TemplateName
      FROM oe.CaseForwardingTargets ft
      LEFT JOIN oe.Vendors v ON v.VendorId = ft.PlanVendorId
      LEFT JOIN oe.MessageTemplates mt ON mt.TemplateId = ft.TemplateId
      WHERE ft.VendorId = @vendorId
      ORDER BY ft.Label
    `);
  return r.recordset;
}

async function createTarget(vendorId, { planVendorId, label, forwardingEmails, templateId, userId }) {
  const pool = await getPool();
  const r = await pool.request()
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .input('planVendorId', sql.UniqueIdentifier, planVendorId)
    .input('label', sql.NVarChar, label)
    .input('emails', sql.NVarChar, forwardingEmails)
    .input('templateId', sql.UniqueIdentifier, templateId || null)
    .input('userId', sql.UniqueIdentifier, userId || null)
    .query(`
      INSERT INTO oe.CaseForwardingTargets
        (VendorId, PlanVendorId, Label, ForwardingEmails, TemplateId, CreatedBy)
      OUTPUT INSERTED.*
      VALUES (@vendorId, @planVendorId, @label, @emails, @templateId, @userId)
    `);
  return r.recordset[0];
}

async function updateTarget(vendorId, targetId, { label, forwardingEmails, templateId, isActive, userId }) {
  const pool = await getPool();
  const r = await pool.request()
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .input('targetId', sql.UniqueIdentifier, targetId)
    .input('label', sql.NVarChar, label)
    .input('emails', sql.NVarChar, forwardingEmails)
    .input('templateId', sql.UniqueIdentifier, templateId || null)
    .input('isActive', sql.Bit, isActive ? 1 : 0)
    .input('userId', sql.UniqueIdentifier, userId || null)
    .query(`
      UPDATE oe.CaseForwardingTargets
      SET Label = @label, ForwardingEmails = @emails, TemplateId = @templateId,
          IsActive = @isActive, ModifiedDate = SYSUTCDATETIME(), ModifiedBy = @userId
      OUTPUT INSERTED.*
      WHERE TargetId = @targetId AND VendorId = @vendorId
    `);
  return r.recordset[0] || null;
}

async function deleteTarget(vendorId, targetId) {
  const pool = await getPool();
  await pool.request()
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .input('targetId', sql.UniqueIdentifier, targetId)
    .query(`DELETE FROM oe.CaseForwardingTargets WHERE TargetId = @targetId AND VendorId = @vendorId`);
  return { deleted: true };
}

/** Render a template string against a case-aware context.
 *  Supports {[scope.Field]} scalars and a repeated {[#bills]}...{[/bills]} block. */
function renderTemplate(template, ctx) {
  if (!template) return '';
  // 1) Expand the bills block first.
  let out = template.replace(/\{\[#bills\]\}([\s\S]*?)\{\[\/bills\]\}/g, (_m, inner) => {
    const bills = Array.isArray(ctx.bills) ? ctx.bills : [];
    return bills.map((bill) =>
      inner.replace(/\{\[bill\.([A-Za-z0-9_]+)\]\}/g, (_mm, f) => fmt(bill[f]))
    ).join('');
  });
  // 2) Expand scalar tokens {[scope.Field]} for member/plan/case.
  out = out.replace(/\{\[(member|plan|case)\.([A-Za-z0-9_]+)\]\}/g, (_m, scope, f) => fmt(ctx[scope]?.[f]));
  return out;
}

function fmt(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return formatDate(v);
  return String(v);
}

// Dates render as MM/DD/YYYY (UTC, so a date-only value isn't shifted by TZ).
function formatDate(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '';
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${mm}/${dd}/${d.getUTCFullYear()}`;
}

// Money renders with thousands separators + 2 decimals (no symbol — the
// template labels the column "(USD)").
function money(v) {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  if (Number.isNaN(n)) return String(v);
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Render a plain-text body (blank-line paragraphs, single-newline line breaks)
// as simple, email-safe HTML so it doesn't collapse into one blob when sent.
function plainTextToHtml(s) {
  const paragraphs = String(s || '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const inner = paragraphs
    .map((p) => `<p style="margin:0 0 12px;">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222;">${inner}</div>`;
}

// Remove the Message Center visual-editor design blob (an HTML comment it
// appends to a saved body). Mirrors the message center's own quick-send strip.
function stripDesignJson(s) {
  if (!s) return s;
  return s.replace(/\n?<!-- DESIGN_JSON:[\s\S]*? -->/g, '');
}

/** Assemble the preview payload for one case. */
async function buildPreview(vendorId, caseId) {
  const target = await resolveTargetForCase(vendorId, caseId);
  if (!target) {
    const err = new Error('No TPA forwarding target for this case');
    err.statusCode = 409;
    throw err;
  }
  const pool = await getPool();

  // Full target row (emails + template).
  const tRow = (await pool.request()
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .input('targetId', sql.UniqueIdentifier, target.targetId)
    .query(`SELECT TargetId, Label, ForwardingEmails, TemplateId FROM oe.CaseForwardingTargets
            WHERE TargetId = @targetId AND VendorId = @vendorId`)).recordset[0];

  const caseRow = await CaseService.getCaseById(vendorId, caseId);
  const planVendorName = target.label;

  // Bills (degrade to [] if table absent).
  let bills = [];
  try {
    const b = await pool.request()
      .input('caseId', sql.UniqueIdentifier, caseId)
      .query(`
        SELECT b.BillType, b.DateOfService, b.Description,
               b.BilledAmount, b.AllowedAmount, b.PaidAmount, b.Balance,
               p.ProviderName
        FROM oe.CaseBills b
        LEFT JOIN oe.Providers p ON p.ProviderId = b.ProviderId
        WHERE b.CaseId = @caseId AND b.IsActive = 1
        ORDER BY b.DateOfService DESC`);
    // Pre-format dates/amounts here so the merge tokens render cleanly.
    bills = b.recordset.map((row) => ({
      ...row,
      DateOfService: formatDate(row.DateOfService),
      BilledAmount: money(row.BilledAmount),
      AllowedAmount: money(row.AllowedAmount),
      PaidAmount: money(row.PaidAmount),
      Balance: money(row.Balance),
    }));
  } catch (_e) { bills = []; }

  // Documents the user can attach.
  const documents = (await pool.request()
    .input('caseId', sql.UniqueIdentifier, caseId)
    .query(`SELECT DocumentId, DocumentName, FileName, MimeType, FileSize
            FROM oe.CaseDocuments WHERE CaseId = @caseId AND IsActive = 1
            ORDER BY CreatedDate DESC`)).recordset;

  // Prior sends to this case (dedup warning).
  let priorSends = [];
  try {
    const ps = await pool.request()
      .input('caseId', sql.UniqueIdentifier, caseId)
      .query(`SELECT RecipientAddress, Subject, SentDate, Status
              FROM oe.MessageHistory WHERE CaseId = @caseId
              ORDER BY SentDate DESC`);
    priorSends = ps.recordset;
  } catch (_e) { priorSends = []; }

  const ctx = {
    member: {
      FirstName: caseRow?.MemberFirstName, LastName: caseRow?.MemberLastName,
      FullName: `${caseRow?.MemberFirstName || ''} ${caseRow?.MemberLastName || ''}`.trim(),
      Email: caseRow?.MemberEmail, Phone: caseRow?.MemberPhone, DateOfBirth: caseRow?.MemberDOB,
    },
    plan: { Name: planVendorName },
    case: {
      Number: caseRow?.CaseNumber, Type: caseRow?.CaseType, Subcategory: caseRow?.CaseSubcategory,
      Title: caseRow?.Title, Description: caseRow?.Description,
      SubmittedDate: caseRow?.SubmittedDate, Status: caseRow?.Status,
    },
    bills,
  };

  let subjectTpl = `Reimbursement request — {[case.Number]} ({[member.FullName]})`;
  let bodyTpl = `Please process the attached reimbursement request.`;
  if (tRow.TemplateId) {
    const t = (await pool.request()
      .input('templateId', sql.UniqueIdentifier, tRow.TemplateId)
      .input('vendorId', sql.UniqueIdentifier, vendorId)
      .query(`SELECT Subject, Body FROM oe.MessageTemplates
              WHERE TemplateId = @templateId AND VendorId = @vendorId`)).recordset[0];
    if (t && t.Subject) { subjectTpl = t.Subject; }
    if (t && t.Body) { bodyTpl = t.Body; }
  }
  // Strip the Message Center visual-editor design blob if the template was
  // edited/saved there — it must never appear in the outgoing email.
  bodyTpl = stripDesignJson(bodyTpl);
  subjectTpl = stripDesignJson(subjectTpl);

  return {
    target: { targetId: tRow.TargetId, label: tRow.Label },
    recipients: String(tRow.ForwardingEmails || '').split(',').map((s) => s.trim()).filter(Boolean),
    subject: renderTemplate(subjectTpl, ctx),
    body: renderTemplate(bodyTpl, ctx),
    documents,
    priorSends,
  };
}

async function send(vendorId, caseId, { to, subject, body, documentIds, userId }) {
  const recipients = (to || []).map((s) => String(s).trim()).filter(Boolean);
  if (recipients.length === 0) {
    const err = new Error('At least one recipient is required');
    err.statusCode = 400;
    throw err;
  }

  // Re-verify this case belongs to the vendor AND resolves to an active
  // forwarding target (reimbursement + configured plan vendor). This is the
  // authorization gate for the whole send: it blocks forwarding a foreign
  // vendor's case or weaponizing the pipe on a non-forwardable case before we
  // ever touch documents or send mail.
  const target = await resolveTargetForCase(vendorId, caseId);
  if (!target) {
    const err = new Error('No TPA forwarding target for this case');
    err.statusCode = 409;
    throw err;
  }

  const pool = await getPool();

  // Tenant context from the case's member (cases are vendor-scoped; member carries tenant).
  const ctxRow = (await pool.request()
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .input('caseId', sql.UniqueIdentifier, caseId)
    .query(`SELECT m.TenantId AS MemberTenantId
            FROM oe.Cases t LEFT JOIN oe.Members m ON m.MemberId = t.MemberId
            WHERE t.CaseId = @caseId AND t.VendorId = @vendorId`)).recordset[0];
  const tenantId = ctxRow?.MemberTenantId || null;

  // Build attachments from selected documents.
  const attachments = [];
  if (Array.isArray(documentIds) && documentIds.length > 0) {
    const dreq = pool.request()
      .input('caseId', sql.UniqueIdentifier, caseId)
      .input('vendorId', sql.UniqueIdentifier, vendorId);
    const idParams = documentIds.map((id, i) => { dreq.input(`d${i}`, sql.UniqueIdentifier, id); return `@d${i}`; });
    // Join to oe.Cases and require the vendor owns the case so foreign
    // documentIds can never be pulled even if the guard above were bypassed.
    const docs = (await dreq.query(`
      SELECT d.DocumentId, d.FileName, d.MimeType, d.BlobUrl
      FROM oe.CaseDocuments d
      INNER JOIN oe.Cases t ON t.CaseId = d.CaseId AND t.VendorId = @vendorId
      WHERE d.CaseId = @caseId AND d.IsActive = 1 AND d.DocumentId IN (${idParams.join(', ')})`)).recordset;
    for (const d of docs) {
      const buf = await downloadBlobBuffer(d.BlobUrl);
      if (!buf) { const e = new Error(`Could not load document ${d.FileName}`); e.statusCode = 502; throw e; }
      attachments.push({
        content: buf.toString('base64'),
        filename: d.FileName,
        type: d.MimeType || 'application/octet-stream',
        disposition: 'attachment',
      });
    }
  }

  // The body is plain text (newlines), but it's sent as HTML — convert so it
  // doesn't collapse into one blob. If it's already HTML (e.g. edited in the
  // Message Center block editor), send as-is and derive a text fallback.
  const isHtmlBody = /<[a-z][\s\S]*?>/i.test(body || '');
  const html = isHtmlBody ? body : plainTextToHtml(body);
  const text = isHtmlBody ? String(body || '').replace(/<[^>]+>/g, '') : body;

  const result = await sendGridEmailService.sendEmail({
    tenantId, to: recipients, subject, html, text, attachments,
    categories: ['tpa-forward'], metadata: { caseId },
  });

  // Record one MessageHistory row (CaseId-linked → History timeline + dedup).
  await pool.request()
    .input('TenantId', sql.UniqueIdentifier, tenantId)
    .input('CaseId', sql.UniqueIdentifier, caseId)
    .input('RecipientAddress', sql.NVarChar, recipients.join(', '))
    .input('Subject', sql.NVarChar, subject || null)
    .input('Status', sql.NVarChar, result.success ? 'Sent' : 'Failed')
    .input('ProviderMessageId', sql.NVarChar, result.messageId || null)
    .input('Body', sql.NVarChar(sql.MAX), body || null)
    .query(`
      INSERT INTO oe.MessageHistory
        (HistoryId, MessageId, TenantId, MessageType, RecipientAddress, Subject, Status, ProviderMessageId, SentDate, CaseId, Body)
      VALUES
        (NEWID(), NEWID(), @TenantId, 'Email', @RecipientAddress, @Subject, @Status, @ProviderMessageId, GETDATE(), @CaseId, @Body)
    `);

  // Internal audit note on the case.
  await pool.request()
    .input('CaseId', sql.UniqueIdentifier, caseId)
    .input('Note', sql.NVarChar, `Forwarded to TPA: ${recipients.join(', ')}`)
    .input('CreatedBy', sql.UniqueIdentifier, userId || null)
    .query(`
      INSERT INTO oe.CaseNotes (NoteId, CaseId, NoteType, Note, IsInternal, CreatedDate, CreatedBy)
      VALUES (NEWID(), @CaseId, 'tpa_forward', @Note, 1, SYSUTCDATETIME(), @CreatedBy)
    `);

  return { success: true, messageId: result.messageId, recipients };
}

/** Create a vendor-scoped starter MessageTemplate from canned ARM/Tall Tree copy. */
async function createStarterTemplate(vendorId, variant, userId) {
  const tpl = STARTER_TEMPLATES[variant];
  if (!tpl) { const e = new Error(`Unknown starter template variant: ${variant}`); e.statusCode = 400; throw e; }
  const pool = await getPool();
  const r = await pool.request()
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .input('name', sql.NVarChar, tpl.name)
    .input('subject', sql.NVarChar, tpl.subject)
    .input('body', sql.NVarChar(sql.MAX), tpl.body)
    .input('userId', sql.UniqueIdentifier, userId || null)
    .query(`
      INSERT INTO oe.MessageTemplates
        (TemplateId, TenantId, VendorId, TemplateName, MessageType, Subject, Body, IsActive, CreatedDate, CreatedBy)
      OUTPUT INSERTED.TemplateId, INSERTED.TemplateName
      VALUES (NEWID(), NULL, @vendorId, @name, 'Email', @subject, @body, 1, GETDATE(), @userId)
    `);
  return r.recordset[0];
}

module.exports = {
  ACTIVE_ENROLLMENT_STATUSES,
  createStarterTemplate,
  resolveTargetsForCases,
  resolveTargetForCase,
  listTargets,
  createTarget,
  updateTarget,
  deleteTarget,
  renderTemplate,
  plainTextToHtml,
  buildPreview,
  send,
};
