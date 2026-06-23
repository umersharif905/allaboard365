describe('Debug Form Modal', () => {
  beforeEach(() => {
    cy.loginAsRole('TenantAdmin');
    cy.visit('/tenant-admin/users');
    cy.contains('Tenant User Management').should('be.visible');
  });

  it('shows create user form fields in modal', () => {
    cy.openUserManagementCreateModal();
    cy.contains('label', 'First Name').should('be.visible');
    cy.contains('label', 'Last Name').should('be.visible');
    cy.contains('label', 'Email').should('be.visible');
  });
});
