// services/caseTaxonomyService.js
// Vendor-scoped CRUD for oe.CaseTypes + oe.CaseSubcategories.
// See sql-changes/2026-05-19-support-ticket-taxonomy.sql and the matching spec.

const { getPool, sql } = require('../config/database');

// ---------- helpers ----------

/**
 * Slugify a label into a stable code. Lowercase ASCII alnum, underscores
 * for spaces/punctuation, collapsed runs, trimmed. Empty → 'item'.
 */
function slugify(label) {
    const base = String(label || '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')        // strip accents
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .replace(/_{2,}/g, '_')
        .slice(0, 45);
    return base || 'item';
}

/**
 * Resolve a unique code for a new row. If `code` collides with an existing
 * row in the same scope, append -2, -3, ... until free.
 *
 * `existsFn(candidate)` returns true if the candidate is already taken.
 */
async function uniqueCode(base, existsFn) {
    if (!(await existsFn(base))) return base;
    for (let n = 2; n < 1000; n++) {
        const candidate = `${base}_${n}`.slice(0, 50);
        // eslint-disable-next-line no-await-in-loop
        if (!(await existsFn(candidate))) return candidate;
    }
    throw new Error('Could not allocate a unique code.');
}

// ---------- read ----------

/**
 * Active taxonomy for ticket creation. Returns types with their active
 * subcategories nested. Inactive items hidden.
 */
async function getActiveTaxonomy(vendorId) {
    const pool = await getPool();
    const r = await pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .query(`
            SELECT TypeId, Code, Label, SortOrder
            FROM oe.CaseTypes
            WHERE VendorId = @vendorId AND IsActive = 1
            ORDER BY SortOrder, Label;

            SELECT SubcategoryId, TypeId, Code, Label, SortOrder
            FROM oe.CaseSubcategories
            WHERE VendorId = @vendorId AND IsActive = 1
            ORDER BY SortOrder, Label;
        `);
    const types = r.recordsets[0];
    const subs = r.recordsets[1];
    return types.map((t) => ({
        typeId: t.TypeId,
        code: t.Code,
        label: t.Label,
        sortOrder: t.SortOrder,
        subcategories: subs
            .filter((s) => s.TypeId === t.TypeId)
            .map((s) => ({
                subcategoryId: s.SubcategoryId,
                code: s.Code,
                label: s.Label,
                sortOrder: s.SortOrder
            }))
    }));
}

/**
 * Full taxonomy including inactive items — for the admin editor.
 */
async function getFullTaxonomy(vendorId) {
    const pool = await getPool();
    const r = await pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .query(`
            SELECT TypeId, Code, Label, IsActive, SortOrder
            FROM oe.CaseTypes
            WHERE VendorId = @vendorId
            ORDER BY SortOrder, Label;

            SELECT SubcategoryId, TypeId, Code, Label, IsActive, SortOrder
            FROM oe.CaseSubcategories
            WHERE VendorId = @vendorId
            ORDER BY SortOrder, Label;
        `);
    const types = r.recordsets[0];
    const subs = r.recordsets[1];
    return types.map((t) => ({
        typeId: t.TypeId,
        code: t.Code,
        label: t.Label,
        isActive: !!t.IsActive,
        sortOrder: t.SortOrder,
        subcategories: subs
            .filter((s) => s.TypeId === t.TypeId)
            .map((s) => ({
                subcategoryId: s.SubcategoryId,
                code: s.Code,
                label: s.Label,
                isActive: !!s.IsActive,
                sortOrder: s.SortOrder
            }))
    }));
}

/**
 * Validate that the given type/subcategory codes exist and are active for
 * this vendor. Throws a 400 if invalid. Used on ticket create/update.
 *
 * Replaces the old hardcoded-map version in caseService.js.
 */
