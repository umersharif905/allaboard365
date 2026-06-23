// backend/routes/business-proposal-sends.js
// Routes for generating and sending business proposals
// Supports multi-document generation with server-side calculations

const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/database');
const { authorize, getUserRoles } = require('../middleware/auth');
const ProposalGeneratorService = require('../services/proposalGenerator.service');
const ProposalDocumentService = require('../services/proposalDocument.service');
const { computeAllCalculations, calcMwTierPrice } = require('../services/proposalCalculation.service');
const sendGridEmailService = require('../services/sendGridEmailService');
const MessageQueueService = require('../services/messageQueue.service');
const { buildSmsBodyWithLinks } = require('../utils/smsBody');
const { resolveFromEmailForTenant } = require('../utils/tenantEmailFrom');

/**
 * Helper function to get AgentId from UserId
 */
async function getAgentIdFromUserId(userId) {
  const pool = await getPool();
  const request = pool.request();
  request.input('userId', sql.UniqueIdentifier, userId);
  
  const result = await request.query(`
    SELECT AgentId
    FROM oe.Agents
    WHERE UserId = @userId AND Status = 'Active'
  `);
  
  if (result.recordset.length === 0) {
    throw new Error('Agent profile not found');
  }
  
  return result.recordset[0].AgentId;
}

/**
 * Extract all calculationType keys from a document's fields.
 * Calculation fields store their type in FieldName.
 */
function extractCalcTypesFromFields(fields) {
  const calcTypes = new Set();
  if (!fields || !Array.isArray(fields)) return calcTypes;
  for (const field of fields) {
    if (field.FieldType === 'calculation' && field.FieldName) {
      calcTypes.add(field.FieldName);
    }
  }
  return calcTypes;
}

/**
 * Validate that agentId belongs to the tenant (for TenantAdmin).
 */
async function validateAgentIdForTenant(agentId, tenantId) {
  if (!agentId || !tenantId) return null;
  const pool = await getPool();
  const request = pool.request();
  request.input('agentId', sql.UniqueIdentifier, agentId);
  request.input('tenantId', sql.UniqueIdentifier, tenantId);
  const result = await request.query(`
    SELECT AgentId FROM oe.Agents
    WHERE AgentId = @agentId AND TenantId = @tenantId AND Status = 'Active'
  `);
  if (result.recordset.length === 0) return null;
  return result.recordset[0].AgentId;
}

/**
 * Resolve tenant for an agent (used by proposal pricing display logic).
 */
async function getAgentTenantId(agentId) {
  if (!agentId) return null;
  const pool = await getPool();
  const request = pool.request();
  request.input('agentId', sql.UniqueIdentifier, agentId);
  const result = await request.query(`
    SELECT TOP 1 TenantId
    FROM oe.Agents
    WHERE AgentId = @agentId
  `);
  if (result.recordset.length === 0) return null;
  return result.recordset[0].TenantId || null;
}

/**
 * POST /api/business-proposal-sends
 * Generate and send one or more business proposal documents.
 * Accepts raw form inputs; calculations are computed server-side.
 * @access Agent, TenantAdmin, SysAdmin
 */
