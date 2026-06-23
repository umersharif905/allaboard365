// Member-authenticated invitation flow.
//
// GET  /api/me/member/forms/invitations/:token         → load form + prefill
// POST /api/me/member/forms/invitations/:token/submit  → submit as the
//                                                          authenticated member
//
// Auth: the parent router (/api/me/member) already runs the JWT auth middleware
// and gates on roles `['Member', 'SysAdmin', 'TenantAdmin', 'Agent',
// 'AgencyOwner', 'GroupAdmin']`. For invitation flows we tighten that to
// Member-only at the handler — admins clicking a recipient link should NOT
// submit on the member's behalf.
//
// Spec: docs/superpowers/specs/2026-05-13-forms-redesign/design.md §4

const express = require('express');
const multer = require('multer');
const { getPool, sql } = require('../../../config/database');
const crypto = require('crypto');
const { uploadToAzureBlob, deleteAzureBlob } = require('../../uploads');
const PUBLIC_FORMS_CONTAINER = process.env.AZURE_STORAGE_PUBLIC_FORMS_CONTAINER || 'public-form-uploads';
const { MAX_UPLOAD_FILE_BYTES } = require('../../../constants/uploadLimits');
const publicFormAdminService = require('../../../services/publicFormAdminService');
const publicFormInvitationService = require('../../../services/publicFormInvitationService');
const { definitionWithAuthenticatedHeaderImage } = require('../../../services/publicFormDefinitionSas');
const { createSubmissionFromPublicRequest } = require('../../../services/publicFormSubmissionService');
const { buildPrefillForMember } = require('../../../services/publicFormInvitationPrefillService');
const { getPriorProvidersForMember, resolveFormVendorId } = require('../../../services/priorProviderService');
const publicFormDraftService = require('../../../services/publicFormDraftService');

const router = express.Router();

const TOKEN_RE = /^[0-9a-f]{64}$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ALLOWED_MIME_TYPES = new Set([
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/jpeg',
    'image/pjpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/heic',
    'image/heif',
    'image/heic-sequence',
    'image/heif-sequence'
]);
const ALLOWED_UPLOAD_EXTENSIONS = new Set([
    '.pdf', '.doc', '.docx', '.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif'
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
        if (mime === 'application/octet-stream' || mime === '') {
            const ext = extensionOf(file.originalname);
            if (ALLOWED_UPLOAD_EXTENSIONS.has(ext)) return cb(null, true);
        }
        cb(new Error(`File type not allowed: ${file.mimetype || 'unknown'}`));
    }
});

/**
 * Resolve which oe.Members row(s) the authenticated user owns. A user can be
 * primary in their own household plus a dependent in another household (rare,
 * but the schema allows it). Returns an array of MemberId strings.
 */
async function findMemberIdsForUser(userId) {
    const pool = await getPool();
    const r = await pool.request()
        .input('userId', sql.UniqueIdentifier, userId)
        .query('SELECT MemberId FROM oe.Members WHERE UserId = @userId');
    return r.recordset.map((row) => String(row.MemberId).toLowerCase());
}

/**
 * Delete staged draft blobs from Azure when a draft is discarded. Implemented
 * with the blob client in C3 (file staging); a no-op until any files are
 * staged, which is the case for drafts created in C2.
 */
async function purgeDraftBlobs(blobPaths) {
    if (!blobPaths || !blobPaths.length) return;
    for (const p of blobPaths) {
        if (!p) continue;
        // BlobPath is stored as `${container}/${blobName}`.
        const slash = String(p).indexOf('/');
        if (slash < 0) continue;
        const container = p.slice(0, slash);
        const blobName = p.slice(slash + 1);
        try {
            await deleteAzureBlob(container, blobName);
        } catch (e) {
            console.warn('purgeDraftBlobs: failed to delete', p, e.message);
        }
    }
}

