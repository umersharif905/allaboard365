// Cypress E2E — Tier ↔ Dependents contract (stub-driven).
//
// Drives the public wizard (`/enroll/:linkToken`) through every step —
// including the Dependents step for ES / EC / EF — and asserts the
// `complete-enrollment` request body. Uses `cy.intercept` stubs; no
// backend required beyond the Vite dev server on :5173.
//
// Paired spec `tier-dependent-real-backend.cy.ts` runs the same wizard
// against the real backend to catch bugs #1 and #2 from
// `docs/enrollments/tier-dependents-bug-investigation.md`.

import type { Interception } from 'cypress/types/net-stubbing';

const LINK_TOKEN = 'enroll_test_agentstatic_001';

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function stubTierSuiteCommon() {
  cy.clearCookies();
  cy.clearLocalStorage();
  cy.stubEnrollmentLink('validAgentStatic');
  cy.stubEnrollmentStatus('incomplete');
  cy.stubEnrollmentDataWithProduct();
  cy.stubProductPricing();
  cy.stubTenantRedirect();
  cy.stubSendVerificationCode('success');
  cy.stubCompleteEnrollment('success');
}

/** Household step: Include-your-spouse select (no test-id yet). */
function setHasSpouse(value: 'Y' | 'N') {
  cy.contains('label', /Include your spouse\?/i)
    .parent()
    .find('select')
    .select(value);
}

/**
 * Drive Get Started + Household with the requested composition. After
 * this runs, the wizard advances to the Product Selection step (step 3 of
 * the wizard's post-welcome flow).
 */
function driveThroughHousehold(opts: { hasSpouse: 'Y' | 'N'; childrenCount: number }) {
  cy.visitEnrollmentLink(LINK_TOKEN);
  cy.waitForWizardReady();
  cy.dismissWelcomeScreen();
  cy.driveWizardGetStartedAutofill();

  cy.get('[data-testid="household-autofill-btn"]').click();
  setHasSpouse(opts.hasSpouse);
  cy.get('[data-testid="household-children-count"]').select(String(opts.childrenCount));
  cy.get('[data-testid="household-continue-btn"]').should('be.enabled').click();
}

interface DependentFill {
  firstName: string;
  lastName: string;
  dateOfBirth: string;          // yyyy-mm-dd
  gender: 'Male' | 'Female';
  email?: string;               // spouses only
}

/**
 * Fill a single dependent row on the Dependents step. Targets the HTML
 * ids wired at EnrollmentWizard.tsx:7441-7521 (`#dependent-firstName-N`,
 * etc.). No `data-testid` attributes are needed — plain CSS ids work.
 */
function fillDependentRow(index: number, data: DependentFill) {
  cy.get(`#dependent-firstName-${index}`).clear().type(data.firstName);
  cy.get(`#dependent-lastName-${index}`).clear().type(data.lastName);
  cy.get(`#dependent-dob-${index}`).clear().type(data.dateOfBirth);
  cy.get(`#dependent-gender-${index}`).select(data.gender);
  if (data.email) {
    cy.get(`#dependent-email-${index}`).clear().type(data.email);
  }
}

/**
 * After Product Selection and Dependents steps, advance through Effective
 * Date → Payment → Acknowledgements → Submit.
 */
function finishWizardWithPayment() {
  cy.driveWizardEffectiveDateContinue();
  cy.driveWizardPaymentPrefill('Card');
  cy.driveWizardAcknowledgementsAutofill();
  cy.driveWizardSubmit();
}

// -----------------------------------------------------------------------
// Live tests — full wizard drive, assert the submit payload
// -----------------------------------------------------------------------

