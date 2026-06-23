describe('Member ID Cards', () => {
  beforeEach(() => {
    // Login as a member
    cy.login('member@allaboard365.com', 'testpass');
    cy.visit('/member/plans-and-id-cards');
  });

  describe('ID Card Display', () => {
    it('should display ID card button for active plans', () => {
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
        
        // Click card front tab
        cy.get('[data-testid="card-front-tab"]').click();
        
        // Card front should be active
        cy.get('[data-testid="card-front-tab"]').should('have.class', 'bg-blue-600');
        cy.get('[data-testid="card-back-tab"]').should('not.have.class', 'bg-blue-600');
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

    it('should display member information on card back', () => {
      cy.get('[data-testid="enrollment-card"]').first().within(() => {
        cy.get('[data-testid="view-id-card-button"]').click();
      });

      cy.get('[data-testid="id-card-modal"]').within(() => {
        // Switch to card back
        cy.get('[data-testid="card-back-tab"]').click();
        
        // Should display additional member details
        cy.get('[data-testid="member-details"]').should('be.visible');
        cy.get('[data-testid="contact-info"]').should('be.visible');
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

    it('should close ID card modal when clicking outside', () => {
      cy.get('[data-testid="enrollment-card"]').first().within(() => {
        cy.get('[data-testid="view-id-card-button"]').click();
      });

      cy.get('[data-testid="id-card-modal"]').should('be.visible');
      
      // Click outside the modal
      cy.get('[data-testid="id-card-modal"]').click('topLeft');
      
      // Modal should be closed
      cy.get('[data-testid="id-card-modal"]').should('not.exist');
    });
  });

  describe('ID Card Actions', () => {
    beforeEach(() => {
      // Open ID card modal
      cy.get('[data-testid="enrollment-card"]').first().within(() => {
        cy.get('[data-testid="view-id-card-button"]').click();
      });
    });

    it('should download ID card', () => {
      cy.get('[data-testid="id-card-modal"]').within(() => {
        // Intercept download request
        cy.intercept('GET', '/api/me/member/id-cards/*/download', {
          statusCode: 200,
          headers: {
            'Content-Type': 'application/pdf',
            'Content-Disposition': 'attachment; filename="id-card.pdf"'
          }
        }).as('downloadIdCard');
        
        // Click download button
        cy.get('[data-testid="download-card-button"]').click();
        
        // Should trigger download
        cy.wait('@downloadIdCard');
      });
    });

    it('should print ID card', () => {
      cy.get('[data-testid="id-card-modal"]').within(() => {
        // Stub window.print
        cy.window().then((win) => {
          cy.stub(win, 'print').as('printStub');
        });
        
        // Click print button
        cy.get('[data-testid="print-card-button"]').click();
        
        // Should call print function
        cy.get('@printStub').should('have.been.called');
      });
    });

    it('should handle download errors gracefully', () => {
      cy.get('[data-testid="id-card-modal"]').within(() => {
        // Intercept download request and return error
        cy.intercept('GET', '/api/me/member/id-cards/*/download', {
          statusCode: 500,
          body: { success: false, message: 'Download failed' }
        }).as('downloadIdCardError');
        
        // Click download button
        cy.get('[data-testid="download-card-button"]').click();
        
        // Should show error message
        cy.get('[data-testid="error-message"]', { timeout: 10000 }).should('be.visible');
      });
    });
  });

  describe('ID Card Data Display', () => {
    it('should display ID card data from backend', () => {
      // Intercept enrollments request and return ID card data
      cy.intercept('GET', '/api/me/member/enrollments', {
        statusCode: 200,
        body: {
          success: true,
          data: [{
            enrollmentId: 'enrollment-123',
            product: {
              productId: 'product-123',
              name: 'Test Plan',
              idCardData: {
                front: {
                  memberName: 'John Doe',
                  memberId: 'M123456',
                  planName: 'Test Plan',
                  effectiveDate: '2024-01-01'
                },
                back: {
                  contactInfo: '555-123-4567',
                  address: '123 Main St'
                }
              }
            }
          }]
        }
      }).as('getEnrollmentsWithIdCard');
      
      cy.visit('/member/plans-and-id-cards');
      
      // Wait for data to load
      cy.wait('@getEnrollmentsWithIdCard');
      
      // Open ID card modal
      cy.get('[data-testid="enrollment-card"]').first().within(() => {
        cy.get('[data-testid="view-id-card-button"]').click();
      });
      
      cy.get('[data-testid="id-card-modal"]').within(() => {
        // Should display ID card data
        cy.get('[data-testid="member-name"]').should('contain', 'John Doe');
        cy.get('[data-testid="member-id"]').should('contain', 'M123456');
        cy.get('[data-testid="plan-name"]').should('contain', 'Test Plan');
        cy.get('[data-testid="effective-date"]').should('contain', '2024-01-01');
      });
    });

    it('should handle missing ID card data gracefully', () => {
      // Intercept enrollments request and return data without ID card
      cy.intercept('GET', '/api/me/member/enrollments', {
        statusCode: 200,
        body: {
          success: true,
          data: [{
            enrollmentId: 'enrollment-123',
            product: {
              productId: 'product-123',
              name: 'Test Plan'
              // No idCardData
            }
          }]
        }
      }).as('getEnrollmentsWithoutIdCard');
      
      cy.visit('/member/plans-and-id-cards');
      
      // Wait for data to load
      cy.wait('@getEnrollmentsWithoutIdCard');
      
      // Open ID card modal
      cy.get('[data-testid="enrollment-card"]').first().within(() => {
        cy.get('[data-testid="view-id-card-button"]').click();
      });
      
      cy.get('[data-testid="id-card-modal"]').within(() => {
        // Should show message about no ID card data
        cy.get('[data-testid="no-id-card-data"]').should('be.visible');
      });
    });
  });

  describe('Responsive Design', () => {
    it('should display ID card modal correctly on mobile', () => {
      // Set mobile viewport
      cy.viewport(375, 667);
      
      cy.get('[data-testid="enrollment-card"]').first().within(() => {
        cy.get('[data-testid="view-id-card-button"]').click();
      });

      cy.get('[data-testid="id-card-modal"]').should('be.visible');
      
      // Should be responsive
      cy.get('[data-testid="id-card-modal"]').should('have.css', 'width');
    });

    it('should display ID card modal correctly on tablet', () => {
      // Set tablet viewport
      cy.viewport(768, 1024);
      
      cy.get('[data-testid="enrollment-card"]').first().within(() => {
        cy.get('[data-testid="view-id-card-button"]').click();
      });

      cy.get('[data-testid="id-card-modal"]').should('be.visible');
      
      // Should be responsive
      cy.get('[data-testid="id-card-modal"]').should('have.css', 'width');
    });
  });

  describe('Accessibility', () => {
    it('should have proper ARIA labels', () => {
      cy.get('[data-testid="enrollment-card"]').first().within(() => {
        cy.get('[data-testid="view-id-card-button"]').click();
      });

      cy.get('[data-testid="id-card-modal"]').within(() => {
        // Should have proper ARIA labels
        cy.get('[data-testid="id-card-modal"]').should('have.attr', 'role', 'dialog');
        cy.get('[data-testid="id-card-modal"]').should('have.attr', 'aria-labelledby');
        
        // Buttons should have proper labels
        cy.get('[data-testid="download-card-button"]').should('have.attr', 'aria-label');
        cy.get('[data-testid="print-card-button"]').should('have.attr', 'aria-label');
      });
    });

    it('should be keyboard navigable', () => {
      cy.get('[data-testid="enrollment-card"]').first().within(() => {
        cy.get('[data-testid="view-id-card-button"]').click();
      });

      cy.get('[data-testid="id-card-modal"]').within(() => {
        // Should be able to navigate with keyboard
        cy.get('[data-testid="card-front-tab"]').focus();
        cy.get('[data-testid="card-front-tab"]').should('be.focused');
        
        // Should be able to navigate to other elements
        cy.get('[data-testid="card-front-tab"]').tab();
        cy.get('[data-testid="card-back-tab"]').should('be.focused');
      });
    });
  });
});



