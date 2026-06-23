/**
 * UNIFIED MEMBER PRODUCTS SERVICE
 * 
 * Shared functions for getting member-available products
 * Used by multiple endpoints:
 * - /api/me/member/products (Member role)
 * - /api/members/:memberId/products (Admin/Agent roles)
 */

const { getPool, sql } = require('../../config/database');
const { authenticateUrls, authenticateProductDocumentsArray } = require('../../routes/uploads');
const { getProductDocumentsForProductIds } = require('./product-documents.service');

class MemberProductsService {
  /**
   * Get products available to a specific member
   * @param {string} memberId - The member's ID
   * @param {string} tenantId - The member's tenant ID (for security filtering)
   * @returns {Promise<Array>} Array of available products
   */
  static async getAvailableProducts(memberId, tenantId) {
    try {
      const pool = await getPool();

      // Get member details for product authorization
      const memberRequest = pool.request();
      memberRequest.input('memberId', sql.UniqueIdentifier, memberId);
      
      const memberResult = await memberRequest.query(`
        SELECT 
          m.MemberId,
          m.GroupId,
          m.TenantId,
          m.Status,
          m.State,
          m.RelationshipType,
          m.DateOfBirth,
          g.Name as GroupName
        FROM oe.Members m
        LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId
        WHERE m.MemberId = @memberId
      `);

      if (memberResult.recordset.length === 0) {
        throw new Error('Member not found');
      }

      const member = memberResult.recordset[0];

      // Security: Verify tenant access
      if (member.TenantId !== tenantId) {
        throw new Error('Access denied: Member belongs to different tenant');
      }

      // Get products available to this member
      // Use the same query pattern as /api/me/member/products for consistency
      const productsRequest = pool.request();
      productsRequest.input('tenantId', sql.UniqueIdentifier, member.TenantId);
      productsRequest.input('memberId', sql.UniqueIdentifier, memberId);
      productsRequest.input('groupId', sql.UniqueIdentifier, member.GroupId);

      // Build group filter if member is in a group
      let groupFilter = '';
      if (member.GroupId) {
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

      const productsQuery = `
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
          -- Use tenant's configured sale price
          ISNULL(tps.SalePrice, 0) as BasePrice,
          -- Subscription details
          tps.SubscriptionStatus,
          tps.IsConfigured,
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

      const productsResult = await productsRequest.query(productsQuery);
      const mainProductIds = productsResult.recordset.map((p) => p.ProductId).filter(Boolean);
      const productDocumentsMap = mainProductIds.length > 0 ? await getProductDocumentsForProductIds(pool, mainProductIds, sql) : new Map();

      // Transform and authenticate URLs (matching /api/me/member/products format)
      const products = await Promise.all(
        productsResult.recordset.map(async (product) => {
          let rawProductDocs = productDocumentsMap.get(product.ProductId) || [];
          if (rawProductDocs.length === 0 && product.ProductDocumentUrl && typeof product.ProductDocumentUrl === 'string' && product.ProductDocumentUrl.trim()) {
            rawProductDocs = [{ documentUrl: product.ProductDocumentUrl.trim(), displayName: 'Document', sortOrder: 0 }];
          }
          const baseProduct = {
            productId: product.ProductId,
            name: product.Name,
            description: product.Description,
            productType: product.ProductType,
            productImageUrl: product.ProductImageUrl,
            productLogoUrl: product.ProductLogoUrl,
            productDocumentUrl: product.ProductDocumentUrl,
            productDocuments: rawProductDocs,
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
            acknowledgementQuestions: product.AcknowledgementQuestions ? JSON.parse(product.AcknowledgementQuestions) : [],
            productOwnerName: product.ProductOwnerName,
            productOwnerEmail: product.ProductOwnerEmail,
            basePrice: parseFloat(product.BasePrice) || 0,
            // Enrollment status
            isEnrolled: product.EnrollmentStatus !== null,
            enrollmentStatus: product.EnrollmentStatus,
            existingEnrollmentId: product.ExistingEnrollmentId,
            canEnroll: product.EnrollmentStatus === null && product.IsConfigured === 1 && product.IsGroupAuthorized === 1,
            subscriptionStatus: product.SubscriptionStatus,
            isConfigured: product.IsConfigured === 1,
            isGroupAuthorized: product.IsGroupAuthorized === 1,
            isBundle: product.IsBundle === 1 || product.IsBundle === true
          };

          // If this is a bundle, get included products
          if (baseProduct.isBundle) {
            try {
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
              
              const processedIncludedProducts = await Promise.all(bundleResult.recordset.map(async (includedProduct) => {
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
                  monthlyPremium: 0,
                  requiredDataFields: includedRequiredDataFields,
                  isRequired: includedProduct.IsRequired === 1,
                  sortOrder: includedProduct.SortOrder,
                  hidePricing: includedProduct.HidePricing || false,
                  linkedToProductId: includedProduct.LinkedToProductId || null
                };
                
                return await authenticateUrls(includedProductData, ['productDocumentUrl']);
              }));
              
              baseProduct.includedProducts = processedIncludedProducts;
            } catch (bundleError) {
              console.error(`❌ Error processing bundle ${product.Name}:`, bundleError);
              baseProduct.includedProducts = [];
            }
          }

          // Authenticate document URLs and productDocuments array
          const authenticated = await authenticateUrls(baseProduct, ['productDocumentUrl']);
          if (authenticated.productDocuments && authenticated.productDocuments.length > 0) {
            authenticated.productDocuments = await authenticateProductDocumentsArray(authenticated.productDocuments);
          }
          return authenticated;
        })
      );

      console.log(`✅ Found ${products.length} products available to member ${memberId}`);
      return products;

    } catch (error) {
      console.error('❌ Error in getAvailableProducts:', error);
      throw error;
    }
  }

  /**
   * Get member's current enrollments
   * @param {string} memberId - The member's ID
   * @param {string} tenantId - The member's tenant ID (for security filtering)
   * @returns {Promise<Array>} Array of member enrollments with product details
   */
  static async getMemberEnrollments(memberId, tenantId) {
    try {
      const pool = await getPool();

      const request = pool.request();
      request.input('memberId', sql.UniqueIdentifier, memberId);

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
          -- Product details
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
          ISNULL(ten.MemberIDPrefix, '') AS MemberTenantMemberIdPrefix,
          -- Bundle product details
          pb.Name as BundleProductName,
          pb.Description as BundleProductDescription,
          pb.ProductType as BundleProductType,
          pb.ProductImageUrl as BundleProductImageUrl,
          pb.ProductLogoUrl as BundleProductLogoUrl,
          pb.ProductDocumentUrl as BundleProductDocumentUrl,
          pb.CoverageDetails as BundleCoverageDetails,
          pb.Features as BundleFeatures,
          pb.IDCardData as BundleIDCardData,
          -- Product Owner details
          po.Name as ProductOwnerName,
          po.ContactEmail as ProductOwnerEmail,
          -- Member details
          u.FirstName + ' ' + u.LastName as MemberName
        FROM oe.Enrollments e
        JOIN oe.Members m ON e.MemberId = m.MemberId
        JOIN oe.Users u ON m.UserId = u.UserId
        JOIN oe.Products p ON e.ProductId = p.ProductId
        LEFT JOIN oe.Tenants po ON p.ProductOwnerId = po.TenantId
        LEFT JOIN oe.Products pb ON e.ProductBundleID = pb.ProductId
        LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId
        WHERE e.MemberId = @memberId
            AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
            AND e.ProductId != '00000000-0000-0000-0000-000000000000'
        ORDER BY e.CreatedDate DESC
      `;

      const result = await request.query(query);

      // Security: Verify tenant access
      if (result.recordset.length > 0) {
        const enrollmentTenantId = result.recordset[0].TenantId;
        if (enrollmentTenantId && enrollmentTenantId !== tenantId) {
          throw new Error('Access denied: Member belongs to different tenant');
        }
      }

      const productIdsForDocs = [...new Set(
        result.recordset.flatMap((e) => [e.ProductId, e.ProductBundleID].filter(Boolean)).filter((id) => id && id !== '00000000-0000-0000-0000-000000000000')
      )];
      const productDocumentsMap = productIdsForDocs.length > 0 ? await getProductDocumentsForProductIds(pool, productIdsForDocs, sql) : new Map();

      // Transform and authenticate URLs
      const enrollments = await Promise.all(
        result.recordset.map(async (enrollment) => {
          let productDocs = productDocumentsMap.get(enrollment.ProductId) || [];
          let bundleDocs = enrollment.ProductBundleID ? (productDocumentsMap.get(enrollment.ProductBundleID) || []) : [];
          if (productDocs.length === 0 && enrollment.ProductDocumentUrl && typeof enrollment.ProductDocumentUrl === 'string' && enrollment.ProductDocumentUrl.trim()) {
            productDocs = [{ documentUrl: enrollment.ProductDocumentUrl.trim(), displayName: 'Document', sortOrder: 0 }];
          }
          if (bundleDocs.length === 0 && enrollment.BundleProductDocumentUrl && typeof enrollment.BundleProductDocumentUrl === 'string' && enrollment.BundleProductDocumentUrl.trim()) {
            bundleDocs = [{ documentUrl: enrollment.BundleProductDocumentUrl.trim(), displayName: 'Document', sortOrder: 0 }];
          }
          const authenticatedEnrollment = {
            ...enrollment,
            ProductDocumentUrl: enrollment.ProductDocumentUrl,
            BundleProductDocumentUrl: enrollment.BundleProductDocumentUrl
          };

          await authenticateUrls(authenticatedEnrollment, ['ProductDocumentUrl', 'BundleProductDocumentUrl']);
          const authProductDocs = productDocs.length > 0 ? await authenticateProductDocumentsArray(productDocs) : [];
          const authBundleDocs = bundleDocs.length > 0 ? await authenticateProductDocumentsArray(bundleDocs) : [];

          return {
            enrollmentId: authenticatedEnrollment.EnrollmentId,
            memberId: authenticatedEnrollment.MemberId,
            productId: authenticatedEnrollment.ProductId,
            status: authenticatedEnrollment.Status,
            effectiveDate: authenticatedEnrollment.EffectiveDate,
            terminationDate: authenticatedEnrollment.TerminationDate,
            premiumAmount: authenticatedEnrollment.PremiumAmount,
            includedPaymentProcessingFeeAmount: authenticatedEnrollment.IncludedPaymentProcessingFeeAmount != null ? Number(authenticatedEnrollment.IncludedPaymentProcessingFeeAmount) : 0,
            includedSystemFeeAmount: authenticatedEnrollment.IncludedSystemFeeAmount != null ? Number(authenticatedEnrollment.IncludedSystemFeeAmount) : 0,
            paymentFrequency: authenticatedEnrollment.PaymentFrequency,
            enrollmentDetails: authenticatedEnrollment.EnrollmentDetails,
            createdDate: authenticatedEnrollment.CreatedDate,
            modifiedDate: authenticatedEnrollment.ModifiedDate,
            productBundleID: authenticatedEnrollment.ProductBundleID,
            groupID: authenticatedEnrollment.GroupID,
            memberName: authenticatedEnrollment.MemberName,
            memberTenantMemberIdPrefix: authenticatedEnrollment.MemberTenantMemberIdPrefix ?? '',
            product: {
              productId: authenticatedEnrollment.ProductId,
              name: authenticatedEnrollment.ProductName,
              description: authenticatedEnrollment.ProductDescription,
              productType: authenticatedEnrollment.ProductType,
              productImageUrl: authenticatedEnrollment.ProductImageUrl,
              productLogoUrl: authenticatedEnrollment.ProductLogoUrl,
              productDocumentUrl: authenticatedEnrollment.ProductDocumentUrl,
              productDocuments: authProductDocs,
              coverageDetails: authenticatedEnrollment.CoverageDetails,
              features: authenticatedEnrollment.Features ? JSON.parse(authenticatedEnrollment.Features) : [],
              productOwnerName: authenticatedEnrollment.ProductOwnerName,
              productOwnerEmail: authenticatedEnrollment.ProductOwnerEmail,
              idCardData: authenticatedEnrollment.IDCardData ? JSON.parse(authenticatedEnrollment.IDCardData) : null,
              idCardMemberIdPrefixMask: authenticatedEnrollment.IDCardMemberIdPrefixMask ?? null
            },
            bundleProduct: authenticatedEnrollment.BundleProductName ? {
              productId: authenticatedEnrollment.ProductBundleID,
              name: authenticatedEnrollment.BundleProductName,
              description: authenticatedEnrollment.BundleProductDescription,
              productType: authenticatedEnrollment.BundleProductType,
              productImageUrl: authenticatedEnrollment.BundleProductImageUrl,
              productLogoUrl: authenticatedEnrollment.BundleProductLogoUrl,
              productDocumentUrl: authenticatedEnrollment.BundleProductDocumentUrl,
              productDocuments: authBundleDocs,
              coverageDetails: authenticatedEnrollment.BundleCoverageDetails,
              features: authenticatedEnrollment.BundleFeatures ? JSON.parse(authenticatedEnrollment.BundleFeatures) : [],
              idCardData: authenticatedEnrollment.BundleIDCardData ? JSON.parse(authenticatedEnrollment.BundleIDCardData) : null,
              idCardMemberIdPrefixMask: authenticatedEnrollment.BundleIDCardMemberIdPrefixMask ?? null
            } : undefined
          };
        })
      );

      console.log(`✅ Found ${enrollments.length} enrollments for member ${memberId}`);
      return enrollments;

    } catch (error) {
      console.error('❌ Error in getMemberEnrollments:', error);
      throw error;
    }
  }

  /**
   * Get member profile data for pricing calculations
   * @param {string} memberId - The member's ID
   * @param {string} tenantId - The member's tenant ID (for security filtering)
   * @returns {Promise<Object>} Member profile data
   */
  static async getMemberProfile(memberId, tenantId) {
    try {
      const pool = await getPool();

      const request = pool.request();
      request.input('memberId', sql.UniqueIdentifier, memberId);

      // Use same query pattern as /api/me/member/profile
      const query = `
        SELECT 
          m.MemberId as Id,
          u.FirstName,
          u.LastName,
          u.Email,
          u.PhoneNumber as Phone,
          m.Address,
          m.City,
          m.State,
          m.Zip as ZipCode,
          m.Status as MemberStatus,
          m.DateOfBirth,
          m.Gender,
          m.TobaccoUse,
          m.Tier,
          m.RelationshipType,
          m.JobPosition,
          m.HouseholdId,
          DATEDIFF(YEAR, m.DateOfBirth, GETDATE()) as Age,
          m.CreatedDate as EnrollmentDate,
          m.GroupId,
          m.TenantId,
          m.AgentId,
          CASE WHEN g.GroupId IS NOT NULL THEN 'LB' ELSE 'SB' END as BillType,
          g.Name as GroupName,
          (SELECT COUNT(*) FROM oe.Members hm WHERE hm.HouseholdId = m.HouseholdId) as HouseholdSize
        FROM oe.Members m
        LEFT JOIN oe.Users u ON m.UserId = u.UserId
        LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId
        WHERE m.MemberId = @memberId
      `;

      const result = await request.query(query);

      if (result.recordset.length === 0) {
        throw new Error('Member not found');
      }

      const memberData = result.recordset[0];

      // Security: Verify tenant access
      if (memberData.TenantId !== tenantId) {
        throw new Error('Access denied: Member belongs to different tenant');
      }

      // Transform to match API response format (camelCase)
      return {
        id: memberData.Id,
        firstName: memberData.FirstName,
        lastName: memberData.LastName,
        email: memberData.Email,
        phone: memberData.Phone || '',
        address: memberData.Address || '',
        city: memberData.City || '',
        state: memberData.State || '',
        zipCode: memberData.ZipCode || '',
        zip: memberData.ZipCode || '', // Include both for compatibility
        memberStatus: memberData.MemberStatus || '',
        dateOfBirth: memberData.DateOfBirth,
        gender: memberData.Gender,
        tobaccoUse: memberData.TobaccoUse || 'No',
        tier: memberData.Tier || 'EE',
        relationshipType: memberData.RelationshipType || 'P',
        jobPosition: memberData.JobPosition || null,
        age: memberData.Age || 35,
        enrollmentDate: memberData.EnrollmentDate,
        groupId: memberData.GroupId,
        tenantId: memberData.TenantId,
        agentId: memberData.AgentId,
        billType: memberData.BillType || 'SB',
        groupName: memberData.GroupName || null,
        householdId: memberData.HouseholdId,
        householdSize: memberData.HouseholdSize || 1
      };

    } catch (error) {
      console.error('❌ Error in getMemberProfile:', error);
      throw error;
    }
  }
}

module.exports = MemberProductsService;

