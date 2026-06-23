// Cypress E2E — Scenario 1: Static Individual link for a new member
// (Plan Phase 2, Scenarios 1A ACH and 1B Card).
//
// Full wizard walkthrough requires the deferred `data-testid` pass +
// dev-only seed endpoint. Contract assertions live inside `describe.skip`
// so CI stays green until those land; a smoke test verifies the wizard
// mounts and lifecycle guards don't trip for a valid link.

import type { Interception } from 'cypress/types/net-stubbing';

describe('Scenario 1A — new member, ACH', () => {
  beforeEach(() => {
    cy.stubEnrollmentLink('validAgentStatic');
    cy.stubEnrollmentStatus('incomplete');
    cy.stubEnrollmentDataWithProduct();
    cy.stubProductPricing();
    cy.stubTenantRedirect();
    cy.stubSendVerificationCode('success');
    cy.stubCompleteEnrollment('success');
  });

  it('walks wizard → submits with paymentMethodType=ACH', () => {
    cy.visitEnrollmentLink('enroll_test_agentstatic_001');
    cy.waitForWizardReady();
    cy.dismissWelcomeScreen();
    cy.driveWizardGetStartedAutofill();
    cy.driveWizardHouseholdAutofill();
    cy.driveWizardSelectFirstProduct();
    cy.driveWizardEffectiveDateContinue();
    cy.driveWizardPaymentPrefill('ACH');
    cy.driveWizardAcknowledgementsAutofill();
    cy.driveWizardSubmit();

    cy.wait('@completeEnrollment').then((interception: Interception) => {
      expect(interception.request.body.paymentMethod?.paymentMethodType).to.equal('ACH');
    });
  });
});

describe('Scenario 1B — new member, Credit Card', () => {
  beforeEach(() => {
    cy.stubEnrollmentLink('validAgentStatic');
    cy.stubEnrollmentStatus('incomplete');
    cy.stubEnrollmentDataWithProduct();
    cy.stubProductPricing();
    cy.stubTenantRedirect();
    cy.stubSendVerificationCode('success');
    cy.stubCompleteEnrollment('success');
  });

  it('walks wizard → submits with paymentMethodType=Card', () => {
    cy.visitEnrollmentLink('enroll_test_agentstatic_001');
    cy.waitForWizardReady();
    cy.dismissWelcomeScreen();
    cy.driveWizardGetStartedAutofill();
    cy.driveWizardHouseholdAutofill();
    cy.driveWizardSelectFirstProduct();
    cy.driveWizardEffectiveDateContinue();
    cy.driveWizardPaymentPrefill();
    cy.driveWizardAcknowledgementsAutofill();
    cy.driveWizardSubmit();

    cy.wait('@completeEnrollment').then((interception: Interception) => {
      expect(interception.request.body.paymentMethod?.paymentMethodType).to.equal('Card');
    });
  });
});

// Smoke test that DOES run.
describe('Scenario 1 — wizard mount smoke', () => {
  beforeEach(() => {
    cy.stubEnrollmentLink('validAgentStatic');
    cy.stubEnrollmentStatus('incomplete');
    cy.stubEnrollmentData();
    cy.stubTenantRedirect();
  });

  it('loads the wizard for a valid Agent-Static link', () => {
    cy.visitEnrollmentLink('enroll_test_agentstatic_001');
    cy.wait('@getEnrollmentLink');
    cy.waitForWizardReady();
  });

  it('does not show a lifecycle guard page for a valid link', () => {
    cy.visitEnrollmentLink('enroll_test_agentstatic_001');
    cy.contains(/Invalid Enrollment Link/i).should('not.exist');
    cy.contains(/Enrollment Link Expired/i).should('not.exist');
    cy.contains(/Enrollment Link Inactive/i).should('not.exist');
  });
});
