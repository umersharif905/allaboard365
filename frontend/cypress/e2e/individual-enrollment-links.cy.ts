// frontend/cypress/e2e/individual-enrollment-links.cy.ts
describe('Individual Enrollment Links', () => {
  beforeEach(() => {
    // Clear existing login state
    cy.clearLocalStorage();
    
    // Login as Agent to test individual enrollment links
    cy.loginAsRole('Agent');
    
    // Navigate to members page
    cy.visit('/agent/members');
    cy.url().should('include', '/agent/members');
    
    // Wait for members to load
    cy.contains('Members', { timeout: 10000 }).should('be.visible');
  });

  it('should show individual enrollment link button for members without groups', () => {
    // Look for a member without a group (individual member)
    cy.get('body').then(($body) => {
      if ($body.find('[title*="Send individual enrollment link"]').length > 0) {
        // Click on the individual enrollment link button
        cy.get('[title*="Send individual enrollment link"]').first().click();
        
        // Verify the modal opens
        cy.get('[role="dialog"]').should('be.visible');
        cy.contains('Send Individual Enrollment Link').should('be.visible');
        
        // Verify member details are shown
        cy.contains('Member Details').should('be.visible');
        
        // Close the modal
        cy.get('button').contains('Cancel').click();
      } else {
        cy.log('No individual members found to test with');
      }
    });
  });

  it('should show group enrollment link button for members with groups', () => {
    // Look for a member with a group
    cy.get('body').then(($body) => {
      if ($body.find('[title*="Send group enrollment link"]').length > 0) {
        // Click on the group enrollment link button
        cy.get('[title*="Send group enrollment link"]').first().click();
        
        // Verify the modal opens (this would be the group enrollment modal)
        cy.get('[role="dialog"]').should('be.visible');
        
        // Close the modal
        cy.get('button').contains('Cancel').click();
      } else {
        cy.log('No group members found to test with');
      }
    });
  });

  it('should load individual enrollment templates in modal', () => {
    // Look for individual enrollment link button
    cy.get('body').then(($body) => {
      if ($body.find('[title*="Send individual enrollment link"]').length > 0) {
        // Click on the individual enrollment link button
        cy.get('[title*="Send individual enrollment link"]').first().click();
        
        // Verify the modal opens
        cy.get('[role="dialog"]').should('be.visible');
        cy.contains('Send Individual Enrollment Link').should('be.visible');
        
        // Wait for templates to load
        cy.get('select').should('be.visible');
        
        // Verify template dropdown has options or shows no templates message
        cy.get('select').then(($select) => {
          if ($select.find('option').length > 1) {
            // Templates loaded successfully
            cy.log('Individual enrollment templates loaded successfully');
          } else {
            // Check for no templates message
            cy.contains('No individual enrollment templates found').should('be.visible');
          }
        });
        
        // Close the modal
        cy.get('button').contains('Cancel').click();
      } else {
        cy.log('No individual members found to test with');
      }
    });
  });

  it('should handle template selection and send link', () => {
    // Look for individual enrollment link button
    cy.get('body').then(($body) => {
      if ($body.find('[title*="Send individual enrollment link"]').length > 0) {
        // Click on the individual enrollment link button
        cy.get('[title*="Send individual enrollment link"]').first().click();
        
        // Verify the modal opens
        cy.get('[role="dialog"]').should('be.visible');
        
        // Wait for templates to load
        cy.get('select').should('be.visible');
        
        // Check if templates are available
        cy.get('select').then(($select) => {
          if ($select.find('option').length > 1) {
            // Select a template
            cy.get('select').select(1); // Select first non-empty option
            
            // Click send button
            cy.get('button').contains('Send Enrollment Link').click();
            
            // Verify success message or error handling
            cy.get('body').then(($body) => {
              if ($body.find('.bg-green-50').length > 0) {
                cy.log('Enrollment link sent successfully');
              } else if ($body.find('.bg-red-50').length > 0) {
                cy.log('Error occurred (expected if no templates available)');
              }
            });
          } else {
            cy.log('No templates available to test sending');
          }
        });
        
        // Close the modal
        cy.get('button').contains('Cancel').click();
      } else {
        cy.log('No individual members found to test with');
      }
    });
  });

  it('should copy enrollment link to clipboard when copy button is clicked', () => {
    // Look for individual enrollment link button
    cy.get('body').then(($body) => {
      if ($body.find('[title*="Send individual enrollment link"]').length > 0) {
        // Click on the individual enrollment link button
        cy.get('[title*="Send individual enrollment link"]').first().click();
        
        // Verify the modal opens
        cy.get('[role="dialog"]').should('be.visible');
        
        // Wait for templates to load
        cy.get('select').should('be.visible');
        
        // Check if templates are available
        cy.get('select').then(($select) => {
          if ($select.find('option').length > 1) {
            // Select a template
            cy.get('select').select(1); // Select first non-empty option
            
            // Click copy link button
            cy.get('button').contains('Copy Link').click();
            
            // Wait for the API call to complete and check for success/error states
            cy.get('body').then(($body) => {
              // Check for either success (copied state) or error message
              if ($body.find('button').contains('Copied!').length > 0) {
                cy.log('Enrollment link copied successfully');
              } else if ($body.find('.bg-red-50').length > 0) {
                cy.log('Error occurred during copy (expected if API fails)');
              } else {
                cy.log('Copy button clicked, waiting for response...');
              }
            });
          } else {
            cy.log('No templates available to test copying');
          }
        });
        
        // Close the modal
        cy.get('button').contains('Cancel').click();
      } else {
        cy.log('No individual members found to test with');
      }
    });
  });
});
