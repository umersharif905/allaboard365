// Agent dashboard quick actions — matches current AgentDashboard UI (hardcoded actions, no data-testids).
describe('Quick Links Functionality', () => {
  beforeEach(() => {
    cy.loginAsRole('Agent');
    cy.visit('/agent/dashboard');
    cy.contains('h2', 'Quick Actions').should('be.visible');
  });

  describe('Quick Links Display', () => {
    it('should display all quick action links', () => {
      cy.contains('Enroll New Member').should('be.visible');
      cy.contains('Create New Group').should('be.visible');
      cy.contains('New Support Ticket').should('be.visible');
    });

    it('should display correct titles and descriptions', () => {
      cy.contains('h3', 'Enroll New Member').should('be.visible');
      cy.contains('h3', 'Create New Group').should('be.visible');
      cy.contains('h3', 'New Support Ticket').should('be.visible');
    });
  });

  describe('Quick Link Navigation', () => {
    it('should navigate to enroll new member page', () => {
      cy.get('a').contains('Enroll New Member').click();
      cy.url().should('include', '/agent/members');
    });

    it('should navigate to create new group page', () => {
      cy.get('a').contains('Create New Group').click();
      cy.url().should('include', '/agent/groups');
    });

    it('should open the support ticket modal', () => {
      cy.get('button').contains('New Support Ticket').click();
      cy.get('[role="dialog"]', { timeout: 10000 }).should('be.visible');
    });
  });
});
