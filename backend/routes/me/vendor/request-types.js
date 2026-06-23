// routes/me/vendor/request-types.js
// Per-vendor Share Request type management.
//
// GET    /api/me/vendor/request-types          — list types for the current vendor (VendorAdmin + VendorAgent)
// POST   /api/me/vendor/request-types          — add a type (VendorAdmin)
// PUT    /api/me/vendor/request-types/:id      — rename / reorder (VendorAdmin)
// DELETE /api/me/vendor/request-types/:id      — delete; if dependent share requests exist and
//                                                 ?force=true is not set, returns 409 with
//                                                 { dependentCount }. With ?force=true, NULLs out
//                                                 the dependent rows in the same transaction.
//
// Read access is open to both VendorAdmin and VendorAgent because the share-request create form
// (an agent-facing screen) needs the list to populate its dropdown. Mutations are VendorAdmin-only.

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { getPool, sql } = require('../../../config/database');
const { authenticate, authorize } = require('../../../middleware/auth');
const { requireShareRequestAccess } = require('../../../middleware/shareRequestAccess');

router.use(authenticate);
router.use(authorize(['VendorAdmin', 'VendorAgent']));
router.use(requireShareRequestAccess);

const adminOnly = authorize(['VendorAdmin']);

const MAX_NAME_LENGTH = 100;

// ---------------------------------------------------------------------------
// GET /  — list types for current vendor
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, req.vendor.VendorId)
            .query(`
                SELECT TypeId, VendorId, Name, SortOrder, CreatedDate, ModifiedDate
                FROM oe.VendorShareRequestTypes
                WHERE VendorId = @vendorId
                ORDER BY SortOrder ASC, Name ASC
            `);

        res.json({ success: true, data: result.recordset });
    } catch (error) {
        console.error('❌ Error fetching request types:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch request types',
            error: error.message
        });
    }
});

// ---------------------------------------------------------------------------
// POST /  — add a type
// ---------------------------------------------------------------------------
router.post('/', adminOnly, async (req, res) => {
    try {
        const name = (req.body?.name ?? '').toString().trim();
        if (!name) {
            return res.status(400).json({ success: false, message: 'Name is required' });
        }
        if (name.length > MAX_NAME_LENGTH) {
            return res.status(400).json({
                success: false,
                message: `Name must be ${MAX_NAME_LENGTH} characters or fewer`
            });
        }

        const typeId = crypto.randomUUID();
        const pool = await getPool();

        // Default SortOrder = MAX + 10 so new entries land at the bottom.
        const result = await pool.request()
            .input('typeId', sql.UniqueIdentifier, typeId)
            .input('vendorId', sql.UniqueIdentifier, req.vendor.VendorId)
            .input('name', sql.NVarChar(MAX_NAME_LENGTH), name)
            .input('createdBy', sql.UniqueIdentifier, req.user.UserId)
            .query(`
                DECLARE @nextSort INT = ISNULL(
                    (SELECT MAX(SortOrder) + 10
                     FROM oe.VendorShareRequestTypes
                     WHERE VendorId = @vendorId),
                    10
                );

                INSERT INTO oe.VendorShareRequestTypes
                    (TypeId, VendorId, Name, SortOrder, CreatedBy)
                VALUES
                    (@typeId, @vendorId, @name, @nextSort, @createdBy);

                SELECT TypeId, VendorId, Name, SortOrder, CreatedDate, ModifiedDate
                FROM oe.VendorShareRequestTypes
                WHERE TypeId = @typeId;
            `);

        res.status(201).json({ success: true, data: result.recordset[0] });
    } catch (error) {
        if (error && (error.number === 2627 || error.number === 2601)) {
            return res.status(409).json({
                success: false,
                message: 'A type with that name already exists for this vendor'
            });
        }
        console.error('❌ Error creating request type:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create request type',
            error: error.message
        });
    }
});

