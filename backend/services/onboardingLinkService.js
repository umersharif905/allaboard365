// backend/services/onboardingLinkService.js
const sql = require('mssql');
const { getPool } = require('../config/database');
const logger = require('../config/logger');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const { generateAgentCode } = require('./agentCode.service');

class OnboardingLinkService {
    /**
     * Create a new onboarding link
     * @param {Object} linkData - Link creation data
     * @param {string} linkData.linkName - Human-readable name for the link
     * @param {string} linkData.tenantId - Tenant ID
     * @param {string} linkData.agencyId - Agency ID (optional)
     * @param {string} linkData.agentId - Agent ID (optional)
     * @param {string} linkData.commissionCode - Unique commission code
     * @param {string} linkData.commissionRuleId - Commission rule ID
     * @param {string} linkData.createdBy - User ID who created the link
     * @param {string} linkData.contractDocumentId - Contract document ID (optional)
     * @returns {Promise<Object>} Created link data
     */
    static async createLink(linkData) {
        logger.info('[ONBOARDING-SERVICE] >> Creating onboarding link');
        
        try {
            const pool = await getPool();
            
            // Validate tenant exists
            const tenantCheck = await pool.request()
                .input('tenantId', sql.UniqueIdentifier, linkData.tenantId)
                .query('SELECT TenantId FROM oe.Tenants WHERE TenantId = @tenantId');
            
            if (tenantCheck.recordset.length === 0) {
                throw new Error('Tenant not found');
            }
            
            // Validate commission rule exists and belongs to tenant
            const ruleCheck = await pool.request()
                .input('ruleId', sql.UniqueIdentifier, linkData.commissionRuleId)
                .input('tenantId', sql.UniqueIdentifier, linkData.tenantId)
                .query(`
                    SELECT RuleId 
                    FROM oe.CommissionRules 
                    WHERE RuleId = @ruleId 
                    AND (TenantId = @tenantId OR TenantId IS NULL)
                `);
            
            if (ruleCheck.recordset.length === 0) {
                throw new Error('Commission rule not found or does not belong to tenant');
            }
            
            // Validate commission code is unique within tenant
            const codeCheck = await pool.request()
                .input('tenantId', sql.UniqueIdentifier, linkData.tenantId)
                .input('commissionCode', sql.NVarChar, linkData.commissionCode)
                .query(`
                    SELECT LinkId 
                    FROM oe.AgentOnboardingLinks 
                    WHERE TenantId = @tenantId 
                    AND CommissionCode = @commissionCode
                `);
            
            if (codeCheck.recordset.length > 0) {
                throw new Error('Commission code already exists for this tenant');
            }
            
            // Create the onboarding link
            const linkId = uuidv4();
            const linkToken = crypto.randomBytes(16).toString('hex'); // 32-character hex string
            const insertQuery = `
                INSERT INTO oe.AgentOnboardingLinks (
                    LinkId, TenantId, AgencyId, AgentId, LinkName, LinkToken, CommissionCode, 
                    CommissionRuleId, CreatedBy, ContractDocumentId
                ) VALUES (
                    @linkId, @tenantId, @agencyId, @agentId, @linkName, @linkToken, @commissionCode,
                    @commissionRuleId, @createdBy, @contractDocumentId
                )
            `;
            
            await pool.request()
                .input('linkId', sql.UniqueIdentifier, linkId)
                .input('tenantId', sql.UniqueIdentifier, linkData.tenantId)
                .input('agencyId', sql.UniqueIdentifier, linkData.agencyId || null)
                .input('agentId', sql.UniqueIdentifier, linkData.agentId || null)
                .input('linkName', sql.NVarChar, linkData.linkName)
                .input('linkToken', sql.NVarChar, linkToken)
                .input('commissionCode', sql.NVarChar, linkData.commissionCode)
                .input('commissionRuleId', sql.UniqueIdentifier, linkData.commissionRuleId)
                .input('createdBy', sql.UniqueIdentifier, linkData.createdBy)
                .input('contractDocumentId', sql.UniqueIdentifier, linkData.contractDocumentId || null)
                .query(insertQuery);
            
            logger.info(`[ONBOARDING-SERVICE] << Created onboarding link: ${linkId}`);
            
            // Return the created link
            return await this.getLinkById(linkId);
            
        } catch (error) {
            logger.error('[ONBOARDING-SERVICE] !! Error creating onboarding link:', error);
            throw error;
        }
    }
    
