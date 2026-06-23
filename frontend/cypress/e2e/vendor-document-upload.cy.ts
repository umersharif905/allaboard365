// frontend/cypress/e2e/vendor-document-upload.cy.ts
describe('Vendor Document Upload Functionality', () => {
  beforeEach(() => {
    // Mock the upload API
    cy.intercept('POST', '/api/uploads', {
      statusCode: 200,
      body: {
        success: true,
        data: {
          fileUrl: 'https://example.com/uploads/test-document.pdf',
          fileName: 'test-document.pdf',
          fileSize: 1024
        }
      }
    }).as('uploadDocument');

    // Mock the vendor API
    cy.intercept('GET', '/api/vendors', {
      statusCode: 200,
      body: {
        success: true,
        data: [
          { VendorId: 'vendor-1', Name: 'Test Vendor 1' },
          { VendorId: 'vendor-2', Name: 'Test Vendor 2' }
        ]
      }
    }).as('getVendors');

    // Visit the vendors page
    cy.visit('/admin/vendors');
  });

  describe('Required Documents Tab', () => {
    beforeEach(() => {
      // Navigate to the Required Documents tab
      cy.get('[data-testid="vendor-tabs"]').should('be.visible');
      cy.get('[data-testid="documents-tab"]').click();
    });

    it('should display the Required Documents tab correctly', () => {
      cy.get('[data-testid="required-documents-section"]').should('be.visible');
      cy.get('h3').should('contain', 'Required Documents');
      cy.get('[data-testid="upload-area"]').should('be.visible');
    });

    it('should show upload area with proper styling', () => {
      cy.get('[data-testid="upload-area"]').should('have.class', 'border-2');
      cy.get('[data-testid="upload-area"]').should('have.class', 'border-dashed');
      cy.get('[data-testid="upload-area"]').should('have.class', 'border-gray-300');
    });

    it('should display upload instructions', () => {
      cy.get('[data-testid="upload-instructions"]').should('be.visible');
      cy.get('[data-testid="upload-instructions"]').should('contain', 'Drag and drop files here');
      cy.get('[data-testid="upload-instructions"]').should('contain', 'or click to browse');
    });

    it('should show supported file types', () => {
      cy.get('[data-testid="supported-file-types"]').should('be.visible');
      cy.get('[data-testid="supported-file-types"]').should('contain', 'PDF, DOC, DOCX');
    });
  });

  describe('File Upload Functionality', () => {
    beforeEach(() => {
      cy.get('[data-testid="documents-tab"]').click();
    });

    it('should allow file selection via click', () => {
      // Create a test file
      const fileName = 'test-document.pdf';
      const fileContent = 'Test PDF content';
      const file = new File([fileContent], fileName, { type: 'application/pdf' });
      
      // Mock file input
      cy.get('[data-testid="file-input"]').selectFile({
        contents: Cypress.Buffer.from(fileContent),
        fileName: fileName,
        mimeType: 'application/pdf'
      });
      
      // Verify file was selected
      cy.get('[data-testid="selected-file-name"]').should('contain', fileName);
    });

    it('should allow drag and drop file upload', () => {
      const fileName = 'drag-drop-test.pdf';
      const fileContent = 'Drag and drop test content';
      
      // Create a data transfer object
      const dataTransfer = new DataTransfer();
      const file = new File([fileContent], fileName, { type: 'application/pdf' });
      dataTransfer.items.add(file);
      
      // Trigger drag and drop
      cy.get('[data-testid="upload-area"]').trigger('drop', {
        dataTransfer: dataTransfer
      });
      
      // Verify file was dropped
      cy.get('[data-testid="selected-file-name"]').should('contain', fileName);
    });

    it('should validate file types', () => {
      const fileName = 'invalid-file.txt';
      const fileContent = 'Invalid file content';
      
      cy.get('[data-testid="file-input"]').selectFile({
        contents: Cypress.Buffer.from(fileContent),
        fileName: fileName,
        mimeType: 'text/plain'
      });
      
      // Should show validation error
      cy.get('[data-testid="file-type-error"]').should('be.visible');
      cy.get('[data-testid="file-type-error"]').should('contain', 'Invalid file type');
    });

    it('should validate file size', () => {
      // Over client max (25MB) to trigger validation
      const fileName = 'large-file.pdf';
      const largeContent = Cypress.Buffer.alloc(25 * 1024 * 1024 + 1);
      
      cy.get('[data-testid="file-input"]').selectFile({
        contents: largeContent,
        fileName: fileName,
        mimeType: 'application/pdf'
      });
      
      // Should show file size error
      cy.get('[data-testid="file-size-error"]').should('be.visible');
      cy.get('[data-testid="file-size-error"]').should('contain', 'File too large');
    });

    it('should show upload progress', () => {
      const fileName = 'upload-test.pdf';
      const fileContent = 'Upload test content';
      
      // Mock upload with delay
      cy.intercept('POST', '/api/uploads', {
        statusCode: 200,
        body: {
          success: true,
          data: {
            fileUrl: 'https://example.com/uploads/upload-test.pdf',
            fileName: fileName,
            fileSize: fileContent.length
          }
        },
        delay: 2000
      }).as('uploadWithDelay');
      
      cy.get('[data-testid="file-input"]').selectFile({
        contents: Cypress.Buffer.from(fileContent),
        fileName: fileName,
        mimeType: 'application/pdf'
      });
      
      // Click upload button
      cy.get('[data-testid="upload-button"]').click();
      
      // Should show progress indicator
      cy.get('[data-testid="upload-progress"]').should('be.visible');
      cy.get('[data-testid="upload-progress"]').should('contain', 'Uploading');
    });

    it('should handle upload success', () => {
      const fileName = 'success-test.pdf';
      const fileContent = 'Success test content';
      
      cy.get('[data-testid="file-input"]').selectFile({
        contents: Cypress.Buffer.from(fileContent),
        fileName: fileName,
        mimeType: 'application/pdf'
      });
      
      cy.get('[data-testid="upload-button"]').click();
      
      // Wait for upload to complete
      cy.wait('@uploadDocument');
      
      // Should show success message
      cy.get('[data-testid="upload-success"]').should('be.visible');
      cy.get('[data-testid="upload-success"]').should('contain', 'File uploaded successfully');
      
      // Should add file to the list
      cy.get('[data-testid="uploaded-files-list"]').should('contain', fileName);
    });

    it('should handle upload failure', () => {
      // Mock upload failure
      cy.intercept('POST', '/api/uploads', {
        statusCode: 500,
        body: {
          success: false,
          message: 'Upload failed'
        }
      }).as('uploadFailure');
      
      const fileName = 'failure-test.pdf';
      const fileContent = 'Failure test content';
      
      cy.get('[data-testid="file-input"]').selectFile({
        contents: Cypress.Buffer.from(fileContent),
        fileName: fileName,
        mimeType: 'application/pdf'
      });
      
      cy.get('[data-testid="upload-button"]').click();
      
      // Wait for upload to fail
      cy.wait('@uploadFailure');
      
      // Should show error message
      cy.get('[data-testid="upload-error"]').should('be.visible');
      cy.get('[data-testid="upload-error"]').should('contain', 'Upload failed');
    });
  });

  describe('Document Management', () => {
    beforeEach(() => {
      cy.get('[data-testid="documents-tab"]').click();
      
      // Upload a test document
      const fileName = 'management-test.pdf';
      const fileContent = 'Management test content';
      
      cy.get('[data-testid="file-input"]').selectFile({
        contents: Cypress.Buffer.from(fileContent),
        fileName: fileName,
        mimeType: 'application/pdf'
      });
      
      cy.get('[data-testid="upload-button"]').click();
      cy.wait('@uploadDocument');
    });

    it('should display uploaded documents in a list', () => {
      cy.get('[data-testid="uploaded-files-list"]').should('be.visible');
      cy.get('[data-testid="uploaded-file-item"]').should('have.length.at.least', 1);
    });

    it('should show document details', () => {
      cy.get('[data-testid="uploaded-file-item"]').first().within(() => {
        cy.get('[data-testid="file-name"]').should('be.visible');
        cy.get('[data-testid="file-size"]').should('be.visible');
        cy.get('[data-testid="upload-date"]').should('be.visible');
      });
    });

    it('should allow document preview', () => {
      cy.get('[data-testid="preview-button"]').first().click();
      
      // Should open preview modal
      cy.get('[data-testid="document-preview-modal"]').should('be.visible');
      cy.get('[data-testid="preview-iframe"]').should('be.visible');
    });

    it('should allow document download', () => {
      cy.get('[data-testid="download-button"]').first().click();
      
      // Should trigger download
      cy.window().its('downloads').should('include', 'management-test.pdf');
    });

    it('should allow document deletion', () => {
      // Mock delete API
      cy.intercept('DELETE', '/api/uploads/*', {
        statusCode: 200,
        body: { success: true }
      }).as('deleteDocument');
      
      cy.get('[data-testid="delete-button"]').first().click();
      
      // Should show confirmation dialog
      cy.get('[data-testid="delete-confirmation"]').should('be.visible');
      cy.get('[data-testid="confirm-delete-button"]').click();
      
      // Wait for delete to complete
      cy.wait('@deleteDocument');
      
      // Should remove file from list
      cy.get('[data-testid="uploaded-file-item"]').should('have.length', 0);
    });
  });

  describe('Form Integration', () => {
    it('should save document data when vendor is saved', () => {
      // Fill in vendor basic info
      cy.get('[data-testid="vendor-name-input"]').type('Test Vendor with Documents');
      cy.get('[data-testid="vendor-email-input"]').type('test@vendor.com');
      
      // Upload a document
      cy.get('[data-testid="documents-tab"]').click();
      const fileName = 'form-integration-test.pdf';
      const fileContent = 'Form integration test content';
      
      cy.get('[data-testid="file-input"]').selectFile({
        contents: Cypress.Buffer.from(fileContent),
        fileName: fileName,
        mimeType: 'application/pdf'
      });
      
      cy.get('[data-testid="upload-button"]').click();
      cy.wait('@uploadDocument');
      
      // Save the vendor
      cy.get('[data-testid="save-vendor-button"]').click();
      
      // Should include document data in the save request
      cy.wait('@saveVendor').then((interception) => {
        expect(interception.request.body).to.include({
          documents: [
            {
              fileName: fileName,
              fileUrl: 'https://example.com/uploads/test-document.pdf'
            }
          ]
        });
      });
    });

    it('should load existing documents when editing vendor', () => {
      // Mock vendor with existing documents
      cy.intercept('GET', '/api/vendors/vendor-1', {
        statusCode: 200,
        body: {
          success: true,
          data: {
            VendorId: 'vendor-1',
            Name: 'Existing Vendor',
            Documents: [
              {
                DocumentId: 'doc-1',
                FileName: 'existing-document.pdf',
                FileUrl: 'https://example.com/uploads/existing-document.pdf',
                UploadDate: '2024-01-01T00:00:00Z'
              }
            ]
          }
        }
      }).as('getVendorWithDocuments');
      
      // Edit existing vendor
      cy.get('[data-testid="edit-vendor-button"]').first().click();
      cy.wait('@getVendorWithDocuments');
      
      // Navigate to documents tab
      cy.get('[data-testid="documents-tab"]').click();
      
      // Should show existing documents
      cy.get('[data-testid="uploaded-files-list"]').should('contain', 'existing-document.pdf');
    });
  });

  describe('Error Handling', () => {
    it('should handle network errors during upload', () => {
      // Mock network error
      cy.intercept('POST', '/api/uploads', { forceNetworkError: true }).as('networkError');
      
      cy.get('[data-testid="documents-tab"]').click();
      
      const fileName = 'network-error-test.pdf';
      const fileContent = 'Network error test content';
      
      cy.get('[data-testid="file-input"]').selectFile({
        contents: Cypress.Buffer.from(fileContent),
        fileName: fileName,
        mimeType: 'application/pdf'
      });
      
      cy.get('[data-testid="upload-button"]').click();
      
      // Should show network error message
      cy.get('[data-testid="upload-error"]').should('be.visible');
      cy.get('[data-testid="upload-error"]').should('contain', 'Network error');
    });

    it('should handle server errors gracefully', () => {
      // Mock server error
      cy.intercept('POST', '/api/uploads', {
        statusCode: 500,
        body: {
          success: false,
          message: 'Internal server error'
        }
      }).as('serverError');
      
      cy.get('[data-testid="documents-tab"]').click();
      
      const fileName = 'server-error-test.pdf';
      const fileContent = 'Server error test content';
      
      cy.get('[data-testid="file-input"]').selectFile({
        contents: Cypress.Buffer.from(fileContent),
        fileName: fileName,
        mimeType: 'application/pdf'
      });
      
      cy.get('[data-testid="upload-button"]').click();
      
      // Should show server error message
      cy.get('[data-testid="upload-error"]').should('be.visible');
      cy.get('[data-testid="upload-error"]').should('contain', 'Internal server error');
    });
  });

  describe('Accessibility', () => {
    it('should have proper ARIA labels', () => {
      cy.get('[data-testid="documents-tab"]').click();
      
      cy.get('[data-testid="file-input"]').should('have.attr', 'aria-label');
      cy.get('[data-testid="upload-button"]').should('have.attr', 'aria-label');
      cy.get('[data-testid="upload-area"]').should('have.attr', 'aria-label');
    });

    it('should be keyboard navigable', () => {
      cy.get('[data-testid="documents-tab"]').click();
      
      // Should be able to navigate with keyboard
      cy.get('[data-testid="file-input"]').focus();
      cy.get('[data-testid="file-input"]').should('be.focused');
      
      cy.get('[data-testid="upload-button"]').focus();
      cy.get('[data-testid="upload-button"]').should('be.focused');
    });

    it('should announce upload status to screen readers', () => {
      cy.get('[data-testid="documents-tab"]').click();
      
      const fileName = 'accessibility-test.pdf';
      const fileContent = 'Accessibility test content';
      
      cy.get('[data-testid="file-input"]').selectFile({
        contents: Cypress.Buffer.from(fileContent),
        fileName: fileName,
        mimeType: 'application/pdf'
      });
      
      cy.get('[data-testid="upload-button"]').click();
      
      // Should have aria-live region for status updates
      cy.get('[data-testid="upload-status"]').should('have.attr', 'aria-live', 'polite');
    });
  });
});