async function validateTicketTypeAndSubcategory(vendorId, typeCode, subcategoryCode) {
    if (!typeCode || typeof typeCode !== 'string') {
        const err = new Error('caseType is required'); err.statusCode = 400; throw err;
    }
    const pool = await getPool();
    const r = await pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .input('typeCode', sql.NVarChar, typeCode)
        .input('subCode',  sql.NVarChar, subcategoryCode || null)
        .query(`
            SELECT TypeId FROM oe.CaseTypes
            WHERE VendorId = @vendorId AND Code = @typeCode AND IsActive = 1;

            SELECT sc.SubcategoryId
            FROM oe.CaseSubcategories sc
            INNER JOIN oe.CaseTypes t ON t.TypeId = sc.TypeId
            WHERE sc.VendorId = @vendorId AND t.Code = @typeCode
              AND sc.Code = @subCode AND sc.IsActive = 1;
        `);
    if (r.recordsets[0].length === 0) {
        const err = new Error(`Unknown or inactive caseType "${typeCode}" for this vendor`);
        err.statusCode = 400; throw err;
    }
    if (subcategoryCode && r.recordsets[1].length === 0) {
        const err = new Error(`Subcategory "${subcategoryCode}" is not valid (or inactive) for caseType "${typeCode}"`);
        err.statusCode = 400; throw err;
    }
}

// ---------- types CRUD ----------

async function createType(vendorId, { label, sortOrder }, userId) {
    if (!label || !String(label).trim()) {
        const err = new Error('label is required'); err.statusCode = 400; throw err;
    }
    const pool = await getPool();
    const base = slugify(label);
    const code = await uniqueCode(base, async (candidate) => {
        const r = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('code', sql.NVarChar, candidate)
            .query(`SELECT 1 AS X FROM oe.CaseTypes WHERE VendorId = @vendorId AND Code = @code`);
        return r.recordset.length > 0;
    });

    const finalSort = Number.isFinite(sortOrder) ? sortOrder : await nextTypeSortOrder(pool, vendorId);
    const r = await pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .input('code', sql.NVarChar, code)
        .input('label', sql.NVarChar, String(label).trim().slice(0, 100))
        .input('sortOrder', sql.Int, finalSort)
        .input('createdBy', sql.UniqueIdentifier, userId || null)
        .query(`
            INSERT INTO oe.CaseTypes (VendorId, Code, Label, SortOrder, CreatedBy)
            OUTPUT INSERTED.TypeId, INSERTED.Code, INSERTED.Label, INSERTED.IsActive, INSERTED.SortOrder
            VALUES (@vendorId, @code, @label, @sortOrder, @createdBy);
        `);
    const row = r.recordset[0];
    return { typeId: row.TypeId, code: row.Code, label: row.Label, isActive: !!row.IsActive, sortOrder: row.SortOrder, subcategories: [] };
}

async function nextTypeSortOrder(pool, vendorId) {
    const r = await pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .query(`SELECT ISNULL(MAX(SortOrder), 0) AS MaxSort FROM oe.CaseTypes WHERE VendorId = @vendorId`);
    return (r.recordset[0]?.MaxSort || 0) + 10;
}

async function updateType(vendorId, typeId, { label, isActive, sortOrder }, userId) {
    const pool = await getPool();
    const sets = ['ModifiedDate = SYSUTCDATETIME()', 'ModifiedBy = @userId'];
    const req = pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .input('typeId',   sql.UniqueIdentifier, typeId)
        .input('userId',   sql.UniqueIdentifier, userId || null);
    if (label !== undefined) {
        if (!label || !String(label).trim()) {
            const err = new Error('label must be non-empty'); err.statusCode = 400; throw err;
        }
        sets.push('Label = @label');
        req.input('label', sql.NVarChar, String(label).trim().slice(0, 100));
    }
    if (isActive !== undefined) {
        sets.push('IsActive = @isActive');
        req.input('isActive', sql.Bit, isActive ? 1 : 0);
    }
    if (sortOrder !== undefined) {
        sets.push('SortOrder = @sortOrder');
        req.input('sortOrder', sql.Int, sortOrder);
    }
    const r = await req.query(`
        UPDATE oe.CaseTypes SET ${sets.join(', ')}
        WHERE TypeId = @typeId AND VendorId = @vendorId;
        SELECT @@ROWCOUNT AS Rows;
    `);
    if (r.recordset[0].Rows === 0) {
        const err = new Error('Type not found'); err.statusCode = 404; throw err;
    }
}

