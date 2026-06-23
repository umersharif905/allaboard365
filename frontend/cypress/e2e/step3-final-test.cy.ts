describe('Step 3 Configuration Fields', () => {
  beforeEach(() => {
    cy.loginAsRole('SysAdmin');
  });

  it('should reach configuration fields step', () => {
    cy.navigateAddProductWizardToConfigurationStep();
    cy.get('[data-testid="add-field-button"]').should('be.visible');
  });
});