// ---------------------------------------------------------------------------
// PUT /:id  — rename and/or reorder
// ---------------------------------------------------------------------------
router.put('/:id', adminOnly, async (req, res) => {
    try {
        const { id } = req.params;
        const body = req.body || {};

        const updates = [];
        const pool = await getPool();
        const request = pool.request()
            .input('typeId', sql.UniqueIdentifier, id)
            .input('vendorId', sql.UniqueIdentifier, req.vendor.VendorId)
            .input('modifiedBy', sql.UniqueIdentifier, req.user.UserId);

        if (body.name !== undefined) {
            const name = (body.name ?? '').toString().trim();
            if (!name) {
                return res.status(400).json({ success: false, message: 'Name cannot be empty' });
            }
            if (name.length > MAX_NAME_LENGTH) {
                return res.status(400).json({
                    success: false,
                    message: `Name must be ${MAX_NAME_LENGTH} characters or fewer`
                });
            }
            updates.push('Name = @name');
            request.input('name', sql.NVarChar(MAX_NAME_LENGTH), name);
        }

        if (body.sortOrder !== undefined) {
            const sortOrder = Number.parseInt(body.sortOrder, 10);
            if (!Number.isFinite(sortOrder)) {
                return res.status(400).json({ success: false, message: 'sortOrder must be an integer' });
            }
            updates.push('SortOrder = @sortOrder');
            request.input('sortOrder', sql.Int, sortOrder);
        }

        if (updates.length === 0) {
            return res.status(400).json({ success: false, message: 'No fields to update' });
        }

        updates.push('ModifiedDate = SYSUTCDATETIME()');
        updates.push('ModifiedBy = @modifiedBy');

        const result = await request.query(`
            UPDATE oe.VendorShareRequestTypes
            SET ${updates.join(', ')}
            WHERE TypeId = @typeId AND VendorId = @vendorId;

            SELECT TypeId, VendorId, Name, SortOrder, CreatedDate, ModifiedDate
            FROM oe.VendorShareRequestTypes
            WHERE TypeId = @typeId AND VendorId = @vendorId;
        `);

        if (result.recordset.length === 0) {
            return res.status(404).json({ success: false, message: 'Request type not found' });
        }

        res.json({ success: true, data: result.recordset[0] });
    } catch (error) {
        if (error && (error.number === 2627 || error.number === 2601)) {
            return res.status(409).json({
                success: false,
                message: 'A type with that name already exists for this vendor'
            });
        }
        console.error('❌ Error updating request type:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update request type',
            error: error.message
        });
    }
});

// ---------------------------------------------------------------------------
// DELETE /:id  — delete with confirmation for dependents
//
// Without ?force=true: counts dependent share requests; if any exist returns
// 409 + { dependentCount } so the UI can show the warning modal.
// With ?force=true: in a transaction, NULLs out dependents then deletes the
// type row. Per the design the column is nullable and the UI renders "—".
// ---------------------------------------------------------------------------
router.delete('/:id', adminOnly, async (req, res) => {
    const { id } = req.params;
    const force = req.query.force === 'true' || req.query.force === '1';

    const pool = await getPool();

    // Step 1: confirm the type belongs to this vendor.
    const ownerResult = await pool.request()
        .input('typeId', sql.UniqueIdentifier, id)
        .input('vendorId', sql.UniqueIdentifier, req.vendor.VendorId)
        .query(`
            SELECT TypeId
            FROM oe.VendorShareRequestTypes
            WHERE TypeId = @typeId AND VendorId = @vendorId
        `);

    if (ownerResult.recordset.length === 0) {
        return res.status(404).json({ success: false, message: 'Request type not found' });
    }

    // Step 2: count dependents.
    const dependentResult = await pool.request()
        .input('typeId', sql.UniqueIdentifier, id)
        .input('vendorId', sql.UniqueIdentifier, req.vendor.VendorId)
        .query(`
            SELECT COUNT(*) AS dependentCount
            FROM oe.ShareRequests
            WHERE RequestTypeId = @typeId AND VendorId = @vendorId
        `);

    const dependentCount = dependentResult.recordset[0].dependentCount;

    if (dependentCount > 0 && !force) {
        return res.status(409).json({
            success: false,
            code: 'DEPENDENTS_EXIST',
            message: 'Share requests are using this type',
            dependentCount
        });
    }

    // Step 3: transaction — NULL out dependents, then hard-delete the type.
    const transaction = new sql.Transaction(pool);
    try {
        await transaction.begin();

        if (dependentCount > 0) {
            await new sql.Request(transaction)
                .input('typeId', sql.UniqueIdentifier, id)
                .input('vendorId', sql.UniqueIdentifier, req.vendor.VendorId)
                .query(`
                    UPDATE oe.ShareRequests
                    SET RequestTypeId = NULL
                    WHERE RequestTypeId = @typeId AND VendorId = @vendorId
                `);
        }

        await new sql.Request(transaction)
            .input('typeId', sql.UniqueIdentifier, id)
            .input('vendorId', sql.UniqueIdentifier, req.vendor.VendorId)
            .query(`
                DELETE FROM oe.VendorShareRequestTypes
                WHERE TypeId = @typeId AND VendorId = @vendorId
            `);

        await transaction.commit();

        res.json({ success: true, data: { typeId: id, dependentCount } });
    } catch (error) {
        try { await transaction.rollback(); } catch (_) { /* ignore */ }
        console.error('❌ Error deleting request type:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete request type',
            error: error.message
        });
    }
});

module.exports = router;
