describe('Group Admin User Management Basic Test', () => {
  it('should load user management page without errors', () => {
    cy.loginAsRole('GroupAdmin');
    cy.visit('/group-admin/users');

    cy.contains('Group Admin Management').should('be.visible');
    cy.contains('button', 'Add User').should('be.visible');

    cy.contains('500').should('not.exist');
    cy.contains('Server Error').should('not.exist');
    cy.contains('400').should('not.exist');
    cy.contains('Bad Request').should('not.exist');
    cy.contains('404').should('not.exist');
    cy.contains('Not Found').should('not.exist');
  });
});
