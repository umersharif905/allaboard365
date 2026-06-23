const { isValidGuid } = require('../utils/tenantProductSubscriptionEnsure');
const { getUserRoles } = require('../middleware/auth');

/**
 * Cancel a tenant's subscription to a product.
 * Blocked when the tenant owns the product (owner auto-subscription).
 *
 * @returns {Promise<{ ok: true, tenantId: string, productId: string, subscriptionId: string } | { ok: false, status: number, message: string }>}
 */
async function cancelTenantProductSubscription(pool, sql, options) {
    const { tenantId, subscriptionId, productId, modifiedBy } = options;

    if (!tenantId || !modifiedBy) {
        return { ok: false, status: 400, message: 'Tenant ID and modifier are required' };
    }
    if (!subscriptionId && !productId) {
        return { ok: false, status: 400, message: 'Subscription ID or product ID is required' };
    }

    const lookup = pool.request();
    lookup.input('TenantId', sql.UniqueIdentifier, tenantId);
    if (subscriptionId) {
        lookup.input('SubscriptionId', sql.UniqueIdentifier, subscriptionId);
    }
    if (productId) {
        lookup.input('ProductId', sql.UniqueIdentifier, productId);
    }

    const whereParts = ['tps.TenantId = @TenantId', `tps.SubscriptionStatus != 'Cancelled'`];
    if (subscriptionId) {
        whereParts.push('tps.SubscriptionId = @SubscriptionId');
    }
    if (productId) {
        whereParts.push('tps.ProductId = @ProductId');
    }

    const lookupResult = await lookup.query(`
        SELECT TOP 1
            tps.SubscriptionId,
            tps.ProductId,
            tps.TenantId,
            tps.RequestId,
            p.ProductOwnerId
        FROM oe.TenantProductSubscriptions tps
        INNER JOIN oe.Products p ON tps.ProductId = p.ProductId
        WHERE ${whereParts.join(' AND ')}
    `);

    const row = lookupResult.recordset[0];
    if (!row) {
        return { ok: false, status: 404, message: 'Subscription not found' };
    }

    const ownerId = row.ProductOwnerId ? row.ProductOwnerId.toString() : null;
    if (ownerId && ownerId.toLowerCase() === tenantId.toString().toLowerCase()) {
        return {
            ok: false,
            status: 400,
            message: 'Cannot remove subscription for the product owner tenant'
        };
    }

    const resolvedSubscriptionId = row.SubscriptionId.toString();
    const resolvedProductId = row.ProductId.toString();
    const resolvedTenantId = row.TenantId.toString();
    const requestId = row.RequestId ? row.RequestId.toString() : null;

    const cancelTps = pool.request();
    cancelTps.input('SubscriptionId', sql.UniqueIdentifier, resolvedSubscriptionId);
    cancelTps.input('ModifiedBy', sql.UniqueIdentifier, modifiedBy);
    cancelTps.input('ModifiedDate', sql.DateTime2, new Date());

    if (requestId) {
        cancelTps.input('TenantId', sql.UniqueIdentifier, resolvedTenantId);
        cancelTps.input('RequestId', sql.UniqueIdentifier, requestId);
        await cancelTps.query(`
            UPDATE oe.TenantProductSubscriptions
            SET
                SubscriptionStatus = 'Cancelled',
                ModifiedBy = @ModifiedBy,
                ModifiedDate = @ModifiedDate
            WHERE SubscriptionStatus != 'Cancelled'
              AND (
                SubscriptionId = @SubscriptionId
                OR (TenantId = @TenantId AND RequestId = @RequestId)
              )
        `);
    } else {
        await cancelTps.query(`
            UPDATE oe.TenantProductSubscriptions
            SET
                SubscriptionStatus = 'Cancelled',
                ModifiedBy = @ModifiedBy,
                ModifiedDate = @ModifiedDate
            WHERE SubscriptionId = @SubscriptionId
        `);
    }

    const affectedProducts = pool.request();
    affectedProducts.input('SubscriptionId', sql.UniqueIdentifier, resolvedSubscriptionId);
    if (requestId) {
        affectedProducts.input('TenantId', sql.UniqueIdentifier, resolvedTenantId);
        affectedProducts.input('RequestId', sql.UniqueIdentifier, requestId);
    }
    const affectedProductsResult = await affectedProducts.query(requestId
        ? `
            SELECT DISTINCT ProductId
            FROM oe.TenantProductSubscriptions
            WHERE TenantId = @TenantId
              AND RequestId = @RequestId
        `
        : `
            SELECT ProductId
            FROM oe.TenantProductSubscriptions
            WHERE SubscriptionId = @SubscriptionId
        `);

    for (const affected of affectedProductsResult.recordset) {
        const productIdToClear = affected.ProductId.toString();
        await pool.request()
            .input('TenantId', sql.UniqueIdentifier, resolvedTenantId)
            .input('ProductId', sql.UniqueIdentifier, productIdToClear)
            .input('ModifiedBy', sql.UniqueIdentifier, modifiedBy)
            .query(`
                UPDATE oe.ProductSubscriptions
                SET
                    Status = 'Removed',
                    ModifiedDate = GETUTCDATE(),
                    ModifiedBy = @ModifiedBy
                WHERE TenantId = @TenantId
                  AND ProductId = @ProductId
                  AND Status IN ('Active', 'Suspended', 'Approved')
            `);
    }

    return {
        ok: true,
        tenantId: resolvedTenantId,
        productId: resolvedProductId,
        subscriptionId: resolvedSubscriptionId
    };
}