function requireMemberRole(req, res) {
    // A user counts as "a member" if Member is their active role OR one of their
    // roles — a GroupAdmin/Agent who is also a Member (and owns member rows) may
    // autofill and submit for their OWN household. Everything downstream is scoped
    // to that household (findHouseholdMembersForUser / findMemberIdsForUser), so
    // this never exposes anyone else's data; it only blocks a pure admin with no
    // Member role from acting on a member's behalf.
    const user = req.user || {};
    const isMember =
        user.currentRole === 'Member' ||
        (Array.isArray(user.roles) && user.roles.includes('Member'));
    if (!isMember) {
        res.status(403).json({
            success: false,
            code: 'MEMBER_ROLE_REQUIRED',
            message: 'This link is for a member account. Please log out and log in with the member account.'
        });
        return false;
    }
    return true;
}

/**
 * Every member the authenticated user may legitimately fill a form for: their
 * own member row(s) plus everyone sharing a household with them (spouse,
 * children). Returns `[{ memberId (lowercased), tenantId }]`. This is the
 * authorization boundary for the "Who is this for?" selector — the primary may
 * autofill a dependent, but never someone outside their household.
 */
async function findHouseholdMembersForUser(userId) {
    const pool = await getPool();
    const r = await pool.request()
        .input('userId', sql.UniqueIdentifier, userId)
        .query(`
            SELECT DISTINCT m2.MemberId, m2.TenantId, m2.HouseholdId
            FROM oe.Members m1
            JOIN oe.Members m2
              ON m2.MemberId = m1.MemberId
              OR (m1.HouseholdId IS NOT NULL AND m2.HouseholdId = m1.HouseholdId)
            WHERE m1.UserId = @userId
        `);
    return r.recordset.map((row) => ({
        memberId: String(row.MemberId).toLowerCase(),
        tenantId: row.TenantId,
        householdId: row.HouseholdId
    }));
}

/**
 * GET /api/me/member/forms/prefill?memberId=<uuid>
 *
 * Signed-in autofill for the public forms. Returns the well-known prefill
 * payload for a member the caller is allowed to fill for (self or a household
 * dependent). 403 if the member is outside the caller's household.
 */
router.get('/prefill', async (req, res) => {
    try {
        if (!requireMemberRole(req, res)) return;
        const memberId = String(req.query.memberId || '').toLowerCase();
        if (!UUID_RE.test(memberId)) {
            return res.status(400).json({ success: false, message: 'A valid memberId is required.' });
        }
        const household = await findHouseholdMembersForUser(req.user.UserId);
        const match = household.find((h) => h.memberId === memberId);
        if (!match) {
            return res.status(403).json({
                success: false,
                message: 'This form is not associated with your account.'
            });
        }
        const prefill = await buildPrefillForMember({ memberId, tenantId: match.tenantId });
        return res.json({ success: true, data: { prefill } });
    } catch (e) {
        console.error('member GET prefill error:', e);
        return res.status(500).json({ success: false, message: 'Failed to load prefill' });
    }
});

/**
 * GET /api/me/member/forms/prior-providers?memberId=<uuid>
 *
 * "Your providers" suggestions for the provider_search field — providers the
 * member's household has used on past share requests. Same household auth as
 * /prefill.
 */
router.get('/prior-providers', async (req, res) => {
    try {
        if (!requireMemberRole(req, res)) return;
        const memberId = String(req.query.memberId || '').toLowerCase();
        if (!UUID_RE.test(memberId)) {
            return res.status(400).json({ success: false, message: 'A valid memberId is required.' });
        }
        const household = await findHouseholdMembersForUser(req.user.UserId);
        const match = household.find((h) => h.memberId === memberId);
        if (!match) {
            return res.status(403).json({
                success: false,
                message: 'This form is not associated with your account.'
            });
        }
        // Vendor-scope to the form's vendor when a formTemplateId is supplied,
        // so a member only sees providers from this vendor's prior requests.
        const formTemplateId = UUID_RE.test(String(req.query.formTemplateId || ''))
            ? String(req.query.formTemplateId)
            : null;
        const vendorId = await resolveFormVendorId(formTemplateId, match.tenantId);
        const providers = await getPriorProvidersForMember({ memberId, tenantId: match.tenantId, vendorId });
        return res.json({ success: true, data: { providers } });
    } catch (e) {
        console.error('member GET prior-providers error:', e);
        return res.status(500).json({ success: false, message: 'Failed to load providers' });
    }
});

