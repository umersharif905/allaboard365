// backend/services/sendGridEmailService.js
const sgMail = require('@sendgrid/mail');
const sql = require('mssql');
const crypto = require('crypto');

class SendGridEmailService {
  constructor() {
    // Initialize SendGrid with API key from environment
    this.apiKey = process.env.SENDGRID_API_KEY;
    
    if (!this.apiKey) {
      console.warn('⚠️  SENDGRID_API_KEY is not configured - email sending will be disabled');
      this.isEnabled = false;
    } else {
      try {
        sgMail.setApiKey(this.apiKey);
        console.log('✅ SendGrid initialized successfully with API key');
        this.isEnabled = true;
      } catch (error) {
        console.error('❌ Failed to initialize SendGrid:', error);
        console.warn('⚠️  Email sending will be disabled');
        this.isEnabled = false;
      }
    }
    
    // Encryption key for storing sensitive data
    this.encryptionKey = process.env.ENCRYPTION_KEY || 'default-encryption-key-change-in-production';
  }

  /**
   * Get tenant email configuration from database
   */
  async getTenantEmailConfig(tenantId) {
    try {
      const { getPool } = require('../config/database');
      const pool = await getPool();
      const result = await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .query(`
          SELECT 
            t.TenantId,
            t.Name as TenantName,
            t.ContactEmail,
            t.AdvancedSettings
          FROM oe.Tenants t
          WHERE t.TenantId = @tenantId
        `);

      if (result.recordset.length === 0) {
        throw new Error(`Tenant not found: ${tenantId}`);
      }

      const tenant = result.recordset[0];
      let emailConfig = {
        tenantName: tenant.TenantName,
        defaultFromEmail: tenant.ContactEmail || process.env.DEFAULT_FROM_EMAIL || 'noreply@allaboard365.com',
        dkimEnabled: false,
        customFromAddress: null,
        dkimDomain: null,
        dkimSelector: null,
        dkimPrivateKey: null
      };

      // Parse advanced settings for email configuration
      if (tenant.AdvancedSettings) {
        try {
          const advancedSettings = JSON.parse(tenant.AdvancedSettings);
          if (advancedSettings.email) {
            emailConfig = {
              ...emailConfig,
              ...advancedSettings.email,
              // Decrypt private key if stored
              dkimPrivateKey: advancedSettings.email.dkimPrivateKeyEncrypted 
                ? this.decryptPrivateKey(advancedSettings.email.dkimPrivateKeyEncrypted)
                : null
            };
          }
        } catch (e) {
          console.error('Error parsing tenant advanced settings:', e);
        }
      }

      return emailConfig;
    } catch (error) {
      console.error('Error fetching tenant email config:', error);
      throw error;
    }
  }

  /**
   * Decrypt DKIM private key
   */
  decryptPrivateKey(encryptedKey) {
    try {
      const algorithm = 'aes-256-gcm';
      const keyBuffer = Buffer.from(this.encryptionKey.slice(0, 32).padEnd(32, '0'));
      
      // Parse the encrypted data (format: iv:authTag:encrypted)
      const parts = encryptedKey.split(':');
      if (parts.length !== 3) {
        throw new Error('Invalid encrypted key format');
      }

      const iv = Buffer.from(parts[0], 'hex');
      const authTag = Buffer.from(parts[1], 'hex');
      const encrypted = Buffer.from(parts[2], 'hex');

      const decipher = crypto.createDecipheriv(algorithm, keyBuffer, iv);
      decipher.setAuthTag(authTag);

      let decrypted = decipher.update(encrypted);
      decrypted = Buffer.concat([decrypted, decipher.final()]);

      return decrypted.toString('utf8');
    } catch (error) {
      console.error('Error decrypting private key:', error);
      return null;
    }
  }

  /**
   * Encrypt DKIM private key for storage
   */
  encryptPrivateKey(privateKey) {
    try {
      const algorithm = 'aes-256-gcm';
      const keyBuffer = Buffer.from(this.encryptionKey.slice(0, 32).padEnd(32, '0'));
      const iv = crypto.randomBytes(16);
      
      const cipher = crypto.createCipheriv(algorithm, keyBuffer, iv);
      
      let encrypted = cipher.update(privateKey, 'utf8');
      encrypted = Buffer.concat([encrypted, cipher.final()]);
      
      const authTag = cipher.getAuthTag();
      
      // Return format: iv:authTag:encrypted
      return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
    } catch (error) {
      console.error('Error encrypting private key:', error);
      throw error;
    }
  }

