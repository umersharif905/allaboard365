describe('Wizard State Test', () => {
  beforeEach(() => {
    cy.loginAsRole('SysAdmin');
  });

  it('jumps to configuration step via step indicator', () => {
    cy.navigateAddProductWizardToConfigurationStep();
    cy.contains('Step 4 of 13').should('be.visible');
  });
});