// ---- Draft autosave (signed-in members) ------------------------------------

/** POST /api/me/member/forms/drafts — create or update the owner's draft. */
router.post('/drafts', async (req, res) => {
    try {
        if (!requireMemberRole(req, res)) return;
        const { formTemplateId, payload } = req.body || {};
        const forMemberId = String((req.body || {}).forMemberId || '').toLowerCase();
        if (!UUID_RE.test(String(formTemplateId || ''))) {
            return res.status(400).json({ success: false, message: 'A valid formTemplateId is required.' });
        }
        if (!UUID_RE.test(forMemberId)) {
            return res.status(400).json({ success: false, message: 'A valid forMemberId is required.' });
        }
        const household = await findHouseholdMembersForUser(req.user.UserId);
        const match = household.find((h) => h.memberId === forMemberId);
        if (!match) {
            return res.status(403).json({ success: false, message: 'This form is not associated with your account.' });
        }
        const draftId = await publicFormDraftService.upsertDraft({
            ownerUserId: req.user.UserId,
            tenantId: match.tenantId,
            formTemplateId,
            forMemberId,
            householdId: match.householdId,
            payload: payload || {}
        });
        return res.json({ success: true, data: { draftId } });
    } catch (e) {
        console.error('member POST draft error:', e);
        return res.status(500).json({ success: false, message: 'Failed to save draft' });
    }
});

/** GET /api/me/member/forms/drafts/active?formTemplateId=&forMemberId= */
router.get('/drafts/active', async (req, res) => {
    try {
        if (!requireMemberRole(req, res)) return;
        const formTemplateId = String(req.query.formTemplateId || '');
        const forMemberId = String(req.query.forMemberId || '').toLowerCase();
        if (!UUID_RE.test(formTemplateId)) {
            return res.status(400).json({ success: false, message: 'A valid formTemplateId is required.' });
        }
        if (forMemberId && !UUID_RE.test(forMemberId)) {
            return res.status(400).json({ success: false, message: 'Invalid forMemberId.' });
        }
        if (forMemberId) {
            const household = await findHouseholdMembersForUser(req.user.UserId);
            if (!household.find((h) => h.memberId === forMemberId)) {
                return res.status(403).json({ success: false, message: 'This form is not associated with your account.' });
            }
        }
        const draft = await publicFormDraftService.getActiveDraft({
            ownerUserId: req.user.UserId,
            formTemplateId,
            forMemberId: forMemberId || null
        });
        return res.json({ success: true, data: { draft } });
    } catch (e) {
        console.error('member GET active draft error:', e);
        return res.status(500).json({ success: false, message: 'Failed to load draft' });
    }
});

/** PATCH /api/me/member/forms/drafts/:draftId — autosave payload. */
router.patch('/drafts/:draftId', async (req, res) => {
    try {
        if (!requireMemberRole(req, res)) return;
        const { draftId } = req.params;
        if (!UUID_RE.test(String(draftId || ''))) {
            return res.status(400).json({ success: false, message: 'Invalid draftId.' });
        }
        const ok = await publicFormDraftService.updateDraftPayload({
            draftId,
            ownerUserId: req.user.UserId,
            payload: (req.body || {}).payload || {}
        });
        if (!ok) return res.status(404).json({ success: false, message: 'Draft not found.' });
        return res.json({ success: true });
    } catch (e) {
        console.error('member PATCH draft error:', e);
        return res.status(500).json({ success: false, message: 'Failed to save draft' });
    }
});