    /**
     * Update an existing onboarding link
     * @param {string} linkId - Link ID
     * @param {Object} updateData - Update data
     * @param {string} updateData.linkName - Human-readable name for the link
     * @param {string} updateData.commissionRuleId - Commission rule ID
     * @param {boolean} updateData.isActive - Whether the link is active
     * @param {string} updateData.contractDocumentId - Contract document ID (optional)
     * @returns {Promise<Object>} Updated link data
     */
    static async updateLink(linkId, updateData) {
        logger.info(`[ONBOARDING-SERVICE] >> Updating onboarding link: ${linkId}`);
        
        try {
            const pool = await getPool();
            
            // Validate link exists
            const linkCheck = await pool.request()
                .input('linkId', sql.UniqueIdentifier, linkId)
                .query('SELECT LinkId FROM oe.AgentOnboardingLinks WHERE LinkId = @linkId');
            
            if (linkCheck.recordset.length === 0) {
                throw new Error('Onboarding link not found');
            }
            
            // Validate commission rule exists if provided
            if (updateData.commissionRuleId) {
                const ruleCheck = await pool.request()
                    .input('ruleId', sql.UniqueIdentifier, updateData.commissionRuleId)
                    .query('SELECT RuleId FROM oe.CommissionRules WHERE RuleId = @ruleId');
                
                if (ruleCheck.recordset.length === 0) {
                    throw new Error('Commission rule not found');
                }
            }
            
            // Update the onboarding link
            const updateQuery = `
                UPDATE oe.AgentOnboardingLinks SET
                    LinkName = @linkName,
                    CommissionRuleId = @commissionRuleId,
                    IsActive = @isActive,
                    ContractDocumentId = @contractDocumentId,
                    ModifiedDate = GETDATE()
                WHERE LinkId = @linkId
            `;
            
            await pool.request()
                .input('linkId', sql.UniqueIdentifier, linkId)
                .input('linkName', sql.NVarChar, updateData.linkName)
                .input('commissionRuleId', sql.UniqueIdentifier, updateData.commissionRuleId)
                .input('isActive', sql.Bit, updateData.isActive)
                .input('contractDocumentId', sql.UniqueIdentifier, updateData.contractDocumentId || null)
                .query(updateQuery);
            
            logger.info(`[ONBOARDING-SERVICE] << Updated onboarding link: ${linkId}`);
            
            // Return the updated link
            return await this.getLinkById(linkId);
            
        } catch (error) {
            logger.error(`[ONBOARDING-SERVICE] << Error updating onboarding link: ${error.message}`);
            throw error;
        }
    }
    