async function reorderTypes(vendorId, orderedTypeIds, userId) {
    if (!Array.isArray(orderedTypeIds) || orderedTypeIds.length === 0) {
        const err = new Error('orderedTypeIds is required'); err.statusCode = 400; throw err;
    }
    const pool = await getPool();
    // Verify all ids belong to this vendor.
    const idsCsv = orderedTypeIds.map((s) => `'${String(s).replace(/'/g, "''")}'`).join(',');
    const check = await pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .query(`SELECT TypeId FROM oe.CaseTypes WHERE VendorId = @vendorId AND TypeId IN (${idsCsv})`);
    if (check.recordset.length !== orderedTypeIds.length) {
        const err = new Error('Some type ids are not in this vendor'); err.statusCode = 400; throw err;
    }
    for (let i = 0; i < orderedTypeIds.length; i++) {
        // eslint-disable-next-line no-await-in-loop
        await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('typeId',   sql.UniqueIdentifier, orderedTypeIds[i])
            .input('userId',   sql.UniqueIdentifier, userId || null)
            .input('sort',     sql.Int, (i + 1) * 10)
            .query(`UPDATE oe.CaseTypes
                    SET SortOrder = @sort, ModifiedDate = SYSUTCDATETIME(), ModifiedBy = @userId
                    WHERE TypeId = @typeId AND VendorId = @vendorId`);
    }
}

// ---------- subcategories CRUD ----------

async function createSubcategory(vendorId, typeId, { label, sortOrder }, userId) {
    if (!label || !String(label).trim()) {
        const err = new Error('label is required'); err.statusCode = 400; throw err;
    }
    const pool = await getPool();
    // Verify the type belongs to this vendor.
    const typeRow = await pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .input('typeId',   sql.UniqueIdentifier, typeId)
        .query(`SELECT TypeId FROM oe.CaseTypes WHERE TypeId = @typeId AND VendorId = @vendorId`);
    if (typeRow.recordset.length === 0) {
        const err = new Error('Parent type not found in this vendor'); err.statusCode = 404; throw err;
    }
    const base = slugify(label);
    const code = await uniqueCode(base, async (candidate) => {
        const r = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('typeId',   sql.UniqueIdentifier, typeId)
            .input('code',     sql.NVarChar, candidate)
            .query(`SELECT 1 AS X FROM oe.CaseSubcategories
                    WHERE VendorId = @vendorId AND TypeId = @typeId AND Code = @code`);
        return r.recordset.length > 0;
    });
    const finalSort = Number.isFinite(sortOrder) ? sortOrder : await nextSubSortOrder(pool, vendorId, typeId);
    const r = await pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .input('typeId',   sql.UniqueIdentifier, typeId)
        .input('code',     sql.NVarChar, code)
        .input('label',    sql.NVarChar, String(label).trim().slice(0, 100))
        .input('sortOrder', sql.Int, finalSort)
        .input('createdBy', sql.UniqueIdentifier, userId || null)
        .query(`
            INSERT INTO oe.CaseSubcategories (VendorId, TypeId, Code, Label, SortOrder, CreatedBy)
            OUTPUT INSERTED.SubcategoryId, INSERTED.Code, INSERTED.Label, INSERTED.IsActive, INSERTED.SortOrder
            VALUES (@vendorId, @typeId, @code, @label, @sortOrder, @createdBy);
        `);
    const row = r.recordset[0];
    return { subcategoryId: row.SubcategoryId, code: row.Code, label: row.Label, isActive: !!row.IsActive, sortOrder: row.SortOrder };
}

