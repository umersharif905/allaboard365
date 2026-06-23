// Vendor-portal mirror of /api/me/tenant-admin/public-forms.
// Delegates to the same publicFormAdminService.
//
// Access matrix:
//   - VendorAgent + VendorAdmin + SysAdmin: read endpoints, submissions
//     (resolve / set member / retry / summary email / routing notifications),
//     PDF downloads.
//   - VendorAdmin + SysAdmin only: template create / edit / publish / delete
//     / version / header image upload.
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { authorize } = require('../../../middleware/auth');
const requireTenantAccess = require('../../../middleware/requireTenantAccess');
const { generateAuthenticatedUrl, isBlobUrl, uploadToAzureBlob } = require('../../uploads');
const publicFormAdminService = require('../../../services/publicFormAdminService');
const vendorImportTenants = require('../../../services/vendorImportTenants.service');
const { linkSubmissionToShareWorkflow, backfillUnmatchedShellMember } = require('../../../services/publicFormShareLinkService');
const publicFormInvitationService = require('../../../services/publicFormInvitationService');
const { getPublicFormsActorUserId } = require('../../../services/publicFormActor');
const SendGridEmailService = require('../../../services/sendGridEmailService');
const { buildSubmissionPdfDownload, sendSubmissionPdfDownload } = require('../../../services/publicFormSubmissionPdfDownload');
const { definitionWithAuthenticatedHeaderImage } = require('../../../services/publicFormDefinitionSas');
const { registerDraftAdminRoutes } = require('../draftAdminRoutes');

const router = express.Router();

router.use(requireTenantAccess);
router.use(authorize(['VendorAdmin', 'VendorAgent', 'SysAdmin']));

// Write endpoints are tightened back to VendorAdmin / SysAdmin on each route.
const authorizeWrite = authorize(['VendorAdmin', 'SysAdmin']);

// In-progress drafts admin tab (shared with the tenant-admin surface).
// Delete is restricted to VendorAdmin / SysAdmin (not VendorAgent).
registerDraftAdminRoutes(router, { deleteMiddleware: authorizeWrite });

const uuidRe = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

const headerImageUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 2 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (/^image\/(jpeg|png|gif|webp)$/i.test(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Only JPEG, PNG, GIF, or WebP images are allowed'));
        }
    }
});

const submissionsListLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: Number(process.env.PUBLIC_FORMS_SUBMISSIONS_LIST_RATE_MAX || 60),
    standardHeaders: true,
    legacyHeaders: false
});

const sendSubmissionSummaryEmailLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: Number(process.env.PUBLIC_FORMS_SEND_SUMMARY_EMAIL_MAX || 8),
    standardHeaders: true,
    legacyHeaders: false
});

const queueRoutingNotificationsLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: Number(process.env.PUBLIC_FORMS_QUEUE_ROUTING_NOTIFICATIONS_MAX || 12),
    standardHeaders: true,
    legacyHeaders: false
});

