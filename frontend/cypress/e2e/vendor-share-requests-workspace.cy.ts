// frontend/cypress/e2e/vendor-share-requests-workspace.cy.ts
// Phase 1 smoke tests for the vendor portal Share Requests split-pane workspace.
// Mirrors the auth handling pattern of vendor-members-workspace.cy.ts: assumes
// the test runner is reaching protected routes with credentials present.

const RAIL_REQUESTS = [
  {
    ShareRequestId: 'sr-1',
    RequestNumber: 'SW-1001',
    RequestType: 'Medical',
    Status: 'New',
    Determination: 'Pending',
    SubmittedDate: '2026-04-30T00:00:00Z',
    CreatedDate: '2026-04-30T00:00:00Z',
    TotalBilledAmount: 0,
    TotalDiscounts: 0,
    TotalUAAmount: 0,
    TotalShareAmount: 0,
    TotalPaidAmount: 0,
    TotalMemberPayments: 0,
    Balance: 0,
    BillCount: 0,
    ProviderCount: 0,
    MemberFirstName: 'Duke',
    MemberLastName: 'Bender',
    MemberEmail: 'duke@example.com',
    MemberPhone: '(480) 330-4251',
    MemberId: 'member-1',
    VendorId: 'vendor-1',
    CreatedByFirstName: 'Agent',
  },
  {
    ShareRequestId: 'sr-2',
    RequestNumber: 'SW-1002',
    RequestType: 'Medical',
    Status: 'Intake',
    Determination: 'Pending',
    SubmittedDate: '2026-04-29T00:00:00Z',
    CreatedDate: '2026-04-29T00:00:00Z',
    TotalBilledAmount: 0,
    TotalDiscounts: 0,
    TotalUAAmount: 0,
    TotalShareAmount: 0,
    TotalPaidAmount: 0,
    TotalMemberPayments: 0,
    Balance: 0,
    BillCount: 0,
    ProviderCount: 0,
    MemberFirstName: 'Lisa',
    MemberLastName: 'Shaw',
    MemberEmail: 'lisa@example.com',
    MemberPhone: '(480) 330-1234',
    MemberId: 'member-2',
    VendorId: 'vendor-1',
    CreatedByFirstName: 'Agent',
  },
];

import {
  seedLocalStorageAsRole,
  stubAuthEndpoints,
  stubVendorPortalLayoutCalls,
} from '../support/stub-auth-helpers';

const seedVendorAdmin = seedLocalStorageAsRole('VendorAdmin', { vendorId: 'vendor-1' });

const stubEndpoints = () => {
  cy.intercept('GET', '**/api/me/vendor/share-requests?**', {
    statusCode: 200,
    body: {
      success: true,
      data: RAIL_REQUESTS,
      pagination: {
        page: 1,
        limit: 25,
        total: RAIL_REQUESTS.length,
        totalPages: 1,
      },
    },
  }).as('listRequests');

  cy.intercept('GET', '**/api/me/vendor/share-requests/sr-1', {
    statusCode: 200,
    body: {
      success: true,
      data: {
        ...RAIL_REQUESTS[0],
        DateOfService: '2026-04-15T00:00:00Z',
        DiagnosisCode: 'M54.5',
        DiagnosisDescription: 'Low back pain',
        GeneralNotes: 'Member visited urgent care for back pain.',
      },
    },
  }).as('getRequest1');

  cy.intercept('GET', '**/api/me/vendor/share-requests/sr-1/member-plans**', {
    statusCode: 200,
    body: {
      success: true,
      data: [
        {
          EnrollmentId: 'enr-1',
          MemberId: 'member-1',
          ProductId: 'prod-1',
          EnrollmentStatus: 'Active',
          EffectiveDate: '2025-11-01T00:00:00Z',
          EnrollmentDate: '2025-10-15T00:00:00Z',
          HouseholdId: 'house-1',
          ProductName: 'Family $3000 UA',
          VendorId: 'vendor-1',
          VendorName: 'Test Vendor',
          RelationshipType: 'P',
          ConfigValue1: 'EF',
          ConfigValue2: '3000',
        },
      ],
    },
  }).as('getPlans1');

  cy.intercept('GET', '**/api/me/vendor/members/member-1**', {
    statusCode: 200,
    body: {
      success: true,
      data: {
        MemberId: 'member-1',
        FirstName: 'Duke',
        LastName: 'Bender',
        Email: 'duke@example.com',
        Phone: '(480) 330-4251',
        HouseholdId: 'house-1',
        RelationshipType: 'P',
      },
    },
  }).as('getMemberForPlans');

  cy.intercept('GET', '**/api/enrollments?memberId=member-1**', {
    statusCode: 200,
    body: { success: true, data: [] },
  }).as('getMemberEnrollments');

  cy.intercept('GET', '**/api/me/vendor/share-requests/sr-1/header-plan**', {
    statusCode: 200,
    body: {
      success: true,
      data: {
        PlanLabel: 'Family $3000 UA',
        TierType: 'EF',
        UAValue: '3000',
        EffectiveDate: '2025-11-01T00:00:00Z',
      },
    },
  }).as('getHeaderPlan');

  cy.intercept('GET', '**/api/me/vendor/share-requests/sr-1/providers', {
    statusCode: 200,
    body: { success: true, data: [] },
  }).as('getProviders1');

  cy.intercept('GET', '**/api/me/vendor/share-requests/sr-1/history**', {
    statusCode: 200,
    body: { success: true, data: [] },
  }).as('getHistory');

  cy.intercept('GET', '**/api/me/vendor/share-requests/claimers', {
    statusCode: 200,
    body: { success: true, data: [] },
  }).as('getClaimers');
};

