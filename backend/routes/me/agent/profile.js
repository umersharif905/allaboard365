// backend/routes/me/agent/profile.js
const express = require('express');
const router = express.Router();
const sql = require('mssql');
const { authorize } = require('../../../middleware/auth');
const { getPool } = require('../../../config/database');
const logger = require('../../../config/logger');

/**
 * @route   GET /api/me/agent/profile
 * @desc    Get the current agent's own profile details
 * @access  Private (Agent only)
 */
router.get('/', authorize(['Agent']), async (req, res) => {
    logger.info(`[AGENT-ME-PROFILE-ROUTE] >> Request received for Agent's own profile.`);
    logger.info(`[AGENT-ME-PROFILE-ROUTE] >> User object:`, JSON.stringify(req.user, null, 2));
    
    try {
        if (!req.user) {
            logger.error("[AGENT-ME-PROFILE-ROUTE] !! Agent user is missing from request object.");
            return res.status(401).json({ success: false, message: 'Authentication error: User information is missing.' });
        }

        const userId = req.user.UserId;
        logger.info(`[AGENT-ME-PROFILE-ROUTE] Fetching agent profile for UserId: ${userId}`);

        const pool = await getPool();
        const request = pool.request();
        
        request.input('userId', sql.UniqueIdentifier, userId);
        
        const result = await request.query(`
            SELECT
                a.AgentId,
                a.AgentCode,
                a.UserId,
                u.FirstName,
                u.LastName,
                u.Email,
                u.PhoneNumber,
                u.ProfileImageUrl,
                a.Phone as AgentPhone,
                a.Address1,
                a.Address2,
                a.City,
                a.State,
                a.ZipCode,
                a.NPN as LicenseNumber,
                a.Status as AgentStatus,
                a.CreatedDate as AgentCreatedDate,
                a.ModifiedDate as AgentModifiedDate,
                cl.DisplayName AS CommissionLevelName,
                COALESCE(cl.SortOrder, a.CommissionTierLevel) AS CommissionTierLevel,
                -- Check if active W9 document exists
                CASE WHEN EXISTS(
                    SELECT 1
                    FROM oe.AgentDocuments
                    WHERE AgentId = a.AgentId
                      AND DocumentType = 'W9'
                      AND Status = 'Active'
                ) THEN 1 ELSE 0 END as W9Stored,
                -- Check if banking info exists
                CASE WHEN EXISTS(SELECT 1 FROM oe.AgentBankInfo WHERE AgentId = a.AgentId AND Status = 'Active') THEN 1 ELSE 0 END as BankingInfoStored
            FROM oe.Agents a
            JOIN oe.Users u ON a.UserId = u.UserId
            LEFT JOIN oe.CommissionLevels cl ON a.CommissionLevelId = cl.CommissionLevelId
            WHERE a.UserId = @userId
        `);

        if (result.recordset.length === 0) {
            logger.error(`[AGENT-ME-PROFILE-ROUTE] Agent profile not found for UserId: ${userId}`);
            return res.status(404).json({ 
                success: false, 
                message: 'Agent profile not found' 
            });
        }

        const agentProfile = result.recordset[0];
        
        // Profile images are in public 'logos' container - no authentication needed
        // Per backend-system.md: image URLs don't require authentication
        
        // Convert to camelCase for frontend consistency
        const profileData = {
            UserId: agentProfile.UserId,
            AgentId: agentProfile.AgentId,
            AgentCode: agentProfile.AgentCode,
            FirstName: agentProfile.FirstName,
            LastName: agentProfile.LastName,
            Email: agentProfile.Email,
            PhoneNumber: agentProfile.PhoneNumber,
            ProfileImageUrl: agentProfile.ProfileImageUrl,
            AgentPhone: agentProfile.AgentPhone,
            Address1: agentProfile.Address1,
            Address2: agentProfile.Address2,
            City: agentProfile.City,
            State: agentProfile.State,
            ZipCode: agentProfile.ZipCode,
            LicenseNumber: agentProfile.LicenseNumber,
            W9Stored: agentProfile.W9Stored,
            BankingInfoStored: agentProfile.BankingInfoStored,
            AgentStatus: agentProfile.AgentStatus,
            AgentCreatedDate: agentProfile.AgentCreatedDate,
            AgentModifiedDate: agentProfile.AgentModifiedDate,
            CommissionLevelName: agentProfile.CommissionLevelName || null,
            CommissionTierLevel: agentProfile.CommissionTierLevel != null
                ? Number(agentProfile.CommissionTierLevel)
                : null
        };

        logger.info(`[AGENT-ME-PROFILE-ROUTE] << Successfully fetched agent profile. Responding with 200.`);
        res.json({ success: true, data: profileData });

    } catch (error) {
        logger.error(`[AGENT-ME-PROFILE-ROUTE] !! Server error: ${error.message}`, error);
        res.status(500).json({ 
            success: false, 
            message: 'Server Error', 
            code: 'AGENT_PROFILE_ERROR' 
        });
    }
});

/**
 * @route   PUT /api/me/agent/profile
 * @desc    Update the current agent's own profile details
 * @access  Private (Agent only)
 */
