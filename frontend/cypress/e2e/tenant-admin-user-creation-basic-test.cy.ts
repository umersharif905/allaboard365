describe('Tenant Admin User Creation Basic Test', () => {
  beforeEach(() => {
    cy.loginAsRole('TenantAdmin');
  });

  it('should load the user management page without errors', () => {
    cy.visit('/tenant-admin/users');

    cy.contains('Tenant User Management').should('be.visible');
    cy.contains('button', 'Add User').should('be.visible');

    cy.contains('500').should('not.exist');
    cy.contains('Server Error').should('not.exist');
    cy.contains('404').should('not.exist');
    cy.contains('Not Found').should('not.exist');
  });

  it('should open the create user modal', () => {
    cy.visit('/tenant-admin/users');
    cy.contains('Tenant User Management').should('be.visible');

    cy.openUserManagementCreateModal();
    cy.contains('Tenant administrator').should('be.visible');
  });
});
