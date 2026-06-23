// backend/routes/proposal-sends.js
// Routes for generating and sending proposals

const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/database');
const { authorize, getUserRoles } = require('../middleware/auth');
const ProposalGeneratorService = require('../services/proposalGenerator.service');
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
 * Validate that agentId belongs to the tenant (for TenantAdmin).
 * Returns agentId if valid; throws or returns null if invalid.
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
 * POST /api/proposal-sends
 * Generate and send proposal
 * @access Agent, TenantAdmin, SysAdmin
 */
router.post('/', authorize(['Agent', 'TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const {
      proposalDocumentId,
      prospectInfo,
      tier,
      tobaccoUse,
      age,
      sendMethod, // 'email', 'text', 'download'
      enrollmentLinkUrls, // Map of EnrollmentLinkTemplateId to URL for enrollment link fields
      customFieldValues, // Map of fieldId to value for custom fields
      existingPdfUrl, // Optional: reuse existing PDF if provided
      emailMessage, // Optional: custom message for email
      textMessage, // Optional: custom message for text/SMS
      agentId: bodyAgentId // Optional: for TenantAdmin - which agent the proposal is for
    } = req.body;
    
    // Validate required fields
    if (!proposalDocumentId || !prospectInfo || !tier || tobaccoUse === undefined || !age) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: proposalDocumentId, prospectInfo, tier, tobaccoUse, age'
      });
    }
    
    if (!prospectInfo.name) {
      return res.status(400).json({
        success: false,
        message: 'Prospect name is required'
      });
    }
    
    // Validate send method
    if (!['email', 'text', 'download'].includes(sendMethod)) {
      return res.status(400).json({
        success: false,
        message: 'sendMethod must be one of: email, text, download'
      });
    }
    
    // Validate contact method based on send method
    if (sendMethod === 'email' && !prospectInfo.email) {
      return res.status(400).json({
        success: false,
        message: 'Email is required when sendMethod is "email"'
      });
    }
    
    if (sendMethod === 'text' && !prospectInfo.phone) {
      return res.status(400).json({
        success: false,
        message: 'Phone is required when sendMethod is "text"'
      });
    }
    
    // Get agent ID - Agent uses own profile; TenantAdmin/SysAdmin may pass agentId
    const userRoles = getUserRoles(req.user);
    let agentId;
    if (bodyAgentId && (userRoles.includes('TenantAdmin') || userRoles.includes('SysAdmin'))) {
      // Validate agent belongs to tenant (TenantAdmin only; SysAdmin can pass any agent)
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
        // SysAdmin: optional validation that agent exists
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
          message: 'Agent profile required to send proposals. Please ensure you have an active agent account.'
        });
      }
    }
    
    // Generate or reuse proposal PDF
    let pdfUrl;
    let pdfBuffer = null; // Store PDF buffer for email attachment if needed
    if (existingPdfUrl) {
      // Reuse existing PDF if provided
      console.log('📄 Reusing existing PDF:', existingPdfUrl);
      pdfUrl = existingPdfUrl;
    } else {
      // Generate new proposal PDF
      // Note: productId is no longer required - pricing placeholders in the document determine which products to calculate
      console.log('📄 Generating proposal PDF...');
      pdfBuffer = await ProposalGeneratorService.generateProposalPDF(
        proposalDocumentId,
        agentId,
        null, // productId is no longer used - pricing placeholders handle product selection
        prospectInfo, // Includes hasSpouse and childrenCount for tier description
        tier,
        tobaccoUse,
        age,
        enrollmentLinkUrls || {},
        customFieldValues || {} // Map of fieldId to value for custom fields
      );
      
      // Upload PDF to blob storage
      console.log('📤 Uploading proposal PDF...');
      pdfUrl = await ProposalGeneratorService.uploadProposalPDF(pdfBuffer, prospectInfo.name);
    }
    
    // Save proposal send record
    const pool = await getPool();
    const request = pool.request();
    const proposalSendId = require('crypto').randomUUID();
    
    request.input('proposalSendId', sql.UniqueIdentifier, proposalSendId);
    request.input('proposalDocumentId', sql.UniqueIdentifier, proposalDocumentId);
    request.input('agentId', sql.UniqueIdentifier, agentId);
    request.input('prospectName', sql.NVarChar, prospectInfo.name);
    request.input('prospectEmail', sql.NVarChar, prospectInfo.email || null);
    request.input('prospectPhone', sql.NVarChar, prospectInfo.phone || null);
    request.input('prospectAddress', sql.NVarChar, prospectInfo.address || null);
    request.input('tier', sql.NVarChar, tier);
    request.input('tobaccoUse', sql.Bit, tobaccoUse);
    request.input('age', sql.Int, age);
    request.input('dateOfBirth', sql.Date, prospectInfo.dateOfBirth ? new Date(prospectInfo.dateOfBirth) : null);
    request.input('generatedPdfUrl', sql.NVarChar, pdfUrl);
    request.input('sentBy', sql.UniqueIdentifier, req.user.UserId);
    request.input('sendMethod', sql.NVarChar, sendMethod);
    
    await request.query(`
      INSERT INTO oe.ProposalSends 
      (ProposalSendId, ProposalDocumentId, AgentId, ProspectName, ProspectEmail, 
       ProspectPhone, ProspectAddress, Tier, TobaccoUse, Age, DateOfBirth, GeneratedPdfUrl, 
       SentDate, SentBy, SendMethod)
      VALUES 
      (@proposalSendId, @proposalDocumentId, @agentId, @prospectName, @prospectEmail,
       @prospectPhone, @prospectAddress, @tier, @tobaccoUse, @age, @dateOfBirth, @generatedPdfUrl,
       GETDATE(), @sentBy, @sendMethod)
    `);
    
    console.log(`✅ Proposal send record saved: ${proposalSendId}`);

    // Create-or-find the prospect this proposal was sent to, and link it (best-effort).
    try {
      const ProspectService = require('../services/prospect.service');
      const prospectId = await ProspectService.recordProposalProspect({
        tenantId: req.user.TenantId,
        agentId,
        name: prospectInfo.name,
        email: prospectInfo.email || null,
        phone: prospectInfo.phone || null,
        source: 'Proposal',
        createdBy: req.user.UserId,
      });
      if (prospectId) {
        await pool.request()
          .input('prospectId', sql.UniqueIdentifier, prospectId)
          .input('sendId', sql.UniqueIdentifier, proposalSendId)
          .query('UPDATE oe.ProposalSends SET ProspectId = @prospectId WHERE ProposalSendId = @sendId');
      }
    } catch (prospectErr) {
      console.warn('⚠️ Prospect link from proposal send failed (non-fatal):', prospectErr.message);
    }

    // Send via email if requested
    if (sendMethod === 'email' && prospectInfo.email) {
      try {
        console.log(`📧 Sending proposal via email to ${prospectInfo.email}...`);
        
        // Get PDF buffer if we need it (if not reusing existing)
        let pdfBufferForEmail;
        if (existingPdfUrl) {
          // Download the existing PDF
          const { BlobServiceClient } = require('@azure/storage-blob');
          const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
          const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
          const urlObj = new URL(existingPdfUrl.split('?')[0]);
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
          pdfBufferForEmail = Buffer.concat(chunks);
        } else {
          pdfBufferForEmail = pdfBuffer;
        }
        
        // Convert PDF buffer to base64
        const pdfBase64 = pdfBufferForEmail.toString('base64');
        
        // Get agent info for email from address and name
        const agentInfo = await ProposalGeneratorService.getAgentInfo(agentId);
        const agentName = agentInfo.fullName;
        const agentEmail = agentInfo.email || req.user.Email;
        
        // Use custom message if provided, otherwise use default
        const messageText = emailMessage || `Dear ${prospectInfo.name},

Please find attached your personalized benefits proposal.

If you have any questions, please don't hesitate to reach out.

Best regards,
${agentName}`;
        
        // Convert plain text to HTML (preserve line breaks)
        const messageHtml = messageText.replace(/\n/g, '<br>');
        
        const emailConfig = await sendGridEmailService.getTenantEmailConfig(req.user.TenantId);
        const fromEmail = resolveFromEmailForTenant(emailConfig);

        await sendGridEmailService.sendEmail({
          tenantId: req.user.TenantId,
          to: prospectInfo.email,
          from: fromEmail,
          replyTo: { email: agentEmail, name: agentName },
          subject: `Your Personalized Benefits Proposal from ${agentName}`,
          html: messageHtml,
          text: messageText,
          attachments: [{
            content: pdfBase64,
            filename: 'proposal.pdf',
            type: 'application/pdf',
            disposition: 'attachment'
          }],
          metadata: {
            sentBy: req.user.UserId,
            sentByEmail: agentEmail,
            sentByRoles: getUserRoles(req.user),
            fromName: agentName
          }
        });
        
        console.log(`✅ Proposal email sent successfully from ${agentName} <${agentEmail}>`);
      } catch (emailError) {
        console.error('❌ Error sending proposal email:', emailError);
        // Don't fail the request, just log the error
      }
    }
    
    // Send via SMS if requested
    if (sendMethod === 'text' && prospectInfo.phone) {
      try {
        console.log(`📱 Sending proposal via SMS to ${prospectInfo.phone}...`);
        
        // Format phone number (ensure it starts with +)
        let phoneNumber = prospectInfo.phone.replace(/\D/g, ''); // Remove non-digits
        if (!phoneNumber.startsWith('+')) {
          phoneNumber = '+1' + phoneNumber; // Assume US number
        }
        
        // Use custom message if provided, otherwise use default
        // Append PDF link to the message
        const baseMessage = textMessage || `Hi ${prospectInfo.name}, your personalized benefits proposal is ready!`;
        const smsContent = buildSmsBodyWithLinks(baseMessage, pdfUrl, {
          linkLabel: 'View your proposal:',
        });
        
        await MessageQueueService.queueMessage({
          tenantId: req.user.TenantId,
          messageType: 'SMS',
          recipientAddress: phoneNumber,
          subject: null,
          messageBody: smsContent,
          status: 'Pending',
          createdBy: req.user.UserId,
          recipientId: null // Not a member, just a prospect
        });
        
        console.log(`✅ Proposal SMS queued successfully`);
      } catch (smsError) {
        console.error('❌ Error queuing proposal SMS:', smsError);
        // Don't fail the request, just log the error
      }
    }
    
    res.json({
      success: true,
      data: {
        proposalSendId,
        pdfUrl,
        sendMethod,
        sentAt: new Date().toISOString()
      },
      message: 'Proposal generated and sent successfully'
    });
  } catch (error) {
    console.error('❌ Error generating/sending proposal:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to generate/send proposal',
      error: {
        message: error.message,
        code: 'GENERATE_PROPOSAL_ERROR'
      }
    });
  }
});