/** DELETE /api/me/member/forms/drafts/:draftId — discard a draft (and its staged files). */
router.delete('/drafts/:draftId', async (req, res) => {
    try {
        if (!requireMemberRole(req, res)) return;
        const { draftId } = req.params;
        if (!UUID_RE.test(String(draftId || ''))) {
            return res.status(400).json({ success: false, message: 'Invalid draftId.' });
        }
        const { deleted, blobPaths } = await publicFormDraftService.deleteDraft({
            draftId,
            ownerUserId: req.user.UserId
        });
        if (!deleted) return res.status(404).json({ success: false, message: 'Draft not found.' });
        await purgeDraftBlobs(blobPaths);
        return res.json({ success: true });
    } catch (e) {
        console.error('member DELETE draft error:', e);
        return res.status(500).json({ success: false, message: 'Failed to delete draft' });
    }
});

/** POST /api/me/member/forms/drafts/:draftId/files — stage one file to Azure. */
router.post('/drafts/:draftId/files', upload.single('file'), async (req, res) => {
    try {
        if (!requireMemberRole(req, res)) return;
        const { draftId } = req.params;
        if (!UUID_RE.test(String(draftId || ''))) {
            return res.status(400).json({ success: false, message: 'Invalid draftId.' });
        }
        const draft = await publicFormDraftService.loadDraftForOwner({ draftId, ownerUserId: req.user.UserId });
        if (!draft) return res.status(404).json({ success: false, message: 'Draft not found.' });
        const file = req.file;
        if (!file) return res.status(400).json({ success: false, message: 'No file uploaded.' });
        const fieldName = String((req.body || {}).fieldName || '').trim();
        if (!fieldName) return res.status(400).json({ success: false, message: 'fieldName is required.' });

        const blobId = crypto.randomUUID().replace(/-/g, '');
        const origSafe = (file.originalname || 'upload').replace(/[^a-zA-Z0-9._-]/g, '_');
        const blobName = `drafts/${draftId}/${blobId}_${origSafe}`;
        const blobUrl = await uploadToAzureBlob(file, PUBLIC_FORMS_CONTAINER, blobName);
        const draftFileId = await publicFormDraftService.insertDraftFile({
            draftId,
            fieldName,
            originalFileName: file.originalname,
            contentType: file.mimetype,
            fileSizeBytes: file.size,
            blobUrl,
            blobPath: `${PUBLIC_FORMS_CONTAINER}/${blobName}`
        });
        return res.json({
            success: true,
            data: { draftFileId, fieldName, originalFileName: file.originalname, blobUrl }
        });
    } catch (e) {
        console.error('member POST draft file error:', e);
        return res.status(500).json({ success: false, message: 'Failed to upload file' });
    }
});

/** DELETE /api/me/member/forms/drafts/:draftId/files/:fileId — remove a staged file. */
router.delete('/drafts/:draftId/files/:fileId', async (req, res) => {
    try {
        if (!requireMemberRole(req, res)) return;
        const { fileId } = req.params;
        if (!UUID_RE.test(String(fileId || ''))) {
            return res.status(400).json({ success: false, message: 'Invalid fileId.' });
        }
        const { deleted, blobPath } = await publicFormDraftService.deleteDraftFile({
            draftFileId: fileId,
            ownerUserId: req.user.UserId
        });
        if (!deleted) return res.status(404).json({ success: false, message: 'File not found.' });
        await purgeDraftBlobs(blobPath ? [blobPath] : []);
        return res.json({ success: true });
    } catch (e) {
        console.error('member DELETE draft file error:', e);
        return res.status(500).json({ success: false, message: 'Failed to delete file' });
    }
});

/**
 * POST /api/me/member/forms/drafts/:draftId/submit
 *
 * Promote a draft to a real submission: re-derive the for-member's identity
 * fields (anti-tamper), create the submission referencing the staged blobs
 * (no re-upload), then delete the draft rows (the blobs now belong to the
 * submission, so they are NOT purged).
 */
