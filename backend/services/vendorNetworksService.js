// backend/services/vendorNetworksService.js
//
// Shared CRUD helpers for oe.VendorNetworks. Used by both the admin route
// (/api/vendors/:id/networks) and the vendor portal route
// (/api/me/vendor/profile/networks).

const sql = require('mssql');

const isValidGuid = (value) =>
    typeof value === 'string' &&
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value.trim());

function mapRow(row) {
    if (!row) return null;
    return {
        vendorNetworkId: row.VendorNetworkId,
        vendorId: row.VendorId,
        title: row.Title,
        isDefault: row.IsDefault === true || row.IsDefault === 1,
        isActive: row.IsActive === true || row.IsActive === 1,
        createdDate: row.CreatedDate,
        modifiedDate: row.ModifiedDate
    };
}

async function listVendorNetworks(pool, vendorId) {
    const result = await pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .query(`
            SELECT VendorNetworkId, VendorId, Title, IsDefault, IsActive, CreatedDate, ModifiedDate
            FROM oe.VendorNetworks
            WHERE VendorId = @vendorId AND IsActive = 1
            ORDER BY IsDefault DESC, Title ASC
        `);
    return result.recordset.map(mapRow);
}

async function createVendorNetwork(pool, vendorId, { title, isDefault }) {
    const trimmed = (title || '').toString().trim();
    if (!trimmed) {
        const err = new Error('Title is required');
        err.statusCode = 400;
        throw err;
    }
    if (trimmed.length > 255) {
        const err = new Error('Title is too long (max 255)');
        err.statusCode = 400;
        throw err;
    }

    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
        // If marking as default, clear other defaults
        if (isDefault) {
            await new sql.Request(transaction)
                .input('vendorId', sql.UniqueIdentifier, vendorId)
                .query(`
                    UPDATE oe.VendorNetworks
                    SET IsDefault = 0, ModifiedDate = GETUTCDATE()
                    WHERE VendorId = @vendorId AND IsDefault = 1
                `);
        }

        // If no networks exist yet, force this one to default
        const countResult = await new sql.Request(transaction)
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query(`
                SELECT COUNT(*) AS Cnt
                FROM oe.VendorNetworks
                WHERE VendorId = @vendorId AND IsActive = 1
            `);
        const existingCount = countResult.recordset[0].Cnt;
        const finalIsDefault = isDefault === true || existingCount === 0;

        const insert = await new sql.Request(transaction)
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('title', sql.NVarChar(255), trimmed)
            .input('isDefault', sql.Bit, finalIsDefault ? 1 : 0)
            .query(`
                INSERT INTO oe.VendorNetworks (VendorId, Title, IsDefault, IsActive)
                OUTPUT inserted.VendorNetworkId, inserted.VendorId, inserted.Title,
                       inserted.IsDefault, inserted.IsActive, inserted.CreatedDate, inserted.ModifiedDate
                VALUES (@vendorId, @title, @isDefault, 1)
            `);

        await transaction.commit();
        return mapRow(insert.recordset[0]);
    } catch (e) {
        try { await transaction.rollback(); } catch (_) { /* noop */ }
        throw e;
    }
}

async function updateVendorNetwork(pool, vendorId, networkId, { title, isDefault }) {
    if (!isValidGuid(networkId)) {
        const err = new Error('Invalid network id');
        err.statusCode = 400;
        throw err;
    }

    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
        const existing = await new sql.Request(transaction)
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('networkId', sql.UniqueIdentifier, networkId)
            .query(`
                SELECT VendorNetworkId, Title, IsDefault
                FROM oe.VendorNetworks
                WHERE VendorNetworkId = @networkId AND VendorId = @vendorId AND IsActive = 1
            `);

        if (existing.recordset.length === 0) {
            const err = new Error('Network not found');
            err.statusCode = 404;
            throw err;
        }

        if (isDefault === true) {
            await new sql.Request(transaction)
                .input('vendorId', sql.UniqueIdentifier, vendorId)
                .input('networkId', sql.UniqueIdentifier, networkId)
                .query(`
                    UPDATE oe.VendorNetworks
                    SET IsDefault = 0, ModifiedDate = GETUTCDATE()
                    WHERE VendorId = @vendorId AND IsDefault = 1 AND VendorNetworkId <> @networkId
                `);
        }

        const trimmed = title !== undefined ? (title || '').toString().trim() : null;
        if (trimmed !== null && !trimmed) {
            const err = new Error('Title cannot be empty');
            err.statusCode = 400;
            throw err;
        }

        const updateRequest = new sql.Request(transaction)
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('networkId', sql.UniqueIdentifier, networkId);

        const setParts = ['ModifiedDate = GETUTCDATE()'];
        if (trimmed !== null) {
            updateRequest.input('title', sql.NVarChar(255), trimmed);
            setParts.push('Title = @title');
        }
        if (isDefault !== undefined) {
            updateRequest.input('isDefault', sql.Bit, isDefault ? 1 : 0);
            setParts.push('IsDefault = @isDefault');
        }

        const updated = await updateRequest.query(`
            UPDATE oe.VendorNetworks
            SET ${setParts.join(', ')}
            OUTPUT inserted.VendorNetworkId, inserted.VendorId, inserted.Title,
                   inserted.IsDefault, inserted.IsActive, inserted.CreatedDate, inserted.ModifiedDate
            WHERE VendorNetworkId = @networkId AND VendorId = @vendorId
        `);

        await transaction.commit();
        return mapRow(updated.recordset[0]);
    } catch (e) {
        try { await transaction.rollback(); } catch (_) { /* noop */ }
        throw e;
    }
}

async function deleteVendorNetwork(pool, vendorId, networkId) {
    if (!isValidGuid(networkId)) {
        const err = new Error('Invalid network id');
        err.statusCode = 400;
        throw err;
    }

    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
        const existing = await new sql.Request(transaction)
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('networkId', sql.UniqueIdentifier, networkId)
            .query(`
                SELECT VendorNetworkId, IsDefault
                FROM oe.VendorNetworks
                WHERE VendorNetworkId = @networkId AND VendorId = @vendorId AND IsActive = 1
            `);

        if (existing.recordset.length === 0) {
            const err = new Error('Network not found');
            err.statusCode = 404;
            throw err;
        }

        if (existing.recordset[0].IsDefault === true || existing.recordset[0].IsDefault === 1) {
            const err = new Error('Cannot delete the default network. Mark another network as default first.');
            err.statusCode = 400;
            throw err;
        }

        // Soft delete + remove any group selections referencing this network so groups fall back to default
        await new sql.Request(transaction)
            .input('networkId', sql.UniqueIdentifier, networkId)
            .query(`
                DELETE FROM oe.GroupVendorNetworks WHERE VendorNetworkId = @networkId
            `);

        await new sql.Request(transaction)
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('networkId', sql.UniqueIdentifier, networkId)
            .query(`
                UPDATE oe.VendorNetworks
                SET IsActive = 0, ModifiedDate = GETUTCDATE()
                WHERE VendorNetworkId = @networkId AND VendorId = @vendorId
            `);

        await transaction.commit();
        return { success: true };
    } catch (e) {
        try { await transaction.rollback(); } catch (_) { /* noop */ }
        throw e;
    }
}

module.exports = {
    listVendorNetworks,
    createVendorNetwork,
    updateVendorNetwork,
    deleteVendorNetwork,
    isValidGuid
};
