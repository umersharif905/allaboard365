const express = require('express');
const router = express.Router();
const { getEffectiveUserId } = require('../../../middleware/attachMemberHouseholdContext');
const { getPool, sql } = require('../../../config/database');
const { authenticateUrls } = require('../../uploads');
const UserRolesService = require('../../../services/shared/user-roles.service');
const MemberProductsService = require('../../../services/shared/member-products.service');
const { buildMemberSsoUrl } = require('./memberSsoUrl');

/**
 * GET /api/me/member/products
 * Get products available to member based on their tenant's subscriptions
 */
router.get('/', async (req, res) => {
    console.log('🚀🚀🚀 PRODUCTS ENDPOINT HIT 🚀🚀🚀');
    try {
        console.log('🔍 req.user:', req.user);
        const userId = getEffectiveUserId(req);
        console.log(`🔍 UserId from auth: ${userId}`);
        const pool = await getPool();
        
        // Get member's tenant ID and current enrollments
        const memberRequest = pool.request();
        memberRequest.input('userId', sql.UniqueIdentifier, userId);
        
        console.log(`🔍 Looking up member for userId: ${userId}`);
        
        const memberResult = await memberRequest.query(`
            SELECT m.MemberId, m.TenantId, m.GroupId, m.Status as MemberStatus
            FROM oe.Members m
            JOIN oe.Users u ON m.UserId = u.UserId
            WHERE u.UserId = @userId
        `);
        
        console.log(`🔍 Member query returned ${memberResult.recordset.length} records`);
        if (memberResult.recordset.length > 0) {
            console.log(`🔍 Member found:`, memberResult.recordset[0]);
        }
        
        if (memberResult.recordset.length === 0) {
            console.log(`❌ No member record found for userId: ${userId}`);
            
            // Enhanced error handling - check if user exists and has Member role
            const userCheckRequest = pool.request();
            userCheckRequest.input('userId', sql.UniqueIdentifier, userId);
            
            const userCheckResult = await userCheckRequest.query(`
                SELECT UserId, Email, Status, TenantId, FirstName, LastName
                FROM oe.Users 
                WHERE UserId = @userId
            `);
            
            if (userCheckResult.recordset.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'User not found. Please contact support.'
                });
            }
            
            const user = userCheckResult.recordset[0];
            
            // Get user roles from UserRoles table
            const userRoles = await UserRolesService.getUserRoleNames(user.UserId);
            
            console.log(`🔍 User found but no member record:`, {
                userId: user.UserId,
                email: user.Email,
                roles: userRoles,
                status: user.Status
            });
            
            // Check if user has Member role
            const hasMemberRole = userRoles.includes('Member');
            
            if (!hasMemberRole) {
                return res.status(403).json({
                    success: false,
                    message: 'Access denied. Member role required.'
                });
            }
            
            if (user.Status !== 'Active') {
                return res.status(403).json({
                    success: false,
                    message: 'Account is inactive. Please contact support.'
                });
            }
            
            // User has Member role but no member record - this is a data integrity issue
            return res.status(500).json({
                success: false,
                message: 'Account setup incomplete. Please contact support to complete your member profile.',
                error: {
                    code: 'MISSING_MEMBER_RECORD',
                    details: 'User has Member role but no corresponding member record in database'
                }
            });
        }
        
        const member = memberResult.recordset[0];
        
        // Allow Active and Terminated members (terminated members can re-enroll)
        // Only block Declined or other inactive statuses
        if (member.MemberStatus !== 'Active' && member.MemberStatus !== 'Terminated') {
            console.log(`❌ Member account is inactive (${member.MemberStatus}) for userId: ${userId}`);
            return res.status(403).json({
                success: false,
                message: 'Your member account is currently inactive.',
                error: {
                    code: 'MEMBER_INACTIVE',
                    details: `Member account status: ${member.MemberStatus}`,
                    memberId: member.MemberId
                }
            });
        }
        
        console.log(`🔍 Member lookup for ${userId}:`, {
            memberId: member.MemberId,
            tenantId: member.TenantId,
            groupId: member.GroupId,
            isGroupMember: !!member.GroupId
        });
        
        // Get available products for member's tenant with enrollment status
        const productsRequest = pool.request();
        productsRequest.input('tenantId', sql.UniqueIdentifier, member.TenantId);
        productsRequest.input('memberId', sql.UniqueIdentifier, member.MemberId);
        productsRequest.input('groupId', sql.UniqueIdentifier, member.GroupId);
        
        // Build query based on whether member is in a group or not
        let groupFilter = '';
        if (member.GroupId) {
            // For group members, show products authorized for their group OR products they're already enrolled in
            groupFilter = `
                AND (
                    EXISTS (
                        SELECT 1 FROM oe.GroupProducts gp 
                        WHERE gp.GroupId = @groupId 
                          AND gp.ProductId = p.ProductId 
                          AND gp.IsActive = 1
                    )
                    OR EXISTS (
                        SELECT 1 FROM oe.Enrollments e 
                        WHERE e.ProductId = p.ProductId 
                          AND e.MemberId = @memberId 
                          AND e.Status IN ('Active', 'Pending')
                    )
                )
            `;
        }
        
        const query = `
            SELECT DISTINCT
                p.ProductId,
                p.Name,
                p.Description,
                p.ProductType,
                p.ProductImageUrl,
                p.ProductLogoUrl,
                p.ProductDocumentUrl,
                p.CoverageDetails,
                p.Features,
                p.MinAge,
                p.MaxAge,
                p.SalesType,
                p.RequiresTobaccoInfo,
                p.EffectiveDateLogic,
                p.MaxEffectiveDateDays,
                p.RequiredLicenses,
                p.RequiredDataFields,
                p.PlanDetailsData,
                p.AcknowledgementQuestions,
                p.IsBundle,
                -- Product Owner details
                po.Name as ProductOwnerName,
                po.ContactEmail as ProductOwnerEmail,
                -- Check if member is already enrolled
                CASE 
                    WHEN e.EnrollmentId IS NOT NULL THEN e.Status
                    ELSE NULL
                END as EnrollmentStatus,
                e.EnrollmentId as ExistingEnrollmentId,
                -- Use tenant's configured sale price (from TenantProductSubscriptions)
                ISNULL(tps.SalePrice, 0) as BasePrice,
                -- Subscription details
                tps.SubscriptionStatus,
                tps.IsConfigured,
                -- Per-product fee flags (for ZeroFeeForACH-aware preview in ProductChangeWizard)
                tps.IncludeProcessingFee,
                tps.RoundUpProcessingFee,
                tps.ZeroFeeForACH,
                tps.CustomSystemFeeEnabled,
                tps.CustomSystemFeeAmount,
                -- Group authorization info
                CASE 
                    WHEN @groupId IS NOT NULL THEN 
                        CASE WHEN gp.GroupProductId IS NOT NULL THEN 1 ELSE 0 END
                    ELSE 1
                END as IsGroupAuthorized
            FROM oe.TenantProductSubscriptions tps
            INNER JOIN oe.Products p ON tps.ProductId = p.ProductId
            LEFT JOIN oe.Tenants po ON p.ProductOwnerId = po.TenantId
            LEFT JOIN oe.Enrollments e ON p.ProductId = e.ProductId 
                AND e.MemberId = @memberId 
                AND e.Status IN ('Active', 'Pending')
            LEFT JOIN oe.GroupProducts gp ON p.ProductId = gp.ProductId 
                AND gp.GroupId = @groupId 
                AND gp.IsActive = 1
            WHERE tps.TenantId = @tenantId
              AND tps.SubscriptionStatus = 'Active'
              AND p.Status = 'Active'
              ${groupFilter}
            ORDER BY p.Name
        `;
        
        const result = await productsRequest.query(query);
        
        console.log(`🔍 Raw query returned ${result.recordset.length} products`);
        if (result.recordset.length > 0) {
            console.log('🔍 First product sample:', {
                productId: result.recordset[0].ProductId,
                name: result.recordset[0].Name,
                subscriptionStatus: result.recordset[0].SubscriptionStatus,
                isConfigured: result.recordset[0].IsConfigured
            });
        }
        
        // Format the response with parsed JSON fields and bundle support
        const products = await Promise.all(result.recordset.map(async (product) => {
            const baseProduct = {
                productId: product.ProductId,
                name: product.Name,
                description: product.Description,
                productType: product.ProductType,
                productImageUrl: product.ProductImageUrl,
                productLogoUrl: product.ProductLogoUrl,
                productDocumentUrl: product.ProductDocumentUrl,
                coverageDetails: product.CoverageDetails,
                features: product.Features ? JSON.parse(product.Features) : [],
                minAge: product.MinAge || 0,
                maxAge: product.MaxAge || 65,
                salesType: product.SalesType,
                requiresTobaccoInfo: product.RequiresTobaccoInfo || false,
                effectiveDateLogic: product.EffectiveDateLogic,
                maxEffectiveDateDays: product.MaxEffectiveDateDays || 60,
                requiredLicenses: product.RequiredLicenses ? JSON.parse(product.RequiredLicenses) : [],
                requiredDataFields: product.RequiredDataFields ? JSON.parse(product.RequiredDataFields) : [],
                planDetailsData: product.PlanDetailsData ? JSON.parse(product.PlanDetailsData) : null,
                acknowledgementQuestions: product.AcknowledgementQuestions ? JSON.parse(product.AcknowledgementQuestions) : [],
                productOwnerName: product.ProductOwnerName,
                productOwnerEmail: product.ProductOwnerEmail,
                basePrice: parseFloat(product.BasePrice) || 0,
                // Enrollment status
                isEnrolled: product.EnrollmentStatus !== null,
                enrollmentStatus: product.EnrollmentStatus,
                existingEnrollmentId: product.ExistingEnrollmentId,
                // Can enroll if no existing enrollment AND product is configured AND group authorized
                canEnroll: product.EnrollmentStatus === null && product.IsConfigured === 1 && product.IsGroupAuthorized === 1,
                // Subscription details
                subscriptionStatus: product.SubscriptionStatus,
                isConfigured: product.IsConfigured === 1,
                // Group authorization
                isGroupAuthorized: product.IsGroupAuthorized === 1,
                // Per-product fee flags — consumed by ProductChangeWizard's calculateCombinedFees so that
                // products with zeroFeeForACH show $0 ACH in the self-service plan-change preview.
                /** @deprecated Subscription include — authority ignores; see includedFeeDeprecation.js */
                includeProcessingFee: product.IncludeProcessingFee === true || product.IncludeProcessingFee === 1,
                roundUpProcessingFee: product.RoundUpProcessingFee === true || product.RoundUpProcessingFee === 1,
                zeroFeeForACH: product.ZeroFeeForACH === true || product.ZeroFeeForACH === 1,
                customSystemFeeEnabled: product.CustomSystemFeeEnabled === true || product.CustomSystemFeeEnabled === 1,
                customSystemFeeAmount: product.CustomSystemFeeAmount != null ? Number(product.CustomSystemFeeAmount) : null,
                // Bundle support
                isBundle: product.IsBundle === 1 || product.IsBundle === true
            };

            // If this is a bundle, get included products
            if (baseProduct.isBundle) {
                console.log(`🔍 Processing bundle product: ${product.Name}`);
                
                try {
                    // Get included products for this bundle
                    const bundleProductsQuery = `
                        SELECT 
                            pb.IncludedProductId,
                            pb.SortOrder,
                            pb.IsRequired,
                            pb.HidePricing,
                            pb.LinkedToProductId,
                            p.Name AS ProductName,
                            p.Description,
                            p.ProductType,
                            p.Status,
                            p.CoverageDetails,
                            p.PricingModel,
                            p.RequiredDataFields,
                            p.ProductDocumentUrl
                        FROM oe.ProductBundles pb
                        INNER JOIN oe.Products p ON pb.IncludedProductId = p.ProductId
                        WHERE pb.BundleProductId = @bundleProductId
                          AND p.Status = 'Active'
                        ORDER BY pb.SortOrder
                    `;
                    
                    const bundleRequest = pool.request();
                    bundleRequest.input('bundleProductId', sql.UniqueIdentifier, product.ProductId);
                    
                    const bundleResult = await bundleRequest.query(bundleProductsQuery);
                    const includedProducts = bundleResult.recordset;
                    
                    console.log(`🔍 Bundle ${product.Name} has ${includedProducts.length} included products`);
                    
                    // Process included products
                    const processedIncludedProducts = await Promise.all(includedProducts.map(async (includedProduct) => {
                        let includedRequiredDataFields = [];
                        try {
                            if (includedProduct.RequiredDataFields) {
                                includedRequiredDataFields = JSON.parse(includedProduct.RequiredDataFields);
                            }
                        } catch (e) {
                            console.warn(`Failed to parse RequiredDataFields for included product ${includedProduct.IncludedProductId}:`, e);
                        }
                        
                        const includedProductData = {
                            productId: includedProduct.IncludedProductId,
                            productName: includedProduct.ProductName,
                            description: includedProduct.Description,
                            productType: includedProduct.ProductType,
                            productDocumentUrl: includedProduct.ProductDocumentUrl,
                            monthlyPremium: 0, // Will be calculated by frontend pricing
                            requiredDataFields: includedRequiredDataFields,
                            isRequired: includedProduct.IsRequired === 1,
                            sortOrder: includedProduct.SortOrder,
                            hidePricing: includedProduct.HidePricing || false,
                            linkedToProductId: includedProduct.LinkedToProductId || null
                        };
                        
                        // Authenticate URLs for included products
                        return await authenticateUrls(includedProductData, ['productDocumentUrl']);
                    }));
                    
                    baseProduct.includedProducts = processedIncludedProducts;
                    console.log(`🔍 Bundle ${product.Name} processed with ${processedIncludedProducts.length} included products`);
                } catch (bundleError) {
                    console.error(`❌ Error processing bundle ${product.Name}:`, bundleError);
                    baseProduct.includedProducts = [];
                }
            }
            
            return baseProduct;
        }));
        
        console.log(`✅ Retrieved ${products.length} available products for member ${userId}`);
        console.log(`🔍 Group authorization filter applied: ${member.GroupId ? 'YES (group member)' : 'NO (individual member)'}`);
        console.log(`🔍 Products with group authorization: ${products.filter(p => p.isGroupAuthorized).length}/${products.length}`);
        
        // Authenticate blob URLs for all products
        console.log('🔐 Authenticating document URLs only for', products.length, 'member products');
        console.log('🔍 Sample product before authentication:', JSON.stringify(products[0], null, 2));
        const authenticatedProducts = await Promise.all(
            products.map(product => authenticateUrls(product, ['productDocumentUrl']))
        );
        console.log('🔍 Sample product after authentication:', JSON.stringify(authenticatedProducts[0], null, 2));
        console.log('✅ Authentication complete for member products (documents only)');
        
        res.json({
            success: true,
            data: authenticatedProducts
        });
        
    } catch (error) {
        console.error('❌ Error fetching member products:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch available products'
        });
    }
});

