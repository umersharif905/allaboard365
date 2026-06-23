const express = require('express');
const router = express.Router();
const { getEffectiveUserId } = require('../../../middleware/attachMemberHouseholdContext');
const { getPool, sql } = require('../../../config/database');
const { authorize } = require('../../../middleware/auth');
const { generateAuthenticatedUrl, isBlobUrl } = require('../../uploads');

// GET /api/me/member/documents - Get member's signed agreements (enrollment acknowledgements only)
router.get('/', authorize(['Member']), async (req, res) => {
  try {
    console.log('📄 GET /api/me/member/documents - Fetching member documents');
    
    const pool = await getPool();
    const request = pool.request();
    
    // Get member's basic info - Allow Active and Terminated members (terminated members can view historical documents)
    const memberQuery = `
      SELECT 
        m.MemberId,
        u.FirstName,
        u.LastName,
        u.Email
      FROM oe.Members m
      INNER JOIN oe.Users u ON m.UserId = u.UserId
      WHERE m.UserId = @userId AND m.Status IN ('Active', 'Terminated')
    `;
    
    request.input('userId', sql.UniqueIdentifier, getEffectiveUserId(req));
    
    const memberResult = await request.query(memberQuery);
    
    if (memberResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Member not found'
      });
    }
    
    const member = memberResult.recordset[0];
    
    // Get signed agreements (acknowledgements) from oe.EnrollmentAcknowledgements table
    // Include enrollment information to show plan history, status, and balance
    // Group by FileUploadId to avoid showing duplicate PDFs (multiple acknowledgements share same PDF)
    const acknowledgementsQuery = `
      SELECT 
        MIN(ea.AcknowledgementId) AS AcknowledgementId,
        ea.LinkToken,
        MIN(ea.SignedDate) AS SignedDate,
        COUNT(ea.AcknowledgementId) AS AcknowledgementCount,
        f.FileId,
        f.FileName,
        f.FilePath,
        f.FileSize,
        f.MimeType,
        f.Category,
        f.Description,
        f.CreatedDate,
        -- Get enrollment information via LinkToken
        MAX(e.Status) AS EnrollmentStatus,
        MAX(e.TerminationDate) AS EnrollmentTerminationDate,
        MAX(e.EffectiveDate) AS EnrollmentEffectiveDate,
        SUM(CASE WHEN e.Status = 'Terminated' THEN 0 ELSE e.PremiumAmount END) AS TotalPremium,
        MAX(p.Name) AS ProductName,
        COUNT(DISTINCT e.EnrollmentId) AS EnrollmentCount
      FROM oe.EnrollmentAcknowledgements ea
      LEFT JOIN oe.FileUploads f ON ea.FileUploadId = f.FileId
      LEFT JOIN oe.EnrollmentLinks el ON ea.LinkToken = el.LinkToken
      LEFT JOIN oe.Enrollments e ON el.MemberId = e.MemberId AND e.Status IN ('Active', 'Terminated', 'Pending Payment')
      LEFT JOIN oe.Products p ON e.ProductId = p.ProductId
      WHERE ea.MemberId = @memberId
      GROUP BY ea.LinkToken, f.FileId, f.FileName, f.FilePath, f.FileSize, f.MimeType, f.Category, f.Description, f.CreatedDate
      ORDER BY MIN(ea.SignedDate) DESC
    `;
    
    const acknowledgementsRequest = pool.request();
    acknowledgementsRequest.input('memberId', sql.UniqueIdentifier, member.MemberId);
    const acknowledgementsResult = await acknowledgementsRequest.query(acknowledgementsQuery);
    
    console.log(`📋 Found ${acknowledgementsResult.recordset.length} unique acknowledgement file(s) with ${acknowledgementsResult.recordset.reduce((sum, r) => sum + r.AcknowledgementCount, 0)} total acknowledgements`);
    
    // Transform acknowledgements to consistent format with authenticated URLs
    const transformedAcknowledgements = await Promise.all(acknowledgementsResult.recordset.map(async (acknowledgement) => {
      let authenticatedUrl = acknowledgement.FilePath;
      
      // Authenticate the URL if it's a blob URL
      if (acknowledgement.FilePath && isBlobUrl(acknowledgement.FilePath)) {
        try {
          authenticatedUrl = await generateAuthenticatedUrl(acknowledgement.FilePath);
          console.log(`✅ Authenticated acknowledgement URL: ${authenticatedUrl}`);
        } catch (error) {
          console.warn(`❌ Failed to authenticate acknowledgement URL: ${error.message}`);
          // Keep original URL if authentication fails
        }
      }
      
      // Determine enrollment status and balance
      const enrollmentStatus = acknowledgement.EnrollmentStatus || 'Unknown';
      const isTerminated = enrollmentStatus === 'Terminated';
      const balance = isTerminated ? 0 : (acknowledgement.TotalPremium || 0);
      
      // Build description with enrollment information
      let description = acknowledgement.AcknowledgementCount > 1 
        ? `${acknowledgement.AcknowledgementCount} acknowledgements signed` 
        : 'Enrollment acknowledgement signed';
      
      if (acknowledgement.ProductName) {
        description += ` - ${acknowledgement.ProductName}`;
      }
      
      if (isTerminated && acknowledgement.EnrollmentTerminationDate) {
        description += ` (Terminated ${new Date(acknowledgement.EnrollmentTerminationDate).toLocaleDateString()})`;
      }
      
      return {
        id: acknowledgement.FileId || acknowledgement.AcknowledgementId,
        type: 'signed_agreement',
        name: acknowledgement.FileName || `Enrollment Agreement - ${acknowledgement.LinkToken}`,
        url: authenticatedUrl,
        size: acknowledgement.FileSize,
        mimeType: acknowledgement.MimeType || 'application/pdf',
        category: acknowledgement.Category || 'Enrollment Agreements',
        description: description,
        createdDate: acknowledgement.SignedDate,
        status: enrollmentStatus, // Show actual enrollment status (Active, Terminated, etc.)
        balance: balance, // Show 0 for terminated, actual premium for active
        isSignedAgreement: true,
        linkToken: acknowledgement.LinkToken,
        acknowledgementCount: acknowledgement.AcknowledgementCount,
        enrollmentInfo: {
          status: enrollmentStatus,
          effectiveDate: acknowledgement.EnrollmentEffectiveDate,
          terminationDate: acknowledgement.EnrollmentTerminationDate,
          productName: acknowledgement.ProductName,
          enrollmentCount: acknowledgement.EnrollmentCount || 0
        }
      };
    }));
    
    // Sort by creation date (newest first)
    transformedAcknowledgements.sort((a, b) => new Date(b.createdDate) - new Date(a.createdDate));
    
    console.log(`✅ Found ${transformedAcknowledgements.length} signed agreements for member ${member.MemberId}`);
    
    // Only return actual documents (signed agreements), not enrollment records
    // Enrollment history should be shown on the Plans page, not Documents page
    res.json({
      success: true,
      data: {
        member: {
          memberId: member.MemberId,
          firstName: member.FirstName,
          lastName: member.LastName,
          email: member.Email
        },
        documents: transformedAcknowledgements,
        summary: {
          totalDocuments: transformedAcknowledgements.length,
          signedAgreements: transformedAcknowledgements.length,
          fileUploads: 0,
          acknowledgements: transformedAcknowledgements.length
        }
      }
    });
    
  } catch (error) {
    console.error('❌ Error fetching member documents:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching documents',
      error: {
        message: error.message,
        code: 'DOCUMENTS_FETCH_ERROR'
      }
    });
  }
});

module.exports = router;
