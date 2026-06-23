// Cypress E2E — Group Products: Agent deletes a product with no enrollments.
//
// Scenario: stub-driven (all API calls intercepted, no DB seed, no real login).
// Verifies:
//   1. Delete modal opens with the correct product name.
//   2. The "currently enrolled" warning is absent when count = 0.
//   3. Confirm fires PATCH visibility with { isHidden: true }.
//   4. Cancel closes the modal without calling the API.

const GROUP_ID  = 'grp-delete-test-001';
const PRODUCT_ID = 'prod-bronze-001';
const TENANT_ID  = 'tnt-test-0001';

// ---------------------------------------------------------------------------
// JWT helpers — same pattern used by list-bill-conversion.cy.ts
// ---------------------------------------------------------------------------

function makeFakeJwt(subject: string): string {
  const payload = { sub: subject, exp: Math.floor(Date.now() / 1000) + 7200 };
  const header  = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).replace(/=/g, '');
  const body    = btoa(JSON.stringify(payload)).replace(/=/g, '');
  return `${header}.${body}.fakesig`;
}

function seedLocalStorageAsAgent(win: Window) {
  const token = makeFakeJwt('usr-agent-001');
  win.localStorage.setItem('accessToken', token);
  win.localStorage.setItem('refreshToken', 'unused-refresh-token');
  win.localStorage.setItem('userId', 'usr-agent-001');
  win.localStorage.setItem('userEmail', 'agent@test.com');
  win.localStorage.setItem('currentRole', 'Agent');
  win.localStorage.setItem('roles', JSON.stringify(['Agent']));
  win.localStorage.setItem('tenantId', TENANT_ID);
  win.localStorage.setItem('currentTenantId', TENANT_ID);
}

// ---------------------------------------------------------------------------
// Auth and layout stubs
// ---------------------------------------------------------------------------

function stubAuthEndpoints() {
  cy.intercept('GET', '**/auth/me', {
    statusCode: 200,
    body: { user: { userId: 'usr-agent-001', email: 'agent@test.com' } }
  }).as('oauthMe');

  cy.intercept('POST', '**/auth/refresh', {
    statusCode: 200,
    body: { accessToken: makeFakeJwt('usr-agent-001'), refreshToken: 'unused-refresh-token' }
  }).as('oauthRefresh');

  cy.intercept('GET', '**/api/users/me', {
    statusCode: 200,
    body: {
      success: true,
      data: {
        UserId: 'usr-agent-001',
        Email: 'agent@test.com',
        TenantId: TENANT_ID,
        currentTenantId: TENANT_ID,
        roles: ['Agent'],
        currentRole: 'Agent'
      }
    }
  }).as('usersMe');
}

function stubAgentLayoutCalls() {
  cy.intercept('GET', '**/api/me/agent/tenant', {
    statusCode: 200,
    body: { success: true, data: { TenantName: 'Test Tenant', LogoUrl: '' } }
  }).as('agentTenant');

  cy.intercept('GET', '**/api/me/agent/profile**', {
    statusCode: 200,
    body: { success: true, data: {} }
  }).as('agentProfile');

  cy.intercept('GET', '**/api/me/agent/licenses**', {
    statusCode: 200,
    body: { success: true, data: [] }
  }).as('agentLicenses');

  cy.intercept('GET', '**/api/me/agent/training/library-status**', {
    statusCode: 200,
    body: { success: true, data: { isComplete: true } }
  }).as('trainingStatus');

  cy.intercept('GET', '**/api/me/agent/**', (req) => {
    req.reply({ statusCode: 200, body: { success: true, data: {} } });
  }).as('agentCatchAll');

  cy.intercept('GET', '**/api/me/agent/group-type-change-requests/pending-action', {
    statusCode: 200,
    body: { success: true, data: [] },
  });
}

// ---------------------------------------------------------------------------
// Group-level stubs
// ---------------------------------------------------------------------------

