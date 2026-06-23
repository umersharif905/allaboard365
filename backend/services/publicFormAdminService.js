const crypto = require('crypto');
const { getPool, sql } = require('../config/database');

const SUBMISSION_TEMPLATE_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

function escapeSqlLikePattern(s) {
    return String(s)
        .replace(/\\/g, '\\\\')
        .replace(/\[/g, '[[]')
        .replace(/%/g, '[%]')
        .replace(/_/g, '[_]');
}

/**
 * When PUBLIC_FORMS_DEFAULT_SEED_TENANT_IDS is set (comma-separated tenant GUIDs), only those
 * tenants get the three auto-seeded default sharing forms (UnsharedAmount, AdditionalDocuments,
 * PreventiveCare) on GET /templates. When unset or empty, all tenants are seeded (legacy behavior).
 */
function shouldAutoSeedDefaultPublicForms(tenantId) {
    const raw = process.env.PUBLIC_FORMS_DEFAULT_SEED_TENANT_IDS;
    if (raw == null || String(raw).trim() === '') {
        return true;
    }
    const normalized = String(tenantId).replace(/[{}]/g, '').toLowerCase();
    const allow = new Set(
        String(raw)
            .split(',')
            .map((s) => s.trim().replace(/[{}]/g, '').toLowerCase())
            .filter(Boolean)
    );
    return allow.has(normalized);
}

const EMAIL_ROLLUP_SQL = `
    OUTER APPLY (
        SELECT
            COUNT(1) AS EmailLogCount,
            SUM(CASE WHEN COALESCE(q.Status, h.Status) = N'Sent' THEN 1 ELSE 0 END) AS EmailSentCount,
            SUM(CASE WHEN COALESCE(q.Status, h.Status) IN (N'Pending', N'Processing') THEN 1 ELSE 0 END) AS EmailPendingCount,
            SUM(CASE WHEN COALESCE(q.Status, h.Status) IN (N'Failed', N'SentHistoryFailed') THEN 1 ELSE 0 END) AS EmailFailedCount,
            MAX(COALESCE(h.SentDate, q.ProcessedDate, q.CreatedDate, l.CreatedDate)) AS LastEmailStatusDate
        FROM oe.PublicFormEmailLog l
        OUTER APPLY (
            SELECT TRY_CONVERT(uniqueidentifier, l.MessageId) AS QueueMessageId
        ) m
        LEFT JOIN oe.MessageQueue q ON q.MessageId = m.QueueMessageId
        OUTER APPLY (
            SELECT TOP 1 mh.Status, mh.SentDate
            FROM oe.MessageHistory mh
            WHERE mh.MessageId = m.QueueMessageId
            ORDER BY mh.SentDate DESC
        ) h
        WHERE l.SubmissionId = s.SubmissionId
          AND l.EmailType = N'routing'
    ) el
`;

/**
 * @param {import('mssql').Request} req
 * @param {string} tenantId
 * @param {object} f
 * @returns {string} WHERE clause (starts with WHERE)
 */
function bindSubmissionListFilters(req, tenantId, f) {
    req.input('tenantId', sql.UniqueIdentifier, tenantId);
    let where = 'WHERE s.TenantId = @tenantId';
    if (f.memberMatchStatus) {
        where += ' AND s.MemberMatchStatus = @mms';
        req.input('mms', sql.NVarChar, f.memberMatchStatus);
    }
    if (f.from) {
        where += ' AND s.CreatedDate >= @fromDt';
        req.input('fromDt', sql.DateTime2, new Date(f.from));
    }
    if (f.to) {
        where += ' AND s.CreatedDate <= @toDt';
        req.input('toDt', sql.DateTime2, new Date(f.to));
    }
    if (f.formTemplateId && SUBMISSION_TEMPLATE_ID_RE.test(String(f.formTemplateId))) {
        where += ' AND s.FormTemplateId = @ftid';
        req.input('ftid', sql.UniqueIdentifier, f.formTemplateId);
    }
    if (f.formKind && String(f.formKind).trim()) {
        where += ' AND s.FormKind = @fk';
        req.input('fk', sql.NVarChar, String(f.formKind).trim());
    }
    // Forms-page redesign: resolution status maps to (MemberId, ShareRequestId,
    // CaseId) trinity. unresolved = no member; resolved-not-linked = member
    // pinned but no SR/Case; resolved-linked = member pinned + SR or Case set.
    if (f.resolutionStatus) {
        const rs = String(f.resolutionStatus).toLowerCase();
        if (rs === 'unresolved') {
            where += ' AND s.MemberId IS NULL';
        } else if (rs === 'resolved-not-linked') {
            where += ' AND s.MemberId IS NOT NULL AND s.ShareRequestId IS NULL AND s.CaseId IS NULL';
        } else if (rs === 'resolved-linked') {
            where += ' AND s.MemberId IS NOT NULL AND (s.ShareRequestId IS NOT NULL OR s.CaseId IS NOT NULL)';
        }
    }
    if (f.source) {
        const src = String(f.source).toLowerCase();
        if (src === 'anonymous' || src === 'targeted' || src === 'authenticated') {
            where += ' AND s.AuthMode = @authMode';
            req.input('authMode', sql.NVarChar, src);
        }
    }
    if (f.firstName && String(f.firstName).trim()) {
        where += ' AND s.PayloadFirstName LIKE @fnLike';
        req.input('fnLike', sql.NVarChar, `%${escapeSqlLikePattern(String(f.firstName).trim())}%`);
    }
    if (f.lastName && String(f.lastName).trim()) {
        where += ' AND s.PayloadLastName LIKE @lnLike';
        req.input('lnLike', sql.NVarChar, `%${escapeSqlLikePattern(String(f.lastName).trim())}%`);
    }
    if (f.q && String(f.q).trim()) {
        const like = `%${escapeSqlLikePattern(String(f.q).trim())}%`;
        // SearchableText is backfilled from decrypted payload; if backfill skipped a row (NULL),
        // still match keyword against columns that are often populated at submit time or manually.
        where += ` AND (
            (s.SearchableText IS NOT NULL AND s.SearchableText LIKE @qLike)
            OR (s.SubmittedMemberIdText IS NOT NULL AND s.SubmittedMemberIdText LIKE @qLike)
            OR (s.PayloadFirstName IS NOT NULL AND s.PayloadFirstName LIKE @qLike)
            OR (s.PayloadLastName IS NOT NULL AND s.PayloadLastName LIKE @qLike)
        )`;
        req.input('qLike', sql.NVarChar(sql.MAX), like);
    }
    if (f.cursorCreatedDate && f.cursorSubmissionId && SUBMISSION_TEMPLATE_ID_RE.test(String(f.cursorSubmissionId))) {
        where += ' AND (s.CreatedDate < @curCd OR (s.CreatedDate = @curCd AND s.SubmissionId < @curSid))';
        req.input('curCd', sql.DateTime2, new Date(f.cursorCreatedDate));
        req.input('curSid', sql.UniqueIdentifier, f.cursorSubmissionId);
    }
    return where;
}
const { decryptPayloadObject } = require('./publicFormCrypto');
const { getDefaultDefinitionJson, getBlankCustomDefinitionJson } = require('./publicFormDefaults');
const { resolveMemberForTenants, buildResolverTenantSet } = require('./publicFormMemberResolver');
const { getPublicFormsActorUserId } = require('./publicFormActor');
const { linkSubmissionToShareWorkflow } = require('./publicFormShareLinkService');
const {
    sendSubmissionNotifications,
    resolveRoutingNotificationRecipients,
    normalizeNotifyEmailsForStorage,
    buildSubmissionDataUrl,
    normalizeLinkBaseOverride
} = require('./publicFormNotifyService');

/**
 * Pull the tenant's custom domain (preferring the column, falling back to
 * AdvancedSettings.domain.customDomain so legacy rows still work) and turn it
 * into an absolute https origin. Returns '' when none is configured.
 *
 * @param {string} tenantId
 * @returns {Promise<string>} e.g. "https://portal.acme.com"
 */
async function getTenantCustomDomainBase(tenantId) {
    const pool = await getPool();
    const row = (await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .query(
            `SELECT CustomDomain, AdvancedSettings FROM oe.Tenants WHERE TenantId = @tenantId`
        )).recordset[0];
    if (!row) return '';
    let advanced = {};
    if (row.AdvancedSettings) {
        try {
            advanced = typeof row.AdvancedSettings === 'string'
                ? JSON.parse(row.AdvancedSettings)
                : row.AdvancedSettings;
        } catch {
            advanced = {};
        }
    }
    const raw = String(row.CustomDomain || advanced?.domain?.customDomain || '')
        .trim()
        .replace(/^https?:\/\//i, '')
        .split('/')[0];
    return raw ? `https://${raw}` : '';
}

/** Default app base used when nothing custom is configured. */
function getDefaultAppBase() {
    return (process.env.APP_BASE_URL || 'https://app.allaboard365.com').replace(/\/+$/, '');
}

/**
 * Validate a link base override against the bases the tenant is actually
 * allowed to use. Prevents the resend dialog from being abused to issue
 * arbitrary phishing-style links. Allowed:
 *   - any http(s)://localhost(:port) or http(s)://127.0.0.1(:port)
 *   - the tenant's CustomDomain (if any)
 *   - the configured default app base (APP_BASE_URL or app.allaboard365.com)
 *
 * @param {string|null|undefined} raw caller-provided override
 * @param {{ tenantCustomDomain: string, defaultAppBase: string }} allowed
 * @returns {string} normalized override URL, or '' when not allowed
 */
function pickAllowedLinkBaseOverride(raw, allowed) {
    const normalized = normalizeLinkBaseOverride(raw);
    if (!normalized) return '';
    let host;
    try {
        host = new URL(normalized).host.toLowerCase();
    } catch {
        return '';
    }
    const hostname = host.split(':')[0];
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
        return normalized;
    }
    const allowedHosts = new Set();
    for (const candidate of [allowed?.tenantCustomDomain, allowed?.defaultAppBase]) {
        if (!candidate) continue;
        try {
            allowedHosts.add(new URL(candidate).host.toLowerCase());
        } catch {
            // ignore malformed allow-list entries
        }
    }
    if (allowedHosts.has(host)) return normalized;
    return '';
}

async function getPublishedDefinitionByTemplateId(formTemplateId) {
    const pool = await getPool();
    const r = await pool.request()
        .input('id', sql.UniqueIdentifier, formTemplateId)
        .query(`
            SELECT
                t.FormTemplateId,
                t.TenantId,
                t.FormKind,
                t.Title,
                t.KindLabel,
                t.IsPublished,
                t.PublishedVersion,
                t.NotifyEmails,
                t.DefaultVendorId,
                t.AllowedFrameAncestors,
                t.AllowAnonymous,
                t.AllowTargeted,
                t.AllowAuthenticated,
                t.CreatesShareRequestOnSubmit,
                t.CreatesCaseOnSubmit,
                t.ResolverTenantIds,
                v.DefinitionJson,
                tn.Name AS TenantName
            FROM oe.PublicFormTemplates t
            INNER JOIN oe.PublicFormTemplateVersions v
                ON v.FormTemplateId = t.FormTemplateId
                AND v.VersionNumber = t.PublishedVersion
            INNER JOIN oe.Tenants tn ON tn.TenantId = t.TenantId
            WHERE t.FormTemplateId = @id AND t.IsPublished = 1 AND ISNULL(t.IsActive, 1) = 1
        `);
    return r.recordset[0] || null;
}

/**
 * Create a new draft template with an empty field list. FormKind is K_{uuid} so it is unique per
 * tenant under UQ_PublicFormTemplates_Tenant_Kind (share workflow treats unknown kinds like UA/Medical).
 */
async function createBlankTemplate(tenantId, title, kindLabel, createdByUserId) {
    const pool = await getPool();
    const formTemplateId = crypto.randomUUID();
    const formKind = `K_${formTemplateId.replace(/-/g, '')}`;
    const safeTitle = String(title || 'New form').trim().slice(0, 500) || 'New form';
    const safeKindLabel = String(kindLabel || '').trim().slice(0, 128);
    if (!safeKindLabel) {
        throw new Error('kindLabel is required');
    }
    const def = getBlankCustomDefinitionJson(safeTitle);

    await pool.request()
        .input('id', sql.UniqueIdentifier, formTemplateId)
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('kind', sql.NVarChar(50), formKind)
        .input('title', sql.NVarChar(500), safeTitle)
        .input('kindLabel', sql.NVarChar(128), safeKindLabel)
        .input('notify', sql.NVarChar(sql.MAX), '[]')
        .query(`
            INSERT INTO oe.PublicFormTemplates (
                FormTemplateId, TenantId, FormKind, Title, IsPublished, PublishedVersion,
                NotifyEmails, AllowedFrameAncestors, KindLabel, IsActive, CreatedDate, ModifiedDate
            ) VALUES (
                @id, @tenantId, @kind, @title, 0, NULL, @notify, N'*', @kindLabel, 1, SYSUTCDATETIME(), SYSUTCDATETIME()
            )
        `);

    await pool.request()
        .input('vid', sql.UniqueIdentifier, crypto.randomUUID())
        .input('tid', sql.UniqueIdentifier, formTemplateId)
        .input('def', sql.NVarChar(sql.MAX), def)
        .input('note', sql.NVarChar, 'Created')
        .input('cb', sql.UniqueIdentifier, createdByUserId || null)
        .query(`
            INSERT INTO oe.PublicFormTemplateVersions (
                VersionId, FormTemplateId, VersionNumber, DefinitionJson, ChangeNote, CreatedBy, CreatedDate
            ) VALUES (@vid, @tid, 1, @def, @note, @cb, SYSUTCDATETIME())
        `);

    await pool.request()
        .input('id', sql.UniqueIdentifier, formTemplateId)
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .query(
            `UPDATE oe.PublicFormTemplates SET ModifiedDate = SYSUTCDATETIME() WHERE FormTemplateId = @id AND TenantId = @tenantId`
        );

    return { formTemplateId, versionNumber: 1 };
}

/**
 * Duplicates a form template (tenant-scoped). The copy keeps every setting and
 * the latest form definition; only the title differs (" (Copy)" appended) and
 * the publish state is reset — a duplicate starts as an unpublished draft.
 */
async function duplicateTemplate(tenantId, sourceFormTemplateId, createdByUserId) {
    const pool = await getPool();

    const src = (await pool.request()
        .input('id', sql.UniqueIdentifier, sourceFormTemplateId)
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .query(`
            SELECT TOP 1 Title, NotifyEmails, AllowedFrameAncestors, KindLabel, IsActive,
                   DefaultVendorId, AllowAnonymous, AllowTargeted, AllowAuthenticated,
                   CreatesShareRequestOnSubmit,
                   CreatesCaseOnSubmit
            FROM oe.PublicFormTemplates
            WHERE FormTemplateId = @id AND TenantId = @tenantId
        `)).recordset[0];
    if (!src) return { ok: false, reason: 'not_found' };

    const srcDef = (await pool.request()
        .input('id', sql.UniqueIdentifier, sourceFormTemplateId)
        .query(`
            SELECT TOP 1 DefinitionJson
            FROM oe.PublicFormTemplateVersions
            WHERE FormTemplateId = @id
            ORDER BY VersionNumber DESC
        `)).recordset[0];

    const baseTitle = String(src.Title || 'Untitled form').trim();
    const definitionJson = srcDef?.DefinitionJson || getBlankCustomDefinitionJson(baseTitle);

    const formTemplateId = crypto.randomUUID();
    const formKind = `K_${formTemplateId.replace(/-/g, '')}`;
    const copyTitle = `${baseTitle} (Copy)`.slice(0, 500);
    const copyKindLabel =
        (String(src.KindLabel || '').trim() || copyTitle).slice(0, 128) || 'Copy';

    await pool.request()
        .input('id', sql.UniqueIdentifier, formTemplateId)
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('kind', sql.NVarChar(50), formKind)
        .input('title', sql.NVarChar(500), copyTitle)
        .input('notify', sql.NVarChar(sql.MAX), src.NotifyEmails || '[]')
        .input('frame', sql.NVarChar(sql.MAX), src.AllowedFrameAncestors || '*')
        .input('kindLabel', sql.NVarChar(128), copyKindLabel)
        .input('isActive', sql.Bit, src.IsActive == null ? 1 : (src.IsActive ? 1 : 0))
        .input('defaultVendorId', sql.UniqueIdentifier, src.DefaultVendorId || null)
        .input('allowAnon', sql.Bit, src.AllowAnonymous == null ? 1 : (src.AllowAnonymous ? 1 : 0))
        .input('allowTargeted', sql.Bit, src.AllowTargeted ? 1 : 0)
        .input('allowAuth', sql.Bit, src.AllowAuthenticated ? 1 : 0)
        .input('createsSr', sql.Bit, src.CreatesShareRequestOnSubmit ? 1 : 0)
        .input('createsCase', sql.Bit, src.CreatesCaseOnSubmit ? 1 : 0)
        .query(`
            INSERT INTO oe.PublicFormTemplates (
                FormTemplateId, TenantId, FormKind, Title, IsPublished, PublishedVersion,
                NotifyEmails, AllowedFrameAncestors, KindLabel, IsActive, DefaultVendorId,
                AllowAnonymous, AllowTargeted, AllowAuthenticated, CreatesShareRequestOnSubmit,
                CreatesCaseOnSubmit,
                CreatedDate, ModifiedDate
            ) VALUES (
                @id, @tenantId, @kind, @title, 0, NULL,
                @notify, @frame, @kindLabel, @isActive, @defaultVendorId,
                @allowAnon, @allowTargeted, @allowAuth, @createsSr,
                @createsCase,
                SYSUTCDATETIME(), SYSUTCDATETIME()
            )
        `);

    await pool.request()
        .input('vid', sql.UniqueIdentifier, crypto.randomUUID())
        .input('tid', sql.UniqueIdentifier, formTemplateId)
        .input('def', sql.NVarChar(sql.MAX), definitionJson)
        .input('note', sql.NVarChar, `Duplicated from "${baseTitle.slice(0, 180)}"`)
        .input('cb', sql.UniqueIdentifier, createdByUserId || null)
        .query(`
            INSERT INTO oe.PublicFormTemplateVersions (
                VersionId, FormTemplateId, VersionNumber, DefinitionJson, ChangeNote, CreatedBy, CreatedDate
            ) VALUES (@vid, @tid, 1, @def, @note, @cb, SYSUTCDATETIME())
        `);

    return { ok: true, formTemplateId, versionNumber: 1 };
}

async function deleteTemplate(tenantId, formTemplateId) {
    const pool = await getPool();
    const cntRow = (await pool.request()
        .input('tid', sql.UniqueIdentifier, formTemplateId)
        .query(`SELECT COUNT(*) AS c FROM oe.PublicFormSubmissions WHERE FormTemplateId = @tid`)).recordset[0];
    const cnt = Number(cntRow?.c) || 0;
    if (cnt > 0) {
        return { ok: false, reason: 'has_submissions' };
    }
    const result = await pool.request()
        .input('id', sql.UniqueIdentifier, formTemplateId)
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .query(`DELETE FROM oe.PublicFormTemplates WHERE FormTemplateId = @id AND TenantId = @tenantId`);
    if (!result.rowsAffected || result.rowsAffected[0] === 0) return { ok: false, reason: 'not_found' };
    return { ok: true };
}

async function listTemplatesForTenant(tenantId) {
    const pool = await getPool();
    return (await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .query(`
            SELECT
                t.FormTemplateId,
                t.FormKind,
                t.Title,
                t.IsPublished,
                t.PublishedVersion,
                t.NotifyEmails,
                t.DefaultVendorId,
                t.AllowedFrameAncestors,
                t.KindLabel,
                t.IsActive,
                t.AllowAnonymous,
                t.AllowTargeted,
                t.AllowAuthenticated,
                t.CreatesShareRequestOnSubmit,
                t.CreatesCaseOnSubmit,
                t.CreatedDate,
                t.ModifiedDate,
                (
                    SELECT COUNT(1)
                    FROM oe.PublicFormSubmissions s
                    WHERE s.FormTemplateId = t.FormTemplateId
                ) AS SubmissionCount,
                (
                    SELECT COUNT(1)
                    FROM oe.PublicFormInvitations i
                    WHERE i.FormTemplateId = t.FormTemplateId
                      AND i.RevokedAt IS NULL
                      AND (i.ExpiresAt IS NULL OR i.ExpiresAt > SYSUTCDATETIME())
                ) AS ActiveInvitationCount
            FROM oe.PublicFormTemplates t
            WHERE t.TenantId = @tenantId
            ORDER BY t.Title
        `)).recordset;
}

async function getTemplateDetailForTenant(tenantId, formTemplateId) {
    const pool = await getPool();
    const t = (await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('id', sql.UniqueIdentifier, formTemplateId)
        .query(`
            SELECT * FROM oe.PublicFormTemplates
            WHERE TenantId = @tenantId AND FormTemplateId = @id
        `)).recordset[0];
    if (!t) return null;
    const versions = (await pool.request()
        .input('id', sql.UniqueIdentifier, formTemplateId)
        .query(`
            SELECT VersionId, VersionNumber, ChangeNote, CreatedDate, CreatedBy
            FROM oe.PublicFormTemplateVersions
            WHERE FormTemplateId = @id
            ORDER BY VersionNumber DESC
        `)).recordset;
    const latest = (await pool.request()
        .input('id', sql.UniqueIdentifier, formTemplateId)
        .query(`
            SELECT TOP 1 DefinitionJson, VersionNumber
            FROM oe.PublicFormTemplateVersions
            WHERE FormTemplateId = @id
            ORDER BY VersionNumber DESC
        `)).recordset[0];
    return { template: t, versions, latestDefinition: latest };
}

/**
 * Care-team preview payload for a template. Returns the published version's
 * definition when published; falls back to the latest draft otherwise so the
 * forms-tab View button works on unpublished forms too. Tenant-scoped.
 */
async function getPreviewPayloadForTenant(tenantId, formTemplateId) {
    const pool = await getPool();
    const tpl = (await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('id', sql.UniqueIdentifier, formTemplateId)
        .query(`
            SELECT FormTemplateId, TenantId, Title, FormKind, IsPublished, PublishedVersion
            FROM oe.PublicFormTemplates
            WHERE TenantId = @tenantId AND FormTemplateId = @id
        `)).recordset[0];
    if (!tpl) return null;
    let row;
    if (tpl.IsPublished && tpl.PublishedVersion) {
        row = (await pool.request()
            .input('id', sql.UniqueIdentifier, formTemplateId)
            .input('vn', sql.Int, tpl.PublishedVersion)
            .query(`
                SELECT TOP 1 DefinitionJson, VersionNumber
                FROM oe.PublicFormTemplateVersions
                WHERE FormTemplateId = @id AND VersionNumber = @vn
            `)).recordset[0];
    }
    if (!row) {
        row = (await pool.request()
            .input('id', sql.UniqueIdentifier, formTemplateId)
            .query(`
                SELECT TOP 1 DefinitionJson, VersionNumber
                FROM oe.PublicFormTemplateVersions
                WHERE FormTemplateId = @id
                ORDER BY VersionNumber DESC
            `)).recordset[0];
    }
    if (!row) {
        return { template: tpl, definitionJson: null, versionNumber: null, isDraftPreview: !tpl.IsPublished };
    }
    return {
        template: tpl,
        definitionJson: row.DefinitionJson,
        versionNumber: row.VersionNumber,
        isDraftPreview: !tpl.IsPublished
    };
}

async function getTemplateVersionDefinition(tenantId, formTemplateId, versionNumber) {
    const pool = await getPool();
    const vn = parseInt(versionNumber, 10);
    if (!Number.isFinite(vn) || vn < 1) return null;
    const row = (await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('id', sql.UniqueIdentifier, formTemplateId)
        .input('vn', sql.Int, vn)
        .query(`
            SELECT v.DefinitionJson, v.VersionNumber, v.ChangeNote, v.CreatedDate
            FROM oe.PublicFormTemplateVersions v
            INNER JOIN oe.PublicFormTemplates t ON t.FormTemplateId = v.FormTemplateId
            WHERE t.TenantId = @tenantId AND v.FormTemplateId = @id AND v.VersionNumber = @vn
        `)).recordset[0];
    return row || null;
}

async function ensureDefaultTemplatesForTenant(tenantId) {
    if (!shouldAutoSeedDefaultPublicForms(tenantId)) {
        return;
    }
    const kinds = ['UnsharedAmount', 'AdditionalDocuments', 'PreventiveCare'];
    const pool = await getPool();
    for (const formKind of kinds) {
        const exists = (await pool.request()
            .input('tenantId', sql.UniqueIdentifier, tenantId)
            .input('kind', sql.NVarChar, formKind)
            .query(`
                SELECT FormTemplateId FROM oe.PublicFormTemplates
                WHERE TenantId = @tenantId AND FormKind = @kind
            `)).recordset[0];
        if (exists) continue;
        const formTemplateId = crypto.randomUUID();
        const def = getDefaultDefinitionJson(formKind);
        await pool.request()
            .input('id', sql.UniqueIdentifier, formTemplateId)
            .input('tenantId', sql.UniqueIdentifier, tenantId)
            .input('kind', sql.NVarChar, formKind)
            .input('title', sql.NVarChar, JSON.parse(def).title)
            .input('notify', sql.NVarChar, '[]')
            .query(`
                INSERT INTO oe.PublicFormTemplates (
                    FormTemplateId, TenantId, FormKind, Title, IsPublished, PublishedVersion,
                    NotifyEmails, AllowedFrameAncestors, CreatedDate, ModifiedDate
                ) VALUES (
                    @id, @tenantId, @kind, @title, 1, 1, @notify, N'*', SYSUTCDATETIME(), SYSUTCDATETIME()
                )
            `);
        await pool.request()
            .input('vid', sql.UniqueIdentifier, crypto.randomUUID())
            .input('tid', sql.UniqueIdentifier, formTemplateId)
            .input('def', sql.NVarChar(sql.MAX), def)
            .query(`
                INSERT INTO oe.PublicFormTemplateVersions (VersionId, FormTemplateId, VersionNumber, DefinitionJson, ChangeNote, CreatedDate)
                VALUES (@vid, @tid, 1, @def, N'Seed', SYSUTCDATETIME())
            `);
    }
}

async function saveNewVersion(tenantId, formTemplateId, definitionJson, changeNote, createdBy) {
    const pool = await getPool();
    const t = (await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('id', sql.UniqueIdentifier, formTemplateId)
        .query(`SELECT FormTemplateId FROM oe.PublicFormTemplates WHERE TenantId = @tenantId AND FormTemplateId = @id`)).recordset[0];
    if (!t) return null;
    JSON.parse(definitionJson); // validate JSON
    const maxRow = (await pool.request()
        .input('id', sql.UniqueIdentifier, formTemplateId)
        .query(`SELECT MAX(VersionNumber) AS mx FROM oe.PublicFormTemplateVersions WHERE FormTemplateId = @id`)).recordset[0];
    const next = (maxRow.mx || 0) + 1;
    await pool.request()
        .input('vid', sql.UniqueIdentifier, crypto.randomUUID())
        .input('tid', sql.UniqueIdentifier, formTemplateId)
        .input('vn', sql.Int, next)
        .input('def', sql.NVarChar(sql.MAX), definitionJson)
        .input('note', sql.NVarChar, changeNote || null)
        .input('cb', sql.UniqueIdentifier, createdBy || null)
        .query(`
            INSERT INTO oe.PublicFormTemplateVersions (
                VersionId, FormTemplateId, VersionNumber, DefinitionJson, ChangeNote, CreatedBy, CreatedDate
            ) VALUES (@vid, @tid, @vn, @def, @note, @cb, SYSUTCDATETIME())
        `);
    await pool.request()
        .input('id', sql.UniqueIdentifier, formTemplateId)
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .query(
            `UPDATE oe.PublicFormTemplates SET ModifiedDate = SYSUTCDATETIME() WHERE FormTemplateId = @id AND TenantId = @tenantId`
        );
    return { versionNumber: next };
}

async function publishVersion(tenantId, formTemplateId, versionNumber) {
    const pool = await getPool();
    const ok = (await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('id', sql.UniqueIdentifier, formTemplateId)
        .input('vn', sql.Int, versionNumber)
        .query(`
            SELECT 1 AS x
            FROM oe.PublicFormTemplates t
            INNER JOIN oe.PublicFormTemplateVersions v ON v.FormTemplateId = t.FormTemplateId AND v.VersionNumber = @vn
            WHERE t.TenantId = @tenantId AND t.FormTemplateId = @id
        `)).recordset[0];
    if (!ok) return false;
    await pool.request()
        .input('id', sql.UniqueIdentifier, formTemplateId)
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('vn', sql.Int, versionNumber)
        .query(`
            UPDATE oe.PublicFormTemplates
            SET IsPublished = 1, PublishedVersion = @vn, ModifiedDate = SYSUTCDATETIME()
            WHERE FormTemplateId = @id AND TenantId = @tenantId
        `);
    return true;
}

async function updateTemplateMeta(tenantId, formTemplateId, body) {
    const pool = await getPool();
    const t = (await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('id', sql.UniqueIdentifier, formTemplateId)
        .query(`SELECT FormTemplateId FROM oe.PublicFormTemplates WHERE TenantId = @tenantId AND FormTemplateId = @id`)).recordset[0];
    if (!t) return false;
    const req = pool.request()
        .input('id', sql.UniqueIdentifier, formTemplateId)
        .input('tenantId', sql.UniqueIdentifier, tenantId);
    const sets = [];
    if (body.title !== undefined) {
        sets.push('Title = @title');
        req.input('title', sql.NVarChar, body.title);
    }
    if (body.notifyEmails !== undefined) {
        sets.push('NotifyEmails = @notifyEmails');
        req.input('notifyEmails', sql.NVarChar(sql.MAX), normalizeNotifyEmailsForStorage(body.notifyEmails));
    }
    if (body.defaultVendorId !== undefined) {
        sets.push('DefaultVendorId = @defaultVendorId');
        let v = body.defaultVendorId;
        if (typeof v === 'string') v = v.trim();
        // Empty string / falsy → DB NULL.
        if (!v) {
            v = null;
        } else if (typeof v !== 'string' || !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(v)) {
            console.warn('updateTemplateMeta: defaultVendorId not a valid GUID:', JSON.stringify(body.defaultVendorId));
            const err = new Error('defaultVendorId must be a valid GUID or empty');
            err.statusCode = 400;
            throw err;
        }
        req.input('defaultVendorId', sql.UniqueIdentifier, v);
    }
    if (body.resolverTenantIds !== undefined) {
        // Allow-list of tenant ids the member-ID resolver may search for this form
        // (a vendor-wide form serves members across sibling tenants). Stored as a
        // JSON array string; buildResolverTenantSet() reads it. Empty/null => own
        // tenant only.
        sets.push('ResolverTenantIds = @resolverTenantIds');
        const val = body.resolverTenantIds;
        if (val == null || (Array.isArray(val) && val.length === 0)) {
            req.input('resolverTenantIds', sql.NVarChar(sql.MAX), null);
        } else if (!Array.isArray(val)) {
            const err = new Error('resolverTenantIds must be an array of tenant GUIDs or empty');
            err.statusCode = 400;
            throw err;
        } else {
            const guidRe = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
            const cleaned = [...new Set(val.map((x) => String(x).trim()).filter(Boolean))];
            for (const g of cleaned) {
                if (!guidRe.test(g)) {
                    const err = new Error('resolverTenantIds contains an invalid GUID');
                    err.statusCode = 400;
                    throw err;
                }
            }
            req.input('resolverTenantIds', sql.NVarChar(sql.MAX), cleaned.length ? JSON.stringify(cleaned) : null);
        }
    }
    if (body.allowedFrameAncestors !== undefined) {
        sets.push('AllowedFrameAncestors = @allowedFrameAncestors');
        req.input('allowedFrameAncestors', sql.NVarChar(sql.MAX), body.allowedFrameAncestors);
    }
    if (body.kindLabel !== undefined) {
        const kl =
            body.kindLabel === null || body.kindLabel === ''
                ? null
                : String(body.kindLabel).trim().slice(0, 128) || null;
        sets.push('KindLabel = @kindLabel');
        req.input('kindLabel', sql.NVarChar(128), kl);
    }
    if (body.isActive !== undefined) {
        sets.push('IsActive = @isActive');
        req.input('isActive', sql.Bit, body.isActive ? 1 : 0);
    }
    // Forms-redesign: delivery-mode flags + auto-SR flag (Section 1 of design.md).
    // Validation: at least one of allowAnonymous / allowTargeted / allowAuthenticated
    // must remain 1 after the patch. We reject patches that would clear all three.
    const allowAnonymousPatch = body.allowAnonymous !== undefined ? Boolean(body.allowAnonymous) : null;
    const allowTargetedPatch = body.allowTargeted !== undefined ? Boolean(body.allowTargeted) : null;
    const allowAuthenticatedPatch = body.allowAuthenticated !== undefined ? Boolean(body.allowAuthenticated) : null;
    if (
        allowAnonymousPatch !== null
        || allowTargetedPatch !== null
        || allowAuthenticatedPatch !== null
    ) {
        const current = (await pool.request()
            .input('tenantId', sql.UniqueIdentifier, tenantId)
            .input('id', sql.UniqueIdentifier, formTemplateId)
            .query(`SELECT AllowAnonymous, AllowTargeted, AllowAuthenticated FROM oe.PublicFormTemplates WHERE TenantId = @tenantId AND FormTemplateId = @id`)).recordset[0];
        const resolvedAnonymous = allowAnonymousPatch ?? Boolean(current?.AllowAnonymous);
        const resolvedTargeted = allowTargetedPatch ?? Boolean(current?.AllowTargeted);
        const resolvedAuthenticated = allowAuthenticatedPatch ?? Boolean(current?.AllowAuthenticated);
        if (!resolvedAnonymous && !resolvedTargeted && !resolvedAuthenticated) {
            const err = new Error('At least one of allowAnonymous / allowTargeted / allowAuthenticated must be enabled.');
            err.statusCode = 400;
            throw err;
        }
        if (allowAnonymousPatch !== null) {
            sets.push('AllowAnonymous = @allowAnonymous');
            req.input('allowAnonymous', sql.Bit, allowAnonymousPatch ? 1 : 0);
        }
        if (allowTargetedPatch !== null) {
            sets.push('AllowTargeted = @allowTargeted');
            req.input('allowTargeted', sql.Bit, allowTargetedPatch ? 1 : 0);
        }
        if (allowAuthenticatedPatch !== null) {
            sets.push('AllowAuthenticated = @allowAuthenticated');
            req.input('allowAuthenticated', sql.Bit, allowAuthenticatedPatch ? 1 : 0);
        }
    }
    if (body.createsShareRequestOnSubmit !== undefined) {
        sets.push('CreatesShareRequestOnSubmit = @createsSr');
        req.input('createsSr', sql.Bit, body.createsShareRequestOnSubmit ? 1 : 0);
    }
    if (body.createsCaseOnSubmit !== undefined) {
        sets.push('CreatesCaseOnSubmit = @createsCase');
        req.input('createsCase', sql.Bit, body.createsCaseOnSubmit ? 1 : 0);
    }
    if (!sets.length) return true;
    sets.push('ModifiedDate = SYSUTCDATETIME()');
    await req.query(
        `UPDATE oe.PublicFormTemplates SET ${sets.join(', ')} WHERE FormTemplateId = @id AND TenantId = @tenantId`
    );
    return true;
}

async function listSubmissions(tenantId, filters = {}) {
    const pool = await getPool();
    const page = Math.max(parseInt(filters.page, 10) || 1, 1);
    const cappedLimit = Math.min(Math.max(parseInt(filters.limit, 10) || 25, 1), 100);
    const useKeyset = Boolean(
        filters.cursorCreatedDate
        && filters.cursorSubmissionId
        && SUBMISSION_TEMPLATE_ID_RE.test(String(filters.cursorSubmissionId))
    );

    const f = {
        memberMatchStatus: filters.memberMatchStatus || undefined,
        from: filters.from || undefined,
        to: filters.to || undefined,
        formTemplateId: filters.formTemplateId || undefined,
        formKind: filters.formKind || undefined,
        resolutionStatus: filters.resolutionStatus || undefined,
        source: filters.source || undefined,
        firstName: filters.firstName || undefined,
        lastName: filters.lastName || undefined,
        q: filters.q || undefined,
        cursorCreatedDate: useKeyset ? filters.cursorCreatedDate : undefined,
        cursorSubmissionId: useKeyset ? filters.cursorSubmissionId : undefined
    };

    const fNoCursor = { ...f, cursorCreatedDate: undefined, cursorSubmissionId: undefined };

    const countReq = pool.request();
    const countWhere = bindSubmissionListFilters(countReq, tenantId, fNoCursor);
    const cnt = await countReq.query(`SELECT COUNT(*) AS c FROM oe.PublicFormSubmissions s ${countWhere}`);
    const total = cnt.recordset[0].c;

    const aggReq = pool.request();
    const aggWhere = bindSubmissionListFilters(aggReq, tenantId, fNoCursor);
    const agg = await aggReq.query(`
        SELECT
            SUM(CASE WHEN s.AnonymousLinkFirstViewedAt IS NOT NULL THEN 1 ELSE 0 END) AS CountWithLinkView,
            AVG(CASE WHEN s.AnonymousLinkFirstViewedAt IS NOT NULL
                THEN CAST(DATEDIFF_BIG(SECOND, s.CreatedDate, s.AnonymousLinkFirstViewedAt) AS FLOAT) END) AS AvgSecondsToLinkView,
            SUM(CASE WHEN s.RoutingEmailFirstOpenedAt IS NOT NULL THEN 1 ELSE 0 END) AS CountWithEmailOpen,
            AVG(CASE WHEN s.RoutingEmailFirstOpenedAt IS NOT NULL
                THEN CAST(DATEDIFF_BIG(SECOND, s.CreatedDate, s.RoutingEmailFirstOpenedAt) AS FLOAT) END) AS AvgSecondsToEmailOpen
        FROM oe.PublicFormSubmissions s
        ${aggWhere}
    `);
    const aggRow = agg.recordset[0] || {};

    const dataReq = pool.request();
    const dataWhere = bindSubmissionListFilters(dataReq, tenantId, f);
    if (useKeyset) {
        dataReq.input('lim', sql.Int, cappedLimit);
    } else {
        const offset = (page - 1) * cappedLimit;
        dataReq.input('off', sql.Int, offset);
        dataReq.input('lim', sql.Int, cappedLimit);
    }

    const pagingSql = useKeyset
        ? 'ORDER BY s.CreatedDate DESC, s.SubmissionId DESC OFFSET 0 ROWS FETCH NEXT @lim ROWS ONLY'
        : 'ORDER BY s.CreatedDate DESC, s.SubmissionId DESC OFFSET @off ROWS FETCH NEXT @lim ROWS ONLY';

    const data = await dataReq.query(`
        SELECT
            s.SubmissionId,
            s.FormTemplateId,
            s.FormKind,
            s.CreatedDate,
            s.MemberId,
            s.MemberMatchStatus,
            s.SubmittedMemberIdText,
            s.ShareRequestId,
            s.CaseId,
            s.LinkedCaseId,
            s.AuthMode,
            s.InvitationId,
            s.LinkedDate,
            s.LinkError,
            s.AnonymousLinkFirstViewedAt,
            s.RoutingEmailFirstOpenedAt,
            s.PayloadFirstName,
            s.PayloadLastName,
            CASE WHEN s.AnonymousLinkFirstViewedAt IS NOT NULL
                THEN DATEDIFF_BIG(SECOND, s.CreatedDate, s.AnonymousLinkFirstViewedAt) END AS SecondsToLinkView,
            CASE WHEN s.RoutingEmailFirstOpenedAt IS NOT NULL
                THEN DATEDIFF_BIG(SECOND, s.CreatedDate, s.RoutingEmailFirstOpenedAt) END AS SecondsToEmailOpen,
            sr.RequestNumber,
            c.CaseNumber,
            tpl.Title AS FormTitle,
            tpl.KindLabel AS TemplateKindLabel,
            u.FirstName AS MemberFirstName,
            u.LastName AS MemberLastName,
            ISNULL(el.EmailSentCount, 0) AS EmailSentCount,
            ISNULL(el.EmailPendingCount, 0) AS EmailPendingCount,
            ISNULL(el.EmailFailedCount, 0) AS EmailFailedCount,
            ISNULL(el.EmailLogCount, 0) AS EmailLogCount,
            el.LastEmailStatusDate
        FROM oe.PublicFormSubmissions s
        LEFT JOIN oe.ShareRequests sr ON sr.ShareRequestId = s.ShareRequestId
        -- Case can live in CaseId (linked) or LinkedCaseId (auto-spawned on submit).
        LEFT JOIN oe.Cases c ON c.CaseId = COALESCE(s.CaseId, s.LinkedCaseId)
        LEFT JOIN oe.PublicFormTemplates tpl ON tpl.FormTemplateId = s.FormTemplateId
        LEFT JOIN oe.Members m ON m.MemberId = s.MemberId
        LEFT JOIN oe.Users u ON u.UserId = m.UserId
        ${EMAIL_ROLLUP_SQL}
        ${dataWhere}
        ${pagingSql}
    `);

    const rows = data.recordset || [];
    const last = rows[rows.length - 1];
    const nextCursor = useKeyset && last && rows.length === cappedLimit
        ? { createdDate: last.CreatedDate, submissionId: last.SubmissionId }
        : (!useKeyset && last && rows.length === cappedLimit && page * cappedLimit < total
            ? { createdDate: last.CreatedDate, submissionId: last.SubmissionId }
            : null);

    return {
        data: rows,
        total,
        page: useKeyset ? 1 : page,
        limit: cappedLimit,
        nextCursor,
        aggregates: {
            countWithLinkView: Number(aggRow.CountWithLinkView) || 0,
            avgSecondsToLinkView: aggRow.AvgSecondsToLinkView != null ? Number(aggRow.AvgSecondsToLinkView) : null,
            countWithEmailOpen: Number(aggRow.CountWithEmailOpen) || 0,
            avgSecondsToEmailOpen: aggRow.AvgSecondsToEmailOpen != null ? Number(aggRow.AvgSecondsToEmailOpen) : null
        }
    };
}

/**
 * Records first anonymous view of submission link (if not already set).
 * @returns {Promise<{ anonymousLinkFirstViewedAt: Date|null, createdDate: Date|null }|null>}
 */
async function recordAnonymousSubmissionFirstView(submissionId) {
    const pool = await getPool();
    await pool.request()
        .input('sid', sql.UniqueIdentifier, submissionId)
        .query(`
            UPDATE oe.PublicFormSubmissions
            SET AnonymousLinkFirstViewedAt = SYSUTCDATETIME()
            WHERE SubmissionId = @sid AND AnonymousLinkFirstViewedAt IS NULL
        `);
    const row = (await pool.request()
        .input('sid', sql.UniqueIdentifier, submissionId)
        .query(`
            SELECT AnonymousLinkFirstViewedAt, CreatedDate
            FROM oe.PublicFormSubmissions
            WHERE SubmissionId = @sid
        `)).recordset[0];
    if (!row) return null;
    return {
        anonymousLinkFirstViewedAt: row.AnonymousLinkFirstViewedAt || null,
        createdDate: row.CreatedDate || null
    };
}

/**
 * @param {string} providerMessageId SendGrid / MessageHistory provider id
 * @param {Date} eventUtc
 */
async function applyRoutingEmailFirstOpenedFromSendGrid(providerMessageId, eventUtc) {
    const pmid = String(providerMessageId || '').trim().replace(/^<|>$/g, '');
    if (!pmid) return { ok: false, reason: 'empty_id' };
    const pool = await getPool();
    const idVariants = [pmid];
    if (pmid.includes('.')) idVariants.push(pmid.split('.')[0]);
    let found = null;
    for (const vid of idVariants) {
        found = (await pool.request()
            .input('pmid', sql.NVarChar(300), vid)
            .query(`
                SELECT TOP 1 l.SubmissionId
                FROM oe.MessageHistory mh
                INNER JOIN oe.PublicFormEmailLog l
                    ON TRY_CONVERT(uniqueidentifier, l.MessageId) = mh.MessageId
                WHERE mh.ProviderMessageId = @pmid
                  AND l.EmailType = N'routing'
                ORDER BY mh.SentDate DESC
            `)).recordset[0];
        if (found) break;
    }
    if (!found) return { ok: false, reason: 'no_match' };
    await pool.request()
        .input('sid', sql.UniqueIdentifier, found.SubmissionId)
        .input('evt', sql.DateTime2, eventUtc)
        .query(`
            UPDATE oe.PublicFormSubmissions
            SET RoutingEmailFirstOpenedAt = CASE
                WHEN RoutingEmailFirstOpenedAt IS NULL OR RoutingEmailFirstOpenedAt > @evt THEN @evt
                ELSE RoutingEmailFirstOpenedAt
            END
            WHERE SubmissionId = @sid
        `);
    return { ok: true, submissionId: found.SubmissionId };
}

/**
 * Update a submission's linkage to a share request or case. Mutually
 * exclusive: both can't be non-null. Both null clears the linkage.
 * Tenant-scoped: the SR (or Case, eventually) must belong to the same
 * tenant as the submission.
 *
 * Slice D.1 of the forms-page redesign.
 */
async function updateSubmissionLinkage(tenantId, submissionId, { shareRequestId, caseId }) {
    const pool = await getPool();
    const submission = (await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('sid', sql.UniqueIdentifier, submissionId)
        .query(`
            SELECT SubmissionId, TenantId, MemberId
            FROM oe.PublicFormSubmissions
            WHERE SubmissionId = @sid AND TenantId = @tenantId
        `)).recordset[0];
    if (!submission) return { ok: false, reason: 'not_found' };
    if (!submission.MemberId) return { ok: false, reason: 'no_member' };
    if (shareRequestId && caseId) return { ok: false, reason: 'mutually_exclusive' };
    if (shareRequestId) {
        const sr = (await pool.request()
            .input('tenantId', sql.UniqueIdentifier, tenantId)
            .input('srId', sql.UniqueIdentifier, shareRequestId)
            .query(`
                SELECT sr.ShareRequestId
                FROM oe.ShareRequests sr
                INNER JOIN oe.Members m ON m.MemberId = sr.MemberId
                WHERE sr.ShareRequestId = @srId AND m.TenantId = @tenantId
            `)).recordset[0];
        if (!sr) return { ok: false, reason: 'sr_not_found' };
    }
    await pool.request()
        .input('sid', sql.UniqueIdentifier, submissionId)
        .input('srId', sql.UniqueIdentifier, shareRequestId || null)
        .input('caseId', sql.UniqueIdentifier, caseId || null)
        .query(`
            UPDATE oe.PublicFormSubmissions
            SET ShareRequestId = @srId,
                CaseId = @caseId,
                LinkedDate = SYSUTCDATETIME(),
                LinkError = NULL
            WHERE SubmissionId = @sid
        `);
    return { ok: true };
}

async function listSubmissionsForExport(tenantId, filters, maxRows) {
    const pool = await getPool();
    const cap = Math.min(Math.max(parseInt(maxRows, 10) || 5000, 1), 25000);
    const f = { ...filters, cursorCreatedDate: undefined, cursorSubmissionId: undefined };
    const dataReq = pool.request();
    const dataWhere = bindSubmissionListFilters(dataReq, tenantId, f);
    dataReq.input('lim', sql.Int, cap);
    const data = await dataReq.query(`
        SELECT
            s.SubmissionId,
            s.FormTemplateId,
            s.FormKind,
            s.CreatedDate,
            s.MemberId,
            s.MemberMatchStatus,
            s.SubmittedMemberIdText,
            s.PayloadFirstName,
            s.PayloadLastName,
            s.AnonymousLinkFirstViewedAt,
            s.RoutingEmailFirstOpenedAt,
            sr.RequestNumber,
            tpl.Title AS FormTitle,
            tpl.KindLabel AS TemplateKindLabel
        FROM oe.PublicFormSubmissions s
        LEFT JOIN oe.ShareRequests sr ON sr.ShareRequestId = s.ShareRequestId
        LEFT JOIN oe.PublicFormTemplates tpl ON tpl.FormTemplateId = s.FormTemplateId
        ${dataWhere}
        ORDER BY s.CreatedDate DESC, s.SubmissionId DESC
        OFFSET 0 ROWS FETCH NEXT @lim ROWS ONLY
    `);
    return data.recordset || [];
}

async function getSubmissionDetail(tenantId, submissionId) {
    const pool = await getPool();
    const row = (await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('sid', sql.UniqueIdentifier, submissionId)
        .query(`
            SELECT
                s.*,
                sr.RequestNumber,
                sr.VendorId AS ShareVendorId,
                u.FirstName AS MemberFirstName,
                u.LastName AS MemberLastName,
                u.Email AS MemberEmail,
                u.PhoneNumber AS MemberPhone
            FROM oe.PublicFormSubmissions s
            LEFT JOIN oe.ShareRequests sr ON sr.ShareRequestId = s.ShareRequestId
            LEFT JOIN oe.Members m ON m.MemberId = s.MemberId
            LEFT JOIN oe.Users u ON u.UserId = m.UserId
            WHERE s.TenantId = @tenantId AND s.SubmissionId = @sid
        `)).recordset[0];
    if (!row) return null;
    const files = (await pool.request()
        .input('sid', sql.UniqueIdentifier, submissionId)
        .query(`SELECT * FROM oe.PublicFormSubmissionFiles WHERE SubmissionId = @sid`)).recordset;
    let payload = null;
    try {
        payload = decryptPayloadObject(row.PayloadEncrypted, row.PayloadIv, row.PayloadAuthTag);
    } catch (e) {
        payload = { _decryptError: e.message };
    }
    return { ...row, payload, files };
}

async function getSubmissionDetailByPublicTokenHash(tokenHash) {
    const pool = await getPool();
    const row = (await pool.request()
        .input('tokenHash', sql.Char(64), tokenHash)
        .query(`
            SELECT s.*, sr.RequestNumber, sr.VendorId AS ShareVendorId, t.Title AS FormTitle
            FROM oe.PublicFormSubmissions s
            LEFT JOIN oe.ShareRequests sr ON sr.ShareRequestId = s.ShareRequestId
            LEFT JOIN oe.PublicFormTemplates t ON t.FormTemplateId = s.FormTemplateId
            WHERE s.PublicAccessTokenHash = @tokenHash
              AND ISNULL(s.PublicAccessRevoked, 0) = 0
              AND s.PublicAccessTokenExpiry IS NOT NULL
              AND s.PublicAccessTokenExpiry > SYSUTCDATETIME()
        `)).recordset[0];
    if (!row) return null;
    const files = (await pool.request()
        .input('sid', sql.UniqueIdentifier, row.SubmissionId)
        .query(`SELECT * FROM oe.PublicFormSubmissionFiles WHERE SubmissionId = @sid`)).recordset;
    let payload = null;
    try {
        payload = decryptPayloadObject(row.PayloadEncrypted, row.PayloadIv, row.PayloadAuthTag);
    } catch (e) {
        payload = { _decryptError: e.message };
    }
    return { ...row, payload, files };
}

async function resolveSubmissionMember(tenantId, submissionId) {
    const detail = await getSubmissionDetail(tenantId, submissionId);
    if (!detail) return { success: false, message: 'Not found' };
    const text = detail.SubmittedMemberIdText || (detail.payload && detail.payload.memberId);
    const pool = await getPool();
    // Re-resolve across the same cross-tenant allow-list the submit-time
    // resolver used (the owning template's ResolverTenantIds, always unioned
    // with the form's own tenant).
    const tmplRow = (await pool.request()
        .input('sid', sql.UniqueIdentifier, submissionId)
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .query(`
            SELECT t.ResolverTenantIds
            FROM oe.PublicFormSubmissions s
            LEFT JOIN oe.PublicFormTemplates t ON t.FormTemplateId = s.FormTemplateId
            WHERE s.SubmissionId = @sid AND s.TenantId = @tenantId
        `)).recordset[0];
    const resolverTenantSet = buildResolverTenantSet(tenantId, tmplRow?.ResolverTenantIds);
    const resolution = await resolveMemberForTenants(resolverTenantSet, String(text || ''));
    await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('sid', sql.UniqueIdentifier, submissionId)
        .input('mid', sql.UniqueIdentifier, resolution.memberId)
        .input('mms', sql.NVarChar, resolution.status)
        .input('ac', sql.Int, resolution.ambiguousCount)
        .query(`
            UPDATE oe.PublicFormSubmissions
            SET MemberId = @mid,
                MemberMatchStatus = @mms,
                AmbiguousMatchCount = @ac,
                LinkError = NULL
            WHERE SubmissionId = @sid AND TenantId = @tenantId
        `);
    return { success: true, resolution };
}

async function manuallySetMember(tenantId, submissionId, memberId) {
    const pool = await getPool();
    const ok = (await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('mid', sql.UniqueIdentifier, memberId)
        .query(`
            SELECT m.MemberId FROM oe.Members m WHERE m.MemberId = @mid AND m.TenantId = @tenantId
        `)).recordset[0];
    if (!ok) return { success: false, message: 'Member not in tenant' };
    await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('sid', sql.UniqueIdentifier, submissionId)
        .input('mid', sql.UniqueIdentifier, memberId)
        .query(`
            UPDATE oe.PublicFormSubmissions
            SET MemberId = @mid, MemberMatchStatus = N'Matched', AmbiguousMatchCount = NULL, LinkError = NULL
            WHERE SubmissionId = @sid AND TenantId = @tenantId
        `);
    return { success: true };
}

async function retryLinkSubmission(tenantId, submissionId, req) {
    const detail = await getSubmissionDetail(tenantId, submissionId);
    if (!detail) return { success: false, message: 'Not found' };
    if (detail.MemberMatchStatus !== 'Matched' || !detail.MemberId) {
        return { success: false, message: 'Member must be matched first' };
    }
    if (detail.ShareRequestId && detail.FormKind !== 'AdditionalDocuments') {
        return { success: false, message: 'Share request already linked' };
    }
    const pool = await getPool();
    const template = (await pool.request()
        .input('id', sql.UniqueIdentifier, detail.FormTemplateId)
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .query(
            `SELECT DefaultVendorId, NotifyEmails, FormKind FROM oe.PublicFormTemplates WHERE FormTemplateId = @id AND TenantId = @tenantId`
        )).recordset[0];
    const actorUserId = await getPublicFormsActorUserId();
    const linkResult = await linkSubmissionToShareWorkflow({
        submissionId,
        tenantId,
        formTemplateId: detail.FormTemplateId,
        formKind: detail.FormKind,
        memberId: detail.MemberId,
        vendorIdOverride: template?.DefaultVendorId,
        payload: detail.payload || {},
        actorUserId
    });
    if (linkResult.success) {
        const newToken = crypto.randomBytes(32).toString('hex');
        const newTokenHash = crypto.createHash('sha256').update(newToken).digest('hex');
        await pool.request()
            .input('sid', sql.UniqueIdentifier, submissionId)
            .input('tenantId', sql.UniqueIdentifier, tenantId)
            .input('tokenHash', sql.Char(64), newTokenHash)
            .query(`
                UPDATE oe.PublicFormSubmissions
                SET PublicAccessTokenHash = @tokenHash,
                    PublicAccessTokenExpiry = DATEADD(DAY, 30, SYSUTCDATETIME()),
                    PublicAccessRevoked = 0
                WHERE SubmissionId = @sid AND TenantId = @tenantId
            `);
        const submissionDataUrl = buildSubmissionDataUrl(newToken, req);
        await sendSubmissionNotifications({
            tenantId,
            submissionId,
            submissionDataUrl,
            formKind: detail.FormKind,
            formTitle: detail.FormTitle || null,
            memberMatchStatus: 'Matched',
            shareRequestId: linkResult.shareRequestId,
            requestNumber: linkResult.requestNumber,
            notifyEmailsJson: template?.NotifyEmails,
            payload: detail.payload || null
        });
    }
    return linkResult;
}

/**
 * Rotate public access token and queue the same routing notification emails as at submit time
 * (MessageQueue). Use when auto-send failed or NotifyEmails was empty.
 * @param {string} tenantId
 * @param {string} submissionId
 * @param {{ additionalRecipientEmails?: string[], replaceDefaults?: boolean, linkBaseOverride?: string|null }} [options]
 * @param {import('express').Request|null|undefined} [req] used to resolve the absolute base URL
 *   for the anonymous viewer link in the email when FRONTEND_URL/APP_URL env vars are not set.
 * @returns {Promise<{ success: boolean, message?: string, queued?: number, recipients?: string[], skipped?: boolean, reason?: string, publicLinkReissued?: boolean, linkBaseUsed?: string }>}
 */
async function queueRoutingNotificationsForSubmission(tenantId, submissionId, options = {}, req) {
    const detail = await getSubmissionDetail(tenantId, submissionId);
    if (!detail) {
        return { success: false, message: 'Not found' };
    }
    const pool = await getPool();
    const template = (await pool.request()
        .input('id', sql.UniqueIdentifier, detail.FormTemplateId)
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .query(
            `SELECT NotifyEmails FROM oe.PublicFormTemplates WHERE FormTemplateId = @id AND TenantId = @tenantId`
        )).recordset[0];

    const additionalRecipientEmails = Array.isArray(options.additionalRecipientEmails)
        ? options.additionalRecipientEmails
        : undefined;
    const replaceDefaults = options.replaceDefaults === true;

    const resolved = await resolveRoutingNotificationRecipients(
        tenantId,
        template?.NotifyEmails,
        additionalRecipientEmails,
        { replaceDefaults }
    );
    if (resolved.length === 0) {
        return {
            success: false,
            message: replaceDefaults
                ? 'No recipients provided. Add at least one valid email address before sending.'
                : 'No routing recipients. Add notify recipients on the form template, set the tenant contact email, or add optional recipients below.',
            skipped: true,
            reason: 'no_recipients',
            publicLinkReissued: false,
            queued: 0,
            recipients: []
        };
    }

    // Resend dialog can pick which origin the email link should point at
    // (localhost / tenant custom domain / default allaboard host). Validate
    // against the same allow-list the GET defaults endpoint reports so a
    // tampered request can't put an arbitrary host into the email body.
    const tenantCustomDomain = await getTenantCustomDomainBase(tenantId);
    const defaultAppBase = getDefaultAppBase();
    const allowedOverride = pickAllowedLinkBaseOverride(options.linkBaseOverride, {
        tenantCustomDomain,
        defaultAppBase
    });

    const newToken = crypto.randomBytes(32).toString('hex');
    const newTokenHash = crypto.createHash('sha256').update(newToken).digest('hex');
    await pool.request()
        .input('sid', sql.UniqueIdentifier, submissionId)
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('tokenHash', sql.Char(64), newTokenHash)
        .query(`
            UPDATE oe.PublicFormSubmissions
            SET PublicAccessTokenHash = @tokenHash,
                PublicAccessTokenExpiry = DATEADD(DAY, 30, SYSUTCDATETIME()),
                PublicAccessRevoked = 0
            WHERE SubmissionId = @sid AND TenantId = @tenantId
        `);

    const submissionDataUrl = buildSubmissionDataUrl(newToken, req, {
        linkBaseOverride: allowedOverride
    });

    const notifyResult = await sendSubmissionNotifications({
        tenantId,
        submissionId,
        submissionDataUrl,
        formKind: detail.FormKind,
        formTitle: detail.FormTitle || null,
        memberMatchStatus: detail.MemberMatchStatus || 'Unknown',
        shareRequestId: detail.ShareRequestId || null,
        requestNumber: detail.RequestNumber != null ? detail.RequestNumber : null,
        notifyEmailsJson: template?.NotifyEmails,
        additionalRecipientEmails,
        replaceDefaults,
        payload: detail.payload || null
    });

    const queued = notifyResult.queued ?? notifyResult.sent ?? 0;

    return {
        success: true,
        queued,
        recipients: resolved,
        skipped: false,
        publicLinkReissued: true,
        reason: undefined,
        linkBaseUsed: allowedOverride || undefined
    };
}

/**
 * Return the email addresses that would receive a routing notification right now if the user
 * pressed "Queue routing notifications" without overriding the recipient list. Used by the UI
 * to pre-populate the editable recipients box.
 * @param {string} tenantId
 * @param {string} submissionId
 */
async function getRoutingNotificationDefaults(tenantId, submissionId) {
    const detail = await getSubmissionDetail(tenantId, submissionId);
    if (!detail) return { success: false, message: 'Not found' };
    const pool = await getPool();
    const template = (await pool.request()
        .input('id', sql.UniqueIdentifier, detail.FormTemplateId)
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .query(
            `SELECT NotifyEmails FROM oe.PublicFormTemplates WHERE FormTemplateId = @id AND TenantId = @tenantId`
        )).recordset[0];
    const recipients = await resolveRoutingNotificationRecipients(
        tenantId,
        template?.NotifyEmails,
        undefined
    );
    const tenantCustomDomain = await getTenantCustomDomainBase(tenantId);
    const defaultAppBase = getDefaultAppBase();
    return {
        success: true,
        recipients,
        tenantCustomDomain: tenantCustomDomain || null,
        defaultAppBase
    };
}

async function getLatestDefinitionByTemplateId(tenantId, formTemplateId) {
    const pool = await getPool();
    const r = await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('id', sql.UniqueIdentifier, formTemplateId)
        .query(`
            SELECT TOP 1
                t.FormTemplateId, t.TenantId, t.FormKind, t.Title, t.KindLabel,
                v.DefinitionJson, v.VersionNumber
            FROM oe.PublicFormTemplates t
            INNER JOIN oe.PublicFormTemplateVersions v
                ON v.FormTemplateId = t.FormTemplateId
            WHERE t.FormTemplateId = @id AND t.TenantId = @tenantId
            ORDER BY v.VersionNumber DESC
        `);
    return r.recordset[0] || null;
}

module.exports = {
    getPublishedDefinitionByTemplateId,
    getPreviewPayloadForTenant,
    getLatestDefinitionByTemplateId,
    listTemplatesForTenant,
    createBlankTemplate,
    duplicateTemplate,
    deleteTemplate,
    getTemplateDetailForTenant,
    getTemplateVersionDefinition,
    ensureDefaultTemplatesForTenant,
    saveNewVersion,
    publishVersion,
    updateTemplateMeta,
    listSubmissions,
    listSubmissionsForExport,
    updateSubmissionLinkage,
    recordAnonymousSubmissionFirstView,
    applyRoutingEmailFirstOpenedFromSendGrid,
    getSubmissionDetail,
    getSubmissionDetailByPublicTokenHash,
    resolveSubmissionMember,
    manuallySetMember,
    retryLinkSubmission,
    queueRoutingNotificationsForSubmission,
    getRoutingNotificationDefaults
};
