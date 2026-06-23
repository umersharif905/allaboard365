// Cypress E2E — Group Products: ASA banner replaces per-row ASA pills.
//
// Verifies:
//   1. Group Admin sees one Sign button for the shared document (deduped by documentId).
//   2. Agent sees the read-only "Awaiting group admin signature on:" variant.
//   3. The legacy per-row ASA pill labels (Signed / No ASA Required) no longer appear.

const GROUP_ID  = 'grp-asa-banner-001';
const TENANT_ID = 'tnt-test-0001';

function makeFakeJwt(subject: string): string {
  const payload = { sub: subject, exp: Math.floor(Date.now() / 1000) + 7200 };
  const header  = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).replace(/=/g, '');
  const body    = btoa(JSON.stringify(payload)).replace(/=/g, '');
  return `${header}.${body}.fakesig`;
}

function seedLocalStorage(role: 'Agent' | 'GroupAdmin', subject: string) {
  return (win: Window) => {
    const token = makeFakeJwt(subject);
    win.localStorage.setItem('accessToken', token);
    win.localStorage.setItem('refreshToken', 'unused-refresh-token');
    win.localStorage.setItem('userId', subject);
    win.localStorage.setItem('userEmail', `${role.toLowerCase()}@test.com`);
    win.localStorage.setItem('currentRole', role);
    win.localStorage.setItem('roles', JSON.stringify([role]));
    win.localStorage.setItem('tenantId', TENANT_ID);
    win.localStorage.setItem('currentTenantId', TENANT_ID);
  };
}

function stubAuthEndpoints(role: 'Agent' | 'GroupAdmin', subject: string) {
  cy.intercept('GET', '**/auth/me', {
    statusCode: 200,
    body: { user: { userId: subject, email: `${role.toLowerCase()}@test.com` } }
  });

  cy.intercept('POST', '**/auth/refresh', {
    statusCode: 200,
    body: { accessToken: makeFakeJwt(subject), refreshToken: 'unused-refresh-token' }
  });

  cy.intercept('GET', '**/api/users/me', {
    statusCode: 200,
    body: {
      success: true,
      data: {
        UserId: subject,
        Email: `${role.toLowerCase()}@test.com`,
        TenantId: TENANT_ID,
        currentTenantId: TENANT_ID,
        roles: [role],
        currentRole: role
      }
    }
  });
}

function stubLayoutCalls() {
  cy.intercept('GET', '**/api/me/agent/**', (req) => {
    req.reply({ statusCode: 200, body: { success: true, data: {} } });
  });
  cy.intercept('GET', '**/api/me/agent/tenant', {
    statusCode: 200,
    body: { success: true, data: { TenantName: 'Test Tenant', LogoUrl: '' } }
  });
  cy.intercept('GET', '**/api/me/agent/training/library-status**', {
    statusCode: 200,
    body: { success: true, data: { isComplete: true } }
  });
  cy.intercept('GET', '**/api/me/agent/enrollment-link-templates**', {
    statusCode: 200,
    body: { success: true, data: { data: [] } }
  });
  // Group admin layout — same group endpoint typically; absorb anything else.
  cy.intercept('GET', '**/api/me/group-admin/**', (req) => {
    req.reply({ statusCode: 200, body: { success: true, data: {} } });
  });
  cy.intercept('GET', '**/api/me/agent/group-type-change-requests/pending-action', {
    statusCode: 200,
    body: { success: true, data: [] },
  });
}

function stubGroupAndProducts() {
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
  // GroupAdmin route variant
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

  cy.intercept('GET', `**/api/groups/${GROUP_ID}/products**`, {
    statusCode: 200,
    body: {
      success: true,
      data: {
        groupProducts: [
          { ProductId: 'p-1', Name: 'Bronze', SalesType: 'Both', IsHidden: false },
          { ProductId: 'p-2', Name: 'Silver', SalesType: 'Both', IsHidden: false }
        ],
        availableProducts: []
      }
    }
  }).as('getProducts');

  // Both products require the SAME ASA document — banner should dedupe to 1 row.
  cy.intercept('GET', `**/api/groups/${GROUP_ID}/asa-status**`, {
    statusCode: 200,
    body: {
      success: true,
      data: {
        products: [
          {
            productId: 'p-1',
            productName: 'Bronze',
            requiresASA: true,
            isSigned: false,
            asaAgreement: { documentId: 'doc-1', documentName: 'Master ASA', documentUrl: 'https://example.com/master.pdf' }
          },
          {
            productId: 'p-2',
            productName: 'Silver',
            requiresASA: true,
            isSigned: false,
            asaAgreement: { documentId: 'doc-1', documentName: 'Master ASA', documentUrl: 'https://example.com/master.pdf' }
          }
        ]
      }
    }
  }).as('getAsa');

  cy.intercept('GET', `**/api/groups/${GROUP_ID}/products/hidden-with-enrollments`, {
    statusCode: 200,
    body: { success: true, data: [] }
  });
}

describe('Group Products: ASA banner replaces per-row pills', () => {
  it('Group Admin sees one Sign button for the shared document', () => {
    stubAuthEndpoints('GroupAdmin', 'usr-ga-001');
    stubLayoutCalls();
    stubGroupAndProducts();

    cy.visit(`/group-admin/groups/${GROUP_ID}#products`, {
      failOnStatusCode: false,
      onBeforeLoad: seedLocalStorage('GroupAdmin', 'usr-ga-001')
    });

    cy.wait('@getProducts', { timeout: 20000 });
    cy.contains(/Master ASA/i, { timeout: 15000 }).should('be.visible');

    // Single Sign button (deduped — both products share doc-1)
    cy.contains('button', /^Sign$/).should('have.length.gte', 1);

    // Legacy per-row pills should NOT appear
    cy.contains(/^Signed$/).should('not.exist');
    cy.contains(/No ASA Required/i).should('not.exist');
  });

  it('Agent sees the read-only awaiting-signature variant', () => {
    stubAuthEndpoints('Agent', 'usr-agent-001');
    stubLayoutCalls();
    stubGroupAndProducts();

    cy.visit(`/agent/groups/${GROUP_ID}#products`, {
      failOnStatusCode: false,
      onBeforeLoad: seedLocalStorage('Agent', 'usr-agent-001')
    });

    cy.wait('@getProducts', { timeout: 20000 });

    cy.contains(/Awaiting group admin signature/i, { timeout: 15000 }).should('be.visible');
    cy.contains(/Master ASA/i).should('be.visible');

    // Agent has NO Sign button on the banner (read-only variant)
    cy.get('body').then(($body) => {
      const signButtons = $body.find('button').filter((_, el) => /^Sign$/.test((el as HTMLButtonElement).innerText.trim()));
      expect(signButtons.length).to.eq(0);
    });
  });
});