    /**
     * Get onboarding link by ID
     * @param {string} linkId - Link ID
     * @returns {Promise<Object>} Link data
     */
    static async getLinkById(linkId) {
        try {
            const pool = await getPool();
            
            const query = `
                SELECT 
                    aol.LinkId,
                    aol.TenantId,
                    t.Name as TenantName,
                    aol.AgencyId,
                    ag.AgencyName,
                    aol.AgentId,
                    a.FirstName + ' ' + a.LastName as AgentName,
                    aol.LinkName,
                    aol.LinkToken,
                    aol.CommissionCode,
                    aol.CommissionRuleId,
                    cr.RuleName as CommissionRuleName,
                    cr.CommissionType,
                    cr.CommissionRate,
                    cr.FlatAmount,
                    aol.IsActive,
                    aol.CurrentUses,
                    aol.CreatedBy,
                    u.FirstName + ' ' + u.LastName as CreatedByName,
                    aol.CreatedDate,
                    aol.ModifiedDate,
                    aol.RedirectUrl,
                    aol.ContractDocumentId,
                    f.FileName as ContractFileName,
                    f.FilePath as ContractDocumentUrl,
                    aol.CustomFields
                FROM oe.AgentOnboardingLinks aol
                INNER JOIN oe.Tenants t ON aol.TenantId = t.TenantId
                INNER JOIN oe.CommissionRules cr ON aol.CommissionRuleId = cr.RuleId
                INNER JOIN oe.Users u ON aol.CreatedBy = u.UserId
                LEFT JOIN oe.Agencies ag ON aol.AgencyId = ag.AgencyId
                LEFT JOIN oe.Agents a ON aol.AgentId = a.AgentId
                LEFT JOIN oe.FileUploads f ON aol.ContractDocumentId = f.FileId
                WHERE aol.LinkId = @linkId
            `;
            
            const result = await pool.request()
                .input('linkId', sql.UniqueIdentifier, linkId)
                .query(query);
            
            if (result.recordset.length === 0) {
                return null;
            }
            
            const link = result.recordset[0];
            if (link.CustomFields) {
                link.CustomFields = JSON.parse(link.CustomFields);
            }
            
            return link;
            
        } catch (error) {
            logger.error('[ONBOARDING-SERVICE] !! Error getting link by ID:', error);
            throw error;
        }
    }
    
    /**
     * Validate commission code
     * @param {string} commissionCode - Commission code to validate
     * @returns {Promise<Object>} Validation result
     */
    static async validateCommissionCode(commissionCode) {
        try {
            const pool = await getPool();
            
            const result = await pool.request()
                .input('CommissionCode', sql.NVarChar, commissionCode)
                .execute('oe.sp_ValidateCommissionCode');
            
            if (result.recordset.length === 0) {
                return {
                    valid: false,
                    message: 'Invalid commission code'
                };
            }
            
            const linkData = result.recordset[0];
            
            if (linkData.Status !== 'Valid') {
                return {
                    valid: false,
                    message: 'Commission code is inactive'
                };
            }
            
            return {
                valid: true,
                data: {
                    linkId: linkData.LinkId,
                    linkName: linkData.LinkName,
                    commissionCode: linkData.CommissionCode,
                    tenantName: linkData.TenantName,
                    commissionRule: {
                        ruleId: linkData.CommissionRuleId,
                        ruleName: linkData.CommissionRuleName,
                        type: linkData.CommissionType,
                        rate: linkData.CommissionRate,
                        flatAmount: linkData.FlatAmount
                    },
                    contractDocumentUrl: linkData.ContractDocumentUrl,
                    customFields: linkData.CustomFields ? JSON.parse(linkData.CustomFields) : null
                }
            };
            
        } catch (error) {
            logger.error('[ONBOARDING-SERVICE] !! Error validating commission code:', error);
            throw error;
        }
    }
    