  /**
   * Sign email with DKIM if configured
   */
  generateDKIMSignature(emailConfig, messageData) {
    if (!emailConfig.dkimEnabled || !emailConfig.dkimPrivateKey) {
      return null;
    }

    try {
      const canonicalHeaders = [
        `from:${messageData.from}`,
        `to:${messageData.to}`,
        `subject:${messageData.subject}`,
        `date:${new Date().toUTCString()}`
      ].join('\r\n');

      const sign = crypto.createSign('RSA-SHA256');
      sign.update(canonicalHeaders);
      sign.end();

      const signature = sign.sign(emailConfig.dkimPrivateKey, 'base64');

      return {
        'DKIM-Signature': `v=1; a=rsa-sha256; c=relaxed/relaxed; ` +
          `d=${emailConfig.dkimDomain}; s=${emailConfig.dkimSelector}; ` +
          `h=from:to:subject:date; ` +
          `bh=${crypto.createHash('sha256').update(messageData.html || messageData.text).digest('base64')}; ` +
          `b=${signature}`
      };
    } catch (error) {
      console.error('Error generating DKIM signature:', error);
      return null;
    }
  }

  /**
   * Send email through SendGrid
   */
  async sendEmail(options) {
    // Skip if SendGrid is not enabled
    if (!this.isEnabled) {
      console.log('📧 [DEV MODE] Email sending skipped (SendGrid not configured):', {
        to: options.to,
        subject: options.subject
      });
      return { success: true, message: 'Email skipped in development mode', messageId: 'dev-mode-skip' };
    }
    
    const {
      tenantId,
      to,
      from,
      cc,
      bcc,
      subject,
      html,
      text,
      attachments,
      templateId,
      dynamicTemplateData,
      categories = [],
      metadata = {},
      replyTo = null,
      messageId: customArgsMessageId // optional: oe.MessageHistory.MessageId for webhook linkage (renamed to avoid shadowing the SendGrid-response messageId below)
    } = options;

    try {
      const normalizedHtml = (typeof html === 'string')
        ? html.replace(/^\uFEFF/, '').trimStart()
        : html;
      const normalizedText = (typeof text === 'string')
        ? text.replace(/^\uFEFF/, '').trimStart()
        : text;

      let emailConfig = {
        tenantName: 'AllAboard365',
        defaultFromEmail: process.env.DEFAULT_FROM_EMAIL || 'noreply@allaboard365.com',
        dkimEnabled: false
      };

      // Get tenant email configuration if tenantId is provided
      if (tenantId && tenantId !== 'undefined' && tenantId !== 'null') {
        try {
          emailConfig = await this.getTenantEmailConfig(tenantId);
        } catch (error) {
          console.warn('Could not fetch tenant email config, using defaults:', error.message);
        }
      }

      // Determine the from address
      // Use metadata.fromName if provided (for agent emails), otherwise use tenant name
      const fromEmail = from || emailConfig.customFromAddress || emailConfig.defaultFromEmail || process.env.DEFAULT_FROM_EMAIL || 'noreply@allaboard365.com';
      const fromName = metadata.fromName || emailConfig.tenantName || 'AllAboard365';
      console.log('🔍 DEBUG: From email:', fromEmail);
      console.log('🔍 DEBUG: From name:', fromName);

      // Build the message object
      const msg = {
        to,
        from: {
          email: fromEmail,
          name: fromName
        },
        ...(replyTo && replyTo.email
          ? {
              replyTo: {
                email: replyTo.email,
                name: replyTo.name || replyTo.email
              }
            }
          : {}),
        subject,
        ...(cc && { cc }),
        ...(bcc && { bcc }),
        ...(normalizedHtml && { html: normalizedHtml }),
        ...(normalizedText && { text: normalizedText }),
        ...(templateId && { templateId }),
        ...(dynamicTemplateData && { dynamicTemplateData }),
        ...(attachments && { attachments }),
        categories: [...categories, ...(tenantId && tenantId !== 'undefined' && tenantId !== 'null' ? [`tenant:${tenantId}`] : [])],
        customArgs: {
          ...(tenantId && tenantId !== 'undefined' && tenantId !== 'null' && { tenantId }),
          ...(customArgsMessageId ? { MessageId: customArgsMessageId } : {}),
          ...metadata
        }
      };

      // Add DKIM headers if configured and tenant exists
      if (tenantId && tenantId !== 'undefined' && tenantId !== 'null' && emailConfig.dkimEnabled) {
        const dkimHeaders = this.generateDKIMSignature(emailConfig, msg);
        if (dkimHeaders) {
          msg.headers = dkimHeaders;
        }
      }

      const attachmentCount = Array.isArray(attachments) ? attachments.length : 0;
      console.log('📧 SendGrid: invoking send', {
        to: Array.isArray(to) ? to : [to],
        subject: typeof subject === 'string' ? subject.slice(0, 80) : subject,
        attachmentCount
      });

      // Send the email
      const result = await sgMail.send(msg);

      const headers = result && result[0] && result[0].headers ? result[0].headers : {};
      const messageId =
        headers['x-message-id'] ||
        headers['X-Message-Id'] ||
        headers['X-Message-ID'] ||
        null;
      const statusCode = result && result[0] ? result[0].statusCode : undefined;

      console.log('📧 SendGrid: send accepted', { messageId, statusCode });

      // Log to DB without blocking the HTTP response (pool slowness must not hang the client)
      if (tenantId && tenantId !== 'undefined' && tenantId !== 'null') {
        void this.logEmailSend({
          tenantId,
          to: Array.isArray(to) ? to.join(',') : to,
          subject,
          status: 'sent',
          messageId,
          metadata
        }).catch((err) => console.error('📧 SendGrid: EmailLogs insert failed (email may still have been sent):', err.message));
      }

      return {
        success: true,
        messageId: messageId || 'unknown',
        statusCode
      };

    } catch (error) {
      console.error('SendGrid email error:', error);
      if (error && error.response && error.response.body) {
        console.error('SendGrid email error body:', JSON.stringify(error.response.body));
      }

      // Log the failure if tenantId provided (non-blocking)
      if (tenantId && tenantId !== 'undefined' && tenantId !== 'null') {
        void this.logEmailSend({
          tenantId,
          to: Array.isArray(options.to) ? options.to.join(',') : options.to,
          subject: options.subject,
          status: 'failed',
          error: error.message,
          metadata: options.metadata
        }).catch((err) => console.error('📧 SendGrid: failed-send EmailLogs insert failed:', err.message));
      }

      throw error;
    }
  }

