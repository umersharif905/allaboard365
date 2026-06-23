describe('Step 3 Configuration Fields', () => {
  beforeEach(() => {
    cy.loginAsRole('SysAdmin');
  });

  it('should render configuration fields on wizard step 4', () => {
    cy.navigateAddProductWizardToConfigurationStep();
    cy.get('[data-testid="step3-configuration-fields"]').should('be.visible');
  });
});
