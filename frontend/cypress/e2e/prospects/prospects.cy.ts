// Cypress E2E — Prospects CRM (Agent portal), stub-driven (no DB).
//
// Covers: list render + status badges, search/filter wiring, create flow (find-or-create),
// detail modal tabs (Details / Communications / Proposals & Quotes), member-match banner +
// confirm-link, send communication, and the Lead Ingest API key modal.

const TENANT_ID = 'tnt-test-0001';
const AGENT_SUBJECT = 'usr-agent-0001';

function makeFakeJwt(subject: string): string {
  const payload = { sub: subject, exp: Math.floor(Date.now() / 1000) + 7200 };
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).replace(/=/g, '');
  const body = btoa(JSON.stringify(payload)).replace(/=/g, '');
  return `${header}.${body}.fakesig`;
}

function seedLocalStorage(win: Window) {
  win.localStorage.setItem('accessToken', makeFakeJwt(AGENT_SUBJECT));
  win.localStorage.setItem('refreshToken', 'unused-refresh-token');
  win.localStorage.setItem('userId', AGENT_SUBJECT);
  win.localStorage.setItem('userEmail', 'agent@test.com');
  win.localStorage.setItem('currentRole', 'Agent');
  win.localStorage.setItem('roles', JSON.stringify(['Agent']));
  win.localStorage.setItem('tenantId', TENANT_ID);
  win.localStorage.setItem('currentTenantId', TENANT_ID);
}

function stubAuth() {
  cy.intercept('GET', '**/auth/me', { statusCode: 200, body: { user: { userId: AGENT_SUBJECT, email: 'agent@test.com' } } });
  cy.intercept('POST', '**/auth/refresh', { statusCode: 200, body: { accessToken: makeFakeJwt(AGENT_SUBJECT), refreshToken: 'unused-refresh-token' } });
  cy.intercept('GET', '**/api/users/me', {
    statusCode: 200,
    body: { success: true, data: { UserId: AGENT_SUBJECT, Email: 'agent@test.com', TenantId: TENANT_ID, currentTenantId: TENANT_ID, roles: ['Agent'], currentRole: 'Agent' } },
  });
}

function stubAgentLayout() {
  // Absorb the AgentLayout's chrome calls so the page can render.
  cy.intercept('GET', '**/api/me/agent/tenant', { statusCode: 200, body: { success: true, data: { TenantName: 'Test Tenant', LogoUrl: '' } } });
  cy.intercept('GET', '**/api/me/agent/training/library-status**', { statusCode: 200, body: { success: true, data: { isComplete: true } } });
  cy.intercept('GET', '**/api/me/agent/agents/downline-agents**', {
    statusCode: 200,
    body: { success: true, data: { currentAgentId: 'agent-self', agencyWideFilterAvailable: false, agents: [{ AgentId: 'agent-self', Name: 'Me Agent', Email: 'agent@test.com' }] } },
  });
  cy.intercept('GET', '**/api/me/agent/**', { statusCode: 200, body: { success: true, data: {} } });
}

const PROSPECT = {
  ProspectId: 'p-1',
  TenantId: TENANT_ID,
  AgentId: 'agent-self',
  FirstName: 'Jane',
  LastName: 'Doe',
  Email: 'jane@example.com',
  Phone: '2015551234',
  Status: 'New',
  ReferralName: 'Website',
  PremiumAmount: 250,
  Source: 'Manual',
  SuggestedMemberId: null,
  MemberId: null,
  ClosedDate: null,
  CreatedDate: '2026-05-20T00:00:00Z',
  ModifiedDate: '2026-05-20T00:00:00Z',
  AgentFirstName: 'Me',
  AgentLastName: 'Agent',
  Tags: [],
  GroupProspectId: null,
  NextFollowUpDate: null,
  LastContactedDate: null,
};

function stubProspectList(prospects = [PROSPECT]) {
  cy.intercept('GET', '**/api/prospects?*', { statusCode: 200, body: { success: true, data: { prospects, total: prospects.length, page: 1, pageSize: 25 } } }).as('list');
  // Bare /api/prospects (no query string) — initial fetch may omit params.
  cy.intercept('GET', '**/api/prospects', { statusCode: 200, body: { success: true, data: { prospects, total: prospects.length, page: 1, pageSize: 25 } } });
  // Phase 6: the page loads the tag list for the tag filter / chips.
  cy.intercept('GET', '**/api/prospect-tags', { statusCode: 200, body: { success: true, data: [] } });
}

function visitProspects() {
  cy.visit('/agent/prospects', { onBeforeLoad: seedLocalStorage });
}

describe('Prospects — list', () => {
  beforeEach(() => {
    stubAuth();
    stubAgentLayout();
    stubProspectList();
  });

  it('renders the page, header and a prospect row', () => {
    visitProspects();
    cy.get('[data-testid="prospects-page"]', { timeout: 15000 }).should('exist');
    cy.contains('h1', 'Prospects').should('be.visible');
    cy.get('[data-testid="prospect-row"]').should('have.length', 1);
    cy.get('[data-testid="prospect-row"]').first().within(() => {
      cy.contains('Jane Doe');
      cy.contains('jane@example.com');
      cy.contains('New');
      cy.contains('Website');
    });
  });

  it('shows the agent Lead Ingest API button', () => {
    visitProspects();
    cy.get('[data-testid="lead-ingest-open"]').should('be.visible');
  });
});

