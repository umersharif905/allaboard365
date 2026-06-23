const express = require('express');
const router = express.Router();
const { getEffectiveUserId } = require('../../../middleware/attachMemberHouseholdContext');
const { getPool, sql } = require('../../../config/database');
const { sameProductId } = require('../../../utils/productIdMatch');

/**
 * POST /api/me/member/product-changes
 * Submit product changes (add/remove products, config changes) for member's entire plan
 */
router.post('/', async (req, res) => {
    try {
        const userId = getEffectiveUserId(req);
        const {
            selectedProducts,      // Array of product IDs to keep/add
            removedProducts,       // Array of product IDs to remove
            configValues,          // Object with productId -> configValue mapping
            effectiveDate,         // When changes should take effect
            frontendPricing        // Frontend-calculated pricing for validation
        } = req.body;
        
        // Validation
        if (!selectedProducts || !Array.isArray(selectedProducts)) {
            return res.status(400).json({
                success: false,
                message: 'Selected products array is required'
            });
        }
        
        const pool = await getPool();
        const transaction = pool.transaction();
        await transaction.begin();
        
        try {
            // Get member information
            const memberRequest = transaction.request();
            memberRequest.input('userId', sql.UniqueIdentifier, userId);
            
            const memberResult = await memberRequest.query(`
                SELECT 
                    m.MemberId, 
                    m.HouseholdId,
                    m.TenantId, 
                    m.GroupId, 
                    m.AgentId,
                    u.FirstName, 
                    u.LastName
                FROM oe.Members m
                JOIN oe.Users u ON m.UserId = u.UserId
                WHERE u.UserId = @userId
            `);
            
            if (memberResult.recordset.length === 0) {
                await transaction.rollback();
                return res.status(404).json({
                    success: false,
                    message: 'Member not found'
                });
            }
            
            const member = memberResult.recordset[0];
            
            // PRICING VALIDATION - Validate frontend pricing against backend calculation
            if (frontendPricing && Array.isArray(frontendPricing) && frontendPricing.length > 0) {
                console.log('🔍 DEBUG: Product changes pricing validation - frontendPricing:', frontendPricing);
                
                // Get member criteria for pricing calculation
                const memberCriteriaRequest = transaction.request();
                memberCriteriaRequest.input('memberId', sql.UniqueIdentifier, member.MemberId);
                
                const memberCriteriaResult = await memberCriteriaRequest.query(`
                    SELECT 
                        m.RelationshipType,
                        m.Tier,
                        m.DateOfBirth,
                        m.TobaccoUse
                    FROM oe.Members m
                    WHERE m.MemberId = @memberId
                `);
                
                if (memberCriteriaResult.recordset.length > 0) {
                    const memberData = memberCriteriaResult.recordset[0];
                    
                    // Calculate age from DateOfBirth
                    const age = memberData.DateOfBirth ? 
                        Math.floor((new Date() - new Date(memberData.DateOfBirth)) / (365.25 * 24 * 60 * 60 * 1000)) : 35;
                    
                    // Get actual household size from household members
                    let householdSize = 1; // Default to 1
                    try {
                        // Query household members to get actual count
                        const householdQuery = `
                            SELECT COUNT(*) as MemberCount
                            FROM oe.Members m
                            WHERE m.HouseholdId = (SELECT HouseholdId FROM oe.Members WHERE MemberId = @memberId)
                              AND m.Status = 'Active'
                        `;
                        
                        const householdRequest = pool.request();
                        householdRequest.input('memberId', sql.UniqueIdentifier, member.MemberId);
                        const householdResult = await householdRequest.query(householdQuery);
                        
                        if (householdResult.recordset.length > 0) {
                            householdSize = householdResult.recordset[0].MemberCount || 1;
                        }
                    } catch (householdError) {
                        console.warn('⚠️ Could not retrieve household size, using default of 1:', householdError);
                    }
                    
                    const memberCriteria = {
                        age: age,
                        tobaccoUse: memberData.TobaccoUse || 'No',
                        tier: memberData.Tier || 'EE',
                        householdSize: householdSize
                    };
                    
                    console.log('🔍 DEBUG: Member criteria for pricing validation:', memberCriteria);
                    
                    // Validate each product's pricing
                    for (const frontendProduct of frontendPricing) {
                        try {
                            // Import PricingEngine for validation
                            const { PricingEngine } = require('../../../services/pricing/PricingEngine');
                            
                            // Calculate backend pricing for this product
                            const productConfigValues = configValues[frontendProduct.productId] ? {
                                configValue1: configValues[frontendProduct.productId]
                            } : {};
                            
                            const pricingResult = await PricingEngine.calculatePricing({
                                memberId: member.MemberId,
                                calculationType: 'enrollment',
                                memberCriteria,
                                productSelections: [{
                                    productId: frontendProduct.productId,
                                    configValues: productConfigValues
                                }]
                            });
                            
                            const backendProduct = pricingResult.products?.find((p) =>
                              sameProductId(p.productId, frontendProduct.productId)
                            );
                            const backendAmount = backendProduct?.monthlyPremium || 0;
                            const frontendAmount = frontendProduct.monthlyPremium || 0;
                            const difference = Math.abs(frontendAmount - backendAmount);
                            const tolerance = 0.01; // 1 cent tolerance
                            
                            console.log(`🔍 PRICING VALIDATION for ${frontendProduct.productName}:`, {
                                frontendAmount: `$${frontendAmount.toFixed(2)}`,
                                backendAmount: `$${backendAmount.toFixed(2)}`,
                                difference: `$${difference.toFixed(2)}`,
                                withinTolerance: difference <= tolerance,
                                selectedConfig: frontendProduct.selectedConfig
                            });
                            
                            if (difference > tolerance) {
                                console.error(`🚨 PRICING VALIDATION FAILED for ${frontendProduct.productName}: Frontend $${frontendAmount.toFixed(2)} vs Backend $${backendAmount.toFixed(2)}`);
                                console.error(`🚨 SECURITY ALERT: Potential price manipulation attempt detected`);
                                console.error(`🚨 Product changes blocked for security reasons`);
                                
                                return res.status(400).json({
                                    success: false,
                                    message: 'Pricing validation failed. Please refresh the page and try again.',
                                    error: {
                                        message: `Pricing mismatch detected for ${frontendProduct.productName}. Frontend: $${frontendAmount.toFixed(2)}, Backend: $${backendAmount.toFixed(2)}`,
                                        code: 'PRICING_VALIDATION_FAILED',
                                        details: {
                                            productId: frontendProduct.productId,
                                            productName: frontendProduct.productName,
                                            frontendAmount: frontendAmount,
                                            backendAmount: backendAmount,
                                            difference: difference,
                                            tolerance: tolerance
                                        }
                                    }
                                });
                            } else {
                                console.log(`✅ PRICING VALIDATION PASSED for ${frontendProduct.productName}`);
                            }
                        } catch (pricingError) {
                            console.error(`❌ Pricing validation error for ${frontendProduct.productName}:`, pricingError);
                            // Continue with validation for other products
                        }
                    }
                } else {
                    console.warn('⚠️ Could not retrieve member criteria for pricing validation');
                }
            } else {
                console.warn('⚠️ No frontend pricing data provided for validation');
            }
            
            // Get all current active enrollments for this member
            const enrollmentsRequest = transaction.request();
            enrollmentsRequest.input('memberId', sql.UniqueIdentifier, member.MemberId);
            
            const enrollmentsResult = await enrollmentsRequest.query(`
                SELECT 
                    e.EnrollmentId,
                    e.ProductId,
                    e.EffectiveDate,
                    e.PaymentFrequency,
                    e.Status
                FROM oe.Enrollments e
                WHERE e.MemberId = @memberId 
                  AND e.Status = 'Active'
            `);
            
            const currentEnrollments = enrollmentsResult.recordset;
            
            // Calculate termination dates for removed products
            const calculateTerminationDate = (effectiveDate, paymentFrequency) => {
                const effective = new Date(effectiveDate);
                
                // For monthly billing, calculate 1 month from the effective date
                if (paymentFrequency.toLowerCase().includes('monthly') || paymentFrequency.toLowerCase().includes('month')) {
                    const terminationDate = new Date(effective);
                    terminationDate.setMonth(terminationDate.getMonth() + 1);
                    
                    // Ensure we don't go backwards in time (shouldn't happen with proper effective dates)
                    const today = new Date();
                    if (terminationDate < today) {
                        console.log('⚠️ Warning: Calculated termination date is in the past, using effective date');
                        return effective;
                    }
                    
                    return terminationDate;
                }
                
                // For other frequencies, use the effective date as fallback
                return effective;
            };
            
            // Process removed products - set termination dates
            const removedEnrollments = currentEnrollments.filter(e => 
                removedProducts.includes(e.ProductId)
            );
            
            for (const enrollment of removedEnrollments) {
                const terminationDate = calculateTerminationDate(
                    enrollment.EffectiveDate, 
                    enrollment.PaymentFrequency
                );
                
                const updateRequest = transaction.request();
                updateRequest.input('enrollmentId', sql.UniqueIdentifier, enrollment.EnrollmentId);
                updateRequest.input('terminationDate', sql.Date, terminationDate);
                updateRequest.input('modifiedDate', sql.DateTime2, new Date());
                updateRequest.input('modifiedBy', sql.UniqueIdentifier, userId);
                
                await updateRequest.query(`
                    UPDATE oe.Enrollments 
                    SET TerminationDate = @terminationDate,
                        Status = 'Inactive',
                        ModifiedDate = @modifiedDate,
                        ModifiedBy = @modifiedBy
                    WHERE EnrollmentId = @enrollmentId
                `);
            }
            
            // Process new product enrollments and configuration changes
            // Include both new products and products with configuration changes
            const productsToEnroll = selectedProducts.filter(productId => 
                !removedProducts.includes(productId)
            );
            
            console.log(`🔍 Processing ${productsToEnroll.length} product enrollments (new + config changes):`, productsToEnroll);
            
            for (const productId of productsToEnroll) {
                // Check if product exists and is available
                const productRequest = transaction.request();
                productRequest.input('productId', sql.UniqueIdentifier, productId);
                productRequest.input('tenantId', sql.UniqueIdentifier, member.TenantId);
                
                const productResult = await productRequest.query(`
                    SELECT p.ProductId, p.Name, p.Status, tps.SubscriptionStatus, tps.IsConfigured
                    FROM oe.Products p
                    INNER JOIN oe.TenantProductSubscriptions tps ON p.ProductId = tps.ProductId
                    WHERE p.ProductId = @productId 
                      AND tps.TenantId = @tenantId
                      AND p.Status = 'Active'
                      AND tps.SubscriptionStatus = 'Active'
                      AND tps.IsConfigured = 1
                `);
                
                if (productResult.recordset.length === 0) {
                    console.warn(`⚠️ Product ${productId} not available for enrollment`);
                    continue;
                }
                
                const product = productResult.recordset[0];
                
                // Create new enrollment
                const enrollmentId = require('crypto').randomUUID();
                const configValue = configValues[productId] || null;
                
                // Calculate premium amount using frontend pricing if available
                let premiumAmount = 0;
                if (frontendPricing && Array.isArray(frontendPricing)) {
                    const frontendProduct = frontendPricing.find(fp => fp.productId === productId);
                    if (frontendProduct) {
                        premiumAmount = frontendProduct.monthlyPremium || 0;
                    }
                }
                
                const enrollmentDetails = {
                    enrollmentType: 'product_change',
                    addedBy: 'member',
                    notes: 'Product added via product change',
                    configuration: configValue,
                    effectiveDate: effectiveDate
                };
                
                const newEnrollmentRequest = transaction.request();
                newEnrollmentRequest.input('enrollmentId', sql.UniqueIdentifier, enrollmentId);
                newEnrollmentRequest.input('memberId', sql.UniqueIdentifier, member.MemberId);
                newEnrollmentRequest.input('productId', sql.UniqueIdentifier, productId);
                newEnrollmentRequest.input('agentId', sql.UniqueIdentifier, member.AgentId);
                newEnrollmentRequest.input('effectiveDate', sql.Date, effectiveDate || new Date());
                newEnrollmentRequest.input('premiumAmount', sql.Decimal(19,4), premiumAmount);
                newEnrollmentRequest.input('paymentFrequency', sql.NVarChar, 'Monthly');
                newEnrollmentRequest.input('enrollmentDetails', sql.NVarChar, JSON.stringify(enrollmentDetails));
                newEnrollmentRequest.input('createdBy', sql.UniqueIdentifier, userId);
                
                await newEnrollmentRequest.query(`
                    INSERT INTO oe.Enrollments 
                    (EnrollmentId, MemberId, ProductId, AgentId, Status, EffectiveDate, 
                     PremiumAmount, PaymentFrequency, EnrollmentDetails, CreatedDate, 
                     ModifiedDate, CreatedBy, ModifiedBy)
                    VALUES 
                    (@enrollmentId, @memberId, @productId, @agentId, 'Active', @effectiveDate,
                     @premiumAmount, @paymentFrequency, @enrollmentDetails, GETUTCDATE(), 
                     GETUTCDATE(), @createdBy, @createdBy)
                `);
                
                console.log(`✅ Created new enrollment ${enrollmentId} for product ${product.Name}`);
            }
            
            // Process configuration changes for remaining enrollments
            // For configuration changes, we terminate existing enrollments and create new ones
            if (configValues && Object.keys(configValues).length > 0) {
                for (const [productId, configValue] of Object.entries(configValues)) {
                    // Find enrollment for this product
                    const enrollment = currentEnrollments.find(e => 
                        e.ProductId === productId && 
                        !removedProducts.includes(productId)
                    );
                    
                    if (enrollment) {
                        console.log(`🔍 Terminating product ${productId} for configuration change:`, configValue);
                        
                        // Calculate termination date (next billing cycle)
                        const terminationDate = calculateTerminationDate(enrollment.EffectiveDate, enrollment.PaymentFrequency);
                        
                        const terminateRequest = transaction.request();
                        terminateRequest.input('enrollmentId', sql.UniqueIdentifier, enrollment.EnrollmentId);
                        terminateRequest.input('terminationDate', sql.Date, terminationDate);
                        terminateRequest.input('modifiedDate', sql.DateTime2, new Date());
                        terminateRequest.input('modifiedBy', sql.UniqueIdentifier, userId);
                        
                        await terminateRequest.query(`
                            UPDATE oe.Enrollments 
                            SET Status = 'Inactive',
                                TerminationDate = @terminationDate,
                                ModifiedDate = @modifiedDate,
                                ModifiedBy = @modifiedBy
                            WHERE EnrollmentId = @enrollmentId
                        `);
                        
                        console.log(`✅ Terminated ${enrollment.ProductName} for config change (terminates: ${terminationDate})`);
                    }
                }
            }
            
            await transaction.commit();
            
            console.log(`✅ Product changes processed for member ${member.MemberId}:`);
            console.log(`   - Removed ${removedEnrollments.length} products`);
            console.log(`   - Added ${productsToEnroll.length} products (new + config changes)`);
            console.log(`   - Terminated ${Object.keys(configValues || {}).length} products for config changes`);
            
            res.json({
                success: true,
                message: 'Product changes saved successfully',
                data: {
                    memberId: member.MemberId,
                    removedProducts: removedProducts.length,
                    addedProducts: productsToEnroll.length,
                    configChanges: Object.keys(configValues || {}).length,
                    terminationDates: removedEnrollments.map(e => ({
                        productId: e.ProductId,
                        enrollmentId: e.EnrollmentId,
                        terminationDate: calculateTerminationDate(e.EffectiveDate, e.PaymentFrequency)
                    })),
                    newEnrollments: productsToEnroll.map(productId => ({
                        productId: productId,
                        status: 'Active',
                        effectiveDate: effectiveDate || new Date()
                    }))
                }
            });
            
        } catch (error) {
            await transaction.rollback();
            throw error;
        }
        
    } catch (error) {
        console.error('❌ Error processing product changes:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to process product changes'
        });
    }
});

module.exports = router;
