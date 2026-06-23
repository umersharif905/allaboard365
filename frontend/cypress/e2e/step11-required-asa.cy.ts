describe('Step 12 Required ASA', () => {
  beforeEach(() => {
    cy.loginAsRole('SysAdmin');
    cy.openMarketplaceAddProductWizard();
    cy.get('.flex.items-center.justify-center.mb-8 .flex.flex-col.items-center')
      .eq(11)
      .find('button')
      .click();
  });

  it('shows required ASA agreement step', () => {
    cy.contains('Required ASA Agreement').should('be.visible');
    cy.contains('Step 12 of 13').should('be.visible');
  });
});
