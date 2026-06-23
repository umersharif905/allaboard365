// Enrollment Constants
// Location: frontend/src/constants/enrollments.ts

/**
 * EnrollmentType values from oe.Enrollments table
 * Used to distinguish between different types of enrollment records
 */
export enum EnrollmentType {
  /** Standard product enrollment */
  PRODUCT = 'Product',
  /** Employer contribution enrollment (all-products rules) */
  CONTRIBUTION = 'Contribution',
  /** Payment processing fee enrollment */
  PAYMENT_PROCESSING_FEE = 'PaymentProcessingFee',
  /** Alternative processing fee type */
  PROCESSING_FEE = 'ProcessingFee',
  /** System fee enrollment */
  SYSTEM_FEE = 'SystemFee',
  /** Credit/debit adjustment enrollment (1-day duration for billing cycle adjustments) */
  CREDIT = 'Credit',
  /** One-time setup fee enrollment */
  SETUP_FEE = 'SetupFee'
}

/**
 * Special ProductId GUID used for non-product enrollment records
 * This GUID is used for:
 * - All-products Contribution enrollments (EnrollmentType = 'Contribution')
 * - SystemFee enrollments (EnrollmentType = 'SystemFee')
 * - PaymentProcessingFee enrollments (EnrollmentType = 'PaymentProcessingFee')
 * - SetupFee enrollments (EnrollmentType = 'SetupFee')
 * 
 * Note: This GUID must exist in oe.Products table (created as a placeholder product)
 * to satisfy the foreign key constraint. The EnrollmentType field distinguishes
 * between different non-product enrollment types.
 */
export const ALL_PRODUCTS_GUID = '00000000-0000-0000-0000-000000000000';

/**
 * Check if an enrollment is a product enrollment (not a fee or contribution)
 */
export const isProductEnrollment = (enrollmentType?: string | null): boolean => {
  return !enrollmentType || enrollmentType === EnrollmentType.PRODUCT;
};

/**
 * Check if an enrollment is a contribution enrollment
 */
export const isContributionEnrollment = (enrollmentType?: string | null): boolean => {
  return enrollmentType === EnrollmentType.CONTRIBUTION;
};

/**
 * Check if an enrollment is a fee enrollment (processing fee, system fee, etc.)
 */
export const isFeeEnrollment = (enrollmentType?: string | null): boolean => {
  return enrollmentType === EnrollmentType.PAYMENT_PROCESSING_FEE ||
         enrollmentType === EnrollmentType.PROCESSING_FEE ||
         enrollmentType === EnrollmentType.SYSTEM_FEE ||
         enrollmentType === EnrollmentType.SETUP_FEE;
};

