const express = require('express');
const router = express.Router();
const { getEffectiveUserId } = require('../../../middleware/attachMemberHouseholdContext');
const { getPool, sql } = require('../../../config/database');
const { PricingEngine } = require('../../../services/pricing/PricingEngine');
const { ContributionCalculator } = require('../../../services/pricing/ContributionCalculator');
const posthog = require('../../../config/posthog');

/**
 * POST /api/me/member/plan-changes
 * Submit plan changes request (config changes, add/remove products)
 */
router.post('/', async (req, res) => {
    try {
        const userId = getEffectiveUserId(req);
        const {
            enrollmentId,
            configFieldChanges,
            addProducts,
            removeProducts,
            effectiveDate
        } = req.body;
        
        // Validation
        if (!enrollmentId) {
            return res.status(400).json({
                success: false,
                message: 'Enrollment ID is required'
            });
        }
        
        const pool = await getPool();
        const transaction = pool.transaction();
        await transaction.begin();
        
        try {
            // Get member and enrollment information
            const memberRequest = transaction.request();
            memberRequest.input('userId', sql.UniqueIdentifier, userId);
            memberRequest.input('enrollmentId', sql.UniqueIdentifier, enrollmentId);
            
            const memberResult = await memberRequest.query(`
                SELECT 
                    m.MemberId, 
                    m.TenantId, 
                    m.GroupId, 
                    m.AgentId,
                    e.EnrollmentId,
                    e.ProductId,
                    e.Status as EnrollmentStatus,
                    u.FirstName, 
                    u.LastName
                FROM oe.Members m
                JOIN oe.Users u ON m.UserId = u.UserId
                JOIN oe.Enrollments e ON m.MemberId = e.MemberId
                WHERE u.UserId = @userId 
                  AND e.EnrollmentId = @enrollmentId
                  AND e.Status = 'Active'
            `);
            
            if (memberResult.recordset.length === 0) {
                await transaction.rollback();
                return res.status(404).json({
                    success: false,
                    message: 'Active enrollment not found or access denied'
                });
            }
            
            const member = memberResult.recordset[0];
            
            // Check if member is active
            if (member.EnrollmentStatus !== 'Active') {
                await transaction.rollback();
                return res.status(403).json({
                    success: false,
                    message: 'Only active enrollments can be modified'
                });
            }
            
            // Create plan change request
            const changeRequestId = require('crypto').randomUUID();
            const changeRequest = transaction.request();
            changeRequest.input('changeRequestId', sql.UniqueIdentifier, changeRequestId);
            changeRequest.input('enrollmentId', sql.UniqueIdentifier, enrollmentId);
            changeRequest.input('memberId', sql.UniqueIdentifier, member.MemberId);
            changeRequest.input('configFieldChanges', sql.NVarChar, configFieldChanges ? JSON.stringify(configFieldChanges) : null);
            changeRequest.input('addProducts', sql.NVarChar, addProducts ? JSON.stringify(addProducts) : null);
            changeRequest.input('removeProducts', sql.NVarChar, removeProducts ? JSON.stringify(removeProducts) : null);
            changeRequest.input('effectiveDate', sql.Date, effectiveDate || null);
            changeRequest.input('status', sql.NVarChar, 'Pending');
            changeRequest.input('createdBy', sql.UniqueIdentifier, userId);
            
            await changeRequest.query(`
                INSERT INTO oe.PlanChangeRequests 
                (ChangeRequestId, EnrollmentId, MemberId, ConfigFieldChanges, AddProducts, 
                 RemoveProducts, EffectiveDate, Status, CreatedDate, ModifiedDate, CreatedBy, ModifiedBy)
                VALUES 
                (@changeRequestId, @enrollmentId, @memberId, @configFieldChanges, @addProducts,
                 @removeProducts, @effectiveDate, @status, GETUTCDATE(), GETUTCDATE(), @createdBy, @createdBy)
            `);
            
            await transaction.commit();

            console.log(`✅ Plan change request created: ${changeRequestId} for enrollment ${enrollmentId}`);

            posthog.capture({
                distinctId: String(userId),
                event: 'plan change requested',
                properties: {
                    change_request_id: changeRequestId,
                    enrollment_id: String(enrollmentId),
                    member_id: String(member.MemberId),
                    tenant_id: member.TenantId ? String(member.TenantId) : undefined,
                    has_config_changes: !!(configFieldChanges && Object.keys(configFieldChanges).length),
                    added_products_count: addProducts ? addProducts.length : 0,
                    removed_products_count: removeProducts ? removeProducts.length : 0,
                    effective_date: effectiveDate || undefined,
                },
            });

            res.status(201).json({
                success: true,
                message: 'Plan change request submitted successfully. Pending approval.',
                data: {
                    changeRequestId,
                    status: 'Pending',
                    enrollmentId,
                    memberName: `${member.FirstName} ${member.LastName}`
                }
            });
            
        } catch (error) {
            await transaction.rollback();
            throw error;
        }
        
    } catch (error) {
        posthog.captureException(error, req.user?.UserId ? String(req.user.UserId) : undefined);
        console.error('❌ Error creating plan change request:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create plan change request'
        });
    }
});