    /**
     * Start onboarding session
     * @param {string} linkId - Link ID
     * @param {string} ipAddress - Client IP address
     * @param {string} userAgent - Client user agent
     * @returns {Promise<Object>} Session data
     */
    static async startSession(linkId, ipAddress, userAgent) {
        try {
            const pool = await getPool();
            
            // Verify link exists and is active
            const linkCheck = await pool.request()
                .input('linkId', sql.UniqueIdentifier, linkId)
                .query(`
                    SELECT LinkId, IsActive 
                    FROM oe.AgentOnboardingLinks 
                    WHERE LinkId = @linkId AND IsActive = 1
                `);
            
            if (linkCheck.recordset.length === 0) {
                throw new Error('Invalid or inactive onboarding link');
            }
            
            // Generate secure session token
            const sessionToken = crypto.randomBytes(32).toString('hex');
            
            // Create session using stored procedure
            const result = await pool.request()
                .input('LinkId', sql.UniqueIdentifier, linkId)
                .input('SessionToken', sql.NVarChar, sessionToken)
                .input('IPAddress', sql.NVarChar, ipAddress)
                .input('UserAgent', sql.NVarChar, userAgent)
                .execute('oe.sp_StartOnboardingSession');
            
            const sessionData = result.recordset[0];
            
            logger.info(`[ONBOARDING-SERVICE] << Started onboarding session: ${sessionData.SessionId}`);
            
            return {
                sessionId: sessionData.SessionId,
                sessionToken: sessionData.SessionToken,
                status: sessionData.Status,
                startedDate: sessionData.StartedDate,
                expiresDate: sessionData.ExpiresDate
            };
            
        } catch (error) {
            logger.error('[ONBOARDING-SERVICE] !! Error starting onboarding session:', error);
            throw error;
        }
    }
    
    /**
     * Save onboarding progress
     * @param {string} sessionToken - Session token
     * @param {Object} agentData - Agent data
     * @param {number} currentStep - Current step
     * @returns {Promise<boolean>} Success status
     */
    static async saveProgress(sessionToken, agentData, currentStep) {
        try {
            const pool = await getPool();
            
            // Verify session exists and is valid
            const sessionCheck = await pool.request()
                .input('sessionToken', sql.NVarChar, sessionToken)
                .query(`
                    SELECT SessionId, Status, ExpiresDate 
                    FROM oe.AgentOnboardingSessions 
                    WHERE SessionToken = @sessionToken
                `);
            
            if (sessionCheck.recordset.length === 0) {
                throw new Error('Invalid session token');
            }
            
            const session = sessionCheck.recordset[0];
            
            // Check if session is expired
            if (new Date() > new Date(session.ExpiresDate)) {
                // Update session status to expired
                await pool.request()
                    .input('sessionId', sql.UniqueIdentifier, session.SessionId)
                    .query(`
                        UPDATE oe.AgentOnboardingSessions 
                        SET Status = 'Expired' 
                        WHERE SessionId = @sessionId
                    `);
                
                throw new Error('Session has expired');
            }
            
            // Update session progress
            await pool.request()
                .input('sessionToken', sql.NVarChar, sessionToken)
                .input('agentData', sql.NVarChar, agentData ? JSON.stringify(agentData) : null)
                .input('currentStep', sql.Int, currentStep)
                .query(`
                    UPDATE oe.AgentOnboardingSessions 
                    SET AgentData = @agentData,
                        Status = CASE WHEN @currentStep >= 3 THEN 'InProgress' ELSE Status END,
                        ModifiedDate = GETDATE()
                    WHERE SessionToken = @sessionToken
                `);
            
            logger.info(`[ONBOARDING-SERVICE] << Saved progress for session: ${session.SessionId}`);
            
            return true;
            
        } catch (error) {
            logger.error('[ONBOARDING-SERVICE] !! Error saving progress:', error);
            throw error;
        }
    }
    
