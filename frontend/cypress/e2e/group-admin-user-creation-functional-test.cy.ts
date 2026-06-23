describe('Group Admin User Creation Functional Test', () => {
  it('should create a new user and verify it appears in the list', () => {
    cy.loginAsRole('GroupAdmin');
    cy.visit('/group-admin/users');

    cy.contains('Group Admin Management').should('be.visible');

    const testEmail = `testuser${Date.now()}@example.com`;

    cy.intercept('POST', '/api/me/group-admin/user-management').as('createUser');

    cy.openUserManagementCreateModal();
    cy.fillUserManagementCreateForm({ email: testEmail, role: 'GroupAdmin' });
    cy.submitUserManagementCreateForm();

    cy.wait('@createUser').its('response.statusCode').should('eq', 200);

    cy.contains('500').should('not.exist');
    cy.contains('Server Error').should('not.exist');
    cy.contains('400').should('not.exist');
    cy.contains('Bad Request').should('not.exist');

    cy.contains('h3', 'Create New User', { timeout: 15000 }).should('not.exist');
    cy.contains(testEmail, { timeout: 15000 }).should('exist');
  });
});
