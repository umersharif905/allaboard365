// publicFormDraftService — signed-in member draft autosave for public forms.
// Payload is encrypted with the same scheme as submissions (publicFormCrypto).
// Drafts are owned by the signed-in user; one per (owner, form, for-member).
const { getPool, sql } = require('../config/database');
const { encryptPayloadObject, decryptPayloadObject } = require('./publicFormCrypto');

function decryptOrNull(row) {
    if (!row || !row.PayloadEncrypted || !row.PayloadIv || !row.PayloadAuthTag) return {};
    try {
        return decryptPayloadObject(row.PayloadEncrypted, row.PayloadIv, row.PayloadAuthTag);
    } catch {
        return {};
    }
}

/** Staged files for a draft (metadata only; bytes live in Azure blob). */
async function getDraftFiles(pool, draftId) {
    const r = await pool.request()
        .input('draftId', sql.UniqueIdentifier, draftId)
        .query(`
            SELECT DraftFileId, FieldName, OriginalFileName, ContentType, FileSizeBytes, BlobUrl, BlobPath
            FROM oe.PublicFormDraftFiles WHERE DraftId = @draftId ORDER BY CreatedDate
        `);
    return r.recordset;
}

/** The owner's active draft for a (form, for-member), or null. Includes payload + files. */
async function getActiveDraft({ ownerUserId, formTemplateId, forMemberId }) {
    const pool = await getPool();
    const r = await pool.request()
        .input('owner', sql.UniqueIdentifier, ownerUserId)
        .input('tpl', sql.UniqueIdentifier, formTemplateId)
        .input('forMember', sql.UniqueIdentifier, forMemberId || null)
        .query(`
            SELECT TOP 1 DraftId, PayloadEncrypted, PayloadIv, PayloadAuthTag, UpdatedDate
            FROM oe.PublicFormDrafts
            WHERE OwnerUserId = @owner AND FormTemplateId = @tpl
              AND ((@forMember IS NULL AND ForMemberId IS NULL) OR ForMemberId = @forMember)
        `);
    const row = r.recordset[0];
    if (!row) return null;
    return {
        draftId: row.DraftId,
        payload: decryptOrNull(row),
        updatedDate: row.UpdatedDate,
        files: await getDraftFiles(pool, row.DraftId)
    };
}

/**
 * Create or update the owner's draft for (form, for-member). Returns the draftId.
 */
