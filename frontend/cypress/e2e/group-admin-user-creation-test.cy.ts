describe('Group Admin User Creation Test', () => {
  it('should load user management page without 500 error', () => {
    cy.loginAsRole('GroupAdmin');
    cy.visit('/group-admin/users');

    cy.contains('500').should('not.exist');
    cy.contains('Server Error').should('not.exist');
    cy.contains('Group Admin Management').should('be.visible');
    cy.contains('button', 'Add User').should('be.visible');
  });
});