router.post('/', authorize(['Agent', 'TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const {
      // --- Document selection ---
      documentIds,             // Array of ProposalDocumentIds to generate
      proposalDocumentId,      // Legacy: single document ID (backward compat)

      // --- Company info ---
      companyName,
      companyAddress,

      // --- Workforce ---
      totalEmployees,

      // --- Current Coverage (per-tier) ---
      hasExistingCoverage,
      currentCountEE,
      currentCountE1,
      currentCountEC,
      currentCountEF,
      currentPremiumEE,
      currentPremiumE1,
      currentPremiumEC,
      currentPremiumEF,
      currentContributionType,
      currentContributionValueType,
      currentContributionValue: currentContribValue,
      currentContributionValueEE: currentContribValueEE,
      currentContributionValueE1: currentContribValueE1,
      currentContributionValueEC: currentContribValueEC,
      currentContributionValueEF: currentContribValueEF,
      currentContributionValueTypeEE,
      currentContributionValueTypeE1,
      currentContributionValueTypeEC,
      currentContributionValueTypeEF,
      // Legacy fields (backward compat)
      currentlyEnrolled: legacyCurrentlyEnrolled,
      currentMonthlyPremium: legacyCurrentMonthlyPremium,

      // --- Plan Configuration ---
      oopLevel,                // '1500' | '3000'

      // --- MW Tier Counts ---
      mwCountEE,
      mwCountE1,
      mwCountEC,
      mwCountEF,

      // --- Partial Switch (per-tier) ---
      currentRemainCountEE,
      currentRemainCountE1,
      currentRemainCountEC,
      currentRemainCountEF,

      // --- Employer Contribution ---
      contributionType,        // 'flat' | 'per_tier' (legacy)
      contributionValueType,   // 'dollar' | 'percentage' (legacy global)
      contributionValue,       // flat mode value (legacy)
      contributionValueEE,     // per_tier values
      contributionValueE1,
      contributionValueEC,
      contributionValueEF,
      contributionValueTypeEE, // per-tier value types (new)
      contributionValueTypeE1,
      contributionValueTypeEC,
      contributionValueTypeEF,

      // --- Enrollment Date ---
      enrollmentDate,          // single date string (e.g. '2026-03-01')

      // --- Send options ---
      sendMethod,              // 'email' | 'text' | 'download'
      recipientEmail,
      recipientPhone,
      emailMessage,
      textMessage,
      enrollmentLinkUrls,
      customFieldValues,

      // --- Reuse existing PDF ---
      existingPdfUrl,
      agentId: bodyAgentId // Optional: for TenantAdmin - which agent the proposal is for
    } = req.body;

    // Resolve document IDs: support both new array and legacy single ID
    const docIds = documentIds && documentIds.length > 0
      ? documentIds
      : (proposalDocumentId ? [proposalDocumentId] : []);

    // --- Validation ---
    if (docIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'At least one document must be selected (documentIds or proposalDocumentId)'
      });
    }

    if (!companyName || !companyName.trim()) {
      return res.status(400).json({ success: false, message: 'Company name is required' });
    }

    // NOTE:
    // Some proposal templates (e.g., employee cover quote docs) do not require
    // workforce-based calculations. In those cases totalEmployees can be omitted.

    if (!['email', 'text', 'download'].includes(sendMethod)) {
      return res.status(400).json({ success: false, message: 'sendMethod must be one of: email, text, download' });
    }

    if (sendMethod === 'email' && !recipientEmail) {
      return res.status(400).json({ success: false, message: 'Email is required when sendMethod is "email"' });
    }

    if (sendMethod === 'text' && !recipientPhone) {
      return res.status(400).json({ success: false, message: 'Phone is required when sendMethod is "text"' });
    }
    
    // Get agent ID - Agent uses own profile; TenantAdmin/SysAdmin may pass agentId
    const userRoles = getUserRoles(req.user);
    let agentId;
    if (bodyAgentId && (userRoles.includes('TenantAdmin') || userRoles.includes('SysAdmin'))) {
      if (userRoles.includes('TenantAdmin')) {
        // req.tenantId / req.user.TenantId are set by requireTenantAccess from X-Current-Tenant-Id (multi-tenant)
        const tenantId = req.tenantId || req.user.TenantId;
        agentId = await validateAgentIdForTenant(bodyAgentId, tenantId);
        if (!agentId) {
          return res.status(403).json({
            success: false,
            message: 'Selected agent is not in your organization or is inactive.'
          });
        }
      } else {
        const pool = await getPool();
        const r = pool.request();
        r.input('agentId', sql.UniqueIdentifier, bodyAgentId);
        const agentResult = await r.query('SELECT AgentId FROM oe.Agents WHERE AgentId = @agentId AND Status = \'Active\'');
        agentId = agentResult.recordset.length ? agentResult.recordset[0].AgentId : null;
        if (!agentId) {
          return res.status(400).json({
            success: false,
            message: 'Invalid or inactive agent.'
          });
        }
      }
    } else {
      try {
        agentId = await getAgentIdFromUserId(req.user.UserId);
      } catch (error) {
        if (userRoles.includes('Agent')) {
          throw error;
        }
        return res.status(400).json({
          success: false,
          message: 'Agent profile required to send business proposals. Please ensure you have an active agent account.'
        });
      }
    }

    const agentTenantId = await getAgentTenantId(agentId);

    // --- Load documents and compute calculations ---
    const generatedDocs = [];
    const prospectInfo = {
      name: companyName,
      address: companyAddress || '',
      email: recipientEmail || '',
      phone: recipientPhone || ''
    };

    for (const docId of docIds) {
      console.log(`📄 Processing document ${docId}...`);

      // Load the document with fields and product slots
      const doc = await ProposalDocumentService.getProposalDocument(docId);
      if (!doc) {
        console.warn(`⚠️ Document ${docId} not found, skipping`);
        continue;
      }

      // Compute all calculations server-side
      const calcTypes = extractCalcTypesFromFields(doc.fields);
      const productSlots = (doc.productSlots || []).map(s => ({
        slotNumber: s.SlotNumber || s.slotNumber,
        productId: s.ProductId || s.productId
      }));

      // Derive backward-compatible values from new per-tier inputs
      const cCountEE = Number(currentCountEE || 0);
      const cCountE1 = Number(currentCountE1 || 0);
      const cCountEC = Number(currentCountEC || 0);
      const cCountEF = Number(currentCountEF || 0);
      const cPremEE = Number(currentPremiumEE || 0);
      const cPremE1 = Number(currentPremiumE1 || 0);
      const cPremEC = Number(currentPremiumEC || 0);
      const cPremEF = Number(currentPremiumEF || 0);
      const derivedCurrentlyEnrolled = cCountEE + cCountE1 + cCountEC + cCountEF || Number(legacyCurrentlyEnrolled || 0);
      const derivedCurrentMonthlyPremium = (cCountEE * cPremEE + cCountE1 * cPremE1 + cCountEC * cPremEC + cCountEF * cPremEF) || Number(legacyCurrentMonthlyPremium || 0);

      const inputs = {
        companyName,
        companyAddress,
        totalEmployees: Number(totalEmployees || 0),
        hasExistingCoverage: !!hasExistingCoverage,
        // Per-tier current coverage (new)
        currentCountEE: cCountEE,
        currentCountE1: cCountE1,
        currentCountEC: cCountEC,
        currentCountEF: cCountEF,
        currentPremiumEE: cPremEE,
        currentPremiumE1: cPremE1,
        currentPremiumEC: cPremEC,
        currentPremiumEF: cPremEF,
        currentContributionType: currentContributionType || 'flat',
        currentContributionValueType: currentContributionValueType || 'dollar',
        currentContributionValue: Number(currentContribValue || 0),
        currentContributionValueEE: Number(currentContribValueEE || 0),
        currentContributionValueE1: Number(currentContribValueE1 || 0),
        currentContributionValueEC: Number(currentContribValueEC || 0),
        currentContributionValueEF: Number(currentContribValueEF || 0),
        currentContributionValueTypeEE: currentContributionValueTypeEE || currentContributionValueType || 'percentage',
        currentContributionValueTypeE1: currentContributionValueTypeE1 || currentContributionValueType || 'percentage',
        currentContributionValueTypeEC: currentContributionValueTypeEC || currentContributionValueType || 'percentage',
        currentContributionValueTypeEF: currentContributionValueTypeEF || currentContributionValueType || 'percentage',
        // Backward-compatible derived values
        currentlyEnrolled: derivedCurrentlyEnrolled,
        currentMonthlyPremium: derivedCurrentMonthlyPremium,
        oopLevel: oopLevel || '3000',
        mwCountEE: Number(mwCountEE || 0),
        mwCountE1: Number(mwCountE1 || 0),
        mwCountEC: Number(mwCountEC || 0),
        mwCountEF: Number(mwCountEF || 0),
        currentRemainCountEE: Number(currentRemainCountEE || 0),
        currentRemainCountE1: Number(currentRemainCountE1 || 0),
        currentRemainCountEC: Number(currentRemainCountEC || 0),
        currentRemainCountEF: Number(currentRemainCountEF || 0),
        currentRemainCount: Number(currentRemainCountEE || 0) + Number(currentRemainCountE1 || 0) + Number(currentRemainCountEC || 0) + Number(currentRemainCountEF || 0),
        contributionType: contributionType || 'flat',
        contributionValueType: contributionValueType || 'dollar',
        contributionValue: Number(contributionValue || 0),
        contributionValueEE: contributionType === 'flat' ? Number(contributionValue || 0) : Number(contributionValueEE || 0),
        contributionValueE1: contributionType === 'flat' ? Number(contributionValue || 0) : Number(contributionValueE1 || 0),
        contributionValueEC: contributionType === 'flat' ? Number(contributionValue || 0) : Number(contributionValueEC || 0),
        contributionValueEF: contributionType === 'flat' ? Number(contributionValue || 0) : Number(contributionValueEF || 0),
        contributionValueTypeEE: contributionValueTypeEE || contributionValueType || 'percentage',
        contributionValueTypeE1: contributionValueTypeE1 || contributionValueType || 'percentage',
        contributionValueTypeEC: contributionValueTypeEC || contributionValueType || 'percentage',
        contributionValueTypeEF: contributionValueTypeEF || contributionValueType || 'percentage',
        enrollmentDate: enrollmentDate || '',
        tenantId: agentTenantId
      };

      console.log(`🔢 Computing calculations for document "${doc.Name}"...`);
      const calcResults = await computeAllCalculations(inputs, Array.from(calcTypes), productSlots);
      console.log(`✅ Computed ${Object.keys(calcResults).length} calculation values`);

      // Generate PDF
      let pdfUrl;
      let pdfBuffer = null;

      if (existingPdfUrl && docIds.length === 1) {
        pdfUrl = existingPdfUrl;
      } else {
        console.log(`📄 Generating PDF for "${doc.Name}"...`);
        pdfBuffer = await ProposalGeneratorService.generateProposalPDF(
          docId,
          agentId,
          null,
          prospectInfo,
          'EE',
          false,
          30,
          enrollmentLinkUrls || {},
          customFieldValues || {},
          calcResults,
          enrollmentDate || null
        );

        console.log('📤 Uploading business proposal PDF...');
        pdfUrl = await ProposalGeneratorService.uploadProposalPDF(pdfBuffer, `${companyName}-${doc.Name}`);
      }

      // Save send record
      const pool = await getPool();
      const request = pool.request();
      const proposalSendId = require('crypto').randomUUID();

      request.input('proposalSendId', sql.UniqueIdentifier, proposalSendId);
      request.input('proposalDocumentId', sql.UniqueIdentifier, docId);
      request.input('agentId', sql.UniqueIdentifier, agentId);
      request.input('prospectName', sql.NVarChar, companyName);
      request.input('prospectEmail', sql.NVarChar, recipientEmail || null);
      request.input('prospectPhone', sql.NVarChar, recipientPhone || null);
      request.input('prospectAddress', sql.NVarChar, companyAddress || null);
      request.input('tier', sql.NVarChar, 'Business');
      request.input('tobaccoUse', sql.Bit, false);
      request.input('age', sql.Int, 0);
      request.input('generatedPdfUrl', sql.NVarChar, pdfUrl);
      request.input('sentBy', sql.UniqueIdentifier, req.user.UserId);
      request.input('sendMethod', sql.NVarChar, sendMethod);

      await request.query(`
        INSERT INTO oe.ProposalSends 
        (ProposalSendId, ProposalDocumentId, AgentId, ProspectName, ProspectEmail, 
         ProspectPhone, ProspectAddress, Tier, TobaccoUse, Age, GeneratedPdfUrl, 
         SentDate, SentBy, SendMethod)
        VALUES 
        (@proposalSendId, @proposalDocumentId, @agentId, @prospectName, @prospectEmail,
         @prospectPhone, @prospectAddress, @tier, @tobaccoUse, @age, @generatedPdfUrl,
         GETDATE(), @sentBy, @sendMethod)
      `);

      console.log(`✅ Saved send record: ${proposalSendId}`);

      // Create-or-find the prospect for this business proposal and link it (best-effort).
      // Also track the company as a GroupProspect and link the prospect to it, so a
      // group and its proposal recipients can be associated. All idempotent/deduped.
      try {
        const ProspectService = require('../services/prospect.service');
        const prospectId = await ProspectService.recordProposalProspect({
          tenantId: agentTenantId,
          agentId,
          name: companyName,
          email: recipientEmail || null,
          phone: recipientPhone || null,
          source: 'Proposal',
          createdBy: req.user.UserId,
        });
        if (prospectId) {
          await pool.request()
            .input('prospectId', sql.UniqueIdentifier, prospectId)
            .input('sendId', sql.UniqueIdentifier, proposalSendId)
            .query('UPDATE oe.ProposalSends SET ProspectId = @prospectId WHERE ProposalSendId = @sendId');
        }

        const groupProspectId = await ProspectService.findOrCreateGroupProspect({
          tenantId: agentTenantId,
          agentId,
          companyName,
          contactName: companyName,
          email: recipientEmail || null,
          phone: recipientPhone || null,
          totalEmployees: typeof totalEmployees === 'number' ? totalEmployees : (parseInt(totalEmployees, 10) || null),
          createdBy: req.user.UserId,
        });
        if (groupProspectId && prospectId) {
          await ProspectService.linkProspectToGroup(pool, prospectId, groupProspectId);
        }
      } catch (prospectErr) {
        console.warn('⚠️ Prospect link from business proposal failed (non-fatal):', prospectErr.message);
      }

      generatedDocs.push({
        proposalSendId,
        proposalDocumentId: docId,
        documentName: doc.Name,
        pdfUrl,
        pdfBuffer
      });
    }

    if (generatedDocs.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No documents were generated. Check that the document IDs are valid.'
      });
    }

    // --- Send via email if requested ---
    if (sendMethod === 'email' && recipientEmail) {
      try {
        console.log(`📧 Sending ${generatedDocs.length} document(s) via email to ${recipientEmail}...`);

        const agentInfo = await ProposalGeneratorService.getAgentInfo(agentId);
        const agentName = agentInfo.fullName;
        const agentEmail = agentInfo.email || req.user.Email;

        const messageText = emailMessage || `Dear ${companyName},\n\nPlease find attached your personalized business benefits proposal.\n\nIf you have any questions, please don't hesitate to reach out.\n\nBest regards,\n${agentName}`;
        const messageHtml = messageText.replace(/\n/g, '<br>');

        const attachments = [];
        for (const doc of generatedDocs) {
          let buffer = doc.pdfBuffer;
          if (!buffer) {
            const { BlobServiceClient } = require('@azure/storage-blob');
            const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
            const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
            const urlObj = new URL(doc.pdfUrl.split('?')[0]);
            const pathParts = urlObj.pathname.split('/').filter(p => p);
            const containerName = pathParts[0];
            const blobName = pathParts.slice(1).join('/');
            const containerClient = blobServiceClient.getContainerClient(containerName);
            const blockBlobClient = containerClient.getBlockBlobClient(blobName);
            const downloadResponse = await blockBlobClient.download(0);
            const chunks = [];
            for await (const chunk of downloadResponse.readableStreamBody) {
              chunks.push(chunk);
            }
            buffer = Buffer.concat(chunks);
          }

          attachments.push({
            content: buffer.toString('base64'),
            filename: `${doc.documentName.replace(/[^a-zA-Z0-9]/g, '_')}-${companyName.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`,
            type: 'application/pdf',
            disposition: 'attachment'
          });
        }

        const emailConfig = await sendGridEmailService.getTenantEmailConfig(req.user.TenantId);
        const fromEmail = resolveFromEmailForTenant(emailConfig);

        await sendGridEmailService.sendEmail({
          tenantId: req.user.TenantId,
          to: recipientEmail,
          from: fromEmail,
          replyTo: { email: agentEmail, name: agentName },
          subject: `Business Benefits Proposal for ${companyName} from ${agentName}`,
          html: messageHtml,
          text: messageText,
          attachments,
          metadata: {
            sentBy: req.user.UserId,
            sentByEmail: agentEmail,
            sentByRoles: getUserRoles(req.user),
            fromName: agentName
          }
        });

        console.log(`✅ Business proposal email sent successfully`);
      } catch (emailError) {
        console.error('❌ Error sending business proposal email:', emailError);
      }
    }

    // --- Send via SMS if requested ---
    if (sendMethod === 'text' && recipientPhone) {
      try {
        console.log(`📱 Sending business proposal via SMS to ${recipientPhone}...`);

        let phoneNumber = recipientPhone.replace(/\D/g, '');
        if (!phoneNumber.startsWith('+')) {
          phoneNumber = '+1' + phoneNumber;
        }

        const baseMessage = textMessage || `Hi ${companyName}, your business benefits proposal is ready!`;
        const smsContent = buildSmsBodyWithLinks(
          baseMessage,
          generatedDocs.map((d) => d.pdfUrl),
          { linkLabel: 'View your proposal:' }
        );

        await MessageQueueService.queueMessage({
          tenantId: req.user.TenantId,
          messageType: 'SMS',
          recipientAddress: phoneNumber,
          subject: null,
          messageBody: smsContent,
          status: 'Pending',
          createdBy: req.user.UserId,
          recipientId: null
        });

        console.log(`✅ Business proposal SMS queued successfully`);
      } catch (smsError) {
        console.error('❌ Error queuing business proposal SMS:', smsError);
      }
    }

    // --- Response ---
    res.json({
      success: true,
      data: {
        documents: generatedDocs.map(d => ({
          proposalSendId: d.proposalSendId,
          proposalDocumentId: d.proposalDocumentId,
          documentName: d.documentName,
          pdfUrl: d.pdfUrl
        })),
        // Legacy compat: also include top-level fields from first doc
        proposalSendId: generatedDocs[0].proposalSendId,
        pdfUrl: generatedDocs[0].pdfUrl,
        sendMethod,
        sentAt: new Date().toISOString()
      },
      message: `${generatedDocs.length} document(s) generated and sent successfully`
    });
  } catch (error) {
    console.error('❌ Error generating/sending business proposal:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to generate/send business proposal',
      error: {
        message: error.message,
        code: 'GENERATE_BUSINESS_PROPOSAL_ERROR'
      }
    });
  }
});

