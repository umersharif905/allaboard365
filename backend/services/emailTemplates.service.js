const fs = require('fs');
const path = require('path');

/**
 * EMAIL TEMPLATES SERVICE
 * 
 * Handles loading and processing of email templates with variable substitution
 */

class EmailTemplatesService {
  /**
   * Load email template from file system
   * @param {string} templateName - Name of the template (e.g., 'enrollment-invitation')
   * @returns {string} Template HTML content
   */
  static loadTemplate(templateName) {
    try {
      const templatePath = path.join(__dirname, '..', 'templates', 'emails', `${templateName}.html`);
      return fs.readFileSync(templatePath, 'utf8');
    } catch (error) {
      console.error(`❌ Error loading template ${templateName}:`, error);
      throw new Error(`Template ${templateName} not found`);
    }
  }

  /**
   * Minify HTML content to prevent email clients from adding unwanted <br> tags
   * @param {string} htmlContent - HTML content to minify
   * @returns {string} Minified HTML content
   */
  static minifyHtml(htmlContent) {
    return htmlContent
      // Remove all line breaks and excessive whitespace
      .replace(/\r\n/g, '') // Remove Windows line breaks
      .replace(/\n/g, '') // Remove Unix line breaks
      .replace(/\r/g, '') // Remove Mac line breaks
      .replace(/\s+/g, ' ') // Replace multiple spaces with single space
      .replace(/>\s+</g, '><') // Remove spaces between tags
      .trim(); // Remove leading/trailing whitespace
  }

  /**
   * Process template with variable substitution
   * @param {string} templateContent - Raw template HTML
   * @param {Object} variables - Variables to substitute
   * @returns {string} Processed HTML
   */
  static processTemplate(templateContent, variables = {}) {
    let processedContent = templateContent;

    // Replace simple variables {{variableName}}
    Object.keys(variables).forEach(key => {
      const value = variables[key] || '';
      const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
      processedContent = processedContent.replace(regex, value);
    });

    // Handle conditional blocks {{#variableName}}...{{/variableName}}
    Object.keys(variables).forEach(key => {
      const value = variables[key];
      const hasValue = value && value.toString().trim() !== '';
      
      if (hasValue) {
        // Remove the conditional markers but keep the content
        const regex = new RegExp(`\\{\\{#${key}\\}\\}([\\s\\S]*?)\\{\\{/${key}\\}\\}`, 'g');
        processedContent = processedContent.replace(regex, '$1');
      } else {
        // Remove the entire conditional block
        const regex = new RegExp(`\\{\\{#${key}\\}\\}[\\s\\S]*?\\{\\{/${key}\\}\\}`, 'g');
        processedContent = processedContent.replace(regex, '');
      }
    });

    // Handle inverse conditional blocks {{^variableName}}...{{/variableName}}
    Object.keys(variables).forEach(key => {
      const value = variables[key];
      const hasValue = value && value.toString().trim() !== '';
      
      if (!hasValue) {
        // Remove the conditional markers but keep the content (inverse condition)
        const regex = new RegExp(`\\{\\{\\^${key}\\}\\}([\\s\\S]*?)\\{\\{/${key}\\}\\}`, 'g');
        processedContent = processedContent.replace(regex, '$1');
      } else {
        // Remove the entire conditional block
        const regex = new RegExp(`\\{\\{\\^${key}\\}\\}[\\s\\S]*?\\{\\{/${key}\\}\\}`, 'g');
        processedContent = processedContent.replace(regex, '');
      }
    });

    // Minify the HTML to prevent email clients from adding unwanted <br> tags
    processedContent = this.minifyHtml(processedContent);

    return processedContent;
  }

