// backend/routes/subscriptions.js - Product Subscription Routes
const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/database');

// Import middleware - using the same pattern as other routes
const { authenticate, authorize , getUserRoles } = require('../middleware/auth');

/**
 * GET /api/subscriptions/test
 * Test endpoint to verify routes are loaded
 */
router.get('/test', (req, res) => {
    res.json({
        success: true,
        message: 'Subscriptions routes are loaded and working!',
        timestamp: new Date().toISOString()
    });
});

/**
 * GET /api/subscriptions/pending
 * Get pending subscription requests from ProductSubscriptionRequests table (SysAdmin only)
 */
router.get('/pending', authenticate, authorize(['SysAdmin']), async (req, res) => {
    try {
        const pool = await getPool();
        const request = pool.request();

        const result = await request.query(`
            SELECT 
                psr.RequestId,
                psr.RequestDate,
                psr.Notes,
                psr.RequestedDiscount,
                psr.DiscountType,
                psr.TierDiscounts,
                psr.EstimatedVolume,
                psr.DiscountJustification,
                p.ProductId,
                p.Name as ProductName,
                p.ProductType,
                p.Description,
                p.ProductImageUrl,
                po.Name as ProductOwnerName,
                t.TenantId,
                t.Name as TenantName,
                t.ContactEmail as TenantEmail,
                u.FirstName + ' ' + u.LastName as RequestedByName,
                u.Email as RequestedByEmail,
                (SELECT MIN(MSRPRate) FROM oe.ProductPricing pp 
                 WHERE pp.ProductId = p.ProductId AND pp.Status = 'Active') AS BasePrice
            FROM oe.ProductSubscriptionRequests psr
            JOIN oe.Products p ON psr.ProductId = p.ProductId
            JOIN oe.Tenants po ON p.ProductOwnerId = po.TenantId
            JOIN oe.Tenants t ON psr.TenantId = t.TenantId
            LEFT JOIN oe.Users u ON psr.RequestedBy = u.UserId
            WHERE psr.Status = 'Pending'
            ORDER BY psr.RequestDate DESC
        `);

        res.json({
            success: true,
            pendingRequests: result.recordset.map(row => ({
                ...row,
                id: row.RequestId,  // Add 'id' field for frontend compatibility
                requestId: row.RequestId,  // Also keep original field name
                RequestID: row.RequestId,  // Capital ID variant
                subscriptionId: row.RequestId,  // In case frontend expects this
                ProductSubscriptionId: row.RequestId  // Another possible variant
            })),
            count: result.recordset.length
        });

    } catch (error) {
        console.error('Error fetching pending subscriptions:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch pending subscriptions',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * GET /api/subscriptions
 * Get active subscriptions from ProductSubscriptions table (filtered by tenant for non-admins)
 */
router.get('/', authenticate, async (req, res) => {
    try {
        const pool = await getPool();
        const request = pool.request();
        
        const { status, tenantId } = req.query;
        
        const userType = getUserRoles(req.user)[0];
        const userTenantId = req.user.tenantId || req.user.TenantId;

        let query = `
            SELECT 
                ps.ProductSubscriptionId,
                ps.Status,
                ps.RequestDate,
                ps.ApprovalDate,
                ps.DiscountAmount,
                ps.DiscountEffectiveDate,
                ps.DiscountEndDate,
                ps.ServiceFeePerMember,
                ps.Notes,
                ps.DenialReason,
                p.ProductId,
                p.Name as ProductName,
                p.Description,
                p.ProductType,
                p.ProductImageUrl,
                t.TenantId,
                t.Name AS TenantName,
                t.ContactEmail AS TenantEmail,
                po.Name as ProductOwnerName,
                (SELECT MIN(MSRPRate) FROM oe.ProductPricing pp 
                 WHERE pp.ProductId = p.ProductId AND pp.Status = 'Active') AS BasePrice,
                au.FirstName + ' ' + au.LastName as ApprovedByName
            FROM oe.ProductSubscriptions ps
            JOIN oe.Products p ON ps.ProductId = p.ProductId
            JOIN oe.Tenants t ON ps.TenantId = t.TenantId
            JOIN oe.Tenants po ON p.ProductOwnerId = po.TenantId
            LEFT JOIN oe.Users au ON ps.ApprovedBy = au.UserId
            WHERE 1=1
        `;

        // Non-SysAdmins can only see their own subscriptions
        if (userType !== 'SysAdmin') {
            query += ` AND ps.TenantId = @userTenantId`;
            request.input('userTenantId', sql.UniqueIdentifier, userTenantId);
        } else if (tenantId) {
            query += ` AND ps.TenantId = @tenantId`;
            request.input('tenantId', sql.UniqueIdentifier, tenantId);
        }

        if (status) {
            query += ` AND ps.Status = @status`;
            request.input('status', sql.NVarChar, status);
        }

        query += ` ORDER BY ps.RequestDate DESC`;

        const result = await request.query(query);

        res.json({
            success: true,
            subscriptions: result.recordset,
            count: result.recordset.length
        });

    } catch (error) {
        console.error('Error fetching subscriptions:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch subscriptions',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * POST /api/subscriptions
 * Request product subscription - creates entry in ProductSubscriptionRequests table
 */
router.post('/', authenticate, authorize(['TenantAdmin', 'GroupAdmin']), async (req, res) => {
    try {
        const { productId, notes, requestedDiscount, discountType, tierDiscounts, estimatedVolume, discountJustification } = req.body;
        const tenantId = req.user.tenantId || req.user.TenantId;
        const userId = req.user.userId || req.user.UserId;

        if (!productId) {
            return res.status(400).json({
                success: false,
                message: 'Product ID is required'
            });
        }

        const pool = await getPool();
        const request = pool.request();
        
        // Check if subscription already exists in ProductSubscriptions table
        request.input('productId', sql.UniqueIdentifier, productId);
        request.input('tenantId', sql.UniqueIdentifier, tenantId);

        const existingResult = await request.query(`
            SELECT ProductSubscriptionId, Status 
            FROM oe.ProductSubscriptions 
            WHERE ProductId = @productId AND TenantId = @tenantId
        `);

        if (existingResult.recordset.length > 0) {
            const existing = existingResult.recordset[0];
            return res.status(409).json({
                success: false,
                message: `Subscription already exists with status: ${existing.Status}`,
                subscriptionId: existing.ProductSubscriptionId
            });
        }

        // Check if request already exists in ProductSubscriptionRequests table
        const existingRequestResult = await request.query(`
            SELECT RequestId, Status 
            FROM oe.ProductSubscriptionRequests 
            WHERE ProductId = @productId AND TenantId = @tenantId AND Status = 'Pending'
        `);

        if (existingRequestResult.recordset.length > 0) {
            return res.status(409).json({
                success: false,
                message: 'A pending request already exists for this product',
                requestId: existingRequestResult.recordset[0].RequestId
            });
        }

        // Create new subscription request
        const requestId = require('crypto').randomUUID();
        
        request.input('requestId', sql.UniqueIdentifier, requestId);
        request.input('notes', sql.NVarChar, notes);
        request.input('requestedBy', sql.UniqueIdentifier, userId);
        request.input('requestedDiscount', sql.Decimal(5,2), requestedDiscount || 0);
        request.input('discountType', sql.NVarChar, discountType);
        request.input('tierDiscounts', sql.NVarChar, tierDiscounts ? JSON.stringify(tierDiscounts) : null);
        request.input('estimatedVolume', sql.Int, estimatedVolume);
        request.input('discountJustification', sql.NVarChar, discountJustification);

        await request.query(`
            INSERT INTO oe.ProductSubscriptionRequests (
                RequestId, ProductId, TenantId, RequestedBy, RequestDate, 
                Status, Notes, CreatedDate, RequestedDiscount, DiscountType,
                TierDiscounts, EstimatedVolume, DiscountJustification
            ) VALUES (
                @requestId, @productId, @tenantId, @requestedBy, GETUTCDATE(),
                'Pending', @notes, GETUTCDATE(), @requestedDiscount, @discountType,
                @tierDiscounts, @estimatedVolume, @discountJustification
            )
        `);

        res.status(201).json({
            success: true,
            message: 'Subscription request submitted successfully',
            requestId: requestId
        });

    } catch (error) {
        console.error('Error creating subscription request:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create subscription request',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * PUT /api/subscriptions/:id
 * Process subscription request - approve or deny (SysAdmin only)
 * This processes requests from ProductSubscriptionRequests table
 */
router.put('/:id', authenticate, authorize(['SysAdmin']), async (req, res) => {
    try {
        console.log('PUT /api/subscriptions/:id - Request ID:', req.params.id);
        console.log('User:', req.user.email, 'Role:', getUserRoles(req.user)[0]);
        console.log('Request body:', JSON.stringify(req.body, null, 2));
        
        const requestId = req.params.id;
        const userId = req.user.userId || req.user.UserId;
        const { 
            status, 
            denialReason, 
            discountAmount, 
            discountEffectiveDate, 
            discountEndDate, 
            notes,
            serviceFeePerMember 
        } = req.body;

        if (!['Approved', 'Denied'].includes(status)) {
            return res.status(400).json({
                success: false,
                message: 'Status must be either Approved or Denied'
            });
        }

        const pool = await getPool();
        const transaction = pool.transaction();
        await transaction.begin();

        try {
            // Get the request details first
            const getRequest = transaction.request();
            getRequest.input('requestId', sql.UniqueIdentifier, requestId);
            
            const requestResult = await getRequest.query(`
                SELECT 
                    psr.RequestId,
                    psr.TenantId,
                    psr.ProductId,
                    psr.RequestedDiscount,
                    psr.DiscountType,
                    psr.TierDiscounts,
                    psr.Status as CurrentStatus,
                    t.Name as TenantName,
                    t.ContactEmail as TenantEmail,
                    p.Name as ProductName
                FROM oe.ProductSubscriptionRequests psr
                JOIN oe.Tenants t ON psr.TenantId = t.TenantId
                JOIN oe.Products p ON psr.ProductId = p.ProductId
                WHERE psr.RequestId = @requestId
            `);

            if (requestResult.recordset.length === 0) {
                await transaction.rollback();
                return res.status(404).json({
                    success: false,
                    message: 'Subscription request not found'
                });
            }

            const requestData = requestResult.recordset[0];

            if (requestData.CurrentStatus !== 'Pending') {
                await transaction.rollback();
                return res.status(400).json({
                    success: false,
                    message: `Request has already been ${requestData.CurrentStatus.toLowerCase()}`
                });
            }

            // Update the request status
            const updateRequest = transaction.request();
            updateRequest.input('requestId', sql.UniqueIdentifier, requestId);
            updateRequest.input('status', sql.NVarChar, status);
            updateRequest.input('processedBy', sql.UniqueIdentifier, userId);
            updateRequest.input('processingNotes', sql.NVarChar, status === 'Denied' && denialReason ? `${notes || ''} Reason: ${denialReason}` : notes);
            updateRequest.input('approvedDiscount', sql.Decimal(5,2), status === 'Approved' ? (discountAmount || requestData.RequestedDiscount || 0) : null);

            await updateRequest.query(`
                UPDATE oe.ProductSubscriptionRequests 
                SET 
                    Status = @status,
                    ProcessedDate = GETUTCDATE(),
                    ProcessedBy = @processedBy,
                    ProcessingNotes = @processingNotes,
                    ApprovedDiscount = @approvedDiscount
                WHERE RequestId = @requestId
            `);

            // If approved, create the actual subscription and delete the request
            if (status === 'Approved') {
                const subscriptionId = require('crypto').randomUUID();
                
                // Handle dates - convert to Date objects or null
                let effectiveDate = null;
                let endDate = null;
                
                if (discountEffectiveDate) {
                    effectiveDate = new Date(discountEffectiveDate);
                    if (isNaN(effectiveDate.getTime())) {
                        effectiveDate = null;
                    }
                }
                
                if (discountEndDate) {
                    endDate = new Date(discountEndDate);
                    if (isNaN(endDate.getTime())) {
                        endDate = null;
                    }
                }
                
                const createSubscription = transaction.request();
                createSubscription.input('subscriptionId', sql.UniqueIdentifier, subscriptionId);
                createSubscription.input('productId', sql.UniqueIdentifier, requestData.ProductId);
                createSubscription.input('tenantId', sql.UniqueIdentifier, requestData.TenantId);
                createSubscription.input('discountAmount', sql.Decimal(19,4), discountAmount || requestData.RequestedDiscount || 0);
                createSubscription.input('discountEffectiveDate', sql.Date, effectiveDate);
                createSubscription.input('discountEndDate', sql.Date, endDate);
                createSubscription.input('serviceFeePerMember', sql.Decimal(19,4), serviceFeePerMember || 2.50);
                createSubscription.input('notes', sql.NVarChar, notes || null);
                createSubscription.input('approvedBy', sql.UniqueIdentifier, userId);

                await createSubscription.query(`
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
                        @subscriptionId, 
                        @productId, 
                        @tenantId, 
                        'Approved',
                        GETUTCDATE(), 
                        GETUTCDATE(), 
                        @discountAmount,
                        @discountEffectiveDate, 
                        @discountEndDate,
                        @serviceFeePerMember,
                        @notes,
                        @approvedBy,
                        GETUTCDATE(), 
                        GETUTCDATE(), 
                        @approvedBy, 
                        @approvedBy
                    )
                `);

                // Update TenantProductSubscriptions if it exists
                const updateTenantSubscription = transaction.request();
                updateTenantSubscription.input('requestId', sql.UniqueIdentifier, requestId);
                updateTenantSubscription.input('status', sql.NVarChar, 'Active');
                updateTenantSubscription.input('modifiedBy', sql.UniqueIdentifier, userId);
                
                await updateTenantSubscription.query(`
                    UPDATE oe.TenantProductSubscriptions
                    SET SubscriptionStatus = @status,
                        ModifiedBy = @modifiedBy,
                        ModifiedDate = GETUTCDATE()
                    WHERE RequestId = @requestId
                `);
            }

            await transaction.commit();

            res.json({
                success: true,
                message: `Subscription ${status.toLowerCase()} successfully`,
                data: {
                    requestId: requestId,
                    status: status,
                    tenantName: requestData.TenantName,
                    productName: requestData.ProductName
                }
            });

        } catch (error) {
            await transaction.rollback();
            throw error;
        }

    } catch (error) {
        console.error('Error updating subscription:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update subscription',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * DELETE /api/subscriptions/:id
 * Remove active subscription (SysAdmin only)
 */
router.delete('/:id', authenticate, authorize(['SysAdmin']), async (req, res) => {
    try {
        const subscriptionId = req.params.id;
        const userId = req.user.userId || req.user.UserId;

        const pool = await getPool();
        const request = pool.request();
        
        request.input('subscriptionId', sql.UniqueIdentifier, subscriptionId);
        request.input('modifiedBy', sql.UniqueIdentifier, userId);

        // Update status to 'Removed' instead of hard delete
        const result = await request.query(`
            UPDATE oe.ProductSubscriptions
            SET 
                Status = 'Removed',
                ModifiedDate = GETUTCDATE(),
                ModifiedBy = @modifiedBy
            OUTPUT DELETED.TenantId, DELETED.ProductId
            WHERE ProductSubscriptionId = @subscriptionId AND Status = 'Approved'
        `);

        if (result.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Active subscription not found'
            });
        }

        res.json({
            success: true,
            message: 'Subscription removed successfully'
        });

    } catch (error) {
        console.error('Error removing subscription:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to remove subscription',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

module.exports = router;