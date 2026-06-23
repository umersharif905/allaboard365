// backend/routes/public/onboarding.js
const express = require('express');
const router = express.Router();
const sql = require('mssql');
const { getPool } = require('../../config/database');
const logger = require('../../config/logger');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const UserRolesService = require('../../services/shared/user-roles.service');
const passwordRequirements = require('../../constants/password-requirements');
const encryptionService = require('../../services/encryptionService');
const { generateAgentCode } = require('../../services/agentCode.service');
const { assertGrantTierAllowed } = require('../../services/onboardingLinkGrantTierValidation.service');

const TIER_SQL = sql.Decimal(9, 4);

const parseAgentDataJson = (raw) => {
    if (!raw) return {};
    if (typeof raw === 'object') return raw;
    if (typeof raw !== 'string') return {};
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (e) {
        return {};
    }
};

/**
 * @route   GET /api/public/onboarding/link/:linkToken
 * @desc    Get onboarding link details by link token
 * @access  Public (no authentication required)
 */
router.get('/link/:linkToken', async (req, res) => {
    logger.info('[PUBLIC-ONBOARDING] >> Getting onboarding link details');
    
    try {
        const { linkToken } = req.params;

        if (!linkToken) {
            return res.status(400).json({
                success: false,
                message: 'Link token is required'
            });
        }

        const pool = await getPool();

        // Get link details by token
        const result = await pool.request()
            .input('LinkToken', sql.NVarChar, linkToken)
            .query(`
                SELECT 
                    aol.LinkId,
                    aol.LinkToken,
                    aol.TenantId,
                    t.Name as TenantName,
                    aol.AgencyId,
                    ag.AgencyName,
                    aol.AgentId,
                    a.FirstName + ' ' + a.LastName as AgentName,
                    aol.LinkName,
                    aol.IsActive,
                    aol.ContractDocumentId,
                    f.FileName as ContractFileName,
                    f.FilePath as ContractDocumentUrl,
                    -- Commission codes as JSON array
                    (
                        SELECT 
                            olcc.CodeId,
                            olcc.CommissionCode,
                            olcc.CommissionGroupId,
                            cg.Name AS CommissionGroupName,
                            olcc.IsActive AS CodeActive
                        FROM oe.OnboardingLinkCommissionCodes olcc
                        LEFT JOIN oe.CommissionGroups cg ON olcc.CommissionGroupId = cg.CommissionGroupId
                        WHERE olcc.LinkId = aol.LinkId
                        FOR JSON PATH
                    ) AS CommissionCodes
                FROM oe.AgentOnboardingLinks aol
                INNER JOIN oe.Tenants t ON aol.TenantId = t.TenantId
                LEFT JOIN oe.Agencies ag ON aol.AgencyId = ag.AgencyId
                LEFT JOIN oe.Agents a ON aol.AgentId = a.AgentId
                LEFT JOIN oe.FileUploads f ON aol.ContractDocumentId = f.FileId
                WHERE aol.LinkToken = @LinkToken AND aol.IsActive = 1
            `);

        if (result.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Invalid onboarding link'
            });
        }

        const linkData = result.recordset[0];

        if (!linkData.IsActive) {
            return res.status(400).json({
                success: false,
                message: 'Onboarding link is inactive'
            });
        }

        logger.info(`[PUBLIC-ONBOARDING] << Link details retrieved for token: ${linkToken}`);
        
        // Parse CommissionCodes JSON if it exists
        let commissionCodes = [];
        if (linkData.CommissionCodes) {
            try {
                commissionCodes = JSON.parse(linkData.CommissionCodes);
            } catch (e) {
                logger.warn('[PUBLIC-ONBOARDING] Failed to parse CommissionCodes JSON:', e);
            }
        }

        // Get ALL agent agreement documents for this tenant
        const documentsQuery = `
            SELECT 
                FileId,
                FileName,
                StoredFileName,
                FilePath,
                FileSize,
                MimeType,
                Description,
                CreatedDate
            FROM oe.FileUploads
            WHERE TenantId = @tenantId
            AND UploadType = 'agentAgreement'
            AND Status = 'Active'
            ORDER BY CreatedDate DESC
        `;
        
        const documentsResult = await pool.request()
            .input('tenantId', sql.UniqueIdentifier, linkData.TenantId)
            .query(documentsQuery);
        
        logger.info(`[PUBLIC-ONBOARDING] Found ${documentsResult.recordset.length} agent agreement documents for tenant`);
        
        // Generate authenticated URLs manually using StoredFileName for correct blob name
        const { generateSASUrl } = require('../uploads');
        
        const authenticatedDocuments = documentsResult.recordset.map((doc) => {
            logger.info(`[PUBLIC-ONBOARDING] Generating SAS URL for: ${doc.FileName}`);
            
            // Reconstruct the blob name from the stored structure
            const blobName = `agent-agreements/${linkData.TenantId}/${doc.StoredFileName}`;
            const containerName = 'agreements';
            
            // Generate SAS URL directly
            const authenticatedUrl = generateSASUrl(containerName, blobName, 'r', 60);
            
            logger.info(`[PUBLIC-ONBOARDING] ✅ Generated SAS URL for ${doc.FileName}`);
            
            return {
                FileId: doc.FileId,
                FileName: doc.FileName,
                FilePath: authenticatedUrl,
                FileSize: doc.FileSize,
                MimeType: doc.MimeType,
                Description: doc.Description,
                CreatedDate: doc.CreatedDate
            };
        });
        
        // Also authenticate the primary ContractDocumentUrl if it exists
        let authenticatedContractUrl = linkData.ContractDocumentUrl;
        if (linkData.ContractDocumentUrl) {
            logger.info(`[PUBLIC-ONBOARDING] Authenticating primary contract URL`);
            const authenticatedContract = await authenticateUrls(
                { ContractDocumentUrl: linkData.ContractDocumentUrl }, 
                ['ContractDocumentUrl']
            );
            authenticatedContractUrl = authenticatedContract.ContractDocumentUrl;
            logger.info(`[PUBLIC-ONBOARDING] ✅ Authenticated primary contract URL`);
        }

        res.json({
            success: true,
            data: {
                LinkId: linkData.LinkId,
                LinkName: linkData.LinkName,
                LinkToken: linkData.LinkToken,
                TenantName: linkData.TenantName,
                CommissionCodes: commissionCodes,
                ContractDocumentId: linkData.ContractDocumentId,
                ContractFileName: linkData.ContractFileName,
                ContractDocumentUrl: authenticatedContractUrl,
                AgentAgreementDocuments: authenticatedDocuments
            }
        });

    } catch (error) {
        logger.error('[PUBLIC-ONBOARDING] !! Error getting link details:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get link details',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

/**
 * @route   POST /api/public/onboarding/validate-code
 * @desc    Validate a commission code against a specific link
 * @access  Public (no authentication required)
 */
router.post('/validate-code', async (req, res) => {
    logger.info('[PUBLIC-ONBOARDING] >> Validating commission code');
    
    try {
        const { linkToken, commissionCode, sessionToken } = req.body;

        if (!linkToken || !commissionCode) {
            return res.status(400).json({
                success: false,
                message: 'Link token and commission code are required'
            });
        }

        const pool = await getPool();

        // Validate link exists and is active (simplified validation for now)
        const result = await pool.request()
            .input('LinkToken', sql.NVarChar, linkToken)
            .query(`
                SELECT 
                    aol.LinkId,
                    aol.LinkToken,
                    aol.IsActive,
                    aol.LinkName,
                    aol.TenantId,
                    aol.AgencyId
                FROM oe.AgentOnboardingLinks aol
                WHERE aol.LinkToken = @LinkToken 
                AND aol.IsActive = 1
            `);

        if (result.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Invalid or inactive link'
            });
        }

        const linkData = result.recordset[0];
        
        // Lookup the commission code and get the associated commission rule
        console.log('🔍 [VALIDATE-CODE] Looking up commission code:', {
            linkId: linkData.LinkId,
            commissionCode: commissionCode.toUpperCase()
        });
        
        const codeResult = await pool.request()
            .input('LinkId', sql.UniqueIdentifier, linkData.LinkId)
            .input('CommissionCode', sql.NVarChar, commissionCode.toUpperCase())
            .query(`
                SELECT 
                    olcc.CodeId,
                    olcc.CommissionCode,
                    olcc.CommissionGroupId,
                    olcc.GrantTierLevel,
                    cg.Name AS CommissionGroupName
                FROM oe.OnboardingLinkCommissionCodes olcc
                LEFT JOIN oe.CommissionGroups cg ON olcc.CommissionGroupId = cg.CommissionGroupId
                WHERE olcc.LinkId = @LinkId
                AND olcc.CommissionCode = @CommissionCode
                AND olcc.IsActive = 1
            `);

        if (codeResult.recordset.length === 0) {
            console.log('❌ [VALIDATE-CODE] Commission code not found or inactive');
            return res.status(400).json({
                success: false,
                message: 'Invalid commission code for this link'
            });
        }

        const row = codeResult.recordset[0];
        const commissionGroupId = row.CommissionGroupId || null;

        if (!linkData.IsActive) {
            return res.status(400).json({
                success: false,
                message: 'This onboarding link is inactive'
            });
        }

        if (row.GrantTierLevel !== null && row.GrantTierLevel !== undefined) {
            const tierCheck = await assertGrantTierAllowed(pool, {
                tenantId: linkData.TenantId,
                agencyId: linkData.AgencyId || null,
                grantTierLevel: row.GrantTierLevel
            });
            if (!tierCheck.valid) {
                return res.status(400).json({
                    success: false,
                    message: 'This commission code is no longer valid for onboarding.'
                });
            }
        }

        logger.info(`[PUBLIC-ONBOARDING] << Commission code validated for link: ${linkToken}`);
        console.log('✅ [VALIDATE-CODE] Commission code validated:', {
            code: commissionCode.toUpperCase(),
            commissionGroupId,
            commissionGroupName: row.CommissionGroupName || null
        });

        if (sessionToken) {
            const existingSessionResult = await pool.request()
                .input('SessionToken', sql.NVarChar, sessionToken)
                .query(`
                    SELECT AgentData
                    FROM oe.AgentOnboardingSessions
                    WHERE SessionToken = @SessionToken
                `);

            const existingAgentData = parseAgentDataJson(existingSessionResult.recordset?.[0]?.AgentData);
            const mergedAgentData = {
                ...existingAgentData,
                commissionContext: {
                    validatedCodeId: row.CodeId,
                    validatedCommissionCode: commissionCode.toUpperCase(),
                    validatedGrantTierLevel: row.GrantTierLevel != null ? Number(row.GrantTierLevel) : 0,
                    validatedAt: new Date().toISOString()
                }
            };

            const updateReq = pool.request()
                .input('SessionToken', sql.NVarChar, sessionToken)
                .input('CommissionCode', sql.NVarChar, commissionCode.toUpperCase())
                .input('CommissionGroupId', sql.UniqueIdentifier, commissionGroupId)
                .input('AgentData', sql.NVarChar, JSON.stringify(mergedAgentData));
            await updateReq.query(`
                UPDATE oe.AgentOnboardingSessions
                SET CommissionGroupId = @CommissionGroupId,
                    CommissionCode = @CommissionCode,
                    AgentData = @AgentData
                WHERE SessionToken = @SessionToken
            `);
            console.log('✅ [VALIDATE-CODE] Session updated');
        }

        res.json({
            success: true,
            data: {
                linkId: linkData.LinkId,
                linkToken: linkData.LinkToken,
                commissionCode: commissionCode.toUpperCase(),
                commissionGroupId: commissionGroupId,
                commissionGroupName: row.CommissionGroupName || null,
                isValid: true
            }
        });

    } catch (error) {
        logger.error('[PUBLIC-ONBOARDING] !! Error validating commission code:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to validate commission code',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

/**
 * @route   POST /api/public/onboarding/start-session
 * @desc    Start a new onboarding session
 * @access  Public (no authentication required)
 */
router.post('/start', async (req, res) => {
    logger.info('[PUBLIC-ONBOARDING] >> Starting onboarding session');
    
    try {
        const { linkToken } = req.body;
        const ipAddress = req.ip || req.connection.remoteAddress;
        const userAgent = req.get('User-Agent');

        if (!linkToken) {
            return res.status(400).json({
                success: false,
                message: 'Link token is required'
            });
        }

        const pool = await getPool();

        // Verify link exists and is active (tenant-level control); get TenantId for rule lookup
        const linkCheck = await pool.request()
            .input('linkToken', sql.NVarChar, linkToken)
            .query(`
                SELECT LinkId, TenantId, IsActive 
                FROM oe.AgentOnboardingLinks 
                WHERE LinkToken = @linkToken
            `);

        if (linkCheck.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Invalid onboarding link'
            });
        }

        if (!linkCheck.recordset[0].IsActive) {
            return res.status(400).json({
                success: false,
                message: 'Onboarding link is inactive'
            });
        }

        const linkId = linkCheck.recordset[0].LinkId;
        const tenantId = linkCheck.recordset[0].TenantId;

        // Commission Groups: group selection is resolved at sale time (agent -> upline -> agency).
        // Onboarding sessions record the selected CommissionCode and optional CommissionGroupId when a code is validated.

        // Generate secure session token
        const sessionToken = crypto.randomBytes(32).toString('hex');

        // Start onboarding session: use stored procedure when present, else inline INSERT (e.g. dev DB without SP)
        let sessionData;
        try {
            const sessionResult = await pool.request()
                .input('LinkId', sql.UniqueIdentifier, linkId)
                .input('SessionToken', sql.NVarChar, sessionToken)
                .input('IPAddress', sql.NVarChar, ipAddress || null)
                .input('UserAgent', sql.NVarChar, userAgent || null)
                .execute('oe.sp_StartOnboardingSession');
            sessionData = sessionResult.recordset?.[0];
        } catch (spErr) {
            const msg = (spErr?.originalError?.info?.message || spErr?.message || '').toString();
            if (msg.includes('sp_StartOnboardingSession') || msg.includes('stored procedure')) {
                logger.warn('[PUBLIC-ONBOARDING] Stored procedure not found, using inline INSERT');
                const inlineResult = await pool.request()
                    .input('LinkId', sql.UniqueIdentifier, linkId)
                    .input('SessionToken', sql.NVarChar, sessionToken)
                    .input('IPAddress', sql.NVarChar, ipAddress || null)
                    .input('UserAgent', sql.NVarChar, userAgent || null)
                    .query(`
                        INSERT INTO oe.AgentOnboardingSessions (LinkId, SessionToken, IPAddress, UserAgent, ExpiresDate)
                        OUTPUT INSERTED.SessionId, INSERTED.SessionToken, INSERTED.Status, INSERTED.StartedDate, INSERTED.ExpiresDate
                        VALUES (@LinkId, @SessionToken, @IPAddress, @UserAgent, NULL)
                    `);
                sessionData = inlineResult.recordset?.[0];
            } else {
                throw spErr;
            }
        }
        if (!sessionData || !sessionData.SessionId) {
            logger.error('[PUBLIC-ONBOARDING] Session did not return session data');
            return res.status(500).json({
                success: false,
                message: 'Failed to start onboarding session',
                error: process.env.NODE_ENV === 'development' ? 'No session returned from database' : undefined
            });
        }

        // Do not set CommissionRuleId on session (deprecated). CommissionGroupId is set on validate-code when applicable.

        logger.info(`[PUBLIC-ONBOARDING] << Started onboarding session: ${sessionData.SessionId}`);
        
        res.json({
            success: true,
            data: {
                sessionId: sessionData.SessionId,
                sessionToken: sessionData.SessionToken,
                status: sessionData.Status,
                startedDate: sessionData.StartedDate,
                expiresDate: sessionData.ExpiresDate
            }
        });

    } catch (error) {
        const sqlErr = error?.originalError?.info?.message || error?.originalError?.message;
        const errMsg = error?.message || String(error);
        logger.error('[PUBLIC-ONBOARDING] !! Error starting onboarding session:', { message: errMsg, sqlMessage: sqlErr, stack: error?.stack });
        res.status(500).json({
            success: false,
            message: 'Failed to start onboarding session',
            error: process.env.NODE_ENV === 'development' ? (sqlErr || errMsg) : undefined
        });
    }
});

/**
 * @route   POST /api/public/onboarding/save-progress
 * @desc    Save onboarding progress (partial data)
 * @access  Public (no authentication required)
 */
router.post('/save-progress', async (req, res) => {
    logger.info('[PUBLIC-ONBOARDING] >> Saving onboarding progress');
    
    try {
        const { sessionToken, currentStep, agentData } = req.body;

        if (!sessionToken || currentStep === undefined) {
            return res.status(400).json({
                success: false,
                message: 'Session token and current step are required'
            });
        }

        const pool = await getPool();

        // Verify session exists and is valid
        const sessionCheck = await pool.request()
            .input('sessionToken', sql.NVarChar, sessionToken)
            .query(`
                SELECT SessionId, Status, ExpiresDate, AgentData 
                FROM oe.AgentOnboardingSessions 
                WHERE SessionToken = @sessionToken
            `);

        if (sessionCheck.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Invalid session token'
            });
        }

        const session = sessionCheck.recordset[0];

        // Check if session is expired (only if ExpiresDate is not NULL)
        if (session.ExpiresDate && new Date() > new Date(session.ExpiresDate)) {
            // Update session status to expired
            await pool.request()
                .input('sessionId', sql.UniqueIdentifier, session.SessionId)
                .query(`
                    UPDATE oe.AgentOnboardingSessions 
                    SET Status = 'Expired' 
                    WHERE SessionId = @sessionId
                `);

            return res.status(400).json({
                success: false,
                message: 'Session has expired'
            });
        }

        // Update session progress
        const updateQuery = `
            UPDATE oe.AgentOnboardingSessions 
            SET AgentData = @agentData,
                Status = CASE WHEN @currentStep >= 3 THEN 'InProgress' ELSE Status END,
                ModifiedDate = GETDATE()
            WHERE SessionToken = @sessionToken
        `;

        const existingAgentData = parseAgentDataJson(session.AgentData);
        const incomingAgentData = agentData && typeof agentData === 'object' ? agentData : {};
        const mergedAgentData = {
            ...existingAgentData,
            ...incomingAgentData
        };

        await pool.request()
            .input('sessionToken', sql.NVarChar, sessionToken)
            .input('agentData', sql.NVarChar, JSON.stringify(mergedAgentData))
            .input('currentStep', sql.Int, currentStep)
            .query(updateQuery);

        logger.info(`[PUBLIC-ONBOARDING] << Saved progress for session: ${session.SessionId}`);
        
        res.json({
            success: true,
            message: 'Progress saved successfully'
        });

    } catch (error) {
        logger.error('[PUBLIC-ONBOARDING] !! Error saving onboarding progress:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to save progress',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

/**
 * @route   POST /api/public/onboarding/complete
 * @desc    Complete the onboarding process, create agent account, and send verification email
 * @access  Public (no authentication required)
 */
router.post('/complete', async (req, res) => {
    console.log('🚀 [COMPLETE] Starting onboarding completion...');
    
    try {
        console.log('🔍 [COMPLETE] Extracting request body...');
        const { 
            sessionToken, 
            agentData, 
            digitalSignature,
            signatureDate 
        } = req.body;

        // Extract documentUrls from agentData (frontend sends it nested)
        const documentUrls = agentData?.documentUrls || [];
        const documentsWithLicenseMetadata = agentData?.documentsWithLicenseMetadata || [];
        console.log('✅ [COMPLETE] Request body extracted successfully');

        console.log('[PUBLIC-ONBOARDING] >> Received complete request:', {
            sessionToken: sessionToken ? 'present' : 'missing',
            agentData: agentData ? 'present' : 'missing',
            digitalSignature: digitalSignature ? 'present' : 'missing',
            signatureDate: signatureDate || 'missing',
            documentCount: documentUrls ? documentUrls.length : 0,
            documentUrlsArray: documentUrls,
            documentsWithLicenseMetadata: documentsWithLicenseMetadata,
            npn: agentData?.npn || agentData?.NPN || agentData?.Npn,
            accountType: agentData?.accountType,
            accountTypeDetail: agentData?.accountTypeDetail,
            bankInfo: {
                bankName: agentData?.bankName,
                hasRoutingNumber: !!agentData?.routingNumber,
                hasAccountNumber: !!agentData?.accountNumber,
                routingLength: agentData?.routingNumber ? agentData.routingNumber.length : 0,
                accountLength: agentData?.accountNumber ? agentData.accountNumber.length : 0
            },
            email: agentData?.email
        });

        console.log('🔍 [COMPLETE] Validating required fields...');
        if (!sessionToken || !agentData) {
            return res.status(400).json({
                success: false,
                message: 'Session token and agent data are required'
            });
        }

        console.log('🔍 [COMPLETE] Getting database pool...');
        const pool = await getPool();
        console.log('✅ [COMPLETE] Database pool obtained');

        // Verify session exists and is valid
        console.log('🔍 [COMPLETE] Looking up session...');
        
        const sessionCheck = await pool.request()
            .input('sessionToken', sql.NVarChar, sessionToken)
            .query(`
                SELECT 
                    aos.SessionId,
                    aos.LinkId,
                    aos.Status,
                    aos.ExpiresDate,
                    aos.AgentData,
                    aos.CommissionGroupId,
                    aos.CommissionCode,
                    aol.TenantId,
                    aol.AgencyId,
                    aol.AgentId as LinkAgentId,
                    aol.LinkName,
                    aol.LinkToken
                FROM oe.AgentOnboardingSessions aos
                INNER JOIN oe.AgentOnboardingLinks aol ON aos.LinkId = aol.LinkId
                WHERE aos.SessionToken = @sessionToken
            `);

        logger.info('[PUBLIC-ONBOARDING] >> Session lookup result:', { 
            recordCount: sessionCheck.recordset.length,
            sessionExists: sessionCheck.recordset.length > 0
        });

        if (sessionCheck.recordset.length === 0) {
            logger.warn('[PUBLIC-ONBOARDING] >> Session not found:', { sessionToken });
            return res.status(404).json({
                success: false,
                message: 'Invalid session token'
            });
        }

        const session = sessionCheck.recordset[0];
        const sessionAgentData = parseAgentDataJson(session.AgentData);
        console.log('✅ [COMPLETE] Session found:', { 
            sessionId: session.SessionId,
            tenantId: session.TenantId,
            agencyId: session.AgencyId,
            status: session.Status,
            linkName: session.LinkName,
            linkToken: session.LinkToken
        });

        // Check if session is expired (only if ExpiresDate is not NULL)
        if (session.ExpiresDate && new Date() > new Date(session.ExpiresDate)) {
            await pool.request()
                .input('sessionId', sql.UniqueIdentifier, session.SessionId)
                .query(`
                    UPDATE oe.AgentOnboardingSessions 
                    SET Status = 'Expired' 
                    WHERE SessionId = @sessionId
                `);

            return res.status(400).json({
                success: false,
                message: 'Session has expired'
            });
        }

        // Check if session is already completed
        if (session.Status === 'Completed') {
            return res.status(400).json({
                success: false,
                message: 'Onboarding session already completed'
            });
        }

        // Validate required agent data
        const requiredFields = ['firstName', 'lastName', 'email', 'phone', 'address', 'city', 'state', 'zip'];
        const missingFields = requiredFields.filter(field => !agentData[field]);
        
        if (missingFields.length > 0) {
            return res.status(400).json({
                success: false,
                message: `Missing required fields: ${missingFields.join(', ')}`
            });
        }

        // Check if email already exists and if they're already an agent
        logger.info('[PUBLIC-ONBOARDING] >> Checking if email already exists and agent status:', { 
            email: agentData.email,
            emailLength: agentData.email ? agentData.email.length : 0
        });
        
        const emailCheck = await pool.request()
            .input('email', sql.NVarChar, agentData.email)
            .query(`
                SELECT 
                    u.UserId, 
                    u.FirstName, 
                    u.LastName, 
                    u.Email, 
                    u.PasswordHash,
                    u.Status as UserStatus,
                    a.AgentId,
                    a.Status as AgentStatus
                FROM oe.Users u
                LEFT JOIN oe.Agents a ON u.UserId = a.UserId
                WHERE u.Email = @email
            `);

        const existingUser = emailCheck.recordset.length > 0 ? emailCheck.recordset[0] : null;
        
        logger.info('[PUBLIC-ONBOARDING] >> Email check result:', { 
            emailExists: !!existingUser,
            hasPassword: existingUser ? !!existingUser.PasswordHash : false,
            isAlreadyAgent: existingUser ? !!existingUser.AgentId : false,
            userId: existingUser?.UserId,
            agentId: existingUser?.AgentId,
            agentStatus: existingUser?.AgentStatus
        });

        // If user is already an active agent, reject the onboarding
        if (existingUser && existingUser.AgentId) {
            logger.warn('[PUBLIC-ONBOARDING] >> User is already registered as an agent:', { 
                email: agentData.email,
                agentId: existingUser.AgentId,
                agentStatus: existingUser.AgentStatus
            });
            return res.status(400).json({
                success: false,
                message: 'This email is already registered as an agent. Please log in to your existing account or contact support if you need assistance.',
                isAlreadyAgent: true
            });
        }

        // Generate email verification token (link expires in 3 days by default; configurable via env AGENT_VERIFICATION_LINK_EXPIRY_HOURS)
        const verificationToken = crypto.randomBytes(32).toString('hex');
        const expiryHours = parseInt(process.env.AGENT_VERIFICATION_LINK_EXPIRY_HOURS || '72', 10) || 72;
        const verificationExpiry = new Date(Date.now() + expiryHours * 60 * 60 * 1000);

        // Begin transaction for agent creation
        logger.info('[PUBLIC-ONBOARDING] >> Starting database transaction');
        const transaction = pool.transaction();
        await transaction.begin();
        logger.info('[PUBLIC-ONBOARDING] >> Transaction started successfully');

        try {
            let userId;
            let isExistingUser = false;
            
            // Handle existing vs new user
            if (existingUser) {
                // User already exists - use existing account and update if needed
                userId = existingUser.UserId;
                isExistingUser = true;
                logger.info('[PUBLIC-ONBOARDING] >> Using existing user account:', { 
                    userId,
                    currentStatus: existingUser.UserStatus,
                    hasPassword: !!existingUser.PasswordHash
                });
                
                // Update user info with new data from onboarding (in case they want to update their info)
                // But preserve their existing password if they have one
                logger.info('[PUBLIC-ONBOARDING] >> Updating existing user with onboarding data...');
                await transaction.request()
                    .input('userId', sql.UniqueIdentifier, userId)
                    .input('firstName', sql.NVarChar, agentData.firstName)
                    .input('lastName', sql.NVarChar, agentData.lastName)
                    .input('phoneNumber', sql.NVarChar, agentData.phone || null)
                    .input('modifiedDate', sql.DateTime2, new Date())
                    .query(`
                        UPDATE oe.Users SET
                            FirstName = @firstName,
                            LastName = @lastName,
                            PhoneNumber = @phoneNumber,
                            ModifiedDate = @modifiedDate
                        WHERE UserId = @userId
                    `);
                logger.info('[PUBLIC-ONBOARDING] >> ✅ Existing user updated with new info');
            } else {
                // Create new user account (without password - will be set after verification)
                userId = uuidv4();
                
                logger.info('[PUBLIC-ONBOARDING] >> Creating new user account:', {
                    userId,
                    firstName: agentData.firstName,
                    lastName: agentData.lastName,
                    email: agentData.email,
                    phoneNumber: agentData.phone || null,
                    userType: 'Agent',
                    tenantId: session.TenantId,
                    status: 'Pending', // Pending until email verified
                    createdBy: userId,
                    modifiedBy: userId
                });
                
                logger.info('[PUBLIC-ONBOARDING] >> Executing Users INSERT query...');
                await transaction.request()
                    .input('userId', sql.UniqueIdentifier, userId)
                    .input('firstName', sql.NVarChar, agentData.firstName)
                    .input('lastName', sql.NVarChar, agentData.lastName)
                    .input('email', sql.NVarChar, agentData.email)
                    .input('phoneNumber', sql.NVarChar, agentData.phone || null)
                    .input('passwordHash', sql.NVarChar, null) // No password yet
                    .input('tenantId', sql.UniqueIdentifier, session.TenantId)
                    .input('status', sql.NVarChar, 'Pending') // Pending verification
                    .input('createdDate', sql.DateTime2, new Date())
                    .input('modifiedDate', sql.DateTime2, new Date())
                    .input('createdBy', sql.UniqueIdentifier, userId) // Self-created
                    .input('modifiedBy', sql.UniqueIdentifier, userId) // Self-modified
                    .query(`
                        INSERT INTO oe.Users (
                            UserId, FirstName, LastName, Email, PhoneNumber, PasswordHash,
                            TenantId, Status, CreatedDate, ModifiedDate, CreatedBy, ModifiedBy
                        ) VALUES (
                            @userId, @firstName, @lastName, @email, @phoneNumber, @passwordHash,
                            @tenantId, @status, @createdDate, @modifiedDate, @createdBy, @modifiedBy
                        )
                    `);
                logger.info('[PUBLIC-ONBOARDING] >> Users INSERT query completed successfully');
                logger.info('[PUBLIC-ONBOARDING] >> ✅ User account created successfully (pending verification)');
            }

            // Create agent record (pending until verification)
            const agentId = uuidv4();
            logger.info('[PUBLIC-ONBOARDING] >> Creating agent record:', {
                agentId,
                userId,
                tenantId: session.TenantId,
                agencyId: session.AgencyId || null,
            commissionGroupId: session.CommissionGroupId || null,
                status: 'Pending', // Pending until email verified
                createdBy: userId,
                modifiedBy: userId,
                hasAgencyId: !!session.AgencyId,
            hasCommissionGroupId: !!session.CommissionGroupId
            });
            logger.info('[PUBLIC-ONBOARDING] >> Executing Agents INSERT query...');
            let grantTierLevel = 0;
            const validatedGrantTierLevel = Number(sessionAgentData?.commissionContext?.validatedGrantTierLevel);
            if (Number.isFinite(validatedGrantTierLevel)) {
                grantTierLevel = validatedGrantTierLevel;
                logger.info('[PUBLIC-ONBOARDING] >> Granting agent CommissionTierLevel from validated session snapshot:', grantTierLevel);
            } else if (session.LinkId && session.CommissionCode) {
                const tierResult = await transaction.request()
                    .input('linkId', sql.UniqueIdentifier, session.LinkId)
                    .input('commissionCode', sql.NVarChar, String(session.CommissionCode).toUpperCase())
                    .query(`
                        SELECT TOP 1 GrantTierLevel
                        FROM oe.OnboardingLinkCommissionCodes
                        WHERE LinkId = @linkId
                          AND CommissionCode = @commissionCode
                          AND IsActive = 1
                        ORDER BY ModifiedDate DESC, CreatedDate DESC
                    `);
                if (tierResult.recordset.length > 0 && tierResult.recordset[0].GrantTierLevel != null) {
                    grantTierLevel = tierResult.recordset[0].GrantTierLevel;
                    logger.info('[PUBLIC-ONBOARDING] >> Granting agent CommissionTierLevel from active link code:', grantTierLevel);
                } else {
                    logger.info('[PUBLIC-ONBOARDING] >> No GrantTierLevel on link code, using default CommissionTierLevel: 0 (Agent)');
                }
            }

            const tierCheckComplete = await assertGrantTierAllowed(transaction, {
                tenantId: session.TenantId,
                agencyId: session.AgencyId || null,
                grantTierLevel
            });
            if (!tierCheckComplete.valid) {
                throw new Error(
                    tierCheckComplete.message ||
                        'Commission tier from this onboarding code is no longer valid.'
                );
            }

            const agentRequest = transaction.request()
                .input('agentId', sql.UniqueIdentifier, agentId)
                .input('userId', sql.UniqueIdentifier, userId)
                .input('tenantId', sql.UniqueIdentifier, session.TenantId)
                .input('agencyId', sql.UniqueIdentifier, session.AgencyId || null)
                .input('commissionRuleId', sql.UniqueIdentifier, null)
                .input('commissionGroupId', sql.UniqueIdentifier, session.CommissionGroupId || null)
                .input('status', sql.NVarChar, 'Pending') // Pending until email verified
                .input('agentType', sql.NVarChar, 'Individual')
                .input('npn', sql.NVarChar, agentData.npn || null)
                .input('phone', sql.NVarChar, agentData.phone || null)
                .input('email', sql.NVarChar, agentData.email || null)
                .input('firstName', sql.NVarChar, agentData.firstName || null)
                .input('lastName', sql.NVarChar, agentData.lastName || null)
                .input('address1', sql.NVarChar, agentData.address || null)
                .input('address2', sql.NVarChar, agentData.address2 || null)
                .input('city', sql.NVarChar, agentData.city || null)
                .input('state', sql.Char, agentData.state || null)
                .input('zipCode', sql.NVarChar, agentData.zip || null)
                .input('ssnOrTaxId', sql.NVarChar, agentData.taxId || null)
                .input('businessName', sql.NVarChar, agentData.companyName || null)
                .input('createdDate', sql.DateTime2, new Date())
                .input('modifiedDate', sql.DateTime2, new Date())
                .input('createdBy', sql.UniqueIdentifier, userId)
                .input('modifiedBy', sql.UniqueIdentifier, userId);
            agentRequest.input('commissionTierLevel', TIER_SQL, grantTierLevel);
            const newAgentCode = await generateAgentCode(transaction, session.TenantId);
            agentRequest.input('agentCode', sql.NVarChar(50), newAgentCode);
            const insertColumns = [
                'AgentId', 'UserId', 'TenantId', 'AgencyId', 'CommissionRuleId', 'CommissionGroupId', 'Status', 'AgentType', 'NPN',
                'Phone', 'Email', 'FirstName', 'LastName', 'Address1', 'Address2',
                'City', 'State', 'ZipCode', 'SSNOrTaxID', 'BusinessName',
                'CommissionTierLevel', 'AgentCode',
                'CreatedDate', 'ModifiedDate', 'CreatedBy', 'ModifiedBy'
            ];
            const insertValues = [
                '@agentId', '@userId', '@tenantId', '@agencyId', '@commissionRuleId', '@commissionGroupId', '@status', '@agentType', '@npn',
                '@phone', '@email', '@firstName', '@lastName', '@address1', '@address2',
                '@city', '@state', '@zipCode', '@ssnOrTaxId', '@businessName',
                '@commissionTierLevel', '@agentCode',
                '@createdDate', '@modifiedDate', '@createdBy', '@modifiedBy'
            ];
            await agentRequest.query(`
                INSERT INTO oe.Agents (
                    ${insertColumns.join(', ')}
                ) VALUES (
                    ${insertValues.join(', ')}
                )
            `);
            logger.info('[PUBLIC-ONBOARDING] >> Agents INSERT query completed successfully');

            logger.info('[PUBLIC-ONBOARDING] >> ✅ Agent record created successfully');

            // Create or update agent bank info record (wrapped in try-catch to not fail entire onboarding)
            console.log('🏦 [BANK-CHECK] Checking bank info data:', {
                hasBankName: !!agentData.bankName,
                hasAccountNumber: !!agentData.accountNumber,
                hasRoutingNumber: !!agentData.routingNumber,
                bankName: agentData.bankName,
                routingLength: agentData.routingNumber ? agentData.routingNumber.length : 0,
                accountLength: agentData.accountNumber ? agentData.accountNumber.length : 0
            });
            
            // Map frontend fields to database fields BEFORE try block:
            // accountType (Business/Individual) -> AccountHolderType
            // accountTypeDetail (Checking/Savings) -> AccountType
            const accountHolderType = agentData.accountType || 'Individual';
            const accountType = agentData.accountTypeDetail || 'Checking';
            
            if (agentData.bankName && agentData.accountNumber && agentData.routingNumber) {
                try {
                    // Check if agent already has bank info (for existing users)
                    const existingBankCheck = await transaction.request()
                        .input('agentId', sql.UniqueIdentifier, agentId)
                        .query(`
                            SELECT BankInfoId FROM oe.AgentBankInfo 
                            WHERE AgentId = @agentId AND Status = 'Active'
                        `);
                    
                    if (existingBankCheck.recordset.length > 0) {
                        logger.info('[PUBLIC-ONBOARDING] >> Agent already has bank info, skipping bank info creation');
                    } else {
                    // Validate routing number (must be exactly 9 digits)
                    const routingNumber = agentData.routingNumber.replace(/\D/g, '');
                    if (routingNumber.length !== 9) {
                        throw new Error(`Invalid routing number: must be exactly 9 digits (received ${routingNumber.length})`);
                    }
                    
                    // Validate account number (must be at least 4 digits for last4)
                    const accountNumber = agentData.accountNumber.replace(/\D/g, '');
                    if (accountNumber.length < 4) {
                        throw new Error(`Invalid account number: must be at least 4 digits (received ${accountNumber.length})`);
                    }
                    
                    const bankInfoId = uuidv4();
                    
                    logger.info('[PUBLIC-ONBOARDING] >> Creating agent bank info record:', {
                        bankInfoId,
                        agentId,
                        bankName: agentData.bankName,
                        accountHolderType: accountHolderType,
                        accountType: accountType
                    });
                    
                    await transaction.request()
                        .input('bankInfoId', sql.UniqueIdentifier, bankInfoId)
                        .input('agentId', sql.UniqueIdentifier, agentId)
                        .input('bankName', sql.NVarChar, agentData.bankName)
                        .input('accountName', sql.NVarChar, `${agentData.firstName} ${agentData.lastName}`)
                        .input('accountHolderType', sql.NVarChar, accountHolderType)
                        .input('accountType', sql.NVarChar, accountType)
                        .input('routingNumber', sql.NVarChar, routingNumber)
                        // Encrypt account number with AES-256-GCM (consistent with all other bank-info paths)
                        .input('accountNumberEncrypted', sql.NVarChar, encryptionService.encrypt(accountNumber))
                        .input('accountNumberLast4', sql.NVarChar, accountNumber.slice(-4))
                        .input('status', sql.NVarChar, 'Active')
                        .input('isDefault', sql.Bit, 1)
                        .input('verificationStatus', sql.NVarChar, 'Pending')
                        .input('createdDate', sql.DateTime2, new Date())
                        .input('modifiedDate', sql.DateTime2, new Date())
                        .input('createdBy', sql.UniqueIdentifier, userId)
                        .input('modifiedBy', sql.UniqueIdentifier, userId)
                        .query(`
                            INSERT INTO oe.AgentBankInfo (
                                BankInfoId, AgentId, BankName, AccountName, AccountHolderType, AccountType,
                                RoutingNumber, AccountNumberEncrypted, AccountNumberLast4,
                                Status, IsDefault, VerificationStatus, CreatedDate, ModifiedDate, CreatedBy, ModifiedBy
                            ) VALUES (
                                @bankInfoId, @agentId, @bankName, @accountName, @accountHolderType, @accountType,
                                @routingNumber, @accountNumberEncrypted, @accountNumberLast4,
                                @status, @isDefault, @verificationStatus, @createdDate, @modifiedDate, @createdBy, @modifiedBy
                            )
                        `);
                    logger.info('[PUBLIC-ONBOARDING] >> ✅ Agent bank info created successfully');
                    }
                } catch (bankError) {
                    console.error('❌ [BANK-ERROR] Failed to create bank info:', {
                        error: bankError.message,
                        sqlMessage: bankError.originalError?.info?.message,
                        sqlState: bankError.originalError?.info?.state,
                        sqlNumber: bankError.originalError?.info?.number,
                        sqlClass: bankError.originalError?.info?.class,
                        sqlLineNumber: bankError.originalError?.info?.lineNumber,
                        constraintName: bankError.code,
                        accountType: agentData.accountType || 'Checking',
                        accountHolderType: accountHolderType,
                        rawBankData: {
                            bankName: agentData.bankName,
                            routingNumber: agentData.routingNumber,
                            accountNumber: agentData.accountNumber,
                            routingNumberLength: agentData.routingNumber ? agentData.routingNumber.length : 0,
                            accountNumberLength: agentData.accountNumber ? agentData.accountNumber.length : 0
                        },
                        validatedBankData: {
                            routingNumber: typeof routingNumber !== 'undefined' ? routingNumber : 'not validated',
                            accountNumber: typeof accountNumber !== 'undefined' ? '***' + (accountNumber ? accountNumber.slice(-4) : '') : 'not validated',
                            routingNumberLength: typeof routingNumber !== 'undefined' ? routingNumber.length : 0,
                            accountNumberLength: typeof accountNumber !== 'undefined' ? accountNumber.length : 0,
                            accountType: accountType,
                            accountHolderType: accountHolderType
                        },
                        stack: bankError.stack
                    });
                    logger.error('[PUBLIC-ONBOARDING] >> ❌ Bank info creation failed - continuing without bank info', {
                        error: bankError.message,
                        sqlError: bankError.originalError?.info?.message,
                        agentId
                    });
                    // Continue with onboarding - bank info can be added later via Settings page
                }
            } else {
                console.log('⚠️ [BANK-SKIP] Skipping bank info creation - missing required fields');
            }

            // Create agent license records from documents with metadata
            if (documentsWithLicenseMetadata && documentsWithLicenseMetadata.length > 0) {
                try {
                    console.log('📜 [LICENSES] Creating agent license records from documents:', {
                        agentId,
                        licenseCount: documentsWithLicenseMetadata.length,
                        licenses: documentsWithLicenseMetadata.map(doc => ({
                            state: doc.state,
                            type: doc.licenseType,
                            fileName: doc.fileName
                        }))
                    });
                    
                    for (let i = 0; i < documentsWithLicenseMetadata.length; i++) {
                        const docMeta = documentsWithLicenseMetadata[i];
                        const licenseId = uuidv4();
                        
                        // Validate required fields
                        if (!docMeta.state || !docMeta.licenseType) {
                            console.warn('⚠️ [LICENSES] Skipping document without state or license type:', docMeta.fileName);
                            continue;
                        }
                        
                        console.log(`📜 [LICENSES] Creating license ${i + 1}:`, {
                            licenseId,
                            state: docMeta.state,
                            licenseType: docMeta.licenseType,
                            licenseNumber: docMeta.licenseNumber || null,
                            status: docMeta.status || 'Active',
                            residencyType: docMeta.residencyType || 'Resident',
                            documentUrl: docMeta.url ? docMeta.url.substring(0, 50) + '...' : 'none'
                        });
                        
                        await transaction.request()
                            .input('licenseId', sql.UniqueIdentifier, licenseId)
                            .input('agentId', sql.UniqueIdentifier, agentId)
                            .input('stateCode', sql.NVarChar, docMeta.state)
                            .input('licenseNumber', sql.NVarChar, docMeta.licenseNumber || null)
                            .input('licenseType', sql.NVarChar, docMeta.licenseType)
                            .input('effectiveDate', sql.Date, docMeta.issueDate || null) // Use issueDate as effectiveDate
                            .input('expirationDate', sql.Date, docMeta.expirationDate || null)
                            .input('issueDate', sql.Date, docMeta.issueDate || null)
                            .input('status', sql.NVarChar, docMeta.status || 'Active')
                            .input('residencyType', sql.NVarChar, docMeta.residencyType || 'Resident')
                            .input('loaIssueDate', sql.Date, docMeta.loaIssueDate || null)
                            .input('companyAppointmentDate', sql.Date, docMeta.companyAppointmentDate || null)
                            .input('renewalDate', sql.Date, docMeta.renewalDate || null)
                            .input('uploadedDocumentUrl', sql.NVarChar, docMeta.url)
                            .input('createdDate', sql.DateTime2, new Date())
                            .input('modifiedDate', sql.DateTime2, new Date())
                            .input('createdBy', sql.UniqueIdentifier, userId)
                            .input('modifiedBy', sql.UniqueIdentifier, userId)
                            .query(`
                                INSERT INTO oe.AgentLicenses (
                                    LicenseId, AgentId, StateCode, LicenseNumber, LicenseType,
                                    EffectiveDate, ExpirationDate, IssueDate, Status, ResidencyType,
                                    LOAIssueDate, CompanyAppointmentDate, RenewalDate,
                                    UploadedDocumentUrl, CreatedDate, ModifiedDate, CreatedBy, ModifiedBy
                                ) VALUES (
                                    @licenseId, @agentId, @stateCode, @licenseNumber, @licenseType,
                                    @effectiveDate, @expirationDate, @issueDate, @status, @residencyType,
                                    @loaIssueDate, @companyAppointmentDate, @renewalDate,
                                    @uploadedDocumentUrl, @createdDate, @modifiedDate, @createdBy, @modifiedBy
                                )
                            `);
                        
                        console.log(`✅ [LICENSES] License created successfully for ${docMeta.state} - ${docMeta.licenseType}`);
                    }
                    console.log('✅ [LICENSES] All agent licenses created successfully');
                } catch (licenseError) {
                    console.error('❌ [LICENSE-ERROR] Failed to create licenses:', {
                        error: licenseError.message,
                        sqlMessage: licenseError.originalError?.info?.message,
                        fullError: JSON.stringify(licenseError, null, 2)
                    });
                    // Continue with onboarding - licenses can be added later
                }
            } else if (documentUrls && documentUrls.length > 0) {
                // Fallback: If old format (just URLs without metadata), create generic documents
                console.warn('⚠️ [DOCUMENTS] Received documents without license metadata, creating generic documents');
                try {
                    for (let i = 0; i < documentUrls.length; i++) {
                        const documentId = uuidv4();
                        const documentUrl = documentUrls[i];
                        const fileName = `document_${i + 1}.pdf`;
                        
                        await transaction.request()
                            .input('documentId', sql.UniqueIdentifier, documentId)
                            .input('agentId', sql.UniqueIdentifier, agentId)
                            .input('documentType', sql.NVarChar, 'Professional')
                            .input('fileName', sql.NVarChar, fileName)
                            .input('fileUrl', sql.NVarChar, documentUrl)
                            .input('fileSize', sql.Int, 0)
                            .input('fileType', sql.NVarChar, 'application/pdf')
                            .input('description', sql.NVarChar, 'Agent onboarding document')
                            .input('status', sql.NVarChar, 'Active')
                            .input('createdDate', sql.DateTime2, new Date())
                            .input('modifiedDate', sql.DateTime2, new Date())
                            .input('createdBy', sql.UniqueIdentifier, userId)
                            .input('modifiedBy', sql.UniqueIdentifier, userId)
                            .query(`
                                INSERT INTO oe.AgentDocuments (
                                    DocumentId, AgentId, DocumentType, FileName, FileUrl,
                                    FileSize, FileType, Description, Status, CreatedDate, ModifiedDate, CreatedBy, ModifiedBy
                                ) VALUES (
                                    @documentId, @agentId, @documentType, @fileName, @fileUrl,
                                    @fileSize, @fileType, @description, @status, @createdDate, @modifiedDate, @createdBy, @modifiedBy
                                )
                            `);
                    }
                    console.log('✅ [DOCUMENTS] Generic documents created');
                } catch (docError) {
                    console.error('❌ [DOCUMENT-ERROR] Failed to create documents:', docError.message);
                }
            }

            // Note: License records are now created from uploaded documents with metadata above
            // No need to create a generic "Insurance Agent" license anymore
            console.log('✅ [LICENSES] License creation handled via document uploads with metadata');

            // Create agent hierarchy record (if it doesn't exist)
            // ParentId = Link's AgentId (upline agent), or AgencyId if no upline agent (direct to agency)
            try {
                // Check if hierarchy already exists for this agent
                const existingHierarchyCheck = await transaction.request()
                    .input('agentId', sql.UniqueIdentifier, agentId)
                    .query(`
                        SELECT HierarchyId FROM oe.AgentHierarchy 
                        WHERE AgentId = @agentId AND Status = 'Active'
                    `);
                
                if (existingHierarchyCheck.recordset.length > 0) {
                    logger.info('[PUBLIC-ONBOARDING] >> Agent already has hierarchy record, skipping hierarchy creation');
                } else {
                    const hierarchyId = uuidv4();
                    // ParentId should be the AgentId from the onboarding link (referring agent)
                    // If no referring agent is set on the link, use AgencyId as the parent (direct to agency)
                    const parentId = session.LinkAgentId || session.AgencyId;
                    const hierarchyType = 'Agent';
                    
                    console.log('🏢 [HIERARCHY] Creating agent hierarchy record:', {
                        hierarchyId,
                        agentId: agentId,
                        agencyId: session.AgencyId || null,
                        parentId: parentId,
                        linkAgentId: session.LinkAgentId || null,
                        tenantId: session.TenantId,
                        type: hierarchyType,
                        linkId: session.LinkId,
                        hasLinkAgent: !!session.LinkAgentId,
                        usingAgencyAsParent: !session.LinkAgentId
                    });
                
                    await transaction.request()
                        .input('hierarchyId', sql.UniqueIdentifier, hierarchyId)
                        .input('type', sql.NVarChar, hierarchyType)
                        .input('tenantId', sql.UniqueIdentifier, session.TenantId)
                        .input('agencyId', sql.UniqueIdentifier, session.AgencyId || null)
                        .input('agentId', sql.UniqueIdentifier, agentId)
                        .input('parentId', sql.UniqueIdentifier, parentId)
                        .input('status', sql.NVarChar, 'Active')
                        .input('createdDate', sql.DateTime2, new Date())
                        .input('modifiedDate', sql.DateTime2, new Date())
                        .query(`
                            INSERT INTO oe.AgentHierarchy (
                                HierarchyId, Type, TenantId, AgencyId, AgentId, ParentId,
                                Status, CreatedDate, ModifiedDate
                            ) VALUES (
                                @hierarchyId, @type, @tenantId, @agencyId, @agentId, @parentId,
                                @status, @createdDate, @modifiedDate
                            )
                        `);
                    console.log('✅ [HIERARCHY] Agent hierarchy created successfully');
                }
            } catch (hierarchyError) {
                console.error('❌ [HIERARCHY-ERROR] Failed to create hierarchy:', {
                    error: hierarchyError.message,
                    sqlMessage: hierarchyError.originalError?.info?.message,
                    fullError: JSON.stringify(hierarchyError, null, 2)
                });
                // Continue with onboarding - hierarchy can be added later
            }

            // Prepare complete agent data including signature and documents
            const completeAgentData = {
                ...agentData,
                userId: userId,
                agentId: agentId,
                digitalSignature: digitalSignature || null,
                signatureDate: signatureDate || null,
                documentUrls: documentUrls || []
            };

            // Update session with agent ID, verification token, and mark as pending verification
            await transaction.request()
                .input('sessionId', sql.UniqueIdentifier, session.SessionId)
                .input('agentId', sql.UniqueIdentifier, agentId)
                .input('agentData', sql.NVarChar, JSON.stringify(completeAgentData))
                .input('verificationToken', sql.NVarChar, verificationToken)
                .input('verificationExpiry', sql.DateTime2, verificationExpiry)
                .query(`
                    UPDATE oe.AgentOnboardingSessions 
                    SET AgentId = @agentId,
                        AgentData = @agentData,
                        Status = 'PendingVerification',
                        VerificationToken = @verificationToken,
                        VerificationTokenExpiry = @verificationExpiry,
                        ModifiedDate = GETUTCDATE()
                    WHERE SessionId = @sessionId
                `);

            // Increment usage count for the link
            console.log('📊 [COMPLETE] Incrementing link usage count...');
            await transaction.request()
                .input('linkId', sql.UniqueIdentifier, session.LinkId)
                .query(`
                    UPDATE oe.AgentOnboardingLinks 
                    SET CurrentUses = CurrentUses + 1,
                        ModifiedDate = GETDATE()
                    WHERE LinkId = @linkId
                `);

            console.log('💾 [COMPLETE] Committing transaction...');
            await transaction.commit();
            console.log('✅ [COMPLETE] Transaction committed successfully!');

            // Assign Agent role after commit (same pattern as tenant-admin agent create — avoids deadlock)
            try {
                logger.info('[PUBLIC-ONBOARDING] >> Assigning Agent role after user + agent creation...');
                await UserRolesService.assignRoleToUser(userId, 'Agent', userId);
                logger.info('[PUBLIC-ONBOARDING] >> ✅ Agent role assigned via UserRoles table');
            } catch (roleError) {
                logger.error('[PUBLIC-ONBOARDING] >> ⚠️ Failed to assign Agent role (assign manually if needed):', roleError.message);
            }

            // Get tenant information for email
            console.log('🌐 [COMPLETE] Getting tenant info for email...');
            let tenant = {};
            try {
                const tenantResult = await pool.request()
                    .input('tenantId', sql.UniqueIdentifier, session.TenantId)
                    .query(`
                        SELECT 
                            TenantId,
                            Name as TenantName,
                            CustomDomain
                        FROM oe.Tenants 
                        WHERE TenantId = @tenantId
                    `);

                tenant = tenantResult.recordset[0] || {};
            } catch (tenantError) {
                console.error('❌ [TENANT-ERROR] Failed to get tenant info:', {
                    error: tenantError.message,
                    tenantId: session.TenantId
                });
                // Continue anyway with empty tenant
            }
            console.log('✅ [COMPLETE] Tenant info retrieved:', {
                tenantId: tenant.TenantId,
                tenantName: tenant.TenantName,
                customDomain: tenant.CustomDomain
            });
            
            // Generate verification URL using referer header (similar to group onboarding)
            let verificationUrl;
            const referer = req.get('referer') || req.get('origin');
            let baseUrl;
            if (referer) {
                // Extract protocol and hostname from referer
                try {
                    const refererUrl = new URL(referer);
                    baseUrl = `${refererUrl.protocol}//${refererUrl.hostname}${refererUrl.port ? ':' + refererUrl.port : ''}`;
                } catch (urlError) {
                    console.warn('❌ Failed to parse referer URL:', referer);
                    baseUrl = null;
                }
            }
            
            if (!baseUrl) {
                // Use request origin if available, otherwise use tenant custom domain or default
                baseUrl = req.get('origin') || (tenant.CustomDomain ? `https://${tenant.CustomDomain}` : 'https://app.allaboard365.com');
            }
            
            verificationUrl = `${baseUrl}/public/agent-verification?token=${verificationToken}`;
            console.log('🌐 [COMPLETE] Generated verification URL:', verificationUrl);

            // Send verification email
            console.log('📧 [EMAIL] Sending verification email...');
            try {
                const EmailTemplatesService = require('../../services/emailTemplates.service');
                const MessageQueueService = require('../../services/messageQueue.service');
                
                // Generate HTML email from template (expiry text for email: 3 days when 72h, else derived from expiryHours)
                const expiryText = expiryHours >= 72 ? '3 days' : (expiryHours >= 24 ? `${Math.round(expiryHours / 24)} days` : `${expiryHours} hours`);
                const htmlContent = await EmailTemplatesService.generateAgentVerification({
                    tenantId: session.TenantId,
                    firstName: agentData.firstName,
                    verificationUrl: verificationUrl,
                    verificationLinkExpiryText: expiryText
                });
                
                await MessageQueueService.queueEmail({
                    tenantId: session.TenantId,
                    toEmail: agentData.email,
                    toName: `${agentData.firstName} ${agentData.lastName}`,
                    subject: `Verify Your Email - ${tenant.TenantName || 'Agent Onboarding'}`,
                    htmlContent: htmlContent,
                    messageType: 'Email',
                    createdBy: userId
                });
                console.log('✅ [EMAIL] Verification email queued successfully');
            } catch (emailError) {
                console.error('❌ [EMAIL-ERROR] Failed to send verification email:', emailError);
                // Don't fail the whole process if email fails
            }

            console.log(`✅ [COMPLETE] Onboarding data saved for agent: ${agentId}`);
            console.log(`📧 [COMPLETE] Verification email sent to: ${agentData.email}`);

            console.log('📤 [COMPLETE] Sending success response...');
            res.json({
                success: true,
                data: {
                    agentId,
                    userId,
                    email: agentData.email,
                    firstName: agentData.firstName,
                    lastName: agentData.lastName,
                    isExistingUser,
                    requiresPasswordConfirmation: isExistingUser && !!existingUser.PasswordHash,
                    tenantName: tenant.TenantName,
                    sessionToken: session.SessionToken,
                    message: 'Verification email sent. Please check your inbox to complete your account setup.'
                }
            });
            console.log('✅ [COMPLETE] Response sent successfully!');

        } catch (error) {
            console.error('❌ [TRANSACTION-ERROR] Transaction error:', {
                error: error.message,
                stack: error.stack,
                sessionToken: sessionToken ? 'present' : 'missing'
            });
            await transaction.rollback();
            throw error;
        }

    } catch (error) {
        console.error('❌ [COMPLETE-ERROR] Error completing onboarding:', {
            message: error.message,
            stack: error.stack,
            name: error.name,
            fullError: JSON.stringify(error, null, 2)
        });
        res.status(500).json({
            success: false,
            message: 'Failed to complete onboarding',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

/**
 * @route   GET /api/public/onboarding/session/:token
 * @desc    Get session details by token
 * @access  Public (no authentication required)
 */
router.get('/session/:token', async (req, res) => {
    logger.info(`[PUBLIC-ONBOARDING] >> Getting session details for token: ${req.params.token}`);
    
    try {
        const sessionToken = req.params.token;
        const pool = await getPool();

        const sessionQuery = `
            SELECT 
                aos.SessionId,
                aos.LinkId,
                aos.Status,
                aos.StartedDate,
                aos.ExpiresDate,
                aos.AgentData,
                aol.LinkName,
                t.Name as TenantName
            FROM oe.AgentOnboardingSessions aos
            INNER JOIN oe.AgentOnboardingLinks aol ON aos.LinkId = aol.LinkId
            INNER JOIN oe.Tenants t ON aol.TenantId = t.TenantId
            WHERE aos.SessionToken = @sessionToken
        `;

        const result = await pool.request()
            .input('sessionToken', sql.NVarChar, sessionToken)
            .query(sessionQuery);

        if (result.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Session not found'
            });
        }

        const session = result.recordset[0];

        // Check if session is expired (only if ExpiresDate is not NULL)
        if (session.ExpiresDate && new Date() > new Date(session.ExpiresDate)) {
            return res.status(400).json({
                success: false,
                message: 'Session has expired'
            });
        }

        logger.info(`[PUBLIC-ONBOARDING] << Retrieved session details: ${session.SessionId}`);
        
        res.json({
            success: true,
            data: {
                sessionId: session.SessionId,
                status: session.Status,
                startedDate: session.StartedDate,
                expiresDate: session.ExpiresDate,
                agentData: session.AgentData ? JSON.parse(session.AgentData) : null,
                linkName: session.LinkName,
                tenantName: session.TenantName
            }
        });

    } catch (error) {
        logger.error('[PUBLIC-ONBOARDING] !! Error getting session details:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get session details',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

/**
 * @route   POST /api/public/onboarding/verify-email
 * @desc    Verify email address using verification token
 * @access  Public (no authentication required)
 */
router.post('/verify-email', async (req, res) => {
    logger.info('[PUBLIC-ONBOARDING] >> Verifying email address');
    
    try {
        const { verificationToken } = req.body;
        
        if (!verificationToken) {
            return res.status(400).json({
                success: false,
                message: 'Verification token is required'
            });
        }

        const pool = await getPool();
        
        // Get session and agent data by verification token
        const sessionQuery = `
            SELECT 
                aos.SessionId,
                aos.AgentId,
                aos.LinkId,
                aos.AgentData,
                aos.VerificationTokenExpiry,
                aol.TenantId,
                t.Name as TenantName
            FROM oe.AgentOnboardingSessions aos
            INNER JOIN oe.AgentOnboardingLinks aol ON aos.LinkId = aol.LinkId
            INNER JOIN oe.Tenants t ON aol.TenantId = t.TenantId
            WHERE aos.VerificationToken = @verificationToken 
            AND aos.Status = 'PendingVerification'
        `;

        const sessionResult = await pool.request()
            .input('verificationToken', sql.NVarChar, verificationToken)
            .query(sessionQuery);

        // 404 = no session found for this token (wrong token, different env, or session no longer PendingVerification). NOT expiration.
        // 400 = session found but VerificationTokenExpiry is in the past (actual expiration; compare uses server time).
        if (sessionResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Invalid or expired verification token'
            });
        }

        const session = sessionResult.recordset[0];
        
        // Check if token is expired (session was found; expiry is compared in server time, so timezone is not the cause of 404)
        if (session.VerificationTokenExpiry && new Date() > new Date(session.VerificationTokenExpiry)) {
            return res.status(400).json({
                success: false,
                message: 'Verification token has expired. Please request a new one.'
            });
        }
        
        const agentData = JSON.parse(session.AgentData);
        const userId = agentData.userId;
        const agentId = session.AgentId;
        
        if (!userId || !agentId) {
            return res.status(400).json({
                success: false,
                message: 'Invalid session data'
            });
        }

        // Check if user exists and has password
        const userCheckQuery = `
            SELECT UserId, Email, PasswordHash, Status FROM oe.Users WHERE UserId = @userId
        `;
        
        const userCheckResult = await pool.request()
            .input('userId', sql.UniqueIdentifier, userId)
            .query(userCheckQuery);

        if (userCheckResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        const user = userCheckResult.recordset[0];
        const hasExistingPassword = !!user.PasswordHash;
        
        logger.info(`✅ Email verified successfully for: ${user.Email}`, {
            userId,
            hasExistingPassword,
            requiresPasswordConfirmation: hasExistingPassword
        });
        
        res.json({
            success: true,
            data: {
                userId,
                agentId,
                email: user.Email,
                firstName: agentData.firstName,
                lastName: agentData.lastName,
                tenantId: session.TenantId,
                tenantName: session.TenantName,
                hasExistingPassword,
                requiresPasswordConfirmation: hasExistingPassword,
                verificationToken // Return token for password setup step
            },
            message: 'Email verified successfully'
        });
        
    } catch (error) {
        logger.error('❌ Error verifying email:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to verify email',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

/**
 * @route   POST /api/public/onboarding/resend-verification
 * @desc    Resend verification email
 * @access  Public (no authentication required)
 */
router.post('/resend-verification', async (req, res) => {
    console.log('🔥🔥🔥 RESEND-VERIFICATION ROUTE HIT 🔥🔥🔥');
    console.log('Request body:', req.body);
    logger.info('[PUBLIC-ONBOARDING] >> Resending verification email');
    
    try {
        const { sessionToken } = req.body;
        
        console.log('📝 SessionToken received:', sessionToken ? sessionToken.substring(0, 20) + '...' : 'NONE');
        
        if (!sessionToken) {
            console.log('❌ No sessionToken provided');
            return res.status(400).json({
                success: false,
                message: 'Session token is required'
            });
        }

        console.log('🔄 Getting database pool...');
        const pool = await getPool();
        console.log('✅ Database pool obtained');
        
        // Get session data
        console.log('📊 Querying session data...');
        const sessionQuery = `
            SELECT 
                aos.SessionId,
                aos.AgentId,
                aos.LinkId,
                aos.AgentData,
                aos.VerificationToken,
                aos.ModifiedDate,
                aos.Status,
                aol.TenantId,
                t.Name as TenantName,
                t.CustomDomain
            FROM oe.AgentOnboardingSessions aos
            INNER JOIN oe.AgentOnboardingLinks aol ON aos.LinkId = aol.LinkId
            INNER JOIN oe.Tenants t ON aol.TenantId = t.TenantId
            WHERE aos.SessionToken = @sessionToken
        `;

        const sessionResult = await pool.request()
            .input('sessionToken', sql.NVarChar, sessionToken)
            .query(sessionQuery);

        console.log('📊 Query result:', sessionResult.recordset.length, 'sessions found');
        
        if (sessionResult.recordset.length > 0) {
            console.log('Session Status:', sessionResult.recordset[0].Status);
        }

        if (sessionResult.recordset.length === 0) {
            console.log('❌ No session found for token');
            return res.status(404).json({
                success: false,
                message: 'Invalid session or already verified'
            });
        }

        const session = sessionResult.recordset[0];
        
        // Check if status is PendingVerification
        if (session.Status !== 'PendingVerification') {
            console.log('❌ Session status is not PendingVerification, current status:', session.Status);
            return res.status(400).json({
                success: false,
                message: `Session is in ${session.Status} state. Verification can only be resent for sessions pending verification.`
            });
        }
        
        console.log('✅ Session found and validated');
        
        // Rate limiting: Check if last email was sent less than 2 minutes ago
        const lastModified = new Date(session.ModifiedDate);
        const now = new Date();
        const minutesSinceLastSend = (now - lastModified) / 1000 / 60;
        
        if (minutesSinceLastSend < 2) {
            return res.status(429).json({
                success: false,
                message: `Please wait ${Math.ceil(2 - minutesSinceLastSend)} minute(s) before requesting another verification email`,
                retryAfter: Math.ceil(2 - minutesSinceLastSend) * 60 // in seconds
            });
        }
        
        const agentData = JSON.parse(session.AgentData);
        
        // Generate new verification token and expiry (same as complete flow: 3 days default)
        const resendExpiryHours = parseInt(process.env.AGENT_VERIFICATION_LINK_EXPIRY_HOURS || '72', 10) || 72;
        const newVerificationToken = crypto.randomBytes(32).toString('hex');
        const newVerificationExpiry = new Date(Date.now() + resendExpiryHours * 60 * 60 * 1000);
        
        // Update session with new token
        await pool.request()
            .input('sessionId', sql.UniqueIdentifier, session.SessionId)
            .input('verificationToken', sql.NVarChar, newVerificationToken)
            .input('verificationExpiry', sql.DateTime2, newVerificationExpiry)
            .query(`
                UPDATE oe.AgentOnboardingSessions 
                SET VerificationToken = @verificationToken,
                    VerificationTokenExpiry = @verificationExpiry,
                    ModifiedDate = GETUTCDATE()
                WHERE SessionId = @sessionId
            `);
        
        // Generate verification URL using referer header (similar to group onboarding)
        let verificationUrl;
        const referer = req.get('referer') || req.get('origin');
        let baseUrl;
        if (referer) {
            // Extract protocol and hostname from referer
            try {
                const refererUrl = new URL(referer);
                baseUrl = `${refererUrl.protocol}//${refererUrl.hostname}${refererUrl.port ? ':' + refererUrl.port : ''}`;
            } catch (urlError) {
                console.warn('❌ Failed to parse referer URL:', referer);
                baseUrl = null;
            }
        }
        
        if (!baseUrl) {
            // Use request origin if available, otherwise use session custom domain or default
            baseUrl = req.get('origin') || (session.CustomDomain ? `https://${session.CustomDomain}` : 'https://app.allaboard365.com');
        }
        
        verificationUrl = `${baseUrl}/public/agent-verification?token=${newVerificationToken}`;
        console.log('🌐 [RESEND] Generated verification URL:', verificationUrl);

        // Send verification email
        try {
            const EmailTemplatesService = require('../../services/emailTemplates.service');
            const MessageQueueService = require('../../services/messageQueue.service');
            
            const resendExpiryText = resendExpiryHours >= 72 ? '3 days' : (resendExpiryHours >= 24 ? `${Math.round(resendExpiryHours / 24)} days` : `${resendExpiryHours} hours`);
            const htmlContent = await EmailTemplatesService.generateAgentVerification({
                tenantId: session.TenantId,
                firstName: agentData.firstName,
                verificationUrl: verificationUrl,
                verificationLinkExpiryText: resendExpiryText
            });
            
            await MessageQueueService.queueEmail({
                tenantId: session.TenantId,
                toEmail: agentData.email,
                toName: `${agentData.firstName} ${agentData.lastName}`,
                subject: `Verify Your Email - ${session.TenantName || 'Agent Onboarding'}`,
                htmlContent: htmlContent,
                messageType: 'Email',
                createdBy: agentData.userId
            });
            logger.info('✅ Verification email resent successfully');
        } catch (emailError) {
            console.error('❌ Failed to send verification email:', emailError);
            return res.status(500).json({
                success: false,
                message: 'Failed to send verification email'
            });
        }
        
        res.json({
            success: true,
            message: 'Verification email resent. Please check your inbox.'
        });
        
    } catch (error) {
        logger.error('❌ Error resending verification email:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to resend verification email',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

/**
 * @route   POST /api/public/onboarding/setup-password
 * @desc    Setup password for agent after email verification
 * @access  Public (no authentication required)
 */
router.post('/setup-password', async (req, res) => {
    logger.info('[PUBLIC-ONBOARDING] >> Setting up/confirming password for agent');
    
    try {
        const { verificationToken, password, isPasswordConfirmation } = req.body;
        
        if (!verificationToken || !password) {
            return res.status(400).json({
                success: false,
                message: 'Verification token and password are required'
            });
        }

        // Validate password strength (only for new password setup)
        if (!isPasswordConfirmation) {
            const passwordRegex = passwordRequirements.getPasswordRegexMin8();
            if (!passwordRegex.test(password)) {
                return res.status(400).json({
                    success: false,
                    message: passwordRequirements.PASSWORD_REQUIREMENTS.messages.fullMin8
                });
            }
        }

        const pool = await getPool();
        
        // Get session and agent data by verification token
        const sessionQuery = `
            SELECT 
                aos.SessionId,
                aos.AgentId,
                aos.LinkId,
                aos.AgentData,
                aos.VerificationTokenExpiry,
                aol.TenantId,
                aol.AgencyId,
                t.Name as TenantName
            FROM oe.AgentOnboardingSessions aos
            INNER JOIN oe.AgentOnboardingLinks aol ON aos.LinkId = aol.LinkId
            INNER JOIN oe.Tenants t ON aol.TenantId = t.TenantId
            WHERE aos.VerificationToken = @verificationToken 
            AND aos.Status = 'PendingVerification'
        `;

        const sessionResult = await pool.request()
            .input('verificationToken', sql.NVarChar, verificationToken)
            .query(sessionQuery);

        if (sessionResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Invalid or expired verification session'
            });
        }

        const session = sessionResult.recordset[0];
        
        // Check if token is expired
        if (session.VerificationTokenExpiry && new Date() > new Date(session.VerificationTokenExpiry)) {
            return res.status(400).json({
                success: false,
                message: 'Verification token has expired'
            });
        }
        
        const agentData = JSON.parse(session.AgentData);
        const userId = agentData.userId;
        const agentId = session.AgentId;
        
        if (!userId || !agentId) {
            return res.status(400).json({
                success: false,
                message: 'Invalid session data'
            });
        }

        // Get user info
        const userCheckQuery = `
            SELECT UserId, Email, PasswordHash, Status, FirstName, LastName FROM oe.Users WHERE UserId = @userId
        `;
        
        const userCheckResult = await pool.request()
            .input('userId', sql.UniqueIdentifier, userId)
            .query(userCheckQuery);

        if (userCheckResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        const user = userCheckResult.recordset[0];
        const hasExistingPassword = !!user.PasswordHash;
        
        // Handle password confirmation (existing user) vs password setup (new user)
        if (isPasswordConfirmation && hasExistingPassword) {
            // Verify existing password
            const passwordMatch = await bcrypt.compare(password, user.PasswordHash);
            if (!passwordMatch) {
                return res.status(401).json({
                    success: false,
                    message: 'Invalid password'
                });
            }
            logger.info('✅ Password confirmed for existing user');
        } else if (!hasExistingPassword) {
            // Set up new password
            const saltRounds = 12;
            const passwordHash = await bcrypt.hash(password, saltRounds);
            
            await pool.request()
                .input('userId', sql.UniqueIdentifier, userId)
                .input('passwordHash', sql.NVarChar, passwordHash)
                .query(`
                    UPDATE oe.Users SET
                        PasswordHash = @passwordHash,
                        ModifiedDate = GETUTCDATE()
                    WHERE UserId = @userId
                `);
            logger.info('✅ New password set successfully');
        } else {
            return res.status(400).json({
                success: false,
                message: 'Invalid password setup request'
            });
        }
        
        // Now activate the agent and user accounts
        const transaction = pool.transaction();
        await transaction.begin();
        
        try {
            // Activate user account
            await transaction.request()
                .input('userId', sql.UniqueIdentifier, userId)
                .query(`
                    UPDATE oe.Users 
                    SET Status = 'Active', ModifiedDate = GETUTCDATE()
                    WHERE UserId = @userId
                `);
            
            // Activate agent account
            await transaction.request()
                .input('agentId', sql.UniqueIdentifier, agentId)
                .query(`
                    UPDATE oe.Agents 
                    SET Status = 'Active', ModifiedDate = GETUTCDATE()
                    WHERE AgentId = @agentId
                `);
            
            // Mark session as completed
            await transaction.request()
                .input('sessionId', sql.UniqueIdentifier, session.SessionId)
                .query(`
                    UPDATE oe.AgentOnboardingSessions 
                    SET Status = 'Completed', CompletedDate = GETUTCDATE(), ModifiedDate = GETUTCDATE()
                    WHERE SessionId = @sessionId
                `);
            
            await transaction.commit();
            logger.info('✅ Agent account activated successfully');
        } catch (error) {
            await transaction.rollback();
            throw error;
        }

        // Agent role is assigned when onboarding form completes (user + agent created), not here.
        
        // Generate JWT token
        const jwt = require('jsonwebtoken');
        const token = jwt.sign(
            { 
                userId: userId,
                email: user.Email,
                tenantId: session.TenantId,
                userType: 'Agent',
                roles: ['Agent']
            },
            process.env.JWT_SECRET || 'fallback-secret',
            { expiresIn: '24h' }
        );
        
        logger.info(`✅ Agent onboarding completed successfully for: ${user.Email}`);
        
        res.json({
            success: true,
            data: {
                token: token,
                userId: userId,
                email: user.Email,
                firstName: user.FirstName,
                lastName: user.LastName,
                tenantId: session.TenantId,
                tenantName: session.TenantName,
                userType: 'Agent',
                roles: ['Agent']
            },
            message: 'Agent onboarding completed successfully!'
        });
        
    } catch (error) {
        logger.error('❌ Error setting up password:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to setup password',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

module.exports = router;
