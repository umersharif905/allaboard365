// Cypress E2E — Group employee who already has a password (Andrew Wyatt pattern).
//
// Pre-state: Group member completed group-admin onboarding (password set),
// enrollment not yet submitted (isCompleted=false). Expected:
//   - Wizard loads after refresh (no "already completed" block).
//   - Group path skips payment; submit sends no paymentMethod.
//   - Failed submit (server rollback) does NOT block a clean retry after reload.
//   - Successful submit skips "Create a strong password" copy when password exists.

import type { Interception } from 'cypress/types/net-stubbing';

const GROUP_LINK = 'enroll_test_group_001';

function stubGroupEnrollmentBasics() {
  cy.stubEnrollmentLink('validGroup');
  cy.stubEnrollmentStatus('incompleteExistingPassword');
  cy.stubEnrollmentDataWithProductForGroup();
  cy.stubProductPricing();
  cy.stubEffectiveDates();
  cy.stubContributionPreview({ premium: 450, employer: 200, employee: 250 });
  cy.stubTenantRedirect();
  cy.stubSendVerificationCode('success');
}

function walkGroupToSubmit() {
  cy.dismissWelcomeScreen();
  cy.driveWizardGetStartedAutofill();
  cy.driveWizardHouseholdAutofill();
  cy.driveWizardSelectFirstProduct();
  cy.driveWizardEffectiveDateContinue();
}

describe('Group employee — existing password (Andrew pattern)', () => {
  beforeEach(() => {
    stubGroupEnrollmentBasics();
  });

  it('loads wizard after refresh when enrollment is still incomplete', () => {
    cy.visitEnrollmentLink(GROUP_LINK);
    cy.waitForWizardReady();
    cy.contains(/Acme Test Group/i).should('be.visible');

    cy.reload();
    cy.waitForWizardReady();
    cy.contains(/Acme Test Group/i).should('be.visible');
    cy.get('[data-testid="begin-enrollment-btn"]').should('be.visible');
  });

  it('submit succeeds without paymentMethod (group ListBill path)', () => {
    cy.stubCompleteEnrollment('success');

    cy.visitEnrollmentLink(GROUP_LINK);
    cy.waitForWizardReady();
    walkGroupToSubmit();
    cy.driveWizardSubmit();

    cy.wait('@completeEnrollment').then((interception: Interception) => {
      expect(interception.response?.statusCode).to.equal(200);
      expect(interception.request.body.paymentMethod).to.satisfy((v: unknown) => v == null);
      expect(interception.request.body.memberId).to.equal('member-test-001');
    });
  });

  it('after failed submit, refresh and retry succeeds (rollback / pending spinner recovery)', () => {
    let attempt = 0;
    cy.intercept('POST', '**/api/enrollment-links/*/complete-enrollment', (req) => {
      attempt += 1;
      if (attempt === 1) {
        req.reply({
          statusCode: 500,
          body: {
            success: false,
            message: 'Enrollment failed: Could not generate agreements PDF. This is required for compliance.'
          }
        });
      } else {
        req.reply({
          statusCode: 200,
          body: {
            success: true,
            data: {
              memberId: 'member-test-001',
              enrollments: [{ enrollmentId: 'enr-1', productId: 'prod-test-healthcare-001' }],
              effectiveDate: '2026-06-01'
            }
          }
        });
      }
    }).as('completeEnrollment');

    cy.visitEnrollmentLink(GROUP_LINK);
    cy.waitForWizardReady();
    walkGroupToSubmit();
    cy.driveWizardSubmit();
    cy.wait('@completeEnrollment').its('response.statusCode').should('eq', 500);

    // User refreshes while enrollment is still incomplete — must be able to try again.
    cy.reload();
    cy.waitForWizardReady();
    walkGroupToSubmit();
    cy.driveWizardSubmit();
    cy.wait('@completeEnrollment').its('response.statusCode').should('eq', 200);
    cy.get('@completeEnrollment.all').should('have.length', 2);
  });

  it('after successful submit, does not prompt to create a new password', () => {
    cy.stubCompleteEnrollment('success');

    cy.visitEnrollmentLink(GROUP_LINK);
    cy.waitForWizardReady();
    walkGroupToSubmit();
    cy.driveWizardSubmit();
    cy.wait('@completeEnrollment');

    // Existing-password users should not see first-time password setup copy.
    cy.contains('Create a strong password').should('not.exist');
    cy.contains(/You're enrolled!|Verify Your Email|Enrollment Complete!/i).should('be.visible');
  });
});