async function upsertDraft({ ownerUserId, tenantId, formTemplateId, forMemberId, householdId, payload }) {
    const pool = await getPool();
    const enc = encryptPayloadObject(payload || {});
    const existing = await pool.request()
        .input('owner', sql.UniqueIdentifier, ownerUserId)
        .input('tpl', sql.UniqueIdentifier, formTemplateId)
        .input('forMember', sql.UniqueIdentifier, forMemberId || null)
        .query(`
            SELECT TOP 1 DraftId FROM oe.PublicFormDrafts
            WHERE OwnerUserId = @owner AND FormTemplateId = @tpl
              AND ((@forMember IS NULL AND ForMemberId IS NULL) OR ForMemberId = @forMember)
        `);

    if (existing.recordset[0]) {
        const draftId = existing.recordset[0].DraftId;
        await pool.request()
            .input('draftId', sql.UniqueIdentifier, draftId)
            .input('enc', sql.VarBinary(sql.MAX), enc.ciphertext)
            .input('iv', sql.VarBinary(16), enc.iv)
            .input('tag', sql.VarBinary(16), enc.authTag)
            .input('keyId', sql.NVarChar(100), enc.keyId)
            .query(`UPDATE oe.PublicFormDrafts
                    SET PayloadEncrypted=@enc, PayloadIv=@iv, PayloadAuthTag=@tag,
                        PayloadKeyId=@keyId, UpdatedDate=SYSUTCDATETIME()
                    WHERE DraftId=@draftId`);
        return draftId;
    }

    try {
        const r = await pool.request()
            .input('tenantId', sql.UniqueIdentifier, tenantId)
            .input('tpl', sql.UniqueIdentifier, formTemplateId)
            .input('owner', sql.UniqueIdentifier, ownerUserId)
            .input('forMember', sql.UniqueIdentifier, forMemberId || null)
            .input('household', sql.UniqueIdentifier, householdId || null)
            .input('enc', sql.VarBinary(sql.MAX), enc.ciphertext)
            .input('iv', sql.VarBinary(16), enc.iv)
            .input('tag', sql.VarBinary(16), enc.authTag)
            .input('keyId', sql.NVarChar(100), enc.keyId)
            .query(`
                INSERT INTO oe.PublicFormDrafts
                    (TenantId, FormTemplateId, OwnerUserId, ForMemberId, HouseholdId,
                     PayloadEncrypted, PayloadIv, PayloadAuthTag, PayloadKeyId)
                OUTPUT inserted.DraftId
                VALUES (@tenantId, @tpl, @owner, @forMember, @household, @enc, @iv, @tag, @keyId)
            `);
        return r.recordset[0].DraftId;
    } catch (e) {
        // Lost a create race against a concurrent first-time save for the same
        // (owner, form, for-member) — UQ_PublicFormDrafts_Owner_Template_Member
        // (2627 unique constraint / 2601 unique index). Re-read the winner's row
        // and update it instead of surfacing a 500.
        if (e && (e.number === 2627 || e.number === 2601)) {
            const again = await pool.request()
                .input('owner', sql.UniqueIdentifier, ownerUserId)
                .input('tpl', sql.UniqueIdentifier, formTemplateId)
                .input('forMember', sql.UniqueIdentifier, forMemberId || null)
                .query(`
                    SELECT TOP 1 DraftId FROM oe.PublicFormDrafts
                    WHERE OwnerUserId = @owner AND FormTemplateId = @tpl
                      AND ((@forMember IS NULL AND ForMemberId IS NULL) OR ForMemberId = @forMember)
                `);
            if (again.recordset[0]) {
                const draftId = again.recordset[0].DraftId;
                await pool.request()
                    .input('draftId', sql.UniqueIdentifier, draftId)
                    .input('enc', sql.VarBinary(sql.MAX), enc.ciphertext)
                    .input('iv', sql.VarBinary(16), enc.iv)
                    .input('tag', sql.VarBinary(16), enc.authTag)
                    .input('keyId', sql.NVarChar(100), enc.keyId)
                    .query(`UPDATE oe.PublicFormDrafts
                            SET PayloadEncrypted=@enc, PayloadIv=@iv, PayloadAuthTag=@tag,
                                PayloadKeyId=@keyId, UpdatedDate=SYSUTCDATETIME()
                            WHERE DraftId=@draftId`);
                return draftId;
            }
        }
        throw e;
    }
}

/** Update an existing draft's payload by id, owner-checked. Returns true if updated. */
async function updateDraftPayload({ draftId, ownerUserId, payload }) {
    const pool = await getPool();
    const enc = encryptPayloadObject(payload || {});
    const r = await pool.request()
        .input('draftId', sql.UniqueIdentifier, draftId)
        .input('owner', sql.UniqueIdentifier, ownerUserId)
        .input('enc', sql.VarBinary(sql.MAX), enc.ciphertext)
        .input('iv', sql.VarBinary(16), enc.iv)
        .input('tag', sql.VarBinary(16), enc.authTag)
        .input('keyId', sql.NVarChar(100), enc.keyId)
        .query(`UPDATE oe.PublicFormDrafts
                SET PayloadEncrypted=@enc, PayloadIv=@iv, PayloadAuthTag=@tag,
                    PayloadKeyId=@keyId, UpdatedDate=SYSUTCDATETIME()
                WHERE DraftId=@draftId AND OwnerUserId=@owner`);
    return r.rowsAffected[0] > 0;
}

/**
 * Delete a draft (owner-checked) and return the staged blob paths to purge.
 * Draft-file rows cascade; Azure blobs must be deleted by the caller.
 */