/**
 * List active tenant subscribers for a product (includes owner row with isProductOwner flag).
 */
async function listProductSubscribers(pool, sql, productId) {
    if (!isValidGuid(productId)) {
        return { ok: false, status: 400, message: 'Invalid product ID' };
    }

    const result = await pool.request()
        .input('ProductId', sql.UniqueIdentifier, productId.trim())
        .query(`
            SELECT
                tps.SubscriptionId,
                t.TenantId,
                t.Name AS TenantName,
                tps.SubscriptionStatus,
                tps.SubscriptionDate,
                p.ProductOwnerId,
                CASE WHEN t.TenantId = p.ProductOwnerId THEN 1 ELSE 0 END AS IsProductOwner
            FROM oe.TenantProductSubscriptions tps
            INNER JOIN oe.Tenants t ON tps.TenantId = t.TenantId
            INNER JOIN oe.Products p ON tps.ProductId = p.ProductId
            WHERE tps.ProductId = @ProductId
              AND tps.SubscriptionStatus != 'Cancelled'
            ORDER BY t.Name
        `);

    return {
        ok: true,
        subscribers: result.recordset.map((row) => ({
            subscriptionId: row.SubscriptionId?.toString(),
            tenantId: row.TenantId?.toString(),
            tenantName: row.TenantName,
            subscriptionStatus: row.SubscriptionStatus,
            subscriptionDate: row.SubscriptionDate,
            isProductOwner: row.IsProductOwner === 1 || row.IsProductOwner === true
        }))
    };
}

/**
 * SysAdmin or product-owner tenant admin may manage subscriber list.
 */
async function assertProductSubscriberManagementAccess(pool, sql, req, productId) {
    if (!isValidGuid(productId)) {
        return { ok: false, status: 400, message: 'Invalid product ID' };
    }

    const roles = getUserRoles(req.user);
    const isSysAdmin = roles.includes('SysAdmin');
    if (isSysAdmin) {
        return { ok: true };
    }

    const tenantId = req.tenantId || req.user?.TenantId;
    if (!tenantId || !roles.includes('TenantAdmin')) {
        return { ok: false, status: 403, message: 'Access denied' };
    }

    const ownerCheck = await pool.request()
        .input('ProductId', sql.UniqueIdentifier, productId)
        .input('TenantId', sql.UniqueIdentifier, tenantId)
        .query(`
            SELECT ProductId
            FROM oe.Products
            WHERE ProductId = @ProductId
              AND ProductOwnerId = @TenantId
              AND Status = 'Active'
        `);

    if (!ownerCheck.recordset[0]) {
        return { ok: false, status: 403, message: 'Only the product owner or SysAdmin can manage subscribers' };
    }

    return { ok: true };
}

module.exports = {
    cancelTenantProductSubscription,
    listProductSubscribers,
    assertProductSubscriberManagementAccess
};
