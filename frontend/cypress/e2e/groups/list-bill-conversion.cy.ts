// Cypress E2E — Standard → ListBill group type conversion happy path
//
// Scenario: stub-driven (all API calls intercepted via cy.intercept, no DB seed,
// no real login). Covers Task 6.1 from the Vendor Minimums & List-Bill plan.
//
// Flow:
//   1. Agent visits group settings for a Standard group (3 members, vendor min 5).
//   2. Clicks "Request type change" → submits with a reason → request lands Pending
//      (autoApproveGroupTypeChanges: false on tenant settings).
//   3. TenantAdmin lands on groups with change-requests modal → approves.
//   4. Agent navigates to the wizard at /agent/groups/:groupId/type-change/wizard.
//   5. Walks through all 5 wizard steps; asserts the summary on Step 5.

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

const GROUP_ID    = 'grp-std-aaaaaa';
const REQUEST_ID  = 'req-11111111-1111-1111-1111-111111111111';
const TENANT_ID   = 'tnt-test-0001';
const PRODUCT_ID  = 'prod-ind-0001';
const TEMPLATE_ID = 'tmpl-group-0001';

// ---------------------------------------------------------------------------
// Token helpers — build a minimal non-expired JWT for localStorage so
// AuthContext.isTokenExpired() returns false and the app continues to
// validateToken() which our cy.intercept stubs then handle.
// ---------------------------------------------------------------------------

function makeFakeJwt(subject: string): string {
  const payload = { sub: subject, exp: Math.floor(Date.now() / 1000) + 7200 };
  // btoa is available in the browser context where Cypress specs execute
  const header  = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).replace(/=/g, '');
  const body    = btoa(JSON.stringify(payload)).replace(/=/g, '');
  return `${header}.${body}.fakesig`;
}

// ---------------------------------------------------------------------------
// Auth seed — inject localStorage before the React app mounts so
// AuthContext picks up the token on its initial useEffect. Must be called via
// cy.visit(url, { onBeforeLoad: fn }) so the window is the real app window.
// ---------------------------------------------------------------------------

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

function seedLocalStorageAsTenantAdmin(win: Window) {
  const token = makeFakeJwt('usr-ta-001');
  win.localStorage.setItem('accessToken', token);
  win.localStorage.setItem('refreshToken', 'unused-refresh-token');
  win.localStorage.setItem('userId', 'usr-ta-001');
  win.localStorage.setItem('userEmail', 'ta@test.com');
  win.localStorage.setItem('currentRole', 'TenantAdmin');
  win.localStorage.setItem('roles', JSON.stringify(['TenantAdmin']));
  win.localStorage.setItem('tenantId', TENANT_ID);
  win.localStorage.setItem('currentTenantId', TENANT_ID);
}

// ---------------------------------------------------------------------------
// Auth API intercepts — catch OAuth /auth/me and /api/users/me, and crucially
// stub /auth/refresh so the backend's real 401 does NOT trigger session-expired.
// All three must be registered before cy.visit().
// ---------------------------------------------------------------------------

function stubAuthEndpoints(role: 'Agent' | 'TenantAdmin') {
  const userId = role === 'Agent' ? 'usr-agent-001' : 'usr-ta-001';
  const email  = role === 'Agent' ? 'agent@test.com' : 'ta@test.com';

  // OAuth validate endpoint (called via native fetch by AuthContext)
  cy.intercept('GET', '**/auth/me', {
    statusCode: 200,
    body: { user: { userId, email } }
  }).as('oauthMe');

  // OAuth refresh endpoint — return a fresh fake token so the 401 redirect
  // from the running backend never fires
  cy.intercept('POST', '**/auth/refresh', {
    statusCode: 200,
    body: { accessToken: makeFakeJwt(userId), refreshToken: 'unused-refresh-token' }
  }).as('oauthRefresh');

  // Our API profile endpoint (called via axios after OAuth passes)
  cy.intercept('GET', '**/api/users/me', {
    statusCode: 200,
    body: {
      success: true,
      data: {
        UserId: userId,
        Email: email,
        TenantId: TENANT_ID,
        currentTenantId: TENANT_ID,
        roles: [role],
        currentRole: role
      }
    }
  }).as('usersMe');
}

// ---------------------------------------------------------------------------
// Layout-level API intercepts — catch background calls from AgentLayout,
// TenantAdminLayout and their context providers so they never hit the real
// backend (which would return 401 on the fake token, triggering a redirect).
// ---------------------------------------------------------------------------

