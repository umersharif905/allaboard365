describe('Group Admin User Creation Comprehensive Test', () => {
  it('should create a new user and display it in the list', () => {
    cy.loginAsRole('GroupAdmin');
    cy.visit('/group-admin/users');

    cy.contains('Group Admin Management').should('be.visible');
    cy.openUserManagementCreateModal();

    const testEmail = `testuser${Date.now()}@example.com`;
    cy.fillUserManagementCreateForm({ email: testEmail, role: 'GroupAdmin' });
    cy.submitUserManagementCreateForm();

    cy.contains('500').should('not.exist');
    cy.contains('Server Error').should('not.exist');
    cy.contains('400').should('not.exist');
    cy.contains('Bad Request').should('not.exist');

    cy.contains(testEmail, { timeout: 15000 }).should('be.visible');
  });
});
