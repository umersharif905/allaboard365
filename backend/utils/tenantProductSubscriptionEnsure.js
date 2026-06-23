const { randomUUID } = require('crypto');

const GUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const DEFAULT_SYSTEM_FEES = {
    platformFee: { name: 'Platform Fee', amount: 2.5, type: 'fixed' },
    transactionFee: { name: 'Transaction Fee', amount: 0.5, type: 'fixed' },
    processingFee: { name: 'Processing Fee', amount: 1.0, type: 'fixed' }
};

function isValidGuid(value) {
    return typeof value === 'string' && GUID_REGEX.test(value.trim());
}

/**
 * Resolve oe.TenantProductSubscriptions.SubscriptionId from a route param that may be
 * either SubscriptionId or ProductId (product owners without an auto-subscribed row).
 */
async function resolveTenantProductSubscriptionId(pool, sql, tenantId, userId, idParam) {
    if (!isValidGuid(idParam)) {
        return { ok: false, status: 400, message: 'Valid subscription or product id is required' };
    }

    const normalizedId = idParam.trim();

    const bySubscription = pool.request();
    bySubscription.input('SubscriptionId', sql.UniqueIdentifier, normalizedId);
    bySubscription.input('TenantId', sql.UniqueIdentifier, tenantId);
    const subResult = await bySubscription.query(`
        SELECT SubscriptionId
        FROM oe.TenantProductSubscriptions
        WHERE SubscriptionId = @SubscriptionId
          AND TenantId = @TenantId
          AND SubscriptionStatus != 'Cancelled'
    `);
    if (subResult.recordset[0]?.SubscriptionId) {
        return { ok: true, subscriptionId: subResult.recordset[0].SubscriptionId.toString() };
    }

    const ownerCheck = pool.request();
    ownerCheck.input('ProductId', sql.UniqueIdentifier, normalizedId);
    ownerCheck.input('TenantId', sql.UniqueIdentifier, tenantId);
    const ownerResult = await ownerCheck.query(`
        SELECT ProductId
        FROM oe.Products
        WHERE ProductId = @ProductId
          AND ProductOwnerId = @TenantId
          AND Status = 'Active'
    `);
    if (!ownerResult.recordset[0]) {
        return { ok: false, status: 404, message: 'Subscription not found' };
    }

    const ensured = await ensureOwnerTenantProductSubscription(pool, sql, tenantId, normalizedId, userId);
    if (!ensured.ok) {
        return ensured;
    }
    return { ok: true, subscriptionId: ensured.subscriptionId };
}

/**
 * Ensure a tenant has active subscription rows for a product (subscriber or new owner).
 * Creates missing rows or reactivates Cancelled TenantProductSubscriptions.
 */
