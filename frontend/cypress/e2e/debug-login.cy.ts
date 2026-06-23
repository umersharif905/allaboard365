describe('Debug Login Process', () => {
  it('logs in as tenant admin via password form', () => {
    cy.loginAsRole('TenantAdmin');
    cy.visit('/tenant-admin/users');
    cy.contains('Tenant User Management').should('be.visible');
  });
});