  /**
   * Get tenant email configuration
   * @param {string} tenantId - Tenant ID
   * @returns {Promise<Object>} Email configuration
   */
  static async getTenantEmailConfig(tenantId) {
    const { getPool, sql } = require('../config/database');
    const pool = await getPool();
    
    try {
      const query = `
        SELECT 
          t.Name as tenantName,
          t.CustomLogoUrl as logoUrl,
          t.AdvancedSettings,
          t.ContactEmail,
          t.SupportEmail
        FROM oe.Tenants t
        WHERE t.TenantId = @tenantId
      `;
      
      const request = pool.request();
      request.input('tenantId', sql.UniqueIdentifier, tenantId);
      const result = await request.query(query);
      
      if (result.recordset.length === 0) {
        throw new Error('Tenant not found');
      }
      
      const tenant = result.recordset[0];
      const advancedSettings = tenant.AdvancedSettings ? JSON.parse(tenant.AdvancedSettings) : {};
      
      return {
        tenantName: tenant.tenantName,
        logoUrl: advancedSettings.branding?.logoUrl || tenant.logoUrl,
        customFromAddress: advancedSettings.email?.customFromAddress || null,
        defaultFromEmail: advancedSettings.email?.defaultFromEmail || process.env.DEFAULT_FROM_EMAIL || 'noreply@allaboard365.com',
        branding: advancedSettings.branding || {}
      };
    } catch (error) {
      console.error('❌ Error getting tenant email config:', error);
      throw error;
    }
  }

  /**
   * Get group information for group-related emails
   * @param {string} groupId - Group ID
   * @returns {Promise<Object>} Group information
   */
  static async getGroupInfo(groupId) {
    const { getPool, sql } = require('../config/database');
    const pool = await getPool();
    
    try {
      const query = `
        SELECT 
          g.Name as groupName,
          g.LogoUrl as groupLogoUrl,
          g.ContactEmail as groupContactEmail
        FROM oe.Groups g
        WHERE g.GroupId = @groupId
      `;
      
      const request = pool.request();
      request.input('groupId', sql.UniqueIdentifier, groupId);
      const result = await request.query(query);
      
      if (result.recordset.length === 0) {
        return null;
      }
      
      return result.recordset[0];
    } catch (error) {
      console.error('❌ Error getting group info:', error);
      return null;
    }
  }

  /**
   * Generate enrollment invitation email
   * @param {Object} params - Email parameters
   * @returns {Promise<string>} Processed HTML email
   */
  static async generateEnrollmentInvitation(params) {
    const {
      tenantId,
      memberId,
      memberFirstName,
      memberEmail,
      enrollmentUrl,
      groupId = null,
      expiresAt = null,
      expirationHours = 72
    } = params;

    try {
      // Get tenant configuration
      const tenantConfig = await this.getTenantEmailConfig(tenantId);
      
      // Get group info if applicable
      let groupInfo = null;
      if (groupId) {
        groupInfo = await this.getGroupInfo(groupId);
      }

      // Calculate expiration message
      let expirationMessage = '';
      if (expiresAt) {
        const expiryDate = new Date(expiresAt);
        const now = new Date();
        const hoursRemaining = Math.ceil((expiryDate - now) / (1000 * 60 * 60));
        const daysRemaining = Math.ceil(hoursRemaining / 24);
        
        if (hoursRemaining > 72) {
          // Extended expiration during enrollment period
          expirationMessage = `This enrollment link is valid until ${expiryDate.toLocaleDateString('en-US', { 
            month: 'long', 
            day: 'numeric', 
            year: 'numeric' 
          })}.`;
        } else {
          // Standard 72-hour expiration
          expirationMessage = `This enrollment link expires in ${hoursRemaining} hours (${daysRemaining} days) for security purposes.`;
        }
      }

      // Load template
      const templateContent = this.loadTemplate('enrollment-invitation');
      
      // Prepare variables
      const variables = {
        tenantName: tenantConfig.tenantName,
        logoUrl: tenantConfig.logoUrl,
        memberFirstName: memberFirstName,
        enrollmentUrl: enrollmentUrl,
        groupName: groupInfo?.groupName || null,
        expirationMessage: expirationMessage
      };

      // Process template
      return this.processTemplate(templateContent, variables);
    } catch (error) {
      console.error('❌ Error generating enrollment invitation:', error);
      throw error;
    }
  }