async function ensureTenantProductSubscription(db, sql, options) {
    const {
        tenantId,
        productId,
        userId,
        productSubscriptionNotes = 'Auto-subscribed to product'
    } = options;

    if (!isValidGuid(tenantId) || !isValidGuid(productId)) {
        return { ok: false, status: 400, message: 'Valid tenant and product ids are required' };
    }

    const existingReq = db.request();
    existingReq.input('TenantId', sql.UniqueIdentifier, tenantId);
    existingReq.input('ProductId', sql.UniqueIdentifier, productId);
    const existingResult = await existingReq.query(`
        SELECT TOP 1 SubscriptionId, SubscriptionStatus
        FROM oe.TenantProductSubscriptions
        WHERE TenantId = @TenantId
          AND ProductId = @ProductId
        ORDER BY ModifiedDate DESC
    `);

    const existingRow = existingResult.recordset[0];
    const now = new Date();
    const actingUserId = userId || null;

    if (existingRow?.SubscriptionId) {
        const status = String(existingRow.SubscriptionStatus || '').trim();
        if (status && status.toLowerCase() !== 'cancelled') {
            await ensureProductSubscriptionRow(db, sql, {
                tenantId,
                productId,
                userId: actingUserId,
                notes: productSubscriptionNotes,
                now
            });
            return {
                ok: true,
                subscriptionId: existingRow.SubscriptionId.toString(),
                created: false,
                reactivated: false
            };
        }

        const reactivateReq = db.request();
        reactivateReq.input('SubscriptionId', sql.UniqueIdentifier, existingRow.SubscriptionId);
        reactivateReq.input('ModifiedBy', sql.UniqueIdentifier, actingUserId);
        reactivateReq.input('ModifiedDate', sql.DateTime2, now);
        await reactivateReq.query(`
            UPDATE oe.TenantProductSubscriptions
            SET SubscriptionStatus = 'Active',
                ModifiedBy = @ModifiedBy,
                ModifiedDate = @ModifiedDate
            WHERE SubscriptionId = @SubscriptionId
        `);

        await ensureProductSubscriptionRow(db, sql, {
            tenantId,
            productId,
            userId: actingUserId,
            notes: productSubscriptionNotes,
            now
        });

        return {
            ok: true,
            subscriptionId: existingRow.SubscriptionId.toString(),
            created: false,
            reactivated: true
        };
    }

    const feesReq = db.request();
    feesReq.input('TenantId', sql.UniqueIdentifier, tenantId);
    const feesResult = await feesReq.query(`
        SELECT SystemFees FROM oe.Tenants WHERE TenantId = @TenantId
    `);
    const rawSystemFees = feesResult.recordset[0]?.SystemFees;
    const systemFees = typeof rawSystemFees === 'string'
        ? rawSystemFees
        : JSON.stringify(rawSystemFees || DEFAULT_SYSTEM_FEES);

    const subscriptionId = randomUUID();
    const insertReq = db.request();
    insertReq.input('subscriptionId', sql.UniqueIdentifier, subscriptionId);
    insertReq.input('tenantId', sql.UniqueIdentifier, tenantId);
    insertReq.input('productId', sql.UniqueIdentifier, productId);
    insertReq.input('subscriptionStatus', sql.NVarChar(50), 'Active');
    insertReq.input('tenantRate', sql.Decimal(19, 4), 0);
    insertReq.input('systemFeesSnapshot', sql.NVarChar, systemFees);
    insertReq.input('createdBy', sql.UniqueIdentifier, actingUserId);
    insertReq.input('modifiedBy', sql.UniqueIdentifier, actingUserId);
    insertReq.input('subscriptionDate', sql.DateTime2, now);
    insertReq.input('modifiedDate', sql.DateTime2, now);
    insertReq.input('isConfigured', sql.Bit, 0);

    await insertReq.query(`
        INSERT INTO oe.TenantProductSubscriptions (
            SubscriptionId,
            TenantId,
            ProductId,
            SubscriptionStatus,
            TenantRate,
            SystemFeesSnapshot,
            CreatedBy,
            ModifiedBy,
            SubscriptionDate,
            ModifiedDate,
            IsConfigured
        ) VALUES (
            @subscriptionId,
            @tenantId,
            @productId,
            @subscriptionStatus,
            @tenantRate,
            @systemFeesSnapshot,
            @createdBy,
            @modifiedBy,
            @subscriptionDate,
            @modifiedDate,
            @isConfigured
        )
    `);

    await ensureProductSubscriptionRow(db, sql, {
        tenantId,
        productId,
        userId: actingUserId,
        notes: productSubscriptionNotes,
        now
    });

    return { ok: true, subscriptionId: subscriptionId.toString(), created: true, reactivated: false };
}

