// src/utils/ruleValidation.ts
export const ruleValidationSchemas = {
  percentageSum: (rules: any[]) => {
    const totalByProduct = rules.reduce((acc: Record<string, number>, rule) => {
      if (rule.commissionType === 'Percentage' && rule.status === 'Active') {
        const key = rule.productId;
        acc[key] = (acc[key] || 0) + (rule.rate || 0);
      }
      return acc;
    }, {} as Record<string, number>);

    const errors: string[] = [];
    Object.entries(totalByProduct).forEach(([productId, total]: [string, number]) => {
      if (total > 0.25) {
        errors.push(
          `Product ${productId}: Total commission ${(total * 100).toFixed(2)}% exceeds 25% limit`
        );
      }
    });

    return errors;
  },

  dateOverlap: (rules: any[]) => {
    const errors: string[] = [];
    const sortedRules = [...rules].sort(
      (a, b) => new Date(a.effectiveDate).getTime() - new Date(b.effectiveDate).getTime()
    );

    for (let i = 0; i < sortedRules.length - 1; i++) {
      const current = sortedRules[i];
      const next = sortedRules[i + 1];

      if (
        current.productId === next.productId &&
        current.entityType === next.entityType &&
        current.status === 'Active' &&
        next.status === 'Active'
      ) {
        const currentEnd = current.terminationDate
          ? new Date(current.terminationDate)
          : new Date('9999-12-31');
        const nextStart = new Date(next.effectiveDate);

        if (currentEnd >= nextStart) {
          errors.push(
            `Rules "${current.ruleName}" and "${next.ruleName}" have overlapping date ranges`
          );
        }
      }
    }

    return errors;
  },

  tierCompleteness: (rule: any) => {
    const errors: string[] = [];

    if (rule.entityType === 'Tier' && rule.commissionType === 'Tiered') {
      const tiers = rule.jsonConfig?.tiers || [];
      const expectedLevels = [0, 1, 2, 3, 4, 5]; // Agent through NMO

      const missingLevels = expectedLevels.filter(
        (level) => !tiers.some((tier: any) => tier.level === level)
      );

      if (missingLevels.length > 0) {
        errors.push(`Missing tier levels: ${missingLevels.join(', ')}`);
      }
    }

    return errors;
  },

  validateRule: (rule: any) => {
    const errors: string[] = [];

    // Basic validation
    if (!rule.ruleName) errors.push('Rule name is required');
    if (!rule.productId) errors.push('Product is required');
    if (!rule.entityType) errors.push('Entity type is required');
    if (!rule.commissionType) errors.push('Commission type is required');
    if (!rule.effectiveDate) errors.push('Effective date is required');

    // Type-specific validation
    if (rule.commissionType === 'Percentage' && (!rule.rate || rule.rate <= 0)) {
      errors.push('Valid commission rate is required for percentage type');
    }

    if (rule.commissionType === 'Flat' && (!rule.amount || rule.amount <= 0)) {
      errors.push('Valid commission amount is required for flat type');
    }

    if (rule.commissionType === 'Tiered' && (!rule.jsonConfig?.tiers || rule.jsonConfig.tiers.length === 0)) {
      errors.push('At least one tier is required for tiered type');
    }

    // Date validation
    if (rule.effectiveDate && rule.terminationDate) {
      const effective = new Date(rule.effectiveDate);
      const termination = new Date(rule.terminationDate);
      if (termination <= effective) {
        errors.push('Termination date must be after effective date');
      }
    }

    return errors;
  },
};