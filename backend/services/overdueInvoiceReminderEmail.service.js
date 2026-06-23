'use strict';

/**
 * Overdue invoice reminder — composition + queue handoff.
 *
 * Builds the email HTML (member or group template) and SMS body for a single
 * reminder send and forwards to MessageQueueService. The selection service
 * (overdueInvoiceReminder.service.js) decides who gets reminded and at what
 * attempt; this file decides what they see.
 */

const sql = require('mssql');
const { getPool } = require('../config/database');
const EmailTemplatesService = require('./emailTemplates.service');
const MessageQueueService = require('./messageQueue.service');
const { buildTenantAppBaseUrl } = require('../utils/tenantAppUrl');
const { nextAllowedSendTime } = require('../utils/nextAllowedSendTime');

function formatCurrency(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '$0.00';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v);
}

function formatDate(d) {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatBillingPeriod(start, end) {
  const s = start ? formatDate(start) : '';
  const e = end ? formatDate(end) : '';
  if (s && e && s !== e) return `${s} – ${e}`;
  return s || e || '';
}

function buildPayInvoiceUrl(invoice, tenantContact) {
  const base = buildTenantAppBaseUrl(tenantContact || {});
  if (invoice.GroupId) {
    return `${base}/group/${invoice.GroupId}/billing?invoice=${invoice.InvoiceId}`;
  }
  return `${base}/member/payments?invoice=${invoice.InvoiceId}`;
}

/**
 * Pull tenant-level contact info beyond what getTenantEmailConfig returns.
 * One small query, cached per call (callers can memoize across invoices in a run).
 */
async function getTenantContact(tenantId) {
  const pool = await getPool();
  const result = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .query(`
      SELECT TOP 1 Name, ContactEmail, ContactPhone, SupportEmail,
             CustomDomain, DefaultUrlPath, IsDefaultUrlPathVerified, AdvancedSettings
      FROM oe.Tenants
      WHERE TenantId = @tenantId
    `);
  return result.recordset[0] || null;
}

/**
 * Build the merge-field dictionary shared by member + group templates.
 */
function buildSharedVariables({ invoice, tenantContact, attemptNumber, maxCount, daysOverdue }) {
  const isFinal = attemptNumber === maxCount;
  const isFirm = !isFinal && attemptNumber > 1;
  const paidSoFar = Number(invoice.PaidAmount) || 0;
  const invoiceTotal = Number(invoice.TotalAmount) || 0;
  const hasPartialPayment = paidSoFar > 0.005;
  const billingPeriod = formatBillingPeriod(invoice.BillingPeriodStart, invoice.BillingPeriodEnd);
  return {
    tenantName: tenantContact?.Name || 'Your benefits administrator',
    tenantContactEmail: tenantContact?.SupportEmail || tenantContact?.ContactEmail || '',
    tenantContactPhone: tenantContact?.ContactPhone || '',
    invoiceNumber: invoice.InvoiceNumber,
    invoiceTotal: formatCurrency(invoiceTotal),
    amountDue: formatCurrency(invoice.BalanceDue),
    dueDate: formatDate(invoice.DueDate),
    billingPeriod,
    daysOverdue: String(daysOverdue),
    attemptNumber: String(attemptNumber),
    maxCount: String(maxCount),
    payInvoiceUrl: buildPayInvoiceUrl(invoice, tenantContact),
    isFinal,
    isFirm,
    hasPartialPayment: hasPartialPayment ? true : '',
    amountPaidSoFar: hasPartialPayment ? formatCurrency(paidSoFar) : ''
  };
}

function buildSubject({ invoice, attemptNumber, maxCount, daysOverdue, tenantContact }) {
  const isFinal = attemptNumber === maxCount;
  const isFirm = !isFinal && attemptNumber > 1;
  const tenantName = tenantContact?.Name || '';
  const prefix = tenantName ? `${tenantName}: ` : '';
  if (isFinal) {
    return `${prefix}Final notice — invoice #${invoice.InvoiceNumber} is ${daysOverdue} days past due`;
  }
  if (isFirm) {
    return `${prefix}Your invoice #${invoice.InvoiceNumber} still needs attention`;
  }
  return `${prefix}Reminder: invoice #${invoice.InvoiceNumber} is past due`;
}

/**
 * Compose + queue the reminder email for one invoice + recipient.
 *
 * @param {object} args
 * @param {string} args.tenantId
 * @param {object} args.invoice                        - row from selection service
 * @param {string} args.recipientEmail                 - to-address
 * @param {string} args.recipientName                  - greeting name (first name for members; contact name for groups)
 * @param {string} args.recipientType                  - 'MemberPrimary' | 'GroupBilling'
 * @param {number} args.attemptNumber
 * @param {number} args.maxCount
 * @param {number} args.daysOverdue
 * @param {string|null} [args.replyToEmail]
 * @param {object|null} [args.tenantContactCache]      - if provided, reused; else fetched
 * @param {string|null} [args.recipientUserId]          - primary member oe.Users.UserId (MessageHistory + Communications tab)
 * @returns {Promise<{ messageId: string }>}
 */
async function composeAndQueueEmail(args) {
  const {
    tenantId,
    invoice,
    recipientEmail,
    recipientName,
    recipientType,
    attemptNumber,
    maxCount,
    daysOverdue,
    replyToEmail = null,
    tenantContactCache = null,
    recipientUserId = null
  } = args;

  if (!recipientEmail) throw new Error('composeAndQueueEmail: recipientEmail required');

  const tenantContact = tenantContactCache || await getTenantContact(tenantId);
  const tenantConfig = await EmailTemplatesService.getTenantEmailConfig(tenantId);

  const isGroup = recipientType === 'GroupBilling';
  const hasPaymentMethodOnFile =
    isGroup ||
    invoice.HasActivePaymentMethodOnFile === 1 ||
    invoice.HasActivePaymentMethodOnFile === true;
  const templateName = isGroup ? 'overdue-invoice-reminder-group' : 'overdue-invoice-reminder-member';
  const templateContent = EmailTemplatesService.loadTemplate(templateName);

  const variables = {
    ...buildSharedVariables({ invoice, tenantContact, attemptNumber, maxCount, daysOverdue }),
    firstName: !isGroup ? (recipientName || 'there') : '',
    recipientName: isGroup ? (recipientName || 'there') : '',
    groupName: isGroup ? (invoice.GroupName || '') : '',
    // Mustache conditional: show when member has no active card/bank on file
    noPaymentMethodOnFile: !isGroup && !hasPaymentMethodOnFile ? true : ''
  };

  const html = EmailTemplatesService.processTemplate(templateContent, variables);
  const subject = buildSubject({ invoice, attemptNumber, maxCount, daysOverdue, tenantContact });

  const historyRecipientId =
    recipientType === 'MemberPrimary' && recipientUserId ? recipientUserId : null;

  const messageId = await MessageQueueService.queueEmail({
    tenantId,
    toEmail: recipientEmail,
    toName: recipientName || null,
    subject,
    htmlContent: html,
    textContent: null,
    messageType: 'Email',
    createdBy: null,
    recipientId: historyRecipientId,
    replyToEmail: replyToEmail || tenantContact?.ContactEmail || null,
    fromEmail: tenantConfig?.customFromAddress || tenantConfig?.defaultFromEmail || null,
    fromName: tenantContact?.Name || null,
    tryImmediateSend: false,
    scheduledSendDate: nextAllowedSendTime()
  });

  return { messageId };
}

/**
 * Compose + queue the reminder SMS. Body kept under ~160 chars where possible.
 *
 * @param {object} args
 * @param {string} args.tenantId
 * @param {object} args.invoice
 * @param {string} args.recipientPhone                 - E.164 or US 10-digit (queueMessage normalizes)
 * @param {string} args.recipientType                  - 'MemberPrimary' (groups deferred in v1)
 * @param {number} args.attemptNumber
 * @param {number} args.maxCount
 * @param {number} args.daysOverdue
 * @param {object|null} [args.tenantContactCache]
 * @param {string|null} [args.recipientUserId]
 * @returns {Promise<{ messageId: string }>}
 */
async function composeAndQueueSms(args) {
  const {
    tenantId,
    invoice,
    recipientPhone,
    recipientType,
    attemptNumber,
    maxCount,
    daysOverdue,
    tenantContactCache = null,
    recipientUserId = null
  } = args;

  if (!recipientPhone) throw new Error('composeAndQueueSms: recipientPhone required');

  const tenantContact = tenantContactCache || await getTenantContact(tenantId);
  const tenantName = (tenantContact?.Name || 'Benefits').slice(0, 40);
  const isFinal = attemptNumber === maxCount;
  const url = buildPayInvoiceUrl(invoice, tenantContact);
  const amount = formatCurrency(invoice.BalanceDue);
  const invoiceTotal = formatCurrency(invoice.TotalAmount);
  const hasPaymentMethodOnFile =
    recipientType === 'GroupBilling' ||
    invoice.HasActivePaymentMethodOnFile === 1 ||
    invoice.HasActivePaymentMethodOnFile === true;

  const lead = isFinal ? 'Final notice' : 'Reminder';
  const billingPeriod = formatBillingPeriod(invoice.BillingPeriodStart, invoice.BillingPeriodEnd);
  const periodBit = billingPeriod ? ` for ${billingPeriod}` : '';
  const dueBit = invoice.DueDate ? ` (due ${formatDate(invoice.DueDate)})` : '';
  let body = `${tenantName}: ${lead} — Invoice #${invoice.InvoiceNumber}${periodBit} total ${invoiceTotal}, balance ${amount}${dueBit} is ${daysOverdue} days past due. Pay: ${url}.`;
  const paidSoFar = Number(invoice.PaidAmount) || 0;
  if (paidSoFar > 0.005) {
    body += ` Paid ${formatCurrency(paidSoFar)} so far.`;
  }
  if (recipientType === 'MemberPrimary' && !hasPaymentMethodOnFile) {
    body += ' No payment method on file—add one in the portal to pay.';
  }
  body += ' Reply STOP to opt out.';

  const historyRecipientId =
    recipientType === 'MemberPrimary' && recipientUserId ? recipientUserId : null;

  const messageId = await MessageQueueService.queueMessage({
    tenantId,
    messageType: 'SMS',
    recipientAddress: recipientPhone,
    subject: null,
    messageBody: body,
    createdBy: null,
    recipientId: historyRecipientId,
    tryImmediateSend: false,
    scheduledSendDate: nextAllowedSendTime()
  });

  return { messageId };
}

module.exports = {
  composeAndQueueEmail,
  composeAndQueueSms,
  getTenantContact,
  buildPayInvoiceUrl
};