router.post('/drafts/:draftId/submit', async (req, res) => {
    try {
        if (!requireMemberRole(req, res)) return;
        const { draftId } = req.params;
        if (!UUID_RE.test(String(draftId || ''))) {
            return res.status(400).json({ success: false, message: 'Invalid draftId.' });
        }
        const draft = await publicFormDraftService.loadDraftForOwner({ draftId, ownerUserId: req.user.UserId });
        if (!draft) return res.status(404).json({ success: false, message: 'Draft not found.' });
        const templateRow = await publicFormAdminService.getPublishedDefinitionByTemplateId(draft.formTemplateId);
        if (!templateRow) {
            return res.status(409).json({ success: false, message: 'This form is currently unavailable.' });
        }

        const payload = draft.payload || {};
        // Server-authoritative identity: overwrite the for-member's profile fields.
        if (draft.forMemberId) {
            const prefill = await buildPrefillForMember({ memberId: draft.forMemberId, tenantId: draft.tenantId });
            for (const [k, v] of Object.entries(prefill)) {
                if (v !== null && v !== undefined && v !== '') payload[k] = v;
            }
        }
        const preStagedFiles = (draft.files || []).map((f) => ({
            fieldName: f.FieldName,
            originalName: f.OriginalFileName,
            contentType: f.ContentType,
            size: f.FileSizeBytes,
            blobUrl: f.BlobUrl,
            blobPath: f.BlobPath
        }));

        const result = await createSubmissionFromPublicRequest(
            req,
            templateRow,
            payload,
            [],
            uploadToAzureBlob,
            {
                authMode: 'authenticated',
                preStagedFiles,
                // Bind to the authorized member directly — don't let typed/edited
                // member-ID text re-resolve (or mis-resolve) the submission.
                boundMemberId: draft.forMemberId || null
            }
        );
        // Promote succeeded — drop the draft rows only; the blobs are now the
        // submission's attachments and must survive.
        await publicFormDraftService.deleteDraftRowsOnly(draftId);
        return res.json({ success: true, data: result });
    } catch (e) {
        console.error('member POST draft submit error:', e);
        const code = e.statusCode || 500;
        return res.status(code).json({ success: false, message: e.message || 'Failed to submit' });
    }
});

/**
 * GET /api/me/member/forms/invitations/:token
 *
 * Authenticated lookup for `authenticated`-mode invitations. Validates that
 * the logged-in user owns the invitation's MemberId, then returns the form
 * definition plus a server-built prefill payload.
 */
router.get('/invitations/:token', async (req, res) => {
    try {
        if (!requireMemberRole(req, res)) return;
        const { token } = req.params;
        if (!TOKEN_RE.test(String(token || ''))) {
            return res.status(410).json({ success: false, message: 'This link is no longer valid.' });
        }
        const invitation = await publicFormInvitationService.findActiveByToken(token);
        if (!invitation) {
            return res.status(410).json({ success: false, message: 'This link is no longer valid.' });
        }
        if (invitation.mode !== 'authenticated') {
            return res.status(409).json({ success: false, message: 'This invitation does not require authentication.' });
        }
        // Route exception: invitations belong to the authenticated actor, not delegated primary.
        const memberIds = await findMemberIdsForUser(req.user.UserId);
        if (!memberIds.includes(String(invitation.memberId).toLowerCase())) {
            return res.status(403).json({ success: false, message: 'This form is not associated with your account.' });
        }
        const publishedRow = await publicFormAdminService.getPublishedDefinitionByTemplateId(invitation.formTemplateId);
        if (!publishedRow || String(publishedRow.TenantId).toLowerCase() !== String(invitation.tenantId).toLowerCase()) {
            return res.status(409).json({ success: false, message: 'This form is currently unavailable. Contact your care team.' });
        }
        // Parse before handing to the SAS-resolver — it returns its input
        // unchanged for non-object args (silent string passthrough), which
        // crashes PublicFormView's def.title.trim() on the recipient side.
        let definition;
        try {
            definition = JSON.parse(publishedRow.DefinitionJson || '{}');
        } catch (parseErr) {
            console.error('authenticated invitation: definition JSON parse', parseErr);
            return res.status(500).json({ success: false, message: 'Invalid form definition' });
        }
        definition = await definitionWithAuthenticatedHeaderImage(definition);
        const prefill = await buildPrefillForMember({
            memberId: invitation.memberId,
            tenantId: invitation.tenantId
        });
        return res.json({
            success: true,
            data: {
                formTitle: publishedRow.Title || '',
                formDefinition: definition,
                prefill,
                expiresAt: invitation.expiresAt,
                invitationId: invitation.invitationId,
                forMemberId: invitation.memberId
            }
        });
    } catch (e) {
        console.error('member GET invitation error:', e);
        return res.status(500).json({ success: false, message: 'Failed to load form' });
    }
});