async function ensureProductSubscriptionRow(db, sql, { tenantId, productId, userId, notes, now }) {
    const psCheck = db.request();
    psCheck.input('tenantId', sql.UniqueIdentifier, tenantId);
    psCheck.input('productId', sql.UniqueIdentifier, productId);
    const psExisting = await psCheck.query(`
        SELECT TOP 1 ProductSubscriptionId, Status
        FROM oe.ProductSubscriptions
        WHERE TenantId = @tenantId AND ProductId = @productId
        ORDER BY ModifiedDate DESC
    `);

    if (psExisting.recordset[0]?.ProductSubscriptionId) {
        const status = String(psExisting.recordset[0].Status || '').trim();
        if (status && status.toLowerCase() !== 'approved') {
            const updateReq = db.request();
            updateReq.input('ProductSubscriptionId', sql.UniqueIdentifier, psExisting.recordset[0].ProductSubscriptionId);
            updateReq.input('status', sql.NVarChar(20), 'Approved');
            updateReq.input('approvalDate', sql.DateTime2, now);
            updateReq.input('modifiedBy', sql.UniqueIdentifier, userId);
            await updateReq.query(`
                UPDATE oe.ProductSubscriptions
                SET Status = @status,
                    ApprovalDate = @approvalDate,
                    ModifiedDate = GETUTCDATE(),
                    ModifiedBy = @modifiedBy
                WHERE ProductSubscriptionId = @ProductSubscriptionId
            `);
        }
        return;
    }

    if (!userId) {
        return;
    }

    const productSubscriptionId = randomUUID();
    await db.request()
        .input('productSubscriptionId', sql.UniqueIdentifier, productSubscriptionId)
        .input('productId', sql.UniqueIdentifier, productId)
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('status', sql.NVarChar(20), 'Approved')
        .input('requestDate', sql.DateTime2, now)
        .input('approvalDate', sql.DateTime2, now)
        .input('discountAmount', sql.Decimal(19, 4), 0)
        .input('serviceFeePerMember', sql.Decimal(19, 4), 0)
        .input('notes', sql.NVarChar(sql.MAX), notes)
        .input('approvedBy', sql.UniqueIdentifier, userId)
        .input('createdBy', sql.UniqueIdentifier, userId)
        .input('modifiedBy', sql.UniqueIdentifier, userId)
        .query(`
            INSERT INTO oe.ProductSubscriptions (
                ProductSubscriptionId,
                ProductId,
                TenantId,
                Status,
                RequestDate,
                ApprovalDate,
                DiscountAmount,
                DiscountEffectiveDate,
                DiscountEndDate,
                ServiceFeePerMember,
                Notes,
                ApprovedBy,
                CreatedDate,
                ModifiedDate,
                CreatedBy,
                ModifiedBy
            ) VALUES (
                @productSubscriptionId,
                @productId,
                @tenantId,
                @status,
                @requestDate,
                @approvalDate,
                @discountAmount,
                NULL,
                NULL,
                @serviceFeePerMember,
                @notes,
                @approvedBy,
                GETUTCDATE(),
                GETUTCDATE(),
                @createdBy,
                @modifiedBy
            )
        `);
}

/**
 * Ensure product owner has oe.TenantProductSubscriptions (and oe.ProductSubscriptions) rows.
 */
async function ensureOwnerTenantProductSubscription(pool, sql, tenantId, productId, userId) {
    const ownerCheck = pool.request();
    ownerCheck.input('ProductId', sql.UniqueIdentifier, productId);
    ownerCheck.input('TenantId', sql.UniqueIdentifier, tenantId);
    const ownerResult = await ownerCheck.query(`
        SELECT ProductId
        FROM oe.Products
        WHERE ProductId = @ProductId
          AND ProductOwnerId = @TenantId
          AND Status = 'Active'
    `);
    if (!ownerResult.recordset[0]) {
        return { ok: false, status: 403, message: 'Only product owners can auto-create a subscription row' };
    }

    return ensureTenantProductSubscription(pool, sql, {
        tenantId,
        productId,
        userId,
        productSubscriptionNotes: 'Auto-approved for product owner'
    });
}

module.exports = {
    GUID_REGEX,
    isValidGuid,
    resolveTenantProductSubscriptionId,
    ensureTenantProductSubscription,
    ensureOwnerTenantProductSubscription
};
