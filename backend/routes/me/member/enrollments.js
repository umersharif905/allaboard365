const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../../../config/database');
const { authenticateUrls, authenticateProductDocumentsArray } = require('../../uploads');
const { getProductDocumentsForProductIds } = require('../../../services/shared/product-documents.service');
const { getUserRoles } = require('../../../middleware/auth');
const UserRolesService = require('../../../services/shared/user-roles.service');
const { resolveIDCardVariant } = require('../../../services/shared/idCardVariantResolver');
const { hydrateIdCardDataWithEnrollmentConfig } = require('../../../services/shared/idCardConfigHydration');
const { getEffectiveUserId } = require('../../../middleware/attachMemberHouseholdContext');

/**
 * GET /api/me/member/enrollments
 * Get current member's enrollments with product details
 */
router.get('/', async (req, res) => {
    try {
        const userId = getEffectiveUserId(req);
        const { filterStatus } = req.query;
        // filterStatus can be 'active', 'pending', or 'terminated'
        // If 'terminated', only return terminated enrollments
        // If 'pending', only return pending enrollments
        // Otherwise, return active enrollments (default behavior)
        console.log('🔍 GET /api/me/member/enrollments - UserId:', userId, 'filterStatus:', filterStatus);
        const pool = await getPool();
        
        // Get member's enrollments with product details and assets
        const request = pool.request();
        request.input('userId', sql.UniqueIdentifier, userId);
        
        // First check member status before proceeding
        const memberCheckRequest = pool.request();
        memberCheckRequest.input('userId', sql.UniqueIdentifier, userId);
        
        const memberCheckResult = await memberCheckRequest.query(`
            SELECT m.MemberId, m.Status as MemberStatus
            FROM oe.Members m
            JOIN oe.Users u ON m.UserId = u.UserId
            WHERE u.UserId = @userId
        `);
        
        if (memberCheckResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Member record not found. Please contact support.'
            });
        }
        
        const memberCheck = memberCheckResult.recordset[0];
        
        // Note: Allow terminated members to view their historical enrollment data
        // This enables them to access ID cards and plan information even after termination
        if (memberCheck.MemberStatus === 'Terminated') {
            console.log('⚠️ Member is terminated but allowing access to historical enrollment data');
        }
        
        // Check if member is inactive (but not terminated - terminated members can view historical data)
        if (memberCheck.MemberStatus !== 'Active' && memberCheck.MemberStatus !== 'Terminated') {
            return res.status(403).json({
                success: false,
                message: 'Your member account is currently inactive.',
                error: {
                    code: 'MEMBER_INACTIVE',
                    details: `Member account status: ${memberCheck.MemberStatus}`,
                    memberId: memberCheck.MemberId
                }
            });
        }
        
        // Build the WHERE clause conditionally based on filterStatus
        let statusFilter = '';
        if (filterStatus === 'terminated') {
            // Only return terminated enrollments (Status = 'Terminated' or 'Inactive', or Active with past termination date)
            // Also include enrollments that have been terminated (regardless of current status if termination date is in the past)
            statusFilter = `AND (
                e.Status = 'Terminated'
                OR e.Status = 'Inactive'
                OR (e.Status = 'Active' AND e.TerminationDate IS NOT NULL AND e.TerminationDate <= GETDATE())
                OR (e.TerminationDate IS NOT NULL AND e.TerminationDate <= GETDATE())
            )`;
            console.log('🔍 Filtering for terminated enrollments - will return Status = Terminated, Inactive, or any with past TerminationDate');
        } else if (filterStatus === 'pending') {
            // Only return pending enrollments
            statusFilter = `AND e.Status = 'Pending' AND e.TerminationDate IS NULL`;
        } else {
            // Default (active or undefined): only active enrollments (exclude terminated)
            statusFilter = `AND (
                (e.Status = 'Active' AND (e.TerminationDate IS NULL OR e.TerminationDate > GETDATE()))
                OR (e.Status = 'Pending' AND e.TerminationDate IS NULL)
            )`;
        }
        
        const query = `
            SELECT 
                e.EnrollmentId,
                e.MemberId,
                e.ProductId,
                e.Status,
                e.EffectiveDate,
                e.TerminationDate,
                e.PremiumAmount,
                e.IncludedPaymentProcessingFeeAmount,
                e.IncludedSystemFeeAmount,
                e.PaymentFrequency,
                e.EnrollmentDetails,
                e.CreatedDate,
                e.ModifiedDate,
                e.ProductBundleID,
                e.GroupID,
                e.EmployerContributionAmount,
                e.ContributionId,
                e.EnrollmentType,
                -- Product details with assets
                p.Name as ProductName,
                p.Description as ProductDescription,
                p.ProductType,
                p.ProductImageUrl,
                p.ProductLogoUrl,
                p.ProductDocumentUrl,
                p.CoverageDetails,
                p.Features,
                p.IDCardData,
                p.IDCardMemberIdPrefixMask,
                pb.IDCardMemberIdPrefixMask AS BundleIDCardMemberIdPrefixMask,
                ISNULL(mt.MemberIDPrefix, '') AS MemberTenantMemberIdPrefix,
                p.RequiredDataFields,
                p.PlanDetailsData,
                p.IsSSNRequired,
                p.VendorId as ProductVendorId,
                pv.VendorName as ProductVendorName,
                -- Product-level ID card vendor group ID settings (only when product uses vendor group IDs)
                p.EligibilityIndividualVendorGroupId as StaticGroupId,
                CASE
                    WHEN p.VendorGroupIdProductType IS NOT NULL
                        AND LTRIM(RTRIM(ISNULL(p.VendorGroupIdProductType, ''))) != ''
                        AND LTRIM(RTRIM(p.VendorGroupIdProductType)) != 'None'
                    THEN ISNULL(p.ShowGroupIdOnIDCard, 0)
                    ELSE 0
                END as ShowGroupIdOnIDCard,
                -- Bundle product details (if this enrollment is part of a bundle)
                pb.Name as BundleProductName,
                pb.Description as BundleProductDescription,
                pb.ProductType as BundleProductType,
                pb.ProductImageUrl as BundleProductImageUrl,
                pb.ProductLogoUrl as BundleProductLogoUrl,
                pb.ProductDocumentUrl as BundleProductDocumentUrl,
                pb.CoverageDetails as BundleCoverageDetails,
                pb.Features as BundleFeatures,
                pb.IDCardData as BundleIDCardData,
                pb.PlanDetailsData as BundlePlanDetailsData,
                pb.VendorId as BundleVendorId,
                bv.VendorName as BundleVendorName,
                -- Bundle relationship fields (from ProductBundles table)
                pbd.HidePricing,
                pbd.LinkedToProductId,
                -- Product Owner details
                po.Name as ProductOwnerName,
                po.ContactEmail as ProductOwnerEmail,
                -- Member details
                u.FirstName + ' ' + u.LastName as MemberName,
                -- Group vendor group ID (if member is in a group)
                gvgi.VendorGroupId as GroupVendorGroupId,
                -- Selected vendor network IDs (drives ID card variation).
                -- Group selection wins when member is in a group; otherwise fall back to
                -- the household's per-vendor selection for individual members.
                COALESCE(gvn.VendorNetworkId, hvn.VendorNetworkId) as GroupVendorNetworkId,
                COALESCE(gvnb.VendorNetworkId, hvnb.VendorNetworkId) as BundleGroupVendorNetworkId,
                -- Live config values from linked ProductPricing row. Preferred over EnrollmentDetails.configuration
                -- snapshot so an admin relabel (e.g. 3000 -> 2500) flows to existing enrollments on read.
                pp.ConfigValue1,
                pp.ConfigValue2,
                pp.ConfigValue3,
                pp.ConfigValue4,
                pp.ConfigValue5
            FROM oe.Enrollments e
            JOIN oe.Members m ON e.MemberId = m.MemberId
            JOIN oe.Users u ON m.UserId = u.UserId
            LEFT JOIN oe.Products p ON e.ProductId = p.ProductId
            LEFT JOIN oe.Tenants po ON p.ProductOwnerId = po.TenantId
            LEFT JOIN oe.Tenants mt ON m.TenantId = mt.TenantId
            LEFT JOIN oe.Vendors pv ON p.VendorId = pv.VendorId
            LEFT JOIN oe.Products pb ON e.ProductBundleID = pb.ProductId
            LEFT JOIN oe.Vendors bv ON pb.VendorId = bv.VendorId
            LEFT JOIN oe.ProductBundles pbd ON e.ProductBundleID = pbd.BundleProductId AND e.ProductId = pbd.IncludedProductId
            LEFT JOIN oe.ProductPricing pp ON e.ProductPricingId = pp.ProductPricingId
            -- Get group vendor group ID if member is in a group
            LEFT JOIN (
                SELECT 
                    vgi.GroupId,
                    vgi.VendorId,
                    vgi.VendorGroupId,
                    ROW_NUMBER() OVER (PARTITION BY vgi.GroupId, vgi.VendorId ORDER BY 
                        CASE WHEN vgi.ProductType = 'Master' THEN 0 ELSE 1 END,
                        vgi.CreatedDate DESC
                    ) as rn
                FROM oe.GroupProductVendorGroupIds vgi
                WHERE vgi.IsActive = 1
            ) gvgi ON m.GroupId = gvgi.GroupId AND p.VendorId = gvgi.VendorId AND gvgi.rn = 1
            -- Group's selected vendor network (drives ID card variation) - per product vendor and per bundle vendor
            LEFT JOIN oe.GroupVendorNetworks gvn  ON m.GroupId = gvn.GroupId  AND p.VendorId = gvn.VendorId  AND gvn.IsActive = 1
            LEFT JOIN oe.GroupVendorNetworks gvnb ON m.GroupId = gvnb.GroupId AND pb.VendorId = gvnb.VendorId AND gvnb.IsActive = 1
            -- Household's selected vendor network — only used when the member is NOT in a group.
            LEFT JOIN oe.HouseholdVendorNetworks hvn
                ON m.GroupId IS NULL AND m.HouseholdId = hvn.HouseholdId  AND p.VendorId  = hvn.VendorId  AND hvn.IsActive = 1
            LEFT JOIN oe.HouseholdVendorNetworks hvnb
                ON m.GroupId IS NULL AND m.HouseholdId = hvnb.HouseholdId AND pb.VendorId = hvnb.VendorId AND hvnb.IsActive = 1
            WHERE u.UserId = @userId
                AND (
                    (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
                    OR e.EnrollmentType = 'Contribution'
                    OR e.EnrollmentType = 'PaymentProcessingFee'
                    OR e.EnrollmentType = 'ProcessingFee'
                    OR e.EnrollmentType = 'SystemFee'
                )
                ${statusFilter}
            ORDER BY e.CreatedDate DESC
        `;
        
        const result = await request.query(query);
        console.log('🔍 Query result recordset length:', result.recordset.length);
        if (result.recordset.length > 0) {
            console.log('🔍 First enrollment:', result.recordset[0]);
        }
        
        // Fetch ProductDocuments for all product IDs and bundle product IDs
        const productIdsForDocs = [...new Set(
            result.recordset
                .flatMap((e) => [e.ProductId, e.ProductBundleID].filter(Boolean))
                .filter((id) => id && id !== '00000000-0000-0000-0000-000000000000')
        )];
        const productDocumentsMap = productIdsForDocs.length > 0
            ? await getProductDocumentsForProductIds(pool, productIdsForDocs, sql)
            : new Map();
        
        // Format the response with parsed JSON fields
        const enrollments = result.recordset.map(enrollment => {
            let productDocs = productDocumentsMap.get(enrollment.ProductId) || [];
            let bundleDocs = enrollment.ProductBundleID ? (productDocumentsMap.get(enrollment.ProductBundleID) || []) : [];
            if (productDocs.length === 0 && enrollment.ProductDocumentUrl && typeof enrollment.ProductDocumentUrl === 'string' && enrollment.ProductDocumentUrl.trim()) {
                productDocs = [{ documentUrl: enrollment.ProductDocumentUrl.trim(), displayName: 'Document', sortOrder: 0 }];
            }
            if (bundleDocs.length === 0 && enrollment.BundleProductDocumentUrl && typeof enrollment.BundleProductDocumentUrl === 'string' && enrollment.BundleProductDocumentUrl.trim()) {
                bundleDocs = [{ documentUrl: enrollment.BundleProductDocumentUrl.trim(), displayName: 'Document', sortOrder: 0 }];
            }

            let requiredDataFields = [];
            try {
                requiredDataFields = enrollment.RequiredDataFields
                    ? JSON.parse(enrollment.RequiredDataFields)
                    : [];
            } catch {
                requiredDataFields = [];
            }

            let idCardDataResolved = enrollment.IDCardData
                ? resolveIDCardVariant(JSON.parse(enrollment.IDCardData), enrollment.GroupVendorNetworkId)
                : null;
            const {
                data: idCardDataHydrated,
                idCardConfigurationDisplay,
                configurationShownInIdCardData
            } = hydrateIdCardDataWithEnrollmentConfig(idCardDataResolved, {
                requiredDataFields,
                configValue1: enrollment.ConfigValue1 ?? null,
                enrollmentDetails: enrollment.EnrollmentDetails
            });

            return {
            enrollmentId: enrollment.EnrollmentId,
            memberId: enrollment.MemberId,
            productId: enrollment.ProductId, // Can be '00000000-0000-0000-0000-000000000000' for all-products contributions
            status: enrollment.Status,
            effectiveDate: enrollment.EffectiveDate,
            terminationDate: enrollment.TerminationDate,
            premiumAmount: parseFloat(enrollment.PremiumAmount) || 0,
            includedPaymentProcessingFeeAmount: enrollment.IncludedPaymentProcessingFeeAmount != null ? (parseFloat(enrollment.IncludedPaymentProcessingFeeAmount) || 0) : 0,
            includedSystemFeeAmount: enrollment.IncludedSystemFeeAmount != null ? (parseFloat(enrollment.IncludedSystemFeeAmount) || 0) : 0,
            paymentFrequency: enrollment.PaymentFrequency,
            enrollmentDetails: enrollment.EnrollmentDetails,
            createdDate: enrollment.CreatedDate,
            modifiedDate: enrollment.ModifiedDate,
            productBundleID: enrollment.ProductBundleID,
            groupID: enrollment.GroupID,
            employerContributionAmount: parseFloat(enrollment.EmployerContributionAmount) || 0,
            contributionId: enrollment.ContributionId,
            enrollmentType: enrollment.EnrollmentType || 'Product', // Include enrollmentType (Product, Contribution, ProcessingFee, SystemFee)
            product: {
                productId: enrollment.ProductId,
                name: enrollment.ProductName,
                description: enrollment.ProductDescription,
                productType: enrollment.ProductType,
                vendorId: enrollment.ProductVendorId,
                vendorName: enrollment.ProductVendorName,
                productImageUrl: enrollment.ProductImageUrl,
                productLogoUrl: enrollment.ProductLogoUrl,
                productDocumentUrl: enrollment.ProductDocumentUrl,
                productDocuments: productDocs,
                coverageDetails: enrollment.CoverageDetails,
                features: enrollment.Features ? JSON.parse(enrollment.Features) : [],
                requiredDataFields,
                planDetailsData: enrollment.PlanDetailsData ? JSON.parse(enrollment.PlanDetailsData) : null,
                isSSNRequired: enrollment.IsSSNRequired === true || enrollment.IsSSNRequired === 1,
                productOwnerName: enrollment.ProductOwnerName,
                productOwnerEmail: enrollment.ProductOwnerEmail,
                idCardData: idCardDataHydrated,
                idCardMemberIdPrefixMask: enrollment.IDCardMemberIdPrefixMask ?? null,
                hidePricing: enrollment.HidePricing || false,
                linkedToProductId: enrollment.LinkedToProductId || null,
                staticGroupId: enrollment.StaticGroupId || null,
                showGroupIdOnIDCard: enrollment.ShowGroupIdOnIDCard === true || enrollment.ShowGroupIdOnIDCard === 1,
                groupId: enrollment.GroupVendorGroupId || enrollment.StaticGroupId || null
            },
            memberTenantMemberIdPrefix: enrollment.MemberTenantMemberIdPrefix ?? '',
            bundleProduct: enrollment.ProductBundleID && enrollment.BundleProductName ? {
                productId: enrollment.ProductBundleID,
                name: enrollment.BundleProductName,
                description: enrollment.BundleProductDescription,
                productType: enrollment.BundleProductType,
                vendorId: enrollment.BundleVendorId,
                vendorName: enrollment.BundleVendorName,
                productImageUrl: enrollment.BundleProductImageUrl,
                productLogoUrl: enrollment.BundleProductLogoUrl,
                productDocumentUrl: enrollment.BundleProductDocumentUrl,
                productDocuments: bundleDocs,
                coverageDetails: enrollment.BundleCoverageDetails,
                features: enrollment.BundleFeatures ? JSON.parse(enrollment.BundleFeatures) : [],
                planDetailsData: enrollment.BundlePlanDetailsData ? JSON.parse(enrollment.BundlePlanDetailsData) : null,
                idCardData: enrollment.BundleIDCardData
                    ? resolveIDCardVariant(JSON.parse(enrollment.BundleIDCardData), enrollment.BundleGroupVendorNetworkId)
                    : null,
                idCardMemberIdPrefixMask: enrollment.BundleIDCardMemberIdPrefixMask ?? null
            } : null,
            memberName: enrollment.MemberName,
            configValue1: enrollment.ConfigValue1 ?? null,
            configValue2: enrollment.ConfigValue2 ?? null,
            configValue3: enrollment.ConfigValue3 ?? null,
            configValue4: enrollment.ConfigValue4 ?? null,
            configValue5: enrollment.ConfigValue5 ?? null,
            configurationShownInIdCardData,
            idCardConfigurationDisplay
            };
        });
        
        console.log(`✅ Retrieved ${enrollments.length} enrollments for member ${userId}`);
        
        // Authenticate blob URLs for all enrollments
        console.log('🔐 Authenticating URLs for', enrollments.length, 'enrollments');
        console.log('🔍 Sample enrollment before authentication:', JSON.stringify(enrollments[0], null, 2));
        const authenticatedEnrollments = await Promise.all(
            enrollments.map(async (enrollment) => {
                if (enrollment.product) {
                    enrollment.product = await authenticateUrls(enrollment.product, ['productDocumentUrl']);
                    if (Array.isArray(enrollment.product.productDocuments) && enrollment.product.productDocuments.length > 0) {
                        enrollment.product.productDocuments = await authenticateProductDocumentsArray(enrollment.product.productDocuments);
                    }
                }
                if (enrollment.bundleProduct) {
                    enrollment.bundleProduct = await authenticateUrls(enrollment.bundleProduct, ['productDocumentUrl']);
                    if (Array.isArray(enrollment.bundleProduct.productDocuments) && enrollment.bundleProduct.productDocuments.length > 0) {
                        enrollment.bundleProduct.productDocuments = await authenticateProductDocumentsArray(enrollment.bundleProduct.productDocuments);
                    }
                }
                return enrollment;
            })
        );
        console.log('🔍 Sample enrollment after authentication:', JSON.stringify(authenticatedEnrollments[0], null, 2));
        console.log('✅ Authentication complete for enrollments');
        
        res.json({
            success: true,
            data: authenticatedEnrollments
        });
        
    } catch (error) {
        console.error('❌ Error fetching member enrollments:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch enrollments'
        });
    }
});