async function deleteDraft({ draftId, ownerUserId }) {
    const pool = await getPool();
    const owns = await pool.request()
        .input('draftId', sql.UniqueIdentifier, draftId)
        .input('owner', sql.UniqueIdentifier, ownerUserId)
        .query('SELECT DraftId FROM oe.PublicFormDrafts WHERE DraftId=@draftId AND OwnerUserId=@owner');
    if (!owns.recordset[0]) return { deleted: false, blobPaths: [] };

    const files = await pool.request()
        .input('draftId', sql.UniqueIdentifier, draftId)
        .query('SELECT BlobPath FROM oe.PublicFormDraftFiles WHERE DraftId=@draftId AND BlobPath IS NOT NULL');
    await pool.request()
        .input('draftId', sql.UniqueIdentifier, draftId)
        .query('DELETE FROM oe.PublicFormDrafts WHERE DraftId=@draftId');
    return { deleted: true, blobPaths: files.recordset.map((f) => f.BlobPath) };
}

/** Record a staged file (already uploaded to Azure) against a draft. */
async function insertDraftFile({ draftId, fieldName, originalFileName, contentType, fileSizeBytes, blobUrl, blobPath }) {
    const pool = await getPool();
    const r = await pool.request()
        .input('draftId', sql.UniqueIdentifier, draftId)
        .input('fieldName', sql.NVarChar(200), fieldName)
        .input('orig', sql.NVarChar(500), originalFileName)
        .input('ct', sql.NVarChar(200), contentType || null)
        .input('sz', sql.BigInt, fileSizeBytes || null)
        .input('url', sql.NVarChar(2000), blobUrl || null)
        .input('path', sql.NVarChar(1000), blobPath || null)
        .query(`
            INSERT INTO oe.PublicFormDraftFiles
                (DraftId, FieldName, OriginalFileName, ContentType, FileSizeBytes, BlobUrl, BlobPath)
            OUTPUT inserted.DraftFileId
            VALUES (@draftId, @fieldName, @orig, @ct, @sz, @url, @path)
        `);
    return r.recordset[0].DraftFileId;
}

/** Delete a staged file (owner-checked via its draft). Returns its blobPath, or null. */
async function deleteDraftFile({ draftFileId, ownerUserId }) {
    const pool = await getPool();
    const f = await pool.request()
        .input('fileId', sql.UniqueIdentifier, draftFileId)
        .input('owner', sql.UniqueIdentifier, ownerUserId)
        .query(`
            SELECT df.BlobPath
            FROM oe.PublicFormDraftFiles df
            JOIN oe.PublicFormDrafts d ON d.DraftId = df.DraftId
            WHERE df.DraftFileId = @fileId AND d.OwnerUserId = @owner
        `);
    if (!f.recordset[0]) return { deleted: false, blobPath: null };
    await pool.request()
        .input('fileId', sql.UniqueIdentifier, draftFileId)
        .query('DELETE FROM oe.PublicFormDraftFiles WHERE DraftFileId = @fileId');
    return { deleted: true, blobPath: f.recordset[0].BlobPath };
}

/** Full draft for the submit/promote path (owner-checked). Null if not owned. */
async function loadDraftForOwner({ draftId, ownerUserId }) {
    const pool = await getPool();
    const r = await pool.request()
        .input('draftId', sql.UniqueIdentifier, draftId)
        .input('owner', sql.UniqueIdentifier, ownerUserId)
        .query(`
            SELECT DraftId, TenantId, FormTemplateId, ForMemberId, HouseholdId,
                   PayloadEncrypted, PayloadIv, PayloadAuthTag
            FROM oe.PublicFormDrafts WHERE DraftId = @draftId AND OwnerUserId = @owner
        `);
    const row = r.recordset[0];
    if (!row) return null;
    return {
        draftId: row.DraftId,
        tenantId: row.TenantId,
        formTemplateId: row.FormTemplateId,
        forMemberId: row.ForMemberId,
        householdId: row.HouseholdId,
        payload: decryptOrNull(row),
        files: await getDraftFiles(pool, row.DraftId)
    };
}

/** Delete the draft rows only (no blob purge) — used after a successful submit
 *  promotes the staged blobs into the submission. */
