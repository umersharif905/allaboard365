describe('Step 3 Configuration Fields', () => {
  beforeEach(() => {
    cy.loginAsRole('SysAdmin');
  });

  it('should navigate to configuration step via wizard', () => {
    cy.navigateAddProductWizardToConfigurationStep();
    cy.contains('Step 4 of 13').should('be.visible');
  });
});
