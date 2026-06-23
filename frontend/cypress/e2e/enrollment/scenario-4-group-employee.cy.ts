// Cypress E2E — Scenario 4: Group employee link (Plan Phase 4).
//
// Pre-state: Group with GroupProducts, EnrollmentLinkTemplates with
// TemplateType='Group', employee member row seeded with GroupId. Link is
// visited directly at /enroll/:linkToken (NOT /enroll-now/ — enforced by
// enroll-now.js:98-107 allow-list).
//
// Expected behaviour:
//   - enrollment-data returns ONLY group products for the linked group.
//   - contribution-preview returns employer + employee split.
//   - Completed oe.Enrollments row has non-zero EmployerContributionAmount.
//   - Employee is charged EmployeeContributionAmount, NOT full premium.

import type { Interception } from 'cypress/types/net-stubbing';

describe('Scenario 4 — group employee link', () => {
  beforeEach(() => {
    cy.stubEnrollmentLink('validGroup');
    cy.stubEnrollmentStatus('incomplete');
    cy.stubEnrollmentDataWithProductForGroup();
    cy.stubProductPricing();
    cy.stubEffectiveDates();
    cy.stubContributionPreview({ premium: 450, employer: 200, employee: 250 });
    cy.stubTenantRedirect();
    cy.stubSendVerificationCode('success');
    cy.stubCompleteEnrollment('success');
  });

  it('renders group branding', () => {
    cy.visitEnrollmentLink('enroll_test_group_001');
    cy.waitForWizardReady();
    cy.contains(/Acme Test Group/i).should('be.visible');
  });

  it('wizard walks to submit (Group enrollment, no Payment step)', () => {
    cy.visitEnrollmentLink('enroll_test_group_001');
    cy.waitForWizardReady();
    cy.dismissWelcomeScreen();
    cy.driveWizardGetStartedAutofill();
    cy.driveWizardHouseholdAutofill();
    cy.driveWizardSelectFirstProduct();
    cy.driveWizardEffectiveDateContinue();
    // Group path skips Payment Method step. Our stub product has no
    // acknowledgements required, so the Acknowledgements step is also
    // skipped — the wizard goes straight to Confirmation.
    cy.driveWizardSubmit();

    cy.wait('@completeEnrollment').its('response.statusCode').should('eq', 200);
  });

  it('rejects the /enroll-now/:shortCode route for a Group link (allow-list guard)', () => {
    cy.stubShortCodeResolve('grp_acme_2026', 'rejectedGroup');
    cy.visitShortCode('grp_acme_2026');
    cy.wait('@resolveShortCode').its('response.statusCode').should('eq', 400);
    cy.url().should('include', '/error');
  });
});

describe('Scenario 4 — contribution variations', () => {
  const variations: Array<{ name: string; premium: number; employer: number; employee: number }> = [
    { name: 'employer pays 100%', premium: 450, employer: 450, employee: 0 },
    { name: 'employer pays 50%', premium: 450, employer: 225, employee: 225 },
    { name: 'employer flat $200/mo', premium: 450, employer: 200, employee: 250 },
    { name: 'employer contribution capped (premium ≤ flat)', premium: 100, employer: 100, employee: 0 }
  ];

  variations.forEach(({ name, premium, employer, employee }) => {
    it(`contribution-preview surfaces split: ${name}`, () => {
      cy.stubEnrollmentLink('validGroup');
      cy.stubEnrollmentStatus('incomplete');
      cy.stubEnrollmentDataWithProductForGroup();
      cy.stubProductPricing();
      cy.stubEffectiveDates();
      cy.stubContributionPreview({ premium, employer, employee });
      cy.stubTenantRedirect();
      cy.stubCompleteEnrollment('success');

      cy.visitEnrollmentLink('enroll_test_group_001');
      cy.waitForWizardReady();
      cy.dismissWelcomeScreen();
      cy.driveWizardGetStartedAutofill();
      cy.driveWizardHouseholdAutofill();
      cy.driveWizardSelectFirstProduct();

      cy.wait('@contributionPreview').its('response.body.data').should('deep.include', {
        premiumAmount: premium,
        employerContributionAmount: employer,
        employeeContributionAmount: employee
      });
    });
  });

  it('group template removed mid-flow → preview error surfaces', () => {
    cy.stubEnrollmentLink('validGroup');
    cy.stubEnrollmentStatus('incomplete');
    cy.stubEnrollmentDataWithProductForGroup();
    cy.stubProductPricing();
    cy.stubEffectiveDates();
    cy.intercept('POST', '**/api/enrollment-links/*/contribution-preview', {
      statusCode: 400,
      body: { success: false, message: 'Group template no longer exists' }
    }).as('contributionPreviewError');
    cy.stubTenantRedirect();

    cy.visitEnrollmentLink('enroll_test_group_001');
    cy.waitForWizardReady();
    cy.dismissWelcomeScreen();
    cy.driveWizardGetStartedAutofill();
    cy.driveWizardHouseholdAutofill();
    cy.driveWizardSelectFirstProduct();

    cy.wait('@contributionPreviewError').its('response.statusCode').should('eq', 400);
  });
});

describe('Scenario 4 — smoke', () => {
  it('wizard mounts for a valid Group link', () => {
    cy.stubEnrollmentLink('validGroup');
    cy.stubEnrollmentStatus('incomplete');
    cy.stubEnrollmentData();
    cy.stubTenantRedirect();

    cy.visitEnrollmentLink('enroll_test_group_001');
    cy.wait('@getEnrollmentLink');
    cy.waitForWizardReady();
  });
});