function stubAgentLayoutCalls() {
  // AgentLayout: GET /api/me/agent/tenant
  cy.intercept('GET', '**/api/me/agent/tenant', {
    statusCode: 200,
    body: { success: true, data: { TenantName: 'Test Tenant', LogoUrl: '' } }
  }).as('agentTenant');

  // AgentProfileValidationContext: profile + licenses
  cy.intercept('GET', '**/api/me/agent/profile**', {
    statusCode: 200,
    body: { success: true, data: {} }
  }).as('agentProfile');

  cy.intercept('GET', '**/api/me/agent/licenses**', {
    statusCode: 200,
    body: { success: true, data: [] }
  }).as('agentLicenses');

  // AgentTrainingIncompleteContext
  cy.intercept('GET', '**/api/me/agent/training/library-status**', {
    statusCode: 200,
    body: { success: true, data: { isComplete: true } }
  }).as('trainingStatus');

  // Broad catch-all for any other /api/me/agent/* calls
  cy.intercept('GET', '**/api/me/agent/**', (req) => {
    req.reply({ statusCode: 200, body: { success: true, data: {} } });
  }).as('agentCatchAll');

  cy.intercept('GET', '**/api/me/agent/group-type-change-requests/pending-action', {
    statusCode: 200,
    body: { success: true, data: [] },
  });
}

function stubTenantAdminLayoutCalls() {
  // TenantAdminLayout: GET /api/tenant-admin/settings
  cy.intercept('GET', '**/api/tenant-admin/settings**', {
    statusCode: 200,
    body: {
      success: true,
      data: {
        autoApproveGroupTypeChanges: false,
        branding: { companyName: 'Test Tenant', logoUrl: '' }
      }
    }
  }).as('tenantAdminSettings');

  // Broad catch-all for any other tenant-admin calls the layout makes
  cy.intercept('GET', '**/api/tenant-admin/**', (req) => {
    req.reply({ statusCode: 200, body: { success: true, data: {} } });
  }).as('tenantAdminCatchAll');

  cy.intercept('GET', '**/api/me/tenant-admin/**', (req) => {
    if (req.url.includes('/accessible-tenants')) {
      req.reply({
        statusCode: 200,
        body: {
          success: true,
          data: [{ TenantId: TENANT_ID, TenantName: 'Test Tenant', Name: 'Test Tenant' }],
        },
      });
      return;
    }
    req.reply({ statusCode: 200, body: { success: true, data: {} } });
  }).as('tenantAdminMeCatchAll');
}

// ---------------------------------------------------------------------------
// Group data intercepts
// ---------------------------------------------------------------------------

function stubGroupDetails() {
  cy.intercept('GET', `**/api/groups/${GROUP_ID}`, {
    statusCode: 200,
    body: {
      success: true,
      data: {
        GroupId: GROUP_ID,
        GroupName: 'Acme Standard Group',
        GroupType: 'Standard',
        TenantId: TENANT_ID,
        MinimumHirePeriod: 30,
        AllowPlanModifications: false,
        Status: 'Active'
      }
    }
  }).as('getGroup');
}

function stubAgentGroup() {
  cy.intercept('GET', `**/api/me/agent/groups/${GROUP_ID}`, {
    statusCode: 200,
    body: {
      success: true,
      data: {
        GroupId: GROUP_ID,
        GroupName: 'Acme Standard Group',
        GroupType: 'Standard',
        TenantId: TENANT_ID,
        MinimumHirePeriod: 30,
        AllowPlanModifications: false,
        Status: 'Active'
      }
    }
  }).as('getAgentGroup');
}

function stubGroupMembers() {
  cy.intercept('GET', `**/api/groups/${GROUP_ID}/members**`, {
    statusCode: 200,
    body: {
      success: true,
      data: {
        members: [
          { MemberId: 'mbr-001', FirstName: 'Alice', LastName: 'Preserve', Status: 'Active' },
          { MemberId: 'mbr-002', FirstName: 'Bob', LastName: 'ReEnroll', Status: 'Active' },
          { MemberId: 'mbr-003', FirstName: 'Carol', LastName: 'NoEnrollment', Status: 'Active' }
        ],
        total: 3
      }
    }
  }).as('groupMembers');
}

function stubGroupProducts() {
  cy.intercept('GET', `**/api/groups/${GROUP_ID}/products**`, {
    statusCode: 200,
    body: {
      success: true,
      data: {
        groupProducts: [],
        availableProducts: [
          {
            ProductId: PRODUCT_ID,
            Name: 'Individual Health Basic',
            SalesType: 'Individual',
            ProductType: 'Medical',
            ProductOwner: 'Acme Vendor'
          }
        ]
      }
    }
  }).as('groupProducts');
}