/**
 * POST /api/me/member/enrollments
 * Create new enrollment request (status = "Pending")
 */
router.post('/', async (req, res) => {
    try {
        const userId = getEffectiveUserId(req);
        const {
            productId,
            effectiveDate,
            paymentFrequency = 'Monthly',
            enrollmentDetails
        } = req.body;
        
        // Validation
        if (!productId || !effectiveDate) {
            return res.status(400).json({
                success: false,
                message: 'Product ID and effective date are required'
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
                SELECT m.MemberId, m.TenantId, m.GroupId, m.AgentId, m.HouseholdId, m.Status as MemberStatus,
                       u.FirstName, u.LastName
                FROM oe.Members m
                JOIN oe.Users u ON m.UserId = u.UserId
                WHERE m.UserId = @userId
            `);
            
            if (memberResult.recordset.length === 0) {
                await transaction.rollback();
                
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
                await transaction.rollback();
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
            
            // Validate product exists and is available to member's tenant
            const productRequest = transaction.request();
            productRequest.input('productId', sql.UniqueIdentifier, productId);
            productRequest.input('tenantId', sql.UniqueIdentifier, member.TenantId);
            
            const productResult = await productRequest.query(`
                SELECT p.ProductId, p.Name, p.PricingModel
                FROM oe.Products p
                JOIN oe.ProductSubscriptions ps ON p.ProductId = ps.ProductId
                WHERE p.ProductId = @productId 
                  AND p.Status = 'Active'
                  AND ps.TenantId = @tenantId
                  AND ps.Status = 'Active'
            `);
            
            if (productResult.recordset.length === 0) {
                await transaction.rollback();
                return res.status(404).json({
                    success: false,
                    message: 'Product not found or not available to your organization'
                });
            }
            
            // Check for existing active/pending enrollment
            const existingRequest = transaction.request();
            existingRequest.input('memberId', sql.UniqueIdentifier, member.MemberId);
            existingRequest.input('productId', sql.UniqueIdentifier, productId);
            
            const existingResult = await existingRequest.query(`
                SELECT EnrollmentId, Status
                FROM oe.Enrollments
                WHERE MemberId = @memberId 
                  AND ProductId = @productId 
                  AND Status IN ('Active', 'Pending')
            `);
            
            if (existingResult.recordset.length > 0) {
                await transaction.rollback();
                return res.status(409).json({
                    success: false,
                    message: `You already have a ${existingResult.recordset[0].Status.toLowerCase()} enrollment for this product`
                });
            }
            
            // Create enrollment request
            const enrollmentId = require('crypto').randomUUID();
            const enrollRequest = transaction.request();
            enrollRequest.input('enrollmentId', sql.UniqueIdentifier, enrollmentId);
            enrollRequest.input('memberId', sql.UniqueIdentifier, member.MemberId);
            enrollRequest.input('productId', sql.UniqueIdentifier, productId);
            enrollRequest.input('agentId', sql.UniqueIdentifier, member.AgentId);
            enrollRequest.input('effectiveDate', sql.Date, effectiveDate);
            enrollRequest.input('premiumAmount', sql.Decimal(19,4), 0); // Will be calculated during approval
            enrollRequest.input('paymentFrequency', sql.NVarChar, paymentFrequency);
            enrollRequest.input('enrollmentDetails', sql.NVarChar, enrollmentDetails || null);
            enrollRequest.input('createdBy', sql.UniqueIdentifier, userId);
            enrollRequest.input('householdId', sql.UniqueIdentifier, member.HouseholdId || null);
            // Pricing fields set to 0 for pending enrollment requests - will be populated upon approval/completion
            enrollRequest.input('netRate', sql.Decimal(19,4), 0);
            enrollRequest.input('overrideRate', sql.Decimal(19,4), 0);
            enrollRequest.input('commission', sql.Decimal(19,4), 0);
            enrollRequest.input('systemFees', sql.Decimal(19,4), 0);
            
            await enrollRequest.query(`
                INSERT INTO oe.Enrollments 
                (EnrollmentId, MemberId, ProductId, AgentId, Status, EffectiveDate, 
                 PremiumAmount, PaymentFrequency, EnrollmentDetails, HouseholdId, NetRate, OverrideRate, Commission, SystemFees,
                 CreatedDate, ModifiedDate, CreatedBy, ModifiedBy)
                VALUES 
                (@enrollmentId, @memberId, @productId, @agentId, 'Pending', @effectiveDate,
                 @premiumAmount, @paymentFrequency, @enrollmentDetails, @householdId, @netRate, @overrideRate, @commission, @systemFees,
                 GETUTCDATE(), GETUTCDATE(), @createdBy, @createdBy)
            `);
            
            await transaction.commit();
            
            console.log(`✅ Enrollment request created: ${enrollmentId} for member ${member.MemberId}`);
            
            res.status(201).json({
                success: true,
                message: 'Enrollment request submitted successfully. Pending approval.',
                data: {
                    enrollmentId,
                    status: 'Pending',
                    productName: productResult.recordset[0].Name,
                    memberName: `${member.FirstName} ${member.LastName}`
                }
            });
            
        } catch (error) {
            await transaction.rollback();
            throw error;
        }
        
    } catch (error) {
        console.error('❌ Error creating enrollment request:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create enrollment request'
        });
    }
});

/**
 * PUT /api/me/member/enrollments/:id/cancel
 * Cancel pending enrollment request
 */
router.put('/:id/cancel', async (req, res) => {
    try {
        const userId = getEffectiveUserId(req);
        const { id: enrollmentId } = req.params;
        
        const pool = await getPool();
        const request = pool.request();
        request.input('enrollmentId', sql.UniqueIdentifier, enrollmentId);
        request.input('userId', sql.UniqueIdentifier, userId);
        
        // Verify enrollment belongs to member and is pending
        const result = await request.query(`
            UPDATE e
            SET Status = 'Cancelled',
                ModifiedDate = GETUTCDATE(),
                ModifiedBy = @userId
            FROM oe.Enrollments e
            JOIN oe.Members m ON e.MemberId = m.MemberId
            JOIN oe.Users u ON m.UserId = u.UserId
            WHERE e.EnrollmentId = @enrollmentId
              AND u.UserId = @userId
              AND e.Status = 'Pending'
        `);
        
        if (result.rowsAffected[0] === 0) {
            return res.status(404).json({
                success: false,
                message: 'Enrollment not found or cannot be cancelled'
            });
        }
        
        console.log(`✅ Enrollment cancelled: ${enrollmentId} by member ${userId}`);
        
        res.json({
            success: true,
            message: 'Enrollment request cancelled successfully'
        });
        
    } catch (error) {
        console.error('❌ Error cancelling enrollment:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to cancel enrollment request'
        });
    }
});

module.exports = router;