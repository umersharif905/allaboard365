/**
 * TIER CALCULATOR - Member tier and age band logic
 * 
 * Used by: PricingEngine for determining coverage tiers and age-based pricing
 */

class TierCalculator {
  /**
   * Calculate member tier based on household composition
   * @param {boolean} hasSpouse - Whether member has a spouse
   * @param {number} childrenCount - Number of children
   * @returns {string} Tier code (EE, ES, EC, EF)
   */
  static calculateMemberTier(hasSpouse, childrenCount) {
    if (!hasSpouse && childrenCount === 0) {
      return 'EE'; // Employee Only
    } else if (hasSpouse && childrenCount === 0) {
      return 'ES'; // Employee + Spouse
    } else if (!hasSpouse && childrenCount > 0) {
      return 'EC'; // Employee + Children
    } else if (hasSpouse && childrenCount > 0) {
      return 'EF'; // Employee + Family
    } else {
      return 'EE'; // Default fallback
    }
  }

  /**
   * Calculate age from date of birth
   * @param {string|Date} dateOfBirth - Date of birth
   * @returns {number} Age in years
   */
  static calculateAge(dateOfBirth) {
    if (!dateOfBirth) {
      throw new Error('dateOfBirth is required');
    }

    const birthDate = new Date(dateOfBirth);
    const today = new Date();
    
    if (isNaN(birthDate.getTime())) {
      throw new Error('Invalid dateOfBirth format');
    }

    if (birthDate > today) {
      throw new Error('dateOfBirth cannot be in the future');
    }

    let age = today.getFullYear() - birthDate.getFullYear();
    const monthDiff = today.getMonth() - birthDate.getMonth();
    
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
      age--;
    }

    return age;
  }

  /**
   * Find the correct age band for a product pricing
   * @param {Array} pricingRecords - Array of pricing records
   * @param {number} memberAge - Member's age
   * @param {string} tobaccoStatus - Member's tobacco status
   * @returns {Object|null} Matching pricing record or null
   */
  static findAgeBand(pricingRecords, memberAge, tobaccoStatus) {
    if (!Array.isArray(pricingRecords) || pricingRecords.length === 0) {
      return null;
    }

    // Filter by tobacco status first
    const tobaccoFiltered = pricingRecords.filter(record => 
      record.TobaccoStatus === tobaccoStatus
    );

    if (tobaccoFiltered.length === 0) {
      // Fallback to any tobacco status if no exact match
      console.warn(`No pricing found for tobacco status: ${tobaccoStatus}, using any tobacco status`);
      return this.findAgeBandByAge(pricingRecords, memberAge);
    }

    return this.findAgeBandByAge(tobaccoFiltered, memberAge);
  }

  /**
   * Find age band by age within filtered records
   * @param {Array} records - Filtered pricing records
   * @param {number} memberAge - Member's age
   * @returns {Object|null} Matching pricing record or null
   */
  static findAgeBandByAge(records, memberAge) {
    // Sort by MinAge descending to get the highest applicable age band
    const sortedRecords = records.sort((a, b) => (b.MinAge || 0) - (a.MinAge || 0));

    for (const record of sortedRecords) {
      const minAge = record.MinAge || 0;
      const maxAge = record.MaxAge || 999;

      if (memberAge >= minAge && memberAge <= maxAge) {
        return record;
      }
    }

    return null;
  }

  /**
   * Calculate household size from tier
   * @param {string} tier - Coverage tier (EE, ES, EC, EF)
   * @returns {number} Household size
   */
  static getHouseholdSizeFromTier(tier) {
    switch (tier) {
      case 'EE': return 1; // Employee only
      case 'ES': return 2; // Employee + Spouse
      case 'EC': return 1; // Employee + Children (employee + at least 1 child)
      case 'EF': return 2; // Employee + Spouse + Children (employee + spouse + at least 1 child)
      default: return 1;
    }
  }

  /**
   * Get tier display name
   * @param {string} tier - Coverage tier code
   * @returns {string} Human-readable tier name
   */
  static getTierDisplayName(tier) {
    switch (tier) {
      case 'EE': return 'Employee Only';
      case 'ES': return 'Employee + Spouse';
      case 'EC': return 'Employee + Children';
      case 'EF': return 'Employee + Family';
      default: return 'Unknown Tier';
    }
  }

  /**
   * Validate tier change impact
   * @param {string} currentTier - Current tier
   * @param {string} newTier - New tier
   * @returns {Object} Change impact information
   */
  static validateTierChange(currentTier, newTier) {
    const currentSize = this.getHouseholdSizeFromTier(currentTier);
    const newSize = this.getHouseholdSizeFromTier(newTier);
    
    return {
      currentTier,
      newTier,
      currentSize,
      newSize,
      isIncrease: newSize > currentSize,
      isDecrease: newSize < currentSize,
      sizeChange: newSize - currentSize,
      changeDescription: this.getTierChangeDescription(currentTier, newTier)
    };
  }

  /**
   * Get human-readable description of tier change
   * @param {string} currentTier - Current tier
   * @param {string} newTier - New tier
   * @returns {string} Change description
   */
  static getTierChangeDescription(currentTier, newTier) {
    if (currentTier === newTier) {
      return 'No change in coverage tier';
    }

    const currentName = this.getTierDisplayName(currentTier);
    const newName = this.getTierDisplayName(newTier);

    return `Changes from ${currentName} to ${newName}`;
  }

  /**
   * Calculate tier from household members
   * @param {Array} householdMembers - Array of household member objects
   * @param {string} primaryMemberId - Primary member ID
   * @returns {string} Calculated tier
   */
  static calculateTierFromHousehold(householdMembers, primaryMemberId) {
    if (!Array.isArray(householdMembers) || householdMembers.length === 0) {
      return 'EE';
    }

    // Find primary member
    const primaryMember = householdMembers.find(member => 
      member.MemberId === primaryMemberId || member.IsCurrentUser
    );

    if (!primaryMember) {
      console.warn('Primary member not found in household, defaulting to EE');
      return 'EE';
    }

    // Count dependents by relationship type
    const dependents = householdMembers.filter(member => 
      member.MemberId !== primaryMemberId && !member.IsCurrentUser
    );

    const spouseCount = dependents.filter(dep => 
      dep.RelationshipType === 'S' || dep.RelationshipType === 'Spouse'
    ).length;

    const childrenCount = dependents.filter(dep => 
      dep.RelationshipType === 'C' || dep.RelationshipType === 'Child'
    ).length;

    return this.calculateMemberTier(spouseCount > 0, childrenCount);
  }

  /**
   * Get tier-specific contribution amount from rule
   * @param {Object} rule - Contribution rule
   * @param {string} tier - Coverage tier
   * @returns {number} Contribution amount for this tier
   */
  static getTierContribution(rule, tier) {
    if (!rule || !rule.TierContributions) {
      return 0;
    }

    const tierContributions = rule.TierContributions;
    
    // Check for exact tier match first
    if (tierContributions[tier] !== undefined) {
      return Number(tierContributions[tier]) || 0;
    }

    // Check for full name matches
    const tierMappings = {
      'EE': ['employee_only', 'employee'],
      'ES': ['employee_spouse', 'employee_spouse'],
      'EC': ['employee_children', 'employee_children'],
      'EF': ['family', 'employee_family']
    };

    const possibleKeys = tierMappings[tier] || [];
    for (const key of possibleKeys) {
      if (tierContributions[key] !== undefined) {
        return Number(tierContributions[key]) || 0;
      }
    }

    return 0;
  }
}

module.exports = TierCalculator;
