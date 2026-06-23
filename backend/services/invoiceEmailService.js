const fs = require('fs');
const path = require('path');
const {
  COHORT_FIRST,
  getCohortFromDate,
  getChargeDayForCohort
} = require('../utils/billingCohort');

/**
 * SHARED INVOICE EMAIL GENERATION SERVICE
 * 
 * This service generates invoice email HTML using the same logic as MonthlyPaymentScheduler
 * Ensures consistency between actual invoice emails and sample invoice emails
 */

/**
 * Generate invoice email HTML for a location
 * @param {Object} options - Email generation options
 * @param {Object} options.group - Group information
 * @param {Object} options.location - Location information
 * @param {Object} options.fees - Fee calculations
 * @param {Object} options.paymentMethod - Payment method information
 * @param {Date} options.billingDate - Billing date
 * @param {boolean} options.useLocationACH - Whether location pays separately
 * @param {Array} options.additionalLocations - Additional locations charged to primary location
 * @returns {string} HTML email content
 */
function generateInvoiceEmailHtml({
  group,
  location,
  fees,
  paymentMethod,
  billingDate,
  useLocationACH,
  additionalLocations = []
}) {
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
  
  // Calculate payment (charge) date from the billing period start.
  // FIRST cohort (billing starts day 1) charges on day 5; FIFTEENTH (day 15) charges on day 20.
  // Fallback to FIRST cohort if the billingDate isn't exactly a cohort boundary.
  const calculatePaymentDate = (billingPeriodStart) => {
    const date = new Date(billingPeriodStart);
    let cohort;
    try {
      cohort = getCohortFromDate(date);
    } catch (e) {
      cohort = COHORT_FIRST;
    }
    date.setUTCDate(getChargeDayForCohort(cohort));
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
  let displayBasePremium = location.BasePremium ?? 0;
  let displayTotalAmount = fees?.totalAmount ?? 0;
  let displayMemberCount = location.MemberCount ?? 0;
  let displayHouseholdCount = location.HouseholdCount ?? 0;
  let displayProcessingFees = fees?.processingFees ?? 0;
  let displaySetupFees = fees?.setupFeesAmount ?? 0;
  let displayNewEnrollments = location.NewEnrollmentsWithSetupFees ?? 0;
  
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
    memberCount: String(displayMemberCount),
    householdCount: String(displayHouseholdCount),
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
  
  return minifiedEmailHtml;
}

module.exports = {
  generateInvoiceEmailHtml
};

