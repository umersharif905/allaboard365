describe('Admin Products API smoke', () => {
  beforeEach(() => {
    cy.loginAsRole('SysAdmin');
  });

  it('loads marketplace page', () => {
    cy.visit('/admin/marketplace');
    cy.url().should('include', '/admin/marketplace');
  });
});
