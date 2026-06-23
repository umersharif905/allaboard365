describe('Tenant User Management', () => {
  beforeEach(() => {
    cy.loginAsRole('TenantAdmin');
  });

  it('should load the user management page', () => {
    cy.visit('/tenant-admin/users');
    cy.contains('Tenant User Management').should('be.visible');
    cy.contains('button', 'Add User').should('be.visible');
  });

  it('should open the create user modal', () => {
    cy.visit('/tenant-admin/users');
    cy.openUserManagementCreateModal();
    cy.contains('label', 'First Name').should('be.visible');
    cy.contains('label', 'Email').should('be.visible');
  });
});
