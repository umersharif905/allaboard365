describe('Debug User List', () => {
  beforeEach(() => {
    cy.loginAsRole('TenantAdmin');
  });

  it('should load the user list without errors', () => {
    cy.intercept('GET', '/api/me/tenant-admin/user-management*').as('getUsers');

    cy.visit('/tenant-admin/users');
    cy.contains('Tenant User Management').should('be.visible');

    cy.wait('@getUsers').its('response.statusCode').should('eq', 200);
    cy.get('table tbody tr').should('have.length.greaterThan', 0);
  });

  it('should open the create user modal', () => {
    cy.visit('/tenant-admin/users');
    cy.openUserManagementCreateModal();
  });
});
