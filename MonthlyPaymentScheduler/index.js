const { getPool, sql } = require('../shared/db');
const DimeService = require('../shared/dimeService');
const { createLogger } = require('../shared/logger');
const fs = require('fs');
const path = require('path');

/**
 * Monthly Payment Scheduler
 * Runs on the 1st of each month at 6 AM
 * 
 * Multi-Location Billing Support:
 * - Calculates premiums by location (based on primary member's LocationId)
 * - Generates invoice records in oe.Invoices for each location
 * - Creates DIME schedules (one per location with payment method)
 * - Sends location-specific emails
 * - Sends consolidated email to group + primary location contacts
 * 
 * See docs/group-payments/MULTI_LOCATION_BILLING.md for full documentation
 */

/**
 * Calculate premiums by location for a group
 * Primary member's LocationId determines which location pays for their household
 * Uses UseLocationACH to determine if location pays separately or charges to primary
 * Includes unpaid setup fees for enrollments with effective date <= billing date
 * 
 * NOTE: Now uses shared invoiceCalculationService to ensure consistency with estimated invoice calculations
 * This also fixes the double-counting bug that existed in the original query
 */
async function calculateLocationPremiums(pool, groupId, billingDate, logger) {
  const { calculateLocationPremiums: sharedCalculateLocationPremiums } = require('../shared/invoiceCalculationService');
  // Pass sql module to ensure we use the same mssql instance as the pool
  const locationPremiums = await sharedCalculateLocationPremiums(pool, groupId, billingDate, sql);
  logger.info(`  Found ${locationPremiums.length} location(s) with enrollments`);
  return locationPremiums;
}

/**
 * Get payment method for a location
 * Uses UseLocationACH to determine if location pays separately
 */
async function getLocationPaymentMethod(pool, groupId, locationId, useLocationACH, isPrimaryLocation, logger) {
  // If location opted to pay for its own members (UseLocationACH = true)
  if (useLocationACH) {
    const paymentMethodQuery = `
      SELECT TOP 1
        gpm.PaymentMethodId,
        gpm.Type,
        gpm.CardLast4,
        gpm.CardBrand,
        gpm.AccountNumberLast4,
        gpm.AccountType,
        gpm.ProcessorPaymentMethodId
      FROM oe.GroupPaymentMethods gpm
      INNER JOIN oe.GroupLocations gl ON gpm.LocationId = gl.LocationId
      WHERE gpm.GroupId = @groupId 
        AND gpm.LocationId = @locationId
        AND gpm.IsDefault = 1 
        AND gpm.Status = 'Active'
        AND gl.UseLocationACH = 1
    `;
    
    const paymentMethodResult = await pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .input('locationId', sql.UniqueIdentifier, locationId)
      .query(paymentMethodQuery);
    
    if (paymentMethodResult.recordset.length > 0) {
      logger.info(`    Using location's own payment method`);
      return {
        ...paymentMethodResult.recordset[0],
        isOwnPaymentMethod: true,
        locationId: locationId
      };
    } else {
      // Location opted in but has no payment method - this is an error!
      logger.error(`    Location has UseLocationACH=true but no payment method!`);
      return null;
    }
  }
  
  // Location did NOT opt to pay separately (UseLocationACH = false)
  // Always use primary location's payment method
  logger.info(`    Location uses primary location's payment method (UseLocationACH=false)`);
  
  const primaryLocationQuery = `
    SELECT TOP 1 gl.LocationId
    FROM oe.GroupLocations gl
    WHERE gl.GroupId = @groupId AND gl.IsPrimary = 1
  `;
  
  const primaryLocationResult = await pool.request()
    .input('groupId', sql.UniqueIdentifier, groupId)
    .query(primaryLocationQuery);
  
  if (primaryLocationResult.recordset.length > 0) {
    const primaryLocationId = primaryLocationResult.recordset[0].LocationId;
    
    // Get primary location's payment method
    const primaryPaymentMethodQuery = `
      SELECT TOP 1
        gpm.PaymentMethodId,
        gpm.Type,
        gpm.CardLast4,
        gpm.CardBrand,
        gpm.AccountNumberLast4,
        gpm.AccountType,
        gpm.ProcessorPaymentMethodId
      FROM oe.GroupPaymentMethods gpm
      WHERE gpm.GroupId = @groupId 
        AND gpm.LocationId = @locationId
        AND gpm.IsDefault = 1 
        AND gpm.Status = 'Active'
    `;
    
    const primaryPaymentMethodResult = await pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .input('locationId', sql.UniqueIdentifier, primaryLocationId)
      .query(primaryPaymentMethodQuery);
    
    if (primaryPaymentMethodResult.recordset.length > 0) {
      return {
        ...primaryPaymentMethodResult.recordset[0],
        isOwnPaymentMethod: false,
        locationId: primaryLocationId,
        chargedToLocationId: primaryLocationId
      };
    }
  }
  
  logger.error(`    No payment method found (even primary location)`);
  return null;
}

// NOTE: calculateLocationFees function removed - we now rely ONLY on oe.Enrollments for fees
// All fees (SystemFee, PaymentProcessingFee) must be stored in oe.Enrollments
// If fees are missing from oe.Enrollments, they will be 0 and a warning will be logged

/**
 * Generate invoice record for a location
 */
async function generateInvoice(pool, group, location, fees, billingDate, invoiceNumber, logger, additionalCharges = [], transaction = null) {
  const invoiceId = require('crypto').randomUUID();
  
  // Calculate due date (5th of current month - payment date)
  // Invoice is generated on 1st, payment is charged on 5th of same month
  const dueDate = new Date(billingDate);
  dueDate.setDate(5); // Payment date is 5th of the same month
  
  // Billing period (current month)
  const billingPeriodStart = new Date(billingDate.getFullYear(), billingDate.getMonth(), 1);
  const billingPeriodEnd = new Date(billingDate.getFullYear(), billingDate.getMonth() + 1, 0);
  
  // Get setup fees and new enrollment count from location
  const setupFeesAmount = fees.setupFeesAmount || 0;
  const newEnrollmentsCount = location.NewEnrollmentsWithSetupFees || 0;
  
  // If this is the primary location, add non-billing location charges
  let totalSubTotal = location.BasePremium;
  let totalAmount = fees.totalAmount;
  let totalSetupFees = setupFeesAmount;
  let totalNewEnrollments = newEnrollmentsCount;
  
  if (location.LocationIsPrimary && additionalCharges.length > 0) {
    logger.info(`    Primary location - adding ${additionalCharges.length} non-billing location(s):`);
    additionalCharges.forEach(charge => {
      totalSubTotal += charge.fees.basePremium;
      totalAmount += charge.fees.totalAmount;
      totalSetupFees += (charge.fees.setupFeesAmount || 0);
      totalNewEnrollments += (charge.location.NewEnrollmentsWithSetupFees || 0);
      logger.info(`      ${charge.location.LocationName}: +$${charge.fees.totalAmount.toFixed(2)}`);
    });
    logger.info(`    Primary location total: $${totalAmount.toFixed(2)}`);
  }
  
  // Use transaction if provided, otherwise use pool.request()
  const request = transaction ? transaction.request() : pool.request();
  
  await request
    .input('invoiceId', sql.UniqueIdentifier, invoiceId)
    .input('groupId', sql.UniqueIdentifier, group.GroupId)
    .input('locationId', sql.UniqueIdentifier, location.LocationId)
    .input('invoiceNumber', sql.NVarChar, invoiceNumber)
    .input('invoiceDate', sql.Date, billingDate)
    .input('dueDate', sql.Date, dueDate)
    .input('billingPeriodStart', sql.Date, billingPeriodStart)
    .input('billingPeriodEnd', sql.Date, billingPeriodEnd)
    .input('subTotal', sql.Decimal(12,2), totalSubTotal)
    .input('taxAmount', sql.Decimal(12,2), 0)
    .input('totalAmount', sql.Decimal(12,2), totalAmount)
    .input('paidAmount', sql.Decimal(12,2), 0)
    .input('status', sql.NVarChar, 'Unpaid')
    .input('paymentDueDate', sql.Date, dueDate)
    .query(`
      INSERT INTO oe.Invoices 
      (InvoiceId, GroupId, LocationId, InvoiceNumber, InvoiceDate, DueDate,
       BillingPeriodStart, BillingPeriodEnd, SubTotal, TaxAmount, TotalAmount,
       PaidAmount, Status, PaymentDueDate, CreatedDate, ModifiedDate, CreatedBy, ModifiedBy)
      VALUES 
      (@invoiceId, @groupId, @locationId, @invoiceNumber, @invoiceDate, @dueDate,
       @billingPeriodStart, @billingPeriodEnd, @subTotal, @taxAmount, @totalAmount,
       @paidAmount, @status, @paymentDueDate, GETUTCDATE(), GETUTCDATE(), NULL, NULL)
    `);
  
  logger.success(`    Created invoice ${invoiceNumber}: $${totalAmount.toFixed(2)}${totalSetupFees > 0 ? ` (includes $${totalSetupFees.toFixed(2)} in setup fees for ${totalNewEnrollments} new enrollment${totalNewEnrollments !== 1 ? 's' : ''})` : ''}`);
  
  return {
    invoiceId,
    invoiceNumber,
    dueDate,
    setupFeesAmount: totalSetupFees,
    newEnrollmentsCount: totalNewEnrollments
  };
}

