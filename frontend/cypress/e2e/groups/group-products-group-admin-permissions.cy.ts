// Cypress E2E — Group Products: Group Admin sees no delete UI.
//
// Verifies:
//   1. Group Admin sees the active product, but NO Delete button.
//   2. NO "Products with Active Enrollments" audit section.
//   3. NO "Show hidden products" checkbox (legacy UI removed for everyone).

const GROUP_ID  = 'grp-perms-001';
const TENANT_ID = 'tnt-test-0001';

function makeFakeJwt(subject: string): string {
  const payload = { sub: subject, exp: Math.floor(Date.now() / 1000) + 7200 };
  const header  = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).replace(/=/g, '');
  const body    = btoa(JSON.stringify(payload)).replace(/=/g, '');
  return `${header}.${body}.fakesig`;
}

function seedLocalStorageAsGroupAdmin(win: Window) {
  const token = makeFakeJwt('usr-ga-001');
  win.localStorage.setItem('accessToken', token);
  win.localStorage.setItem('refreshToken', 'unused-refresh-token');
  win.localStorage.setItem('userId', 'usr-ga-001');
  win.localStorage.setItem('userEmail', 'ga@test.com');
  win.localStorage.setItem('currentRole', 'GroupAdmin');
  win.localStorage.setItem('roles', JSON.stringify(['GroupAdmin']));
  win.localStorage.setItem('tenantId', TENANT_ID);
  win.localStorage.setItem('currentTenantId', TENANT_ID);
}

function stubAuthEndpoints() {
  cy.intercept('GET', '**/auth/me', {
    statusCode: 200,
    body: { user: { userId: 'usr-ga-001', email: 'ga@test.com' } }
  });

  cy.intercept('POST', '**/auth/refresh', {
    statusCode: 200,
    body: { accessToken: makeFakeJwt('usr-ga-001'), refreshToken: 'unused-refresh-token' }
  });

  cy.intercept('GET', '**/api/users/me', {
    statusCode: 200,
    body: {
      success: true,
      data: {
        UserId: 'usr-ga-001',
        Email: 'ga@test.com',
        TenantId: TENANT_ID,
        currentTenantId: TENANT_ID,
        roles: ['GroupAdmin'],
        currentRole: 'GroupAdmin'
      }
    }
  });
}

function stubLayoutCalls() {
  cy.intercept('GET', '**/api/me/group-admin/**', (req) => {
    req.reply({ statusCode: 200, body: { success: true, data: {} } });
  });
  cy.intercept('GET', '**/api/me/agent/**', (req) => {
    req.reply({ statusCode: 200, body: { success: true, data: {} } });
  });
  cy.intercept('GET', '**/api/me/agent/group-type-change-requests/pending-action', {
    statusCode: 200,
    body: { success: true, data: [] },
  });
}

describe('Group Products: Group Admin sees no delete UI', () => {
  beforeEach(() => {
    stubAuthEndpoints();
    stubLayoutCalls();

    cy.intercept('GET', `**/api/groups/${GROUP_ID}/**`, (req) => {
      req.reply({ statusCode: 200, body: { success: true, data: {} } });
    });

    cy.intercept('GET', '**/api/me/group-admin/group', {
      statusCode: 200,
      body: {
        success: true,
        data: {
          GroupId: GROUP_ID,
          Name: 'Acme Corp',
          GroupType: 'Standard',
          TenantId: TENANT_ID,
          Status: 'Active',
        },
      },
    });

    cy.intercept('GET', `**/api/me/group-admin/groups/${GROUP_ID}`, {
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
    });

    cy.intercept('GET', `**/api/groups/${GROUP_ID}/products**`, {
      statusCode: 200,
      body: {
        success: true,
        data: {
          groupProducts: [
            { ProductId: 'p-1', Name: 'Bronze', SalesType: 'Both', IsHidden: false }
          ],
          availableProducts: []
        }
      }
    }).as('getProducts');

    cy.intercept('GET', `**/api/groups/${GROUP_ID}/asa-status**`, {
      statusCode: 200,
      body: { success: true, data: { products: [] } }
    });

    // The frontend should NOT request hidden-with-enrollments for Group Admins
    // (the hook is gated by canEditProducts). If the call happens, this stub
    // returns an empty array so the test continues; the assertion below verifies
    // the audit section does not render anyway.
    cy.intercept('GET', `**/api/groups/${GROUP_ID}/products/hidden-with-enrollments`, {
      statusCode: 200,
      body: { success: true, data: [] }
    }).as('getHidden');
  });

  it('Group Admin sees no Delete buttons, no audit section, no Show-hidden checkbox', () => {
    cy.visit(`/group-admin/groups/${GROUP_ID}#products`, {
      failOnStatusCode: false,
      onBeforeLoad: seedLocalStorageAsGroupAdmin
    });

    cy.wait('@getProducts', { timeout: 20000 });
    cy.contains('Bronze', { timeout: 15000 }).should('be.visible');

    // No Delete button anywhere
    cy.get('body').then(($body) => {
      const deleteButtons = $body.find('button').filter((_, el) => {
        const text = (el as HTMLButtonElement).innerText.trim();
        const aria = el.getAttribute('aria-label') || '';
        return /^Delete$|^Remove$/i.test(text) || /delete|remove/i.test(aria);
      });
      expect(deleteButtons.length, 'no Delete/Remove buttons rendered for GroupAdmin').to.eq(0);
    });

    // No audit section
    cy.contains(/Products with Active Enrollments/i).should('not.exist');

    // No legacy "Show hidden products" checkbox
    cy.contains(/Show hidden products/i).should('not.exist');
  });
});
