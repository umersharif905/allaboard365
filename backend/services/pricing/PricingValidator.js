/**
 * PRICING VALIDATOR - Input validation and error handling
 * 
 * Used by: PricingEngine for all pricing calculations
 */

class PricingValidator {
  /**
   * Validate pricing calculation parameters
   * @param {Object} params - Pricing parameters
   * @throws {Error} If validation fails
   */
  static validateInputs(params) {
    if (!params) {
      throw new Error('Pricing parameters are required');
    }

    // Validate calculation type
    if (!params.calculationType || !['enrollment', 'current', 'simulation'].includes(params.calculationType)) {
      throw new Error('calculationType must be one of: enrollment, current, simulation');
    }

    // For current calculations, memberId is required
    if (params.calculationType === 'current' && !params.memberId) {
      throw new Error('memberId is required for current calculations');
    }

    // For enrollment and simulation, memberCriteria is required
    if (['enrollment', 'simulation'].includes(params.calculationType)) {
      this.validateMemberCriteria(params.memberCriteria);
    }

    // For enrollment calculations, productSelections is required
    if (params.calculationType === 'enrollment' && (!params.productSelections || !Array.isArray(params.productSelections))) {
      throw new Error('productSelections array is required for enrollment calculations');
    }

    // For simulation calculations, simulationContext is required
    if (params.calculationType === 'simulation' && !params.simulationContext) {
      throw new Error('simulationContext is required for simulation calculations');
    }
  }

  /**
   * Validate member criteria
   * @param {Object} memberCriteria - Member criteria object
   * @throws {Error} If validation fails
   */
  static validateMemberCriteria(memberCriteria) {
    if (!memberCriteria) {
      throw new Error('memberCriteria is required');
    }

    if (typeof memberCriteria.age !== 'number' || memberCriteria.age < 0 || memberCriteria.age > 120) {
      throw new Error('memberCriteria.age must be a number between 0 and 120');
    }

    if (!memberCriteria.tobaccoUse || !['Yes', 'No', 'Y', 'N', 'yes', 'no'].includes(memberCriteria.tobaccoUse)) {
      throw new Error('memberCriteria.tobaccoUse must be "Yes", "No", "Y", "N", "yes", or "no"');
    }

    if (!memberCriteria.tier || !['EE', 'ES', 'EC', 'EF'].includes(memberCriteria.tier)) {
      throw new Error('memberCriteria.tier must be one of: EE, ES, EC, EF');
    }

    if (typeof memberCriteria.householdSize !== 'number' || memberCriteria.householdSize < 1) {
      throw new Error('memberCriteria.householdSize must be a positive number');
    }
  }

  /**
   * Validate product selection
   * @param {Object} productSelection - Product selection object
   * @throws {Error} If validation fails
   */
  static validateProductSelection(productSelection) {
    if (!productSelection) {
      throw new Error('productSelection is required');
    }

    if (!productSelection.productId || typeof productSelection.productId !== 'string') {
      throw new Error('productSelection.productId must be a valid string');
    }

    if (productSelection.configValues && typeof productSelection.configValues !== 'object') {
      throw new Error('productSelection.configValues must be an object');
    }
  }

  /**
   * Validate contribution rule
   * @param {Object} rule - Contribution rule object
   * @throws {Error} If validation fails
   */
  static validateContributionRule(rule) {
    if (!rule) {
      throw new Error('contribution rule is required');
    }

    if (!rule.ContributionType || !['flat_rate', 'percentage', 'tier_based', 'role_based', 'override'].includes(rule.ContributionType)) {
      throw new Error('contribution rule type must be one of: flat_rate, percentage, tier_based, role_based, override');
    }

    // Validate based on contribution type
    switch (rule.ContributionType) {
      case 'flat_rate':
        if (typeof rule.FlatRateAmount !== 'number' || rule.FlatRateAmount < 0) {
          throw new Error('flat_rate contribution must have valid FlatRateAmount');
        }
        break;
      case 'percentage':
        if (typeof rule.PercentageAmount !== 'number' || rule.PercentageAmount < 0 || rule.PercentageAmount > 100) {
          throw new Error('percentage contribution must have valid PercentageAmount between 0 and 100');
        }
        break;
      case 'tier_based':
        if (!rule.TierContributions || typeof rule.TierContributions !== 'object') {
          throw new Error('tier_based contribution must have valid TierContributions object');
        }
        break;
    }
  }

  /**
   * Validate pricing result
   * @param {Object} result - Pricing result object
   * @throws {Error} If validation fails
   */
  static validatePricingResult(result) {
    if (!result) {
      throw new Error('pricing result is required');
    }

    if (!Array.isArray(result.products)) {
      throw new Error('pricing result must have products array');
    }

    if (!result.totals || typeof result.totals !== 'object') {
      throw new Error('pricing result must have totals object');
    }

    const { totalPremium, totalEmployerContribution, totalEmployeeContribution } = result.totals;

    if (typeof totalPremium !== 'number' || totalPremium < 0) {
      throw new Error('totalPremium must be a non-negative number');
    }

    if (typeof totalEmployerContribution !== 'number' || totalEmployerContribution < 0) {
      throw new Error('totalEmployerContribution must be a non-negative number');
    }

    if (typeof totalEmployeeContribution !== 'number' || totalEmployeeContribution < 0) {
      throw new Error('totalEmployeeContribution must be a non-negative number');
    }

    // Validate that contributions don't exceed premium
    if (totalEmployerContribution > totalPremium) {
      throw new Error('employer contribution cannot exceed total premium');
    }

    // Validate that employee + employer = total (within rounding tolerance)
    const calculatedTotal = totalEmployerContribution + totalEmployeeContribution;
    const difference = Math.abs(calculatedTotal - totalPremium);
    if (difference > 0.01) { // Allow for rounding differences
      throw new Error(`contribution totals don't match premium: ${calculatedTotal} vs ${totalPremium}`);
    }
  }

  /**
   * Sanitize and validate numeric input
   * @param {any} value - Input value
   * @param {string} fieldName - Field name for error messages
   * @param {number} min - Minimum allowed value
   * @param {number} max - Maximum allowed value
   * @returns {number} Sanitized numeric value
   */
  static sanitizeNumeric(value, fieldName, min = 0, max = Number.MAX_SAFE_INTEGER) {
    if (value === null || value === undefined) {
      return 0;
    }

    const num = Number(value);
    if (isNaN(num)) {
      throw new Error(`${fieldName} must be a valid number`);
    }

    if (num < min || num > max) {
      throw new Error(`${fieldName} must be between ${min} and ${max}`);
    }

    return Math.round(num * 100) / 100; // Round to 2 decimal places
  }

  /**
   * Validate UUID format
   * @param {string} uuid - UUID string
   * @param {string} fieldName - Field name for error messages
   * @throws {Error} If validation fails
   */
  static validateUUID(uuid, fieldName) {
    if (!uuid || typeof uuid !== 'string') {
      throw new Error(`${fieldName} must be a valid string`);
    }

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(uuid)) {
      throw new Error(`${fieldName} must be a valid UUID format`);
    }
  }
}

module.exports = PricingValidator;
