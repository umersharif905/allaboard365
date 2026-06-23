// Test to verify "Enroll New Member" link navigates to members page

describe('Agent Dashboard - Quick Actions', () => {
  beforeEach(() => {
    // Use the custom login command
    cy.loginAsAgent();
    
    // Navigate directly to the dashboard
    cy.visit('/agent/dashboard');
    cy.url().should('include', '/agent/dashboard');
    
    // Wait for the dashboard to load properly
    cy.contains('Dashboard', { timeout: 10000 }).should('be.visible');
  });

  it('should navigate to members page when clicking "Enroll New Member"', () => {
    // Take a screenshot to see what the dashboard looks like
    cy.screenshot('dashboard-before-click');
    
    // Find the "Enroll New Member" link and click it
    cy.contains('Enroll New Member').should('be.visible').click();
    
    // Verify navigation to members page
    cy.url().should('include', '/agent/members');
    cy.contains('Members', { timeout: 10000 }).should('be.visible');
    
    // Take a screenshot of the members page to verify
    cy.screenshot('members-page-after-click');
  });
}); 