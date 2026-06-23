// backend/services/householdVendorNetworks.service.js
//
// Shared write helper for oe.HouseholdVendorNetworks.
//
// Used by:
//   - PUT /api/households/:householdId/vendor-networks  (admin-driven, full upsert/clear)
//   - POST /api/enrollment-links/:linkToken/complete-enrollment  (apply user's network
//     picks during enrollment; only non-default selections are passed)
//
// Selections are an object keyed by vendorId. Each value is either:
//   - vendorNetworkId (string)         -> upsert + activate that selection
//   - null / undefined / empty string  -> soft-delete (IsActive = 0)
//
// Soft-delete preserves ModifiedDate so eligibility export change-detection can see
// the change via that timestamp.

const { sql, rawSql } = require('../config/database');

/**
 * Apply a batch of household vendor network selections inside an existing transaction.
 *
 * @param {object} params
 * @param {object} params.transaction - active mssql Transaction
 * @param {string} params.householdId - target household
 * @param {Record<string, string|null|undefined>} params.selections - vendorId -> vendorNetworkId | null
 * @param {object} [params.logger] - optional logger (defaults to console)
 * @returns {Promise<{ applied: number, cleared: number, skipped: Array<{ vendorId: string, reason: string }> }>}
 */
async function applyHouseholdVendorNetworkSelections({
    transaction,
    householdId,
    selections,
    logger = console
}) {
    if (!transaction) throw new Error('transaction is required');
    if (!householdId) throw new Error('householdId is required');
    if (!selections || typeof selections !== 'object' || Array.isArray(selections)) {
        return { applied: 0, cleared: 0, skipped: [] };
    }

    let applied = 0;
    let cleared = 0;
    const skipped = [];

    for (const [vendorId, rawNetworkId] of Object.entries(selections)) {
        if (!vendorId) {
            skipped.push({ vendorId: '', reason: 'missing vendorId' });
            continue;
        }
        const vendorNetworkId = rawNetworkId && String(rawNetworkId).trim() ? String(rawNetworkId).trim() : null;

        if (!vendorNetworkId) {
            await new rawSql.Request(transaction)
                .input('householdId', sql.UniqueIdentifier, householdId)
                .input('vendorId', sql.UniqueIdentifier, vendorId)
                .query(`
                    UPDATE oe.HouseholdVendorNetworks
                    SET IsActive = 0, ModifiedDate = GETUTCDATE()
                    WHERE HouseholdId = @householdId AND VendorId = @vendorId AND IsActive = 1
                `);
            cleared += 1;
            continue;
        }

        const validNetwork = await new rawSql.Request(transaction)
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('networkId', sql.UniqueIdentifier, vendorNetworkId)
            .query(`
                SELECT VendorNetworkId
                FROM oe.VendorNetworks
                WHERE VendorNetworkId = @networkId AND VendorId = @vendorId AND IsActive = 1
            `);
        if (validNetwork.recordset.length === 0) {
            skipped.push({ vendorId, reason: `network ${vendorNetworkId} not found for vendor` });
            logger.warn?.(`Skipping HVN selection: vendor ${vendorId} network ${vendorNetworkId} not found / inactive`);
            continue;
        }

        await new rawSql.Request(transaction)
            .input('householdId', sql.UniqueIdentifier, householdId)
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('networkId', sql.UniqueIdentifier, vendorNetworkId)
            .query(`
                MERGE oe.HouseholdVendorNetworks AS target
                USING (SELECT @householdId AS HouseholdId, @vendorId AS VendorId) AS source
                ON target.HouseholdId = source.HouseholdId AND target.VendorId = source.VendorId
                WHEN MATCHED THEN
                    UPDATE SET VendorNetworkId = @networkId, IsActive = 1, ModifiedDate = GETUTCDATE()
                WHEN NOT MATCHED THEN
                    INSERT (HouseholdId, VendorId, VendorNetworkId, IsActive)
                    VALUES (@householdId, @vendorId, @networkId, 1);
            `);
        applied += 1;
    }

    return { applied, cleared, skipped };
}

module.exports = {
    applyHouseholdVendorNetworkSelections
};