/**
 * Send location invoice email
 * Uses UseLocationACH to determine which template to use
 * @param {Array} additionalLocations - Array of locations being charged to this invoice (for primary location)
 */
async function sendLocationInvoiceEmail(pool, group, location, fees, paymentMethod, billingDate, useLocationACH, logger, additionalLocations = []) {
  try {
    const tenantQuery = `SELECT TenantId FROM oe.Groups WHERE GroupId = @groupId`;
    const tenantResult = await pool.request()
      .input('groupId', sql.UniqueIdentifier, group.GroupId)
      .query(tenantQuery);
    const tenantId = tenantResult.recordset[0]?.TenantId;
    
    // Choose template based on UseLocationACH and IsPrimary
    // Primary locations always use the normal invoice template (even if UseLocationACH is false)
    // Non-primary locations with UseLocationACH=false use the "no payment" template
    const isPrimaryLocation = location.LocationIsPrimary || location.IsPrimary;
    const shouldUseNormalTemplate = isPrimaryLocation || useLocationACH;
    const templatePath = path.join(__dirname, '..', 'templates', 'emails', shouldUseNormalTemplate ? 'location-invoice.html' : 'location-invoice-no-payment.html');
    let emailHtml = fs.readFileSync(templatePath, 'utf8');
    
    // Payment method display
    let paymentMethodDisplay = 'On File';
    if (paymentMethod) {
      if (paymentMethod.Type === 'Card' || paymentMethod.Type === 'CreditCard') {
        paymentMethodDisplay = `${paymentMethod.CardBrand || 'Card'} ending in ${paymentMethod.CardLast4}`;
      } else if (paymentMethod.Type === 'ACH') {
        paymentMethodDisplay = `${paymentMethod.AccountType || 'Checking'} account ending in ${paymentMethod.AccountNumberLast4}`;
      }
    }
    
    // Format dates
    const formatDate = (date) => new Date(date).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
    
    // Calculate payment date (5th of the month) from billing date (1st of the month)
    const calculatePaymentDate = (billingDate) => {
      const date = new Date(billingDate);
      date.setDate(5); // Payment happens on the 5th
      return date;
    };
    
    const paymentDate = calculatePaymentDate(billingDate);
    
    // Build additional locations breakdown HTML (if primary location includes other locations)
    let additionalLocationsHtml = '';
    if (additionalLocations.length > 0) {
      additionalLocationsHtml = `
        <table width="100%" cellpadding="0" cellspacing="0" style="margin: 20px 0; border: 1px solid #e5e7eb; border-radius: 6px; overflow: hidden;">
          <tr style="background-color: #f9fafb;">
            <td style="padding: 12px; border-bottom: 1px solid #e5e7eb;">
              <p style="margin: 0; color: #1e40af; font-size: 13px; font-weight: 600;">This invoice includes premiums for the following locations:</p>
            </td>
          </tr>
          ${additionalLocations.map(loc => `
            <tr>
              <td style="padding: 12px; border-bottom: 1px solid #e5e7eb;">
                <p style="margin: 0; color: #374151; font-size: 14px;">
                  <strong>${loc.name}</strong>: $${parseFloat(loc.totalAmount).toFixed(2)} 
                  (${loc.memberCount} member${loc.memberCount !== 1 ? 's' : ''} across ${loc.householdCount} household${loc.householdCount !== 1 ? 's' : ''})
                </p>
              </td>
            </tr>
          `).join('')}
          <tr>
            <td style="padding: 12px; background-color: #eff6ff;">
              <p style="margin: 0; color: #1e40af; font-size: 13px; line-height: 1.5;">
                <strong>Note:</strong> These locations are configured to have their premiums paid by the primary location. Their charges are included in this invoice and will be paid using the primary location's payment method.
              </p>
            </td>
          </tr>
        </table>
      `;
    }
    
    // Calculate total amounts including additional locations (for primary location)
    let displayBasePremium = location.BasePremium;
    let displayTotalAmount = fees.totalAmount;
    let displayMemberCount = location.MemberCount;
    let displayHouseholdCount = location.HouseholdCount;
    let displayProcessingFees = fees.processingFees;
    let displaySetupFees = fees.setupFeesAmount || 0;
    let displayNewEnrollments = location.NewEnrollmentsWithSetupFees || 0;
    
    if (additionalLocations.length > 0) {
      // Add up all locations for display
      additionalLocations.forEach(loc => {
        displayBasePremium += loc.basePremium;
        displayTotalAmount += loc.totalAmount; // Already includes fees
        displayMemberCount += loc.memberCount;
        displayHouseholdCount += loc.householdCount;
        // Sum processing fees from each location
        displayProcessingFees += loc.processingFees || 0;
        // Sum setup fees from each location
        displaySetupFees += (loc.fees?.setupFeesAmount || 0);
        // Sum new enrollments from each location
        displayNewEnrollments += (loc.location?.NewEnrollmentsWithSetupFees || 0);
      });
    }
    
    // Build breakdown section HTML
    let breakdownSectionHtml = '';
    if (displayProcessingFees > 0 || displaySetupFees > 0) {
      breakdownSectionHtml = '<tr><td colspan="2" style="padding-top: 12px; border-top: 1px solid #e5e7eb;"><table width="100%" cellpadding="4" cellspacing="0">';
      breakdownSectionHtml += `<tr><td style="color: #6b7280; font-size: 13px;">Base Premium:</td><td align="right" style="color: #374151; font-size: 13px;">$${parseFloat(displayBasePremium).toFixed(2)}</td></tr>`;
      if (displayProcessingFees > 0) {
        breakdownSectionHtml += `<tr><td style="color: #6b7280; font-size: 13px;">Processing Fees:</td><td align="right" style="color: #374151; font-size: 13px;">$${parseFloat(displayProcessingFees).toFixed(2)}</td></tr>`;
      }
      if (displaySetupFees > 0) {
        const setupFeeLabel = displayNewEnrollments > 0 
          ? `Total Setup Fees (One-time) - ${displayNewEnrollments} new enrollment${displayNewEnrollments !== 1 ? 's' : ''}:`
          : 'Total Setup Fees (One-time):';
        breakdownSectionHtml += `<tr><td style="color: #6b7280; font-size: 13px;">${setupFeeLabel}</td><td align="right" style="color: #374151; font-size: 13px;">$${parseFloat(displaySetupFees).toFixed(2)}</td></tr>`;
      }
      breakdownSectionHtml += '</table></td></tr>';
    }
    
    // Replace template variables
    const variables = {
      groupName: group.GroupName,
      locationName: location.LocationName || 'Unnamed Location',
      contactName: location.LocationContactName || (location.LocationContactEmail?.split('@')[0] || 'Team').split('.').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
      basePremium: `$${parseFloat(displayBasePremium).toFixed(2)}`,
      processingFees: displayProcessingFees > 0 ? `$${parseFloat(displayProcessingFees).toFixed(2)}` : '',
      setupFees: displaySetupFees > 0 ? `$${parseFloat(displaySetupFees).toFixed(2)}` : '',
      newEnrollmentsCount: displayNewEnrollments > 0 ? displayNewEnrollments.toString() : '',
      totalAmount: `$${parseFloat(displayTotalAmount).toFixed(2)}`,
      memberCount: displayMemberCount.toString(),
      householdCount: displayHouseholdCount.toString(),
      paymentMethod: paymentMethodDisplay,
      billingDate: formatDate(billingDate),
      paymentDate: formatDate(paymentDate),
      currentYear: new Date().getFullYear().toString(),
      additionalLocationsBreakdown: additionalLocationsHtml,
      breakdownSection: breakdownSectionHtml
    };
    
    // Simple template processing
    Object.keys(variables).forEach(key => {
      const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
      emailHtml = emailHtml.replace(regex, variables[key] || '');
    });
    
    // Handle conditional blocks (legacy support)
    if (variables.processingFees) {
      emailHtml = emailHtml.replace(/\{\{#processingFees\}\}([\s\S]*?)\{\{\/processingFees\}\}/g, '$1');
    } else {
      emailHtml = emailHtml.replace(/\{\{#processingFees\}\}[\s\S]*?\{\{\/processingFees\}\}/g, '');
    }
    
    // Replace additional locations breakdown (insert before payment information section)
    if (additionalLocationsHtml) {
      emailHtml = emailHtml.replace(/\{\{additionalLocationsBreakdown\}\}/g, additionalLocationsHtml);
    } else {
      emailHtml = emailHtml.replace(/\{\{additionalLocationsBreakdown\}\}/g, '');
    }
    
    // Minify HTML
    const minifiedEmailHtml = emailHtml
      .replace(/\r\n/g, '').replace(/\n/g, '').replace(/\r/g, '')
      .replace(/\s+/g, ' ').replace(/>\s+</g, '><').trim();
    
    // Queue email
    const messageId = require('crypto').randomUUID();
    const subjectSuffix = useLocationACH ? '' : ' (Premium Covered by Primary Location)';
    
    await pool.request()
      .input('messageId', sql.UniqueIdentifier, messageId)
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('recipientAddress', sql.NVarChar, location.LocationContactEmail)
      .input('subject', sql.NVarChar, `Monthly Invoice - ${location.LocationName}${subjectSuffix}`)
      .input('body', sql.NVarChar, minifiedEmailHtml)
      .query(`
        INSERT INTO oe.MessageQueue (
          MessageId, TenantId, MessageType, RecipientAddress, 
          Subject, Body, Status, RetryCount, CreatedDate, CreatedBy, RecipientId
        ) VALUES (
          @messageId, @tenantId, 'Email', @recipientAddress,
          @subject, @body, 'Pending', 0, GETUTCDATE(), NULL, NULL
        )
      `);
    
    logger.success(`    Sent location invoice email: ${messageId}`);
    return true;
  } catch (error) {
    logger.error(`    Failed to send location email: ${error.message}`);
    return false;
  }
}

/**
 * Send consolidated group invoice email (to group contact + primary location contact)
 */
async function sendConsolidatedInvoiceEmail(pool, group, locationResults, billingDate, logger) {
  try {
    const tenantQuery = `SELECT TenantId FROM oe.Groups WHERE GroupId = @groupId`;
    const tenantResult = await pool.request()
      .input('groupId', sql.UniqueIdentifier, group.GroupId)
      .query(tenantQuery);
    const tenantId = tenantResult.recordset[0]?.TenantId;
    
    // Load template
    const templatePath = path.join(__dirname, '..', '..', 'backend', 'templates', 'emails', 'group-invoice-consolidated.html');
    let emailHtml = fs.readFileSync(templatePath, 'utf8');
    
    // Calculate totals - sum all location fees (primary, covered by primary, and separate locations)
    // Note: Each location's fees in locationResults are separate, so we sum them all
    const grandTotal = locationResults.reduce((sum, loc) => sum + loc.fees.totalAmount, 0);
    const totalMembers = locationResults.reduce((sum, loc) => sum + loc.location.MemberCount, 0);
    const totalHouseholds = locationResults.reduce((sum, loc) => sum + loc.location.HouseholdCount, 0);
    
    // Build location breakdown HTML - group locations covered by primary under primary
    let locationBreakdownHtml = '';
    
    // Find primary location and locations covered by it
    const primaryLocationResult = locationResults.find(lr => lr.location.LocationIsPrimary);
    const locationsCoveredByPrimary = locationResults.filter(lr => 
      !lr.location.LocationIsPrimary && 
      !lr.paymentMethod?.isOwnPaymentMethod
    );
    const otherLocations = locationResults.filter(lr => 
      !lr.location.LocationIsPrimary && 
      lr.paymentMethod?.isOwnPaymentMethod
    );
    
    // Display primary location group (own premium + locations covered by it)
    if (primaryLocationResult) {
      const loc = primaryLocationResult.location;
      const fees = primaryLocationResult.fees;
      
      // Show primary location's own premium first
      locationBreakdownHtml += `
        <tr>
          <td style="padding: 12px; border-bottom: 1px solid #e5e7eb;">
            ✅ <strong>${loc.LocationName}</strong> <span style="color: #6b7280; font-size: 12px; font-weight: normal;">(Primary Location)</span>
          </td>
          <td style="padding: 12px; border-bottom: 1px solid #e5e7eb; text-align: center;">
            ${loc.MemberCount} / ${loc.HouseholdCount}
          </td>
          <td style="padding: 12px; border-bottom: 1px solid #e5e7eb; text-align: right;">
            $${parseFloat(loc.BasePremium).toFixed(2)}
          </td>
          <td style="padding: 12px; border-bottom: 1px solid #e5e7eb; text-align: right;">
            $${parseFloat(fees.processingFees).toFixed(2)}
          </td>
          <td style="padding: 12px; border-bottom: 1px solid #e5e7eb; text-align: right;">
            $${parseFloat(fees.totalAmount).toFixed(2)}
          </td>
        </tr>
      `;
      
      // Display locations covered by primary (indented)
      let coveredLocationsBasePremium = 0;
      let coveredLocationsProcessingFees = 0;
      let coveredLocationsTotalAmount = 0;
      
      locationsCoveredByPrimary.forEach(locResult => {
        const loc = locResult.location;
        const fees = locResult.fees;
        
        coveredLocationsBasePremium += parseFloat(loc.BasePremium);
        coveredLocationsProcessingFees += parseFloat(fees.processingFees);
        coveredLocationsTotalAmount += parseFloat(fees.totalAmount);
        
        locationBreakdownHtml += `
          <tr>
            <td style="padding: 12px 12px 12px 40px; border-bottom: 1px solid #e5e7eb; color: #6b7280;">
              └─ ${loc.LocationName} <span style="color: #9ca3af; font-size: 11px;">(Premium covered by primary location)</span>
            </td>
            <td style="padding: 12px; border-bottom: 1px solid #e5e7eb; text-align: center; color: #6b7280;">
              ${loc.MemberCount} / ${loc.HouseholdCount}
            </td>
            <td style="padding: 12px; border-bottom: 1px solid #e5e7eb; text-align: right; color: #6b7280;">
              $${parseFloat(loc.BasePremium).toFixed(2)}
            </td>
            <td style="padding: 12px; border-bottom: 1px solid #e5e7eb; text-align: right; color: #6b7280;">
              $${parseFloat(fees.processingFees).toFixed(2)}
            </td>
            <td style="padding: 12px; border-bottom: 1px solid #e5e7eb; text-align: right; color: #6b7280;">
              $${parseFloat(fees.totalAmount).toFixed(2)}
            </td>
          </tr>
        `;
      });
      
      // Show subtotal row for primary location group if there are covered locations
      if (locationsCoveredByPrimary.length > 0) {
        const primaryGroupBasePremium = parseFloat(loc.BasePremium) + coveredLocationsBasePremium;
        const primaryGroupProcessingFees = parseFloat(fees.processingFees) + coveredLocationsProcessingFees;
        const primaryGroupTotalAmount = parseFloat(fees.totalAmount) + coveredLocationsTotalAmount;
        
        locationBreakdownHtml += `
          <tr style="background-color: #f9fafb;">
            <td style="padding: 12px; border-bottom: 2px solid #d1d5db; font-weight: 600; color: #111827;">
              <strong>${loc.LocationName} Total</strong> <span style="color: #6b7280; font-size: 12px; font-weight: normal;">(includes locations above)</span>
            </td>
            <td style="padding: 12px; border-bottom: 2px solid #d1d5db; text-align: center; font-weight: 600; color: #111827;">
              —
            </td>
            <td style="padding: 12px; border-bottom: 2px solid #d1d5db; text-align: right; font-weight: 600; color: #111827;">
              $${primaryGroupBasePremium.toFixed(2)}
            </td>
            <td style="padding: 12px; border-bottom: 2px solid #d1d5db; text-align: right; font-weight: 600; color: #111827;">
              $${primaryGroupProcessingFees.toFixed(2)}
            </td>
            <td style="padding: 12px; border-bottom: 2px solid #d1d5db; text-align: right; font-weight: 700; color: #111827; font-size: 15px;">
              $${primaryGroupTotalAmount.toFixed(2)}
            </td>
          </tr>
        `;
      }
    }
    
    // Display other locations that pay separately
    otherLocations.forEach(locResult => {
      const loc = locResult.location;
      const fees = locResult.fees;
      
      locationBreakdownHtml += `
        <tr>
          <td style="padding: 12px; border-bottom: 1px solid #e5e7eb;">
            ✅ <strong>${loc.LocationName}</strong>
          </td>
          <td style="padding: 12px; border-bottom: 1px solid #e5e7eb; text-align: center;">
            ${loc.MemberCount} / ${loc.HouseholdCount}
          </td>
          <td style="padding: 12px; border-bottom: 1px solid #e5e7eb; text-align: right;">
            $${parseFloat(loc.BasePremium).toFixed(2)}
          </td>
          <td style="padding: 12px; border-bottom: 1px solid #e5e7eb; text-align: right;">
            $${parseFloat(fees.processingFees).toFixed(2)}
          </td>
          <td style="padding: 12px; border-bottom: 1px solid #e5e7eb; text-align: right; font-weight: 600;">
            $${parseFloat(fees.totalAmount).toFixed(2)}
          </td>
        </tr>
      `;
    });
    
    // Format date
    const formatDate = (date) => new Date(date).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
    
    // Calculate payment date (5th of the month) from billing date (1st of the month)
    const calculatePaymentDate = (billingDate) => {
      const date = new Date(billingDate);
      date.setDate(5); // Payment happens on the 5th
      return date;
    };
    
    const paymentDate = calculatePaymentDate(billingDate);
    
    // Replace template variables
    const variables = {
      groupName: group.GroupName,
      contactName: group.PrimaryContact ? group.PrimaryContact.split(' ')[0] : 'Team',
      grandTotal: `$${parseFloat(grandTotal).toFixed(2)}`,
      totalMembers: totalMembers.toString(),
      totalHouseholds: totalHouseholds.toString(),
      locationBreakdown: locationBreakdownHtml,
      billingDate: formatDate(billingDate),
      paymentDate: formatDate(paymentDate),
      currentYear: new Date().getFullYear().toString(),
      locationCount: locationResults.length.toString()
    };
    
    Object.keys(variables).forEach(key => {
      const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
      emailHtml = emailHtml.replace(regex, variables[key] || '');
    });
    
    // Minify HTML
    const minifiedEmailHtml = emailHtml
      .replace(/\r\n/g, '').replace(/\n/g, '').replace(/\r/g, '')
      .replace(/\s+/g, ' ').replace(/>\s+</g, '><').trim();
    
    // Send to group contact
    if (group.ContactEmail) {
      const messageId = require('crypto').randomUUID();
      await pool.request()
        .input('messageId', sql.UniqueIdentifier, messageId)
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('recipientAddress', sql.NVarChar, group.ContactEmail)
        .input('subject', sql.NVarChar, `Monthly Invoice - ${group.GroupName} - All Locations`)
        .input('body', sql.NVarChar, minifiedEmailHtml)
        .query(`
          INSERT INTO oe.MessageQueue (
            MessageId, TenantId, MessageType, RecipientAddress, 
            Subject, Body, Status, RetryCount, CreatedDate, CreatedBy, RecipientId
          ) VALUES (
            @messageId, @tenantId, 'Email', @recipientAddress,
            @subject, @body, 'Pending', 0, GETUTCDATE(), NULL, NULL
          )
        `);
      logger.success(`    Sent consolidated email to group contact: ${group.ContactEmail}`);
    }
    
    // Send to primary location contact (if different from group contact)
    const primaryLocation = locationResults.find(lr => lr.location.LocationIsPrimary);
    if (primaryLocation && primaryLocation.location.LocationContactEmail && 
        primaryLocation.location.LocationContactEmail !== group.ContactEmail) {
      const messageId = require('crypto').randomUUID();
      await pool.request()
        .input('messageId', sql.UniqueIdentifier, messageId)
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('recipientAddress', sql.NVarChar, primaryLocation.location.LocationContactEmail)
        .input('subject', sql.NVarChar, `Monthly Invoice - ${group.GroupName} - All Locations`)
        .input('body', sql.NVarChar, minifiedEmailHtml)
        .query(`
          INSERT INTO oe.MessageQueue (
            MessageId, TenantId, MessageType, RecipientAddress, 
            Subject, Body, Status, RetryCount, CreatedDate, CreatedBy, RecipientId
          ) VALUES (
            @messageId, @tenantId, 'Email', @recipientAddress,
            @subject, @body, 'Pending', 0, GETUTCDATE(), NULL, NULL
          )
        `);
      logger.success(`    Sent consolidated email to primary location contact: ${primaryLocation.location.LocationContactEmail}`);
    }
    
    return true;
  } catch (error) {
    logger.error(`    Failed to send consolidated email: ${error.message}`);
    return false;
  }
}

/**
 * Send execution report email to jeremy@open-enroll.net
 * Reports all successes and failures from the monthly payment scheduler run
 */
async function sendExecutionReportEmail(pool, results, startTime, endTime, billingDate, paymentDate, logger) {
  try {
    const duration = ((endTime - startTime) / 1000).toFixed(2);
    const formatDate = (date) => {
      return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    };
    
    // Build HTML report
    let html = `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .header { background-color: #2563eb; color: white; padding: 20px; border-radius: 5px 5px 0 0; }
    .content { padding: 20px; background-color: #f9fafb; }
    .section { background-color: white; padding: 15px; margin: 10px 0; border-radius: 5px; border-left: 4px solid #2563eb; }
    .success { border-left-color: #10b981; }
    .error { border-left-color: #ef4444; }
    .warning { border-left-color: #f59e0b; }
    h2 { margin-top: 0; color: #1f2937; }
    h3 { color: #4b5563; margin-top: 20px; }
    table { width: 100%; border-collapse: collapse; margin: 10px 0; }
    th, td { padding: 8px; text-align: left; border-bottom: 1px solid #e5e7eb; }
    th { background-color: #f3f4f6; font-weight: 600; }
    .stat { font-size: 24px; font-weight: bold; color: #2563eb; }
    .stat-success { color: #10b981; }
    .stat-error { color: #ef4444; }
    .error-detail { background-color: #fef2f2; padding: 10px; margin: 5px 0; border-radius: 3px; border-left: 3px solid #ef4444; }
    .success-detail { background-color: #f0fdf4; padding: 10px; margin: 5px 0; border-radius: 3px; border-left: 3px solid #10b981; }
  </style>
</head>
<body>
  <div class="header">
    <h1>Monthly Payment Scheduler Execution Report</h1>
    <p>Execution Date: ${formatDate(startTime)} at ${startTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' })}</p>
    <p>Duration: ${duration} seconds</p>
  </div>
  
  <div class="content">
    <div class="section">
      <h2>📊 Summary</h2>
      <table>
        <tr>
          <th>Metric</th>
          <th>Count</th>
        </tr>
        <tr>
          <td>Groups Processed</td>
          <td><span class="stat">${results.processed}</span></td>
        </tr>
        <tr>
          <td>Groups Updated Successfully</td>
          <td><span class="stat stat-success">${results.updated}</span></td>
        </tr>
        <tr>
          <td>Groups Failed</td>
          <td><span class="stat stat-error">${results.failed}</span></td>
        </tr>
        <tr>
          <td>Invoices Created</td>
          <td><span class="stat stat-success">${results.invoicesCreated}</span></td>
        </tr>
        <tr>
          <td>Emails Sent</td>
          <td><span class="stat stat-success">${results.emailsSent}</span></td>
        </tr>
        <tr>
          <td>Emails Failed</td>
          <td><span class="stat stat-error">${results.emailsFailed}</span></td>
        </tr>
        <tr>
          <td>DIME Schedule Errors</td>
          <td><span class="stat stat-error">${results.dimeErrors.length}</span></td>
        </tr>
      </table>
    </div>
    
    <div class="section">
      <h2>📅 Billing Information</h2>
      <p><strong>Invoice Date:</strong> ${formatDate(billingDate)}</p>
      <p><strong>Payment Date:</strong> ${formatDate(paymentDate)}</p>
    </div>`;
    
    // Add successful groups
    if (results.updated > 0) {
      html += `
    <div class="section success">
      <h2>✅ Successfully Processed Groups</h2>
      <p><strong>${results.updated} group(s) processed successfully</strong></p>
      <p>Invoices created and DIME schedules set up for these groups.</p>
    </div>`;
    }
    
    // Add group processing errors
    if (results.errors.length > 0) {
      html += `
    <div class="section error">
      <h2>❌ Group Processing Errors</h2>
      <p><strong>${results.errors.length} group(s) failed to process:</strong></p>`;
      
      results.errors.forEach(err => {
        html += `
      <div class="error-detail">
        <strong>${err.groupName || 'Unknown Group'}</strong><br>
        <em>Error:</em> ${err.error}<br>
        ${err.hasPaymentMethods ? '<strong>⚠️ Has payment methods - manual intervention required!</strong>' : ''}
      </div>`;
      });
      
      html += `
    </div>`;
    }
    
    // Add DIME errors
    if (results.dimeErrors.length > 0) {
      html += `
    <div class="section error">
      <h2>❌ DIME Schedule Creation Errors</h2>
      <p><strong>${results.dimeErrors.length} DIME schedule(s) failed to create:</strong></p>`;
      
      results.dimeErrors.forEach(err => {
        html += `
      <div class="error-detail">
        <strong>${err.groupName} - ${err.locationName}</strong><br>
        <em>Error:</em> ${err.error}<br>
        ${err.status ? `<em>Status:</em> ${err.status}<br>` : ''}
        ${err.amount ? `<em>Amount:</em> $${parseFloat(err.amount).toFixed(2)}<br>` : ''}
      </div>`;
      });
      
      html += `
    </div>`;
    }
    
    // Add email errors
    if (results.emailErrors.length > 0) {
      html += `
    <div class="section warning">
      <h2>⚠️ Email Queuing Errors</h2>
      <p><strong>${results.emailErrors.length} email(s) failed to queue:</strong></p>`;
      
      results.emailErrors.forEach(err => {
        html += `
      <div class="error-detail">
        <strong>${err.groupName} - ${err.locationName || 'Consolidated Email'}</strong><br>
        <em>Recipient:</em> ${err.recipientEmail || 'N/A'}<br>
        <em>Error:</em> ${err.error}
      </div>`;
      });
      
      html += `
    </div>`;
    }
    
    html += `
  </div>
</body>
</html>`;
    
    // Get tenant ID for message queue (use first tenant from results or query for any active tenant)
    let messageTenantId = null;
    if (results.errors.length > 0 && results.errors[0].groupId) {
      // Try to get tenant from first error group
      const tenantQuery = await pool.request()
        .input('groupId', sql.UniqueIdentifier, results.errors[0].groupId)
        .query(`SELECT TenantId FROM oe.Groups WHERE GroupId = @groupId`);
      messageTenantId = tenantQuery.recordset[0]?.TenantId;
    }
    
    if (!messageTenantId) {
      // Fallback: get any active tenant
      const tenantQuery = await pool.request().query(`SELECT TOP 1 TenantId FROM oe.Tenants WHERE Status = 'Active'`);
      messageTenantId = tenantQuery.recordset[0]?.TenantId;
    }
    
    if (!messageTenantId) {
      logger.warn(`  Cannot send execution report - no tenant ID available`);
      return false;
    }
    
    // Queue the email
    const messageId = require('crypto').randomUUID();
    await pool.request()
      .input('messageId', sql.UniqueIdentifier, messageId)
      .input('tenantId', sql.UniqueIdentifier, messageTenantId)
      .input('recipientAddress', sql.NVarChar, 'jeremy@open-enroll.net')
      .input('subject', sql.NVarChar, `Monthly Payment Scheduler Report - ${formatDate(startTime)} (${results.failed > 0 ? 'FAILURES' : 'SUCCESS'})`)
      .input('body', sql.NVarChar, html)
      .query(`
        INSERT INTO oe.MessageQueue (
          MessageId, TenantId, MessageType, RecipientAddress, 
          Subject, Body, Status, RetryCount, CreatedDate, CreatedBy, RecipientId
        ) VALUES (
          @messageId, @tenantId, 'Email', @recipientAddress,
          @subject, @body, 'Pending', 0, GETUTCDATE(), NULL, NULL
        )
      `);
    
    logger.success(`  📧 Execution report queued to jeremy@open-enroll.net`);
    return true;
  } catch (error) {
    logger.error(`  Failed to queue execution report email: ${error.message}`);
    return false;
  }
}

/**
 * @param {object} context - Azure Function context
 * @param {object} myTimer - Timer trigger (null when invoked from DimeManualScheduler)
 * @param {object} [options] - Optional: { groupId } to run for a single group only (manual test)
 */
module.exports = async function (context, myTimer, options = {}) {
  const logger = createLogger(context);
  const startTime = new Date();
  const singleGroupId = options && options.groupId;
  const billingDateOverride = options && options.billingDate; // YYYY-MM-DD for regenerate flow

  logger.section('Monthly Payment Scheduler Started (Multi-Location Billing)');
  logger.info(`Execution Date: ${startTime.toISOString()}`);
  if (singleGroupId) logger.info(`Single-group mode: GroupId = ${singleGroupId}`);
  if (billingDateOverride) logger.info(`Billing date override: ${billingDateOverride}`);
  logger.info(`[DEBUG] Code version: Fixed primary location logic v2`);
  
  // Check if emails should be skipped (for testing)
  const SKIP_EMAILS = process.env.SKIP_EMAILS === 'true' || process.env.SKIP_EMAILS === '1';
  if (SKIP_EMAILS) {
    logger.warn('⚠️ SKIP_EMAILS is enabled - emails will NOT be sent (testing mode)');
  }
  
  // Check if transactions should be used (all-or-nothing: invoice + DIME must both succeed)
  const USE_TRANSACTIONS = process.env.USE_TRANSACTIONS === 'true' || process.env.USE_TRANSACTIONS === '1';
  if (USE_TRANSACTIONS) {
    logger.warn('⚠️ USE_TRANSACTIONS is enabled - invoice creation and DIME setup are atomic (all-or-nothing)');
  }
  
  let pool;
  const results = {
    processed: 0,
    updated: 0,
    unchanged: 0,
    failed: 0,
    invoicesCreated: 0,
    emailsSent: 0,
    emailsFailed: 0,
    errors: [],
    dimeErrors: [],  // Track DIME schedule creation errors
    emailErrors: []  // Track email queuing errors
  };

  try {
    // Connect to database
    pool = await getPool();
    logger.success('Database connected');
    
    // Calculate billing date and payment date
    // Override: when billingDateOverride (YYYY-MM-DD) is provided (e.g. from regenerate flow), use it
    // Otherwise: If run on or before the 5th: invoice for current month; if after 5th: next month
    const today = new Date();
    const currentDay = today.getDate();
    
    let billingDate;
    let paymentDate;
    
    if (billingDateOverride) {
      const [y, m, d] = billingDateOverride.split('-').map(Number);
      billingDate = new Date(y, (m || 1) - 1, d || 1);
      paymentDate = new Date(billingDate);
      paymentDate.setDate(5);
      if (paymentDate < billingDate) paymentDate.setMonth(paymentDate.getMonth() + 1);
    } else if (currentDay <= 5) {
      // Run on 1st-5th: invoice for current month, payment on 5th of current month
      billingDate = new Date(today.getFullYear(), today.getMonth(), 1);
      paymentDate = new Date(today.getFullYear(), today.getMonth(), 5);
    } else {
      // Run after 5th: invoice for next month, payment on 5th of next month
      billingDate = new Date(today.getFullYear(), today.getMonth() + 1, 1);
      paymentDate = new Date(today.getFullYear(), today.getMonth() + 1, 5);
    }
    
    logger.info(`Billing Date (Invoice Date): ${billingDate.toISOString().split('T')[0]}`);
    logger.info(`Payment Date: ${paymentDate.toISOString().split('T')[0]}`);
    
    // Get all active groups (or single group when options.groupId is set)
    const groupsQuery = `
      SELECT DISTINCT
        g.GroupId,
        g.TenantId,
        g.Name as GroupName,
        g.PrimaryContact,
        g.ContactEmail,
        g.ContactPhone,
        g.ProcessorCustomerId
      FROM oe.Groups g
      WHERE g.Status = 'Active'
      ${singleGroupId ? 'AND g.GroupId = @groupId' : ''}
      ORDER BY g.Name
    `;
    const groupsRequest = pool.request();
    if (singleGroupId) groupsRequest.input('groupId', sql.UniqueIdentifier, singleGroupId);
    const groupsResult = await groupsRequest.query(groupsQuery);
    const groups = groupsResult.recordset;
    
    logger.info(`Found ${groups.length} active groups`);
    
    // Process each group
    for (const group of groups) {
      results.processed++;
      
      try {
        logger.subsection(`Processing: ${group.GroupName} (${group.GroupId})`);
        
        // Get location premiums (pass billingDate to include unpaid setup fees)
        const locationPremiums = await calculateLocationPremiums(pool, group.GroupId, billingDate, logger);
        
        if (locationPremiums.length === 0) {
          logger.warn(`  No active enrollments, skipping`);
          continue;
        }
        
        // Fetch tenant settings
        const tenantSettingsResult = await pool.request()
          .input('tenantId', sql.UniqueIdentifier, group.TenantId)
          .query(`SELECT SystemFees, PaymentProcessorSettings FROM oe.Tenants WHERE TenantId = @tenantId`);
        
        let systemFeesSettings = null;
        let paymentProcessorSettings = null;
        
        if (tenantSettingsResult.recordset.length > 0) {
          try {
            systemFeesSettings = tenantSettingsResult.recordset[0].SystemFees ? JSON.parse(tenantSettingsResult.recordset[0].SystemFees) : null;
            paymentProcessorSettings = tenantSettingsResult.recordset[0].PaymentProcessorSettings ? JSON.parse(tenantSettingsResult.recordset[0].PaymentProcessorSettings) : null;
          } catch (e) {
            logger.warn(`  Failed to parse settings: ${e.message}`);
          }
        }
        
        // Get next invoice number
        let baseInvoiceNumber;
        try {
          const invoiceNumberResult = await pool.request()
            .output('InvoiceNumber', sql.NVarChar(50))
            .execute('oe.sp_GetNextInvoiceNumber');
          baseInvoiceNumber = invoiceNumberResult.output.InvoiceNumber;
        } catch (err) {
          // Fallback if stored procedure doesn't exist
          baseInvoiceNumber = `INV-${new Date().getFullYear()}-${String(Date.now()).slice(-6)}`;
        }
        
        logger.info(`  Base Invoice Number: ${baseInvoiceNumber}`);
        
        // Handle DIME customer - verify and refresh if needed
        if (!group.ProcessorCustomerId) {
          logger.warn(`  Creating DIME customer...`);
          
          if (!group.PrimaryContact || !group.ContactEmail) {
            logger.error(`  Missing contact info, cannot create customer`);
            results.failed++;
            continue;
          }
          
          const contactParts = group.PrimaryContact.split(' ');
          const createResult = await DimeService.createCustomer({
            firstName: contactParts[0],
            lastName: contactParts.slice(1).join(' ') || contactParts[0],
            email: group.ContactEmail,
            phone: group.ContactPhone?.replace(/\D/g, '').slice(-10)
          }, group.TenantId);
          
          if (!createResult.success) {
            logger.error(`  Failed to create DIME customer: ${createResult.message}`);
            results.failed++;
            continue;
          }
          
          logger.success(`  Created DIME customer: ${createResult.customerId}`);
          
          await pool.request()
            .input('groupId', sql.UniqueIdentifier, group.GroupId)
            .input('customerId', sql.NVarChar(255), createResult.customerId)
            .query(`UPDATE oe.Groups SET ProcessorCustomerId = @customerId, ModifiedDate = GETUTCDATE() WHERE GroupId = @groupId`);
          
          group.ProcessorCustomerId = createResult.customerId;
        } else {
          // Verify existing customer UUID is still valid in DIME
          logger.info(`  Verifying DIME customer: ${group.ProcessorCustomerId}`);
          const verifyResult = await DimeService.verifyCustomer(group.ProcessorCustomerId, group.TenantId);
          
          if (!verifyResult.exists) {
            logger.warn(`  ⚠️ Stored customer UUID is invalid in DIME. Attempting to find by email...`);
            
            // Check if group has payment methods - if so, we MUST find the existing customer
            const paymentMethodCheck = await pool.request()
              .input('groupId', sql.UniqueIdentifier, group.GroupId)
              .query(`
                SELECT COUNT(*) as PaymentMethodCount
                FROM oe.GroupPaymentMethods
                WHERE GroupId = @groupId AND Status = 'Active'
              `);
            
            const hasPaymentMethods = paymentMethodCheck.recordset[0]?.PaymentMethodCount > 0;
            
            if (hasPaymentMethods) {
              logger.warn(`  ⚠️ Group has ${paymentMethodCheck.recordset[0].PaymentMethodCount} active payment method(s) - MUST find existing customer to preserve payment methods`);
            }
            
            // Try to find customer by email (this preserves payment methods)
            if (group.ContactEmail) {
              const foundCustomer = await DimeService.getCustomerByEmail(group.ContactEmail, group.TenantId);
              
              if (foundCustomer.success && foundCustomer.customerId) {
                logger.success(`  ✅ Found customer by email: ${foundCustomer.customerId} (preserves payment methods)`);
                
                // Update database with correct customer UUID
                await pool.request()
                  .input('groupId', sql.UniqueIdentifier, group.GroupId)
                  .input('customerId', sql.NVarChar(255), foundCustomer.customerId)
                  .query(`UPDATE oe.Groups SET ProcessorCustomerId = @customerId, ModifiedDate = GETUTCDATE() WHERE GroupId = @groupId`);
                
                group.ProcessorCustomerId = foundCustomer.customerId;
              } else {
                // Customer not found by email - FAIL (payment methods can only be created manually in group portal)
                logger.error(`  ❌ CRITICAL: Customer UUID ${group.ProcessorCustomerId} is invalid and customer not found by email ${group.ContactEmail}`);
                logger.error(`  ❌ Manual intervention required: Check DIME dashboard or update ProcessorCustomerId in database`);
                logger.error(`  ❌ Payment methods can only be created manually in the group portal - cannot auto-create customer`);
                results.failed++;
                results.errors.push({
                  groupId: group.GroupId,
                  groupName: group.GroupName,
                  error: `Invalid customer UUID and not found by email ${group.ContactEmail}. Manual intervention required.`,
                  hasPaymentMethods: hasPaymentMethods
                });
                continue;
              }
            } else {
              logger.error(`  Cannot refresh customer UUID - missing contact email`);
              if (hasPaymentMethods) {
                logger.error(`  ❌ CRITICAL: Group has payment methods but cannot verify customer - manual intervention required`);
              }
              results.failed++;
              continue;
            }
          } else {
            logger.info(`  ✅ Customer UUID verified: ${group.ProcessorCustomerId}`);
          }
        }
        
        // Process each location
        const locationResults = [];
        const locationsChargingToPrimary = []; // Track locations with UseLocationACH=false
        
        for (let i = 0; i < locationPremiums.length; i++) {
          const location = locationPremiums[i];
          
          logger.info(`  Location: ${location.LocationName} (${location.HouseholdCount} households, ${location.MemberCount} members)`);
          logger.info(`    UseLocationACH: ${location.UseLocationACH ? 'Yes - pays separately' : 'No - charges to primary'}`);
          
          // Get payment method (checks UseLocationACH to determine billing)
          const paymentMethod = await getLocationPaymentMethod(pool, group.GroupId, location.LocationId, location.UseLocationACH, location.LocationIsPrimary, logger);
          
          if (!paymentMethod) {
            logger.error(`    No payment method available (even primary location has none), skipping`);
            results.failed++;
            continue;
          }
          
          // Calculate fees for this location (include unpaid setup fees)
          // Use PaymentProcessingFee and SystemFee from database enrollments ONLY (oe.Enrollments)
          // Never calculate from settings - all fees must be in oe.Enrollments
          const unpaidSetupFees = location.UnpaidSetupFees || 0;
          const dbPaymentProcessingFee = location.PaymentProcessingFeeAmount || 0;
          const dbSystemFee = location.SystemFeeAmount || 0;
          
          // Use database values from oe.Enrollments - if missing, use 0 and log warning
          if (dbPaymentProcessingFee === 0 && dbSystemFee === 0) {
            logger.warn(`    ⚠️ WARNING: No fee enrollments found in oe.Enrollments for location ${location.LocationName} (SystemFee=$${dbSystemFee.toFixed(2)}, PaymentProcessingFee=$${dbPaymentProcessingFee.toFixed(2)})`);
          } else {
            logger.info(`    Using database-stored fees from oe.Enrollments: SystemFee=$${dbSystemFee.toFixed(2)}, PaymentProcessingFee=$${dbPaymentProcessingFee.toFixed(2)}`);
          }
          
          const subtotalWithSystemFees = location.BasePremium + dbSystemFee;
          const fees = {
            systemFeesAmount: dbSystemFee,
            paymentProcessingFee: dbPaymentProcessingFee,
            setupFeesAmount: unpaidSetupFees,
            totalAmount: Math.round((subtotalWithSystemFees + dbPaymentProcessingFee + unpaidSetupFees) * 100) / 100,
            processingFees: Math.round((dbSystemFee + dbPaymentProcessingFee) * 100) / 100,
            subtotalWithSystemFees: subtotalWithSystemFees
          };
          
          logger.info(`    Base: $${location.BasePremium}, System Fees: $${fees.systemFeesAmount}, Payment Fee: $${fees.paymentProcessingFee}, Setup Fees: $${fees.setupFeesAmount}, Total: $${fees.totalAmount}`);
          
          // Check if this is the primary location
          const isPrimaryLocation = location.LocationIsPrimary || location.IsPrimary;
          logger.info(`    LocationIsPrimary: ${location.LocationIsPrimary}, IsPrimary: ${location.IsPrimary}, isPrimaryLocation: ${isPrimaryLocation}, UseLocationACH: ${location.UseLocationACH}`);
          
          // If location is NOT primary AND does NOT pay separately, add to primary location's charge
          if (!isPrimaryLocation && !location.UseLocationACH) {
            logger.info(`    Adding to primary location's invoice (UseLocationACH=false, not primary)`);
            locationsChargingToPrimary.push({
              location,
              fees
            });
            
            // Create a $0 invoice for this location to show in invoice list (makes it clear it's charged to primary)
            const invoiceSuffix = `-${location.LocationName?.replace(/\s/g, '') || 'NonBilling'}`;
            const invoiceNumber = `${baseInvoiceNumber}${invoiceSuffix}`;
            
            // Create invoice with $0 amounts (charged to primary)
            const zeroFees = {
              basePremium: 0,
              systemFeesAmount: 0,
              paymentProcessingFee: 0,
              subtotalWithSystemFees: 0,
              processingFees: 0,
              totalAmount: 0
            };
            
            const zeroInvoice = await generateInvoice(pool, group, location, zeroFees, billingDate, invoiceNumber, logger, []);
            logger.info(`    Created $0 invoice for ${location.LocationName} (charged to primary): ${invoiceNumber}`);
            results.invoicesCreated++;
            
            // Store for consolidated email
            locationResults.push({
              location,
              fees,
              paymentMethod,
              invoice: zeroInvoice // $0 invoice for display
            });
            
            // Send informational email only
            if (location.LocationContactEmail) {
              const emailSent = await sendLocationInvoiceEmail(
                pool, group, location, fees, paymentMethod, billingDate,
                false, // UseLocationACH = false
                logger
              );
              if (emailSent) results.emailsSent++;
              else results.emailsFailed++;
            }
            
            continue; // Don't create DIME schedule
          }
          
          // Primary location OR location pays separately - create invoice and DIME schedule
          // Compute effective schedule amount (primary may include non-billing locations)
          let scheduleAmountForSkip = fees.totalAmount;
          if (location.LocationIsPrimary && locationsChargingToPrimary.length > 0) {
            locationsChargingToPrimary.forEach(charge => {
              scheduleAmountForSkip += charge.fees.totalAmount;
            });
          }
          // Skip location when total is $0 - no active enrollments for this billing period; DIME rejects amount > 0
          if (scheduleAmountForSkip <= 0 || (typeof scheduleAmountForSkip === 'number' && scheduleAmountForSkip < 0.01)) {
            logger.info(`    ⏭️ Skipping location ${location.LocationName}: $0 due (no active enrollments for this billing period)`);
            continue;
          }
          
          // Skip if invoice already exists for this group/location/billing period (e.g. from a prior single-group run)
          const existingInvoiceCheck = await pool.request()
            .input('groupId', sql.UniqueIdentifier, group.GroupId)
            .input('locationId', sql.UniqueIdentifier, location.LocationId)
            .input('invoiceDate', sql.Date, billingDate)
            .query(`SELECT 1 AS HasExisting FROM oe.Invoices WHERE GroupId = @groupId AND LocationId = @locationId AND CAST(InvoiceDate AS DATE) = CAST(@invoiceDate AS DATE)`);
          if (existingInvoiceCheck.recordset && existingInvoiceCheck.recordset.length > 0) {
            logger.info(`    ⏭️ Skipping location ${location.LocationName}: invoice already exists for this billing period (no duplicate)`);
            continue;
          }
          
          const invoiceSuffix = locationPremiums.filter(l => l.UseLocationACH).length > 1 ? `-${location.LocationName?.replace(/\s/g, '') || (i + 1)}` : '';
          const invoiceNumber = `${baseInvoiceNumber}${invoiceSuffix}`;
          
          // Generate invoice - if primary location, include non-billing charges
          const additionalCharges = location.LocationIsPrimary ? locationsChargingToPrimary : [];
          
          // If USE_TRANSACTIONS is enabled, wrap invoice creation and DIME setup in a transaction
          // This ensures atomicity: if DIME fails, invoice is rolled back
          let invoice;
          let transaction = null;
          
          if (USE_TRANSACTIONS) {
            transaction = new sql.Transaction(pool);
            await transaction.begin();
            logger.info(`    🔒 Started transaction for invoice + DIME setup`);
          }
          
          try {
            invoice = await generateInvoice(pool, group, location, fees, billingDate, invoiceNumber, logger, additionalCharges, transaction);
            results.invoicesCreated++;
            
            // Store result for consolidated email
            locationResults.push({
              location,
              fees,
              paymentMethod,
              invoice
            });
            
            // Create/update DIME schedule if:
            // 1. Location pays separately (UseLocationACH = true), OR
            // 2. Location is primary (even if UseLocationACH = false, primary location must be charged)
            const isPrimaryLocation = location.LocationIsPrimary || location.IsPrimary;
            const shouldCreateDimeSchedule = (location.UseLocationACH && paymentMethod.isOwnPaymentMethod) || isPrimaryLocation;
          
          if (shouldCreateDimeSchedule) {
            try {
              // Cancel ALL existing schedules for this customer in DIME
              // This ensures we clean up any orphaned schedules that aren't in the database
              logger.info(`    Canceling all existing DIME schedules for customer ${group.ProcessorCustomerId}`);
              
              // First, try to get all schedules from DIME for this customer
              logger.info(`    [DIME] Listing recurring payments for customer: ${group.ProcessorCustomerId}`);
              const dimeSchedulesResult = await DimeService.listRecurringPayments(group.ProcessorCustomerId, group.TenantId);
              
              if (dimeSchedulesResult.success && dimeSchedulesResult.schedules && dimeSchedulesResult.schedules.length > 0) {
                logger.info(`    Found ${dimeSchedulesResult.schedules.length} schedule(s) in DIME for this customer`);
                
                // Cancel all active schedules from DIME
                for (const schedule of dimeSchedulesResult.schedules) {
                  const scheduleId = schedule.id || schedule.recurring_payment_id || schedule.schedule_id;
                  const status = schedule.status || schedule.state;
                  
                  // Cancel active schedules (skip already canceled/paused ones)
                  if (scheduleId) {
                    const statusLower = (status || '').toLowerCase();
                    if (statusLower === 'active' || statusLower === 'failed' || !status) {
                      try {
                        await DimeService.cancelRecurringPayment(scheduleId.toString(), group.TenantId);
                        logger.success(`    Canceled DIME schedule ${scheduleId} (status: ${status || 'unknown'})`);
                      } catch (cancelError) {
                        if (cancelError.response?.status !== 404) {
                          logger.warn(`    Failed to cancel DIME schedule ${scheduleId}: ${cancelError.message}`);
                        }
                      }
                    } else {
                      logger.info(`    Skipping DIME schedule ${scheduleId} (status: ${status})`);
                    }
                  }
                }
              } else {
                // Fallback: Cancel schedules from database if DIME API doesn't support listing
                if (dimeSchedulesResult.error) {
                  logger.warn(`    [DIME] List API error: ${dimeSchedulesResult.error.message} (status: ${dimeSchedulesResult.error.status})`);
                  if (dimeSchedulesResult.error.status === 404) {
                    logger.info(`    [DIME] List endpoint returned 404 - may not exist, falling back to database records`);
                  }
                } else {
                  logger.info(`    [DIME] List API returned no schedules`);
                }
                logger.info(`    Falling back to canceling schedules from database records`);
                const existingSchedulesQuery = `
                  SELECT DimeScheduleId 
                  FROM oe.GroupRecurringPaymentPlans 
                  WHERE GroupId = @groupId 
                    AND IsActive = 1
                    AND (LocationId = @locationId OR LocationId IS NULL)
                `;
                const existingSchedulesResult = await pool.request()
                  .input('groupId', sql.UniqueIdentifier, group.GroupId)
                  .input('locationId', sql.UniqueIdentifier, location.LocationId)
                  .query(existingSchedulesQuery);
                
                const scheduleIds = existingSchedulesResult.recordset.map(r => r.DimeScheduleId).filter(id => id);
                
                for (const scheduleId of scheduleIds) {
                  try {
                    logger.info(`    [DIME] Canceling schedule ${scheduleId} (from database)`);
                    await DimeService.cancelRecurringPayment(scheduleId, group.TenantId);
                    logger.success(`    Canceled existing schedule ${scheduleId} (from database)`);
                  } catch (cancelError) {
                    if (cancelError.response?.status !== 404) {
                      logger.warn(`    [DIME] Failed to cancel ${scheduleId}: ${cancelError.message}`);
                    } else {
                      logger.info(`    [DIME] Schedule ${scheduleId} already canceled (404)`);
                    }
                  }
                }
              }
              
              // Create new schedule - if primary location, include non-billing location charges
              // Use the calculated paymentDate (5th of current month if run on/before 5th, or 5th of next month if after 5th)
              const nextBillingDate = paymentDate;
              
              // Calculate schedule amount (define outside try-catch so it's accessible in error handlers)
              let scheduleAmount = fees.totalAmount;
              if (location.LocationIsPrimary && locationsChargingToPrimary.length > 0) {
                locationsChargingToPrimary.forEach(charge => {
                  scheduleAmount += charge.fees.totalAmount;
                });
                logger.info(`    DIME schedule amount includes non-billing locations: $${scheduleAmount.toFixed(2)}`);
              }
              
              logger.info(`    [DIME] Creating recurring payment: customer=${group.ProcessorCustomerId}, paymentMethod=${paymentMethod.ProcessorPaymentMethodId}, amount=$${scheduleAmount.toFixed(2)}`);
              const newSchedule = await DimeService.setupRecurringPayment({
                customerId: group.ProcessorCustomerId,
                paymentMethodId: paymentMethod.ProcessorPaymentMethodId,
                amount: scheduleAmount,
                description: `${group.GroupName} - ${location.LocationName}`,
                startDate: nextBillingDate
              }, group.TenantId);
              
              if (newSchedule.success) {
                logger.success(`    Created DIME schedule: ${newSchedule.scheduleId}`);
                
                // Handle unique constraint: only one IsActive=0 and one IsActive=1 per group
                // Strategy: Delete old inactive plans (keep history in other tables), then deactivate active, then insert new active
                // Note: We delete inactive plans to avoid constraint violation, but history is preserved in Invoices and Payments tables
                
                // Step 1: Delete old inactive plans to free up the IsActive=0 slot
                // History is preserved in oe.Invoices and oe.Payments tables
                // Create a new request for each query to avoid parameter conflicts
                const deleteRequest = transaction ? transaction.request() : pool.request();
                await deleteRequest
                  .input('groupId', sql.UniqueIdentifier, group.GroupId)
                  .input('locationId', sql.UniqueIdentifier, location.LocationId)
                  .query(`
                    DELETE FROM oe.GroupRecurringPaymentPlans 
                    WHERE GroupId = @groupId 
                      AND (LocationId = @locationId OR LocationId IS NULL)
                      AND IsActive = 0
                  `);
                
                // Step 2: Deactivate current active plan (now safe since we deleted inactive ones)
                const updateRequest = transaction ? transaction.request() : pool.request();
                await updateRequest
                  .input('groupId', sql.UniqueIdentifier, group.GroupId)
                  .input('locationId', sql.UniqueIdentifier, location.LocationId)
                  .query(`UPDATE oe.GroupRecurringPaymentPlans SET IsActive = 0, ModifiedDate = GETUTCDATE() WHERE GroupId = @groupId AND (LocationId = @locationId OR LocationId IS NULL) AND IsActive = 1`);
                
                // Step 3: Insert new active plan
                const insertRequest = transaction ? transaction.request() : pool.request();
                await insertRequest
                  .input('groupId', sql.UniqueIdentifier, group.GroupId)
                  .input('locationId', sql.UniqueIdentifier, location.LocationId)
                  .input('invoiceId', sql.UniqueIdentifier, invoice.invoiceId)
                  .input('scheduleId', sql.NVarChar(255), newSchedule.scheduleId)
                  .input('amount', sql.Decimal(10,2), scheduleAmount)
                  .input('nextBillingDate', sql.DateTime2, nextBillingDate)
                  .query(`
                    INSERT INTO oe.GroupRecurringPaymentPlans (
                      PlanId, GroupId, LocationId, InvoiceId, DimeScheduleId, MonthlyAmount, BillingDay,
                      NextBillingDate, IsActive, CreatedDate, ModifiedDate
                    ) VALUES (
                      NEWID(), @groupId, @locationId, @invoiceId, @scheduleId, @amount, 5,
                      @nextBillingDate, 1, GETUTCDATE(), GETUTCDATE()
                    )
                  `);
                logger.success(`    Saved recurring payment plan to database (DIME schedule ${newSchedule.scheduleId})`);
                
                // Commit transaction if using transactions
                if (transaction) {
                  await transaction.commit();
                  logger.success(`    ✅ Transaction committed - invoice and DIME setup completed`);
                }
              } else {
                const errorDetails = newSchedule.error?.status 
                  ? ` (status: ${newSchedule.error.status})` 
                  : '';
                const errorMessage = `${newSchedule.error?.message || 'Unknown error'}${errorDetails}`;
                logger.error(`    [DIME] Failed to create recurring payment: ${errorMessage}`);
                if (newSchedule.error?.data) {
                  logger.error(`    [DIME] Error details: ${JSON.stringify(newSchedule.error.data)}`);
                }
                
                // If using transactions, rollback the invoice creation
                if (transaction) {
                  await transaction.rollback();
                  logger.error(`    🔄 Transaction rolled back - invoice creation reverted due to DIME failure`);
                  results.invoicesCreated--; // Adjust count since invoice was rolled back
                }
                
                // Capture error in results for database logging
                results.dimeErrors.push({
                  groupId: group.GroupId,
                  groupName: group.GroupName,
                  locationId: location.LocationId,
                  locationName: location.LocationName,
                  customerId: group.ProcessorCustomerId,
                  paymentMethodId: paymentMethod.ProcessorPaymentMethodId,
                  amount: scheduleAmount,
                  error: errorMessage,
                  status: newSchedule.error?.status,
                  errorData: newSchedule.error?.data
                });
                // Don't throw - continue processing other locations, but log the failure
              }
            } catch (scheduleError) {
              logger.error(`    [DIME] Error creating recurring payment schedule: ${scheduleError.message}`);
              if (scheduleError.response) {
                logger.error(`    [DIME] Response status: ${scheduleError.response.status}`);
                logger.error(`    [DIME] Response data: ${JSON.stringify(scheduleError.response.data)}`);
              }
              logger.error(`    [DIME] Stack: ${scheduleError.stack}`);
              // Capture error in results for database logging
              results.dimeErrors.push({
                groupId: group.GroupId,
                groupName: group.GroupName,
                locationId: location.LocationId,
                locationName: location.LocationName,
                customerId: group.ProcessorCustomerId,
                paymentMethodId: paymentMethod?.ProcessorPaymentMethodId,
                amount: scheduleAmount || 0, // Use 0 as fallback if scheduleAmount wasn't calculated yet
                error: scheduleError.message,
                status: scheduleError.response?.status,
                responseData: scheduleError.response?.data,
                stack: scheduleError.stack
              });
              
              // If using transactions, rollback the invoice creation
              if (transaction) {
                try {
                  await transaction.rollback();
                  logger.error(`    🔄 Transaction rolled back - invoice creation reverted due to DIME error`);
                  results.invoicesCreated--; // Adjust count since invoice was rolled back
                } catch (rollbackError) {
                  logger.error(`    Failed to rollback transaction: ${rollbackError.message}`);
                }
              }
              // Don't throw - continue processing other locations
            }
          }
          
          // Commit transaction if it was started and DIME succeeded (or if no DIME schedule was needed)
          if (transaction && (!shouldCreateDimeSchedule || (shouldCreateDimeSchedule && invoice))) {
            // Transaction already committed in DIME success block, or no DIME needed
            // Just ensure we're not in a transaction state
          }
          
          } catch (transactionError) {
            // Catch any errors during invoice creation or transaction handling
            logger.error(`    Error in invoice/DIME transaction: ${transactionError.message}`);
            if (transaction) {
              try {
                await transaction.rollback();
                logger.error(`    🔄 Transaction rolled back due to error`);
              } catch (rollbackError) {
                logger.error(`    Failed to rollback transaction: ${rollbackError.message}`);
              }
            }
            // Re-throw to be caught by outer try-catch
            throw transactionError;
          }
          
          // Send location email AFTER transaction commits (if location has contact email) - SKIP if SKIP_EMAILS is enabled
          if (location.LocationContactEmail && !SKIP_EMAILS) {
            // Pass additional charges info for primary location emails
            const additionalLocationsInfo = location.LocationIsPrimary && additionalCharges.length > 0 
              ? additionalCharges.map(c => ({
                  name: c.location.LocationName,
                  basePremium: c.location.BasePremium,
                  totalAmount: c.fees.totalAmount,
                  processingFees: c.fees.processingFees,
                  memberCount: c.location.MemberCount,
                  householdCount: c.location.HouseholdCount
                }))
              : [];
            
            // Primary locations always use normal invoice template (even if UseLocationACH is false)
            const isPrimaryLocation = location.LocationIsPrimary || location.IsPrimary;
            const shouldUseNormalTemplate = isPrimaryLocation || location.UseLocationACH;
            
            const emailSent = await sendLocationInvoiceEmail(
              pool, group, location, fees, paymentMethod, billingDate,
              shouldUseNormalTemplate, logger, additionalLocationsInfo
            );
            if (emailSent) {
              results.emailsSent++;
            } else {
              results.emailsFailed++;
              results.emailErrors.push({
                groupId: group.GroupId,
                groupName: group.GroupName,
                locationId: location.LocationId,
                locationName: location.LocationName,
                recipientEmail: location.LocationContactEmail,
                error: 'Email queuing failed - check Azure logs for details'
              });
            }
          } else if (location.LocationContactEmail && SKIP_EMAILS) {
            logger.info(`    ⏭️ Skipping email (SKIP_EMAILS enabled)`);
          }
        }
        
        // Send consolidated email if multiple locations (only if not skipping emails)
        if (locationResults.length > 1 && !SKIP_EMAILS) {
          const consolidatedSent = await sendConsolidatedInvoiceEmail(pool, group, locationResults, billingDate, logger);
          if (consolidatedSent) {
            results.emailsSent++;
          } else {
            results.emailsFailed++;
            results.emailErrors.push({
              groupId: group.GroupId,
              groupName: group.GroupName,
              locationId: null,
              locationName: 'Consolidated Email',
              recipientEmail: group.ContactEmail,
              error: 'Consolidated email queuing failed - check Azure logs for details'
            });
          }
        }
        
        results.updated++;
        
      } catch (error) {
        logger.error(`  ❌ Group processing failed: ${group.GroupName} (${group.GroupId})`);
        logger.error(`  Error: ${error.message}`);
        if (error.response) {
          logger.error(`  HTTP Status: ${error.response.status}`);
          logger.error(`  Response Data: ${JSON.stringify(error.response.data)}`);
        }
        logger.error(`  Stack: ${error.stack}`);
        results.failed++;
        results.errors.push({
          groupId: group.GroupId,
          groupName: group.GroupName,
          error: error.message,
          status: error.response?.status,
          responseData: error.response?.data
        });
      }
    }
    
    // Summary
    logger.section('Monthly Payment Scheduler Summary');
    logger.info(`Processed: ${results.processed} groups`);
    logger.success(`Updated: ${results.updated} groups`);
    logger.success(`Invoices Created: ${results.invoicesCreated}`);
    logger.success(`Emails Sent: ${results.emailsSent}`);
    logger.error(`Failed: ${results.failed} groups`);
    logger.error(`Emails Failed: ${results.emailsFailed}`);
    
    if (results.errors.length > 0) {
      logger.subsection('Group Processing Errors');
      results.errors.forEach(err => {
        logger.error(`  ${err.groupName}: ${err.error}`);
      });
    }
    
    if (results.dimeErrors.length > 0) {
      logger.subsection('DIME Schedule Creation Errors');
      results.dimeErrors.forEach(err => {
        logger.error(`  ${err.groupName} - ${err.locationName}: ${err.error}`);
      });
    }
    
    if (results.emailErrors.length > 0) {
      logger.subsection('Email Queuing Errors');
      results.emailErrors.forEach(err => {
        logger.error(`  ${err.groupName} - ${err.locationName}: ${err.error}`);
      });
    }
    
    const duration = (new Date() - startTime) / 1000;
    logger.success(`Completed in ${duration.toFixed(2)}s`);
    
    // Store execution log
    const endTime = new Date();
    await pool.request()
      .input('jobName', sql.NVarChar(100), 'MonthlyPaymentScheduler')
      .input('startTime', sql.DateTime2, startTime)
      .input('endTime', sql.DateTime2, endTime)
      .input('status', sql.NVarChar(50), results.failed === 0 ? 'Success' : 'PartialSuccess')
      .input('resultSummary', sql.NVarChar(sql.MAX), JSON.stringify(results))
      .query(`
        INSERT INTO oe.ScheduledJobExecutions (
          ExecutionId, JobName, StartTime, EndTime, Status, ResultSummary
        ) VALUES (
          NEWID(), @jobName, @startTime, @endTime, @status, @resultSummary
        )
      `);
    
    // Send execution report email to jeremy@open-enroll.net
    await sendExecutionReportEmail(pool, results, startTime, endTime, billingDate, paymentDate, logger);
    
  } catch (error) {
    logger.error(`Fatal error: ${error.message}`);
    logger.error(`Stack: ${error.stack}`);
    
    if (pool) {
      try {
        await pool.request()
          .input('jobName', sql.NVarChar(100), 'MonthlyPaymentScheduler')
          .input('startTime', sql.DateTime2, startTime)
          .input('endTime', sql.DateTime2, new Date())
          .input('status', sql.NVarChar(50), 'Failed')
          .input('errorMessage', sql.NVarChar(sql.MAX), error.message)
          .query(`
            INSERT INTO oe.ScheduledJobExecutions (
              ExecutionId, JobName, StartTime, EndTime, Status, ErrorMessage
            ) VALUES (
              NEWID(), @jobName, @startTime, @endTime, @status, @errorMessage
            )
          `);
      } catch (logError) {
        logger.error(`Failed to log error: ${logError.message}`);
      }
    }
    
    throw error;
  } finally {
    if (pool) {
      try {
        await pool.close();
        logger.info('Database connection closed');
      } catch (closeError) {
        logger.error(`Error closing connection: ${closeError.message}`);
      }
    }
  }
};
