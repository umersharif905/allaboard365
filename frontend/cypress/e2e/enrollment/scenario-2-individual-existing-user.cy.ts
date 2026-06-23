// Cypress E2E — Scenario 2: Static Individual link for a pre-existing User
// (Plan Phase 2).
//
// Pre-state: oe.Users row exists (e.g. an Agent account) but NO oe.Members
// row in this tenant. Expected behaviour:
//   - existingUserQuery (enrollment-links.js:4110-4125) hits → UserId reused.
//   - A NEW oe.Members row is created in tenant scope with existing UserId.
//   - oe.Users.PasswordHash is NOT overwritten (critical security invariant).
//   - If the user already has a password, password setup is skipped/reset-flow.
//
// Full walkthrough requires the deferred wizard driver + seed endpoint.

import type { Interception } from 'cypress/types/net-stubbing';

describe('Scenario 2 — existing user, new member', () => {
  beforeEach(() => {
    cy.stubEnrollmentLink('validAgentStatic');
    cy.stubEnrollmentStatus('incomplete');
    cy.stubEnrollmentDataWithProduct();
    cy.stubProductPricing();
    cy.stubTenantRedirect();
    cy.stubSendVerificationCode('success');
    cy.stubCompleteEnrollment('success');
  });

  it('2A ACH — existing user → submits with paymentMethodType=ACH', () => {
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
      expect(interception.request.body.memberInfo?.email).to.exist;
      expect(interception.response?.statusCode).to.equal(200);
    });
  });

  it('2B Card — existing user → submits with paymentMethodType=Card', () => {
    cy.visitEnrollmentLink('enroll_test_agentstatic_001');
    cy.waitForWizardReady();
    cy.dismissWelcomeScreen();
    cy.driveWizardGetStartedAutofill();
    cy.driveWizardHouseholdAutofill();
    cy.driveWizardSelectFirstProduct();
    cy.driveWizardEffectiveDateContinue();
    cy.driveWizardPaymentPrefill('Card');
    cy.driveWizardAcknowledgementsAutofill();
    cy.driveWizardSubmit();

    cy.wait('@completeEnrollment').then((interception: Interception) => {
      expect(interception.request.body.paymentMethod?.paymentMethodType).to.equal('Card');
      expect(interception.request.body.memberInfo?.email).to.exist;
      expect(interception.response?.statusCode).to.equal(200);
    });
  });

  // NOTE: 2A-i (cross-tenant existing user) and 2A-ii (deleted user) are
  // backend-only behaviours — the wizard walkthrough is identical. These
  // live as backend Jest tests where the DB state can be asserted.
});

describe('Scenario 2 — smoke', () => {
  it('wizard mounts for a valid Agent-Static link (pre-existing user flow entry point)', () => {
    cy.stubEnrollmentLink('validAgentStatic');
    cy.stubEnrollmentStatus('incomplete');
    cy.stubEnrollmentData();
    cy.stubTenantRedirect();

    cy.visitEnrollmentLink('enroll_test_agentstatic_001');
    cy.wait('@getEnrollmentLink');
    cy.waitForWizardReady();
  });
});
