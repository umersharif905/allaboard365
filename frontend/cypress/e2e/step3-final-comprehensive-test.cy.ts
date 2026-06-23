describe('Step 3 Configuration Fields', () => {
  beforeEach(() => {
    cy.loginAsRole('SysAdmin');
  });

  it('should render configuration fields on wizard step 4', () => {
    cy.navigateAddProductWizardToConfigurationStep();
    cy.get('[data-testid="step3-configuration-fields"]').should('be.visible');
    cy.get('[data-testid="add-field-button"]').should('be.visible');
  });

  it('should add a field and an option', () => {
    cy.navigateAddProductWizardToConfigurationStep();
    cy.get('[data-testid="add-field-button"]').click();
    cy.get('[data-testid="field-name-input"]').type('Deductible');
    cy.get('[data-testid="configuration-fields-container"]').should('be.visible');
    cy.get('[data-testid="add-option-button"]').click();
  });
});
