const { getPool, sql } = require('../../config/database');
const { DEFAULT_LINK_EXPIRATION_HOURS } = require('../../constants/linkExpiration');

/**
 * UNIFIED ENROLLMENT LINK SERVICE - Used by multiple endpoints
 * 
 * Endpoints using this service:
 * - /api/groups/:id/send-enrollment-links (Group enrollment links)
 * - /api/enrollment-links/send-individual (Individual enrollment links)
 * 
 * This service provides consistent enrollment link creation for both
 * group and individual members using the same database structure.
 */
class EnrollmentLinkService {
  
  /**
   * Create enrollment link for a single member
   * @param {object} params - Enrollment link parameters
   * @param {string} params.memberId - Member ID
   * @param {string} params.templateId - Enrollment link template ID
   * @param {string} params.groupId - Group ID (optional for individual links)
   * @param {string} params.groupName - Group name for description (optional)
   * @param {string} params.templateName - Template name for description (optional)
   * @param {string} params.effectiveDate - Effective date (optional)
   * @param {string} params.createdBy - User ID who created the link
   * @param {number} params.expirationHours - Hours until expiration (default: 72)
   * @param {object} params.req - Express request object (for extracting baseUrl)
   * @param {object} params.transaction - Database transaction (optional)
   * @param {string} params.agentId - Agent ID from template (optional)
   * @param {string} params.agencyId - Agency ID from template (optional)
   * @returns {object} Created enrollment link data
   */
  static async createEnrollmentLink(params) {
    try {
      const {
        memberId,
        templateId,
        groupId = null,
        groupName = null,
        templateName = null,
        effectiveDate = null,
        createdBy,
        expirationHours = DEFAULT_LINK_EXPIRATION_HOURS,
        expiresAtDate = null,
        req,
        transaction = null,
        agentId = null,
        agencyId = null,
        baseUrlOverride = null
      } = params;

      // Validate required parameters
      if (!memberId || !templateId || !createdBy) {
        throw new Error('MemberId, templateId, and createdBy are required');
      }
      
      // Use override (e.g. from localhost domain dropdown) or extract from request
      const baseUrl = baseUrlOverride && String(baseUrlOverride).trim()
        ? String(baseUrlOverride).trim().replace(/\/$/, '')
        : (req ? (req.get('origin') || `${req.protocol}://${req.get('host')}`) : 'http://localhost:3000');

      // Generate unique link token
      const linkToken = `enroll_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      // Generate UUID for LinkId
      const linkId = require('crypto').randomUUID();
      
      // Create enrollment URL
      const enrollmentUrl = `${baseUrl}/enroll/${linkToken}`;
      
      // Calculate expiration date (never use a past date - would create an already-expired link)
      let expiresAt;
      if (expiresAtDate) {
        const targetDate = new Date(expiresAtDate);
        const endOfTarget = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate(), 23, 59, 59, 999);
        if (endOfTarget > new Date()) {
          expiresAt = endOfTarget;
        } else {
          // Period end is in the past - use time-based expiration instead
          expiresAt = new Date(Date.now() + expirationHours * 60 * 60 * 1000);
        }
      } else {
        // For time-based expiration (default 7 days), use hours from now
        expiresAt = new Date(Date.now() + expirationHours * 60 * 60 * 1000);
      }
      
      // Create description
      let description = 'Enrollment link';
      if (groupName && templateName) {
        description = `Enrollment link for ${groupName} - ${templateName}`;
      } else if (templateName) {
        description = `Enrollment link - ${templateName}`;
      }

      // Determine LinkType based on whether it's for a specific member or group
      const linkType = memberId ? 'Member' : 'Group';

      // Prepare query
      const createLinkQuery = `
        INSERT INTO oe.EnrollmentLinks (
          LinkId, GroupId, MemberId, LinkToken, LinkUrl, Description, ExpiresAt, 
          IsActive, UsageCount, MaxUsage, EnrollmentLinkTemplateId, 
          EarliestEffectiveDate, AgentId, AgencyId, LinkType, CreatedDate, ModifiedDate, CreatedBy, ModifiedBy
        ) VALUES (
          @linkId, @groupId, @memberId, @linkToken, @linkUrl, @description, @expiresAt,
          @isActive, @usageCount, @maxUsage, @enrollmentLinkTemplateId,
          @earliestEffectiveDate, @agentId, @agencyId, @linkType, GETUTCDATE(), GETUTCDATE(), @createdBy, @modifiedBy
        )
      `;

      // Use provided transaction or create new request
      const request = transaction ? transaction.request() : (await getPool()).request();
      // Fail fast if INSERT is blocked by a stale session holding locks on oe.EnrollmentLinks -
      // otherwise the pool-wide 60s requestTimeout hits after the frontend already gave up at 30s.
      if (!transaction) {
        request.timeout = 15000;
      }

      // Set parameters
      request.input('linkId', sql.UniqueIdentifier, linkId);
      request.input('groupId', sql.UniqueIdentifier, groupId);
      request.input('memberId', sql.UniqueIdentifier, memberId);
      request.input('linkToken', sql.NVarChar, linkToken);
      request.input('linkUrl', sql.NVarChar, enrollmentUrl);
      request.input('description', sql.NVarChar, description);
      request.input('expiresAt', sql.DateTime2, expiresAt);
      request.input('isActive', sql.Bit, 1);
      request.input('usageCount', sql.Int, 0);
      request.input('maxUsage', sql.Int, 1);
      request.input('enrollmentLinkTemplateId', sql.UniqueIdentifier, templateId);
      request.input('earliestEffectiveDate', sql.Date, effectiveDate ? new Date(effectiveDate) : null);
      request.input('agentId', sql.UniqueIdentifier, agentId);
      request.input('agencyId', sql.UniqueIdentifier, agencyId);
      request.input('linkType', sql.NVarChar, linkType);
      request.input('createdBy', sql.UniqueIdentifier, createdBy);
      request.input('modifiedBy', sql.UniqueIdentifier, createdBy);

      // Execute query
      const insertStart = Date.now();
      console.log(`🔍 DEBUG: [EnrollmentLinks.INSERT] starting for member ${memberId} (linkId ${linkId})`);
      const result = await request.query(createLinkQuery);
      console.log(`🔍 DEBUG: [EnrollmentLinks.INSERT] finished in ${Date.now() - insertStart}ms`);
      
      // Verify the insert actually succeeded
      if (!result || result.rowsAffected[0] === 0) {
        throw new Error('Failed to create enrollment link - no rows affected');
      }

      console.log(`✅ Created enrollment link: ${linkToken} for member ${memberId}`);
      console.log(`🔗 Enrollment URL: ${enrollmentUrl}`);
      console.log(`⏰ Expires at: ${expiresAt.toISOString()}`);
      console.log(`📊 Insert result: ${result.rowsAffected[0]} row(s) affected`);

      return {
        linkId,
        linkToken,
        enrollmentUrl,
        expiresAt: expiresAt.toISOString(),
        memberId,
        groupId,
        effectiveDate
      };

    } catch (error) {
      console.error('❌ Error creating enrollment link:', error);
      throw error;
    }
  }

  /**
   * Create multiple enrollment links for group members
   * @param {object} params - Group enrollment link parameters
   * @param {Array} params.memberIds - Array of member IDs
   * @param {string} params.templateId - Enrollment link template ID
   * @param {string} params.groupId - Group ID
   * @param {string} params.groupName - Group name
   * @param {string} params.templateName - Template name
   * @param {string} params.effectiveDate - Effective date (optional)
   * @param {string} params.createdBy - User ID who created the links
   * @param {number} params.expirationHours - Hours until expiration (default: 72)
   * @param {object} params.req - Express request object (for extracting baseUrl)
   * @param {string} params.agentId - Agent ID from template (optional)
   * @param {string} params.agencyId - Agency ID from template (optional)
   * @returns {Array} Array of created enrollment link data
   */
  static async createGroupEnrollmentLinks(params) {
    try {
      const {
        memberIds,
        templateId,
        groupId,
        groupName,
        templateName,
        effectiveDate = null,
        createdBy,
        expirationHours = DEFAULT_LINK_EXPIRATION_HOURS,
        expiresAtDate = null,
        req,
        agentId = null,
        agencyId = null,
        baseUrlOverride = null
      } = params;

      // Validate required parameters
      if (!memberIds || !Array.isArray(memberIds) || memberIds.length === 0) {
        throw new Error('MemberIds array is required and must not be empty');
      }
      if (!templateId || !groupId || !groupName || !templateName || !createdBy) {
        throw new Error('templateId, groupId, groupName, templateName, and createdBy are required');
      }

      const pool = await getPool();
      const transaction = pool.transaction();
      
      try {
        await transaction.begin();
        
        const createdLinks = [];
        
        for (const memberId of memberIds) {
          const linkData = await this.createEnrollmentLink({
            memberId,
            templateId,
            groupId,
            groupName,
            templateName,
            effectiveDate,
            createdBy,
            expirationHours,
            expiresAtDate,
            req,
            transaction,
            agentId,
            agencyId,
            baseUrlOverride
          });
          
          createdLinks.push(linkData);
        }
        
        await transaction.commit();
        
        console.log(`✅ Created ${createdLinks.length} enrollment links for group ${groupName}`);
        
        return createdLinks;
        
      } catch (error) {
        await transaction.rollback();
        throw error;
      }

    } catch (error) {
      console.error('❌ Error creating group enrollment links:', error);
      throw error;
    }
  }

  /**
   * Get member information for enrollment link creation
   * @param {string} memberId - Member ID
   * @param {object} pool - Database pool (optional)
   * @returns {object} Member information
   */
  static async getMemberInfo(memberId, pool = null) {
    try {
      const dbPool = pool || await getPool();
      const request = dbPool.request();
      
      request.input('memberId', sql.UniqueIdentifier, memberId);
      
      // First check if member exists and get their status
      const memberCheckQuery = `
        SELECT 
          m.MemberId,
          m.UserId,
          m.GroupId,
          m.Status,
          m.SmsConsent,
          u.FirstName,
          u.LastName,
          u.Email,
          g.Name as GroupName,
          CASE WHEN da.DeclineAcknowledgementId IS NOT NULL THEN 1 ELSE 0 END as HasDeclinedCoverage
        FROM oe.Members m
        JOIN oe.Users u ON m.UserId = u.UserId
        LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId
        LEFT JOIN oe.DeclineAcknowledgements da ON m.MemberId = da.MemberId AND da.Status = 'Active'
        WHERE m.MemberId = @memberId
      `;
      
      const memberCheckResult = await request.query(memberCheckQuery);
      
      if (memberCheckResult.recordset.length === 0) {
        return null; // Member not found
      }
      
      const member = memberCheckResult.recordset[0];
      
      // Allow Active and Terminated members (terminated members can be re-enrolled)
      // Only reject Declined members or members with declined coverage
      if (member.Status === 'Declined' || member.HasDeclinedCoverage) {
        // Return a special object to indicate declined coverage
        return {
          ...member,
          _isDeclinedCoverage: true
        };
      }
      
      // Allow Active, Terminated, and other statuses (except Declined)
      // Terminated members can be re-enrolled
      return member;
      
    } catch (error) {
      console.error('❌ Error getting member info:', error);
      throw error;
    }
  }

  /**
   * Validate enrollment link template
   * @param {string} templateId - Template ID
   * @param {string} userTenantId - User's tenant ID
   * @param {string} userType - User type (SysAdmin, TenantAdmin, etc.)
   * @param {object} pool - Database pool (optional)
   * @param {string} expectedTemplateType - Expected template type ('Individual' or 'Group')
   * @returns {object} Template information
   */
  static async validateTemplate(templateId, userTenantId, userType, pool = null, expectedTemplateType = null) {
    try {
      const dbPool = pool || await getPool();
      const request = dbPool.request();
      
      request.input('templateId', sql.UniqueIdentifier, templateId);
      
      // userType may be a comma-separated string of roles (e.g. "TenantAdmin, Agent")
      const isSysAdmin = typeof userType === 'string' && userType.split(',').map(r => r.trim()).includes('SysAdmin');
      
      console.log('🔍 validateTemplate:', { templateId, userTenantId, userType, isSysAdmin, expectedTemplateType });
      
      let query;
      if (isSysAdmin) {
        if (expectedTemplateType) {
          request.input('templateType', sql.NVarChar, expectedTemplateType);
          query = `
            SELECT TemplateId, TemplateName, TemplateType, IsActive
            FROM oe.EnrollmentLinkTemplates 
            WHERE TemplateId = @templateId 
              AND TemplateType = @templateType
              AND IsActive = 1
          `;
        } else {
          query = `
            SELECT TemplateId, TemplateName, TemplateType, IsActive
            FROM oe.EnrollmentLinkTemplates 
            WHERE TemplateId = @templateId 
              AND IsActive = 1
          `;
        }
      } else {
        request.input('userTenantId', sql.UniqueIdentifier, userTenantId);
        if (expectedTemplateType) {
          request.input('templateType', sql.NVarChar, expectedTemplateType);
          query = `
            SELECT TemplateId, TemplateName, TemplateType, IsActive
            FROM oe.EnrollmentLinkTemplates 
            WHERE TemplateId = @templateId 
              AND TemplateType = @templateType
              AND IsActive = 1 
              AND TenantId = @userTenantId
          `;
        } else {
          query = `
            SELECT TemplateId, TemplateName, TemplateType, IsActive
            FROM oe.EnrollmentLinkTemplates 
            WHERE TemplateId = @templateId 
              AND IsActive = 1 
              AND TenantId = @userTenantId
          `;
        }
      }
      
      const result = await request.query(query);
      
      if (result.recordset.length === 0) {
        return null;
      }
      
      return result.recordset[0];
      
    } catch (error) {
      console.error('❌ Error validating template:', error);
      throw error;
    }
  }
}

module.exports = EnrollmentLinkService;