/**
 * GET /api/me/member/plan-changes
 * Get member's plan change requests
 */
router.get('/', async (req, res) => {
    try {
        const userId = getEffectiveUserId(req);
        const pool = await getPool();
        
        const request = pool.request();
        request.input('userId', sql.UniqueIdentifier, userId);
        
        const query = `
            SELECT 
                pcr.ChangeRequestId,
                pcr.EnrollmentId,
                pcr.ConfigFieldChanges,
                pcr.AddProducts,
                pcr.RemoveProducts,
                pcr.EffectiveDate,
                pcr.Status,
                pcr.CreatedDate,
                pcr.ModifiedDate,
                -- Enrollment details
                e.ProductId,
                p.Name as ProductName,
                p.ProductType
            FROM oe.PlanChangeRequests pcr
            JOIN oe.Enrollments e ON pcr.EnrollmentId = e.EnrollmentId
            JOIN oe.Members m ON e.MemberId = m.MemberId
            JOIN oe.Users u ON m.UserId = u.UserId
            JOIN oe.Products p ON e.ProductId = p.ProductId
            WHERE u.UserId = @userId
            ORDER BY pcr.CreatedDate DESC
        `;
        
        const result = await request.query(query);
        
        // Format the response
        const changeRequests = result.recordset.map(request => ({
            changeRequestId: request.ChangeRequestId,
            enrollmentId: request.EnrollmentId,
            productId: request.ProductId,
            productName: request.ProductName,
            productType: request.ProductType,
            configFieldChanges: request.ConfigFieldChanges ? JSON.parse(request.ConfigFieldChanges) : null,
            addProducts: request.AddProducts ? JSON.parse(request.AddProducts) : [],
            removeProducts: request.RemoveProducts ? JSON.parse(request.RemoveProducts) : [],
            effectiveDate: request.EffectiveDate,
            status: request.Status,
            createdDate: request.CreatedDate,
            modifiedDate: request.ModifiedDate
        }));
        
        console.log(`✅ Retrieved ${changeRequests.length} plan change requests for member ${userId}`);
        
        res.json({
            success: true,
            data: changeRequests
        });
        
    } catch (error) {
        console.error('❌ Error fetching plan change requests:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch plan change requests'
        });
    }
});

/**
 * PUT /api/me/member/plan-changes/:id/cancel
 * Cancel pending plan change request
 */
router.put('/:id/cancel', async (req, res) => {
    try {
        const userId = getEffectiveUserId(req);
        const { id: changeRequestId } = req.params;
        
        const pool = await getPool();
        const request = pool.request();
        request.input('changeRequestId', sql.UniqueIdentifier, changeRequestId);
        request.input('userId', sql.UniqueIdentifier, userId);
        
        // Verify change request belongs to member and is pending
        const result = await request.query(`
            UPDATE pcr
            SET Status = 'Cancelled',
                ModifiedDate = GETUTCDATE(),
                ModifiedBy = @userId
            FROM oe.PlanChangeRequests pcr
            JOIN oe.Enrollments e ON pcr.EnrollmentId = e.EnrollmentId
            JOIN oe.Members m ON e.MemberId = m.MemberId
            JOIN oe.Users u ON m.UserId = u.UserId
            WHERE pcr.ChangeRequestId = @changeRequestId
              AND u.UserId = @userId
              AND pcr.Status = 'Pending'
        `);
        
        if (result.rowsAffected[0] === 0) {
            return res.status(404).json({
                success: false,
                message: 'Plan change request not found or cannot be cancelled'
            });
        }
        
        console.log(`✅ Plan change request cancelled: ${changeRequestId} by member ${userId}`);
        
        res.json({
            success: true,
            message: 'Plan change request cancelled successfully'
        });
        
    } catch (error) {
        console.error('❌ Error cancelling plan change request:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to cancel plan change request'
        });
    }
});

/**
 * GET /api/me/member/plan-changes/pricing-impact
 * Calculate pricing impact for plan changes
 */
