// backend/routes/me/agent/bank-info.js
const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();
const sql = require('mssql');
const { authorize } = require('../../../middleware/auth');
const { getPool } = require('../../../config/database');
const logger = require('../../../config/logger');
const encryptionService = require('../../../services/encryptionService');

const upload = multer({ storage: multer.memoryStorage() });

/** Normalize account type from UI (checking/savings) or API (Checking/Savings). */
function normalizeAccountType(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const t = raw.trim();
    const lower = t.toLowerCase();
    if (lower === 'checking') return 'Checking';
    if (lower === 'savings') return 'Savings';
    if (t === 'Checking' || t === 'Savings') return t;
    return null;
}

/**
 * @route   GET /api/me/agent/bank-info
 * @desc    Get the current agent's own banking information
 * @access  Private (Agent only)
 */
router.get('/', authorize(['Agent']), async (req, res) => {
    logger.info('[AGENT-ME-BANK-INFO] >> Getting agent banking info');
    
    try {
        if (!req.user) {
            logger.error('[AGENT-ME-BANK-INFO] !! User is missing from request');
            return res.status(401).json({ 
                success: false, 
                message: 'Authentication error: User information is missing.' 
            });
        }

        const userId = req.user.UserId;
        const pool = await getPool();

        // First get the agent's AgentId
        const agentResult = await pool.request()
            .input('userId', sql.UniqueIdentifier, userId)
            .query(`
                SELECT AgentId 
                FROM oe.Agents 
                WHERE UserId = @userId
            `);

        if (agentResult.recordset.length === 0) {
            logger.error(`[AGENT-ME-BANK-INFO] Agent not found for UserId: ${userId}`);
            return res.status(404).json({ 
                success: false, 
                message: 'Agent not found' 
            });
        }

        const agentId = agentResult.recordset[0].AgentId;

        // Get banking information
        const bankResult = await pool.request()
            .input('agentId', sql.UniqueIdentifier, agentId)
            .query(`
                SELECT 
                    BankInfoId,
                    BankName,
                    AccountName,
                    AccountType,
                    AccountHolderType,
                    RoutingNumber,
                    AccountNumberEncrypted,
                    AccountNumberLast4,
                    Status,
                    CreatedDate,
                    ModifiedDate
                FROM oe.AgentBankInfo 
                WHERE AgentId = @agentId 
                AND Status = 'Active'
                ORDER BY CreatedDate DESC
            `);

        logger.info(`[AGENT-ME-BANK-INFO] << Found ${bankResult.recordset.length} banking records`);

        // Decode the stored account number so the agent can view their own
        // full account number in the UI. Uses smartDecryptAccountNumber to
        // handle all three legacy storage formats (AES-256-GCM, base64,
        // plaintext) since historical rows were written inconsistently.
        const decodedRecords = bankResult.recordset.map((record) => {
            const out = { ...record };
            if (out.AccountNumberEncrypted) {
                try {
                    out.AccountNumber = encryptionService.smartDecryptAccountNumber(
                        out.AccountNumberEncrypted
                    ) || '';
                } catch (decodeError) {
                    logger.warn(
                        '[AGENT-ME-BANK-INFO] Failed to decode AccountNumberEncrypted',
                        { error: decodeError.message }
                    );
                    out.AccountNumber = '';
                }
            }
            delete out.AccountNumberEncrypted;
            return out;
        });

        res.json({
            success: true,
            data: decodedRecords
        });

    } catch (error) {
        logger.error('[AGENT-ME-BANK-INFO] !! Error getting banking info:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get banking information',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

/**
 * @route   POST /api/me/agent/bank-info
 * @desc    Create or update the current agent's banking information (same storage rules as tenant-admin)
 * @access  Private (Agent only)
 */
router.post(
    '/',
    authorize(['Agent']),
    (req, res, next) => {
        const ct = req.headers['content-type'] || '';
        if (ct.includes('multipart/form-data')) {
            return upload.none()(req, res, next);
        }
        return next();
    },
    async (req, res) => {
        logger.info('[AGENT-ME-BANK-INFO] >> Saving agent banking info');

        try {
            if (!req.user) {
                return res.status(401).json({
                    success: false,
                    message: 'Authentication error: User information is missing.'
                });
            }

            const {
                bankName,
                accountName,
                nameOnAccount,
                accountType: accountTypeRaw,
                routingNumber,
                accountNumber
            } = req.body;

            const resolvedAccountName = (accountName || nameOnAccount || '').trim();
            const accountType = normalizeAccountType(accountTypeRaw);

            if (!bankName || !resolvedAccountName || !accountType || !routingNumber || !accountNumber) {
                return res.status(400).json({
                    success: false,
                    message: 'All bank information fields are required'
                });
            }

            if (!/^\d{9}$/.test(String(routingNumber).replace(/\D/g, ''))) {
                return res.status(400).json({
                    success: false,
                    message: 'Routing number must be exactly 9 digits'
                });
            }

            const routingDigits = String(routingNumber).replace(/\D/g, '');
            const acctDigits = String(accountNumber).replace(/\D/g, '');
            if (acctDigits.length < 4 || acctDigits.length > 17) {
                return res.status(400).json({
                    success: false,
                    message: 'Account number must be 4-17 digits'
                });
            }

            const userId = req.user.UserId;
            const pool = await getPool();

            const agentResult = await pool.request()
                .input('userId', sql.UniqueIdentifier, userId)
                .query(`
                    SELECT AgentId, TenantId, Status
                    FROM oe.Agents
                    WHERE UserId = @userId
                `);

            if (agentResult.recordset.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Agent not found'
                });
            }

            const { AgentId: actualAgentId } = agentResult.recordset[0];

            const accountNumberLast4 = acctDigits.slice(-4);
            // Encrypt with AES-256-GCM (consistent with all other bank-info paths).
            // Was previously naive base64 — NOT real encryption.
            const encryptedAccountNumber = encryptionService.encrypt(acctDigits);

            const transaction = pool.transaction();

            try {
                await transaction.begin();

                const existingBankRequest = transaction.request();
                existingBankRequest.input('AgentId', sql.UniqueIdentifier, actualAgentId);

                const existingBankResult = await existingBankRequest.query(`
                    SELECT BankInfoId FROM oe.AgentBankInfo
                    WHERE AgentId = @AgentId AND Status = 'Active'
                `);

                if (existingBankResult.recordset.length > 0) {
                    const bankInfoId = existingBankResult.recordset[0].BankInfoId;

                    const updateRequest = transaction.request();
                    updateRequest.input('BankInfoId', sql.UniqueIdentifier, bankInfoId);
                    updateRequest.input('BankName', sql.NVarChar, bankName);
                    updateRequest.input('AccountName', sql.NVarChar, resolvedAccountName);
                    updateRequest.input('AccountType', sql.NVarChar, accountType);
                    updateRequest.input('RoutingNumber', sql.NVarChar, routingDigits);
                    updateRequest.input('AccountNumberEncrypted', sql.NVarChar, encryptedAccountNumber);
                    updateRequest.input('AccountNumberLast4', sql.NVarChar, accountNumberLast4);
                    updateRequest.input('ModifiedBy', sql.UniqueIdentifier, userId);

                    await updateRequest.query(`
                        UPDATE oe.AgentBankInfo
                        SET BankName = @BankName,
                            AccountName = @AccountName,
                            AccountType = @AccountType,
                            RoutingNumber = @RoutingNumber,
                            AccountNumberEncrypted = @AccountNumberEncrypted,
                            AccountNumberLast4 = @AccountNumberLast4,
                            ModifiedDate = GETUTCDATE(),
                            ModifiedBy = @ModifiedBy,
                            VerificationStatus = 'Pending'
                        WHERE BankInfoId = @BankInfoId
                    `);
                } else {
                    const bankInfoId = uuidv4();

                    const insertRequest = transaction.request();
                    insertRequest.input('BankInfoId', sql.UniqueIdentifier, bankInfoId);
                    insertRequest.input('AgentId', sql.UniqueIdentifier, actualAgentId);
                    insertRequest.input('BankName', sql.NVarChar, bankName);
                    insertRequest.input('AccountName', sql.NVarChar, resolvedAccountName);
                    insertRequest.input('AccountHolderType', sql.NVarChar, 'Individual');
                    insertRequest.input('AccountType', sql.NVarChar, accountType);
                    insertRequest.input('RoutingNumber', sql.NVarChar, routingDigits);
                    insertRequest.input('AccountNumberEncrypted', sql.NVarChar, encryptedAccountNumber);
                    insertRequest.input('AccountNumberLast4', sql.NVarChar, accountNumberLast4);
                    insertRequest.input('CreatedBy', sql.UniqueIdentifier, userId);
                    insertRequest.input('ModifiedBy', sql.UniqueIdentifier, userId);

                    await insertRequest.query(`
                        INSERT INTO oe.AgentBankInfo (
                            BankInfoId, AgentId, BankName, AccountName, AccountHolderType, AccountType,
                            RoutingNumber, AccountNumberEncrypted, AccountNumberLast4,
                            Status, IsDefault, VerificationStatus,
                            CreatedDate, ModifiedDate, CreatedBy, ModifiedBy
                        ) VALUES (
                            @BankInfoId, @AgentId, @BankName, @AccountName, @AccountHolderType, @AccountType,
                            @RoutingNumber, @AccountNumberEncrypted, @AccountNumberLast4,
                            'Active', 1, 'Pending',
                            GETUTCDATE(), GETUTCDATE(), @CreatedBy, @ModifiedBy
                        )
                    `);
                }

                await transaction.commit();

                logger.info('[AGENT-ME-BANK-INFO] << Bank information saved', { agentId: actualAgentId });

                return res.json({
                    success: true,
                    message: 'Bank information saved successfully'
                });
            } catch (err) {
                await transaction.rollback();
                throw err;
            }
        } catch (error) {
            logger.error('[AGENT-ME-BANK-INFO] !! Error saving banking info:', error);
            return res.status(500).json({
                success: false,
                message: 'Failed to save banking information',
                error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
            });
        }
    }
);

module.exports = router;