/**
 * GET /api/me/member/products/:id
 * Get detailed product information with assets
 */
router.get('/:id', async (req, res) => {
    try {
        const userId = getEffectiveUserId(req);
        const { id: productId } = req.params;
        const pool = await getPool();
        
        // Get member's tenant ID first
        const memberRequest = pool.request();
        memberRequest.input('userId', sql.UniqueIdentifier, userId);
        
        const memberResult = await memberRequest.query(`
            SELECT m.MemberId, m.TenantId
            FROM oe.Members m
            JOIN oe.Users u ON m.UserId = u.UserId
            WHERE u.UserId = @userId AND m.Status = 'Active'
        `);
        
        if (memberResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Member not found or inactive'
            });
        }
        
        const member = memberResult.recordset[0];
        
        // Get product details with access validation
        const productRequest = pool.request();
        productRequest.input('productId', sql.UniqueIdentifier, productId);
        productRequest.input('tenantId', sql.UniqueIdentifier, member.TenantId);
        productRequest.input('memberId', sql.UniqueIdentifier, member.MemberId);
        
        const query = `
            SELECT 
                p.ProductId,
                p.Name,
                p.Description,
                p.ProductType,
                p.ProductImageUrl,
                p.ProductLogoUrl,
                p.ProductDocumentUrl,
                p.CoverageDetails,
                p.Features,
                p.MinAge,
                p.MaxAge,
                p.SalesType,
                p.RequiresTobaccoInfo,
                p.EffectiveDateLogic,
                p.MaxEffectiveDateDays,
                p.TerminationLogic,
                p.RequiredLicenses,
                p.RequiredDataFields,
                p.PlanDetailsData,
                p.AcknowledgementQuestions,
                p.ContactDetails,
                -- Product Owner details
                po.Name as ProductOwnerName,
                po.ContactEmail as ProductOwnerEmail,
                -- Enrollment status
                e.Status as EnrollmentStatus,
                e.EnrollmentId as ExistingEnrollmentId,
                e.EffectiveDate as EnrollmentEffectiveDate,
                e.PremiumAmount as EnrollmentPremium,
                -- Subscription details
                tps.SalePrice as BasePrice,
                tps.SubscriptionStatus,
                tps.IsConfigured
            FROM oe.TenantProductSubscriptions tps
            INNER JOIN oe.Products p ON tps.ProductId = p.ProductId
            LEFT JOIN oe.Tenants po ON p.ProductOwnerId = po.TenantId
            LEFT JOIN oe.Enrollments e ON p.ProductId = e.ProductId 
                AND e.MemberId = @memberId 
                AND e.Status IN ('Active', 'Pending')
            WHERE p.ProductId = @productId
              AND tps.TenantId = @tenantId
              AND tps.SubscriptionStatus = 'Active'
              AND p.Status = 'Active'
        `;
        
        const result = await productRequest.query(query);
        
        if (result.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Product not found or not available to your organization'
            });
        }
        
        const productData = result.recordset[0];
        
        // Get pricing information
        const pricingRequest = pool.request();
        pricingRequest.input('productId', sql.UniqueIdentifier, productId);
        
        const pricingResult = await pricingRequest.query(`
            SELECT 
                PricingName,
                MSRPRate,
                MinAge,
                MaxAge,
                ConfigField1,
                ConfigField2,
                ConfigField3,
                ConfigValue1,
                ConfigValue2,
                ConfigValue3,
                EffectiveDate,
                TerminationDate
            FROM oe.ProductPricing
            WHERE ProductId = @productId 
              AND Status = 'Active'
              AND EffectiveDate <= GETDATE()
              AND (TerminationDate IS NULL OR TerminationDate > GETDATE())
            ORDER BY MSRPRate ASC
        `);
        
        // Format the response
        const product = {
            productId: productData.ProductId,
            name: productData.Name,
            description: productData.Description,
            productType: productData.ProductType,
            productImageUrl: productData.ProductImageUrl,
            productLogoUrl: productData.ProductLogoUrl,
            productDocumentUrl: productData.ProductDocumentUrl,
            coverageDetails: productData.CoverageDetails,
            features: productData.Features ? JSON.parse(productData.Features) : [],
            minAge: productData.MinAge || 0,
            maxAge: productData.MaxAge || 65,
            salesType: productData.SalesType,
            requiresTobaccoInfo: productData.RequiresTobaccoInfo || false,
            effectiveDateLogic: productData.EffectiveDateLogic,
            maxEffectiveDateDays: productData.MaxEffectiveDateDays || 60,
            terminationLogic: productData.TerminationLogic,
            requiredLicenses: productData.RequiredLicenses ? JSON.parse(productData.RequiredLicenses) : [],
            requiredDataFields: productData.RequiredDataFields ? JSON.parse(productData.RequiredDataFields) : [],
            planDetailsData: productData.PlanDetailsData ? JSON.parse(productData.PlanDetailsData) : null,
            acknowledgementQuestions: productData.AcknowledgementQuestions ? JSON.parse(productData.AcknowledgementQuestions) : [],
            contactDetails: productData.ContactDetails ? JSON.parse(productData.ContactDetails) : {},
            productOwnerName: productData.ProductOwnerName,
            productOwnerEmail: productData.ProductOwnerEmail,
            // Enrollment information
            enrollment: productData.EnrollmentStatus ? {
                status: productData.EnrollmentStatus,
                enrollmentId: productData.ExistingEnrollmentId,
                effectiveDate: productData.EnrollmentEffectiveDate,
                premium: parseFloat(productData.EnrollmentPremium) || 0
            } : null,
            // Pricing tiers
            pricing: pricingResult.recordset.map(pricing => ({
                name: pricing.PricingName,
                rate: parseFloat(pricing.MSRPRate),
                minAge: pricing.MinAge,
                maxAge: pricing.MaxAge,
                configuration: {
                    field1: pricing.ConfigField1,
                    field2: pricing.ConfigField2,
                    field3: pricing.ConfigField3,
                    value1: pricing.ConfigValue1,
                    value2: pricing.ConfigValue2,
                    value3: pricing.ConfigValue3
                },
                effectiveDate: pricing.EffectiveDate,
                terminationDate: pricing.TerminationDate
            })),
            // Subscription details
            basePrice: parseFloat(productData.BasePrice) || 0,
            subscriptionStatus: productData.SubscriptionStatus,
            isConfigured: productData.IsConfigured === 1,
            canEnroll: !productData.EnrollmentStatus && productData.IsConfigured === 1
        };
        
        console.log(`✅ Retrieved product details for ${productId} for member ${userId}`);
        
        // Authenticate only document URLs for product (images/logos are public)
        console.log('🔐 Authenticating document URLs for product:', product.name);
        const authenticatedProduct = await authenticateUrls(product, ['productDocumentUrl']);
        console.log('✅ Authentication complete for product (documents only)');
        
        res.json({
            success: true,
            data: authenticatedProduct
        });
        
    } catch (error) {
        console.error('❌ Error fetching product details:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch product details'
        });
    }
});