  /**
   * Send transactional emails with tenant branding
   */
  async sendTransactionalEmail(tenantId, type, recipientData, templateData = {}) {
    // Skip if SendGrid is not enabled
    if (!this.isEnabled) {
      console.log('📧 [DEV MODE] Transactional email skipped:', { type, to: recipientData.email });
      return { success: true, message: 'Email skipped in development mode' };
    }
    
    const templates = {
      welcome: {
        subject: 'Welcome to {{tenantName}}',
        templateId: process.env.SENDGRID_TEMPLATE_WELCOME
      },
      enrollment_confirmation: {
        subject: 'Enrollment Confirmation - {{productName}}',
        templateId: process.env.SENDGRID_TEMPLATE_ENROLLMENT
      },
      payment_confirmation: {
        subject: 'Payment Confirmation - {{amount}}',
        templateId: process.env.SENDGRID_TEMPLATE_PAYMENT
      },
      password_reset: {
        subject: 'Password Reset Request',
        templateId: process.env.SENDGRID_TEMPLATE_PASSWORD_RESET
      },
      agent_onboarding: {
        subject: 'Welcome to the {{tenantName}} Team',
        templateId: process.env.SENDGRID_TEMPLATE_AGENT_ONBOARDING
      }
    };

    const template = templates[type];
    if (!template) {
      throw new Error(`Unknown email template type: ${type}`);
    }

    // Get tenant configuration for branding
    const emailConfig = await this.getTenantEmailConfig(tenantId);

    // Prepare dynamic template data with tenant branding
    const dynamicData = {
      tenantName: emailConfig.tenantName,
      ...templateData,
      branding: {
        primaryColor: templateData.primaryColor || '#1f6db0',
        logo: templateData.logo || null,
        footer: templateData.footer || `© ${new Date().getFullYear()} ${emailConfig.tenantName}`
      }
    };

    // Process subject line with template variables
    let subject = template.subject;
    Object.keys(dynamicData).forEach(key => {
      subject = subject.replace(`{{${key}}}`, dynamicData[key]);
    });

    return this.sendEmail({
      tenantId,
      to: recipientData.email,
      subject,
      templateId: template.templateId,
      dynamicTemplateData: dynamicData,
      categories: [type],
      metadata: {
        emailType: type,
        recipientId: recipientData.id
      }
    });
  }