router.post('/pricing-impact', async (req, res) => {
    try {
        const userId = getEffectiveUserId(req);
        const {
            enrollmentId,
            configFieldChanges,
            addProducts,
            removeProducts
        } = req.body;
        
        // Validation
        if (!enrollmentId) {
            return res.status(400).json({
                success: false,
                message: 'Enrollment ID is required'
            });
        }
        
        const pool = await getPool();
        const request = pool.request();
        request.input('userId', sql.UniqueIdentifier, userId);
        request.input('enrollmentId', sql.UniqueIdentifier, enrollmentId);
        
        // Get current enrollment and member details
        const memberResult = await request.query(`
            SELECT 
                m.MemberId,
                m.TenantId,
                e.ProductId,
                e.PremiumAmount as CurrentPremium,
                u.FirstName,
                u.LastName,
                u.DateOfBirth
            FROM oe.Members m
            JOIN oe.Users u ON m.UserId = u.UserId
            JOIN oe.Enrollments e ON m.MemberId = e.MemberId
            WHERE u.UserId = @userId 
              AND e.EnrollmentId = @enrollmentId
              AND e.Status = 'Active'
        `);
        
        if (memberResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Active enrollment not found'
            });
        }
        
        const member = memberResult.recordset[0];
        
        // Get current product pricing information
        const pricingRequest = pool.request();
        pricingRequest.input('productId', sql.UniqueIdentifier, member.ProductId);
        pricingRequest.input('memberId', sql.UniqueIdentifier, member.MemberId);
        
        const pricingResult = await pricingRequest.query(`
            SELECT 
                pp.ProductPricingId,
                pp.TierType,
                pp.TobaccoStatus,
                pp.MinAge,
                pp.MaxAge,
                pp.NetRate,
                pp.OverrideRate,
                pp.MSRPRate,
                pp.ConfigValue1,
                pp.ConfigValue2,
                pp.ConfigValue3,
                pp.ConfigValue4,
                pp.ConfigValue5
            FROM oe.ProductPricing pp
            WHERE pp.ProductId = @productId
              AND pp.Status = 'Active'
        `);
        
        // Calculate current pricing
        const currentPremium = parseFloat(member.CurrentPremium) || 0;
        let newPremium = currentPremium;
        let configChangeImpact = 0;
        let addedProductsImpact = 0;
        let removedProductsImpact = 0;
        
        // Calculate config field changes impact
        if (configFieldChanges && Object.keys(configFieldChanges).length > 0) {
            // Find matching pricing tier based on config values
            const matchingPricing = pricingResult.recordset.find(pricing => {
                // Match config values
                const config1Match = !configFieldChanges.configField1 || pricing.ConfigValue1 === configFieldChanges.configField1;
                const config2Match = !configFieldChanges.configField2 || pricing.ConfigValue2 === configFieldChanges.configField2;
                const config3Match = !configFieldChanges.configField3 || pricing.ConfigValue3 === configFieldChanges.configField3;
                const config4Match = !configFieldChanges.configField4 || pricing.ConfigValue4 === configFieldChanges.configField4;
                const config5Match = !configFieldChanges.configField5 || pricing.ConfigValue5 === configFieldChanges.configField5;
                
                return config1Match && config2Match && config3Match && config4Match && config5Match;
            });
            
            if (matchingPricing) {
                const newRate = parseFloat(matchingPricing.NetRate) + parseFloat(matchingPricing.OverrideRate);
                configChangeImpact = newRate - currentPremium;
                newPremium += configChangeImpact;
            }
        }
        
        // Calculate add products impact
        if (addProducts && addProducts.length > 0) {
            // TODO: Get pricing for each product to add
            // For now, estimate $50 per additional product
            addedProductsImpact = addProducts.length * 50;
            newPremium += addedProductsImpact;
        }
        
        // Calculate remove products impact
        if (removeProducts && removeProducts.length > 0) {
            // TODO: Get pricing for each product to remove
            // For now, estimate $50 per removed product
            removedProductsImpact = -removeProducts.length * 50;
            newPremium += removedProductsImpact;
        }
        
        const pricingImpact = {
            currentPremium: currentPremium,
            newPremium: Math.max(0, newPremium), // Ensure premium doesn't go negative
            difference: newPremium - currentPremium,
            breakdown: {
                configChanges: configChangeImpact,
                addedProducts: addedProductsImpact,
                removedProducts: removedProductsImpact
            },
            hasChanges: configChangeImpact !== 0 || addedProductsImpact !== 0 || removedProductsImpact !== 0
        };
        
        res.json({
            success: true,
            data: pricingImpact
        });
        
    } catch (error) {
        console.error('❌ Error calculating pricing impact:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to calculate pricing impact'
        });
    }
});

module.exports = router;