/**
 * POST /api/business-proposal-sends/tier-prices
 * Returns tier prices (EE, E1, EC, EF) for one or more products,
 * using the same calcMwTierPrice function that PDF generation uses.
 * EC (Employee+Children) is only populated for products that price the EC tier;
 * 3-tier products return ec=0 and the frontend hides the EC column.
 * This ensures the frontend blue box matches the generated PDF.
 * @access Agent, TenantAdmin, SysAdmin
 */
router.post('/tier-prices', authorize(['Agent', 'TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const { products, oopLevel, enrollmentDate } = req.body;
    // products: [{ productId, productName }]

    if (!products || !Array.isArray(products) || products.length === 0) {
      return res.status(400).json({ success: false, message: 'products array is required' });
    }

    // Resolve agent's tenantId for processing fee calculation
    let agentId;
    try {
      agentId = await getAgentIdFromUserId(req.user.UserId);
    } catch (_) {
      agentId = null;
    }
    const tenantId = agentId ? await getAgentTenantId(agentId) : null;

    const tiers = ['EE', 'E1', 'EC', 'EF'];
    const rows = [];

    for (const product of products) {
      const prices = { EE: 0, E1: 0, EC: 0, EF: 0 };
      for (const tier of tiers) {
        try {
          prices[tier] = await calcMwTierPrice(product.productId, oopLevel, tier, tenantId, enrollmentDate || null);
        } catch (err) {
          console.error(`⚠️ Tier price error for ${product.productId} ${tier}:`, err.message);
          prices[tier] = 0;
        }
      }
      rows.push({
        productId: product.productId,
        productName: product.productName || '',
        ee: prices.EE,
        e1: prices.E1,
        ec: prices.EC,
        ef: prices.EF
      });
    }

    res.json({ success: true, data: rows });
  } catch (error) {
    console.error('❌ Error in /tier-prices:', error);
    res.status(500).json({ success: false, message: 'Server error calculating tier prices' });
  }
});

module.exports = router;
