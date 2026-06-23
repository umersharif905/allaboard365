/**
 * Utility functions for converting between monthly and pay period amounts
 * All contributions are stored as monthly in the database
 * UI displays/accepts input based on group's payroll period preference
 */

export type PayrollPeriod = 'Monthly' | 'Bi-Monthly' | 'Bi-Weekly' | 'Weekly';

/**
 * Convert monthly amount to pay period amount for display/input
 */
export const convertMonthlyToPayPeriod = (monthlyAmount: number, payrollPeriod: PayrollPeriod): number => {
  switch (payrollPeriod) {
    case 'Monthly':
      return monthlyAmount;
    case 'Bi-Monthly':
      return monthlyAmount / 2;
    case 'Bi-Weekly':
      // Bi-weekly: 26 pay periods per year = monthly * 12 / 26
      return (monthlyAmount * 12) / 26;
    case 'Weekly':
      // Weekly: 52 pay periods per year = monthly * 12 / 52
      return (monthlyAmount * 12) / 52;
    default:
      return monthlyAmount;
  }
};

/**
 * Convert pay period amount to monthly amount for storage
 * Rounds UP to nearest cent to ensure we never under-collect
 */
export const convertPayPeriodToMonthly = (payPeriodAmount: number, payrollPeriod: PayrollPeriod): number => {
  switch (payrollPeriod) {
    case 'Monthly':
      return payPeriodAmount;
    case 'Bi-Monthly':
      return payPeriodAmount * 2;
    case 'Bi-Weekly': {
      // Bi-weekly: 26 pay periods per year = pay period * 26 / 12
      // Round UP to nearest cent (multiply by 100, ceil, divide by 100)
      const biWeeklyMonthly = (payPeriodAmount * 26) / 12;
      return Math.ceil(biWeeklyMonthly * 100) / 100;
    }
    case 'Weekly': {
      // Weekly: 52 pay periods per year = pay period * 52 / 12
      const weeklyMonthly = (payPeriodAmount * 52) / 12;
      return Math.ceil(weeklyMonthly * 100) / 100;
    }
    default:
      return payPeriodAmount;
  }
};

/**
 * Get label text for pay period
 */
export const getPayPeriodLabel = (payrollPeriod: PayrollPeriod): string => {
  switch (payrollPeriod) {
    case 'Monthly':
      return 'per month';
    case 'Bi-Monthly':
      return 'per pay period (2 pay periods per month)';
    case 'Bi-Weekly':
      return 'per pay period (26 pay periods per year)';
    case 'Weekly':
      return 'per pay period (52 pay periods per year)';
    default:
      return 'per month';
  }
};

/**
 * Get input label text for contribution amount field
 */
export const getContributionAmountLabel = (payrollPeriod: PayrollPeriod): string => {
  switch (payrollPeriod) {
    case 'Monthly':
      return 'Monthly Contribution Amount';
    case 'Bi-Monthly':
      return 'Bi-Monthly Contribution Amount';
    case 'Bi-Weekly':
      return 'Bi-Weekly Contribution Amount';
    case 'Weekly':
      return 'Weekly Contribution Amount';
    default:
      return 'Monthly Contribution Amount';
  }
};

/**
 * Get short period label for display (weekly, bi-weekly, bi-monthly, monthly)
 */
export const getShortPeriodLabel = (payrollPeriod: PayrollPeriod): string => {
  switch (payrollPeriod) {
    case 'Monthly':
      return 'monthly';
    case 'Bi-Monthly':
      return 'bi-monthly';
    case 'Bi-Weekly':
      return 'bi-weekly';
    case 'Weekly':
      return 'weekly';
    default:
      return 'monthly';
  }
};

/**
 * Format contribution amount for display: shows pay period amount with period label and monthly equivalent
 * Example: "$113.80/bi-weekly ($69.34/mo)"
 */
export const formatContributionDisplay = (
  monthlyAmount: number,
  payrollPeriod: PayrollPeriod
): string => {
  const payPeriodAmount = convertMonthlyToPayPeriod(monthlyAmount, payrollPeriod);
  const periodLabel = getShortPeriodLabel(payrollPeriod);
  
  if (payrollPeriod === 'Monthly') {
    return `$${monthlyAmount.toFixed(2)}/monthly`;
  }
  
  return `$${payPeriodAmount.toFixed(2)}/${periodLabel} ($${monthlyAmount.toFixed(2)}/mo)`;
};

