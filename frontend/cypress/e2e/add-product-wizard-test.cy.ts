describe('Add Product Wizard - Configuration Step', () => {
  beforeEach(() => {
    cy.loginAsRole('SysAdmin');
  });

  it('should open the wizard and reach the configuration fields step', () => {
    cy.navigateAddProductWizardToConfigurationStep();
    cy.get('[data-testid="step3-configuration-fields"]').should('be.visible');
    cy.contains('button', 'Add Configuration Field').should('be.visible');
  });

  it('should add a configuration field and option', () => {
    cy.navigateAddProductWizardToConfigurationStep();

    cy.get('[data-testid="add-field-button"]').click();
    cy.get('[data-testid="field-name-input"]').should('be.visible').type('Test Field');
    cy.get('[data-testid="configuration-fields-container"]').should('be.visible');
    cy.get('[data-testid="add-option-button"]').click();
  });
});
