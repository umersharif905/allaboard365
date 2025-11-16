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
 */
async function calculateLocationPremiums(pool, groupId, logger) {
  const query = `
    -- Get primary location for fallback
    DECLARE @PrimaryLocationId UNIQUEIDENTIFIER;
    SELECT TOP 1 @PrimaryLocationId = LocationId 
    FROM oe.GroupLocations 
    WHERE GroupId = @groupId AND IsPrimary = 1;
    
    -- Calculate premiums by location (primary member's LocationId determines billing)
    SELECT 
      COALESCE(pm.LocationId, @PrimaryLocationId) as LocationId,
      gl.Name as LocationName,
      gl.ContactName as LocationContactName,
      gl.ContactEmail as LocationContactEmail,
      gl.IsPrimary as LocationIsPrimary,
      gl.UseLocationACH as UseLocationACH,
      COUNT(DISTINCT pm.HouseholdId) as HouseholdCount,
      COUNT(DISTINCT m_all.MemberId) as MemberCount,
      COUNT(e.EnrollmentId) as EnrollmentCount,
      SUM(e.PremiumAmount) as BasePremium
    FROM oe.Members pm
    INNER JOIN oe.Enrollments e ON pm.HouseholdId = e.HouseholdId
    LEFT JOIN oe.Members m_all ON e.HouseholdId = m_all.HouseholdId AND m_all.Status != 'Terminated'
    LEFT JOIN oe.GroupLocations gl ON COALESCE(pm.LocationId, @PrimaryLocationId) = gl.LocationId
    WHERE pm.MemberSequence = 1  -- Primary member determines location
      AND pm.GroupId = @groupId
      AND pm.Status != 'Terminated'
      AND e.Status = 'Active'
    GROUP BY COALESCE(pm.LocationId, @PrimaryLocationId), gl.Name, gl.ContactName, gl.ContactEmail, gl.IsPrimary, gl.UseLocationACH
    ORDER BY gl.IsPrimary DESC, gl.Name
  `;
  
  const result = await pool.request()
    .input('groupId', sql.UniqueIdentifier, groupId)
    .query(query);
  
  logger.info(`  Found ${result.recordset.length} location(s) with enrollments`);
  
  return result.recordset;
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

/**
 * Calculate fees for a location
 */
function calculateLocationFees(basePremium, householdCount, paymentMethodType, systemFeesSettings, paymentProcessorSettings) {
  const premiumCalculator = require('../shared/premiumCalculator');
  
  // Calculate system fees
  const subtotalWithSystemFees = premiumCalculator.calculateGroupMonthlyTotal(
    basePremium,
    householdCount,
    systemFeesSettings
  );
  
  const systemFeesAmount = Math.round((subtotalWithSystemFees - basePremium) * 100) / 100;
  
  // Calculate payment processing fees
  let paymentProcessingFee = 0;
  
  if (paymentProcessorSettings?.chargeFeeToMember && paymentProcessorSettings?.processors?.openenroll?.fees) {
    const fees = paymentProcessorSettings.processors.openenroll.fees;
    const feeConfig = (paymentMethodType === 'Card' || paymentMethodType === 'CreditCard') ? fees.creditCard : fees.ach;
    
    if (feeConfig) {
      let percentageValue = feeConfig.percentageFee || 0;
      
      // Handle both decimal (0.0025 = 0.25%) and whole number (3 = 3%) formats
      if (percentageValue >= 1) {
        percentageValue = percentageValue / 100;
      }
      
      const percentageFee = subtotalWithSystemFees * percentageValue;
      const flatFee = feeConfig.flatFee || 0;
      paymentProcessingFee = Math.round((percentageFee + flatFee) * 100) / 100;
    }
  }
  
  // Final amount includes: base premium + system fees + payment processing fees
  const totalAmount = Math.round((subtotalWithSystemFees + paymentProcessingFee) * 100) / 100;
  const processingFees = Math.round((systemFeesAmount + paymentProcessingFee) * 100) / 100;
  
  return {
    systemFeesAmount,
    paymentProcessingFee,
    totalAmount,
    processingFees,
    subtotalWithSystemFees
  };
}

/**
 * Generate invoice record for a location
 */
async function generateInvoice(pool, group, location, fees, billingDate, invoiceNumber, logger, additionalCharges = []) {
  const invoiceId = require('crypto').randomUUID();
  
  // Calculate due date (5th of next month)
  const dueDate = new Date(billingDate);
  dueDate.setMonth(dueDate.getMonth() + 1);
  dueDate.setDate(5);
  
  // Billing period (current month)
  const billingPeriodStart = new Date(billingDate.getFullYear(), billingDate.getMonth(), 1);
  const billingPeriodEnd = new Date(billingDate.getFullYear(), billingDate.getMonth() + 1, 0);
  
  // If this is the primary location, add non-billing location charges
  let totalSubTotal = location.BasePremium;
  let totalAmount = fees.totalAmount;
  
  if (location.LocationIsPrimary && additionalCharges.length > 0) {
    logger.info(`    Primary location - adding ${additionalCharges.length} non-billing location(s):`);
    additionalCharges.forEach(charge => {
      totalSubTotal += charge.fees.basePremium;
      totalAmount += charge.fees.totalAmount;
      logger.info(`      ${charge.location.LocationName}: +$${charge.fees.totalAmount.toFixed(2)}`);
    });
    logger.info(`    Primary location total: $${totalAmount.toFixed(2)}`);
  }
  
  await pool.request()
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
  
  logger.success(`    Created invoice ${invoiceNumber}: $${totalAmount.toFixed(2)}`);
  
  return {
    invoiceId,
    invoiceNumber,
    dueDate
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
    
    // Choose template based on UseLocationACH
    // If true: location pays separately (normal invoice)
    // If false: charged to primary location (warning invoice)
    const templatePath = path.join(__dirname, '..', '..', 'backend', 'templates', 'emails', useLocationACH ? 'location-invoice.html' : 'location-invoice-no-payment.html');
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
    
    if (additionalLocations.length > 0) {
      // Add up all locations for display
      additionalLocations.forEach(loc => {
        displayBasePremium += loc.basePremium;
        displayTotalAmount += loc.totalAmount; // Already includes fees
        displayMemberCount += loc.memberCount;
        displayHouseholdCount += loc.householdCount;
        // Sum processing fees from each location
        displayProcessingFees += loc.processingFees || 0;
      });
    }
    
    // Replace template variables
    const variables = {
      groupName: group.GroupName,
      locationName: location.LocationName || 'Unnamed Location',
      contactName: location.LocationContactName || (location.LocationContactEmail?.split('@')[0] || 'Team').split('.').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
      basePremium: `$${parseFloat(displayBasePremium).toFixed(2)}`,
      processingFees: displayProcessingFees > 0 ? `$${parseFloat(displayProcessingFees).toFixed(2)}` : '',
      totalAmount: `$${parseFloat(displayTotalAmount).toFixed(2)}`,
      memberCount: displayMemberCount.toString(),
      householdCount: displayHouseholdCount.toString(),
      paymentMethod: paymentMethodDisplay,
      billingDate: formatDate(billingDate),
      currentYear: new Date().getFullYear().toString(),
      additionalLocationsBreakdown: additionalLocationsHtml
    };
    
    // Simple template processing
    Object.keys(variables).forEach(key => {
      const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
      emailHtml = emailHtml.replace(regex, variables[key] || '');
    });
    
    // Handle conditional blocks
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
    
    // Replace template variables
    const variables = {
      groupName: group.GroupName,
      contactName: group.PrimaryContact ? group.PrimaryContact.split(' ')[0] : 'Team',
      grandTotal: `$${parseFloat(grandTotal).toFixed(2)}`,
      totalMembers: totalMembers.toString(),
      totalHouseholds: totalHouseholds.toString(),
      locationBreakdown: locationBreakdownHtml,
      billingDate: formatDate(billingDate),
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

module.exports = async function (context, myTimer) {
  const logger = createLogger(context);
  const startTime = new Date();
  
  logger.section('Monthly Payment Scheduler Started (Multi-Location Billing)');
  logger.info(`Execution Date: ${startTime.toISOString()}`);
  
  let pool;
  const results = {
    processed: 0,
    updated: 0,
    unchanged: 0,
    failed: 0,
    invoicesCreated: 0,
    emailsSent: 0,
    emailsFailed: 0,
    errors: []
  };

  try {
    // Connect to database
    pool = await getPool();
    logger.success('Database connected');
    
    // Calculate billing date (5th of next month)
    const today = new Date();
    const currentDay = today.getDate();
    
    let billingDate;
    if (currentDay >= 5) {
      billingDate = new Date(today.getFullYear(), today.getMonth() + 1, 5);
    } else {
      billingDate = new Date(today.getFullYear(), today.getMonth(), 5);
    }
    
    logger.info(`Billing Date (Next Cycle): ${billingDate.toISOString().split('T')[0]}`);
    
    // Get all active groups
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
      ORDER BY g.Name
    `;
    
    const groupsResult = await pool.request().query(groupsQuery);
    const groups = groupsResult.recordset;
    
    logger.info(`Found ${groups.length} active groups`);
    
    // Process each group
    for (const group of groups) {
      results.processed++;
      
      try {
        logger.subsection(`Processing: ${group.GroupName} (${group.GroupId})`);
        
        // Get location premiums
        const locationPremiums = await calculateLocationPremiums(pool, group.GroupId, logger);
        
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
        
        // Handle DIME customer
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
          logger.info(`  Using existing DIME customer: ${group.ProcessorCustomerId}`);
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
          
          // Calculate fees for this location
          const fees = calculateLocationFees(
            location.BasePremium,
            location.HouseholdCount,
            paymentMethod.Type,
            systemFeesSettings,
            paymentProcessorSettings
          );
          
          logger.info(`    Base: $${location.BasePremium}, System Fees: $${fees.systemFeesAmount}, Payment Fee: $${fees.paymentProcessingFee}, Total: $${fees.totalAmount}`);
          
          // If location does NOT pay separately, add to primary location's charge
          if (!location.UseLocationACH) {
            logger.info(`    Adding to primary location's invoice (UseLocationACH=false)`);
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
          
          // Location pays separately - create invoice and DIME schedule
          const invoiceSuffix = locationPremiums.filter(l => l.UseLocationACH).length > 1 ? `-${location.LocationName?.replace(/\s/g, '') || (i + 1)}` : '';
          const invoiceNumber = `${baseInvoiceNumber}${invoiceSuffix}`;
          
          // Generate invoice - if primary location, include non-billing charges
          const additionalCharges = location.LocationIsPrimary ? locationsChargingToPrimary : [];
          const invoice = await generateInvoice(pool, group, location, fees, billingDate, invoiceNumber, logger, additionalCharges);
          results.invoicesCreated++;
          
          // Send location email (if location has contact email)
          if (location.LocationContactEmail) {
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
            
            const emailSent = await sendLocationInvoiceEmail(
              pool, group, location, fees, paymentMethod, billingDate,
              location.UseLocationACH, logger, additionalLocationsInfo
            );
            if (emailSent) results.emailsSent++;
            else results.emailsFailed++;
          }
          
          // Store result for consolidated email
          locationResults.push({
            location,
            fees,
            paymentMethod,
            invoice
          });
          
          // Create/update DIME schedule ONLY if location pays separately (UseLocationACH = true)
          if (location.UseLocationACH && paymentMethod.isOwnPaymentMethod) {
            try {
              // Cancel existing schedules for this location
              const existingSchedulesQuery = `
                SELECT DimeScheduleId 
                FROM oe.GroupRecurringPaymentPlans 
                WHERE GroupId = @groupId AND LocationId = @locationId AND IsActive = 1
              `;
              const existingSchedulesResult = await pool.request()
                .input('groupId', sql.UniqueIdentifier, group.GroupId)
                .input('locationId', sql.UniqueIdentifier, location.LocationId)
                .query(existingSchedulesQuery);
              
              const scheduleIds = existingSchedulesResult.recordset.map(r => r.DimeScheduleId).filter(id => id);
              
              for (const scheduleId of scheduleIds) {
                try {
                  await DimeService.cancelRecurringPayment(scheduleId, group.TenantId);
                  logger.success(`    Canceled existing schedule ${scheduleId}`);
                } catch (cancelError) {
                  if (cancelError.response?.status !== 404) {
                    logger.warn(`    Failed to cancel ${scheduleId}: ${cancelError.message}`);
                  }
                }
              }
              
              // Create new schedule - if primary location, include non-billing location charges
              const nextBillingDate = new Date(today.getFullYear(), today.getMonth() + 1, 5);
              
              let scheduleAmount = fees.totalAmount;
              if (location.LocationIsPrimary && locationsChargingToPrimary.length > 0) {
                locationsChargingToPrimary.forEach(charge => {
                  scheduleAmount += charge.fees.totalAmount;
                });
                logger.info(`    DIME schedule amount includes non-billing locations: $${scheduleAmount.toFixed(2)}`);
              }
              
              const newSchedule = await DimeService.setupRecurringPayment({
                customerId: group.ProcessorCustomerId,
                paymentMethodId: paymentMethod.ProcessorPaymentMethodId,
                amount: scheduleAmount,
                description: `${group.GroupName} - ${location.LocationName}`,
                startDate: nextBillingDate
              }, group.TenantId);
              
              if (newSchedule.success) {
                logger.success(`    Created DIME schedule: ${newSchedule.scheduleId}`);
                
                // Deactivate old plans for this group (unique constraint on GroupId+IsActive allows only one active plan per group)
                await pool.request()
                  .input('groupId', sql.UniqueIdentifier, group.GroupId)
                  .query(`UPDATE oe.GroupRecurringPaymentPlans SET IsActive = 0, ModifiedDate = GETUTCDATE() WHERE GroupId = @groupId AND IsActive = 1`);
                
                // Insert new plan (use scheduleAmount which includes non-billing charges)
                await pool.request()
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
              } else {
                logger.error(`    Failed to create DIME schedule: ${newSchedule.error.message}`);
              }
            } catch (scheduleError) {
              logger.error(`    Error creating DIME schedule: ${scheduleError.message}`);
              // Don't throw - continue processing other locations
            }
          }
        }
        
        // Send consolidated email if multiple locations
        if (locationResults.length > 1) {
          const consolidatedSent = await sendConsolidatedInvoiceEmail(pool, group, locationResults, billingDate, logger);
          if (consolidatedSent) results.emailsSent++;
          else results.emailsFailed++;
        }
        
        results.updated++;
        
      } catch (error) {
        logger.error(`  Error: ${error.message}`);
        logger.error(`  Stack: ${error.stack}`);
        results.failed++;
        results.errors.push({
          groupId: group.GroupId,
          groupName: group.GroupName,
          error: error.message
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
      logger.subsection('Errors');
      results.errors.forEach(err => {
        logger.error(`  ${err.groupName}: ${err.error}`);
      });
    }
    
    const duration = (new Date() - startTime) / 1000;
    logger.success(`Completed in ${duration.toFixed(2)}s`);
    
    // Store execution log
    await pool.request()
      .input('jobName', sql.NVarChar(100), 'MonthlyPaymentScheduler')
      .input('startTime', sql.DateTime2, startTime)
      .input('endTime', sql.DateTime2, new Date())
      .input('status', sql.NVarChar(50), results.failed === 0 ? 'Success' : 'PartialSuccess')
      .input('resultSummary', sql.NVarChar(sql.MAX), JSON.stringify(results))
      .query(`
        INSERT INTO oe.ScheduledJobExecutions (
          ExecutionId, JobName, StartTime, EndTime, Status, ResultSummary
        ) VALUES (
          NEWID(), @jobName, @startTime, @endTime, @status, @resultSummary
        )
      `);
    
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