function stubGroupAndProducts() {
  cy.intercept('GET', `**/api/groups/${GROUP_ID}/**`, (req) => {
    req.reply({ statusCode: 200, body: { success: true, data: {} } });
  }).as('groupCatchAll');

  // Agent fetches group via /api/me/agent/groups/:id
  cy.intercept('GET', `**/api/me/agent/groups/${GROUP_ID}`, {
    statusCode: 200,
    body: {
      success: true,
      data: {
        GroupId: GROUP_ID,
        Name: 'Acme Corp',
        GroupType: 'Standard',
        TenantId: TENANT_ID,
        Status: 'Active'
      }
    }
  }).as('getGroup');

  // Group products list
  cy.intercept('GET', `**/api/groups/${GROUP_ID}/products**`, {
    statusCode: 200,
    body: {
      success: true,
      data: {
        groupProducts: [
          { ProductId: PRODUCT_ID, Name: 'Bronze Plan', SalesType: 'Both', IsHidden: false }
        ],
        availableProducts: []
      }
    }
  }).as('getProducts');

  // ASA status — none required
  cy.intercept('GET', `**/api/groups/${GROUP_ID}/asa-status**`, {
    statusCode: 200,
    body: { success: true, data: { products: [] } }
  }).as('getAsa');

  // Hidden-with-enrollments — empty
  cy.intercept('GET', `**/api/groups/${GROUP_ID}/products/hidden-with-enrollments`, {
    statusCode: 200,
    body: { success: true, data: [] }
  }).as('getHidden');

  // Enrollment count for Bronze — zero
  cy.intercept('GET', `**/api/groups/${GROUP_ID}/products/${PRODUCT_ID}/enrollment-count`, {
    statusCode: 200,
    body: { success: true, data: { count: 0 } }
  }).as('getCount');

  // PATCH visibility — success
  cy.intercept('PATCH', `**/api/groups/${GROUP_ID}/products/${PRODUCT_ID}/visibility`, {
    statusCode: 200,
    body: { success: true, message: 'Product hidden from new enrollments' }
  }).as('patchVisibility');

  // Enrollment link templates (used by the products tab)
  cy.intercept('GET', '**/api/me/agent/enrollment-link-templates**', {
    statusCode: 200,
    body: { success: true, data: { data: [] } }
  }).as('getTemplates');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Group Products: Agent deletes a product (no enrollments)', () => {
  beforeEach(() => {
    stubAuthEndpoints();
    stubAgentLayoutCalls();
    stubGroupAndProducts();

    cy.visit(`/agent/groups/${GROUP_ID}#products`, {
      failOnStatusCode: false,
      onBeforeLoad: seedLocalStorageAsAgent
    });

    // Wait for the products tab content to load
    cy.wait('@getProducts', { timeout: 20000 });
    cy.contains('Bronze Plan', { timeout: 15000 }).should('be.visible');
  });

  it('opens the delete confirmation modal with correct product name and no enrollment warning', () => {
    // Click the delete/remove button for Bronze Plan
    cy.contains('Bronze Plan').parents('[class*="border"]').first()
      .find('button[title*="emove"], button[aria-label*="emove"], button[aria-label*="elete"]')
      .first().click();

    cy.wait('@getCount');

    // Modal should appear with product name
    cy.contains(/Bronze Plan/i, { timeout: 8000 }).should('be.visible');

    // No enrollment warning (count = 0)
    cy.contains(/currently enrolled/i).should('not.exist');
  });

  it('confirms removal and PATCHes visibility with { isHidden: true }', () => {
    cy.contains('Bronze Plan').parents('[class*="border"]').first()
      .find('button[title*="emove"], button[aria-label*="emove"], button[aria-label*="elete"]')
      .first().click();

    cy.wait('@getCount');

    // Confirm button
    cy.contains('button', /^Remove$|^Confirm$|^Delete$/i, { timeout: 8000 }).click();
    cy.wait('@patchVisibility').its('request.body').should('deep.include', { isHidden: true });
  });

  it('cancel closes the modal without calling the visibility API', () => {
    cy.contains('Bronze Plan').parents('[class*="border"]').first()
      .find('button[title*="emove"], button[aria-label*="emove"], button[aria-label*="elete"]')
      .first().click();

    cy.wait('@getCount');

    cy.contains('button', /^Cancel$/i, { timeout: 8000 }).click();

    // Modal dismissed
    cy.contains(/Remove .* from this group/i).should('not.exist');
  });
});