  /**
   * Generate onboarding invitation email
   * @param {Object} params - Email parameters
   * @returns {Promise<string>} Processed HTML email
   */
  static async generateOnboardingInvitation(params) {
    const {
      tenantId,
      contactFirstName,
      contactEmail,
      onboardingUrl,
      groupId,
      groupName
    } = params;

    try {
      // Get tenant configuration
      const tenantConfig = await this.getTenantEmailConfig(tenantId);
      
      // Get group info
      const groupInfo = await this.getGroupInfo(groupId);

      // Load template
      const templateContent = this.loadTemplate('onboarding-invitation');
      
      // Prepare variables
      const variables = {
        tenantName: tenantConfig.tenantName,
        logoUrl: tenantConfig.logoUrl,
        contactFirstName: contactFirstName,
        onboardingUrl: onboardingUrl,
        groupName: groupInfo?.groupName || groupName
      };

      // Process template
      return this.processTemplate(templateContent, variables);
    } catch (error) {
      console.error('❌ Error generating onboarding invitation:', error);
      throw error;
    }
  }

  /**
   * Generate user welcome email
   * @param {Object} params - Email parameters
   * @returns {Promise<string>} Processed HTML email
   */
  static async generateUserWelcome(params) {
    const {
      tenantId,
      firstName,
      userEmail,
      userType,
      setupUrl,
      /** When set (e.g. vendor portal users), shown instead of the linked tenant’s name in copy/subject. */
      organizationName
    } = params;

    try {
      // Get tenant configuration (branding / queue context may still use this tenant)
      const tenantConfig = await this.getTenantEmailConfig(tenantId);
      const orgLabel =
        organizationName != null && String(organizationName).trim() !== ''
          ? String(organizationName).trim()
          : tenantConfig.tenantName;

      // Load template
      const templateContent = this.loadTemplate('user-welcome');
      
      // Prepare variables (template uses {{tenantName}} for the org name in body/header)
      const variables = {
        tenantName: orgLabel,
        logoUrl: tenantConfig.logoUrl,
        firstName: firstName,
        userType: userType,
        setupUrl: setupUrl
      };

      // Process template
      return this.processTemplate(templateContent, variables);
    } catch (error) {
      console.error('❌ Error generating user welcome:', error);
      throw error;
    }
  }

  /**
   * Generate agent verification email
   * @param {Object} params - Email parameters
   * @returns {Promise<string>} Processed HTML email
   */
  static async generateAgentVerification(params) {
    const {
      tenantId,
      firstName,
      verificationUrl,
      verificationLinkExpiryText = '3 days'
    } = params;

    try {
      // Get tenant configuration
      const tenantConfig = await this.getTenantEmailConfig(tenantId);

      // Load template
      const templateContent = this.loadTemplate('agent-verification');
      
      // Prepare variables
      const variables = {
        tenantName: tenantConfig.tenantName,
        logoUrl: tenantConfig.logoUrl,
        firstName: firstName,
        verificationUrl: verificationUrl,
        verificationLinkExpiryText: verificationLinkExpiryText
      };

      // Process template
      return this.processTemplate(templateContent, variables);
    } catch (error) {
      console.error('❌ Error generating agent verification:', error);
      throw error;
    }
  }

  /**
   * Generate tenant admin invitation email
   * @param {Object} params - Email parameters
   * @returns {Promise<string>} Processed HTML email
   */
  static async generateTenantAdminInvitation(params) {
    const {
      firstName,
      tenantName,
      invitationUrl,
      sysAdminName
    } = params;

    try {
      // Load template
      const templateContent = this.loadTemplate('tenant-admin-invitation');
      
      // Prepare variables (using Open-Enroll branding)
      const variables = {
        firstName: firstName,
        tenantName: tenantName,
        invitationUrl: invitationUrl,
        sysAdminName: sysAdminName
      };

      // Process template
      return this.processTemplate(templateContent, variables);
    } catch (error) {
      console.error('❌ Error generating tenant admin invitation:', error);
      throw error;
    }
  }

