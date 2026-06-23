// Agent dashboard test with enhanced login (TypeScript version)

/// <reference types="cypress" />

describe('Agent Dashboard', () => {
  beforeEach(() => {
    cy.loginAsRole('Agent');
    cy.visit('/agent/dashboard');
  });

  it('should navigate to members page when clicking "Enroll New Member"', () => {
    // Take screenshot of dashboard for debugging
    cy.screenshot('dashboard-view');
    
    // Check the URL to make sure we're on the dashboard
    cy.url().should('include', '/agent/dashboard');
    
    // Find the "Enroll New Member" link with more comprehensive selectors
    cy.log('Looking for enrollment link');
    cy.get('body').contains('Enroll New Member').should('exist');
    cy.get('a').contains('Enroll New Member').click();
    
    // Wait for navigation
    cy.wait(2000);
    
    // Take screenshot of where we ended up
    cy.screenshot('after-enrollment-click');
    
    // Verify we're on the members page
    cy.url().should('include', '/agent/members');
    cy.contains('Members').should('exist');
    
    cy.log('Test completed successfully');
  });
}); 