/**
 * POST /api/me/member/forms/invitations/:token/submit
 *
 * Authenticated submit. Re-runs the membership match (server-authoritative)
 * before persisting. Submission's MemberId/InvitationId/AuthMode/
 * ShareRequestId/CaseId are set from the invitation row.
 */
router.post('/invitations/:token/submit', upload.any(), async (req, res) => {
    try {
        if (!requireMemberRole(req, res)) return;
        const { token } = req.params;
        if (!TOKEN_RE.test(String(token || ''))) {
            return res.status(410).json({ success: false, message: 'This link is no longer valid.' });
        }
        const invitation = await publicFormInvitationService.findActiveByToken(token);
        if (!invitation) {
            return res.status(410).json({ success: false, message: 'This link is no longer valid.' });
        }
        if (invitation.mode !== 'authenticated') {
            return res.status(409).json({ success: false, message: 'This invitation does not require authentication.' });
        }
        // Route exception: invitations belong to the authenticated actor, not delegated primary.
        const memberIds = await findMemberIdsForUser(req.user.UserId);
        if (!memberIds.includes(String(invitation.memberId).toLowerCase())) {
            return res.status(403).json({ success: false, message: 'This form is not associated with your account.' });
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
        // Server is authoritative for prefill — overwrite any recipient-supplied
        // value for known fields with the server-side member profile copy. This
        // prevents a tampered POST from spoofing identity fields against an
        // invitation that didn't ask for them.
        // Optional "Who is this for?" override — a household member the signed-in
        // user is authorized for (spouse/child). Defaults to the invitation's
        // original recipient, so omitting it preserves existing behavior. Keeps
        // the invitation's InvitationId/ShareRequest/Case linkage; only the
        // member the submission is FOR changes.
        let effectiveMemberId = invitation.memberId;
        const requestedForMember = String(req.body.forMemberId || '').toLowerCase();
        if (
            requestedForMember &&
            UUID_RE.test(requestedForMember) &&
            requestedForMember !== String(invitation.memberId).toLowerCase()
        ) {
            const household = await findHouseholdMembersForUser(req.user.UserId);
            if (household.find((h) => h.memberId === requestedForMember)) {
                effectiveMemberId = requestedForMember;
            }
        }
        // Server is authoritative for prefill — overwrite any recipient-supplied
        // value for known fields with the server-side member profile copy. This
        // prevents a tampered POST from spoofing identity fields.
        const prefill = await buildPrefillForMember({
            memberId: effectiveMemberId,
            tenantId: invitation.tenantId
        });
        for (const [key, value] of Object.entries(prefill)) {
            if (value !== null && value !== undefined && value !== '') {
                payload[key] = value;
            }
        }
        const result = await createSubmissionFromPublicRequest(
            req,
            templateRow,
            payload,
            req.files || [],
            uploadToAzureBlob,
            { invitation, authMode: 'authenticated', boundMemberId: effectiveMemberId }
        );
        return res.status(201).json({
            success: true,
            message: 'Your form was received.',
            data: result
        });
    } catch (e) {
        const status = e.statusCode || 500;
        if (status >= 500) console.error('❌ member invitation submit', e);
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
        return res.status(status).json({
            success: false,
            message,
            error: { message, code: errCode }
        });
    }
});

module.exports = router;