function stubGroupCatchAll() {
  // Absorb any other /api/groups/:id/* calls (setup status, billing, etc.)
  cy.intercept('GET', `**/api/groups/${GROUP_ID}/**`, (req) => {
    req.reply({ statusCode: 200, body: { success: true, data: {} } });
  }).as('groupCatchAll');
}

function stubEnrollmentLinkTemplates() {
  cy.intercept('GET', '**/api/me/agent/enrollment-link-templates**', {
    statusCode: 200,
    body: {
      success: true,
      data: {
        data: [
          {
            TemplateId: TEMPLATE_ID,
            TemplateName: 'Group Re-enrollment 2026',
            TemplateType: 'Group',
            IsActive: true,
            GroupId: GROUP_ID
          }
        ]
      }
    }
  }).as('getTemplates');
}

// ---------------------------------------------------------------------------
// Part 1 — Agent: Request type change on group settings
// ---------------------------------------------------------------------------

describe('List-fill conversion — Part 1: Agent submits type-change request', () => {
  const pendingRequest = {
    RequestId: REQUEST_ID,
    GroupId: GROUP_ID,
    TenantId: TENANT_ID,
    RequestedBy: 'usr-agent-001',
    CurrentType: 'Standard',
    RequestedType: 'ListBill',
    Status: 'Pending',
    Reason: 'Need list-bill billing for vendor minimum exemption',
    ReviewedBy: null,
    ReviewedAt: null,
    ReviewNotes: null,
    CreatedDate: new Date().toISOString(),
    ModifiedDate: new Date().toISOString(),
    GroupName: 'Acme Standard Group',
    AgentName: 'Agent Test'
  };

  beforeEach(() => {
    // Auth — must be registered before visit
    stubAuthEndpoints('Agent');
    stubAgentLayoutCalls();

    // Group data
    stubGroupDetails();
    stubAgentGroup();
    stubGroupMembers();
    stubGroupCatchAll();

    // Type-change request creation → returns Pending (autoApprove=false)
    cy.intercept('POST', '**/api/group-type-change-requests', {
      statusCode: 201,
      body: { success: true, data: pendingRequest }
    }).as('createRequest');
  });

  it('navigates to group settings and opens Request type change modal', () => {
    // Navigate directly to the Settings tab via URL hash
    cy.visit(`/agent/groups/${GROUP_ID}#settings`, {
      failOnStatusCode: false,
      onBeforeLoad: seedLocalStorageAsAgent
    });

    // Wait for the group to load and the settings tab content to appear
    // The GroupType card contains "Group Type" heading and "Request type change" button
    cy.contains(/Group Type/i, { timeout: 20000 }).should('be.visible');
    cy.contains('button', /request type change/i, { timeout: 10000 }).should('be.visible').click();

    // Modal title
    cy.contains(/Request Group Type Change/i, { timeout: 5000 }).should('be.visible');
  });

  it('submits a type-change request and sees Pending confirmation', () => {
    cy.visit(`/agent/groups/${GROUP_ID}#settings`, {
      failOnStatusCode: false,
      onBeforeLoad: seedLocalStorageAsAgent
    });

    cy.contains(/Group Type/i, { timeout: 20000 }).should('be.visible');
    cy.contains('button', /request type change/i, { timeout: 10000 }).click();

    // Modal open
    cy.contains(/Request Group Type Change/i, { timeout: 5000 });

    // Fill reason and submit
    cy.get('textarea').type('Need list-bill billing for vendor minimum exemption');
    cy.contains('button', /submit request/i).click();

    cy.wait('@createRequest').its('request.body').should('deep.include', {
      requestedType: 'ListBill'
    });

    // After submit with autoApprove=false → Pending state displayed
    cy.contains(/pending approval/i, { timeout: 8000 }).should('be.visible');
  });
});

// ---------------------------------------------------------------------------
// Part 2 — TenantAdmin: Approve the pending request
// ---------------------------------------------------------------------------

