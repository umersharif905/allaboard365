// frontend/cypress/e2e/vendor-members-workspace.cy.ts
// Smoke tests for the vendor portal Members split-pane workspace.
// Mirrors the auth handling pattern of vendor-document-upload.cy.ts: assumes
// the test runner is reaching protected routes with credentials present.

const RAIL_MEMBERS = [
  {
    MemberId: 'member-1',
    HouseholdId: 'household-1',
    HouseholdMemberID: 'T685409225',
    RelationshipType: 'P',
    FirstName: 'Sarah',
    LastName: 'Bartholomew',
    Email: 'sarah@example.com',
    ActiveEnrollments: 1,
  },
  {
    MemberId: 'member-2',
    HouseholdId: 'household-2',
    HouseholdMemberID: '482862486',
    RelationshipType: 'P',
    FirstName: 'Tim',
    LastName: 'Madole',
    Email: 'tim@example.com',
    ActiveEnrollments: 0,
  },
];

import {
  seedLocalStorageAsRole,
  stubAuthEndpoints,
  stubVendorPortalLayoutCalls,
} from '../support/stub-auth-helpers';

const seedVendorAdmin = seedLocalStorageAsRole('VendorAdmin', { vendorId: 'vendor-1' });

const stubVendorEndpoints = () => {
  cy.intercept('GET', '**/api/me/vendor/members?**', {
    statusCode: 200,
    body: {
      success: true,
      data: RAIL_MEMBERS,
      pagination: { page: 1, limit: 25, total: RAIL_MEMBERS.length, totalPages: 1 },
    },
  }).as('getMembers');

  cy.intercept('GET', '**/api/me/vendor/members/member-1', {
    statusCode: 200,
    body: {
      success: true,
      data: {
        MemberId: 'member-1',
        HouseholdId: 'household-1',
        HouseholdMemberID: 'T685409225',
        RelationshipType: 'P',
        FirstName: 'Sarah',
        LastName: 'Bartholomew',
        Email: 'sarah@example.com',
        Phone: '(615) 415-3129',
        Address: '144 Cheek Rd.',
        City: 'Nashville',
        State: 'TN',
        ZipCode: '37205',
        DateOfBirth: '1988-12-01T00:00:00Z',
        Gender: 'F',
      },
    },
  }).as('getMember');

  cy.intercept('GET', '**/api/me/vendor/members/unknown-id', {
    statusCode: 404,
    body: { success: false, message: 'Not found' },
  }).as('getUnknownMember');

  cy.intercept('GET', '**/api/me/vendor/share-requests/dashboard', {
    statusCode: 200,
    body: { success: true, data: {} },
  }).as('shareRequestsProbe');

  cy.intercept('GET', '**/api/me/vendor/share-requests/member-plans/*', {
    statusCode: 200,
    body: { success: true, data: [] },
  }).as('memberPlans');

  cy.intercept('GET', '**/api/enrollments?memberId=member-1**', {
    statusCode: 200,
    body: { success: true, data: [] },
  }).as('getMemberEnrollments');

  cy.intercept('GET', '**/api/me/vendor/members/member-1/notes', {
    statusCode: 200,
    body: { success: true, data: [] },
  }).as('getMemberNotes');

  cy.intercept('GET', '**/api/me/vendor/share-requests?memberId=**', {
    statusCode: 200,
    body: { success: true, data: [] },
  }).as('memberShareRequests');

  cy.intercept('GET', '**/api/me/vendor/share-requests/claimers', {
    statusCode: 200,
    body: { success: true, data: [] },
  }).as('getClaimers');
};

describe('Vendor Members Workspace', () => {
  beforeEach(() => {
    stubAuthEndpoints('VendorAdmin');
    stubVendorPortalLayoutCalls();
    stubVendorEndpoints();
  });

  it('renders the rail with the empty-state right pane on /vendor/members', () => {
    cy.visit('/vendor/members', {
      failOnStatusCode: false,
      onBeforeLoad: seedVendorAdmin,
    });
    cy.wait('@getMembers');

    cy.contains('Sarah Bartholomew').should('be.visible');
    cy.contains('Tim Madole').should('be.visible');
    cy.contains('Select a member').should('be.visible');
  });

  it('selecting a member updates the URL and renders the Details tab', () => {
    cy.visit('/vendor/members', {
      failOnStatusCode: false,
      onBeforeLoad: seedVendorAdmin,
    });
    cy.wait('@getMembers');

    cy.contains('Sarah Bartholomew').click();
    cy.url().should('include', '/vendor/members/member-1');
    cy.wait('@getMember');

    cy.contains('Member Details').should('be.visible');
    cy.get('input[value="Sarah"]').should('exist');
    cy.get('input[value="Bartholomew"]').should('exist');
  });

  it('switching tabs updates the ?tab= query param', () => {
    cy.visit('/vendor/members/member-1', {
      failOnStatusCode: false,
      onBeforeLoad: seedVendorAdmin,
    });
    cy.wait('@getMember');

    cy.contains('button[role="tab"]', 'Plans').click();
    cy.url().should('include', 'tab=plans');
    cy.contains(/No active plans|Plans/i, { timeout: 10000 }).should('be.visible');

    cy.contains('button[role="tab"]', 'Notes').click({ scrollBehavior: 'center' });
    cy.url().should('include', 'tab=notes');
    cy.get('[role="tabpanel"]').should('be.visible');
  });

  it('deep-linking to an unknown member shows an error empty state but keeps the rail', () => {
    cy.visit('/vendor/members/unknown-id', {
      failOnStatusCode: false,
      onBeforeLoad: seedVendorAdmin,
    });
    cy.wait('@getMembers');
    cy.wait('@getUnknownMember');

    cy.contains('Sarah Bartholomew').should('be.visible');
    cy.contains(/Member not found|Unable to load member details/).should('be.visible');
  });

  it('the New Request tab renders the inline share request form', () => {
    cy.intercept('GET', '**/api/me/vendor/request-types', {
      statusCode: 200,
      body: { success: true, data: [] },
    }).as('requestTypes');

    cy.visit('/vendor/members/member-1?tab=new-request', {
      failOnStatusCode: false,
      onBeforeLoad: seedVendorAdmin,
    });
    cy.wait('@getMember');

    cy.url().should('include', 'tab=new-request');
    cy.contains('h1', 'New Share Request', { timeout: 10000 }).should('be.visible');
  });

  describe('mobile viewport', () => {
    beforeEach(() => {
      cy.viewport(375, 812);
    });

    it('shows rail-only on /vendor/members and hides it on /vendor/members/:id', () => {
      cy.visit('/vendor/members', {
        failOnStatusCode: false,
        onBeforeLoad: seedVendorAdmin,
      });
      cy.wait('@getMembers');
      cy.contains('Sarah Bartholomew').should('be.visible');
      cy.contains('Select a member').should('not.be.visible');

      cy.visit('/vendor/members/member-1', {
        failOnStatusCode: false,
        onBeforeLoad: seedVendorAdmin,
      });
      cy.wait('@getMember');
      cy.contains('Back to members').should('be.visible');
    });
  });
});