/**
 * GET /api/proposal-sends
 * Get proposal sending history for the current agent
 * @access Agent, TenantAdmin, SysAdmin
 */
router.get('/', authorize(['Agent', 'TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    let agentId;
    try {
      agentId = await getAgentIdFromUserId(req.user.UserId);
    } catch (error) {
      // If user is not an agent, return empty array or handle differently
      const userRoles = getUserRoles(req.user);
      if (userRoles.includes('Agent')) {
        throw error; // Re-throw if they should be an agent but aren't found
      }
      // For non-agents, return empty array for now
      return res.json({
        success: true,
        data: []
      });
    }
    
    const pool = await getPool();
    const request = pool.request();
    request.input('agentId', sql.UniqueIdentifier, agentId);
    
    const result = await request.query(`
      SELECT 
        ps.ProposalSendId,
        ps.ProposalDocumentId,
        ps.ProspectName,
        ps.ProspectEmail,
        ps.ProspectPhone,
        ps.Tier,
        ps.TobaccoUse,
        ps.Age,
        ps.GeneratedPdfUrl,
        ps.SentDate,
        ps.SendMethod,
        pd.Name as ProposalDocumentName
      FROM oe.ProposalSends ps
      LEFT JOIN oe.ProposalDocuments pd ON ps.ProposalDocumentId = pd.ProposalDocumentId
      WHERE ps.AgentId = @agentId
      ORDER BY ps.SentDate DESC
    `);
    
    res.json({
      success: true,
      data: result.recordset || []
    });
  } catch (error) {
    console.error('❌ Error getting proposal sends:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get proposal sends',
      error: {
        message: error.message,
        code: 'GET_PROPOSAL_SENDS_ERROR'
      }
    });
  }
});

module.exports = router;