describe('List-fill conversion — Part 2: TenantAdmin approves request', () => {
  const pendingRequests = [
    {
      RequestId: REQUEST_ID,
      GroupId: GROUP_ID,
      TenantId: TENANT_ID,
      RequestedBy: 'usr-agent-001',
      CurrentType: 'Standard',
      RequestedType: 'ListBill',
      Status: 'Pending',
      Reason: 'Need list-bill billing for vendor minimum exemption',
      ReviewedBy: null,
      ReviewedAt: null,
      ReviewNotes: null,
      CreatedDate: new Date().toISOString(),
      ModifiedDate: new Date().toISOString(),
      GroupName: 'Acme Standard Group',
      AgentName: 'Agent Test'
    }
  ];

  beforeEach(() => {
    stubAuthEndpoints('TenantAdmin');
    stubTenantAdminLayoutCalls();

    cy.intercept('GET', '**/api/me/tenant-admin/groups**', {
      statusCode: 200,
      body: { success: true, data: [] },
    }).as('tenantGroups');

    cy.intercept('GET', '**/api/tenant-admin/agents**', {
      statusCode: 200,
      body: { success: true, data: [] },
    }).as('tenantAgents');

    cy.intercept('GET', '**/api/tenant/products**', {
      statusCode: 200,
      body: { success: true, data: [] },
    }).as('tenantProducts');

    // List of pending requests — respond to first call with data, subsequent with empty
    let callCount = 0;
    cy.intercept('GET', '**/api/group-type-change-requests**', (req) => {
      callCount++;
      if (callCount === 1) {
        req.reply({ statusCode: 200, body: { success: true, data: pendingRequests } });
      } else {
        req.reply({ statusCode: 200, body: { success: true, data: [] } });
      }
    }).as('listRequests');

    // Approve endpoint
    cy.intercept('POST', `**/api/group-type-change-requests/${REQUEST_ID}/approve`, {
      statusCode: 200,
      body: {
        success: true,
        data: {
          ...pendingRequests[0],
          Status: 'Approved',
          ReviewedBy: 'usr-ta-001',
          ReviewedAt: new Date().toISOString(),
          ReviewNotes: ''
        }
      }
    }).as('approveRequest');
  });

  it('TenantAdmin sees the Pending request and approves it', () => {
    cy.visit('/tenant-admin/groups?changeRequests=open', {
      failOnStatusCode: false,
      onBeforeLoad: seedLocalStorageAsTenantAdmin,
    });

    cy.wait('@listRequests', { timeout: 20000 });

    // Page heading
    cy.contains(/Group Type Change Requests/i, { timeout: 10000 }).should('be.visible');

    // The group name should appear in the table row
    cy.contains('Acme Standard Group', { timeout: 10000 }).should('be.visible');

    // ListBill appears in the type-change column
    cy.contains('ListBill', { timeout: 5000 }).should('exist');

    // Click Approve button for this row
    cy.contains('button', /^approve$/i).first().click();

    // Approve confirmation modal opens
    cy.get('[role="dialog"]', { timeout: 5000 }).should('be.visible');
    cy.get('#approve-modal-title').should('contain.text', 'Confirm Approval');

    // Confirm inside the modal
    cy.get('[role="dialog"]').contains('button', /confirm/i).click();

    cy.wait('@approveRequest').its('response.statusCode').should('eq', 200);

    // Approve confirmation modal dismisses after success (queue may still be open in parent panel)
    cy.get('#approve-modal-title').should('not.exist');
  });
});

// ---------------------------------------------------------------------------
// Part 3 — Agent: Walk through the 5-step conversion wizard
// ---------------------------------------------------------------------------