    /**
     * Complete onboarding and create agent account
     * @param {string} sessionToken - Session token
     * @param {Object} agentData - Complete agent data
     * @param {string} digitalSignature - Digital signature
     * @param {string} signatureDate - Signature date
     * @returns {Promise<Object>} Created agent data
     */
    static async completeOnboarding(sessionToken, agentData, digitalSignature, signatureDate) {
        logger.info('[ONBOARDING-SERVICE] >> Completing onboarding process');
        
        try {
            const pool = await getPool();
            
            // Verify session exists and is valid
            const sessionCheck = await pool.request()
                .input('sessionToken', sql.NVarChar, sessionToken)
                .query(`
                    SELECT 
                        aos.SessionId,
                        aos.LinkId,
                        aos.Status,
                        aos.ExpiresDate,
                        aol.TenantId,
                        aol.CommissionRuleId
                    FROM oe.AgentOnboardingSessions aos
                    INNER JOIN oe.AgentOnboardingLinks aol ON aos.LinkId = aol.LinkId
                    WHERE aos.SessionToken = @sessionToken
                `);
            
            if (sessionCheck.recordset.length === 0) {
                throw new Error('Invalid session token');
            }
            
            const session = sessionCheck.recordset[0];
            
            // Check if session is expired
            if (new Date() > new Date(session.ExpiresDate)) {
                await pool.request()
                    .input('sessionId', sql.UniqueIdentifier, session.SessionId)
                    .query(`
                        UPDATE oe.AgentOnboardingSessions 
                        SET Status = 'Expired' 
                        WHERE SessionId = @sessionId
                    `);
                
                throw new Error('Session has expired');
            }
            
            // Check if session is already completed
            if (session.Status === 'Completed') {
                throw new Error('Onboarding session already completed');
            }
            
            // Validate required agent data
            const requiredFields = ['firstName', 'lastName', 'email', 'phone', 'address', 'city', 'state', 'zip'];
            const missingFields = requiredFields.filter(field => !agentData[field]);
            
            if (missingFields.length > 0) {
                throw new Error(`Missing required fields: ${missingFields.join(', ')}`);
            }
            
            // Check if agent email already exists
            const emailCheck = await pool.request()
                .input('email', sql.NVarChar, agentData.email)
                .query(`
                    SELECT UserId 
                    FROM oe.Users 
                    WHERE Email = @email
                `);
            
            if (emailCheck.recordset.length > 0) {
                throw new Error('An account with this email already exists');
            }
            
            // Begin transaction for agent creation
            const transaction = pool.transaction();
            await transaction.begin();
            
            try {
                // Create user account
                const userId = uuidv4();
                await transaction.request()
                    .input('userId', sql.UniqueIdentifier, userId)
                    .input('firstName', sql.NVarChar, agentData.firstName)
                    .input('lastName', sql.NVarChar, agentData.lastName)
                    .input('email', sql.NVarChar, agentData.email)
                    .input('phone', sql.NVarChar, agentData.phone || null)
                    .input('address', sql.NVarChar, agentData.address)
                    .input('city', sql.NVarChar, agentData.city)
                    .input('state', sql.NVarChar, agentData.state)
                    .input('zip', sql.NVarChar, agentData.zip)
                    .input('tenantId', sql.UniqueIdentifier, session.TenantId)
                    .input('createdDate', sql.DateTime2, new Date())
                    .query(`
                        INSERT INTO oe.Users (
                            UserId, FirstName, LastName, Email, Phone, 
                            Address, City, State, Zip, TenantId, CreatedDate
                        ) VALUES (
                            @userId, @firstName, @lastName, @email, @phone,
                            @address, @city, @state, @zip, @tenantId, @createdDate
                        )
                    `);
                
                // Create agent record
                const agentId = uuidv4();
                const newAgentCode = await generateAgentCode(transaction, session.TenantId);
                await transaction.request()
                    .input('agentId', sql.UniqueIdentifier, agentId)
                    .input('userId', sql.UniqueIdentifier, userId)
                    .input('tenantId', sql.UniqueIdentifier, session.TenantId)
                    .input('npn', sql.NVarChar, agentData.npn || null)
                    .input('taxId', sql.NVarChar, agentData.taxId || null)
                    .input('taxIdType', sql.NVarChar, agentData.taxIdType || null)
                    .input('commissionRole', sql.NVarChar, 'Standard')
                    .input('status', sql.NVarChar, 'Active')
                    .input('agentCode', sql.NVarChar(50), newAgentCode)
                    .input('createdDate', sql.DateTime2, new Date())
                    .query(`
                        INSERT INTO oe.Agents (
                            AgentId, UserId, TenantId, NPN, TaxId, TaxIdType,
                            CommissionRole, Status, AgentCode, CreatedDate
                        ) VALUES (
                            @agentId, @userId, @tenantId, @npn, @taxId, @taxIdType,
                            @commissionRole, @status, @agentCode, @createdDate
                        )
                    `);
                
                // Update session with agent ID and mark as completed
                await transaction.request()
                    .input('sessionId', sql.UniqueIdentifier, session.SessionId)
                    .input('agentId', sql.UniqueIdentifier, agentId)
                    .input('agentData', sql.NVarChar, JSON.stringify(agentData))
                    .input('completedDate', sql.DateTime2, new Date())
                    .query(`
                        UPDATE oe.AgentOnboardingSessions 
                        SET AgentId = @agentId,
                            AgentData = @agentData,
                            Status = 'Completed',
                            CompletedDate = @completedDate,
                            ModifiedDate = GETDATE()
                        WHERE SessionId = @sessionId
                    `);
                
                // Increment usage count for the link
                await transaction.request()
                    .input('linkId', sql.UniqueIdentifier, session.LinkId)
                    .query(`
                        UPDATE oe.AgentOnboardingLinks 
                        SET CurrentUses = CurrentUses + 1,
                            ModifiedDate = GETDATE()
                        WHERE LinkId = @linkId
                    `);
                
                await transaction.commit();
                
                logger.info(`[ONBOARDING-SERVICE] << Completed onboarding for agent: ${agentId}`);
                
                return {
                    agentId,
                    userId,
                    email: agentData.email,
                    tenantId: session.TenantId,
                    commissionRuleId: session.CommissionRuleId
                };
                
            } catch (error) {
                await transaction.rollback();
                throw error;
            }
            
        } catch (error) {
            logger.error('[ONBOARDING-SERVICE] !! Error completing onboarding:', error);
            throw error;
        }
    }
    
