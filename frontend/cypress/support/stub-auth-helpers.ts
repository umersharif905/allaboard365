/// <reference types="cypress" />

/** Minimal non-expired JWT for stub-driven Cypress specs. */
export function makeFakeJwt(subject: string): string {
  const payload = { sub: subject, exp: Math.floor(Date.now() / 1000) + 7200 };
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).replace(/=/g, '');
  const body = btoa(JSON.stringify(payload)).replace(/=/g, '');
  return `${header}.${body}.fakesig`;
}

type StubRole = 'Agent' | 'GroupAdmin' | 'TenantAdmin' | 'VendorAdmin' | 'VendorAgent';

const ROLE_SUBJECT: Record<StubRole, string> = {
  Agent: 'usr-agent-001',
  GroupAdmin: 'usr-ga-001',
  TenantAdmin: 'usr-ta-001',
  VendorAdmin: 'usr-vendor-001',
  VendorAgent: 'usr-vendor-agent-001',
};

export function seedLocalStorageAsRole(
  role: StubRole,
  options: { tenantId?: string; vendorId?: string } = {}
) {
  const tenantId = options.tenantId ?? 'tnt-test-0001';
  const subject = ROLE_SUBJECT[role];

  return (win: Window) => {
    const token = makeFakeJwt(subject);
    win.localStorage.setItem('accessToken', token);
    win.localStorage.setItem('refreshToken', 'unused-refresh-token');
    win.localStorage.setItem('userId', subject);
    win.localStorage.setItem('userEmail', `${role.toLowerCase()}@test.com`);
    win.localStorage.setItem('currentRole', role);
    win.localStorage.setItem('roles', JSON.stringify([role]));
    win.localStorage.setItem('tenantId', tenantId);
    win.localStorage.setItem('currentTenantId', tenantId);
    if (options.vendorId) {
      win.localStorage.setItem('vendorId', options.vendorId);
    }
  };
}

export function stubAuthEndpoints(role: StubRole, tenantId = 'tnt-test-0001') {
  const subject = ROLE_SUBJECT[role];
  const email = `${role.toLowerCase()}@test.com`;

  cy.intercept('GET', '**/auth/me', {
    statusCode: 200,
    body: { user: { userId: subject, email } },
  });

  cy.intercept('POST', '**/auth/refresh', {
    statusCode: 200,
    body: { accessToken: makeFakeJwt(subject), refreshToken: 'unused-refresh-token' },
  });

  cy.intercept('GET', '**/api/users/me', {
    statusCode: 200,
    body: {
      success: true,
      data: {
        UserId: subject,
        Email: email,
        TenantId: tenantId,
        currentTenantId: tenantId,
        roles: [role],
        currentRole: role,
      },
    },
  });
}

/** Catch-all first; register specific routes after this in each spec. */
export function stubAgentLayoutCalls() {
  cy.intercept('GET', '**/api/me/agent/**', (req) => {
    req.reply({ statusCode: 200, body: { success: true, data: {} } });
  });

  cy.intercept('GET', '**/api/me/agent/tenant', {
    statusCode: 200,
    body: { success: true, data: { TenantName: 'Test Tenant', LogoUrl: '' } },
  });

  cy.intercept('GET', '**/api/me/agent/profile**', {
    statusCode: 200,
    body: { success: true, data: {} },
  });

  cy.intercept('GET', '**/api/me/agent/licenses**', {
    statusCode: 200,
    body: { success: true, data: [] },
  });

  cy.intercept('GET', '**/api/me/agent/training/library-status**', {
    statusCode: 200,
    body: { success: true, data: { isComplete: true } },
  });

  cy.intercept('GET', '**/api/me/agent/enrollment-link-templates**', {
    statusCode: 200,
    body: { success: true, data: { data: [] } },
  });

  cy.intercept('GET', '**/api/me/agent/group-type-change-requests/pending-action', {
    statusCode: 200,
    body: { success: true, data: [] },
  });
}

export function stubTenantAdminLayoutCalls(tenantId = 'tnt-test-0001') {
  cy.intercept('GET', '**/api/tenant-admin/**', (req) => {
    req.reply({ statusCode: 200, body: { success: true, data: {} } });
  });

  cy.intercept('GET', '**/api/me/tenant-admin/**', (req) => {
    if (req.url.includes('/accessible-tenants')) {
      req.reply({
        statusCode: 200,
        body: {
          success: true,
          data: [{ TenantId: tenantId, TenantName: 'Test Tenant', Name: 'Test Tenant' }],
        },
      });
      return;
    }
    req.reply({ statusCode: 200, body: { success: true, data: {} } });
  });

  cy.intercept('GET', '**/api/tenant-admin/settings**', {
    statusCode: 200,
    body: {
      success: true,
      data: {
        autoApproveGroupTypeChanges: false,
        branding: { companyName: 'Test Tenant', logoUrl: '' },
      },
    },
  });

  cy.intercept('GET', '**/api/me/tenant-admin/accessible-tenants', {
    statusCode: 200,
    body: {
      success: true,
      data: [{ TenantId: tenantId, TenantName: 'Test Tenant', Name: 'Test Tenant' }],
    },
  });
}

export function stubVendorPortalLayoutCalls() {
  cy.intercept('GET', '**/api/me/vendor/**', (req) => {
    req.reply({ statusCode: 200, body: { success: true, data: {} } });
  });

  cy.intercept('GET', '**/api/me/vendor/dashboard**', {
    statusCode: 200,
    body: { success: true, data: {} },
  });
}

export function stubGroupRouteCatchAll(groupId: string) {
  cy.intercept('GET', `**/api/groups/${groupId}/**`, (req) => {
    req.reply({ statusCode: 200, body: { success: true, data: {} } });
  });
}

declare global {
  namespace Cypress {
    interface Chainable {
      seedLocalStorageAsRole(
        role: StubRole,
        options?: { tenantId?: string; vendorId?: string }
      ): Chainable<(win: Window) => void>;
    }
  }
}

Cypress.Commands.add('seedLocalStorageAsRole', seedLocalStorageAsRole);

export {};