router.put('/', authorize(['Agent']), async (req, res) => {
    logger.info(`[AGENT-ME-PROFILE-ROUTE] >> Update request received for Agent's own profile.`);
    
    try {
        if (!req.user) {
            logger.error("[AGENT-ME-PROFILE-ROUTE] !! Agent user is missing from request object.");
            return res.status(401).json({ success: false, message: 'Authentication error: User information is missing.' });
        }

        const userId = req.user.UserId;
        const { firstName, lastName, phoneNumber, licenseNumber, address1, address2, city, state, zipCode, profileImageUrl } = req.body;

        logger.info(`[AGENT-ME-PROFILE-ROUTE] Updating agent profile for UserId: ${userId}`);
        logger.info(`[AGENT-ME-PROFILE-ROUTE] Received data:`, JSON.stringify({
            firstName, lastName, phoneNumber, licenseNumber, address1, address2, city, state, zipCode, profileImageUrl
        }, null, 2));

        const pool = await getPool();
        const request = pool.request();
        
        request.input('userId', sql.UniqueIdentifier, userId);
        
        // Build dynamic UPDATE query for Users table - only update fields that are provided
        let usersUpdateFields = [];
        
        if (firstName !== undefined) {
            request.input('firstName', sql.NVarChar, firstName);
            usersUpdateFields.push('FirstName = @firstName');
        }
        
        if (lastName !== undefined) {
            request.input('lastName', sql.NVarChar, lastName);
            usersUpdateFields.push('LastName = @lastName');
        }
        
        if (phoneNumber !== undefined) {
            request.input('phoneNumber', sql.NVarChar, phoneNumber);
            usersUpdateFields.push('PhoneNumber = @phoneNumber');
        }
        
        // Add ProfileImageUrl update if provided
        if (profileImageUrl !== undefined) {
            // Store the original URL (without SAS token) in database
            // We'll authenticate it when reading it back
            let urlToStore = profileImageUrl || null;
            if (urlToStore && urlToStore.includes('blob.core.windows.net')) {
                // Strip any existing SAS token to store clean URL
                try {
                    const url = new URL(urlToStore);
                    urlToStore = `${url.protocol}//${url.hostname}${url.pathname}`;
                } catch (e) {
                    // If URL parsing fails, use as-is
                }
            }
            request.input('profileImageUrl', sql.NVarChar, urlToStore);
            usersUpdateFields.push('ProfileImageUrl = @profileImageUrl');
        }
        
        // Only update Users table if there are fields to update
        if (usersUpdateFields.length > 0) {
            usersUpdateFields.push('ModifiedDate = GETUTCDATE()');
            
            const usersUpdateQuery = `
                UPDATE oe.Users 
                SET ${usersUpdateFields.join(',\n                ')}
                WHERE UserId = @userId
            `;
            
            logger.info(`[AGENT-ME-PROFILE-ROUTE] Executing Users UPDATE query:`, usersUpdateQuery);
            await request.query(usersUpdateQuery);
        }

        // Build dynamic UPDATE query for Agents table - only update fields that are provided
        let agentsUpdateFields = [];
        
        if (licenseNumber !== undefined) {
            request.input('npn', sql.NVarChar, licenseNumber);
            agentsUpdateFields.push('NPN = @npn');
        }
        
        if (address1 !== undefined) {
            request.input('address1', sql.NVarChar, address1);
            agentsUpdateFields.push('Address1 = @address1');
        }
        
        if (address2 !== undefined) {
            request.input('address2', sql.NVarChar, address2);
            agentsUpdateFields.push('Address2 = @address2');
        }
        
        if (city !== undefined) {
            request.input('city', sql.NVarChar, city);
            agentsUpdateFields.push('City = @city');
        }
        
        if (state !== undefined) {
            request.input('state', sql.NVarChar, state);
            agentsUpdateFields.push('State = @state');
        }
        
        if (zipCode !== undefined) {
            request.input('zipCode', sql.NVarChar, zipCode);
            agentsUpdateFields.push('ZipCode = @zipCode');
        }
        
        // Only update Agents table if there are fields to update
        if (agentsUpdateFields.length > 0) {
            agentsUpdateFields.push('ModifiedDate = GETUTCDATE()');
            
            const agentsUpdateQuery = `
                UPDATE oe.Agents 
                SET ${agentsUpdateFields.join(',\n                ')}
                WHERE UserId = @userId
            `;
            
            logger.info(`[AGENT-ME-PROFILE-ROUTE] Executing Agents UPDATE query:`, agentsUpdateQuery);
            await request.query(agentsUpdateQuery);
        }

        logger.info(`[AGENT-ME-PROFILE-ROUTE] << Successfully updated agent profile. Responding with 200.`);
        res.json({ 
            success: true, 
            message: 'Agent profile updated successfully',
            data: { userId, firstName, lastName, phoneNumber, licenseNumber }
        });

    } catch (error) {
        logger.error(`[AGENT-ME-PROFILE-ROUTE] !! Server error: ${error.message}`, error);
        logger.error(`[AGENT-ME-PROFILE-ROUTE] !! Error stack: ${error.stack}`);
        logger.error(`[AGENT-ME-PROFILE-ROUTE] !! Error details:`, JSON.stringify({
            message: error.message,
            code: error.code,
            number: error.number,
            state: error.state,
            class: error.class,
            serverName: error.serverName,
            procName: error.procName,
            lineNumber: error.lineNumber
        }, null, 2));
        res.status(500).json({ 
            success: false, 
            message: error.message || 'Server Error', 
            code: 'AGENT_PROFILE_UPDATE_ERROR' 
        });
    }
});

module.exports = router;
