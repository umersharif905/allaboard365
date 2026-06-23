const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { uploadToAzureBlob } = require('../uploads');
const { generateAuthenticatedUrl, isBlobUrl } = require('../uploads');
const publicFormAdminService = require('../../services/publicFormAdminService');
const publicFormInvitationService = require('../../services/publicFormInvitationService');
const { definitionWithAuthenticatedHeaderImage } = require('../../services/publicFormDefinitionSas');
const { createSubmissionFromPublicRequest } = require('../../services/publicFormSubmissionService');
const { buildSubmissionPdfDownload, sendSubmissionPdfDownload } = require('../../services/publicFormSubmissionPdfDownload');
const { appBaseUrl } = require('../../services/publicFormNotifyService');
const { MAX_UPLOAD_FILE_BYTES } = require('../../constants/uploadLimits');

const router = express.Router();

const uuidRe = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

const ALLOWED_MIME_TYPES = new Set([
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/jpeg',
    'image/pjpeg',
    'image/png',
    'image/gif',
    'image/webp',
    // iPhone camera roll (HEIC/HEIF, including multi-image sequences)
    'image/heic',
    'image/heif',
    'image/heic-sequence',
    'image/heif-sequence'
]);

const ALLOWED_UPLOAD_EXTENSIONS = new Set([
    '.pdf',
    '.doc',
    '.docx',
    '.jpg',
    '.jpeg',
    '.png',
    '.gif',
    '.webp',
    '.heic',
    '.heif'
]);

function extensionOf(filename) {
    const name = String(filename || '').toLowerCase();
    const dot = name.lastIndexOf('.');
    return dot >= 0 ? name.slice(dot) : '';
}

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_FILE_BYTES, files: 20 },
    fileFilter: (req, file, cb) => {
        const mime = String(file.mimetype || '').toLowerCase();
        if (ALLOWED_MIME_TYPES.has(mime)) return cb(null, true);
        // Some browsers (esp. drag-and-drop, older Safari) send a generic
        // `application/octet-stream` even for PDFs/Word/images. Accept it when
        // the filename extension is one of our known-good types.
        if (mime === 'application/octet-stream' || mime === '') {
            const ext = extensionOf(file.originalname);
            if (ALLOWED_UPLOAD_EXTENSIONS.has(ext)) return cb(null, true);
        }
        cb(new Error(`File type not allowed: ${file.mimetype || 'unknown'}`));
    }
});

/**
 * GET /api/public/forms/submissions/:token
 * Anonymous data view link (tokenized, 30-day expiry).
 */
router.get('/submissions/:token', async (req, res) => {
    try {
        const token = String(req.params.token || '').trim();
        if (!/^[a-fA-F0-9]{64}$/.test(token)) {
            return res.status(400).json({ success: false, message: 'Invalid submission access token' });
        }
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        const detail = await publicFormAdminService.getSubmissionDetailByPublicTokenHash(tokenHash);
        if (!detail) {
            return res.status(404).json({ success: false, message: 'Submission link is invalid or expired' });
        }

        let viewTracking = null;
        try {
            viewTracking = await publicFormAdminService.recordAnonymousSubmissionFirstView(detail.SubmissionId);
        } catch (viewErr) {
            console.warn('recordAnonymousSubmissionFirstView', viewErr.message);
        }
        const firstViewAt = viewTracking?.anonymousLinkFirstViewedAt || detail.AnonymousLinkFirstViewedAt || null;
        const createdAt = viewTracking?.createdDate || detail.CreatedDate || null;
        let secondsFromSubmitToFirstView = null;
        if (firstViewAt && createdAt) {
            secondsFromSubmitToFirstView = Math.max(
                0,
                Math.round((new Date(firstViewAt).getTime() - new Date(createdAt).getTime()) / 1000)
            );
        }

        // Include field metadata (label, type, order) so the viewer can
        // render human-friendly labels instead of raw payload keys.
        let fieldMeta = [];
        try {
            const templateRow = await publicFormAdminService.getPublishedDefinitionByTemplateId(detail.FormTemplateId);
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
        } catch (metaErr) {
            console.warn('public forms submission: field metadata unavailable', metaErr.message);
        }

        const files = await Promise.all((detail.files || []).map(async (f) => {
            const next = { ...f };
            if (next.BlobUrl && isBlobUrl(next.BlobUrl)) {
                try {
                    next.BlobUrl = await generateAuthenticatedUrl(next.BlobUrl);
                } catch (e) {
                    console.warn('public submission file SAS generation failed', e.message);
                }
            }
            return next;
        }));

        return res.json({
            success: true,
            data: {
                submissionId: detail.SubmissionId,
                formTemplateId: detail.FormTemplateId,
                formKind: detail.FormKind,
                title: detail.FormTitle || null,
                createdDate: detail.CreatedDate,
                memberMatchStatus: detail.MemberMatchStatus,
                submittedMemberIdText: detail.SubmittedMemberIdText,
                shareRequestId: detail.ShareRequestId,
                requestNumber: detail.RequestNumber || null,
                anonymousLinkFirstViewedAt: firstViewAt,
                secondsFromSubmitToFirstView,
                payload: detail.payload || {},
                fields: fieldMeta,
                files: files.map((f) => ({
                    fileId: f.FileId,
                    originalFileName: f.OriginalFileName,
                    contentType: f.ContentType,
                    fileSizeBytes: f.FileSizeBytes,
                    blobUrl: f.BlobUrl,
                    filePurpose: f.FilePurpose || null
                }))
            }
        });
    } catch (e) {
        console.error('public forms submission link GET', e);
        return res.status(500).json({ success: false, message: 'Failed to load submission data' });
    }
});