  /**
   * Single line for member-facing payment failure emails (always non-empty).
   */
  static buildPaymentFailureSummaryForEmail({
    failureReason,
    achReturnCode,
    achReturnReason,
    chargebackReason
  }) {
    const trim = (v) => {
      if (v == null) return '';
      const s = String(v).trim();
      return s;
    };
    const fr = trim(failureReason);
    if (fr && !/^unknown$/i.test(fr)) return fr;
    const achParts = [trim(achReturnCode), trim(achReturnReason)].filter(Boolean);
    if (achParts.length) return achParts.join(' — ');
    const cb = trim(chargebackReason);
    if (cb) return cb;
    return 'No detailed decline message was returned by the payment processor. If this keeps happening, contact support with the transaction ID shown above.';
  }

  /**
   * DIME/card-on-file declines where the processor could not resolve the saved token (e.g. code 23).
   * Used by member + agent-friendly email summaries.
   */
  static paymentFailureIsStoredTokenUnresolved(params) {
    const technical = EmailTemplatesService.buildPaymentFailureSummaryForEmail(params);
    const fr = params.failureReason == null ? '' : String(params.failureReason).trim();
    const haystack = `${fr} ${technical}`.toLowerCase();
    return (
      /\[23\]/.test(fr) ||
      /lookup on the supplied token/.test(haystack) ||
      /supplied token failed/.test(haystack) ||
      /taas resultcode:\s*400/.test(haystack)
    );
  }

  /**
   * Member-facing decline line — plain language without DIME jargon (vault/token codes).
   */
  static buildPaymentFailureMemberFriendlySummary(params) {
    const technical = EmailTemplatesService.buildPaymentFailureSummaryForEmail(params);
    const gb =
      params.groupBillingContact === true ||
      params.groupBillingContact === 'true' ||
      params.groupBillingContact === 1 ||
      params.groupBillingContact === '1';
    if (EmailTemplatesService.paymentFailureIsStoredTokenUnresolved(params)) {
      if (gb) {
        return (
          'The bank or card on file for your group billing could not be charged because some details on file are missing or outdated with our payment processor. ' +
          'Please sign in with a group administrator account, open Billing (or group billing), and update the default payment method—usually for your primary billing location. ' +
          'Re-entering the same bank account or card is OK; that refreshes how it is stored so we can bill your group successfully.'
        );
      }
      return (
        'Your saved payment method could not be used because some details on file are missing or outdated with our payment processor. ' +
        'Please sign in, update your payment methods, and add your card or bank account again—even if it is the same account, re-adding refreshes how it is stored so we can bill you successfully.'
      );
    }

    return technical;
  }

  /**
   * Agent-facing decline line — same reassurance as member (re-entering the same payment method is OK).
   */
  static buildPaymentFailureAgentFriendlySummary(params) {
    const technical = EmailTemplatesService.buildPaymentFailureSummaryForEmail(params);
    const groupScope = params.agentScope === 'group';
    if (EmailTemplatesService.paymentFailureIsStoredTokenUnresolved(params)) {
      if (groupScope) {
        return (
          'The processor could not validate the saved payment token for group billing (often after a replaced bank account or a sync issue). ' +
          'Ask the group billing contact to sign in and update the default payment method for the primary billing location (re-entering the same ACH or card is fine—that refreshes secure storage). ' +
          'Then retry the payment or wait for the next scheduled billing run.'
        );
      }
      return (
        'The processor could not validate the saved payment token (often after a replaced card or a sync issue). ' +
        'Ask the member or group contact to sign in and **re-add their payment method**—using the **same card or bank account is fine**; that refreshes secure storage so charges can succeed. After they save it, retry the payment or wait for the next scheduled billing run.'
      );
    }

    return technical;
  }

  /**
   * Short note for retry / streak context (member + agent payment failure templates).
   * @param {number|null|undefined} paymentAttemptNumber
   * @param {number|null|undefined} paymentConsecutiveFailureCount
   */
  static buildPaymentFailureRetryNoticeForEmail(paymentAttemptNumber, paymentConsecutiveFailureCount) {
    const n = paymentAttemptNumber != null ? Number(paymentAttemptNumber) : NaN;
    const c = paymentConsecutiveFailureCount != null ? Number(paymentConsecutiveFailureCount) : NaN;
    if (Number.isFinite(n) && n >= 2) {
      const tail =
        Number.isFinite(c) && c >= 1 ? ` (${c} consecutive failure streak before resolution, per our records)` : '';
      return `This notice is for billing retry attempt ${n}${tail}.`;
    }
    if (Number.isFinite(c) && c >= 2) {
      return `Our records show ${c} prior consecutive failures in this payer's current failure streak before this decline.`;
    }
    if (Number.isFinite(c) && c === 1) {
      return 'Our records show at least one prior consecutive failure before this decline.';
    }
    return '';
  }