describe('Tier ↔ dependents — submit payload reflects household composition', () => {
  beforeEach(stubTierSuiteCommon);

  it('EE — no spouse, 0 children → memberTier=EE, dependents=[]', () => {
    driveThroughHousehold({ hasSpouse: 'N', childrenCount: 0 });
    cy.driveWizardSelectFirstProduct();
    // No Dependents step renders when the household has no dependents
    // (householdMembers array is empty; line 7566 shows the empty state).
    finishWizardWithPayment();

    cy.wait('@completeEnrollment').then(({ request }: Interception) => {
      expect(request.body.memberTier).to.eq('EE');
      const deps = request.body.dependents ?? request.body.householdMembers ?? [];
      expect(deps).to.have.length(0);
    });
  });

  it('ES — spouse=Yes, children=0 → memberTier=ES, 1 spouse in dependents', () => {
    driveThroughHousehold({ hasSpouse: 'Y', childrenCount: 0 });
    cy.driveWizardSelectFirstProduct();

    // Dependents step: 1 spouse row (index 0).
    fillDependentRow(0, {
      firstName: 'Jane',
      lastName: 'Doe',
      dateOfBirth: '1990-04-01',
      gender: 'Female',
      email: 'jane.doe+cypress@test.local'
    });
    cy.get('[data-testid="dependents-continue-btn"]').should('be.enabled').click();

    finishWizardWithPayment();

    cy.wait('@completeEnrollment').then(({ request }: Interception) => {
      expect(request.body.memberTier).to.eq('ES');
      const deps: any[] = request.body.dependents ?? request.body.householdMembers ?? [];
      expect(deps).to.have.length(1);
      expect(String(deps[0].relationshipType || deps[0].relationship)).to.match(/^S$|^Spouse$/);
      expect(deps[0].firstName).to.eq('Jane');
      expect(deps[0].lastName).to.eq('Doe');
      expect(deps[0].dateOfBirth).to.eq('1990-04-01');
    });
  });

  it('EC — spouse=No, children=2 → memberTier=EC, 2 children in dependents', () => {
    driveThroughHousehold({ hasSpouse: 'N', childrenCount: 2 });
    cy.driveWizardSelectFirstProduct();

    // Dependents step: 2 child rows (indexes 0, 1). The useEffect at
    // EnrollmentWizard.tsx:2077-2135 syncs householdMembers to match
    // childrenCount, creating empty child records we then fill.
    fillDependentRow(0, {
      firstName: 'Charlie',
      lastName: 'Child',
      dateOfBirth: '2015-05-15',
      gender: 'Male'
    });
    fillDependentRow(1, {
      firstName: 'Dana',
      lastName: 'Child',
      dateOfBirth: '2017-08-20',
      gender: 'Female'
    });
    cy.get('[data-testid="dependents-continue-btn"]').should('be.enabled').click();

    finishWizardWithPayment();

    cy.wait('@completeEnrollment').then(({ request }: Interception) => {
      expect(request.body.memberTier).to.eq('EC');
      const deps: any[] = request.body.dependents ?? request.body.householdMembers ?? [];
      expect(deps).to.have.length(2);
      deps.forEach((dep) => {
        expect(String(dep.relationshipType || dep.relationship)).to.match(/^C$|^Child$/);
      });
    });
  });

  it('EF — spouse=Yes, children=1 → memberTier=EF, spouse+child in dependents', () => {
    driveThroughHousehold({ hasSpouse: 'Y', childrenCount: 1 });
    cy.driveWizardSelectFirstProduct();

    // Spouse is always rendered first (line 2100-2113) so index 0 is
    // spouse, index 1 is the child.
    fillDependentRow(0, {
      firstName: 'Jamie',
      lastName: 'Spouse',
      dateOfBirth: '1988-02-14',
      gender: 'Female',
      email: 'jamie.spouse+cypress@test.local'
    });
    fillDependentRow(1, {
      firstName: 'River',
      lastName: 'Child',
      dateOfBirth: '2018-11-03',
      gender: 'Male'
    });
    cy.get('[data-testid="dependents-continue-btn"]').should('be.enabled').click();

    finishWizardWithPayment();

    cy.wait('@completeEnrollment').then(({ request }: Interception) => {
      expect(request.body.memberTier).to.eq('EF');
      const deps: any[] = request.body.dependents ?? request.body.householdMembers ?? [];
      expect(deps).to.have.length(2);
      const spouse = deps.find((d) => String(d.relationshipType || d.relationship).match(/^S$|^Spouse$/));
      const child  = deps.find((d) => String(d.relationshipType || d.relationship).match(/^C$|^Child$/));
      expect(spouse, 'EF payload must include a spouse').to.exist;
      expect(child,  'EF payload must include a child').to.exist;
    });
  });
});

// -----------------------------------------------------------------------
// Contract gaps — backend doesn't enforce tier ↔ dependent invariants
// today. Kept as `.skip` with explicit blockers so the coverage gap is
// visible. Each throws on unskip.
// -----------------------------------------------------------------------

describe.skip('Backend enforcement — tier ↔ dependent mismatch rejection (not shipped)', () => {
  beforeEach(() => {
    cy.clearCookies();
    cy.clearLocalStorage();
    cy.stubEnrollmentLink('validAgentStatic');
    cy.stubEnrollmentStatus('incomplete');
    cy.stubEnrollmentDataWithProduct();
    cy.stubProductPricing();
    cy.stubTenantRedirect();
    cy.stubSendVerificationCode('success');
    // Run against real backend — do NOT stub the submit response.
    cy.intercept('POST', '**/api/enrollment-links/*/complete-enrollment').as('completeEnrollment');
  });

  it('rejects ES with dependents=[] (400 TIER_MISMATCH_NO_SPOUSE)', () => {
    throw new Error('Backend validator not shipped. See doc Finding #3.');
  });

  it('rejects EC with dependents=[] (400 TIER_MISMATCH_NO_CHILDREN)', () => {
    throw new Error('Backend validator not shipped. See doc Finding #3.');
  });

  it('rejects EF with dependents=[spouse only] (400 TIER_MISMATCH_MISSING_CHILDREN)', () => {
    throw new Error('Backend validator not shipped. See doc Finding #3.');
  });

  it('rejects any dependent missing firstName / lastName / DOB / SSN (400 DEPENDENT_FIELDS_MISSING)', () => {
    // Today the gate at enrollment-links.js:4892 silently drops rows.
    throw new Error('Backend validator not shipped. See doc Finding #3.');
  });
});

// -----------------------------------------------------------------------
// Smoke — spec entry point
// -----------------------------------------------------------------------

describe('Tier ↔ dependents — smoke', () => {
  beforeEach(stubTierSuiteCommon);

  it('wizard mounts and reaches the Household step', () => {
    cy.visitEnrollmentLink(LINK_TOKEN);
    cy.waitForWizardReady();
    cy.dismissWelcomeScreen();
    cy.driveWizardGetStartedAutofill();
    cy.get('[data-testid="household-continue-btn"]').should('exist');
  });
});