/**
 * GET /api/public/forms/submissions/:token/submission-pdf
 * Same on-demand PDF as tenant-admin download (token proves access).
 */
router.get('/submissions/:token/submission-pdf', async (req, res) => {
    try {
        const token = String(req.params.token || '').trim();
        if (!/^[a-fA-F0-9]{64}$/.test(token)) {
            return res.status(400).json({ success: false, message: 'Invalid submission access token' });
        }
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        const detail = await publicFormAdminService.getSubmissionDetailByPublicTokenHash(tokenHash);
        if (!detail) {
            return res.status(404).json({ success: false, message: 'Submission link is invalid or expired' });
        }
        const templateRow = await publicFormAdminService.getPublishedDefinitionByTemplateId(detail.FormTemplateId);
        const result = await buildSubmissionPdfDownload(detail, templateRow, {
            includeAllFields: false,
            basenameSuffix: 'submission',
            templateMissingMessage: 'Published form definition not found (form may be unpublished)'
        });
        return sendSubmissionPdfDownload(res, result);
    } catch (e) {
        console.error('public forms submission-pdf', e);
        return res.status(500).json({ success: false, message: 'Failed to generate PDF' });
    }
});

/**
 * GET /api/public/forms/submissions/:token/submission-pdf-complete
 * Complete PDF — ignores includeInPdf flags, every field appears.
 */
router.get('/submissions/:token/submission-pdf-complete', async (req, res) => {
    try {
        const token = String(req.params.token || '').trim();
        if (!/^[a-fA-F0-9]{64}$/.test(token)) {
            return res.status(400).json({ success: false, message: 'Invalid submission access token' });
        }
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        const detail = await publicFormAdminService.getSubmissionDetailByPublicTokenHash(tokenHash);
        if (!detail) {
            return res.status(404).json({ success: false, message: 'Submission link is invalid or expired' });
        }
        const templateRow = await publicFormAdminService.getPublishedDefinitionByTemplateId(detail.FormTemplateId);
        const result = await buildSubmissionPdfDownload(detail, templateRow, {
            includeAllFields: true,
            basenameSuffix: 'submission-complete',
            templateMissingMessage: 'Published form definition not found'
        });
        return sendSubmissionPdfDownload(res, result);
    } catch (e) {
        console.error('public forms submission-pdf-complete', e);
        return res.status(500).json({ success: false, message: 'Failed to generate PDF' });
    }
});

/**
 * GET /api/public/forms/:formTemplateId
 * Published definition for anonymous rendering (no PHI).
 */
