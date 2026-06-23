// Cypress E2E — Scenario 3A: Existing member with an active enrollment is
// blocked from re-enrolling (Plan Phase 3).
//
// As of 2026-05-07 the pre-enrollment send-verification-code route was
// removed and replaced with a post-enrollment verify step. The block path
// for "already enrolled" is now exercised at the complete-enrollment seam.

import type { Interception } from 'cypress/types/net-stubbing';

describe('Scenario 3A — existing member blocked (complete-enrollment path)', () => {
  beforeEach(() => {
    cy.stubEnrollmentLink('validAgentStatic');
    cy.stubEnrollmentStatus('incomplete');
    cy.stubEnrollmentDataWithProduct();
    cy.stubProductPricing();
    cy.stubTenantRedirect();
    cy.stubSendVerificationCode('success');
  });

  it('complete-enrollment returns 400 DUPLICATE_MEMBER → response surfaces the error', () => {
    cy.stubCompleteEnrollment('duplicateMember');

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
      expect(interception.response?.statusCode).to.equal(400);
      expect(interception.response?.body?.error?.code).to.equal('DUPLICATE_MEMBER');
    });
  });

  it('complete-enrollment returns 400 MEMBER_IN_GROUP → response surfaces the group error', () => {
    cy.stubCompleteEnrollment('memberInGroup');

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
      expect(interception.response?.statusCode).to.equal(400);
      expect(interception.response?.body?.error?.code).to.equal('MEMBER_IN_GROUP');
    });
  });
});

describe('Scenario 3A — fixture wire-up smoke', () => {
  it('mounts the wizard with existing-member stubs primed', () => {
    cy.stubEnrollmentLink('validAgentStatic');
    cy.stubEnrollmentStatus('incomplete');
    cy.stubEnrollmentData();
    cy.stubTenantRedirect();
    cy.stubCompleteEnrollment('duplicateMember');

    cy.visitEnrollmentLink('enroll_test_agentstatic_001');
    cy.wait('@getEnrollmentLink');
    cy.waitForWizardReady();
  });
});
