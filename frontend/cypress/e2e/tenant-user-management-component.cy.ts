describe('Tenant User Management Component', () => {
  beforeEach(() => {
    cy.loginAsRole('TenantAdmin');
  });

  it('should render the user management page and create modal', () => {
    cy.visit('/tenant-admin/users');
    cy.contains('Tenant User Management').should('be.visible');
    cy.contains('button', 'Add User').should('be.visible');

    cy.openUserManagementCreateModal();
    cy.contains('label', 'First Name').parent().find('input').should('be.visible');
    cy.contains('label', 'Last Name').parent().find('input').should('be.visible');
    cy.contains('label', 'Email').parent().find('input').should('be.visible');
    cy.get('button').contains('Create User').should('be.disabled');
  });
});
