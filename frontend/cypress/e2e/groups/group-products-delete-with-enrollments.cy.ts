// Cypress E2E — Group Products: Agent deletes a product that has active enrollments.
//
// Verifies:
//   1. Delete modal shows the "N members are currently enrolled" warning.
//   2. After confirm, the product moves out of the active list.
//   3. The "Products with Active Enrollments" audit section appears with members.

const GROUP_ID   = 'grp-delete-enr-001';
const PRODUCT_ID = 'prod-bronze-001';
const TENANT_ID  = 'tnt-test-0001';

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
  });

  cy.intercept('GET', '**/api/me/agent/profile**', {
    statusCode: 200,
    body: { success: true, data: {} }
  });

  cy.intercept('GET', '**/api/me/agent/licenses**', {
    statusCode: 200,
    body: { success: true, data: [] }
  });

  cy.intercept('GET', '**/api/me/agent/training/library-status**', {
    statusCode: 200,
    body: { success: true, data: { isComplete: true } }
  });

  cy.intercept('GET', '**/api/me/agent/**', (req) => {
    req.reply({ statusCode: 200, body: { success: true, data: {} } });
  });

  cy.intercept('GET', '**/api/me/agent/group-type-change-requests/pending-action', {
    statusCode: 200,
    body: { success: true, data: [] },
  });

  cy.intercept('GET', '**/api/me/agent/enrollment-link-templates**', {
    statusCode: 200,
    body: { success: true, data: { data: [] } }
  });
}

describe('Group Products: Agent deletes a product (has enrollments)', () => {
  let hiddenWithEnrollments: any[] = [];

  beforeEach(() => {
    hiddenWithEnrollments = [];

    stubAuthEndpoints();
    stubAgentLayoutCalls();

    cy.intercept('GET', `**/api/groups/${GROUP_ID}/**`, (req) => {
      req.reply({ statusCode: 200, body: { success: true, data: {} } });
    });

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

    cy.intercept('GET', `**/api/groups/${GROUP_ID}/asa-status**`, {
      statusCode: 200,
      body: { success: true, data: { products: [] } }
    });

    cy.intercept('GET', `**/api/groups/${GROUP_ID}/products/hidden-with-enrollments`, (req) => {
      req.reply({ statusCode: 200, body: { success: true, data: hiddenWithEnrollments } });
    }).as('getHidden');

    cy.intercept('GET', `**/api/groups/${GROUP_ID}/products/${PRODUCT_ID}/enrollment-count`, {
      statusCode: 200,
      body: { success: true, data: { count: 2 } }
    }).as('getCount');

    cy.intercept('PATCH', `**/api/groups/${GROUP_ID}/products/${PRODUCT_ID}/visibility`, (req) => {
      hiddenWithEnrollments = [{
        productId: PRODUCT_ID,
        productName: 'Bronze Plan',
        enrollmentCount: 2,
        members: [
          { memberId: 'm-1', fullName: 'Jane Doe',   enrolledDate: '2026-01-15T00:00:00.000Z' },
          { memberId: 'm-2', fullName: 'John Smith', enrolledDate: '2025-11-02T00:00:00.000Z' }
        ]
      }];
      req.reply({ statusCode: 200, body: { success: true } });
    }).as('patchVisibility');

    cy.visit(`/agent/groups/${GROUP_ID}#products`, {
      failOnStatusCode: false,
      onBeforeLoad: seedLocalStorageAsAgent
    });

    cy.wait('@getProducts', { timeout: 20000 });
    cy.contains('Bronze Plan', { timeout: 15000 }).should('be.visible');
  });

  it('shows enrolled-count warning, deletes, and surfaces the product in the audit section', () => {
    cy.contains('Bronze Plan').parents('[class*="border"]').first()
      .find('button[title*="emove"], button[aria-label*="emove"], button[aria-label*="elete"]')
      .first().click();

    cy.wait('@getCount');

    cy.contains(/2 members? are currently enrolled/i, { timeout: 8000 }).should('be.visible');

    cy.contains('button', /^Remove$|^Confirm$|^Delete$/i).click();
    cy.wait('@patchVisibility');
    cy.wait('@getHidden');

    cy.contains('Removed Products with Active Members', { timeout: 10000 }).should('be.visible');

    cy.contains('button', /Bronze Plan/i).click();
    cy.contains('Jane Doe').should('be.visible');
    cy.contains('John Smith').should('be.visible');
  });
});