  /**
   * Subject fragment when attempt ordinal is known and &gt;= 2.
   */
  static paymentFailureSubjectRetryFragment(paymentAttemptNumber) {
    const n = paymentAttemptNumber != null ? Number(paymentAttemptNumber) : NaN;
    return Number.isFinite(n) && n >= 2 ? ` — retry attempt ${n}` : '';
  }

  /**
   * Generate payment failure notification email
   * @param {Object} params - Email parameters
   * @returns {Promise<string>} Processed HTML email
   */
  static async generatePaymentFailureNotification(params) {
    const {
      tenantId,
      memberName,
      groupName = '',
      groupBillingContact = false,
      paymentAmount,
      paymentDate,
      paymentMethod,
      transactionId,
      failureReason,
      achReturnCode,
      achReturnReason,
      chargebackReason,
      paymentAttemptNumber = null,
      paymentConsecutiveFailureCount = null
    } = params;

    try {
      // Load template
      const templateContent = this.loadTemplate('payment-failure');
      
      // Get tenant configuration
      const tenantConfig = await this.getTenantEmailConfig(tenantId);
      
      // Format payment amount
      const formattedAmount = new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD'
      }).format(paymentAmount);
      
      // Format payment date
      const formattedDate = new Date(paymentDate).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });

      const gb =
        groupBillingContact === true ||
        groupBillingContact === 'true' ||
        groupBillingContact === 1 ||
        groupBillingContact === '1';

      const failureSummary = this.buildPaymentFailureMemberFriendlySummary({
        failureReason,
        achReturnCode,
        achReturnReason,
        chargebackReason,
        groupBillingContact: gb
      });

      const retryAttemptNote = EmailTemplatesService.buildPaymentFailureRetryNoticeForEmail(
        paymentAttemptNumber,
        paymentConsecutiveFailureCount
      );

      const gn = typeof groupName === 'string' ? groupName.trim() : '';

      const variables = {
        memberName: memberName,
        groupName: gn || 'your group',
        groupBillingContact: gb ? 'yes' : '',
        tenantName: tenantConfig.tenantName,
        amount: formattedAmount,
        paymentDate: formattedDate,
        paymentMethod: paymentMethod || 'Unknown',
        transactionId: transactionId || 'N/A',
        failureSummary,
        retryAttemptNote,
        supportEmail: tenantConfig.supportEmail || 'improve@allaboard365.com',
        supportPhone: tenantConfig.supportPhone || '1-800-ALLABOARD'
      };

      // Process template
      return this.processTemplate(templateContent, variables);
    } catch (error) {
      console.error('❌ Error generating payment failure notification:', error);
      throw error;
    }
  }

  /**
   * Agent-facing payment failure (member vs group wording).
   * @param {Object} params
   * @param {'member'|'group'} params.agentScope
   */
  static async generatePaymentFailureAgentNotification(params) {
    const {
      tenantId,
      agentName,
      agentScope,
      memberDisplayNameForAgent,
      groupName,
      paymentAmount,
      paymentDate,
      paymentMethod,
      transactionId,
      failureReason,
      achReturnCode,
      achReturnReason,
      chargebackReason,
      paymentAttemptNumber = null,
      paymentConsecutiveFailureCount = null
    } = params;

    try {
      const templateContent = this.loadTemplate('payment-failure-agent');
      const tenantConfig = await this.getTenantEmailConfig(tenantId);

      const formattedAmount = new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD'
      }).format(Number(paymentAmount));

      const formattedDate = new Date(paymentDate).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });

      const failureSummary = this.buildPaymentFailureAgentFriendlySummary({
        failureReason,
        achReturnCode,
        achReturnReason,
        chargebackReason,
        agentScope
      });

      const retryAttemptNote = EmailTemplatesService.buildPaymentFailureRetryNoticeForEmail(
        paymentAttemptNumber,
        paymentConsecutiveFailureCount
      );

      const md = typeof memberDisplayNameForAgent === 'string' ? memberDisplayNameForAgent.trim() : '';
      const gn = typeof groupName === 'string' ? groupName.trim() : '';

      let agentLeadIn = '';
      if (agentScope === 'group') {
        agentLeadIn = gn
          ? `Your group "${gn}" had a billing payment declined or returned at the processor. Please coordinate with the group contact and billing as needed.`
          : `A group billing payment on your account had a decline or return at the processor.`;
      } else if (md && gn) {
        agentLeadIn = `Your member ${md} (${gn}) had a payment decline or return at the processor. Consider reaching out to help them resolve payment details.`;
      } else if (md) {
        agentLeadIn = `Your member ${md} had a payment decline or return at the processor. Consider reaching out to help them resolve payment details.`;
      } else if (gn) {
        agentLeadIn = `A payment related to "${gn}" declined or returned at the processor. Details are below.`;
      } else {
        agentLeadIn =
          `A payment tied to your book of business failed at the processor. Details are below.`;
      }

      const variables = {
        agentName: typeof agentName === 'string' && agentName.trim() ? agentName.trim() : 'there',
        agentLeadIn,
        tenantName: tenantConfig.tenantName,
        amount: formattedAmount,
        paymentDate: formattedDate,
        paymentMethod: paymentMethod || 'Unknown',
        transactionId: transactionId || 'N/A',
        failureSummary,
        retryAttemptNote,
        memberNameForAgent: agentScope === 'group' ? '' : md,
        groupNameForAgent: gn,
        supportEmail: tenantConfig.supportEmail || 'improve@allaboard365.com',
        supportPhone: tenantConfig.supportPhone || '1-800-ALLABOARD'
      };

      return this.processTemplate(templateContent, variables);
    } catch (error) {
      console.error('❌ Error generating payment failure agent notification:', error);
      throw error;
    }
  }

  /**
   * Generate the centralized "you have a new prospect" agent notification.
   * Returns { subject, html } (unlike the older generators that return HTML only),
   * so the caller can queue both directly.
   *
   * @param {Object} params
   * @param {string} params.tenantId
   * @param {string} params.agentName    - agent's first name (or 'there')
   * @param {string} params.prospectName - display name for the prospect
   * @param {string|null} params.prospectEmail
   * @param {string|null} params.prospectPhone
   * @param {string} params.prospectsUrl - deep link to the agent's Prospects tab
   * @param {string|null} params.source  - lead source (e.g. 'MightyWELL Website')
   * @returns {Promise<{ subject: string, html: string }>}
   */
  static async generateNewProspectNotification(params) {
    const {
      tenantId,
      agentName,
      prospectName,
      prospectEmail = null,
      prospectPhone = null,
      prospectsUrl,
      source = null,
    } = params;

    const templateContent = this.loadTemplate('new-prospect-notification');

    let tenantName = 'Your portal';
    try {
      const tenantConfig = await this.getTenantEmailConfig(tenantId);
      tenantName = tenantConfig.tenantName || tenantName;
    } catch (err) {
      // Soft-fail on tenant config; the email is still useful with a generic name.
      console.warn('⚠️ [generateNewProspectNotification] tenant config lookup failed:', err && err.message);
    }

    const safeName = typeof prospectName === 'string' && prospectName.trim() ? prospectName.trim() : 'New prospect';
    const subject = `New prospect: ${safeName}`;

    const variables = {
      agentName: typeof agentName === 'string' && agentName.trim() ? agentName.trim() : 'there',
      prospectName: safeName,
      prospectEmail: prospectEmail || '',
      prospectPhone: prospectPhone || '',
      prospectsUrl: prospectsUrl || '',
      source: source || '',
      tenantName,
    };

    const html = this.processTemplate(templateContent, variables);
    return { subject, html };
  }
}

module.exports = EmailTemplatesService;