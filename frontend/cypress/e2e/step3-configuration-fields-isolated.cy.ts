describe('Step 3 Configuration Fields (isolated)', () => {
  beforeEach(() => {
    cy.loginAsRole('SysAdmin');
  });

  it('should reach configuration fields step', () => {
    cy.navigateAddProductWizardToConfigurationStep();
    cy.get('[data-testid="step3-configuration-fields"]').should('be.visible');
  });
});
