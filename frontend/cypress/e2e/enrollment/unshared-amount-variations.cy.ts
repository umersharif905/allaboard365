// Cypress E2E — Unshared Amount variations (Plan Phase 6).
// The bundle product exposes a config dropdown with `config_6000`,
// `config_3000`, `config_1500`. Expected monthly display (per the existing
// spec knowledge): $378 / $408 / $453 at EE tier.
//
// Full matrix is 3 configs × 4 tiers = 12 combinations; see the 12-combo
// describe.skip below. Requires deferred wizard driver.

describe.skip('Unshared amount — config switching (requires wizard driver)', () => {
  beforeEach(() => {
    cy.stubEnrollmentLink('validAgentStatic');
    cy.stubEnrollmentStatus('incomplete');
    cy.stubEnrollmentData();
    cy.stubTenantRedirect();
    cy.stubSendVerificationCode('success');
    cy.stubCompleteEnrollment('success');
  });

  it('renders config_6000 / config_3000 / config_1500 options in the bundle select', () => {
    cy.visitEnrollmentLink('enroll_test_agentstatic_001');
    throw new Error('driveWizardToProductsStep: not implemented');
  });

  it('switching config updates monthly pricing ($378 / $408 / $453 at EE)', () => {
    const expected = [
      { config: 'config_6000', price: '$378' },
      { config: 'config_3000', price: '$408' },
      { config: 'config_1500', price: '$453' }
    ];
    cy.visitEnrollmentLink('enroll_test_agentstatic_001');
    throw new Error('driveWizardToProductsStep + selectConfig: not implemented');
    // eslint-disable-next-line @typescript-eslint/no-unreachable
    expected.forEach(({ config, price }) => {
      cy.get('select').select(config);
      cy.contains(price).should('be.visible');
    });
  });

  it('config persists when stepping back then forward', () => {
    cy.visitEnrollmentLink('enroll_test_agentstatic_001');
    throw new Error('driveWizardBackForward: not implemented');
  });

  it('multiple-product config selection works independently per product', () => {
    cy.visitEnrollmentLink('enroll_test_agentstatic_001');
    throw new Error('driveWizardMultiProduct: not implemented');
  });

  it('acknowledgements PDF reflects selected config', () => {
    cy.visitEnrollmentLink('enroll_test_agentstatic_001');
    throw new Error('driveWizardToAcknowledgements: not implemented');
  });
});

describe.skip('Unshared amount — 12-combo matrix (3 configs × 4 tiers)', () => {
  beforeEach(() => {
    cy.stubEnrollmentLink('validAgentStatic');
    cy.stubEnrollmentStatus('incomplete');
    cy.stubEnrollmentData();
    cy.stubTenantRedirect();
    cy.stubSendVerificationCode('success');
    cy.stubCompleteEnrollment('success');
  });

  const configs = ['config_6000', 'config_3000', 'config_1500'];
  const tiers = ['EE', 'ES', 'EC', 'EF'] as const;

  configs.forEach((config) => {
    tiers.forEach((tier) => {
      it(`${config} × ${tier} — pricing recalculates using both tier and config`, () => {
        cy.visitEnrollmentLink('enroll_test_agentstatic_001');
        throw new Error(`driveWizardForConfigAndTier(${config}, ${tier}): not implemented`);
      });
    });
  });
});

describe('Unshared amount — smoke', () => {
  it('wizard mounts (entry point for unshared-amount tests)', () => {
    cy.stubEnrollmentLink('validAgentStatic');
    cy.stubEnrollmentStatus('incomplete');
    cy.stubEnrollmentData();
    cy.stubTenantRedirect();

    cy.visitEnrollmentLink('enroll_test_agentstatic_001');
    cy.wait('@getEnrollmentLink');
    cy.waitForWizardReady();
  });
});