  /**
   * Send bulk emails with rate limiting
   */
  async sendBulkEmails(tenantId, recipients, emailOptions) {
    // Skip if SendGrid is not enabled
    if (!this.isEnabled) {
      console.log('📧 [DEV MODE] Bulk email sending skipped:', { recipientCount: recipients.length });
      return { success: true, sent: 0, failed: 0, results: [] };
    }
    
    const results = [];
    const batchSize = 100; // SendGrid's limit for batch sending
    const delayBetweenBatches = 1000; // 1 second between batches

    // Process recipients in batches
    for (let i = 0; i < recipients.length; i += batchSize) {
      const batch = recipients.slice(i, i + batchSize);
      
      try {
        // Create personalized messages for each recipient
        const messages = await Promise.all(batch.map(async recipient => {
          const emailConfig = await this.getTenantEmailConfig(tenantId);
          const fromEmail = emailConfig.customFromAddress || emailConfig.defaultFromEmail || process.env.DEFAULT_FROM_EMAIL || 'noreply@allaboard365.com';
          
          const personalizedHtml = this.personalizeContent(emailOptions.html || '', recipient);
          const personalizedText = emailOptions.text ? this.personalizeContent(emailOptions.text, recipient) : undefined;
          return {
            to: recipient.email,
            from: {
              email: fromEmail,
              name: emailConfig.tenantName
            },
            subject: emailOptions.subject,
            html: personalizedHtml.replace(/^\uFEFF/, '').trimStart(),
            text: personalizedText ? personalizedText.replace(/^\uFEFF/, '').trimStart() : undefined,
            categories: ['bulk', `tenant:${tenantId}`],
            customArgs: {
              tenantId,
              recipientId: recipient.id,
              campaignId: emailOptions.campaignId
            }
          };
        }));

        // Send batch
        const result = await sgMail.send(messages);
        results.push({
          batch: Math.floor(i / batchSize) + 1,
          success: true,
          count: batch.length
        });

        // Delay between batches to avoid rate limits
        if (i + batchSize < recipients.length) {
          await new Promise(resolve => setTimeout(resolve, delayBetweenBatches));
        }

      } catch (error) {
        console.error(`Batch ${Math.floor(i / batchSize) + 1} failed:`, error);
        results.push({
          batch: Math.floor(i / batchSize) + 1,
          success: false,
          error: error.message
        });
      }
    }

    return results;
  }

  /**
   * Personalize email content with recipient data
   */
  personalizeContent(content, recipient) {
    let personalizedContent = content;
    
    // Replace merge tags
    Object.keys(recipient).forEach(key => {
      const regex = new RegExp(`{{${key}}}`, 'g');
      personalizedContent = personalizedContent.replace(regex, recipient[key]);
    });

    return personalizedContent;
  }

  /**
   * Log email sends for auditing
   */
  async logEmailSend(data) {
    try {
      const { getPool } = require('../config/database');
      const pool = await getPool();
      await pool.request()
        .input('tenantId', sql.UniqueIdentifier, data.tenantId)
        .input('recipient', sql.NVarChar(255), data.to)
        .input('subject', sql.NVarChar(255), data.subject)
        .input('status', sql.NVarChar(50), data.status)
        .input('messageId', sql.NVarChar(255), data.messageId || null)
        .input('error', sql.NVarChar(sql.MAX), data.error || null)
        .input('metadata', sql.NVarChar(sql.MAX), JSON.stringify(data.metadata || {}))
        .query(`
          INSERT INTO oe.EmailLogs (
            TenantId, Recipient, Subject, Status, MessageId, Error, Metadata, CreatedDate
          ) VALUES (
            @tenantId, @recipient, @subject, @status, @messageId, @error, @metadata, GETDATE()
          )
        `);
    } catch (error) {
      console.error('Error logging email send:', error);
      // Don't throw - logging should not break email sending
    }
  }

