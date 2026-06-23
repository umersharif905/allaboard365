describe('Group Admin User Management', () => {
  beforeEach(() => {
    cy.loginAsRole('GroupAdmin');
  });

  it('should load the user management page', () => {
    cy.visit('/group-admin/users');
    cy.contains('Group Admin Management').should('be.visible');
    cy.contains('button', 'Add User').should('be.visible');
  });

  it('should open the create user modal', () => {
    cy.visit('/group-admin/users');
    cy.openUserManagementCreateModal();
    cy.get('button').contains('Create User').should('be.disabled');
  });

  it('should create a new group admin user', () => {
    const testEmail = `testuser${Date.now()}@example.com`;

    cy.visit('/group-admin/users');
    cy.openUserManagementCreateModal();
    cy.fillUserManagementCreateForm({ email: testEmail, role: 'GroupAdmin' });
    cy.submitUserManagementCreateForm();

    cy.contains('h3', 'Create New User', { timeout: 15000 }).should('not.exist');
    cy.contains('500').should('not.exist');
    cy.contains('Server Error').should('not.exist');
  });
});