function escapeHtmlEmail(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function formatPayloadCell(v) {
    if (v === null || v === undefined) return '—';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
}

function buildSubmissionSummaryEmailHtml(detail) {
    const pay = detail.payload && typeof detail.payload === 'object' && !Array.isArray(detail.payload)
        ? detail.payload
        : {};
    const rows = Object.entries(pay).map(([k, v]) => (
        `<tr><td style="padding:8px;border:1px solid #e5e7eb;font-weight:600;vertical-align:top;width:35%;">${
            escapeHtmlEmail(k)}</td><td style="padding:8px;border:1px solid #e5e7eb;vertical-align:top;">${
            escapeHtmlEmail(formatPayloadCell(v))}</td></tr>`
    )).join('');
    const subId = detail.SubmissionId ? String(detail.SubmissionId) : '';
    const reqNum = detail.RequestNumber != null ? String(detail.RequestNumber) : '';
    const match = detail.MemberMatchStatus != null ? String(detail.MemberMatchStatus) : '';
    const created = detail.CreatedDate ? new Date(detail.CreatedDate).toLocaleString() : '';
    return `<!DOCTYPE html><html><body style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111827;">
<h2 style="margin:0 0 12px;font-size:18px;">Form submission summary</h2>
<p style="margin:0 0 8px;"><strong>Form kind:</strong> ${escapeHtmlEmail(detail.FormKind || '')}</p>
<p style="margin:0 0 8px;"><strong>Submitted:</strong> ${escapeHtmlEmail(created)}</p>
${reqNum ? `<p style="margin:0 0 8px;"><strong>Request #:</strong> ${escapeHtmlEmail(reqNum)}</p>` : ''}
${match ? `<p style="margin:0 0 8px;"><strong>Member match:</strong> ${escapeHtmlEmail(match)}</p>` : ''}
${subId ? `<p style="margin:0 0 16px;font-size:12px;color:#6b7280;">Submission ID: ${escapeHtmlEmail(subId)}</p>` : ''}
<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;max-width:640px;">${
        rows || '<tr><td style="padding:8px;">No field data.</td></tr>'}</table>
<p style="margin-top:16px;font-size:12px;color:#6b7280;">Sent from your organization&apos;s admin tools. Contains information from a submitted form.</p>
</body></html>`;
}

function parseSubmissionListQuery(query) {
    return {
        memberMatchStatus: query.memberMatchStatus || undefined,
        from: query.from || undefined,
        to: query.to || undefined,
        formTemplateId: query.formTemplateId || undefined,
        formKind: query.formKind || undefined,
        resolutionStatus: query.resolutionStatus || undefined,
        source: query.source || undefined,
        firstName: query.firstName || undefined,
        lastName: query.lastName || undefined,
        q: query.q || undefined,
        page: query.page,
        limit: query.limit,
        cursorCreatedDate: query.cursorCreatedDate || undefined,
        cursorSubmissionId: query.cursorSubmissionId || undefined
    };
}

function csvEscape(val) {
    if (val === null || val === undefined) return '';
    const s = String(val);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
}

router.get('/templates', async (req, res) => {
    try {
        const tenantId = req.tenantId;
        await publicFormAdminService.ensureDefaultTemplatesForTenant(tenantId);
        const list = await publicFormAdminService.listTemplatesForTenant(tenantId);
        res.json({
            success: true,
            data: list,
            meta: {
                tenantId: String(tenantId),
                tenantName: req.tenantName || null
            }
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: 'Failed to list templates' });
    }
});

router.post('/templates', authorizeWrite, async (req, res) => {
    try {
        const title = req.body?.title;
        const kindLabelRaw = req.body?.kindLabel ?? req.body?.kind;
        const kindLabel = typeof kindLabelRaw === 'string' ? kindLabelRaw : '';
        if (!String(kindLabel).trim()) {
            return res.status(400).json({ success: false, message: 'kind (kindLabel) is required' });
        }
        const out = await publicFormAdminService.createBlankTemplate(
            req.tenantId,
            typeof title === 'string' ? title : undefined,
            kindLabel,
            req.user.UserId
        );
        res.status(201).json({ success: true, data: out });
    } catch (e) {
        console.error(e);
        res.status(400).json({ success: false, message: e.message || 'Failed to create form' });
    }
});

/**
 * POST /api/me/vendor/public-forms/templates/:formTemplateId/duplicate
 * Copies a template (all settings + latest definition) as a new unpublished
 * draft with " (Copy)" appended to the title.
 */
router.post('/templates/:formTemplateId/duplicate', authorizeWrite, async (req, res) => {
    try {
        const { formTemplateId } = req.params;
        if (!uuidRe.test(formTemplateId)) {
            return res.status(400).json({ success: false, message: 'Invalid id' });
        }
        const result = await publicFormAdminService.duplicateTemplate(
            req.tenantId,
            formTemplateId,
            req.user.UserId
        );
        if (!result.ok) {
            return res.status(404).json({ success: false, message: 'Not found' });
        }
        res.status(201).json({
            success: true,
            data: { formTemplateId: result.formTemplateId, versionNumber: result.versionNumber }
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: 'Failed to duplicate form' });
    }
});

/**
 * GET /api/me/vendor/public-forms/resolver-tenant-options?vendorId=<guid>
 * The tenants a vendor serves — pick-list for a form's "resolve members across
 * tenants" allow-list (ResolverTenantIds).
 */
router.get('/resolver-tenant-options', async (req, res) => {
    try {
        const vendorId = String(req.query.vendorId || '').trim();
        if (!uuidRe.test(vendorId)) {
            return res.status(400).json({ success: false, message: 'vendorId is required' });
        }
        const tenants = await vendorImportTenants.getImportEligibleTenantsForVendor(vendorId);
        res.json({
            success: true,
            data: (tenants || []).map((t) => ({ tenantId: t.tenantId, tenantName: t.tenantName }))
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: 'Failed to load tenants' });
    }
});

router.get('/templates/:formTemplateId', async (req, res) => {
    try {
        const { formTemplateId } = req.params;
        if (!uuidRe.test(formTemplateId)) {
            return res.status(400).json({ success: false, message: 'Invalid id' });
        }
        const detail = await publicFormAdminService.getTemplateDetailForTenant(req.tenantId, formTemplateId);
        if (!detail) return res.status(404).json({ success: false, message: 'Not found' });
        res.json({ success: true, data: detail });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: 'Failed to load template' });
    }
});

router.get('/templates/:formTemplateId/versions/:versionNumber', async (req, res) => {
    try {
        const { formTemplateId, versionNumber } = req.params;
        if (!uuidRe.test(formTemplateId)) {
            return res.status(400).json({ success: false, message: 'Invalid id' });
        }
        const row = await publicFormAdminService.getTemplateVersionDefinition(
            req.tenantId,
            formTemplateId,
            versionNumber
        );
        if (!row) return res.status(404).json({ success: false, message: 'Not found' });
        res.json({
            success: true,
            data: {
                definitionJson: row.DefinitionJson,
                versionNumber: row.VersionNumber,
                changeNote: row.ChangeNote,
                createdDate: row.CreatedDate
            }
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: 'Failed to load version' });
    }
});

router.patch('/templates/:formTemplateId', authorizeWrite, async (req, res) => {
    try {
        const { formTemplateId } = req.params;
        if (!uuidRe.test(formTemplateId)) {
            return res.status(400).json({ success: false, message: 'Invalid id' });
        }
        const ok = await publicFormAdminService.updateTemplateMeta(req.tenantId, formTemplateId, req.body);
        if (!ok) return res.status(404).json({ success: false, message: 'Not found' });
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(400).json({ success: false, message: e.message || 'Update failed' });
    }
});

router.delete('/templates/:formTemplateId', authorizeWrite, async (req, res) => {
    try {
        const { formTemplateId } = req.params;
        if (!uuidRe.test(formTemplateId)) {
            return res.status(400).json({ success: false, message: 'Invalid id' });
        }
        const result = await publicFormAdminService.deleteTemplate(req.tenantId, formTemplateId);
        if (!result.ok) {
            if (result.reason === 'has_submissions') {
                return res.status(409).json({
                    success: false,
                    message: 'Cannot delete: this form has submissions. Set it inactive instead.'
                });
            }
            return res.status(404).json({ success: false, message: 'Not found' });
        }
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: 'Failed to delete form' });
    }
});

/**
 * GET /api/me/vendor/public-forms/templates/:formTemplateId/preview-payload
 * Care-team preview — same shape as tenant-admin variant.
 */
router.get('/templates/:formTemplateId/preview-payload', async (req, res) => {
    try {
        const { formTemplateId } = req.params;
        if (!uuidRe.test(formTemplateId)) {
            return res.status(400).json({ success: false, message: 'Invalid id' });
        }
        const payload = await publicFormAdminService.getPreviewPayloadForTenant(req.tenantId, formTemplateId);
        if (!payload) {
            return res.status(404).json({ success: false, message: 'Not found' });
        }
        if (!payload.definitionJson) {
            return res.status(404).json({ success: false, message: 'No versions exist for this template yet' });
        }
        let definition;
        try {
            definition = JSON.parse(payload.definitionJson);
        } catch (parseErr) {
            console.error('preview-payload: definition JSON parse', parseErr);
            return res.status(500).json({ success: false, message: 'Invalid form definition' });
        }
        definition = await definitionWithAuthenticatedHeaderImage(definition);
        const defHeading = definition && typeof definition.title === 'string'
            ? definition.title.trim()
            : '';
        res.json({
            success: true,
            data: {
                formTemplateId: payload.template.FormTemplateId,
                title: defHeading || payload.template.Title || '',
                definition,
                versionNumber: payload.versionNumber,
                isDraftPreview: payload.isDraftPreview
            }
        });
    } catch (e) {
        console.error('preview-payload error:', e);
        res.status(500).json({ success: false, message: 'Failed to load preview' });
    }
});

router.post('/templates/:formTemplateId/publish', authorizeWrite, async (req, res) => {
    try {
        const { formTemplateId } = req.params;
        const versionNumber = parseInt(req.body.versionNumber, 10);
        if (!uuidRe.test(formTemplateId) || !versionNumber) {
            return res.status(400).json({ success: false, message: 'Invalid request' });
        }
        const ok = await publicFormAdminService.publishVersion(req.tenantId, formTemplateId, versionNumber);
        if (!ok) return res.status(404).json({ success: false, message: 'Template or version not found' });
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: 'Publish failed' });
    }
});

router.post(
    '/templates/:formTemplateId/header-image',
    authorizeWrite,
    (req, res, next) => {
        headerImageUpload.single('file')(req, res, (err) => {
            if (err) {
                return res.status(400).json({ success: false, message: err.message || 'Invalid file' });
            }
            next();
        });
    },
    async (req, res) => {
        try {
            const { formTemplateId } = req.params;
            if (!uuidRe.test(formTemplateId)) {
                return res.status(400).json({ success: false, message: 'Invalid id' });
            }
            if (!req.file) {
                return res.status(400).json({ success: false, message: 'file required (multipart field name: file)' });
            }
            const exists = await publicFormAdminService.getTemplateDetailForTenant(req.tenantId, formTemplateId);
            if (!exists) return res.status(404).json({ success: false, message: 'Not found' });

            const extByMime = {
                'image/jpeg': '.jpg',
                'image/png': '.png',
                'image/gif': '.gif',
                'image/webp': '.webp'
            };
            const ext = extByMime[req.file.mimetype] || '.bin';
            const blobName = `template-headers/${req.tenantId}/${formTemplateId}/${crypto.randomUUID()}${ext}`;
            const container = process.env.AZURE_STORAGE_PUBLIC_FORMS_CONTAINER || 'public-form-uploads';
            const url = await uploadToAzureBlob(req.file, container, blobName);
            res.status(201).json({ success: true, data: { url } });
        } catch (e) {
            console.error(e);
            res.status(500).json({ success: false, message: e.message || 'Upload failed' });
        }
    }
);

router.post('/templates/:formTemplateId/versions', authorizeWrite, async (req, res) => {
    try {
        const { formTemplateId } = req.params;
        if (!uuidRe.test(formTemplateId)) {
            return res.status(400).json({ success: false, message: 'Invalid id' });
        }
        const { definitionJson, changeNote } = req.body;
        if (!definitionJson || typeof definitionJson !== 'string') {
            return res.status(400).json({ success: false, message: 'definitionJson string required' });
        }
        const out = await publicFormAdminService.saveNewVersion(
            req.tenantId,
            formTemplateId,
            definitionJson,
            changeNote,
            req.user.UserId
        );
        if (!out) return res.status(404).json({ success: false, message: 'Not found' });
        res.status(201).json({ success: true, data: out });
    } catch (e) {
        console.error(e);
        res.status(400).json({ success: false, message: e.message || 'Save failed' });
    }
});

router.get('/submissions/export', submissionsListLimiter, async (req, res) => {
    try {
        const filters = parseSubmissionListQuery(req.query);
        const rows = await publicFormAdminService.listSubmissionsForExport(
            req.tenantId,
            filters,
            req.query.maxRows
        );
        const headers = [
            'SubmissionId',
            'FormTemplateId',
            'FormTitle',
            'CreatedDate',
            'MemberId',
            'MemberMatchStatus',
            'SubmittedMemberIdText',
            'PayloadFirstName',
            'PayloadLastName',
            'AnonymousLinkFirstViewedAt',
            'RequestNumber'
        ];
        const lines = [headers.join(',')];
        for (const r of rows) {
            lines.push([
                csvEscape(r.SubmissionId),
                csvEscape(r.FormTemplateId),
                csvEscape(r.FormTitle),
                csvEscape(r.CreatedDate),
                csvEscape(r.MemberId),
                csvEscape(r.MemberMatchStatus),
                csvEscape(r.SubmittedMemberIdText),
                csvEscape(r.PayloadFirstName),
                csvEscape(r.PayloadLastName),
                csvEscape(r.AnonymousLinkFirstViewedAt),
                csvEscape(r.RequestNumber)
            ].join(','));
        }
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="public-form-submissions.csv"');
        res.send(lines.join('\r\n'));
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: 'Failed to export submissions' });
    }
});

router.get('/submissions', submissionsListLimiter, async (req, res) => {
    try {
        const data = await publicFormAdminService.listSubmissions(
            req.tenantId,
            parseSubmissionListQuery(req.query)
        );
        res.json({ success: true, data });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: 'Failed to list submissions' });
    }
});

router.get('/submissions/:submissionId/submission-pdf', async (req, res) => {
    try {
        const { submissionId } = req.params;
        if (!uuidRe.test(submissionId)) {
            return res.status(400).json({ success: false, message: 'Invalid id' });
        }
        const detail = await publicFormAdminService.getSubmissionDetail(req.tenantId, submissionId);
        if (!detail) {
            return res.status(404).json({ success: false, message: 'Not found' });
        }
        const templateRow = await publicFormAdminService.getLatestDefinitionByTemplateId(req.tenantId, detail.FormTemplateId)
            || await publicFormAdminService.getPublishedDefinitionByTemplateId(detail.FormTemplateId);
        const result = await buildSubmissionPdfDownload(detail, templateRow, {
            includeAllFields: false,
            basenameSuffix: 'submission',
            templateMissingMessage: 'Form definition not found (no saved versions)'
        });
        return sendSubmissionPdfDownload(res, result);
    } catch (e) {
        console.error('submission-pdf', e);
        return res.status(500).json({ success: false, message: 'Failed to generate PDF' });
    }
});

router.get('/submissions/:submissionId/submission-pdf-complete', async (req, res) => {
    try {
        const { submissionId } = req.params;
        if (!uuidRe.test(submissionId)) {
            return res.status(400).json({ success: false, message: 'Invalid id' });
        }
        const detail = await publicFormAdminService.getSubmissionDetail(req.tenantId, submissionId);
        if (!detail) {
            return res.status(404).json({ success: false, message: 'Not found' });
        }
        const templateRow = await publicFormAdminService.getLatestDefinitionByTemplateId(req.tenantId, detail.FormTemplateId)
            || await publicFormAdminService.getPublishedDefinitionByTemplateId(detail.FormTemplateId);
        const result = await buildSubmissionPdfDownload(detail, templateRow, {
            includeAllFields: true,
            basenameSuffix: 'submission-complete',
            templateMissingMessage: 'Form definition not found (no saved versions)'
        });
        return sendSubmissionPdfDownload(res, result);
    } catch (e) {
        console.error('submission-pdf-complete', e);
        return res.status(500).json({ success: false, message: 'Failed to generate PDF' });
    }
});

router.get('/submissions/:submissionId', async (req, res) => {
    try {
        const { submissionId } = req.params;
        if (!uuidRe.test(submissionId)) {
            return res.status(400).json({ success: false, message: 'Invalid id' });
        }
        const row = await publicFormAdminService.getSubmissionDetail(req.tenantId, submissionId);
        if (!row) return res.status(404).json({ success: false, message: 'Not found' });
        const { PayloadEncrypted, PayloadIv, PayloadAuthTag, files, ...rest } = row;
        const filesWithSas = await Promise.all((files || []).map(async (f) => {
            const next = { ...f };
            if (next.BlobUrl && isBlobUrl(next.BlobUrl)) {
                try {
                    next.BlobUrl = await generateAuthenticatedUrl(next.BlobUrl);
                } catch (e) {
                    console.warn('public-forms vendor submission file SAS failed', e.message);
                }
            }
            return next;
        }));
        let fieldMeta = [];
        try {
            if (row.FormTemplateId) {
                const templateRow = await publicFormAdminService.getPublishedDefinitionByTemplateId(row.FormTemplateId);
                if (templateRow && templateRow.DefinitionJson) {
                    const def = JSON.parse(templateRow.DefinitionJson);
                    if (Array.isArray(def.fields)) {
                        fieldMeta = def.fields
                            .filter((f) => f && f.name && f.type !== 'static_html')
                            .map((f) => ({
                                name: String(f.name),
                                label: f.label ? String(f.label) : null,
                                type: f.type ? String(f.type) : null
                            }));
                    }
                }
            }
        } catch (metaErr) {
            console.warn('vendor submission: field metadata unavailable', metaErr.message);
        }
        res.json({ success: true, data: { ...rest, files: filesWithSas, fields: fieldMeta } });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: 'Failed to load submission' });
    }
});

router.post('/submissions/:submissionId/send-summary-email', sendSubmissionSummaryEmailLimiter, async (req, res) => {
    try {
        const { submissionId } = req.params;
        const toEmail = String(req.body?.toEmail || '').trim().toLowerCase();
        if (!uuidRe.test(submissionId)) {
            return res.status(400).json({ success: false, message: 'Invalid id' });
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(toEmail) || toEmail.length > 254) {
            return res.status(400).json({ success: false, message: 'Enter a valid email address' });
        }
        const detail = await publicFormAdminService.getSubmissionDetail(req.tenantId, submissionId);
        if (!detail) {
            return res.status(404).json({ success: false, message: 'Not found' });
        }
        let emailConfig = { tenantName: 'Organization', defaultFromEmail: process.env.DEFAULT_FROM_EMAIL || 'noreply@allaboard365.com' };
        try {
            emailConfig = await SendGridEmailService.getTenantEmailConfig(req.tenantId);
        } catch (e) {
            console.warn('send-summary-email tenant config', e.message);
        }
        const fromEmail = emailConfig.customFromAddress || emailConfig.defaultFromEmail
            || process.env.DEFAULT_FROM_EMAIL || 'noreply@allaboard365.com';
        const fromName = emailConfig.tenantName || 'AllAboard365';
        const html = buildSubmissionSummaryEmailHtml(detail);
        const text = `Form submission summary\nForm: ${detail.FormKind}\nSubmitted: ${detail.CreatedDate ? new Date(detail.CreatedDate).toISOString() : ''}\nSubmission: ${submissionId}\n\nSee HTML email for fields.`;
        await SendGridEmailService.sendEmail({
            tenantId: req.tenantId,
            to: toEmail,
            from: fromEmail,
            subject: `Form submission summary — ${detail.FormKind || 'Sharing form'}`.slice(0, 200),
            html,
            text,
            metadata: {
                fromName,
                emailType: 'public_form_submission_summary_forward'
            },
            categories: ['public-form', 'submission-summary']
        });
        res.json({ success: true, message: 'Summary sent' });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: e.message || 'Failed to send email' });
    }
});

router.get(
    '/submissions/:submissionId/routing-notification-defaults',
    async (req, res) => {
        try {
            const { submissionId } = req.params;
            if (!uuidRe.test(submissionId)) {
                return res.status(400).json({ success: false, message: 'Invalid id' });
            }
            const out = await publicFormAdminService.getRoutingNotificationDefaults(
                req.tenantId,
                submissionId
            );
            if (!out.success) {
                return res.status(404).json({ success: false, message: out.message || 'Not found' });
            }
            res.json({
                success: true,
                data: {
                    recipients: out.recipients || [],
                    tenantCustomDomain: out.tenantCustomDomain || null,
                    defaultAppBase: out.defaultAppBase || null
                }
            });
        } catch (e) {
            console.error(e);
            res.status(500).json({ success: false, message: e.message || 'Failed' });
        }
    }
);

router.post(
    '/submissions/:submissionId/queue-routing-notifications',
    queueRoutingNotificationsLimiter,
    async (req, res) => {
        try {
            const { submissionId } = req.params;
            if (!uuidRe.test(submissionId)) {
                return res.status(400).json({ success: false, message: 'Invalid id' });
            }
            let additionalRecipientEmails;
            if (Array.isArray(req.body?.additionalEmailsList)) {
                additionalRecipientEmails = req.body.additionalEmailsList.map((e) => String(e).trim()).filter(Boolean);
            } else if (typeof req.body?.additionalEmails === 'string' && req.body.additionalEmails.trim()) {
                additionalRecipientEmails = req.body.additionalEmails
                    .split(/[,;]/)
                    .map((s) => s.trim())
                    .filter(Boolean);
            }
            const replaceDefaults = req.body?.replaceDefaults === true;
            const linkBaseOverride =
                typeof req.body?.linkBaseOverride === 'string' ? req.body.linkBaseOverride : null;
            const out = await publicFormAdminService.queueRoutingNotificationsForSubmission(
                req.tenantId,
                submissionId,
                { additionalRecipientEmails, replaceDefaults, linkBaseOverride },
                req
            );
            if (!out.success && out.message === 'Not found') {
                return res.status(404).json({ success: false, message: out.message });
            }
            if (out.skipped) {
                return res.status(400).json({
                    success: false,
                    message: out.message || 'No recipients',
                    data: out
                });
            }
            res.json({ success: true, data: out });
        } catch (e) {
            console.error(e);
            res.status(500).json({ success: false, message: e.message || 'Failed to queue routing emails' });
        }
    }
);

/**
 * PATCH /api/me/vendor/public-forms/submissions/:submissionId/linkage
 * Forms-page redesign Slice D.1. Same shape + semantics as the
 * tenant-admin variant.
 */
router.patch('/submissions/:submissionId/linkage', async (req, res) => {
    try {
        const { submissionId } = req.params;
        if (!uuidRe.test(submissionId)) {
            return res.status(400).json({ success: false, message: 'Invalid id' });
        }
        const shareRequestId = req.body?.shareRequestId || null;
        const caseId = req.body?.caseId || null;
        const out = await publicFormAdminService.updateSubmissionLinkage(req.tenantId, submissionId, {
            shareRequestId,
            caseId
        });
        if (!out.ok) {
            const map = {
                not_found: { code: 404, msg: 'Submission not found' },
                no_member: { code: 409, msg: 'Resolve the submission to a member first' },
                mutually_exclusive: { code: 400, msg: 'Set only one of shareRequestId or caseId' },
                sr_not_found: { code: 404, msg: 'Share request not found for this tenant' }
            };
            const m = map[out.reason] || { code: 400, msg: 'Linkage update failed' };
            return res.status(m.code).json({ success: false, message: m.msg });
        }
        res.status(204).end();
    } catch (e) {
        console.error('linkage update error:', e);
        res.status(500).json({ success: false, message: 'Failed to update linkage' });
    }
});

router.post('/submissions/:submissionId/resolve-member', async (req, res) => {
    try {
        const { submissionId } = req.params;
        if (!uuidRe.test(submissionId)) {
            return res.status(400).json({ success: false, message: 'Invalid id' });
        }
        const out = await publicFormAdminService.resolveSubmissionMember(req.tenantId, submissionId);
        if (!out.success) return res.status(404).json(out);
        if (out.resolution && out.resolution.status === 'Matched' && out.resolution.memberId) {
            const detail = await publicFormAdminService.getSubmissionDetail(req.tenantId, submissionId);
            const tmplWrap = await publicFormAdminService.getTemplateDetailForTenant(req.tenantId, detail.FormTemplateId);
            const actorUserId = await getPublicFormsActorUserId();
            await linkSubmissionToShareWorkflow({
                submissionId,
                tenantId: req.tenantId,
                formTemplateId: detail.FormTemplateId,
                formKind: detail.FormKind,
                memberId: out.resolution.memberId,
                vendorIdOverride: tmplWrap?.template?.DefaultVendorId,
                payload: detail.payload || {},
                actorUserId
            });
        }
        res.json({ success: true, data: out });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: e.message || 'Resolve failed' });
    }
});

router.post('/submissions/:submissionId/set-member', async (req, res) => {
    try {
        const { submissionId } = req.params;
        const { memberId } = req.body;
        if (!uuidRe.test(submissionId) || !memberId || !uuidRe.test(memberId)) {
            return res.status(400).json({ success: false, message: 'Invalid request' });
        }
        const out = await publicFormAdminService.manuallySetMember(req.tenantId, submissionId, memberId);
        if (!out.success) return res.status(400).json(out);
        // If an unmatched "shell" SR/Case already exists for this submission, backfill
        // the member into it (clearing NeedsMemberMatch) instead of creating a duplicate.
        const backfill = await backfillUnmatchedShellMember({ submissionId, memberId });
        let linkResult = { success: true, ...backfill };
        if (!backfill.backfilled) {
            const detail = await publicFormAdminService.getSubmissionDetail(req.tenantId, submissionId);
            const tmplWrap = await publicFormAdminService.getTemplateDetailForTenant(req.tenantId, detail.FormTemplateId);
            const actorUserId = await getPublicFormsActorUserId();
            linkResult = await linkSubmissionToShareWorkflow({
                submissionId,
                tenantId: req.tenantId,
                formTemplateId: detail.FormTemplateId,
                formKind: detail.FormKind,
                memberId,
                vendorIdOverride: tmplWrap?.template?.DefaultVendorId,
                payload: detail.payload || {},
                actorUserId
            });
        }
        res.json({ success: true, data: { ...out, linkResult } });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: 'Failed' });
    }
});

router.post('/submissions/:submissionId/retry-link', async (req, res) => {
    try {
        const { submissionId } = req.params;
        if (!uuidRe.test(submissionId)) {
            return res.status(400).json({ success: false, message: 'Invalid id' });
        }
        const out = await publicFormAdminService.retryLinkSubmission(req.tenantId, submissionId, req);
        res.json({ success: !!out.success, data: out });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: e.message || 'Retry failed' });
    }
});

// --- Invitation endpoints ("send to member" flow) ----------------------------

/**
 * POST /api/me/vendor/public-forms/:formTemplateId/invitations
 *
 * Body: { memberId, mode, linkedShareRequestId?, linkedCaseId?, recipientEmail, deliveryMethod }
 * Returns: { invitationId, url, expiresAt, emailResult? }
 */
router.post('/templates/:formTemplateId/invitations', async (req, res) => {
    try {
        const { formTemplateId } = req.params;
        if (!uuidRe.test(formTemplateId)) {
            return res.status(400).json({ success: false, message: 'Invalid form template id' });
        }
        const { memberId, mode, linkedShareRequestId, linkedCaseId, recipientEmail, deliveryMethod } = req.body || {};
        if (!uuidRe.test(String(memberId || ''))) {
            return res.status(400).json({ success: false, message: 'Invalid memberId' });
        }
        if (linkedShareRequestId && !uuidRe.test(String(linkedShareRequestId))) {
            return res.status(400).json({ success: false, message: 'Invalid linkedShareRequestId' });
        }
        if (linkedCaseId && !uuidRe.test(String(linkedCaseId))) {
            return res.status(400).json({ success: false, message: 'Invalid linkedCaseId' });
        }
        const tmplWrap = await publicFormAdminService.getTemplateDetailForTenant(req.tenantId, formTemplateId);
        if (!tmplWrap || !tmplWrap.template) {
            return res.status(404).json({ success: false, message: 'Template not found' });
        }
        const t = tmplWrap.template;
        if (mode === 'targeted' && !t.AllowTargeted) {
            return res.status(400).json({ success: false, message: 'This form does not allow targeted (no-login) delivery.' });
        }
        if (mode === 'authenticated' && !t.AllowAuthenticated) {
            return res.status(400).json({ success: false, message: 'This form does not allow authenticated delivery.' });
        }
        if (mode !== 'targeted' && mode !== 'authenticated') {
            return res.status(400).json({ success: false, message: 'mode must be targeted or authenticated' });
        }

        const { invitationId, token, expiresAt } = await publicFormInvitationService.createInvitation({
            tenantId: req.tenantId,
            formTemplateId,
            memberId,
            mode,
            linkedShareRequestId: linkedShareRequestId || null,
            linkedCaseId: linkedCaseId || null,
            deliveryMethod,
            sentByUserId: req.user.UserId,
            sentToEmail: recipientEmail
        });
        const url = publicFormInvitationService.buildInvitationUrl(token, { req });

        let emailResult = null;
        if (deliveryMethod === 'email' || deliveryMethod === 'both') {
            const greeting = await publicFormInvitationService.getTargetedGreeting({ memberId, sentToEmail: recipientEmail });
            emailResult = await publicFormInvitationService.sendInvitationEmail({
                sendGridService: SendGridEmailService,
                recipientEmail,
                recipientFirstName: greeting.firstName,
                formTitle: t.Title,
                invitationUrl: url,
                mode,
                expiresAt,
                tenantName: tmplWrap.tenantName || null
            });
        }

        return res.status(201).json({ success: true, data: { invitationId, url, expiresAt, emailResult } });
    } catch (e) {
        console.error('createInvitation error:', e);
        return res.status(500).json({ success: false, message: e.message || 'Failed to create invitation' });
    }
});

/**
 * GET /api/me/vendor/public-forms/:formTemplateId/invitations
 */
/**
 * POST /api/me/vendor/public-forms/templates/:formTemplateId/send-anonymous-link
 * Vendor mirror of the anonymous-link send (B-012). No invitation row,
 * no token, no member binding.
 */
router.post('/templates/:formTemplateId/send-anonymous-link', async (req, res) => {
    try {
        const { formTemplateId } = req.params;
        if (!uuidRe.test(formTemplateId)) {
            return res.status(400).json({ success: false, message: 'Invalid template id' });
        }
        const recipientEmail = String(req.body?.recipientEmail || '').trim();
        if (!recipientEmail || !/^.+@.+\..+$/.test(recipientEmail)) {
            return res.status(400).json({ success: false, message: 'Valid recipientEmail required' });
        }
        const tpl = await publicFormAdminService.getTemplateDetailForTenant(req.tenantId, formTemplateId);
        if (!tpl) {
            return res.status(404).json({ success: false, message: 'Template not found' });
        }
        if (!tpl.template.AllowAnonymous) {
            return res.status(409).json({
                success: false,
                message: 'Template does not allow anonymous submissions'
            });
        }
        if (!tpl.template.IsPublished) {
            return res.status(409).json({
                success: false,
                message: 'Template is not published yet'
            });
        }
        const { resolveSubmissionLinkBase } = require('../../../services/publicFormNotifyService');
        const base = resolveSubmissionLinkBase(req) || 'http://localhost:5173';
        const formUrl = `${base}/forms/${formTemplateId}`;
        let tenantName = '';
        try {
            const cfg = await SendGridEmailService.getTenantEmailConfig(req.tenantId);
            tenantName = cfg?.tenantName || '';
        } catch {
            // Best-effort; email still sends with a generic greeting.
        }
        const result = await publicFormInvitationService.sendAnonymousLinkEmail({
            sendGridService: SendGridEmailService,
            recipientEmail,
            formTitle: tpl.template.Title,
            formUrl,
            tenantName,
            customMessage: req.body?.message
        });
        if (!result.sent) {
            return res.status(502).json({
                success: false,
                message: result.error || 'Email send failed'
            });
        }
        res.json({ success: true });
    } catch (e) {
        console.error('send-anonymous-link error:', e);
        res.status(500).json({ success: false, message: 'Failed to send anonymous link' });
    }
});

router.get('/templates/:formTemplateId/invitations', async (req, res) => {
    try {
        const { formTemplateId } = req.params;
        if (!uuidRe.test(formTemplateId)) {
            return res.status(400).json({ success: false, message: 'Invalid form template id' });
        }
        const rows = await publicFormInvitationService.listForTemplate({
            tenantId: req.tenantId,
            formTemplateId
        });
        return res.json({ success: true, data: rows });
    } catch (e) {
        console.error('listInvitations error:', e);
        return res.status(500).json({ success: false, message: 'Failed to list invitations' });
    }
});

/**
 * GET /api/me/vendor/public-forms/invitations/:invitationId
 */
router.get('/invitations/:invitationId', async (req, res) => {
    try {
        const { invitationId } = req.params;
        if (!uuidRe.test(invitationId)) {
            return res.status(400).json({ success: false, message: 'Invalid invitation id' });
        }
        const row = await publicFormInvitationService.getById({
            invitationId,
            tenantId: req.tenantId
        });
        if (!row) return res.status(404).json({ success: false, message: 'Not found' });
        return res.json({ success: true, data: row });
    } catch (e) {
        console.error('getInvitation error:', e);
        return res.status(500).json({ success: false, message: 'Failed' });
    }
});

/**
 * DELETE /api/me/vendor/public-forms/invitations/:invitationId
 */
/**
 * POST /api/me/vendor/public-forms/invitations/:invitationId/renew
 * Vendor mirror of the renew flow (B-028).
 */
router.post('/invitations/:invitationId/renew', async (req, res) => {
    try {
        const { invitationId } = req.params;
        if (!uuidRe.test(invitationId)) {
            return res.status(400).json({ success: false, message: 'Invalid invitation id' });
        }
        const deliveryMethod = req.body?.deliveryMethod === 'email' ? 'email' : 'copy';
        const out = await publicFormInvitationService.renewInvitation({
            invitationId,
            tenantId: req.tenantId,
            sentByUserId: req.user.UserId,
            deliveryMethod
        });
        if (!out.ok) {
            const map = {
                not_found: { code: 404, msg: 'Invitation not found' },
                no_recipient: { code: 409, msg: 'Cannot renew: original invitation has no recipient email' }
            };
            const m = map[out.reason] || { code: 400, msg: 'Renew failed' };
            return res.status(m.code).json({ success: false, message: m.msg });
        }
        const url = publicFormInvitationService.buildInvitationUrl(out.token, { req });
        let emailResult = null;
        if (deliveryMethod === 'email') {
            try {
                const tmplWrap = await publicFormAdminService.getTemplateDetailForTenant(req.tenantId, out.formTemplateId);
                const greeting = await publicFormInvitationService.getTargetedGreeting({
                    memberId: null,
                    sentToEmail: out.sentToEmail
                });
                emailResult = await publicFormInvitationService.sendInvitationEmail({
                    sendGridService: SendGridEmailService,
                    recipientEmail: out.sentToEmail,
                    recipientFirstName: greeting?.firstName,
                    formTitle: tmplWrap?.template?.Title,
                    invitationUrl: url,
                    mode: out.mode,
                    expiresAt: out.expiresAt,
                    tenantName: tmplWrap?.tenantName || null
                });
            } catch (emailErr) {
                console.warn('renew invitation: email send failed', emailErr.message);
                emailResult = { sent: false, error: emailErr.message };
            }
        }
        res.json({
            success: true,
            data: {
                invitationId: out.invitationId,
                url,
                expiresAt: out.expiresAt,
                emailResult
            }
        });
    } catch (e) {
        console.error('renew invitation error:', e);
        res.status(500).json({ success: false, message: 'Failed to renew invitation' });
    }
});

/**
 * PATCH /api/me/vendor/public-forms/invitations/:invitationId
 * Extend an invitation's expiry. Body: { expiresAt: ISOString }.
 * Forms-page redesign punch-list B-015.
 */
router.patch('/invitations/:invitationId', async (req, res) => {
    try {
        const { invitationId } = req.params;
        if (!uuidRe.test(invitationId)) {
            return res.status(400).json({ success: false, message: 'Invalid invitation id' });
        }
        const expiresAt = req.body?.expiresAt;
        if (!expiresAt) {
            return res.status(400).json({ success: false, message: 'expiresAt is required' });
        }
        const out = await publicFormInvitationService.updateExpiry({
            invitationId,
            tenantId: req.tenantId,
            expiresAt
        });
        if (!out.ok) {
            const map = {
                not_found: { code: 404, msg: 'Invitation not found' },
                revoked: { code: 409, msg: 'Cannot extend a revoked invitation' },
                invalid_date: { code: 400, msg: 'Invalid expiresAt date' },
                past: { code: 400, msg: 'expiresAt must be in the future' }
            };
            const m = map[out.reason] || { code: 400, msg: 'Extend failed' };
            return res.status(m.code).json({ success: false, message: m.msg });
        }
        res.json({ success: true, data: { expiresAt: out.expiresAt } });
    } catch (e) {
        console.error('extend invitation error:', e);
        res.status(500).json({ success: false, message: 'Failed to extend invitation' });
    }
});

router.delete('/invitations/:invitationId', async (req, res) => {
    try {
        const { invitationId } = req.params;
        if (!uuidRe.test(invitationId)) {
            return res.status(400).json({ success: false, message: 'Invalid invitation id' });
        }
        const out = await publicFormInvitationService.revokeInvitation({
            invitationId,
            tenantId: req.tenantId
        });
        if (!out.ok) return res.status(404).json({ success: false, message: out.reason });
        return res.status(204).end();
    } catch (e) {
        console.error('revokeInvitation error:', e);
        return res.status(500).json({ success: false, message: 'Failed' });
    }
});

module.exports = router;