async function deleteDraftRowsOnly(draftId) {
    const pool = await getPool();
    await pool.request()
        .input('draftId', sql.UniqueIdentifier, draftId)
        .query('DELETE FROM oe.PublicFormDrafts WHERE DraftId = @draftId');
}

/**
 * Admin: list in-progress drafts for a tenant with display metadata (who it's
 * by, who it's for, form title, age, file count + total size). Most-recent first.
 */
async function listDraftsForTenant(tenantId) {
    const pool = await getPool();
    const r = await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .query(`
            SELECT
                d.DraftId, d.FormTemplateId, d.CreatedDate, d.UpdatedDate,
                t.Title AS FormTitle,
                ou.FirstName AS OwnerFirstName, ou.LastName AS OwnerLastName,
                fu.FirstName AS ForFirstName, fu.LastName AS ForLastName,
                (SELECT COUNT(*) FROM oe.PublicFormDraftFiles f WHERE f.DraftId = d.DraftId) AS FileCount,
                (SELECT ISNULL(SUM(CAST(f.FileSizeBytes AS BIGINT)), 0) FROM oe.PublicFormDraftFiles f WHERE f.DraftId = d.DraftId) AS TotalBytes
            FROM oe.PublicFormDrafts d
            LEFT JOIN oe.PublicFormTemplates t ON t.FormTemplateId = d.FormTemplateId
            LEFT JOIN oe.Users ou ON ou.UserId = d.OwnerUserId
            LEFT JOIN oe.Members fm ON fm.MemberId = d.ForMemberId
            LEFT JOIN oe.Users fu ON fu.UserId = fm.UserId
            WHERE d.TenantId = @tenantId
            ORDER BY d.UpdatedDate DESC
        `);
    return r.recordset;
}

/**
 * Admin: full draft (decrypted payload + staged files) for read-only view,
 * tenant-scoped. Null if the draft isn't in this tenant.
 */
async function getDraftForTenant(draftId, tenantId) {
    const pool = await getPool();
    const r = await pool.request()
        .input('draftId', sql.UniqueIdentifier, draftId)
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .query(`
            SELECT DraftId, FormTemplateId, PayloadEncrypted, PayloadIv, PayloadAuthTag, CreatedDate, UpdatedDate
            FROM oe.PublicFormDrafts WHERE DraftId = @draftId AND TenantId = @tenantId
        `);
    const row = r.recordset[0];
    if (!row) return null;
    return {
        draftId: row.DraftId,
        formTemplateId: row.FormTemplateId,
        createdDate: row.CreatedDate,
        updatedDate: row.UpdatedDate,
        payload: decryptOrNull(row),
        files: await getDraftFiles(pool, row.DraftId)
    };
}

/**
 * Admin: delete a tenant's draft and return its staged blob paths to purge.
 * Returns { deleted:false } if the draft isn't in this tenant.
 */
async function deleteDraftForTenant(draftId, tenantId) {
    const pool = await getPool();
    const owns = await pool.request()
        .input('draftId', sql.UniqueIdentifier, draftId)
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .query('SELECT DraftId FROM oe.PublicFormDrafts WHERE DraftId = @draftId AND TenantId = @tenantId');
    if (!owns.recordset[0]) return { deleted: false, blobPaths: [] };
    const files = await pool.request()
        .input('draftId', sql.UniqueIdentifier, draftId)
        .query('SELECT BlobPath FROM oe.PublicFormDraftFiles WHERE DraftId = @draftId AND BlobPath IS NOT NULL');
    await pool.request()
        .input('draftId', sql.UniqueIdentifier, draftId)
        .query('DELETE FROM oe.PublicFormDrafts WHERE DraftId = @draftId');
    return { deleted: true, blobPaths: files.recordset.map((f) => f.BlobPath) };
}

module.exports = {
    getActiveDraft,
    upsertDraft,
    updateDraftPayload,
    deleteDraft,
    getDraftFiles,
    insertDraftFile,
    deleteDraftFile,
    loadDraftForOwner,
    deleteDraftRowsOnly,
    listDraftsForTenant,
    getDraftForTenant,
    deleteDraftForTenant
};
