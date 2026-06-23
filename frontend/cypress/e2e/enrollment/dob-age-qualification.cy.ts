/**
 * Enrollment wizard — DOB / age qualification for age-banded products (e.g. dental 18–64).
 * Mirrors prod incident: age 0 + GetWell Dental → PRICING_CALCULATION_FAILED.
 */

const ADULT_DOB = '1990-06-15';
const DENTAL_PRODUCT_ID = 'prod-test-dental-ageband-001';

function infantDobIso(): string {
  const d = new Date();
  d.setMonth(d.getMonth() - 3);
  return d.toISOString().split('T')[0];
}

function clickHouseholdContinue() {
  cy.contains('h2', 'Household Information').should('be.visible');
  cy.get('[data-testid="household-continue-btn"]')
    .scrollIntoView()
    .should('be.enabled')
    .click({ force: true });
}

describe('Enrollment wizard — DOB age qualification', () => {
  beforeEach(() => {
    cy.stubEnrollmentLink('validAgentStatic');
    cy.stubEnrollmentStatus('incomplete');
    cy.stubEnrollmentDataWithAgeBandedDental();
    cy.stubProductPricingForMemberAge();
    cy.stubTenantRedirect();
    cy.stubSendVerificationCode('success');
  });

  it('blocks Household Continue when DOB yields age 0 and shows age + DOB in modal', () => {
    const infantDob = infantDobIso();

    cy.visitEnrollmentLink('enroll_test_agentstatic_001');
    cy.waitForWizardReady();
    cy.dismissWelcomeScreen();

    cy.get('[data-testid="get-started-autofill-btn"]').click();
    cy.get('[data-testid="member-dob"]').clear().type(infantDob);
    cy.get('[data-testid="get-started-continue-btn"]').should('be.enabled').click();
    cy.wait('@getProductPricing');

    cy.driveWizardHouseholdAutofill();
    clickHouseholdContinue();

    cy.get('[data-testid="no-products-for-age-modal"]').should('be.visible');
    cy.contains('No products available for your age').should('be.visible');
    cy.contains(infantDob).should('be.visible');
    cy.contains('your age is 0').should('be.visible');
    cy.contains(/Re-enter your date of birth/i).should('be.visible');
  });

  it('Fix date of birth navigates to Get Started and adult DOB allows product selection', () => {
    const infantDob = infantDobIso();

    cy.visitEnrollmentLink('enroll_test_agentstatic_001');
    cy.waitForWizardReady();
    cy.dismissWelcomeScreen();

    cy.get('[data-testid="get-started-autofill-btn"]').click();
    cy.get('[data-testid="member-dob"]').clear().type(infantDob);
    cy.get('[data-testid="get-started-continue-btn"]').click();
    cy.wait('@getProductPricing');
    cy.driveWizardHouseholdAutofill();
    clickHouseholdContinue();

    cy.get('[data-testid="no-products-for-age-fix-dob-btn"]').click();
    cy.get('[data-testid="member-dob"]').clear().type(ADULT_DOB);
    cy.get('[data-testid="get-started-continue-btn"]').click();
    cy.wait('@getProductPricing');

    cy.driveWizardHouseholdAutofill();

    cy.get('[data-testid="no-products-for-age-modal"]').should('not.exist');
    cy.contains('Select Dental').should('be.visible');
    cy.get(`[data-testid="product-card-${DENTAL_PRODUCT_ID}"]`).should('be.visible');
  });

  it('shows Check your date of birth when submit returns PRICING_CALCULATION_FAILED', () => {
    cy.stubCompleteEnrollment('pricingCalculationFailed', 400);

    cy.visitEnrollmentLink('enroll_test_agentstatic_001');
    cy.waitForWizardReady();
    cy.dismissWelcomeScreen();
    cy.get('[data-testid="get-started-autofill-btn"]').click();
    cy.get('[data-testid="member-dob"]').clear().type(ADULT_DOB);
    cy.get('[data-testid="get-started-continue-btn"]').click();
    cy.wait('@getProductPricing');
    cy.driveWizardHouseholdAutofill();
    cy.get(`[data-testid="product-card-${DENTAL_PRODUCT_ID}"]`).should('be.visible').click();
    cy.get('[data-testid="product-section-continue-btn"]').click();
    cy.driveWizardEffectiveDateContinue();
    cy.driveWizardPaymentPrefill('Card');
    cy.driveWizardAcknowledgementsAutofill();
    cy.driveWizardSubmit();

    cy.contains(/Check your date of birth/i).should('be.visible');
    cy.contains(/Re-enter your date of birth/i).should('be.visible');
    cy.contains(ADULT_DOB).should('be.visible');
  });
});
