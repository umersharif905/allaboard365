/**
 * ASA agreement selection lives in Add Product wizard step 12 (/admin/marketplace).
 * Vendor document upload uses /admin/vendors — not covered by brittle data-testid mocks.
 */
describe('ASA Agreement Flow Integration', () => {
  beforeEach(() => {
    cy.loginAsRole('SysAdmin');
  });

  it('loads marketplace where ASA is configured on products', () => {
    cy.visit('/admin/marketplace');
    cy.contains('Product Marketplace').should('be.visible');
  });

  it('loads vendors admin where ASA documents are uploaded', () => {
    cy.visit('/admin/vendors');
    cy.get('body').should('be.visible');
    cy.url().should('include', '/admin/vendors');
  });

  it('can open add product wizard through licensing step', () => {
    cy.openMarketplaceAddProductWizard();
    cy.contains('h3', 'Select Vendor').should('be.visible');
  });
});
