const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const {
  downloadBlobImageBufferForPdf,
  generateAuthenticatedUrl,
  isBlobUrl
} = require('../routes/uploads');
const { SHOW_INVOICE_PROCESSING_FEES_LINE_ITEM } = require('../config/invoiceDisplayFlags');

/** Reserved layout box for tenant logo (PDFKit scales image to fit inside). */
const LOGO_TOP = 40;
const TENANT_LOGO_FIT_W = 260;
const TENANT_LOGO_FIT_H = 76;
const ADDR_GAP_AFTER_LOGO = 16;

/**
 * Resolve tenant branding logo for PDF embedding (Azure + SAS fallback, optional /public paths).
 * @param {string|null|undefined} logoUrl
 * @returns {Promise<Buffer|null>}
 */
async function prepareTenantLogoBufferForPdf(logoUrl) {
  if (!logoUrl || typeof logoUrl !== 'string') return null;
  const trimmed = logoUrl.trim();
  if (!trimmed) return null;

  let raw = null;

  if (/^https?:\/\//i.test(trimmed)) {
    raw = await downloadBlobImageBufferForPdf(trimmed);
    if (!raw && isBlobUrl(trimmed)) {
      try {
        const sasUrl = await generateAuthenticatedUrl(trimmed, 90);
        raw = await downloadBlobImageBufferForPdf(sasUrl);
      } catch (_) {
        /* ignore */
      }
    }
  }

  if (!raw && trimmed.startsWith('/')) {
    const rel = trimmed.replace(/^\//, '');
    const candidates = [
      path.join(__dirname, '../../frontend/public', rel),
      path.join(__dirname, '../../../frontend/public', rel)
    ];
    for (const p of candidates) {
      try {
        if (fs.existsSync(p)) {
          raw = fs.readFileSync(p);
          break;
        }
      } catch (_) {
        /* ignore */
      }
    }
  }

  if (!raw || raw.length === 0) return null;

  try {
    return await sharp(raw).rotate().png({ compressionLevel: 6 }).toBuffer();
  } catch {
    try {
      return await sharp(raw).rotate().jpeg({ quality: 85, mozjpeg: true }).toBuffer();
    } catch {
      return raw;
    }
  }
}

/**
 * SHARED INVOICE PDF GENERATION SERVICE
 * 
 * This service ensures consistent PDF formatting across:
 * - Actual invoice downloads (/api/groups/:groupId/invoices/:invoiceId/download)
 * - Sample invoice generation (/api/groups/:groupId/billing/sample-invoice)
 * 
 * Both use the same format:
 * - No "Unit Price" column (removed for clarity)
 * - Processing/show fee line: controlled by SHOW_INVOICE_PROCESSING_FEES_LINE_ITEM (see invoiceDisplayFlags.js)
 * - Consistent column widths and layout
 */

/**
 * Generate invoice PDF from invoice record and location results
 * @param {Object} options - PDF generation options
 * @param {Object} options.invoice - Invoice record from database
 * @param {Array} options.locationResults - Array of {location, fees} objects for line items
 * @param {Object} [options.group] - Group information (Bill To); omit if billTo is set
 * @param {Object} [options.billTo] - Household / individual Bill To: { name, addressLine1, cityStateZip }
 * @param {Object} options.tenant - Tenant information
 * @param {Date} options.billingDate - Billing date
 * @param {Date} options.dueDate - Due date
 * @param {Date} options.billingPeriodStart - Billing period start
 * @param {Date} options.billingPeriodEnd - Billing period end
 * @param {string} options.title - Invoice title (e.g., "INVOICE" or "SAMPLE INVOICE")
 * @param {string} options.invoiceNumber - Invoice number
 * @param {boolean} options.isSample - Whether this is a sample invoice
 * @param {Array} [options.simpleLineItems] - Individual invoice rows: [{ description, quantity, amount }]
 * @param {Buffer|null} [options.tenantLogoBuffer] - Tenant logo image buffer for header (prefer over large name text)
 * @param {'invoice'|'payment_receipt'} [options.documentKind]
 * @param {object} [options.paymentReceipt] - When documentKind is payment_receipt: paymentAmount, paymentDate,
 *   paymentMethodSummary?, processorTransactionId?, invoiceBalanceDue?, invoicePaidInFull?, minimalStandalone?
 * @returns {PDFDocument} PDF document ready to be piped to response
 */
function generateInvoicePdf({
  invoice,
  locationResults,
  group,
  billTo,
  tenant,
  billingDate,
  dueDate,
  billingPeriodStart,
  billingPeriodEnd,
  title = 'INVOICE',
  invoiceNumber,
  isSample = false,
  simpleLineItems,
  tenantLogoBuffer,
  documentKind = 'invoice',
  paymentReceipt = null
}) {
  const doc = new PDFDocument();
  
  const PAGE_TEXT_FLOOR = 540;

  /** @returns {number} next yPosition */
  function ensureVerticalSpace(currentY, minHeightNeeded) {
    if (currentY + minHeightNeeded > PAGE_TEXT_FLOOR) {
      doc.addPage();
      return 50;
    }
    return currentY;
  }
  
  // Format dates without timezone conversion (parse date parts separately)
  // This prevents off-by-one day errors when dates are in UTC
  // For calendar dates (billing periods, invoice dates), parse date parts separately
  // Following backend-system.md guidance: parse date parts separately to avoid timezone conversion
  const formatDateForPDF = (date) => {
    let year, month, day;
    
    if (date instanceof Date) {
      // If it's already a Date object, extract UTC parts
      year = date.getUTCFullYear();
      month = date.getUTCMonth() + 1; // getUTCMonth() returns 0-11
      day = date.getUTCDate();
    } else if (typeof date === 'string') {
      // Parse date string directly (e.g., "2026-01-01T00:00:00Z" or "2026-01-01")
      // Extract just the date part (YYYY-MM-DD) before any timezone conversion
      const dateOnly = date.split('T')[0]; // Get "YYYY-MM-DD" part
      const [y, m, d] = dateOnly.split('-').map(Number);
      year = y;
      month = m;
      day = d;
    } else {
      // Fallback: try to create Date and use UTC methods
      const dateObj = new Date(date);
      year = dateObj.getUTCFullYear();
      month = dateObj.getUTCMonth() + 1;
      day = dateObj.getUTCDate();
    }
    
    return `${month}/${day}/${year}`;
  };
  
  const hasTenantLogo = !!(tenantLogoBuffer && tenantLogoBuffer.length > 0);

  // Header - Tenant Information (logo when available, else tenant name)
  let tenantAddrStartY = 80;
  if (hasTenantLogo) {
    doc.image(tenantLogoBuffer, 50, LOGO_TOP, {
      fit: [TENANT_LOGO_FIT_W, TENANT_LOGO_FIT_H],
      align: 'left',
      valign: 'center'
    });
    tenantAddrStartY = LOGO_TOP + TENANT_LOGO_FIT_H + ADDR_GAP_AFTER_LOGO;
  } else {
    doc.fontSize(20).text(tenant.Name || tenant.TenantName, 50, 50);
    tenantAddrStartY = 80;
  }
  doc.fontSize(10).text(tenant.PrimaryAddress || tenant.TenantAddress || '', 50, tenantAddrStartY);
  doc.text(`${tenant.PrimaryCity || tenant.TenantCity || ''}, ${tenant.PrimaryState || tenant.TenantState || ''} ${tenant.PrimaryZip || tenant.TenantZip || ''}`, 50, tenantAddrStartY + 15);

  // Header - Invoice Information (same vertical rhythm as legacy layout when no logo)
  const invoiceMetaTopY = hasTenantLogo ? LOGO_TOP : 50;
  const isPaymentReceipt = documentKind === 'payment_receipt' && paymentReceipt;
  const headerTitle = isPaymentReceipt ? 'PAYMENT RECEIPT' : title;
  doc.fontSize(16).text(headerTitle, 400, invoiceMetaTopY);
  doc.fontSize(10);
  if (
    documentKind === 'payment_receipt' &&
    paymentReceipt &&
    paymentReceipt.minimalStandalone
  ) {
    doc.text(`Reference: ${invoiceNumber}`, 400, invoiceMetaTopY + 30);
  } else {
    doc.text(`Invoice #: ${invoiceNumber}`, 400, invoiceMetaTopY + 30);
  }
  doc.text(`Invoice Date: ${formatDateForPDF(billingDate)}`, 400, invoiceMetaTopY + 45);
  const dueDateLabel = invoice?.InvoiceType === 'Group' ? 'Payment Date' : 'Due Date';
  if (isPaymentReceipt) {
    doc.text(`Payment Date: ${formatDateForPDF(paymentReceipt.paymentDate)}`, 400, invoiceMetaTopY + 60);
  } else {
    doc.text(`${dueDateLabel}: ${formatDateForPDF(dueDate)}`, 400, invoiceMetaTopY + 60);
  }
  const invoiceMetaBottom = invoiceMetaTopY + 72;

  const addrBottomY = tenantAddrStartY + 15 + 18;
  const billToY = Math.max(150, addrBottomY + 18, invoiceMetaBottom + 14);

  // Bill To — group billing or individual/household (billTo)
  const billName = billTo?.name || group?.Name || group?.GroupName || '';
  const billLine1 = billTo?.addressLine1 || group?.Address || group?.PrimaryAddress || '';
  const billLine2 = billTo?.cityStateZip
    || `${group?.City || group?.PrimaryCity || ''}, ${group?.State || group?.PrimaryState || ''} ${group?.Zip || group?.PrimaryZip || ''}`.trim();
  doc.fontSize(12).text('Bill To:', 50, billToY);
  doc.fontSize(10).text(billName, 50, billToY + 20);
  doc.text(billLine1, 50, billToY + 35);
  doc.text(billLine2, 50, billToY + 50);

  const billingPeriodY = billToY + 90;
  doc.text(`Billing Period: ${formatDateForPDF(billingPeriodStart)} - ${formatDateForPDF(billingPeriodEnd)}`, 50, billingPeriodY);

  const lineItemsHeaderY = billingPeriodY + 40;
  doc.fontSize(10);
  doc.text('Description', 50, lineItemsHeaderY);
  doc.text('Qty', 350, lineItemsHeaderY);
  doc.text('Total', 450, lineItemsHeaderY);

  const lineStrokeY = lineItemsHeaderY + 15;
  doc.moveTo(50, lineStrokeY).lineTo(550, lineStrokeY).stroke();

  // Line Items - Build from location results
  let yPosition = lineStrokeY + 15;
  let subtotal = 0;

  if (simpleLineItems && simpleLineItems.length > 0) {
    simpleLineItems.forEach((item) => {
      const qty = item.quantity != null ? item.quantity : 1;
      const amount = parseFloat(item.amount) || 0;
      doc.fontSize(10).font('Helvetica');
      const descHeight = doc.heightOfString(String(item.description || ''), { width: 280 });
      yPosition = ensureVerticalSpace(yPosition, Math.max(descHeight, 14) + 24);
      doc.text(String(item.description || ''), 50, yPosition, { width: 280 });
      doc.text(String(qty), 350, yPosition);
      doc.text(`$${amount.toFixed(2)}`, 450, yPosition);
      yPosition += Math.max(descHeight, 14) + 8;
      subtotal += amount;
    });
  } else if (locationResults && locationResults.length > 0) {
    locationResults.forEach((locResult, index) => {
      const location = locResult.location;
      const fees = locResult.fees;
      
      // Location header (if multiple locations)
      if (locationResults.length > 1) {
        yPosition = ensureVerticalSpace(yPosition, 24);
        doc.fontSize(11).font('Helvetica-Bold').text(location.LocationName || 'Unnamed Location', 50, yPosition);
        if (location.LocationIsPrimary) {
          doc.fontSize(9).font('Helvetica').text('(Primary Location)', 200, yPosition);
        }
        yPosition += 20;
      }
      
      // Monthly Premium (+ processing when not shown as a separate line — see invoiceDisplayFlags.js)
      const totalProcessingFees = (fees.systemFeesAmount || 0) + (fees.paymentProcessingFee || 0);
      const premiumDisplayAmount =
        parseFloat(location.BasePremium) +
        (!SHOW_INVOICE_PROCESSING_FEES_LINE_ITEM && totalProcessingFees > 0 ? totalProcessingFees : 0);
      yPosition = ensureVerticalSpace(yPosition, 22);
      doc.fontSize(10).font('Helvetica').text('Monthly Premium', 50, yPosition);
      doc.text(`${location.HouseholdCount} household${location.HouseholdCount !== 1 ? 's' : ''}`, 350, yPosition);
      doc.text(`$${premiumDisplayAmount.toFixed(2)}`, 450, yPosition);
      subtotal += premiumDisplayAmount;
      yPosition += 20;

      // Processing Fees (combined System Fees + Payment Processing Fee)
      if (SHOW_INVOICE_PROCESSING_FEES_LINE_ITEM && totalProcessingFees > 0) {
        yPosition = ensureVerticalSpace(yPosition, 22);
        doc.text('Processing Fees', 50, yPosition);
        doc.text('1', 350, yPosition);
        doc.text(`$${parseFloat(totalProcessingFees).toFixed(2)}`, 450, yPosition);
        subtotal += totalProcessingFees;
        yPosition += 20;
      }
      
      // Setup Fees
      if (fees.setupFeesAmount > 0) {
        yPosition = ensureVerticalSpace(yPosition, 22);
        const setupFeeLabel = (location.NewEnrollmentsWithSetupFees || 0) > 0
          ? `Setup Fees (One-time) - ${location.NewEnrollmentsWithSetupFees || 0} new enrollment${(location.NewEnrollmentsWithSetupFees || 0) !== 1 ? 's' : ''}`
          : 'Setup Fees (One-time)';
        doc.text(setupFeeLabel, 50, yPosition);
        doc.text('1', 350, yPosition);
        doc.text(`$${parseFloat(fees.setupFeesAmount).toFixed(2)}`, 450, yPosition);
        subtotal += fees.setupFeesAmount;
        yPosition += 20;
      }
      
      // Add spacing between locations
      if (index < locationResults.length - 1) {
        yPosition += 10;
      }
    });
  } else if (invoice && (parseFloat(invoice.SubTotal) > 0 || parseFloat(invoice.TotalAmount) > 0)) {
    // Fallback: invoice totals only (individual invoices or missing line rebuild)
    const lineAmt = parseFloat(invoice.SubTotal) > 0
      ? parseFloat(invoice.SubTotal)
      : parseFloat(invoice.TotalAmount || 0);
    yPosition = ensureVerticalSpace(yPosition, 22);
    doc.fontSize(10).font('Helvetica').text('Monthly Premium', 50, yPosition);
    doc.text('1', 350, yPosition);
    doc.text(`$${lineAmt.toFixed(2)}`, 450, yPosition);
    subtotal = lineAmt;
    yPosition += 20;
  } else if ((!locationResults || locationResults.length === 0) && (!invoice || (!invoice.SubTotal && !invoice.TotalAmount))) {
    // If no line items at all, show a message
    yPosition = ensureVerticalSpace(yPosition, 22);
    doc.fontSize(10).font('Helvetica').text('No line items for this billing period.', 50, yPosition);
    yPosition += 20;
  }
  
  // Totals
  yPosition = ensureVerticalSpace(yPosition, 72);
  yPosition += 20;
  doc.moveTo(350, yPosition).lineTo(550, yPosition).stroke();
  yPosition += 15;
  
  doc.fontSize(10).font('Helvetica');
  doc.text('Subtotal:', 350, yPosition);
  doc.text(`$${parseFloat(subtotal).toFixed(2)}`, 450, yPosition);
  yPosition += 20;
  
  // Tax (if applicable)
  const taxAmount = invoice?.TaxAmount || 0;
  if (taxAmount > 0) {
    doc.text('Tax:', 350, yPosition);
    doc.text(`$${parseFloat(taxAmount).toFixed(2)}`, 450, yPosition);
    yPosition += 20;
  }
  
  const totalAmount =
    invoice?.TotalAmount != null && invoice.TotalAmount !== ''
      ? parseFloat(invoice.TotalAmount)
      : parseFloat(subtotal) + parseFloat(taxAmount);

  if (isPaymentReceipt) {
    const pr = paymentReceipt;
    doc.fontSize(12).font('Helvetica');
    if (pr.minimalStandalone) {
      doc.text('Amount Paid:', 350, yPosition);
      doc.text(`$${parseFloat(pr.paymentAmount).toFixed(2)}`, 450, yPosition);
      yPosition += 28;
    } else {
      doc.text('Invoice Total:', 350, yPosition);
      doc.text(`$${parseFloat(totalAmount).toFixed(2)}`, 450, yPosition);
      yPosition += 20;
      doc.text('Amount Paid (this payment):', 350, yPosition);
      doc.text(`$${parseFloat(pr.paymentAmount).toFixed(2)}`, 450, yPosition);
      yPosition += 24;
      doc.fontSize(11).font('Helvetica-Bold');
      const balanceDue =
        pr.invoiceBalanceDue != null && pr.invoiceBalanceDue !== ''
          ? parseFloat(pr.invoiceBalanceDue)
          : null;
      const paidFull =
        pr.invoicePaidInFull === true ||
        (balanceDue !== null && !Number.isNaN(balanceDue) && Math.abs(balanceDue) < 0.005);
      if (paidFull) {
        doc.text('Paid in full — Balance $0.00', 350, yPosition);
      } else if (balanceDue !== null && !Number.isNaN(balanceDue)) {
        doc.text('Remaining Balance:', 350, yPosition);
        doc.text(`$${balanceDue.toFixed(2)}`, 450, yPosition);
      }
      yPosition += 28;
    }
    doc.fontSize(10).font('Helvetica');
    if (pr.paymentMethodSummary) {
      yPosition = ensureVerticalSpace(yPosition, 22);
      doc.text(`Payment Method: ${pr.paymentMethodSummary}`, 50, yPosition);
      yPosition += 16;
    }
    if (pr.processorTransactionId) {
      yPosition = ensureVerticalSpace(yPosition, 22);
      doc.text(`Transaction ID: ${pr.processorTransactionId}`, 50, yPosition);
      yPosition += 16;
    }
  } else {
    doc.fontSize(12).font('Helvetica');
    doc.text('Total Due:', 350, yPosition);
    doc.text(`$${parseFloat(totalAmount).toFixed(2)}`, 450, yPosition);
    yPosition += 28;

    doc.fontSize(10).font('Helvetica');
    const paymentTerms = invoice?.PaymentTerms || 30;
    yPosition = ensureVerticalSpace(yPosition, 36);
    doc.text(`Payment Terms: Net ${paymentTerms} days`, 50, yPosition);
  }
  
  // Sample Invoice Disclaimer
  if (isSample) {
    yPosition += 18;
    yPosition = ensureVerticalSpace(yPosition, 24);
    doc.text('Note: This is a SAMPLE INVOICE for preview purposes only.', 50, yPosition);
  }
  
  return doc;
}

module.exports = {
  generateInvoicePdf,
  prepareTenantLogoBufferForPdf
};