/**
 * POST /api/me/member/products/:id/sso-url
 * Get a ready-to-open SSO portal URL for the current member and product.
 * Requires: product has SSO enabled, member has active enrollment in the product.
 * Returns { url } for the client to open in browser/webview.
 */
router.post('/:id/sso-url', async (req, res) => {
    try {
        const userId = getEffectiveUserId(req);
        const { id: productId } = req.params;
        const pool = await getPool();

        const memberResult = await pool.request()
            .input('userId', sql.UniqueIdentifier, userId)
            .query(`
                SELECT m.MemberId, m.TenantId, m.HouseholdId, m.HouseholdMemberID, m.Tier, m.RelationshipType,
                       FORMAT(m.DateOfBirth, 'yyyy-MM-dd') as DateOfBirth,
                       m.Address, m.City, m.State, m.Zip, m.Gender,
                       u.FirstName, u.LastName, u.Email, u.PhoneNumber
                FROM oe.Members m
                JOIN oe.Users u ON m.UserId = u.UserId
                WHERE u.UserId = @userId AND m.Status IN ('Active', 'Terminated')
            `);
        if (memberResult.recordset.length === 0) {
            return res.status(404).json({ success: false, message: 'Member not found' });
        }
        const member = memberResult.recordset[0];

        const { url } = await buildMemberSsoUrl(pool, member, productId);
        res.json({ success: true, data: { url } });
    } catch (error) {
        if (error.code === 'NOT_ENROLLED') {
            return res.status(403).json({ success: false, message: error.message });
        }
        if (error.code === 'PRODUCT_NOT_FOUND') {
            return res.status(404).json({ success: false, message: error.message });
        }
        if (error.code === 'NO_SSO_CONFIG') {
            return res.status(400).json({ success: false, message: error.message });
        }
        console.error('❌ Member SSO URL error:', error);
        res.status(502).json({
            success: false,
            message: error.message || 'Failed to get portal URL'
        });
    }
});

