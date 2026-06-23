const crypto = require('crypto');
const { getPool, sql } = require('../config/database');
const { encryptPayloadObject } = require('./publicFormCrypto');
const { resolveMemberForTenants, buildResolverTenantSet } = require('./publicFormMemberResolver');
const { getPublicFormsActorUserId } = require('./publicFormActor');
const { linkSubmissionToShareWorkflow } = require('./publicFormShareLinkService');
const { redactDirectDepositFields } = require('./memberDirectDepositService');
const publicFormInvitationService = require('./publicFormInvitationService');
const {
    sendSubmissionNotifications,
    sendSubmitterConfirmationEmail,
    buildSubmissionDataUrl
} = require('./publicFormNotifyService');
const { buildSubmissionPdfBuffer } = require('./publicFormSubmissionPdfService');
const notificationService = require('./notificationService');
const { requireShared } = require('../config/shared-modules');
const { resolveVisibility } = requireShared('public-form-visibility');

const MAX_SIGNATURE_DATA_URL_CHARS = 6 * 1024 * 1024;

function parseDefinition(definitionJson) {
    try {
        return JSON.parse(definitionJson);
    } catch {
        return { fields: [] };
    }
}

function localYmd(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function effectiveDateMinMax(field) {
    if (field.type !== 'date') return {};
    const today = new Date();
    const todayStr = localYmd(today);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = localYmd(yesterday);
    let max;
    if (field.dateDisallowToday) max = yesterdayStr;
    else if (field.dateDisallowFuture) max = todayStr;
    if (field.dateMax) {
        max = max ? (field.dateMax < max ? field.dateMax : max) : field.dateMax;
    }
    const min = field.dateMin || undefined;
    return { min, max };
}

function dateValueValid(field, value) {
    if (!value || typeof value !== 'string') return false;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const { min, max } = effectiveDateMinMax(field);
    if (min && value < min) return false;
    if (max && value > max) return false;
    return true;
}

/**
 * Enrich signature fields with server-side audit (UTC time, IP hash, client hints).
 * Mutates `payload` in place.
 * @param {import('express').Request} req
 * @param {Record<string, unknown>} payload
 * @param {{ fields?: unknown[] }} def
 */
function attachSignatureAudit(req, payload, def) {
    const fields = def.fields || [];
    for (const f of fields) {
        if (f.type !== 'signature') continue;
        const v = payload[f.name];
        if (!v || typeof v !== 'object') continue;
        const img = v.imageDataUrl;
        if (typeof img !== 'string' || !img.startsWith('data:image')) continue;
        const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
        const ipHash = ip ? crypto.createHash('sha256').update(ip).digest('hex') : null;
        payload[f.name] = {
            imageDataUrl: img,
            audit: {
                signedAtUtc: new Date().toISOString(),
                signerIpHashSha256: ipHash,
                userAgent: String(req.headers['user-agent'] || '').slice(0, 500),
                acceptLanguage: (req.headers['accept-language'] || '').toString().slice(0, 200) || null,
                cfCountry: (req.headers['cf-ipcountry'] || req.headers['CF-IPCountry'] || '')
                    .toString()
                    .slice(0, 8) || null
            }
        };
    }
}

function validatePayloadAgainstDefinition(def, payload, files) {
    const fields = def.fields || [];
    const errors = [];
    // Conditional visibility — a required field hidden by the recipient's
    // pre-screening answers must not block the submission. For legacy forms
    // (no pages / no pre-screening) every field resolves visible, so this is
    // a no-op.
    const { visibleFieldNames } = resolveVisibility(
        def,
        payload && typeof payload === 'object' ? payload.__preScreenAnswers : null
    );
    // Files arrive on the multipart request as a flat list ("files") rather
    // than keyed by field name, so we can't associate a specific upload with
    // a specific `file` field. Best effort: require at least as many uploads
    // as there are required file fields.
    const fileCount = Array.isArray(files) ? files.length : 0;
    let requiredFileFieldsSeen = 0;
    for (const f of fields) {
        if (f.type === 'static_html') continue;
        if (!visibleFieldNames.has(f.name)) continue;
        if (f.type === 'signature') {
            const v = payload[f.name];
            if (f.required) {
                if (
                    !v ||
                    typeof v !== 'object' ||
                    typeof v.imageDataUrl !== 'string' ||
                    !/^data:image\/(png|jpeg|jpg);base64,/i.test(v.imageDataUrl)
                ) {
                    errors.push(`Required signature: ${f.label || f.name}`);
                } else if (v.imageDataUrl.length > MAX_SIGNATURE_DATA_URL_CHARS) {
                    errors.push(`Signature too large: ${f.label || f.name}`);
                }
            } else if (v !== undefined && v !== null && v !== '') {
                if (
                    typeof v !== 'object' ||
                    typeof v.imageDataUrl !== 'string' ||
                    !/^data:image\/(png|jpeg|jpg);base64,/i.test(v.imageDataUrl)
                ) {
                    errors.push(`Invalid signature: ${f.label || f.name}`);
                } else if (v.imageDataUrl.length > MAX_SIGNATURE_DATA_URL_CHARS) {
                    errors.push(`Signature too large: ${f.label || f.name}`);
                }
            }
            continue;
        }
        const v = payload[f.name];
        if (f.type === 'date' && v !== undefined && v !== null && v !== '') {
            if (!dateValueValid(f, String(v))) {
                errors.push(`Invalid date: ${f.label || f.name}`);
            }
        }
        // Min-character check on long-text fields — applies whenever a value
        // is present, independent of required (required handles emptiness).
        if (
            (f.type === 'textarea' || f.type === 'paragraph') &&
            typeof f.minLength === 'number' &&
            Number.isFinite(f.minLength) &&
            f.minLength > 0
        ) {
            const trimmedLen = typeof v === 'string' ? v.trim().length : 0;
            if (trimmedLen > 0 && trimmedLen < f.minLength) {
                errors.push(
                    `Please enter at least ${f.minLength} characters in ${f.label || f.name}`
                );
            }
        }
        if (!f.required) continue;
        if (f.type === 'checkbox' || f.type === 'terms') {
            if (!v) errors.push(`Required: ${f.label || f.name}`);
            continue;
        }
        if (f.type === 'checkbox_group') {
            if (!Array.isArray(v) || v.length === 0) {
                errors.push(`Required: ${f.label || f.name}`);
            }
            continue;
        }
        if (f.type === 'file') {
            requiredFileFieldsSeen += 1;
            if (fileCount < requiredFileFieldsSeen) {
                errors.push(`Please attach a file for: ${f.label || f.name}`);
            }
            continue;
        }
        if (v === undefined || v === null || v === '') {
            errors.push(`Missing required field: ${f.label || f.name}`);
        }
    }
    return errors;
}

function clientIpHash(req) {
    const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
    if (!ip) return null;
    return crypto.createHash('sha256').update(ip).digest();
}

const SEARCH_TEXT_MAX = 32000;

function truncateNvarchar(str, max) {
    const s = String(str || '').trim();
    if (!s) return '';
    return s.length <= max ? s : s.slice(0, max);
}

function pickPayloadNamePart(payload, keys) {
    for (const k of keys) {
        if (!Object.prototype.hasOwnProperty.call(payload, k)) continue;
        const v = payload[k];
        if (v === null || v === undefined) continue;
        const s = truncateNvarchar(String(v), 200);
        if (s) return s;
    }
    return null;
}

/**
 * Keys matching `regex` (e.g. firstName, firstName_2, firstName_3 from the form builder).
 * Sorted so base `firstName` / `lastName` (no suffix) wins over suffixed duplicates.
 * @param {Record<string, unknown>} payload
 * @param {RegExp} regex
 */
function pickPayloadNamePartRegex(payload, regex) {
    const keys = Object.keys(payload).filter((k) => regex.test(k));
    keys.sort((a, b) => {
        const na = a.match(/_(\d+)$/i);
        const nb = b.match(/_(\d+)$/i);
        const ia = na ? parseInt(na[1], 10) : 0;
        const ib = nb ? parseInt(nb[1], 10) : 0;
        return ia - ib;
    });
    return pickPayloadNamePart(payload, keys);
}

/**
 * Safe path segment for Azure blob keys (ASCII-ish, bounded length).
 * @param {string|null|undefined} str
 * @param {number} maxLen
 */
function slugForBlobSegment(str, maxLen = 32) {
    const s = String(str ?? '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase()
        .slice(0, maxLen);
    return s || 'unknown';
}

// Form-field key aliases for the email and phone a submitter typed. Shared by
// derivePayloadSearchFields (search denormalization) and derivePayloadContact
// (member resolution) so the two never drift apart.
const EMAIL_FIELD_KEYS = ['email', 'Email', 'emailAddress', 'EmailAddress', 'email_address'];
const PHONE_FIELD_KEYS = ['phone', 'Phone', 'phoneNumber', 'PhoneNumber', 'mobile', 'mobilePhone', 'cellPhone', 'cell'];

/**
 * Email/phone as entered on the form, untruncated — for member resolution
 * fallback when no member id / card was supplied. Same key aliases as
 * derivePayloadSearchFields.
 * @param {Record<string, unknown>} payload
 * @returns {{ email: string|null, phone: string|null }}
 */
function derivePayloadContact(payload) {
    if (!payload || typeof payload !== 'object') {
        return { email: null, phone: null };
    }
    const email = (
        pickPayloadNamePart(payload, EMAIL_FIELD_KEYS) ?? pickPayloadNamePartRegex(payload, /^email(_\d+)?$/i)
    ) || null;
    const phone = (
        pickPayloadNamePart(payload, PHONE_FIELD_KEYS) ?? pickPayloadNamePartRegex(payload, /^phone(_\d+)?$/i)
    ) || null;
    return { email, phone };
}

/**
 * Denormalized fields for admin search (PHI — same controls as submission row).
 * Supports snake_case, camelCase, PascalCase, form-builder suffixed keys (firstName_2…),
 * and Additional documents `verifyLastName` when that is the only last-name field.
 * @param {Record<string, unknown>} payload
 */
function derivePayloadSearchFields(payload) {
    if (!payload || typeof payload !== 'object') {
        return { payloadFirstName: null, payloadLastName: null, payloadEmail: null, payloadPhone: null, searchableText: null };
    }
    const first =
        pickPayloadNamePart(payload, [
            'first_name',
            'firstName',
            'firstName_2',
            'given_name',
            'fname',
            'FirstName',
            'GivenName',
            'givenName'
        ]) ?? pickPayloadNamePartRegex(payload, /^firstName(_\d+)?$/i);
    const last =
        pickPayloadNamePart(payload, [
            'last_name',
            'lastName',
            'lastName_2',
            'family_name',
            'surname',
            'LastName',
            'FamilyName',
            'familyName'
        ]) ??
        pickPayloadNamePartRegex(payload, /^lastName(_\d+)?$/i) ??
        pickPayloadNamePart(payload, ['verifyLastName', 'VerifyLastName']);
    const { email, phone } = derivePayloadContact(payload);
    const truncatedEmail = email ? truncateNvarchar(email, 254) : null;
    const truncatedPhone = phone ? truncateNvarchar(phone, 50) : null;
    const parts = [];
    for (const k of Object.keys(payload)) {
        const v = payload[k];
        if (v === null || v === undefined) continue;
        if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.imageDataUrl === 'string') {
            continue;
        }
        if (typeof v === 'string' && v.trim()) {
            parts.push(v.trim());
        } else if (typeof v === 'number' || typeof v === 'boolean') {
            parts.push(String(v));
        } else if (Array.isArray(v)) {
            for (const item of v) {
                if (typeof item === 'string' && item.trim()) parts.push(item.trim());
                else if (item != null && typeof item !== 'object') parts.push(String(item));
            }
        }
    }
    const joined = parts.join(' ').toLowerCase().replace(/\s+/g, ' ').trim();
    const searchableText = joined.length ? truncateNvarchar(joined, SEARCH_TEXT_MAX) : null;
    return {
        payloadFirstName: first,
        payloadLastName: last,
        payloadEmail: truncatedEmail,
        payloadPhone: truncatedPhone,
        searchableText: searchableText || null
    };
}

/**
 * @param {import('express').Request} req
 * @param {object} templateRow — joined template + version row
 * @param {Record<string, unknown>} payload
 * @param {import('multer').File[]} files
 * @param {Function} uploadToAzureBlob
 * @param {{ invitation?: { invitationId: string, memberId: string, linkedShareRequestId: string|null, linkedCaseId: string|null, sentToEmail: string }, authMode?: 'targeted'|'authenticated'|'anonymous' }} [submissionContext]
 *   Invitation context for the "send to member" flows. When present, the
 *   resolver is skipped, MemberId/InvitationId/ShareRequestId/CaseId/AuthMode
 *   are set from the invitation, and FirstUsedAt is stamped after the insert.
 */
async function createSubmissionFromPublicRequest(req, templateRow, payload, files, uploadToAzureBlob, submissionContext = {}) {
    const def = parseDefinition(templateRow.DefinitionJson);
    // Files already uploaded to Azure (promoted from a draft) — referenced in
    // place, no re-upload. Shape: { fieldName, originalName, contentType, size, blobUrl, blobPath }.
    const preStagedFiles = Array.isArray(submissionContext.preStagedFiles)
        ? submissionContext.preStagedFiles
        : [];
    // Required-file validation matches on fieldname; pre-staged files satisfy it
    // without being re-uploaded by the attachment loop below.
    const validationFiles = preStagedFiles.length
        ? [...(Array.isArray(files) ? files : []), ...preStagedFiles.map((p) => ({ fieldname: p.fieldName }))]
        : files;
    const valErrors = validatePayloadAgainstDefinition(def, payload, validationFiles);
    if (valErrors.length) {
        const err = new Error(valErrors.join('; '));
        err.statusCode = 400;
        throw err;
    }
    attachSignatureAudit(req, payload, def);

    const tenantId = templateRow.TenantId;
    const formKind = templateRow.FormKind;
    const formTemplateId = templateRow.FormTemplateId;
    const invitation = submissionContext.invitation || null;
    const authMode = submissionContext.authMode || (invitation ? 'targeted' : 'anonymous');
    // Member id may be carried under the legacy `memberId` key OR under any
    // form-defined field of type `member_id` (e.g. the combined form's
    // `ay_member_id`). Try the legacy key first for back-compat, then fall
    // back to walking the definition for a member_id-typed field.
    let memberText = (payload.memberId || '').toString().trim();
    if (!memberText) {
        const memberIdField = (def.fields || []).find((f) => f && f.type === 'member_id' && f.name);
        if (memberIdField) {
            const v = payload[memberIdField.name];
            if (v != null) memberText = String(v).trim();
        }
    }

    // Member binding precedence:
    //   1. invitation — recipient pinned to a specific MemberId. A server-authorized
    //      household member (the "Who is this for?" selection) may override who the
    //      submission is FOR, falling back to the invitation's original recipient.
    //   2. boundMemberId — an authenticated, server-authorized member (e.g. a
    //      signed-in draft promote). Bind directly; never trust typed/edited
    //      member-ID text to pick (or re-pick) the member (A6 anti-tamper).
    //   3. anonymous public submission — run the inline resolver across the
    //      form's tenant allow-list. A vendor-wide public form may serve members
    //      across sibling tenants; the template's ResolverTenantIds (always unioned
    //      with the form's own tenant) defines where resolution may search. The
    //      resolver tries the typed member id/card first, then falls back to the
    //      submitter's email, then phone, when no id was supplied or it missed.
    const boundMemberId = submissionContext.boundMemberId || null;
    let resolution;
    if (invitation) {
        resolution = { memberId: boundMemberId || invitation.memberId, status: 'Matched', ambiguousCount: 0 };
    } else if (boundMemberId) {
        resolution = { memberId: boundMemberId, status: 'Matched', ambiguousCount: 0 };
    } else {
        const resolverTenantSet = buildResolverTenantSet(tenantId, templateRow.ResolverTenantIds);
        const { email: submittedEmail, phone: submittedPhone } = derivePayloadContact(payload);
        resolution = await resolveMemberForTenants(resolverTenantSet, {
            memberIdText: memberText,
            email: submittedEmail,
            phone: submittedPhone
        });
    }

    // Strip ACH banking fields (dd_*) before encrypting the payload. They
    // get persisted separately on oe.MemberDirectDeposits by the share-link
    // step. This prevents banking data from also living inside
    // PublicFormSubmissions.PayloadEncrypted, where no one is managing it.
    const { sanitizedPayload, redactedKeys } = redactDirectDepositFields(payload);
    const enc = encryptPayloadObject(sanitizedPayload);
    if (redactedKeys.length) {
        console.log(
            `publicFormSubmissionService: redacted ${redactedKeys.length} direct-deposit field(s) before encrypting submission payload`
        );
    }
    const searchFields = derivePayloadSearchFields(sanitizedPayload);
    const submissionId = crypto.randomUUID();
    const publicAccessToken = crypto.randomBytes(32).toString('hex');
    const publicAccessTokenHash = crypto.createHash('sha256').update(publicAccessToken).digest('hex');
    const fingerprint = crypto
        .createHash('sha256')
        .update(`${formTemplateId}|${memberText}|${new Date().toISOString().slice(0, 10)}`)
        .digest('hex');

    const pool = await getPool();
    const ipHash = clientIpHash(req);

    // Stage blob uploads BEFORE writing any DB rows so a storage failure
    // doesn't leave an orphaned submission row without its attachments.
    // All DB inserts then run inside a single transaction (ACID compliance
    // per backend-system.md) — if any insert fails the whole submission
    // rolls back as a unit.
    const container = process.env.AZURE_STORAGE_PUBLIC_FORMS_CONTAINER || 'public-form-uploads';
    const readableKind = String(templateRow.KindLabel || '').trim() || formKind;
    const datePart = new Date().toISOString().slice(0, 10);
    const lastSeg = slugForBlobSegment(searchFields.payloadLastName, 32);
    const firstSeg = slugForBlobSegment(searchFields.payloadFirstName, 32);
    const kindSeg = slugForBlobSegment(readableKind, 40);

    const stagedFiles = [];
    const attachments = Array.isArray(files) ? files : [];
    for (let i = 0; i < attachments.length; i += 1) {
        const file = attachments[i];
        const shortId = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
        const origSafe = (file.originalname || 'upload').replace(/[^a-zA-Z0-9._-]/g, '_');
        const safeName = `${submissionId}/${lastSeg}_${firstSeg}_${datePart}_${kindSeg}_${shortId}_${origSafe}`;
        try {
            const blobUrl = await uploadToAzureBlob(file, container, safeName);
            stagedFiles.push({
                fileId: crypto.randomUUID(),
                originalName: file.originalname,
                contentType: file.mimetype,
                size: file.size,
                blobUrl,
                blobPath: `${container}/${safeName}`,
                filePurpose: 'attachment'
            });
        } catch (uploadErr) {
            console.error(
                `❌ publicFormSubmissionService: attachment ${i + 1}/${attachments.length} upload failed`,
                { file: file.originalname, size: file.size, message: uploadErr.message }
            );
            const err = new Error(
                `Upload failed for "${file.originalname}": ${uploadErr.message || 'storage error'}`
            );
            err.statusCode = 502;
            err.code = 'STORAGE_UPLOAD_FAILED';
            throw err;
        }
    }

    // Promoted draft files are already in blob storage — reference them in place.
    for (const pf of preStagedFiles) {
        stagedFiles.push({
            fileId: crypto.randomUUID(),
            originalName: pf.originalName,
            contentType: pf.contentType,
            size: pf.size,
            blobUrl: pf.blobUrl,
            blobPath: pf.blobPath,
            filePurpose: 'attachment'
        });
    }

    // Submission-record PDF is best-effort — failures should not block the
    // submission itself. The viewer will still render the payload + files.
    if (def.submissionPdf && def.submissionPdf.enabled === true) {
        try {
            const pdfBuf = await buildSubmissionPdfBuffer(def, payload, {
                title: templateRow.Title || def.title || 'Form submission'
            });
            const fakeFile = {
                buffer: pdfBuf,
                size: pdfBuf.length,
                mimetype: 'application/pdf',
                originalname: 'submission-record.pdf'
            };
            const pdfBlobName = `${submissionId}/submission-record.pdf`;
            const pdfUrl = await uploadToAzureBlob(fakeFile, container, pdfBlobName);
            stagedFiles.push({
                fileId: crypto.randomUUID(),
                originalName: 'submission-record.pdf',
                contentType: 'application/pdf',
                size: pdfBuf.length,
                blobUrl: pdfUrl,
                blobPath: `${container}/${pdfBlobName}`,
                filePurpose: 'submission_pdf'
            });
        } catch (e) {
            console.warn('publicFormSubmissionService: submission PDF failed', e.message);
        }
    }

    const transaction = pool.transaction();
    await transaction.begin();
    try {
        await transaction.request()
            .input('submissionId', sql.UniqueIdentifier, submissionId)
            .input('formTemplateId', sql.UniqueIdentifier, formTemplateId)
            .input('tenantId', sql.UniqueIdentifier, tenantId)
            .input('formKind', sql.NVarChar, formKind)
            .input('clientIpHash', sql.VarBinary, ipHash)
            .input('payloadEncrypted', sql.VarBinary, enc.ciphertext)
            .input('payloadIv', sql.VarBinary, enc.iv)
            .input('payloadAuthTag', sql.VarBinary, enc.authTag)
            .input('payloadKeyId', sql.NVarChar, enc.keyId)
            .input('submittedMemberIdText', sql.NVarChar, memberText || null)
            .input('memberId', sql.UniqueIdentifier, resolution.memberId)
            .input('memberMatchStatus', sql.NVarChar, resolution.status)
            .input('ambiguousCount', sql.Int, resolution.ambiguousCount)
            .input('fingerprint', sql.Char(64), fingerprint)
            .input('publicAccessTokenHash', sql.Char(64), publicAccessTokenHash)
            .input('payloadFirstName', sql.NVarChar(200), searchFields.payloadFirstName)
            .input('payloadLastName', sql.NVarChar(200), searchFields.payloadLastName)
            .input('payloadEmail', sql.NVarChar(254), searchFields.payloadEmail)
            .input('payloadPhone', sql.NVarChar(50), searchFields.payloadPhone)
            .input('searchableText', sql.NVarChar(sql.MAX), searchFields.searchableText)
            .input('authMode', sql.NVarChar(20), authMode)
            .input('invitationId', sql.UniqueIdentifier, invitation ? invitation.invitationId : null)
            .input('shareRequestId', sql.UniqueIdentifier, invitation ? invitation.linkedShareRequestId : null)
            .input('caseId', sql.UniqueIdentifier, invitation ? invitation.linkedCaseId : null)
            .query(`
                INSERT INTO oe.PublicFormSubmissions (
                    SubmissionId, FormTemplateId, TenantId, FormKind, ClientIpHash,
                    PayloadEncrypted, PayloadIv, PayloadAuthTag, PayloadKeyId,
                    SubmittedMemberIdText, MemberId, MemberMatchStatus, AmbiguousMatchCount,
                    SubmissionFingerprint, PublicAccessTokenHash, PublicAccessTokenExpiry, PublicAccessRevoked,
                    PayloadFirstName, PayloadLastName, PayloadEmail, PayloadPhone, SearchableText,
                    AuthMode, InvitationId, ShareRequestId, CaseId
                ) VALUES (
                    @submissionId, @formTemplateId, @tenantId, @formKind, @clientIpHash,
                    @payloadEncrypted, @payloadIv, @payloadAuthTag, @payloadKeyId,
                    @submittedMemberIdText, @memberId, @memberMatchStatus, @ambiguousCount,
                    @fingerprint, @publicAccessTokenHash, DATEADD(DAY, 30, SYSUTCDATETIME()), 0,
                    @payloadFirstName, @payloadLastName, @payloadEmail, @payloadPhone, @searchableText,
                    @authMode, @invitationId, @shareRequestId, @caseId
                )
            `);

        for (const f of stagedFiles) {
            await transaction.request()
                .input('fileId', sql.UniqueIdentifier, f.fileId)
                .input('submissionId', sql.UniqueIdentifier, submissionId)
                .input('orig', sql.NVarChar, f.originalName)
                .input('ct', sql.NVarChar, f.contentType)
                .input('sz', sql.BigInt, f.size)
                .input('url', sql.NVarChar, f.blobUrl)
                .input('path', sql.NVarChar, f.blobPath)
                .input('filePurpose', sql.NVarChar, f.filePurpose)
                .query(`
                    INSERT INTO oe.PublicFormSubmissionFiles (
                        FileId, SubmissionId, OriginalFileName, ContentType, FileSizeBytes, BlobUrl, BlobPath, FilePurpose
                    ) VALUES (@fileId, @submissionId, @orig, @ct, @sz, @url, @path, @filePurpose)
                `);
        }

        await transaction.commit();
    } catch (dbErr) {
        try { await transaction.rollback(); } catch (rbErr) {
            console.warn('publicFormSubmissionService: rollback after insert failure also failed', rbErr.message);
        }
        if (stagedFiles.length > 0) {
            console.warn(
                'publicFormSubmissionService: DB write failed after staging blobs; ' +
                'orphaned blobs may exist and should be swept:',
                stagedFiles.map((f) => f.blobPath)
            );
        }
        const err = new Error(`Database write failed while saving submission: ${dbErr.message || 'unknown error'}`);
        err.statusCode = 500;
        err.code = dbErr.code || 'SUBMISSION_DB_WRITE_FAILED';
        throw err;
    }

    console.log(
        `✅ Public form submission ${submissionId} saved with ${stagedFiles.length} file(s) for tenant ${tenantId}`
    );

    // Invitations are multi-use within their expiry window; stamp FirstUsedAt
    // exactly once. Idempotent and best-effort — a failure here MUST NOT roll
    // back the submission itself.
    if (invitation) {
        try {
            await publicFormInvitationService.markFirstUsed(invitation.invitationId);
        } catch (markErr) {
            console.warn('publicFormSubmissionService: markFirstUsed failed', markErr.message);
        }
    }

    let linkResult = { success: false };
    let requestNumber = null;

    // Skip auto-SR-create when the care team already picked an SR at send-time:
    // double-creating would defeat the explicit linkage. The submission's
    // ShareRequestId is already set from the invitation.
    const skipShareWorkflow = Boolean(invitation && invitation.linkedShareRequestId);

    // Route to the back-office workflow when we have a matched member, OR when the
    // submission is unmatched (no member / ambiguous) — the latter creates a
    // member-less "shell" SR/Case flagged NeedsMemberMatch so it still shows up in
    // the dashboards for a staffer to match. (Invitation-pinned SRs are skipped.)
    const hasMatchedMember = resolution.status === 'Matched' && Boolean(resolution.memberId);
    const isUnmatched = !resolution.memberId;
    if ((hasMatchedMember || isUnmatched) && !skipShareWorkflow) {
        try {
            const actorUserId = await getPublicFormsActorUserId();
            linkResult = await linkSubmissionToShareWorkflow({
                submissionId,
                tenantId,
                formTemplateId,
                formKind,
                memberId: resolution.memberId || null,
                needsMemberMatch: isUnmatched,
                vendorIdOverride: templateRow.DefaultVendorId,
                payload,
                actorUserId,
                def
            });
            requestNumber = linkResult.requestNumber || null;
        } catch (linkErr) {
            // Linking is a best-effort enrichment after the submission is safely
            // persisted — don't fail the submission if the share-workflow hop errors.
            console.warn('publicFormSubmissionService: link to share workflow failed', linkErr.message);
        }
    }

    const submissionDataUrl = buildSubmissionDataUrl(publicAccessToken, req);

    try {
        await sendSubmissionNotifications({
            tenantId,
            submissionId,
            submissionDataUrl,
            formKind,
            formTitle: templateRow.Title || null,
            memberMatchStatus: resolution.status,
            shareRequestId: linkResult.shareRequestId || null,
            requestNumber,
            notifyEmailsJson: templateRow.NotifyEmails,
            // Pass the dd_*-stripped payload to notify paths — defence in
            // depth so banking values can't leak into email bodies.
            payload: sanitizedPayload
        });
    } catch (notifyErr) {
        console.warn('publicFormSubmissionService: routing notifications failed', notifyErr.message);
    }

    // In-app bell notification for the owning vendor's users (best-effort).
    if (templateRow.DefaultVendorId) {
        try {
            await notificationService.createFormSubmissionNotifications({
                vendorId: templateRow.DefaultVendorId,
                tenantId,
                submissionId,
                formTitle: templateRow.Title || null
            });
        } catch (notifyErr) {
            console.warn('publicFormSubmissionService: in-app form notifications failed', notifyErr.message);
        }
    }

    try {
        await sendSubmitterConfirmationEmail({
            tenantId,
            submissionId,
            payload: sanitizedPayload,
            formTitle: templateRow.Title || null,
            formKind
        });
    } catch (e) {
        console.warn('publicFormSubmissionService: submitter confirmation email failed', e.message);
    }

    return {
        submissionId,
        memberMatchStatus: resolution.status,
        received: true
    };
}

module.exports = {
    createSubmissionFromPublicRequest,
    validatePayloadAgainstDefinition,
    parseDefinition,
    derivePayloadSearchFields,
    attachSignatureAudit
};
