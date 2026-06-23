describe('Add Product Button', () => {
  beforeEach(() => {
    cy.loginAsRole('SysAdmin');
  });

  it('shows enabled Add Product button on marketplace', () => {
    cy.visit('/admin/marketplace');
    cy.contains('Product Marketplace').should('be.visible');
    cy.contains('button', /Add.*Product/i).should('not.be.disabled');
  });

  it('opens add product wizard when clicked', () => {
    cy.openMarketplaceAddProductWizard();
    cy.contains('h3', 'Select Vendor').should('be.visible');
  });
});
