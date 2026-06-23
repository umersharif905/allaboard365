// Cypress E2E — Dependents variations (Plan Phase 5).
// Covers the 10 dependent cases listed in the plan. Each test drives the
// wizard to the Household / Dependents step then asserts tier derivation,
// pricing recalc, and validation blocking. Requires deferred wizard driver.

describe('Dependents matrix — EE tier (no dependents baseline)', () => {
  beforeEach(() => {
    cy.stubEnrollmentLink('validAgentStatic');
    cy.stubEnrollmentStatus('incomplete');
    cy.stubEnrollmentDataWithProduct();
    cy.stubProductPricing();
    cy.stubTenantRedirect();
    cy.stubSendVerificationCode('success');
    cy.stubCompleteEnrollment('success');
  });

  it('EE — no dependents → submit body has memberTier=EE', () => {
    cy.visitEnrollmentLink('enroll_test_agentstatic_001');
    cy.waitForWizardReady();
    cy.dismissWelcomeScreen();
    cy.driveWizardGetStartedAutofill();
    cy.driveWizardHouseholdAutofill(); // children=0, no spouse
    cy.driveWizardSelectFirstProduct();
    cy.driveWizardEffectiveDateContinue();
    cy.driveWizardPaymentPrefill('Card');
    cy.driveWizardAcknowledgementsAutofill();
    cy.driveWizardSubmit();

    cy.wait('@completeEnrollment')
      .its('request.body.memberTier')
      .should('eq', 'EE');
  });
});

// NOTE: ES / EC / EC-multi / EF tier walkthroughs require driving the
// Dependents step (Has Spouse select + per-dependent first/last/DOB/gender
// inputs), which need their own test-ids. Scaffolded below until those land.
describe.skip('Dependents matrix — ES / EC / EF (needs dependents-step test-ids)', () => {
  beforeEach(() => {
    cy.stubEnrollmentLink('validAgentStatic');
    cy.stubEnrollmentStatus('incomplete');
    cy.stubEnrollmentDataWithProduct();
    cy.stubProductPricing();
    cy.stubTenantRedirect();
    cy.stubSendVerificationCode('success');
    cy.stubCompleteEnrollment('success');
  });

  it('ES — spouse only → tier=ES', () => {
    throw new Error('spouse test-ids: not implemented');
  });

  it('EC — 1 child → tier=EC', () => {
    throw new Error('dependent-row test-ids: not implemented');
  });

  it('EC (multi) — 3 children → tier=EC with correct count', () => {
    throw new Error('dependent-row test-ids: not implemented');
  });

  it('EF — spouse + 2 children → tier=EF', () => {
    throw new Error('spouse + dependent-row test-ids: not implemented');
  });
});

describe.skip('Dependents edge cases (requires wizard driver)', () => {
  beforeEach(() => {
    cy.stubEnrollmentLink('validAgentStatic');
    cy.stubEnrollmentStatus('incomplete');
    cy.stubEnrollmentData();
    cy.stubTenantRedirect();
    cy.stubSendVerificationCode('success');
    cy.stubCompleteEnrollment('success');
  });

  it('future DOB → inline validation error, submit blocked (EnrollmentWizard.tsx:3620-3634)', () => {
    cy.visitEnrollmentLink('enroll_test_agentstatic_001');
    throw new Error('addDependentWithFutureDob: not implemented');
    // eslint-disable-next-line @typescript-eslint/no-unreachable
    cy.contains(/Date of birth|future/i).should('be.visible');
    cy.get('@completeEnrollment.all').should('have.length', 0);
  });

  it('missing required field (first name / last name / DOB / gender) → submit blocked', () => {
    cy.visitEnrollmentLink('enroll_test_agentstatic_001');
    throw new Error('addDependentMissingField: not implemented');
  });

  it('requiresSSN flag on + spouse without SSN → submit blocked', () => {
    cy.stubEnrollmentData({
      data: {
        tenant: { TenantId: 't', TenantName: 'Test' },
        requiresSSN: true,
        products: [],
        productSections: [],
        bundles: [],
        effectiveDates: ['2026-05-01'],
        householdMembers: []
      }
    });
    cy.visitEnrollmentLink('enroll_test_agentstatic_001');
    throw new Error('addSpouseWithoutSsn: not implemented');
  });

  it('remove-and-re-add → tier does not stick on previous value', () => {
    cy.visitEnrollmentLink('enroll_test_agentstatic_001');
    throw new Error('removeAndReAddDependent: not implemented');
  });

  it('name + DOB collision (same first + DOB, different last) → both persist as separate dependents', () => {
    // Regression guard against enrollment-links.js:4919-4936 scope.
    cy.visitEnrollmentLink('enroll_test_agentstatic_001');
    throw new Error('addCollidingDependents: not implemented');
  });
});

describe('Dependents — smoke', () => {
  beforeEach(() => {
    cy.clearCookies();
    cy.clearLocalStorage();
    cy.stubEnrollmentLink('validAgentStatic');
    cy.stubEnrollmentStatus('incomplete');
    cy.stubEnrollmentData();
    cy.stubTenantRedirect();
  });

  it('wizard mounts (entry point for dependents tests)', () => {
    cy.visitEnrollmentLink('enroll_test_agentstatic_001');
    cy.wait('@getEnrollmentLink');
    cy.waitForWizardReady();
  });
});
