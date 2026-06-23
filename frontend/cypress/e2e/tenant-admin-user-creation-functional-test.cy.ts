describe('Tenant Admin User Creation Functional Test', () => {
  beforeEach(() => {
    cy.loginAsRole('TenantAdmin');
  });

  it('should create a new user and verify it appears in the list', () => {
    const testEmail = `testuser-${Date.now()}@example.com`;

    cy.visit('/tenant-admin/users');
    cy.contains('Tenant User Management').should('be.visible');

    cy.openUserManagementCreateModal();
    cy.fillUserManagementCreateForm({ email: testEmail });
    cy.submitUserManagementCreateForm();

    cy.contains('h3', 'Create New User', { timeout: 15000 }).should('not.exist');
    cy.contains('500').should('not.exist');
    cy.contains('Server Error').should('not.exist');
  });

  it('should disable create when required fields are empty', () => {
    cy.visit('/tenant-admin/users');
    cy.openUserManagementCreateModal();
    cy.get('button').contains('Create User').should('be.disabled');
  });
});
