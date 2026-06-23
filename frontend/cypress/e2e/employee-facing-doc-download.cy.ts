/// <reference types="cypress" />

/**
 * Smoke test: employee-facing doc list + download click
 *
 * HOW TO RUN LOCALLY (dev server must use relative API URLs so cy.intercept works):
 *   cd frontend
 *   VITE_API_URL='' npx vite &   # start Vite without absolute API baseURL
 *   npx cypress run --spec cypress/e2e/employee-facing-doc-download.cy.ts
 *
 * In CI the VITE_API_URL env should be left unset (or empty) so that Axios
 * uses relative paths that route through Vite's proxy — making them
 * same-origin and therefore interceptable by cy.intercept.
 *
 * With VITE_API_URL set to an absolute URL (e.g. http://localhost:3002),
 * Axios sends cross-origin XHR which Cypress-Electron does not intercept.
 *
 * The VITE_OAUTH_URL cross-origin fetch IS intercepted by cy.intercept
 * using the `**/auth/me` wildcard pattern (fetch goes through Cypress's proxy).
 */

// Fake JWT with a far-future exp so AuthContext won't consider it expired.
// Header: {"alg":"HS256","typ":"JWT"}
// Payload: {"sub":"test-agent-id","email":"agent@allaboard365.com","exp":9999999999}
const FAKE_JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
  'eyJzdWIiOiJ0ZXN0LWFnZW50LWlkIiwiZW1haWwiOiJhZ2VudEBhbGxhYm9hcmQzNjUuY29tIiwiZXhwIjo5OTk5OTk5OTk5fQ.' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const GROUP_ID = 'g1';
const DOC_ID = 'd1';

describe('Employee facing doc download', () => {
  beforeEach(() => {
    // ── Auth stubs ──────────────────────────────────────────────────────────
    // AuthContext calls OAuth /auth/me via fetch. The VITE_OAUTH_URL resolves
    // to http://localhost:3002 in .env, but cy.intercept with **/ wildcards
    // intercepts cross-origin fetch (fetch is proxied; XHR is not in Electron).
    cy.intercept({ method: 'GET', url: '**/auth/me' }, {
      statusCode: 200,
      body: {
        user: {
          userId: 'test-agent-id',
          email: 'agent@allaboard365.com',
          tenantId: 't1',
          roles: ['Agent'],
          firstName: 'Test',
          lastName: 'Agent'
        }
      }
    }).as('oauthMe');

    cy.intercept({ method: 'POST', url: '**/refresh' }, {
      statusCode: 200,
      body: { accessToken: FAKE_JWT, refreshToken: FAKE_JWT }
    }).as('refresh');

    // AuthContext step 2: /api/users/me (Axios, goes through Vite proxy when
    // VITE_API_URL is unset; interceptable as a same-origin relative path).
    cy.intercept('GET', '/api/users/me', {
      statusCode: 200,
      body: {
        success: true,
        data: {
          UserId: 'test-agent-id',
          Email: 'agent@allaboard365.com',
          TenantId: 't1',
          // `roles` (lowercase string[]) is the primary path in AuthContext
          roles: ['Agent'],
          currentRole: 'Agent'
        }
      }
    }).as('usersMe');

    // ── Group detail ────────────────────────────────────────────────────────
    cy.intercept('GET', `/api/groups/${GROUP_ID}`, {
      statusCode: 200,
      body: {
        success: true,
        data: {
          GroupId: GROUP_ID,
          Name: 'Test Group',
          TenantId: 't1',
          TotalMembers: 3,
          Status: 'Active'
        }
      }
    }).as('getGroup');

    // ── Employee docs — the endpoints this test exercises ───────────────────
    cy.intercept('GET', `/api/groups/${GROUP_ID}/employee-docs`, {
      statusCode: 200,
      body: {
        success: true,
        data: [
          {
            proposalDocumentId: DOC_ID,
            name: 'Employee Facing (Gold)',
            productId: 'p1',
            productName: 'Gold'
          }
        ]
      }
    }).as('listDocs');

    cy.intercept(
      'GET',
      `/api/groups/${GROUP_ID}/employee-docs/${DOC_ID}/download`,
      {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `inline; filename="Group-Gold.pdf"`
        },
        body: '%PDF-1.4 test'
      }
    ).as('downloadDoc');

    // ── Ancillary stubs so the group detail page doesn't throw ─────────────
    cy.intercept('GET', `/api/groups/${GROUP_ID}/members*`, {
      statusCode: 200,
      body: { success: true, data: [], pagination: { total: 0 } }
    });
    cy.intercept('GET', '/api/groups/*/products*', {
      statusCode: 200, body: { success: true, data: [] }
    });
    cy.intercept('GET', '/api/groups/*/contributions*', {
      statusCode: 200, body: { success: true, data: [] }
    });
    cy.intercept('GET', '/api/groups/*/billing*', {
      statusCode: 200, body: { success: true, data: {} }
    });
    cy.intercept('GET', '/api/groups/*/documents*', {
      statusCode: 200, body: { success: true, data: [] }
    });
    cy.intercept('GET', '/api/groups/*/setup-status*', {
      statusCode: 200, body: { success: true, data: {} }
    });
    cy.intercept('GET', '/api/agents/w9-requirement*', {
      statusCode: 200, body: { success: true, data: { required: false } }
    });
    cy.intercept('GET', '/api/me/agent/groups*', {
      statusCode: 200, body: { success: true, data: [] }
    });
  });

  it('shows Download Employee Doc button and fires window.open on click', () => {
    // Navigate directly to the Members tab (GroupDetails uses hash-based routing).
    // Seed localStorage in onBeforeLoad so AuthLayout + ProtectedRoute see a
    // valid session before the first React render.
    cy.visit(`/agent/groups/${GROUP_ID}#members`, {
      onBeforeLoad(win) {
        win.localStorage.setItem('accessToken', FAKE_JWT);
        win.localStorage.setItem('refreshToken', FAKE_JWT);
        win.localStorage.setItem('userId', 'test-agent-id');
        win.localStorage.setItem('userEmail', 'agent@allaboard365.com');
        win.localStorage.setItem('roles', JSON.stringify(['Agent']));
        win.localStorage.setItem('currentRole', 'Agent');
        win.localStorage.setItem('tenantId', 't1');
        win.localStorage.setItem('currentTenantId', 't1');
      }
    });

    // Wait for the employee-docs list — proves the Members tab rendered and
    // useGroupEmployeeDocs fired.
    cy.wait('@listDocs');

    // Stub window.open before clicking so we can spy on the call.
    cy.window().then((win) => {
      cy.stub(win, 'open').as('winOpen');
    });

    // GroupMembersTab renders "Download Employee Doc" when exactly one doc exists.
    cy.contains('button', 'Download Employee Doc').click();

    cy.get('@winOpen').should(
      'have.been.calledWithMatch',
      new RegExp(`/api/groups/${GROUP_ID}/employee-docs/${DOC_ID}/download`)
    );
  });
});
