describe('Part Number Field', () => {
  beforeEach(() => {
    cy.loginAsRole('SysAdmin');
  });

  it('loads marketplace where product details are managed', () => {
    cy.visit('/admin/marketplace');
    cy.contains('Product Marketplace').should('be.visible');
  });

  it('opens add product wizard basic details step', () => {
    cy.openMarketplaceAddProductWizard();
    cy.get('.flex.items-center.justify-center.mb-8 .flex.flex-col.items-center')
      .eq(1)
      .find('button')
      .click();
    cy.contains('label', 'Product Name').should('be.visible');
  });
});