  /**
   * Verify tenant domain configuration with SendGrid
   */
  async verifyDomainAuthentication(tenantId) {
    try {
      const emailConfig = await this.getTenantEmailConfig(tenantId);
      
      if (!emailConfig.dkimEnabled || !emailConfig.dkimDomain) {
        return {
          verified: false,
          message: 'DKIM not configured for this tenant'
        };
      }

      // Send a test email to verify configuration
      const testResult = await this.sendEmail({
        tenantId,
        to: process.env.TEST_EMAIL_ADDRESS || 'test@allaboard365.com',
        subject: 'Domain Authentication Test',
        text: `Testing domain authentication for ${emailConfig.dkimDomain}`,
        categories: ['domain-test']
      });

      return {
        verified: true,
        message: 'Domain authentication verified successfully',
        messageId: testResult.messageId
      };

    } catch (error) {
      return {
        verified: false,
        message: 'Domain authentication failed',
        error: error.message
      };
    }
  }

  /**
   * Get email statistics for a tenant
   */
  async getEmailStats(tenantId, startDate, endDate) {
    try {
      const { getPool } = require('../config/database');
      const pool = await getPool();
      const result = await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('startDate', sql.DateTime, startDate)
        .input('endDate', sql.DateTime, endDate)
        .query(`
          SELECT 
            COUNT(*) as totalEmails,
            SUM(CASE WHEN Status = 'sent' THEN 1 ELSE 0 END) as sentEmails,
            SUM(CASE WHEN Status = 'failed' THEN 1 ELSE 0 END) as failedEmails,
            CAST(CreatedDate as DATE) as date
          FROM oe.EmailLogs
          WHERE TenantId = @tenantId
            AND CreatedDate BETWEEN @startDate AND @endDate
          GROUP BY CAST(CreatedDate as DATE)
          ORDER BY date DESC
        `);

      return result.recordset;
    } catch (error) {
      console.error('Error fetching email stats:', error);
      throw error;
    }
  }
  /**
   * Send password reset email
   * @param {string} to - Recipient email address
   * @param {string} resetToken - Password reset token
   * @param {string} firstName - User's first name
   * @param {string} tenantId - Tenant ID for branding
   * @returns {Promise<Object>} SendGrid response
   */
  async sendPasswordResetEmail(to, resetToken, firstName = 'User', tenantId = null) {
    try {
      if (!this.isEnabled) {
        throw new Error('Email service is not enabled - SENDGRID_API_KEY not configured');
      }

      // Get tenant configuration for branding
      const emailConfig = await this.getTenantEmailConfig(tenantId);
      
      // Construct reset URL - use tenant custom domain if available, otherwise use default
      // Never use localhost as fallback
      let resetUrl;
      if (emailConfig.customDomain) {
        resetUrl = `https://${emailConfig.customDomain}/reset-password/${resetToken}`;
      } else {
        resetUrl = `https://app.allaboard365.com/reset-password/${resetToken}`;
      }

      // Determine the from address with fallback
      const fromEmail = emailConfig.customFromAddress || emailConfig.defaultFromEmail || process.env.DEFAULT_FROM_EMAIL || 'noreply@allaboard365.com';
      const fromName = emailConfig.tenantName || 'AllAboard365';

      const msg = {
        to: to,
        from: {
          email: fromEmail,
          name: fromName
        },
        subject: 'Reset Your Password',
        html: `
          <!DOCTYPE html>
          <html>
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Password Reset</title>
          </head>
          <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
            <div style="text-align: center; margin-bottom: 30px;">
              <img src="${emailConfig.logoUrl || '/images/branding/allaboard365/allaboard365-logo-transparent.png'}" alt="${emailConfig.tenantName || 'AllAboard365'}" style="max-height: 60px;">
            </div>
            
            <h2 style="color: ${emailConfig.primaryColor || '#1f6db0'}; text-align: center;">Password Reset Request</h2>
            
            <p>Hello ${firstName},</p>
            
            <p>We received a request to reset your password for your ${emailConfig.tenantName || 'AllAboard365'} account.</p>
            
            <p>Click the button below to reset your password:</p>
            
            <div style="text-align: center; margin: 30px 0;">
              <a href="${resetUrl}" 
                 style="background-color: ${emailConfig.primaryColor || '#1f6db0'}; 
                        color: white; 
                        padding: 12px 30px; 
                        text-decoration: none; 
                        border-radius: 5px; 
                        display: inline-block;
                        font-weight: bold;">
                Reset Password
              </a>
            </div>
            
            <p style="font-size: 14px; color: #666;">
              If the button doesn't work, copy and paste this link into your browser:<br>
              <a href="${resetUrl}" style="color: ${emailConfig.primaryColor || '#1f6db0'}; word-break: break-all;">${resetUrl}</a>
            </p>
            
            <div style="background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin: 20px 0;">
              <p style="margin: 0; font-size: 14px; color: #666;">
                <strong>Important:</strong> This link will expire in 15 minutes for security reasons. 
                If you didn't request this password reset, please ignore this email.
              </p>
            </div>
            
            <p style="font-size: 14px; color: #666;">
              Best regards,<br>
              The ${emailConfig.tenantName || 'AllAboard365'} Team
            </p>
          </body>
          </html>
        `.replace(/^\uFEFF/, '').trimStart()
      };

      console.log(`📧 Sending password reset email to: ${to}`);
      const response = await sgMail.send(msg);
      console.log('✅ Password reset email sent successfully');
      
      return {
        success: true,
        messageId: response[0].headers['x-message-id'],
        response: response[0]
      };

    } catch (error) {
      console.error('❌ Failed to send password reset email:', error);
      throw error;
    }
  }

