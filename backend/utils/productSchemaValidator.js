// backend/utils/productSchemaValidator.js
// Validates AI-generated product data against expected schema

const PRODUCT_TYPES = [
  'Healthcare',
  'Dental',
  'Vision',
  'Life Insurance',
  'Disability',
  'Accident',
  'Critical Illness',
  'Hospital Indemnity',
  'Other'
];

const SALES_TYPES = ['Individual', 'Group', 'Both'];

const PRICING_TIER_TYPES = ['EE', 'ES', 'EC', 'EF', 'N/A'];

const EFFECTIVE_DATE_LOGIC = [
  'FirstOfMonth',
  'FirstOfNextMonth',
  'ImmediateEffectiveDate',
  'Custom'
];

const FIELD_TYPES = [
  'text',
  'textarea',
  'dropdown',
  'checkbox',
  'yesno',
  'number',
  'date'
];

/**
 * Validates AI-generated product data
 * Only validates field types and structure, not required fields (those can be empty)
 * @param {Object} data - The product data to validate
 * @returns {Object} - { valid: boolean, errors: string[] }
 */
function validateProductData(data) {
  const errors = [];

  // Type validation (not required, but if present must be correct type)
  if (data.vendorId !== undefined && typeof data.vendorId !== 'string') {
    errors.push('vendorId must be a string');
  }

  if (data.name !== undefined && typeof data.name !== 'string') {
    errors.push('name must be a string');
  }

  if (data.productType !== undefined && !PRODUCT_TYPES.includes(data.productType)) {
    errors.push(`productType must be one of: ${PRODUCT_TYPES.join(', ')}`);
  }

  if (data.productOwnerId !== undefined && typeof data.productOwnerId !== 'string') {
    errors.push('productOwnerId must be a string');
  }

  // Enum validations (only if present)
  if (data.salesType !== undefined && !SALES_TYPES.includes(data.salesType)) {
    errors.push(`salesType must be one of: ${SALES_TYPES.join(', ')}`);
  }

  if (data.effectiveDateLogic !== undefined && !EFFECTIVE_DATE_LOGIC.includes(data.effectiveDateLogic)) {
    errors.push(`effectiveDateLogic must be one of: ${EFFECTIVE_DATE_LOGIC.join(', ')}`);
  }

  // Number validations
  if (data.minAge !== undefined) {
    if (typeof data.minAge !== 'number' || data.minAge < 0 || data.minAge > 150) {
      errors.push('minAge must be a number between 0 and 150');
    }
  }

  if (data.maxAge !== undefined) {
    if (typeof data.maxAge !== 'number' || data.maxAge < 0 || data.maxAge > 150) {
      errors.push('maxAge must be a number between 0 and 150');
    }
  }

  if (data.minAge && data.maxAge && data.minAge >= data.maxAge) {
    errors.push('minAge must be less than maxAge');
  }

  if (data.maxEffectiveDateDays !== undefined) {
    if (typeof data.maxEffectiveDateDays !== 'number' || data.maxEffectiveDateDays < 0) {
      errors.push('maxEffectiveDateDays must be a non-negative number');
    }
  }

  // Boolean validations
  if (data.isVendorPricing !== undefined && typeof data.isVendorPricing !== 'boolean') {
    errors.push('isVendorPricing must be a boolean');
  }

  if (data.requiresTobaccoInfo !== undefined && typeof data.requiresTobaccoInfo !== 'boolean') {
    errors.push('requiresTobaccoInfo must be a boolean');
  }

  if (data.isPublic !== undefined && typeof data.isPublic !== 'boolean') {
    errors.push('isPublic must be a boolean');
  }

  if (data.includeProcessingFee !== undefined && typeof data.includeProcessingFee !== 'boolean') {
    errors.push('includeProcessingFee must be a boolean');
  }

  if (data.manualIncludedProcessingFee !== undefined && typeof data.manualIncludedProcessingFee !== 'boolean') {
    errors.push('manualIncludedProcessingFee must be a boolean');
  }

  if (data.roundUpProcessingFee !== undefined && typeof data.roundUpProcessingFee !== 'boolean') {
    errors.push('roundUpProcessingFee must be a boolean');
  }

  if (data.processingFeePercentage !== undefined && data.processingFeePercentage !== null) {
    const pct = Number(data.processingFeePercentage);
    if (Number.isNaN(pct) || pct < 0 || pct > 100) {
      errors.push('processingFeePercentage must be a number between 0 and 100');
    }
  }

  // Array validations
  if (data.allowedStates !== undefined) {
    if (!Array.isArray(data.allowedStates)) {
      errors.push('allowedStates must be an array');
    } else if (data.allowedStates.length > 0 && data.allowedStates.some(state => typeof state !== 'string' || state.length !== 2)) {
      errors.push('allowedStates must be an array of 2-letter state codes');
    }
  }

  if (data.requiredLicenses !== undefined && !Array.isArray(data.requiredLicenses)) {
    errors.push('requiredLicenses must be an array');
  }

  // Configuration Fields validation
  if (data.configurationFields !== undefined) {
    if (!Array.isArray(data.configurationFields)) {
      errors.push('configurationFields must be an array');
    } else {
      data.configurationFields.forEach((field, index) => {
        if (!field.fieldName || typeof field.fieldName !== 'string') {
          errors.push(`configurationFields[${index}].fieldName is required and must be a string`);
        }
        if (!Array.isArray(field.fieldOptions)) {
          errors.push(`configurationFields[${index}].fieldOptions must be an array`);
        }
      });
    }
  }

  // Pricing Tiers validation (only validate structure if present)
  if (data.pricingTiers !== undefined) {
    if (!Array.isArray(data.pricingTiers)) {
      errors.push('pricingTiers must be an array');
    } else if (data.pricingTiers.length > 0) {
      data.pricingTiers.forEach((tier, tierIndex) => {
        if (!tier.tierType || !PRICING_TIER_TYPES.includes(tier.tierType)) {
          errors.push(`pricingTiers[${tierIndex}].tierType must be one of: ${PRICING_TIER_TYPES.join(', ')}`);
        }

        if (!Array.isArray(tier.ageBands) || tier.ageBands.length === 0) {
          errors.push(`pricingTiers[${tierIndex}].ageBands must be a non-empty array`);
        } else {
          tier.ageBands.forEach((band, bandIndex) => {
            // Only minAge and maxAge are truly required
            const requiredNumbers = ['minAge', 'maxAge'];
            requiredNumbers.forEach(field => {
              if (band[field] === undefined || typeof band[field] !== 'number') {
                errors.push(`pricingTiers[${tierIndex}].ageBands[${bandIndex}].${field} must be a number`);
              }
            });

            // Optional number fields - only validate type if present
            const optionalNumbers = ['netRate', 'overrideRate', 'commission', 'systemFees', 'msrpRate'];
            optionalNumbers.forEach(field => {
              if (band[field] !== undefined && typeof band[field] !== 'number') {
                errors.push(`pricingTiers[${tierIndex}].ageBands[${bandIndex}].${field} must be a number if provided`);
              }
            });

            // Tobacco status - can be 'N/A', 'Yes', or 'No'
            if (band.tobaccoStatus && !['N/A', 'Yes', 'No'].includes(band.tobaccoStatus)) {
              errors.push(`pricingTiers[${tierIndex}].ageBands[${bandIndex}].tobaccoStatus must be 'N/A', 'Yes', or 'No'`);
            }
          });
        }
      });
    }
  }

  // Acknowledgement Questions validation
  if (data.acknowledgementQuestions !== undefined) {
    if (!Array.isArray(data.acknowledgementQuestions)) {
      errors.push('acknowledgementQuestions must be an array');
    } else {
      data.acknowledgementQuestions.forEach((question, index) => {
        if (!question.question || typeof question.question !== 'string') {
          errors.push(`acknowledgementQuestions[${index}].question is required and must be a string`);
        }
        if (!question.fieldType || !FIELD_TYPES.includes(question.fieldType)) {
          errors.push(`acknowledgementQuestions[${index}].fieldType must be one of: ${FIELD_TYPES.join(', ')}`);
        }
        if (question.required !== undefined && typeof question.required !== 'boolean') {
          errors.push(`acknowledgementQuestions[${index}].required must be a boolean`);
        }
        if (question.fieldType === 'dropdown' && (!question.options || !Array.isArray(question.options))) {
          errors.push(`acknowledgementQuestions[${index}].options must be an array for dropdown fieldType`);
        }
      });
    }
  }

  // AI Chunks validation
  if (data.aiChunks !== undefined) {
    if (!Array.isArray(data.aiChunks)) {
      errors.push('aiChunks must be an array');
    } else {
      data.aiChunks.forEach((chunk, index) => {
        if (!chunk.chunk_text || typeof chunk.chunk_text !== 'string') {
          errors.push(`aiChunks[${index}].chunk_text is required and must be a string`);
        }
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Formats validation errors for AI to understand and fix
 * @param {string[]} errors - Array of error messages
 * @returns {string} - Formatted error message
 */
function formatErrorsForAI(errors) {
  return `The generated product data has the following validation errors:\n\n${errors.map((err, i) => `${i + 1}. ${err}`).join('\n')}\n\nPlease fix these errors and generate valid JSON again.`;
}

module.exports = {
  validateProductData,
  formatErrorsForAI,
  PRODUCT_TYPES,
  SALES_TYPES,
  PRICING_TIER_TYPES,
  EFFECTIVE_DATE_LOGIC,
  FIELD_TYPES
};