describe('Prospects — create (find-or-create)', () => {
  beforeEach(() => {
    stubAuth();
    stubAgentLayout();
    stubProspectList([]);
  });

  it('opens the create modal, submits, and posts to the API', () => {
    cy.intercept('POST', '**/api/prospects', { statusCode: 201, body: { success: true, data: { prospect: { ...PROSPECT, ProspectId: 'p-new' }, created: true } } }).as('create');
    // Detail fetch fired after create (modal opens on the new id).
    cy.intercept('GET', '**/api/prospects/p-new', { statusCode: 200, body: { success: true, data: { prospect: { ...PROSPECT, ProspectId: 'p-new' }, products: [], member: null } } });

    visitProspects();
    cy.get('[data-testid="prospect-add"]').click();
    cy.contains('h2', 'Add Prospect').should('be.visible');
    cy.contains('label', 'Email').parent().find('input').type('jane@example.com');
    cy.contains('label', 'First name').parent().find('input').type('Jane');
    cy.contains('button', 'Create').click();
    cy.wait('@create').its('request.body').should('deep.include', { email: 'jane@example.com', firstName: 'Jane' });
  });

  it('validation error when all fields blank', () => {
    visitProspects();
    cy.get('[data-testid="prospect-add"]').click();
    cy.contains('button', 'Create').click();
    cy.contains('Enter at least a name, email, or phone.').should('be.visible');
  });
});

describe('Prospects — detail tabs + member match', () => {
  beforeEach(() => {
    stubAuth();
    stubAgentLayout();
    stubProspectList();
  });

  it('opens detail, switches tabs, and shows the member-match banner + confirm', () => {
    const matched = { ...PROSPECT, SuggestedMemberId: 'm-1' };
    cy.intercept('GET', '**/api/prospects/p-1', {
      statusCode: 200,
      body: { success: true, data: { prospect: matched, products: [], member: { MemberId: 'm-1', Status: 'Active', FirstName: 'Jane', LastName: 'Doe', Email: 'jane@example.com', PhoneNumber: '2015551234' } } },
    });
    cy.intercept('GET', '**/api/prospects/p-1/communications', { statusCode: 200, body: { success: true, data: [{ messageId: 'msg-1', messageType: 'Email', subject: 'Welcome', status: 'Delivered', sentDate: '2026-05-21T00:00:00Z', recipientAddress: 'jane@example.com', source: 'Sent' }] } });
    cy.intercept('GET', '**/api/prospects/p-1/proposals', { statusCode: 200, body: { success: true, data: { proposals: [], quotes: [] } } });
    cy.intercept('GET', '**/api/prospect-tags', { statusCode: 200, body: { success: true, data: [] } });
    cy.intercept('POST', '**/api/prospects/p-1/confirm-member-link', { statusCode: 200, body: { success: true, data: { prospect: { ...matched, MemberId: 'm-1', Status: 'Closed', SuggestedMemberId: null }, products: [], member: { MemberId: 'm-1', Status: 'Active', FirstName: 'Jane', LastName: 'Doe', Email: 'jane@example.com', PhoneNumber: null } } } }).as('confirm');

    visitProspects();
    cy.get('[data-testid="prospect-row"]').first().click();

    // Member-match banner on Details tab.
    cy.contains('Possible member match found').should('be.visible');

    // Communications tab.
    cy.contains('button', 'Communications').click();
    cy.contains('Welcome').should('be.visible');
    cy.contains('History').should('be.visible');

    // Proposals & Quotes tab now launches the real quote tools.
    cy.contains('button', 'Proposals & Quotes').click();
    cy.contains('button', 'Quick Quote').should('be.visible');
    cy.contains('button', 'Individual Proposal').should('be.visible');

    // Back to details, confirm member link.
    cy.contains('button', 'Details').click();
    cy.contains('button', 'Confirm link').click();
    cy.wait('@confirm');
  });

  it('sends a communication (email)', () => {
    cy.intercept('GET', '**/api/prospects/p-1', { statusCode: 200, body: { success: true, data: { prospect: PROSPECT, products: [], member: null } } });
    cy.intercept('GET', '**/api/prospects/p-1/communications', { statusCode: 200, body: { success: true, data: [] } });
    cy.intercept('POST', '**/api/prospects/p-1/communications', { statusCode: 200, body: { success: true, data: { messageId: 'msg-new' } } }).as('send');

    visitProspects();
    cy.get('[data-testid="prospect-row"]').first().click();
    cy.contains('button', 'Communications').click();
    cy.get('textarea').first().type('Hello Jane, following up on your quote.');
    cy.contains('button', 'Send').click();
    cy.wait('@send').its('request.body').should('include', { channel: 'email' });
  });
});

describe('Prospects — Lead Ingest API key', () => {
  beforeEach(() => {
    stubAuth();
    stubAgentLayout();
    stubProspectList();
  });

  it('opens the modal, generates a key and shows it once', () => {
    cy.intercept('GET', '**/api/agent-api-keys', { statusCode: 200, body: { success: true, data: [] } });
    cy.intercept('POST', '**/api/agent-api-keys', { statusCode: 201, body: { success: true, data: { apiKeyId: 'k1', name: 'Lead ingest key', partialKey: 'abcd', key: 'sk_live_secret_value', scope: 'lead-ingest' } } }).as('mint');

    visitProspects();
    cy.get('[data-testid="lead-ingest-open"]').click();
    cy.contains('Lead Ingest API Key').should('be.visible');
    cy.contains('button', 'Generate new key').click();
    cy.wait('@mint');
    cy.contains('sk_live_secret_value').should('be.visible');
    cy.contains("won't be shown again").should('be.visible');
  });
});
