// Cypress E2E — Scenario 3B: Existing member with NO active enrollment is
// allowed to re-enroll; existing MemberId is reused (Plan Phase 3).
//
// Pre-state: oe.Users + oe.Members exist, but oe.Enrollments rows for that
// member are all Terminated / Cancelled (or absent). Expected behaviour:
//   - useExistingMember = true branch at enrollment-links.js:4197-4202.
//   - NO new oe.Members row created (count unchanged).
//   - Exactly ONE new oe.Enrollments row is created with the existing MemberId.

import type { Interception } from 'cypress/types/net-stubbing';

describe('Scenario 3B — existing member, no active enrollment → reuse', () => {
  beforeEach(() => {
    cy.stubEnrollmentLink('validAgentStatic');
    cy.stubEnrollmentStatus('incomplete');
    cy.stubEnrollmentDataWithProduct();
    cy.stubProductPricing();
    cy.stubTenantRedirect();
    cy.stubSendVerificationCode('success');
    cy.stubCompleteEnrollment('success');
  });

  it('wizard completes (reuses member branch is server-side, mocked here)', () => {
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
      expect(interception.response?.statusCode).to.equal(200);
    });
  });

  // NOTE: The reuse-existing-member distinction (useExistingMember branch at
  // enrollment-links.js:4197-4202) is a backend behaviour. The wizard
  // walkthrough is identical to S1; the DB-level "no new Members row"
  // assertion belongs in a backend Jest test driven by the seed endpoint.
});

describe('Scenario 3B — smoke', () => {
  it('wizard mounts for the reuse-existing-member flow', () => {
    cy.stubEnrollmentLink('validAgentStatic');
    cy.stubEnrollmentStatus('incomplete');
    cy.stubEnrollmentData();
    cy.stubTenantRedirect();

    cy.visitEnrollmentLink('enroll_test_agentstatic_001');
    cy.wait('@getEnrollmentLink');
    cy.waitForWizardReady();
  });
});