  /**
   * Send email verification code
   * @param {string} to - Recipient email address
   * @param {string} verificationCode - 6-digit verification code
   * @param {string} agentName - Agent's name
   * @param {string} tenantId - Tenant ID for branding
   * @returns {Promise<Object>} SendGrid response
   */
  async sendVerificationCode(to, verificationCode, agentName = 'your agent', tenantId = null) {
    try {
      if (!this.isEnabled) {
        console.log('📧 [DEV MODE] Verification code email skipped:', { to, code: verificationCode });
        return { success: true, message: 'Email skipped in development mode' };
      }

      // Get tenant configuration for branding
      let emailConfig = {
        tenantName: 'AllAboard365',
        defaultFromEmail: process.env.DEFAULT_FROM_EMAIL || 'noreply@allaboard365.com'
      };

      if (tenantId) {
        try {
          emailConfig = await this.getTenantEmailConfig(tenantId);
        } catch (error) {
          console.warn('Could not fetch tenant email config, using defaults:', error.message);
        }
      }

      // Load email template
      const fs = require('fs');
      const path = require('path');
      const templatePath = path.join(__dirname, '../templates/emails/email-verification-code.html');
      let htmlTemplate = fs.readFileSync(templatePath, 'utf8');

      // Replace template variables
      htmlTemplate = htmlTemplate
        .replace(/{{tenantName}}/g, emailConfig.tenantName || 'AllAboard365')
        .replace(/{{agentName}}/g, agentName)
        .replace(/{{verificationCode}}/g, verificationCode)
        .replace(/{{year}}/g, new Date().getFullYear().toString());

      // Determine the from address with fallback
      const fromEmail = emailConfig.customFromAddress || emailConfig.defaultFromEmail || process.env.DEFAULT_FROM_EMAIL || 'noreply@allaboard365.com';
      const fromName = emailConfig.tenantName || 'AllAboard365';

      const msg = {
        to: to,
        from: {
          email: fromEmail,
          name: fromName
        },
        subject: `Verify Your Email - ${emailConfig.tenantName || 'AllAboard365'}`,
        html: htmlTemplate.replace(/^\uFEFF/, '').trimStart(),
        categories: ['email-verification', 'enrollment'],
        customArgs: {
          emailType: 'email_verification',
          ...(tenantId && { tenantId })
        }
      };

      console.log(`📧 Sending verification code to: ${to}`);
      const response = await sgMail.send(msg);
      console.log('✅ Verification code email sent successfully');
      
      return {
        success: true,
        messageId: response[0].headers['x-message-id'],
        response: response[0]
      };

    } catch (error) {
      console.error('❌ Failed to send verification code email:', error);
      throw error;
    }
  }
}

module.exports = new SendGridEmailService();