    /**
     * Get onboarding statistics for a tenant
     * @param {string} tenantId - Tenant ID
     * @returns {Promise<Object>} Statistics data
     */
    static async getTenantStatistics(tenantId) {
        try {
            const pool = await getPool();
            
            const statsQuery = `
                SELECT 
                    COUNT(DISTINCT aol.LinkId) as TotalLinks,
                    SUM(CASE WHEN aol.IsActive = 1 THEN 1 ELSE 0 END) as ActiveLinks,
                    SUM(aol.CurrentUses) as TotalUses,
                    COUNT(DISTINCT aos.SessionId) as TotalSessions,
                    SUM(CASE WHEN aos.Status = 'Completed' THEN 1 ELSE 0 END) as CompletedSessions,
                    SUM(CASE WHEN aos.Status = 'InProgress' THEN 1 ELSE 0 END) as InProgressSessions,
                    SUM(CASE WHEN aos.Status = 'Pending' THEN 1 ELSE 0 END) as PendingSessions,
                    SUM(CASE WHEN aos.Status = 'Failed' THEN 1 ELSE 0 END) as FailedSessions,
                    ROUND(
                        (SUM(CASE WHEN aos.Status = 'Completed' THEN 1 ELSE 0 END) * 100.0) / 
                        NULLIF(COUNT(DISTINCT aos.SessionId), 0), 2
                    ) as OverallCompletionRate
                FROM oe.AgentOnboardingLinks aol
                LEFT JOIN oe.AgentOnboardingSessions aos ON aol.LinkId = aos.LinkId
                WHERE aol.TenantId = @tenantId
            `;
            
            const result = await pool.request()
                .input('tenantId', sql.UniqueIdentifier, tenantId)
                .query(statsQuery);
            
            return result.recordset[0];
            
        } catch (error) {
            logger.error('[ONBOARDING-SERVICE] !! Error getting tenant statistics:', error);
            throw error;
        }
    }
}

module.exports = OnboardingLinkService;