describe('List-fill conversion — Part 3: Agent walks the conversion wizard', () => {
  const previewMembers = [
    {
      memberId: 'mbr-001',
      displayName: 'Alice LetFinish',
      action: 'letFinishThenCancel',
      enrollments: [
        {
          enrollmentId: 'enr-001',
          productId: 'prod-group-1',
          productName: 'Group Bronze',
          vendorId: 'v-1',
          productType: 'Medical',
          effectiveDate: '2025-01-01T00:00:00Z',
          status: 'Active',
          matchingIndividualProduct: null,
          action: 'letFinishThenCancel',
        },
      ],
    },
    {
      memberId: 'mbr-002',
      displayName: 'Bob ReEnroll',
      action: 'reEnroll',
      enrollments: [
        {
          enrollmentId: 'enr-002',
          productId: 'prod-group-2',
          productName: 'Group Silver',
          vendorId: 'v-1',
          productType: 'Medical',
          effectiveDate: '2026-06-01T00:00:00Z',
          status: 'Pending',
          matchingIndividualProduct: null,
          action: 'reEnroll',
        },
      ],
    },
  ];

  beforeEach(() => {
    stubAuthEndpoints('Agent');
    stubAgentLayoutCalls();
    stubGroupDetails();
    stubAgentGroup();
    stubGroupCatchAll();

    cy.intercept('GET', `**/api/groups/${GROUP_ID}/type-change/preview`, {
      statusCode: 200,
      body: { success: true, data: { targetType: 'ListBill', members: previewMembers, membersWithoutEnrollments: [] } },
    }).as('typeChangePreview');

    cy.intercept('GET', `**/api/groups/${GROUP_ID}/type-change/available-products`, {
      statusCode: 200,
      body: {
        success: true,
        data: {
          groupProducts: [],
          availableProducts: [
            {
              ProductId: PRODUCT_ID,
              Name: 'Individual Health Basic',
              SalesType: 'Individual',
              ProductType: 'Medical',
              ProductOwner: 'Acme Vendor',
            },
          ],
          group: { GroupId: GROUP_ID, Name: 'Acme Standard Group', TenantId: TENANT_ID, Status: 'Active' },
        },
      },
    }).as('availableProducts');

    cy.intercept('POST', `**/api/groups/${GROUP_ID}/type-change/apply`, {
      statusCode: 200,
      body: {
        success: true,
        data: {
          productsAdded: 1,
          enrollmentsCancelled: 1,
          householdIdsCleared: 1,
          enrollmentsTerminationScheduled: 1,
        },
      },
    }).as('typeChangeApply');

    stubEnrollmentLinkTemplates();

    cy.intercept('POST', `**/api/groups/${GROUP_ID}/send-enrollment-links`, {
      statusCode: 200,
      body: { success: true, data: { sentCount: 1 } },
    }).as('sendEnrollmentLinks');
  });

  it('Step 1 — shows member preview bucketed into reEnroll and letFinish', () => {
    cy.visit(`/agent/groups/${GROUP_ID}/type-change/wizard`, {
      failOnStatusCode: false,
      onBeforeLoad: seedLocalStorageAsAgent,
    });

    cy.wait('@typeChangePreview', { timeout: 20000 });
    cy.contains(/Review existing enrollments/i, { timeout: 10000 }).should('be.visible');
    cy.get('[data-testid="section-reEnroll"]', { timeout: 10000 }).should('contain.text', '1 member');
    cy.get('[data-testid="section-letFinishThenCancel"]').should('contain.text', '1 member');
  });

  it('Steps 1–5 — full wizard happy path', () => {
    cy.visit(`/agent/groups/${GROUP_ID}/type-change/wizard`, {
      failOnStatusCode: false,
      onBeforeLoad: seedLocalStorageAsAgent,
    });

    cy.wait('@typeChangePreview', { timeout: 20000 });
    cy.get('[data-testid="section-reEnroll"]').should('be.visible');
    cy.get('[data-testid="section-letFinishThenCancel"]').should('be.visible');
    cy.contains('button', /next/i).click();

    cy.wait('@availableProducts', { timeout: 10000 });
    cy.contains(/Select individual products/i, { timeout: 10000 }).should('be.visible');
    cy.contains('Individual Health Basic', { timeout: 8000 }).should('be.visible');
    cy.get(`[data-testid="product-checkbox-${PRODUCT_ID}"]`).check();
    cy.get('[data-testid="step2-next"]').click();

    cy.contains(/Confirm conversion/i, { timeout: 10000 }).should('be.visible');
    cy.get('[data-testid="confirm-household-count"]').should('contain.text', '2');
    cy.get('[data-testid="confirm-understood"]').check();
    cy.get('[data-testid="step3-apply"]').click();
    cy.wait('@typeChangeApply').its('response.statusCode').should('eq', 200);

    cy.wait('@getTemplates', { timeout: 10000 });
    cy.contains(/Send enrollment links/i, { timeout: 10000 }).should('be.visible');
    cy.get('[data-testid="reenroll-member-list"]', { timeout: 8000 }).should('contain.text', 'Bob ReEnroll');
    cy.get('[data-testid="step4-template-auto"]').should('be.visible');
    cy.get('[data-testid="step4-send"]').click();
    cy.wait('@sendEnrollmentLinks').its('request.body').should('deep.include', { templateId: TEMPLATE_ID });

    cy.contains(/Conversion complete/i, { timeout: 10000 }).should('be.visible');
    cy.get('[data-testid="step5-summary"]').should('be.visible');
    cy.get('[data-testid="summary-terminating"]').should('contain.text', '1');
    cy.get('[data-testid="summary-cancelled"]').should('contain.text', '1');
    cy.get('[data-testid="summary-ids-cleared"]').should('contain.text', '1');
    cy.get('[data-testid="summary-links-sent"]').should('contain.text', '1');
  });
});
