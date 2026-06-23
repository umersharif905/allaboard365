describe('Member Plans & ID Cards', () => {
  beforeEach(() => {
    // Login as a member
    cy.login('member@allaboard365.com', 'testpass');
    cy.visit('/member/plans-and-id-cards');
  });

  describe('ID Card Display', () => {
    it('should display active plans with ID card buttons', () => {
      // Wait for plans to load
      cy.get('[data-testid="active-plans"]', { timeout: 10000 }).should('be.visible');
      
      // Check if there are active enrollments
      cy.get('[data-testid="enrollment-card"]').then(($cards) => {
        if ($cards.length > 0) {
          // Should have "View ID Card" button for active enrollments
          cy.get('[data-testid="view-id-card-button"]').should('be.visible');
        }
      });
    });

    it('should open ID card modal when View ID Card is clicked', () => {
      cy.get('[data-testid="enrollment-card"]').first().within(() => {
        cy.get('[data-testid="view-id-card-button"]').click();
      });

      // ID card modal should open
      cy.get('[data-testid="id-card-modal"]').should('be.visible');
      cy.get('[data-testid="id-card-title"]').should('contain', 'Digital ID Card');
    });

    it('should display card front and back tabs', () => {
      cy.get('[data-testid="enrollment-card"]').first().within(() => {
        cy.get('[data-testid="view-id-card-button"]').click();
      });

      cy.get('[data-testid="id-card-modal"]').within(() => {
        // Should have card front and back tabs
        cy.get('[data-testid="card-front-tab"]').should('be.visible');
        cy.get('[data-testid="card-back-tab"]').should('be.visible');
        
        // Card front should be active by default
        cy.get('[data-testid="card-front-tab"]').should('have.class', 'bg-blue-600');
      });
    });

    it('should switch between card front and back', () => {
      cy.get('[data-testid="enrollment-card"]').first().within(() => {
        cy.get('[data-testid="view-id-card-button"]').click();
      });

      cy.get('[data-testid="id-card-modal"]').within(() => {
        // Click card back tab
        cy.get('[data-testid="card-back-tab"]').click();
        
        // Card back should be active
        cy.get('[data-testid="card-back-tab"]').should('have.class', 'bg-blue-600');
        cy.get('[data-testid="card-front-tab"]').should('not.have.class', 'bg-blue-600');
      });
    });

    it('should display member information on card front', () => {
      cy.get('[data-testid="enrollment-card"]').first().within(() => {
        cy.get('[data-testid="view-id-card-button"]').click();
      });

      cy.get('[data-testid="id-card-modal"]').within(() => {
        // Should display member details
        cy.get('[data-testid="member-name"]').should('be.visible');
        cy.get('[data-testid="member-id"]').should('be.visible');
        cy.get('[data-testid="plan-name"]').should('be.visible');
        cy.get('[data-testid="effective-date"]').should('be.visible');
      });
    });

    it('should display download and print buttons', () => {
      cy.get('[data-testid="enrollment-card"]').first().within(() => {
        cy.get('[data-testid="view-id-card-button"]').click();
      });

      cy.get('[data-testid="id-card-modal"]').within(() => {
        cy.get('[data-testid="download-card-button"]').should('be.visible');
        cy.get('[data-testid="print-card-button"]').should('be.visible');
      });
    });

    it('should close ID card modal when close button is clicked', () => {
      cy.get('[data-testid="enrollment-card"]').first().within(() => {
        cy.get('[data-testid="view-id-card-button"]').click();
      });

      cy.get('[data-testid="id-card-modal"]').should('be.visible');
      
      // Click close button
      cy.get('[data-testid="close-modal-button"]').click();
      
      // Modal should be closed
      cy.get('[data-testid="id-card-modal"]').should('not.exist');
    });
  });

  describe('Plan Changes', () => {
    it('should display Make Changes button for active plans', () => {
      cy.get('[data-testid="active-plans"]', { timeout: 10000 }).should('be.visible');
      
      cy.get('[data-testid="enrollment-card"]').then(($cards) => {
        if ($cards.length > 0) {
          // Should have "Make Changes" button for active enrollments
          cy.get('[data-testid="make-changes-button"]').should('be.visible');
        }
      });
    });

    it('should open plan changes modal when Make Changes is clicked', () => {
      cy.get('[data-testid="enrollment-card"]').first().within(() => {
        cy.get('[data-testid="make-changes-button"]').click();
      });

      // Plan changes modal should open
      cy.get('[data-testid="plan-changes-modal"]').should('be.visible');
      cy.get('[data-testid="plan-changes-title"]').should('contain', 'Make Changes to');
    });

    it('should display configuration, products, and summary tabs', () => {
      cy.get('[data-testid="enrollment-card"]').first().within(() => {
        cy.get('[data-testid="make-changes-button"]').click();
      });

      cy.get('[data-testid="plan-changes-modal"]').within(() => {
        // Should have all three tabs
        cy.get('[data-testid="config-tab"]').should('be.visible');
        cy.get('[data-testid="products-tab"]').should('be.visible');
        cy.get('[data-testid="summary-tab"]').should('be.visible');
        
        // Configuration tab should be active by default
        cy.get('[data-testid="config-tab"]').should('have.class', 'bg-blue-600');
      });
    });

    it('should switch between tabs correctly', () => {
      cy.get('[data-testid="enrollment-card"]').first().within(() => {
        cy.get('[data-testid="make-changes-button"]').click();
      });

      cy.get('[data-testid="plan-changes-modal"]').within(() => {
        // Click products tab
        cy.get('[data-testid="products-tab"]').click();
        cy.get('[data-testid="products-tab"]').should('have.class', 'bg-blue-600');
        
        // Click summary tab
        cy.get('[data-testid="summary-tab"]').click();
        cy.get('[data-testid="summary-tab"]').should('have.class', 'bg-blue-600');
      });
    });

    it('should display configuration fields if available', () => {
      cy.get('[data-testid="enrollment-card"]').first().within(() => {
        cy.get('[data-testid="make-changes-button"]').click();
      });

      cy.get('[data-testid="plan-changes-modal"]').within(() => {
        // Check if configuration fields are displayed
        cy.get('body').then(($body) => {
          if ($body.find('[data-testid="config-field"]').length > 0) {
            cy.get('[data-testid="config-field"]').should('be.visible');
          } else {
            // Should show message about no configuration fields
            cy.get('[data-testid="no-config-fields"]').should('be.visible');
          }
        });
      });
    });

    it('should allow changing configuration field values', () => {
      cy.get('[data-testid="enrollment-card"]').first().within(() => {
        cy.get('[data-testid="make-changes-button"]').click();
      });

      cy.get('[data-testid="plan-changes-modal"]').within(() => {
        // Check if there are configuration fields to change
        cy.get('body').then(($body) => {
          if ($body.find('[data-testid="config-field"]').length > 0) {
            // Change a configuration field
            cy.get('[data-testid="config-field"]').first().within(() => {
              cy.get('select, input').first().then(($input) => {
                if ($input.is('select')) {
                  cy.wrap($input).select(1); // Select second option
                } else {
                  cy.wrap($input).clear().type('New Value');
                }
              });
            });
            
            // Save button should be enabled
            cy.get('[data-testid="save-changes-button"]').should('not.be.disabled');
          }
        });
      });
    });

    it('should display available products for adding', () => {
      cy.get('[data-testid="enrollment-card"]').first().within(() => {
        cy.get('[data-testid="make-changes-button"]').click();
      });

      cy.get('[data-testid="plan-changes-modal"]').within(() => {
        // Switch to products tab
        cy.get('[data-testid="products-tab"]').click();
        
        // Should show add products section
        cy.get('[data-testid="add-products-section"]').should('be.visible');
        
        // Check if there are available products
        cy.get('body').then(($body) => {
          if ($body.find('[data-testid="available-product"]').length > 0) {
            cy.get('[data-testid="available-product"]').should('be.visible');
          } else {
            // Should show message about no available products
            cy.get('[data-testid="no-available-products"]').should('be.visible');
          }
        });
      });
    });

    it('should allow adding products', () => {
      cy.get('[data-testid="enrollment-card"]').first().within(() => {
        cy.get('[data-testid="make-changes-button"]').click();
      });

      cy.get('[data-testid="plan-changes-modal"]').within(() => {
        // Switch to products tab
        cy.get('[data-testid="products-tab"]').click();
        
        // Check if there are products to add
        cy.get('body').then(($body) => {
          if ($body.find('[data-testid="add-product-button"]').length > 0) {
            // Click add product button
            cy.get('[data-testid="add-product-button"]').first().click();
            
            // Switch to summary tab to see the change
            cy.get('[data-testid="summary-tab"]').click();
            
            // Should show products to add
            cy.get('[data-testid="products-to-add"]').should('be.visible');
          }
        });
      });
    });

    it('should allow removing current product', () => {
      cy.get('[data-testid="enrollment-card"]').first().within(() => {
        cy.get('[data-testid="make-changes-button"]').click();
      });

      cy.get('[data-testid="plan-changes-modal"]').within(() => {
        // Switch to products tab
        cy.get('[data-testid="products-tab"]').click();
        
        // Click remove product button
        cy.get('[data-testid="remove-product-button"]').click();
        
        // Switch to summary tab to see the change
        cy.get('[data-testid="summary-tab"]').click();
        
        // Should show products to remove
        cy.get('[data-testid="products-to-remove"]').should('be.visible');
      });
    });

    it('should display pricing impact when changes are made', () => {
      cy.get('[data-testid="enrollment-card"]').first().within(() => {
        cy.get('[data-testid="make-changes-button"]').click();
      });

      cy.get('[data-testid="plan-changes-modal"]').within(() => {
        // Make a configuration change if possible
        cy.get('body').then(($body) => {
          if ($body.find('[data-testid="config-field"]').length > 0) {
            cy.get('[data-testid="config-field"]').first().within(() => {
              cy.get('select, input').first().then(($input) => {
                if ($input.is('select')) {
                  cy.wrap($input).select(1);
                } else {
                  cy.wrap($input).clear().type('New Value');
                }
              });
            });
            
            // Wait for pricing impact to be calculated
            cy.get('[data-testid="pricing-impact"]', { timeout: 10000 }).should('be.visible');
          }
        });
      });
    });

    it('should display change summary', () => {
      cy.get('[data-testid="enrollment-card"]').first().within(() => {
        cy.get('[data-testid="make-changes-button"]').click();
      });

      cy.get('[data-testid="plan-changes-modal"]').within(() => {
        // Switch to summary tab
        cy.get('[data-testid="summary-tab"]').click();
        
        // Should show change summary
        cy.get('[data-testid="change-summary"]').should('be.visible');
        
        // Should show effective date input
        cy.get('[data-testid="effective-date-input"]').should('be.visible');
      });
    });

    it('should save changes successfully', () => {
      cy.get('[data-testid="enrollment-card"]').first().within(() => {
        cy.get('[data-testid="make-changes-button"]').click();
      });

      cy.get('[data-testid="plan-changes-modal"]').within(() => {
        // Make a change
        cy.get('body').then(($body) => {
          if ($body.find('[data-testid="config-field"]').length > 0) {
            cy.get('[data-testid="config-field"]').first().within(() => {
              cy.get('select, input').first().then(($input) => {
                if ($input.is('select')) {
                  cy.wrap($input).select(1);
                } else {
                  cy.wrap($input).clear().type('New Value');
                }
              });
            });
            
            // Click save changes button
            cy.get('[data-testid="save-changes-button"]').click();
            
            // Modal should close
            cy.get('[data-testid="plan-changes-modal"]').should('not.exist');
          }
        });
      });
    });

    it('should cancel changes when cancel button is clicked', () => {
      cy.get('[data-testid="enrollment-card"]').first().within(() => {
        cy.get('[data-testid="make-changes-button"]').click();
      });

      cy.get('[data-testid="plan-changes-modal"]').within(() => {
        // Click cancel button
        cy.get('[data-testid="cancel-button"]').click();
        
        // Modal should close
        cy.get('[data-testid="plan-changes-modal"]').should('not.exist');
      });
    });
  });

  describe('Error Handling', () => {
    it('should handle API errors gracefully', () => {
      // Intercept API calls and return errors
      cy.intercept('GET', '/api/me/member/enrollments', { statusCode: 500 }).as('getEnrollmentsError');
      
      cy.visit('/member/plans-and-id-cards');
      
      // Should show error message
      cy.get('[data-testid="error-message"]', { timeout: 10000 }).should('be.visible');
    });

    it('should handle terminated account', () => {
      // Intercept API calls and return terminated account error
      cy.intercept('GET', '/api/me/member/enrollments', {
        statusCode: 403,
        body: {
          success: false,
          error: {
            code: 'MEMBER_TERMINATED',
            memberId: 'member-123',
            terminatedDate: '2024-01-01'
          }
        }
      }).as('getEnrollmentsTerminated');
      
      cy.visit('/member/plans-and-id-cards');
      
      // Should show terminated account screen
      cy.get('[data-testid="terminated-account-screen"]', { timeout: 10000 }).should('be.visible');
    });

    it('should handle inactive account', () => {
      // Intercept API calls and return inactive account error
      cy.intercept('GET', '/api/me/member/enrollments', {
        statusCode: 403,
        body: {
          success: false,
          error: {
            code: 'MEMBER_INACTIVE'
          }
        }
      }).as('getEnrollmentsInactive');
      
      cy.visit('/member/plans-and-id-cards');
      
      // Should show inactive account message
      cy.get('[data-testid="inactive-account-message"]', { timeout: 10000 }).should('be.visible');
    });
  });

  describe('Loading States', () => {
    it('should show loading state while fetching data', () => {
      // Intercept API calls and delay response
      cy.intercept('GET', '/api/me/member/enrollments', (req) => {
        req.reply((res) => {
          res.delay(2000);
        });
      }).as('getEnrollmentsDelayed');
      
      cy.visit('/member/plans-and-id-cards');
      
      // Should show loading spinner
      cy.get('[data-testid="loading-spinner"]', { timeout: 5000 }).should('be.visible');
    });
  });
});



