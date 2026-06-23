describe('Group Admin Products Loading Test', () => {
  it('loads group admin dashboard without server errors', () => {
    cy.loginAsRole('GroupAdmin');
    cy.visit('/group-admin/dashboard');

    cy.contains('500').should('not.exist');
    cy.contains('Server Error').should('not.exist');
    cy.url().should('match', /\/group-admin\/(dashboard|groups\/)/);
  });
});