async function nextSubSortOrder(pool, vendorId, typeId) {
    const r = await pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .input('typeId',   sql.UniqueIdentifier, typeId)
        .query(`SELECT ISNULL(MAX(SortOrder), 0) AS MaxSort
                FROM oe.CaseSubcategories
                WHERE VendorId = @vendorId AND TypeId = @typeId`);
    return (r.recordset[0]?.MaxSort || 0) + 10;
}

async function updateSubcategory(vendorId, subcategoryId, { label, isActive, sortOrder }, userId) {
    const pool = await getPool();
    const sets = ['ModifiedDate = SYSUTCDATETIME()', 'ModifiedBy = @userId'];
    const req = pool.request()
        .input('vendorId',      sql.UniqueIdentifier, vendorId)
        .input('subcategoryId', sql.UniqueIdentifier, subcategoryId)
        .input('userId',        sql.UniqueIdentifier, userId || null);
    if (label !== undefined) {
        if (!label || !String(label).trim()) {
            const err = new Error('label must be non-empty'); err.statusCode = 400; throw err;
        }
        sets.push('Label = @label');
        req.input('label', sql.NVarChar, String(label).trim().slice(0, 100));
    }
    if (isActive !== undefined) {
        sets.push('IsActive = @isActive');
        req.input('isActive', sql.Bit, isActive ? 1 : 0);
    }
    if (sortOrder !== undefined) {
        sets.push('SortOrder = @sortOrder');
        req.input('sortOrder', sql.Int, sortOrder);
    }
    const r = await req.query(`
        UPDATE oe.CaseSubcategories SET ${sets.join(', ')}
        WHERE SubcategoryId = @subcategoryId AND VendorId = @vendorId;
        SELECT @@ROWCOUNT AS Rows;
    `);
    if (r.recordset[0].Rows === 0) {
        const err = new Error('Subcategory not found'); err.statusCode = 404; throw err;
    }
}

async function reorderSubcategories(vendorId, typeId, orderedIds, userId) {
    if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
        const err = new Error('orderedSubcategoryIds is required'); err.statusCode = 400; throw err;
    }
    const pool = await getPool();
    const idsCsv = orderedIds.map((s) => `'${String(s).replace(/'/g, "''")}'`).join(',');
    const check = await pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .input('typeId',   sql.UniqueIdentifier, typeId)
        .query(`SELECT SubcategoryId FROM oe.CaseSubcategories
                WHERE VendorId = @vendorId AND TypeId = @typeId AND SubcategoryId IN (${idsCsv})`);
    if (check.recordset.length !== orderedIds.length) {
        const err = new Error('Some subcategory ids are not in this vendor/type'); err.statusCode = 400; throw err;
    }
    for (let i = 0; i < orderedIds.length; i++) {
        // eslint-disable-next-line no-await-in-loop
        await pool.request()
            .input('vendorId',      sql.UniqueIdentifier, vendorId)
            .input('subcategoryId', sql.UniqueIdentifier, orderedIds[i])
            .input('userId',        sql.UniqueIdentifier, userId || null)
            .input('sort',          sql.Int, (i + 1) * 10)
            .query(`UPDATE oe.CaseSubcategories
                    SET SortOrder = @sort, ModifiedDate = SYSUTCDATETIME(), ModifiedBy = @userId
                    WHERE SubcategoryId = @subcategoryId AND VendorId = @vendorId`);
    }
}

module.exports = {
    slugify,
    getActiveTaxonomy,
    getFullTaxonomy,
    validateTicketTypeAndSubcategory,
    createType,
    updateType,
    reorderTypes,
    createSubcategory,
    updateSubcategory,
    reorderSubcategories
};