router.get('/:formTemplateId', async (req, res) => {
    try {
        const { formTemplateId } = req.params;
        if (!uuidRe.test(formTemplateId)) {
            return res.status(400).json({ success: false, message: 'Invalid form id' });
        }
        const row = await publicFormAdminService.getPublishedDefinitionByTemplateId(formTemplateId);
        if (!row) {
            return res.status(404).json({ success: false, message: 'Form not found or not published' });
        }
        const base = appBaseUrl();
        const embedUrl = base ? `${base}/forms/${formTemplateId}` : `/forms/${formTemplateId}`;
        let definition;
        try {
            definition = JSON.parse(row.DefinitionJson);
        } catch (parseErr) {
            console.error('public forms definition JSON parse', parseErr);
            return res.status(500).json({ success: false, message: 'Invalid form definition' });
        }
        definition = await definitionWithAuthenticatedHeaderImage(definition);
        const defHeading =
            definition && typeof definition.title === 'string' ? definition.title.trim() : '';
        const effectiveTitle = defHeading || row.Title || '';
        const iframeSafeTitle = effectiveTitle.replace(/"/g, '&quot;');
        const iframeSnippet = `<iframe src="${embedUrl}" title="${iframeSafeTitle}" width="100%" height="1200" style="border:0;" loading="lazy"></iframe>`;
        res.json({
            success: true,
            data: {
                formTemplateId: row.FormTemplateId,
                tenantId: row.TenantId,
                tenantName: row.TenantName,
                formKind: row.FormKind,
                title: effectiveTitle,
                allowedFrameAncestors: row.AllowedFrameAncestors,
                definition,
                embedUrl,
                iframeSnippet
            }
        });
    } catch (e) {
        console.error('public forms GET', e);
        res.status(500).json({ success: false, message: 'Failed to load form' });
    }
});

/**
 * POST /api/public/forms/:formTemplateId/submit
 * multipart: field "payload" = JSON string; optional files
 */
router.post('/:formTemplateId/submit', upload.any(), async (req, res) => {
    try {
        const { formTemplateId } = req.params;
        if (!uuidRe.test(formTemplateId)) {
            return res.status(400).json({ success: false, message: 'Invalid form id' });
        }
        const templateRow = await publicFormAdminService.getPublishedDefinitionByTemplateId(formTemplateId);
        if (!templateRow) {
            return res.status(404).json({ success: false, message: 'Form not found or not published' });
        }
        let payload;
        try {
            payload = JSON.parse(req.body.payload || '{}');
        } catch {
            return res.status(400).json({ success: false, message: 'Invalid payload JSON' });
        }
        const result = await createSubmissionFromPublicRequest(
            req,
            templateRow,
            payload,
            req.files || [],
            uploadToAzureBlob
        );
        res.status(201).json({
            success: true,
            message: 'Your request was received. If you do not hear from us, contact support.',
            data: result
        });
    } catch (e) {
        const status = e.statusCode || 500;
        if (status >= 500) console.error('❌ public forms submit', e);
        const errCode = (typeof e.code === 'string' && e.code)
            || (typeof e.name === 'string' && e.name !== 'Error' && e.name)
            || (status >= 500 ? 'INTERNAL_ERROR' : 'SUBMISSION_REJECTED');
        let message;
        if (status >= 400 && status < 500 && typeof e.message === 'string' && e.message.trim()) {
            message = e.message;
        } else if (status >= 500 && typeof e.message === 'string' && e.message.trim()) {
            message = `Submission failed: ${e.message}`;
        } else {
            message = `Submission failed: ${errCode}`;
        }
        res.status(status).json({
            success: false,
            message,
            error: { message, code: errCode }
        });
    }
});

// --- Invitation endpoints (recipient side of "send to member" flow) -----------

const TOKEN_RE = /^[0-9a-f]{64}$/i;

/**
 * GET /api/public/forms/invitations/:token/meta
 *
 * Lightweight, mode-aware lookup. The frontend InvitationRouter calls this
 * first to decide whether to render the targeted form inline or redirect to
 * /login. Returns ONLY { mode, formTitle, expiresAt, exists } — never returns
 * recipient identity, member info, or SR/Case linkage. On any failure
 * (expired / revoked / invalid token) returns { exists: false } with 410.
 */
router.get('/invitations/:token/meta', async (req, res) => {
    try {
        const { token } = req.params;
        if (!TOKEN_RE.test(String(token || ''))) {
            return res.status(410).json({ success: false, exists: false, message: 'This link is no longer valid.' });
        }
        const invitation = await publicFormInvitationService.findActiveByToken(token);
        if (!invitation) {
            return res.status(410).json({ success: false, exists: false, message: 'This link is no longer valid.' });
        }
        // Fetch only the template title — keep this query minimal.
        const tmplWrap = await publicFormAdminService.getTemplateDetailForTenant(
            invitation.tenantId,
            invitation.formTemplateId
        );
        if (!tmplWrap || !tmplWrap.template) {
            return res.status(410).json({ success: false, exists: false, message: 'This link is no longer valid.' });
        }
        return res.json({
            success: true,
            data: {
                exists: true,
                mode: invitation.mode,
                formTitle: tmplWrap.template.Title || '',
                expiresAt: invitation.expiresAt
            }
        });
    } catch (e) {
        console.error('GET invitations meta error:', e);
        return res.status(410).json({ success: false, exists: false, message: 'This link is no longer valid.' });
    }
});

/**
 * POST /api/public/forms/invitations/:token/submit
 *
 * Recipient-side submit for a TARGETED (no-login) invitation. Re-validates the
 * invitation gate (active + targeted), then writes the submission with
 * MemberId/InvitationId/AuthMode/ShareRequestId/CaseId pre-set from the
 * invitation row. Skips the auto member-resolver (member is already known).
 * Stamps invitation.FirstUsedAt on first submit (idempotent, multi-use within
 * expiry).
 */
router.post('/invitations/:token/submit', upload.any(), async (req, res) => {
    try {
        const { token } = req.params;
        if (!TOKEN_RE.test(String(token || ''))) {
            return res.status(410).json({ success: false, message: 'This link is no longer valid.' });
        }
        const invitation = await publicFormInvitationService.findActiveByToken(token);
        if (!invitation) {
            return res.status(410).json({ success: false, message: 'This link is no longer valid.' });
        }
        if (invitation.mode !== 'targeted') {
            return res.status(403).json({ success: false, message: 'This link requires authentication.' });
        }
        const templateRow = await publicFormAdminService.getPublishedDefinitionByTemplateId(invitation.formTemplateId);
        if (!templateRow || String(templateRow.TenantId).toLowerCase() !== String(invitation.tenantId).toLowerCase()) {
            return res.status(409).json({ success: false, message: 'This form is currently unavailable. Contact your care team.' });
        }
        let payload;
        try {
            payload = JSON.parse(req.body.payload || '{}');
        } catch {
            return res.status(400).json({ success: false, message: 'Invalid payload JSON' });
        }
        const result = await createSubmissionFromPublicRequest(
            req,
            templateRow,
            payload,
            req.files || [],
            uploadToAzureBlob,
            { invitation, authMode: 'targeted' }
        );
        res.status(201).json({
            success: true,
            message: 'Your form was received.',
            data: result
        });
    } catch (e) {
        const status = e.statusCode || 500;
        if (status >= 500) console.error('❌ public forms invitation submit', e);
        const errCode = (typeof e.code === 'string' && e.code)
            || (typeof e.name === 'string' && e.name !== 'Error' && e.name)
            || (status >= 500 ? 'INTERNAL_ERROR' : 'SUBMISSION_REJECTED');
        let message;
        if (status >= 400 && status < 500 && typeof e.message === 'string' && e.message.trim()) {
            message = e.message;
        } else if (status >= 500 && typeof e.message === 'string' && e.message.trim()) {
            message = `Submission failed: ${e.message}`;
        } else {
            message = `Submission failed: ${errCode}`;
        }
        res.status(status).json({
            success: false,
            message,
            error: { message, code: errCode }
        });
    }
});

/**
 * GET /api/public/forms/invitations/:token
 *
 * Full payload for the TARGETED (no-login) flow only. Returns form definition,
 * recipient greeting (firstName + sentToEmail only), and a few audit metadata
 * fields. For authenticated-mode invitations, returns 403 to force the
 * frontend through /login + /api/me/member/forms/invitations/:token.
 */
router.get('/invitations/:token', async (req, res) => {
    try {
        const { token } = req.params;
        if (!TOKEN_RE.test(String(token || ''))) {
            return res.status(410).json({ success: false, message: 'This link is no longer valid.' });
        }
        const invitation = await publicFormInvitationService.findActiveByToken(token);
        if (!invitation) {
            return res.status(410).json({ success: false, message: 'This link is no longer valid.' });
        }
        if (invitation.mode !== 'targeted') {
            return res.status(403).json({ success: false, message: 'This link requires authentication.' });
        }
        const publishedRow = await publicFormAdminService.getPublishedDefinitionByTemplateId(invitation.formTemplateId);
        if (!publishedRow || String(publishedRow.TenantId).toLowerCase() !== String(invitation.tenantId).toLowerCase()) {
            return res.status(409).json({ success: false, message: 'This form is currently unavailable. Contact your care team.' });
        }
        // Server-side resolved header-image SAS, same as the anonymous public
        // GET path. NOTE: definitionWithAuthenticatedHeaderImage expects a
        // parsed object — it returns its input unchanged when handed a string,
        // which silently sends raw JSON to the client and crashes
        // PublicFormView's def.title.trim().
        let definition;
        try {
            definition = JSON.parse(publishedRow.DefinitionJson || '{}');
        } catch (parseErr) {
            console.error('targeted invitation: definition JSON parse', parseErr);
            return res.status(500).json({ success: false, message: 'Invalid form definition' });
        }
        definition = await definitionWithAuthenticatedHeaderImage(definition);
        const greeting = await publicFormInvitationService.getTargetedGreeting(invitation);
        return res.json({
            success: true,
            data: {
                formTitle: publishedRow.Title || '',
                formDefinition: definition,
                greeting: {
                    firstName: greeting.firstName,
                    sentToEmail: greeting.sentToEmail
                },
                expiresAt: invitation.expiresAt,
                invitationId: invitation.invitationId
            }
        });
    } catch (e) {
        console.error('GET invitations (targeted) error:', e);
        return res.status(410).json({ success: false, message: 'This link is no longer valid.' });
    }
});

module.exports = router;
