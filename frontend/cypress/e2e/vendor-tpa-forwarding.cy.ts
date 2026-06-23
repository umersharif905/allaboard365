// frontend/cypress/e2e/vendor-tpa-forwarding.cy.ts
// Stub-driven smoke test for TPA case forwarding. No DB, no real SendGrid —
// the preview/send endpoints are intercepted. Mirrors the auth + layout
// stubbing pattern of vendor-members-workspace.cy.ts.

import {
  seedLocalStorageAsRole,
  stubAuthEndpoints,
  stubVendorPortalLayoutCalls,
} from '../support/stub-auth-helpers';

const seedVendorAdmin = seedLocalStorageAsRole('VendorAdmin', { vendorId: 'vendor-1' });

const FORWARDING_TARGET = { targetId: 't1', label: 'ARM', planVendorId: 'v-arm' };

const CASE_ROW = {
  CaseId: 'case-1',
  CaseNumber: 'CASE-2026-0001',
  MemberId: 'member-1',
  Status: 'Open',
  CaseType: 'reimbursement',
  CaseSubcategory: 'preventative',
  Title: 'Preventative reimbursement',
  SubmittedDate: '2026-05-20T00:00:00Z',
  MemberFirstName: 'Sarah',
  MemberLastName: 'Bartholomew',
  MemberEmail: 'sarah@example.com',
  ForwardingTarget: FORWARDING_TARGET,
};

const stubCaseEndpoints = () => {
  cy.intercept('GET', '**/api/me/vendor/cases/taxonomy', {
    statusCode: 200,
    body: { success: true, data: { types: [], subcategories: [] } },
  }).as('taxonomy');

  cy.intercept('GET', '**/api/me/vendor/cases/claimers', {
    statusCode: 200,
    body: { success: true, data: [] },
  }).as('claimers');

  cy.intercept('GET', '**/api/me/vendor/cases?**', {
    statusCode: 200,
    body: {
      success: true,
      data: [CASE_ROW],
      pagination: { page: 1, limit: 25, total: 1, totalPages: 1 },
    },
  }).as('caseList');

  cy.intercept('GET', '**/api/me/vendor/cases/case-1', {
    statusCode: 200,
    body: { success: true, data: CASE_ROW },
  }).as('caseDetail');

  // Tab content endpoints — keep them quiet so the workspace renders cleanly.
  cy.intercept('GET', '**/api/me/vendor/cases/case-1/**', {
    statusCode: 200,
    body: { success: true, data: [] },
  }).as('caseSubresources');

  // Forwarding preview + send.
  cy.intercept('GET', '**/api/me/vendor/case-forwarding/cases/case-1/preview', {
    statusCode: 200,
    body: {
      success: true,
      data: {
        target: { targetId: 't1', label: 'ARM' },
        recipients: ['intake@arm.example', 'ops@arm.example'],
        subject: 'Reimbursement request — CASE-2026-0001',
        body: 'Please process the attached reimbursement request.',
        documents: [{ DocumentId: 'doc-1', DocumentName: 'Itemized bill', FileName: 'bill.pdf' }],
        priorSends: [],
      },
    },
  }).as('preview');

  cy.intercept('POST', '**/api/me/vendor/case-forwarding/cases/case-1/send', {
    statusCode: 200,
    body: { success: true, data: { messageId: 'm-1', recipients: ['intake@arm.example'] } },
  }).as('send');
};

describe('Vendor TPA case forwarding', () => {
  beforeEach(() => {
    stubAuthEndpoints('VendorAdmin');
    stubVendorPortalLayoutCalls();
    stubCaseEndpoints();
  });

  it('shows the TPA badge on the case row', () => {
    cy.visit('/vendor/cases', { failOnStatusCode: false, onBeforeLoad: seedVendorAdmin });
    cy.wait('@caseList');
    cy.contains('CASE-2026-0001').should('be.visible');
    cy.contains('ARM').should('be.visible');
  });

  it('generates a preview and sends to a selected recipient', () => {
    cy.visit('/vendor/cases/case-1', { failOnStatusCode: false, onBeforeLoad: seedVendorAdmin });
    cy.wait('@caseDetail');

    cy.contains('button', 'Generate Email Report').click();
    cy.wait('@preview');

    cy.contains('Forward to ARM').should('be.visible');
    cy.contains('intake@arm.example').should('be.visible');
    cy.contains('Itemized bill').should('be.visible');

    cy.contains('button', 'Send').click();
    cy.wait('@send').its('request.body.to').should('include', 'intake@arm.example');
  });
});