/**
 * PUT /api/me/member/reactivate
 * Reactivate a terminated member account
 */
router.put('/reactivate', async (req, res) => {
    try {
        const userId = getEffectiveUserId(req);
        const pool = await getPool();
        
        // Get member information
        const memberRequest = pool.request();
        memberRequest.input('userId', sql.UniqueIdentifier, userId);
        
        const memberResult = await memberRequest.query(`
            SELECT m.MemberId, m.Status as MemberStatus, m.TenantId, m.GroupId
            FROM oe.Members m
            JOIN oe.Users u ON m.UserId = u.UserId
            WHERE u.UserId = @userId
        `);
        
        if (memberResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Member record not found'
            });
        }
        
        const member = memberResult.recordset[0];
        
        if (member.MemberStatus !== 'Terminated') {
            return res.status(400).json({
                success: false,
                message: 'Account is not terminated and cannot be reactivated'
            });
        }
        
        // Reactivate the member
        const updateRequest = pool.request();
        updateRequest.input('memberId', sql.UniqueIdentifier, member.MemberId);
        
        await updateRequest.query(`
            UPDATE oe.Members 
            SET Status = 'Active', 
                ModifiedDate = GETUTCDATE()
            WHERE MemberId = @memberId
        `);
        
        console.log(`✅ Member account reactivated: ${member.MemberId} for user ${userId}`);
        
        res.json({
            success: true,
            message: 'Your account has been reactivated successfully',
            data: {
                memberId: member.MemberId,
                status: 'Active'
            }
        });
        
    } catch (error) {
        console.error('❌ Error reactivating member account:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to reactivate account'
        });
    }
});

module.exports = router;