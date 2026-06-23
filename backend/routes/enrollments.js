const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/database');
const { getUserRoles } = require('../middleware/auth');
const { resolveIDCardVariant } = require('../services/shared/idCardVariantResolver');
const { hydrateIdCardDataWithEnrollmentConfig } = require('../services/shared/idCardConfigHydration');
const { getMemberPlanTenure } = require('../services/enrollments/planTenureService');
const { getProductDocumentsForProductIds } = require('../services/shared/product-documents.service');

// Authorization middleware
const authorize = (allowedRoles) => {
    return (req, res, next) => {
        const userRoles = getUserRoles(req.user);
        if (!allowedRoles.some(role => userRoles.includes(role))) {
            return res.status(403).json({
                success: false,
                message: 'Insufficient permissions',
                required: allowedRoles,
                current: userRoles
            });
        }
        next();
    };
};

// GET Enrollments - FIXED version
router.get('/', authorize(['SysAdmin', 'TenantAdmin', 'Agent', 'AgencyOwner', 'GroupAdmin', 'VendorAdmin', 'VendorAgent']), async (req, res) => {
    try {
        const { status = 'Active', memberId, productId } = req.query;

        const pool = await getPool();

        // Vendor roles may only query enrollments for members enrolled in their products.
        const userRoles = getUserRoles(req.user);
        const isVendorOnly =
            !userRoles.some((r) => ['SysAdmin', 'TenantAdmin', 'Agent', 'AgencyOwner', 'GroupAdmin'].includes(r)) &&
            userRoles.some((r) => r === 'VendorAdmin' || r === 'VendorAgent');
        if (isVendorOnly) {
            const vendorId = req.user.VendorId;
            if (!vendorId || !memberId) {
                return res.status(403).json({ success: false, message: 'Insufficient permissions' });
            }
            const guardResult = await pool.request()
                .input('memberId', sql.UniqueIdentifier, memberId)
                .input('vendorId', sql.UniqueIdentifier, vendorId)
                .query(`
                    SELECT TOP 1 m.MemberId
                    FROM oe.Members m
                    INNER JOIN oe.Enrollments e ON m.MemberId = e.MemberId
                    INNER JOIN oe.Products p ON e.ProductId = p.ProductId
                    WHERE m.MemberId = @memberId AND p.VendorId = @vendorId
                `);
            if (guardResult.recordset.length === 0) {
                return res.status(403).json({ success: false, message: 'Insufficient permissions' });
            }
        }
        
        let query = '';
        const request = pool.request();
        
        // If querying by memberId, we need a different approach to handle members with no enrollments
        if (memberId) {
            query = `
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
                    e.CreatedDate,
                    e.ProductBundleID,
                    e.EnrollmentDetails,
                    e.EnrollmentType,
                    e.ExternalAPISyncedAt,
                    e.ExternalAPIDeactivatedAt,
                    e.IsPendingMigration,
                    e.EmployerContributionAmount,
                    u.FirstName + ' ' + u.LastName as MemberName,
                    p.Name as ProductName,
                    p.Description as ProductDescription,
                    p.ProductType,
                    p.VendorId as ProductVendorId,
                    pv.VendorName as ProductVendorName,
                    p.ProductImageUrl,
                    p.ProductLogoUrl,
                    p.ProductDocumentUrl,
                    p.IDCardData,
                    p.IDCardMemberIdPrefixMask,
                    pb.IDCardMemberIdPrefixMask AS BundleIDCardMemberIdPrefixMask,
                    ISNULL(mt.MemberIDPrefix, '') AS MemberTenantMemberIdPrefix,
                    p.RequiredDataFields,
                    -- Product-level ID card vendor group ID settings (only when product uses vendor group IDs)
                    p.EligibilityIndividualVendorGroupId as StaticGroupId,
                    CASE
                        WHEN p.VendorGroupIdProductType IS NOT NULL
                            AND LTRIM(RTRIM(ISNULL(p.VendorGroupIdProductType, ''))) != ''
                            AND LTRIM(RTRIM(p.VendorGroupIdProductType)) != 'None'
                        THEN ISNULL(p.ShowGroupIdOnIDCard, 0)
                        ELSE 0
                    END as ShowGroupIdOnIDCard,
                    po.Name as ProductOwnerName,
                    -- Group vendor group ID (if member is in a group)
                    gvgi.VendorGroupId as GroupVendorGroupId,
                    -- Selected vendor network IDs (drives ID card variation).
                    -- Group selection wins when member is in a group; otherwise fall back to
                    -- the household's per-vendor selection for individual members.
                    COALESCE(gvn.VendorNetworkId, hvn.VendorNetworkId) as GroupVendorNetworkId,
                    COALESCE(gvnb.VendorNetworkId, hvnb.VendorNetworkId) as BundleGroupVendorNetworkId,
                    -- Bundle product details (if this enrollment is part of a bundle)
                    pb.Name as BundleProductName,
                    pb.Description as BundleProductDescription,
                    pb.ProductType as BundleProductType,
                    pb.VendorId as BundleVendorId,
                    bv.VendorName as BundleVendorName,
                    pb.ProductImageUrl as BundleProductImageUrl,
                    pb.ProductLogoUrl as BundleProductLogoUrl,
                    pb.ProductDocumentUrl as BundleProductDocumentUrl,
                    pb.IDCardData as BundleIDCardData,
                    -- Bundle relationship fields (from ProductBundles table)
                    pbd.HidePricing,
                    pbd.LinkedToProductId,
                    CASE WHEN pac.ProductId IS NOT NULL AND JSON_VALUE(pac.ConfigJson, '$.enrollment.enabled') = 'true' THEN 1 ELSE 0 END as HasProductAPIConfig,
                    pp.TierType as PricingTier,
                    -- Live config values from linked ProductPricing row. Preferred over EnrollmentDetails.configuration
                    -- snapshot so an admin relabel (e.g. 3000 -> 2500) flows to existing enrollments on read.
                    pp.ConfigValue1,
                    pp.ConfigValue2,
                    pp.ConfigValue3,
                    pp.ConfigValue4,
                    pp.ConfigValue5
                FROM oe.Members m
                JOIN oe.Users u ON m.UserId = u.UserId
                LEFT JOIN oe.Enrollments e ON e.MemberId = m.MemberId 
                    AND (e.Status = @status OR @status = 'all')
                    AND (e.EnrollmentType = 'Product' OR e.EnrollmentType = 'Contribution' OR e.EnrollmentType = 'PaymentProcessingFee' OR e.EnrollmentType = 'ProcessingFee' OR e.EnrollmentType = 'SystemFee' OR e.EnrollmentType IS NULL)
                    AND (e.EnrollmentType = 'Contribution' OR e.EnrollmentType = 'PaymentProcessingFee' OR e.EnrollmentType = 'ProcessingFee' OR e.EnrollmentType = 'SystemFee' OR e.ProductId != '00000000-0000-0000-0000-000000000000')
                LEFT JOIN oe.Products p ON e.ProductId = p.ProductId
                LEFT JOIN oe.Vendors pv ON p.VendorId = pv.VendorId
                LEFT JOIN oe.Tenants po ON p.ProductOwnerId = po.TenantId
                LEFT JOIN oe.Tenants mt ON m.TenantId = mt.TenantId
                LEFT JOIN oe.Products pb ON e.ProductBundleID = pb.ProductId
                LEFT JOIN oe.Vendors bv ON pb.VendorId = bv.VendorId
                LEFT JOIN oe.ProductBundles pbd ON e.ProductBundleID = pbd.BundleProductId AND e.ProductId = pbd.IncludedProductId
                LEFT JOIN oe.ProductAPIConfigs pac ON p.ProductId = pac.ProductId
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
                -- Group's selected vendor network (drives ID card variation)
                LEFT JOIN oe.GroupVendorNetworks gvn  ON m.GroupId = gvn.GroupId  AND p.VendorId = gvn.VendorId  AND gvn.IsActive = 1
                LEFT JOIN oe.GroupVendorNetworks gvnb ON m.GroupId = gvnb.GroupId AND pb.VendorId = gvnb.VendorId AND gvnb.IsActive = 1
                -- Household's selected vendor network — only used when the member is NOT in a group.
                LEFT JOIN oe.HouseholdVendorNetworks hvn
                    ON m.GroupId IS NULL AND m.HouseholdId = hvn.HouseholdId  AND p.VendorId  = hvn.VendorId  AND hvn.IsActive = 1
                LEFT JOIN oe.HouseholdVendorNetworks hvnb
                    ON m.GroupId IS NULL AND m.HouseholdId = hvnb.HouseholdId AND pb.VendorId = hvnb.VendorId AND hvnb.IsActive = 1
                WHERE m.MemberId = @memberId
            `;
            request.input('memberId', sql.UniqueIdentifier, memberId);
        } else {
            // Original query for general enrollment listing
            query = `
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
                    e.CreatedDate,
                    u.FirstName + ' ' + u.LastName as MemberName,
                    p.Name as ProductName, 
                    p.ProductType,
                    po.Name as ProductOwnerName
                FROM oe.Enrollments e
                JOIN oe.Members m ON e.MemberId = m.MemberId
                JOIN oe.Users u ON m.UserId = u.UserId
                JOIN oe.Products p ON e.ProductId = p.ProductId
                JOIN oe.Tenants po ON p.ProductOwnerId = po.TenantId
                WHERE (e.Status = @status OR @status = 'all')
                    AND (e.EnrollmentType = 'Product' OR e.EnrollmentType = 'Contribution' OR e.EnrollmentType IS NULL)
                    AND e.ProductId != '00000000-0000-0000-0000-000000000000'
            `;
        }
        
        request.input('status', sql.NVarChar, status);
        
        // Add tenant filtering for non-admin users.
        // Vendor-only users (VendorAdmin/VendorAgent) operate cross-tenant: their access is
        // already scoped by the vendor-product guard above, and migrated (pending-migration)
        // members frequently live under a different TenantId than the vendor user. Applying
        // a TenantId filter here would wrongly return zero enrollments for those members,
        // hiding their plans and ID cards in the vendor back office. Skip it for vendors.
        if (!getUserRoles(req.user).includes('SysAdmin') && !isVendorOnly) {
            query += ' AND m.TenantId = @tenantId';
            request.input('tenantId', sql.UniqueIdentifier, req.user.TenantId);
        }
        
        // Add group filtering for GroupAdmin users (when querying by memberId)
        if (req.user.currentRole === 'GroupAdmin' && memberId) {
            // Get GroupAdmin's group ID
            let userGroupId = req.user.GroupId || req.user.groupId;
            
            // If GroupId not in JWT, query from GroupAdmins table
            if (!userGroupId) {
                const groupIdQuery = `
                    SELECT GroupId 
                    FROM oe.GroupAdmins 
                    WHERE UserId = @userId AND Status = 'Active'
                `;
                const groupIdRequest = pool.request();
                groupIdRequest.input('userId', sql.UniqueIdentifier, req.user.UserId);
                const groupIdResult = await groupIdRequest.query(groupIdQuery);
                
                if (groupIdResult.recordset.length > 0 && groupIdResult.recordset[0].GroupId) {
                    userGroupId = groupIdResult.recordset[0].GroupId;
                }
            }
            
            if (userGroupId) {
                query += ' AND m.GroupId = @userGroupId';
                request.input('userGroupId', sql.UniqueIdentifier, userGroupId);
            } else {
                // GroupAdmin has no group assigned - deny access
                return res.status(403).json({
                    success: false,
                    message: 'Access denied: No group assigned',
                    code: 'NO_GROUP_ASSIGNED'
                });
            }
        }
        
        if (productId && !memberId) {
            query += ' AND e.ProductId = @productId';
            request.input('productId', sql.UniqueIdentifier, productId);
        }
        
        query += ' ORDER BY e.CreatedDate DESC';
        
        const result = await request.query(query);
        
        // Filter out null enrollment records (when member has no enrollments)
        const enrollments = result.recordset.filter(record => record.EnrollmentId !== null);

        // Attach oe.ProductDocuments rows (multi-document products). Fall back to legacy ProductDocumentUrl.
        const productIdsForDocs = [...new Set(
            enrollments
                .flatMap((e) => [e.ProductId, e.ProductBundleID].filter(Boolean))
                .filter((id) => id && id !== '00000000-0000-0000-0000-000000000000')
        )];
        const productDocumentsMap = productIdsForDocs.length > 0
            ? await getProductDocumentsForProductIds(pool, productIdsForDocs, sql)
            : new Map();

        for (const enrollment of enrollments) {
            let productDocs = productDocumentsMap.get(enrollment.ProductId) || [];
            let bundleDocs = enrollment.ProductBundleID
                ? (productDocumentsMap.get(enrollment.ProductBundleID) || [])
                : [];
            if (productDocs.length === 0 && enrollment.ProductDocumentUrl && typeof enrollment.ProductDocumentUrl === 'string' && enrollment.ProductDocumentUrl.trim()) {
                productDocs = [{ documentUrl: enrollment.ProductDocumentUrl.trim(), displayName: 'Document', sortOrder: 0 }];
            }
            if (bundleDocs.length === 0 && enrollment.BundleProductDocumentUrl && typeof enrollment.BundleProductDocumentUrl === 'string' && enrollment.BundleProductDocumentUrl.trim()) {
                bundleDocs = [{ documentUrl: enrollment.BundleProductDocumentUrl.trim(), displayName: 'Document', sortOrder: 0 }];
            }
            enrollment.ProductDocuments = productDocs;
            enrollment.BundleProductDocuments = bundleDocs;
        }

        // Resolve ID card variant per group's network selection (default fallback when none).
        // Mutating in place keeps the existing JSON-string contract (callers JSON.parse downstream).
        for (const enrollment of enrollments) {
            if (enrollment.IDCardData) {
                try {
                    const parsed = JSON.parse(enrollment.IDCardData);
                    const resolved = resolveIDCardVariant(parsed, enrollment.GroupVendorNetworkId);
                    let requiredDataFields = [];
                    try {
                        requiredDataFields = enrollment.RequiredDataFields
                            ? JSON.parse(enrollment.RequiredDataFields)
                            : [];
                    } catch {
                        requiredDataFields = [];
                    }
                    const {
                        data: hydratedCard,
                        idCardConfigurationDisplay,
                        configurationShownInIdCardData
                    } = hydrateIdCardDataWithEnrollmentConfig(resolved, {
                        requiredDataFields,
                        configValue1: enrollment.ConfigValue1 ?? null,
                        enrollmentDetails: enrollment.EnrollmentDetails
                    });
                    enrollment.IDCardData = JSON.stringify(hydratedCard);
                    enrollment.idCardConfigurationDisplay = idCardConfigurationDisplay;
                    enrollment.configurationShownInIdCardData = configurationShownInIdCardData;
                } catch (e) {
                    console.warn('⚠️ Failed to resolve IDCardData variant:', e.message);
                }
            }
            if (enrollment.BundleIDCardData) {
                try {
                    const parsedB = JSON.parse(enrollment.BundleIDCardData);
                    const resolvedB = resolveIDCardVariant(parsedB, enrollment.BundleGroupVendorNetworkId);
                    enrollment.BundleIDCardData = JSON.stringify(resolvedB);
                } catch (e) {
                    console.warn('⚠️ Failed to resolve BundleIDCardData variant:', e.message);
                }
            }
        }

        // Authenticate product document URLs (per backend-system.md - only documents, not images)
        const { authenticateUrls, authenticateProductDocumentsArray } = require('./uploads');
        const authenticatedEnrollments = await Promise.all(
            enrollments.map(async (enrollment) => {
                let authenticated = enrollment;
                if (authenticated.ProductDocumentUrl) {
                    try {
                        authenticated = await authenticateUrls(authenticated, ['ProductDocumentUrl']);
                    } catch (error) {
                        console.warn('⚠️ Failed to authenticate ProductDocumentUrl:', error.message);
                    }
                }
                if (authenticated.BundleProductDocumentUrl) {
                    try {
                        authenticated = await authenticateUrls(authenticated, ['BundleProductDocumentUrl']);
                    } catch (error) {
                        console.warn('⚠️ Failed to authenticate BundleProductDocumentUrl:', error.message);
                    }
                }
                if (Array.isArray(authenticated.ProductDocuments) && authenticated.ProductDocuments.length > 0) {
                    authenticated.ProductDocuments = await authenticateProductDocumentsArray(authenticated.ProductDocuments);
                }
                if (Array.isArray(authenticated.BundleProductDocuments) && authenticated.BundleProductDocuments.length > 0) {
                    authenticated.BundleProductDocuments = await authenticateProductDocumentsArray(authenticated.BundleProductDocuments);
                }
                return authenticated;
            })
        );
        
        res.json({ 
            success: true, 
            data: authenticatedEnrollments,
            enrollments: authenticatedEnrollments // Some frontend code expects this format
        });
        
    } catch (error) {
        console.error('❌ Error fetching enrollments:', error);
        console.error('Query details:', { memberId: req.query.memberId, status: req.query.status });
        res.status(500).json({ 
            success: false, 
            message: 'Failed to fetch enrollments',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// POST Enrollments - FIXED: Added 'Admin' role
router.post('/', authorize(['Admin', 'SysAdmin', 'TenantAdmin', 'Agent']), async (req, res) => {
    try {
        const {
            memberId,
            productId,
            effectiveDate,
            premium,
            paymentFrequency = 'Monthly'
        } = req.body;

        // Validation
        if (!memberId || !productId || !effectiveDate || !premium) {
            return res.status(400).json({
                success: false,
                message: 'Member ID, Product ID, effective date, and premium are required'
            });
        }

        const pool = await getPool();
        const transaction = pool.transaction();
        await transaction.begin();

        try {
            // Validate member and product exist and are accessible
            const validationRequest = transaction.request();
            validationRequest.input('memberId', sql.UniqueIdentifier, memberId);
            validationRequest.input('productId', sql.UniqueIdentifier, productId);
            
            let memberQuery = `
                SELECT m.MemberId, m.TenantId, m.HouseholdId, m.AgentId, u.FirstName, u.LastName
                FROM oe.Members m
                JOIN oe.Users u ON m.UserId = u.UserId
                WHERE m.MemberId = @memberId AND m.Status = 'Active'
            `;
            
            if (!getUserRoles(req.user).includes('SysAdmin')) {
                memberQuery += ' AND m.TenantId = @userTenantId';
                validationRequest.input('userTenantId', sql.UniqueIdentifier, req.user.TenantId);
            }

            const memberResult = await validationRequest.query(memberQuery);
            if (memberResult.recordset.length === 0) {
                await transaction.rollback();
                return res.status(404).json({
                    success: false,
                    message: 'Member not found or not accessible'
                });
            }
            
            const member = memberResult.recordset[0];

            const productResult = await validationRequest.query(`
                SELECT ProductId, Name FROM oe.Products 
                WHERE ProductId = @productId AND Status = 'Active'
            `);
            if (productResult.recordset.length === 0) {
                await transaction.rollback();
                return res.status(404).json({
                    success: false,
                    message: 'Product not found or not active'
                });
            }

            // Check for duplicate enrollment
            const duplicateResult = await validationRequest.query(`
                SELECT EnrollmentId FROM oe.Enrollments
                WHERE MemberId = @memberId AND ProductId = @productId AND Status IN ('Active', 'Pending')
            `);
            if (duplicateResult.recordset.length > 0) {
                await transaction.rollback();
                return res.status(409).json({
                    success: false,
                    message: 'Member is already enrolled in this product'
                });
            }

            // Create enrollment
            const enrollmentId = require('crypto').randomUUID();
            const enrollmentRequest = transaction.request();
            enrollmentRequest.input('enrollmentId', sql.UniqueIdentifier, enrollmentId);
            enrollmentRequest.input('memberId', sql.UniqueIdentifier, memberId);
            enrollmentRequest.input('productId', sql.UniqueIdentifier, productId);
            enrollmentRequest.input('agentId', sql.UniqueIdentifier, member.AgentId || null);
            enrollmentRequest.input('effectiveDate', sql.Date, effectiveDate);
            enrollmentRequest.input('premium', sql.Decimal(19,4), premium);
            enrollmentRequest.input('paymentFrequency', sql.NVarChar, paymentFrequency);
            enrollmentRequest.input('createdBy', sql.UniqueIdentifier, req.user.UserId);
            enrollmentRequest.input('householdId', sql.UniqueIdentifier, member.HouseholdId || null);
            // Pricing fields set to 0 for legacy endpoint - proper enrollment creation should use EnrollmentCompletionService
            enrollmentRequest.input('netRate', sql.Decimal(19,4), 0);
            enrollmentRequest.input('overrideRate', sql.Decimal(19,4), 0);
            enrollmentRequest.input('commission', sql.Decimal(19,4), 0);
            enrollmentRequest.input('systemFees', sql.Decimal(19,4), 0);

            await enrollmentRequest.query(`
                INSERT INTO oe.Enrollments 
                (EnrollmentId, MemberId, ProductId, AgentId, Status, EffectiveDate, 
                 PremiumAmount, PaymentFrequency, HouseholdId, NetRate, OverrideRate, Commission, SystemFees,
                 CreatedDate, ModifiedDate, CreatedBy, ModifiedBy)
                VALUES 
                (@enrollmentId, @memberId, @productId, @agentId, 'Active', @effectiveDate,
                 @premium, @paymentFrequency, @householdId, @netRate, @overrideRate, @commission, @systemFees,
                 GETDATE(), GETDATE(), @createdBy, @createdBy)
            `);

            await transaction.commit();

            res.status(201).json({
                success: true,
                message: 'Enrollment created successfully',
                data: {
                    enrollmentId,
                    memberName: `${member.FirstName} ${member.LastName}`,
                    productName: productResult.recordset[0].Name
                }
            });

            console.log(`✅ Enrollment created: ${enrollmentId}`);

        } catch (error) {
            await transaction.rollback();
            throw error;
        }

    } catch (error) {
        console.error('❌ Error creating enrollment:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create enrollment'
        });
    }
});

// GET /api/enrollments/tenure/:memberId
// Continuous-coverage plan tenure (issue #382). Returns { hasCoverage,
// tenureStartDate, daysOnPlan, chain } so Member Care can see the original
// effective date across plan-change rows.
router.get('/tenure/:memberId', authorize(['SysAdmin', 'TenantAdmin', 'Agent', 'AgencyOwner', 'GroupAdmin', 'VendorAdmin', 'VendorAgent']), async (req, res) => {
    try {
        const { memberId } = req.params;
        if (!memberId) {
            return res.status(400).json({ success: false, message: 'memberId required' });
        }

        const userRoles = getUserRoles(req.user);
        const isSysAdmin = userRoles.includes('SysAdmin');
        const isVendorOnly =
            !userRoles.some((r) => ['SysAdmin', 'TenantAdmin', 'Agent', 'AgencyOwner', 'GroupAdmin'].includes(r)) &&
            userRoles.some((r) => r === 'VendorAdmin' || r === 'VendorAgent');

        // Vendor-only users may only see tenure for members enrolled in one of
        // their products (mirrors the GET / guard in this file).
        if (isVendorOnly) {
            const vendorId = req.user.VendorId;
            if (!vendorId) {
                return res.status(403).json({ success: false, message: 'Insufficient permissions' });
            }
            const pool = await getPool();
            const guardResult = await pool.request()
                .input('memberId', sql.UniqueIdentifier, memberId)
                .input('vendorId', sql.UniqueIdentifier, vendorId)
                .query(`
                    SELECT TOP 1 m.MemberId
                    FROM oe.Members m
                    INNER JOIN oe.Enrollments e ON m.MemberId = e.MemberId
                    INNER JOIN oe.Products p ON e.ProductId = p.ProductId
                    WHERE m.MemberId = @memberId AND p.VendorId = @vendorId
                `);
            if (guardResult.recordset.length === 0) {
                return res.status(403).json({ success: false, message: 'Insufficient permissions' });
            }
        }

        // SysAdmin and vendor-only users are tenant-agnostic for this lookup.
        const skipTenantFilter = isSysAdmin || isVendorOnly;
        const tenantId = skipTenantFilter ? null : (req.tenantId || req.user?.TenantId);

        const tenure = await getMemberPlanTenure(memberId, tenantId);
        return res.json({ success: true, data: tenure });
    } catch (error) {
        console.error('❌ Error computing plan tenure:', error);
        return res.status(500).json({ success: false, message: 'Failed to compute plan tenure' });
    }
});

module.exports = router;