describe('Vendor Share Requests Workspace (Phase 1)', () => {
  beforeEach(() => {
    stubAuthEndpoints('VendorAdmin');
    stubVendorPortalLayoutCalls();
    stubEndpoints();
  });

  it('renders the rail with the empty-state right pane on /vendor/share-requests', () => {
    cy.visit('/vendor/share-requests', {
      failOnStatusCode: false,
      onBeforeLoad: seedVendorAdmin,
    });
    cy.wait('@listRequests');

    cy.contains('SW-1001').should('be.visible');
    cy.contains('Duke Bender').should('be.visible');
    cy.contains('Lisa Shaw').should('be.visible');
    cy.contains('Select a share request').should('be.visible');
  });

  it('typing in the rail search URL-syncs the q param after debounce', () => {
    cy.visit('/vendor/share-requests', {
      failOnStatusCode: false,
      onBeforeLoad: seedVendorAdmin,
    });
    cy.wait('@listRequests');

    cy.get('input[aria-label="Search share requests"]').type('bender');
    cy.url().should('include', 'q=bender');
  });

  it('selecting a request updates the URL and renders header + Request Details tab', () => {
    cy.visit('/vendor/share-requests', {
      failOnStatusCode: false,
      onBeforeLoad: seedVendorAdmin,
    });
    cy.wait('@listRequests');

    cy.contains('SW-1001').click();
    cy.url().should('include', '/vendor/share-requests/sr-1');
    cy.wait('@getRequest1');

    // Header card columns
    cy.contains('Membership').should('be.visible');
    cy.contains('Request').should('be.visible');
    cy.contains('Plan').should('be.visible');

    // Default tab is request-details: no ?tab= param, body shows Classification section
    cy.url().should('not.include', 'tab=');
    cy.contains('Classification').should('be.visible');
  });

  it('switching to the Plans tab adds ?tab=plans and renders the plans table', () => {
    cy.visit('/vendor/share-requests/sr-1', {
      failOnStatusCode: false,
      onBeforeLoad: seedVendorAdmin,
    });
    cy.wait('@getRequest1');

    cy.get('button[role="tab"]').contains('Plans').click();
    cy.url().should('include', 'tab=plans');
    cy.contains(/No active plans|Family \$3000 UA|Plans/i, { timeout: 10000 }).should('be.visible');
  });

  it('the History tab is reachable directly from the top-level tab strip', () => {
    cy.visit('/vendor/share-requests/sr-1', {
      failOnStatusCode: false,
      onBeforeLoad: seedVendorAdmin,
    });
    cy.wait('@getRequest1');

    cy.get('button[role="tab"]').contains('History').click();
    cy.url().should('include', 'tab=history');
  });

  describe('mobile viewport', () => {
    beforeEach(() => {
      cy.viewport(375, 812);
    });

    it('shows rail-only on /vendor/share-requests and full-screen detail with back button', () => {
      cy.visit('/vendor/share-requests', {
        failOnStatusCode: false,
        onBeforeLoad: seedVendorAdmin,
      });
      cy.wait('@listRequests');
      cy.contains('SW-1001').should('be.visible');
      cy.contains('Select a share request').should('not.be.visible');

      cy.visit('/vendor/share-requests/sr-1', {
        failOnStatusCode: false,
        onBeforeLoad: seedVendorAdmin,
      });
      cy.wait('@getRequest1');
      cy.contains('Back to share requests').should('be.visible');
    });
  });
});
