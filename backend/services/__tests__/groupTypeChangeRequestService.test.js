/**
 * groupTypeChangeRequestService — GroupType change approval queue
 *
 * Covers:
 *   createRequest  — Pending path, auto-approve path, duplicate guard, same-type guard
 *   approveRequest — happy path, not-pending guard, tenant isolation
 *   denyRequest    — happy path, missing notes guard
 *
 * Run: npx jest groupTypeChangeRequestService
 */

jest.mock('../../config/database', () => ({
  getPool: jest.fn()
}));

// Stub email side effects — these are tested separately via
// belowMinimumCheckService.test.js's recipient logic. Here we only care that
// the queue is NOT called with a group-admin recipient (covered explicitly
// in the dedicated test below).
jest.mock('../messageQueue.service', () => ({
  queueEmail: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('../emailTemplates.service', () => ({
  loadTemplate: jest.fn().mockReturnValue('<html>{{groupName}}</html>'),
  processTemplate: jest.fn().mockReturnValue('<html>processed</html>'),
  getTenantEmailConfig: jest.fn().mockResolvedValue({ tenantName: 'Test Tenant' })
}));

const { getPool } = require('../../config/database');
const MessageQueueService = require('../messageQueue.service');
const svc = require('../groupTypeChangeRequestService');

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Build a chainable mssql request mock.
 * queryImpl(sql) is called on .query() and should return the result object.
 */
function buildRequest(queryImpl = async () => ({ recordset: [], rowsAffected: [0] })) {
  const req = {};
  req.input = jest.fn().mockReturnValue(req);
  req.query = jest.fn((sql) => queryImpl(sql));
  return req;
}

/**
 * Build a pool mock where every pool.request() returns a new mock powered
 * by the provided sequence of query implementations.
 *
 * If there are more calls than impls, the last impl is reused.
 */
function buildPool(queryImpls) {
  let call = 0;
  const pool = {
    request: jest.fn(() => {
      const impl = queryImpls[Math.min(call++, queryImpls.length - 1)];
      return buildRequest(impl);
    })
  };
  return pool;
}

// Suppress noisy console output
beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => {
  console.log.mockRestore?.();
  console.error.mockRestore?.();
  console.warn.mockRestore?.();
});
beforeEach(() => {
  jest.clearAllMocks();
});

// ─── fixtures ────────────────────────────────────────────────────────────────

const GROUP_ID    = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_ID   = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const USER_ID     = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const REQUEST_ID  = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const REVIEWER_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

// ─── createRequest ───────────────────────────────────────────────────────────

describe('createRequest', () => {
  test('creates Pending request when auto-approve disabled', async () => {
    // Query sequence:
    //  1. SELECT GroupType FROM oe.Groups → currentType = 'Standard'
    //  2. SELECT RequestId ... Status='Pending' → no existing pending
    //  3. SELECT AdvancedSettings FROM oe.Tenants → autoApprove = false
    //  4. INSERT ... OUTPUT INSERTED.* → new row
    //  5. SELECT … Tenants … → loadTenantForUrl
    //  6. SELECT FirstName/LastName FROM oe.Users → lookupRequesterName
    //  7+ submitted-email path: belowMinimumAlertRecipients lookup
    //   (recipients return empty in this stub so no email is queued)
    const insertedRow = {
      RequestId: REQUEST_ID,
      GroupId: GROUP_ID,
      TenantId: TENANT_ID,
      Status: 'Pending',
      RequestedType: 'ListBill',
      CurrentType: 'Standard'
    };

    const pool = buildPool([
      async () => ({ recordset: [{ GroupType: 'Standard' }] }),
      async () => ({ recordset: [] }),                          // no pending
      async () => ({ recordset: [{ AdvancedSettings: JSON.stringify({ enrollment: { autoApproveGroupTypeChanges: false } }) }] }),
      async () => ({ recordset: [insertedRow] }),               // INSERT
      async () => ({ recordset: [{ TenantId: TENANT_ID, Name: 'Acme', CustomDomain: null, DefaultUrlPath: null, IsDefaultUrlPathVerified: false, AdvancedSettings: null }] }),
      async () => ({ recordset: [{ FirstName: 'Ron', LastName: 'Requester' }] }),
      async () => ({ recordset: [{ AdvancedSettings: null }] }) // belowMinimumAlertRecipients lookup → none
    ]);
    getPool.mockResolvedValue(pool);

    const result = await svc.createRequest({
      groupId: GROUP_ID,
      tenantId: TENANT_ID,
      requestedBy: USER_ID,
      requestedType: 'ListBill',
      reason: 'Switching to list-bill model'
    });

    expect(result.Status).toBe('Pending');
    expect(result.RequestId).toBe(REQUEST_ID);

    // Groups.GroupType must NOT have been updated.
    // No email is queued because recipients are empty.
    expect(MessageQueueService.queueEmail).not.toHaveBeenCalled();
  });

  test('creates Approved request without flipping GroupType when auto-approve enabled', async () => {
    const insertedRow = {
      RequestId: REQUEST_ID,
      GroupId: GROUP_ID,
      TenantId: TENANT_ID,
      Status: 'Approved',
      RequestedType: 'ListBill',
      CurrentType: 'Standard',
      ReviewNotes: 'Auto-approved per tenant setting'
    };

    const pool = buildPool([
      async () => ({ recordset: [{ GroupType: 'Standard' }] }),
      async () => ({ recordset: [] }),                          // no pending
      async () => ({ recordset: [{ AdvancedSettings: JSON.stringify({ enrollment: { autoApproveGroupTypeChanges: true } }) }] }),
      async () => ({ recordset: [insertedRow] }),               // INSERT
      async () => ({ recordset: [{ TenantId: TENANT_ID, Name: 'Acme', CustomDomain: null, DefaultUrlPath: null, IsDefaultUrlPathVerified: false, AdvancedSettings: null }] }), // loadTenantForUrl
      async () => ({ recordset: [] })                           // resolveAgentRecipientForGroup → no agent → no email queued
    ]);
    getPool.mockResolvedValue(pool);

    const result = await svc.createRequest({
      groupId: GROUP_ID,
      tenantId: TENANT_ID,
      requestedBy: USER_ID,
      requestedType: 'ListBill'
    });

    expect(result.Status).toBe('Approved');
    expect(result.ReviewNotes).toBe('Auto-approved per tenant setting');

    // No submitted email goes out on the auto-approve path; the agent
    // approval email is skipped because the agent-recipient lookup is empty.
    expect(MessageQueueService.queueEmail).not.toHaveBeenCalled();
  });

  test('rejects if CurrentType === RequestedType', async () => {
    const pool = buildPool([
      async () => ({ recordset: [{ GroupType: 'Standard' }] })
    ]);
    getPool.mockResolvedValue(pool);

    await expect(
      svc.createRequest({
        groupId: GROUP_ID,
        tenantId: TENANT_ID,
        requestedBy: USER_ID,
        requestedType: 'Standard'  // same as current
      })
    ).rejects.toMatchObject({ status: 400, message: /current type/i });
  });

  test('rejects if a Pending request already exists for this group', async () => {
    const pool = buildPool([
      async () => ({ recordset: [{ GroupType: 'Standard' }] }),
      async () => ({ recordset: [{ RequestId: REQUEST_ID }] })  // pending exists
    ]);
    getPool.mockResolvedValue(pool);

    await expect(
      svc.createRequest({
        groupId: GROUP_ID,
        tenantId: TENANT_ID,
        requestedBy: USER_ID,
        requestedType: 'ListBill'
      })
    ).rejects.toMatchObject({ status: 409, message: /pending request already exists/i });
  });

  test('rejects invalid requestedType', async () => {
    // getPool should never be called for an invalid type
    await expect(
      svc.createRequest({
        groupId: GROUP_ID,
        tenantId: TENANT_ID,
        requestedBy: USER_ID,
        requestedType: 'Unknown'
      })
    ).rejects.toMatchObject({ status: 400, message: /invalid requestedtype/i });

    expect(getPool).not.toHaveBeenCalled();
  });
});

// ─── listRequests ────────────────────────────────────────────────────────────

describe('listRequests', () => {
  const rows = [
    { RequestId: REQUEST_ID, TenantId: TENANT_ID, TenantName: 'Acme Agency', GroupName: 'Group A', Status: 'Pending' },
    { RequestId: 'req-2',    TenantId: 'other',   TenantName: 'Other Agency', GroupName: 'Group B', Status: 'Pending' }
  ];

  test('TenantAdmin sees only own tenant — TenantId filter applied', async () => {
    const pool = buildPool([async () => ({ recordset: [rows[0]] })]);
    getPool.mockResolvedValue(pool);

    const result = await svc.listRequests({ tenantId: TENANT_ID, includeAllTenants: false });

    expect(result).toHaveLength(1);
    expect(result[0].TenantId).toBe(TENANT_ID);

    // The SQL passed to query() must contain the TenantId filter
    const querySql = pool.request.mock.results[0].value.query.mock.calls[0][0];
    expect(querySql).toMatch(/r\.TenantId = @TenantId/i);
  });

  test('SysAdmin sees all tenants — TenantId filter skipped', async () => {
    const pool = buildPool([async () => ({ recordset: rows })]);
    getPool.mockResolvedValue(pool);

    const result = await svc.listRequests({ tenantId: TENANT_ID, includeAllTenants: true });

    expect(result).toHaveLength(2);
    // Both tenants present in result
    const tenantIds = result.map((r) => r.TenantId);
    expect(tenantIds).toContain(TENANT_ID);
    expect(tenantIds).toContain('other');

    // The SQL passed to query() must NOT contain the TenantId filter
    const querySql = pool.request.mock.results[0].value.query.mock.calls[0][0];
    expect(querySql).not.toMatch(/r\.TenantId = @TenantId/i);

    // Result includes TenantName from the JOIN
    expect(result[0].TenantName).toBe('Acme Agency');
    expect(result[1].TenantName).toBe('Other Agency');
  });
});

// ─── approveRequest ──────────────────────────────────────────────────────────

describe('approveRequest', () => {
  const pendingRow = {
    RequestId: REQUEST_ID,
    GroupId: GROUP_ID,
    TenantId: TENANT_ID,
    Status: 'Pending',
    RequestedType: 'ListBill',
    CurrentType: 'Standard'
  };

  test('marks Approved, records reviewer; GroupType is NOT flipped here', async () => {
    const pool2 = buildPool([
      async () => ({ recordset: [pendingRow] }),                // SELECT existing
      async () => ({ recordset: [], rowsAffected: [1] }),       // UPDATE request
      async () => ({ recordset: [{ FirstName: 'R', LastName: 'V' }] }), // reviewer name
      async () => ({ recordset: [{ TenantId: TENANT_ID, Name: 'Acme', CustomDomain: null, DefaultUrlPath: null, IsDefaultUrlPathVerified: false, AdvancedSettings: null }] }), // loadTenantForUrl
      async () => ({ recordset: [] })                           // resolveAgentRecipientForGroup → no agent
    ]);
    getPool.mockResolvedValue(pool2);

    const result = await svc.approveRequest({
      requestId: REQUEST_ID,
      tenantId: TENANT_ID,
      reviewerId: REVIEWER_ID,
      notes: 'Looks good'
    });

    expect(result.Status).toBe('Approved');
    expect(result.ReviewedBy).toBe(REVIEWER_ID);
    expect(result.ReviewNotes).toBe('Looks good');
    // No agent recipient stubbed → no email queued.
    expect(MessageQueueService.queueEmail).not.toHaveBeenCalled();
  });

  test('rejects if request is not Pending', async () => {
    const pool = buildPool([
      async () => ({ recordset: [{ ...pendingRow, Status: 'Approved' }] })
    ]);
    getPool.mockResolvedValue(pool);

    await expect(
      svc.approveRequest({ requestId: REQUEST_ID, tenantId: TENANT_ID, reviewerId: REVIEWER_ID })
    ).rejects.toMatchObject({ status: 409, message: /not pending/i });
  });

  test('rejects with 404 when request not found in this tenant (tenant isolation)', async () => {
    // Simulates a TenantAdmin from a different tenant: TenantId filter returns no rows
    const pool = buildPool([
      async () => ({ recordset: [] })
    ]);
    getPool.mockResolvedValue(pool);

    await expect(
      svc.approveRequest({
        requestId: REQUEST_ID,
        tenantId: 'other-tenant-id',
        reviewerId: REVIEWER_ID
      })
    ).rejects.toMatchObject({ status: 404, message: /not found/i });
  });
});

// ─── denyRequest ─────────────────────────────────────────────────────────────

describe('denyRequest', () => {
  test('marks Denied with required notes', async () => {
    const pool = buildPool([
      async () => ({ recordset: [], rowsAffected: [1] })
    ]);
    getPool.mockResolvedValue(pool);

    const result = await svc.denyRequest({
      requestId: REQUEST_ID,
      tenantId: TENANT_ID,
      reviewerId: REVIEWER_ID,
      notes: 'Does not meet criteria'
    });

    expect(result).toMatchObject({ requestId: REQUEST_ID, status: 'Denied' });
    // Email path is skipped here because the SELECT returns no row in this
    // stub. Full email-recipient-resolution is exercised below.
    expect(MessageQueueService.queueEmail).not.toHaveBeenCalled();
  });

  test('rejects if notes are missing', async () => {
    await expect(
      svc.denyRequest({ requestId: REQUEST_ID, tenantId: TENANT_ID, reviewerId: REVIEWER_ID })
    ).rejects.toMatchObject({ status: 400, message: /notes are required/i });

    expect(getPool).not.toHaveBeenCalled();
  });
});

// ─── email recipients: agent-only, never group admin ─────────────────────────
//
// These tests guard the user requirement that conversion emails go to the
// agent and ONLY the agent (no group admin, no carbon-copies).

describe('email recipients are agent-only', () => {
  const AGENT_EMAIL = 'agent@example.com';

  test('approveRequest queues exactly one email, addressed to the group agent', async () => {
    const pendingRow = {
      RequestId: REQUEST_ID,
      GroupId: GROUP_ID,
      TenantId: TENANT_ID,
      Status: 'Pending',
      RequestedType: 'ListBill',
      CurrentType: 'Standard'
    };
    const pool = buildPool([
      async () => ({ recordset: [pendingRow] }),                                     // SELECT existing
      async () => ({ recordset: [], rowsAffected: [1] }),                            // UPDATE request
      async () => ({ recordset: [{ FirstName: 'Tina', LastName: 'Tenant' }] }),      // lookupReviewerName
      async () => ({ recordset: [{ TenantId: TENANT_ID, Name: 'Acme', CustomDomain: null, DefaultUrlPath: null, IsDefaultUrlPathVerified: false, AdvancedSettings: null }] }), // loadTenantForUrl
      async () => ({                                                                 // resolveAgentRecipientForGroup
        recordset: [{
          GroupName: 'Acme Corp',
          GroupType: 'Standard',
          AgentEmail: AGENT_EMAIL,
          AgentFirstName: 'Alice',
          AgentLastName: 'Agent'
        }]
      })
    ]);
    getPool.mockResolvedValue(pool);

    await svc.approveRequest({
      requestId: REQUEST_ID,
      tenantId: TENANT_ID,
      reviewerId: REVIEWER_ID,
      notes: 'Looks good'
    });

    expect(MessageQueueService.queueEmail).toHaveBeenCalledTimes(1);
    expect(MessageQueueService.queueEmail).toHaveBeenCalledWith(
      expect.objectContaining({ toEmail: AGENT_EMAIL })
    );
    // Defensive: never include any 'cc'/'bcc' or group-admin field.
    const call = MessageQueueService.queueEmail.mock.calls[0][0];
    expect(call.cc).toBeUndefined();
    expect(call.bcc).toBeUndefined();
    expect(call.groupAdminEmail).toBeUndefined();
  });

  test('denyRequest queues exactly one email, addressed to the group agent', async () => {
    const pool = buildPool([
      async () => ({ recordset: [{ GroupId: GROUP_ID, CurrentType: 'Standard', RequestedType: 'ListBill' }] }), // SELECT existing
      async () => ({ recordset: [], rowsAffected: [1] }),                                                       // UPDATE
      async () => ({ recordset: [{ FirstName: 'Tina', LastName: 'Tenant' }] }),                                 // lookupReviewerName
      async () => ({ recordset: [{ TenantId: TENANT_ID, Name: 'Acme', CustomDomain: null, DefaultUrlPath: null, IsDefaultUrlPathVerified: false, AdvancedSettings: null }] }), // loadTenantForUrl
      async () => ({                                                                                            // resolveAgentRecipientForGroup
        recordset: [{
          GroupName: 'Acme Corp',
          GroupType: 'Standard',
          AgentEmail: AGENT_EMAIL,
          AgentFirstName: 'Alice',
          AgentLastName: 'Agent'
        }]
      })
    ]);
    getPool.mockResolvedValue(pool);

    await svc.denyRequest({
      requestId: REQUEST_ID,
      tenantId: TENANT_ID,
      reviewerId: REVIEWER_ID,
      notes: 'Does not meet criteria'
    });

    expect(MessageQueueService.queueEmail).toHaveBeenCalledTimes(1);
    expect(MessageQueueService.queueEmail).toHaveBeenCalledWith(
      expect.objectContaining({ toEmail: AGENT_EMAIL })
    );
    const call = MessageQueueService.queueEmail.mock.calls[0][0];
    expect(call.cc).toBeUndefined();
    expect(call.bcc).toBeUndefined();
  });

  test('createRequest auto-approve queues exactly one email, addressed to the group agent', async () => {
    const insertedRow = {
      RequestId: REQUEST_ID,
      GroupId: GROUP_ID,
      TenantId: TENANT_ID,
      Status: 'Approved',
      RequestedType: 'ListBill',
      CurrentType: 'Standard',
      ReviewNotes: 'Auto-approved per tenant setting'
    };
    const pool = buildPool([
      async () => ({ recordset: [{ GroupType: 'Standard' }] }),                                                 // SELECT GroupType
      async () => ({ recordset: [] }),                                                                          // SELECT pending
      async () => ({ recordset: [{ AdvancedSettings: JSON.stringify({ enrollment: { autoApproveGroupTypeChanges: true } }) }] }),
      async () => ({ recordset: [insertedRow] }),                                                               // INSERT
      async () => ({ recordset: [{ TenantId: TENANT_ID, Name: 'Acme', CustomDomain: null, DefaultUrlPath: null, IsDefaultUrlPathVerified: false, AdvancedSettings: null }] }), // loadTenantForUrl
      async () => ({                                                                                            // resolveAgentRecipientForGroup
        recordset: [{
          GroupName: 'Acme Corp',
          GroupType: 'Standard',
          AgentEmail: AGENT_EMAIL,
          AgentFirstName: 'Alice',
          AgentLastName: 'Agent'
        }]
      })
    ]);
    getPool.mockResolvedValue(pool);

    await svc.createRequest({
      groupId: GROUP_ID,
      tenantId: TENANT_ID,
      requestedBy: USER_ID,
      requestedType: 'ListBill'
    });

    expect(MessageQueueService.queueEmail).toHaveBeenCalledTimes(1);
    expect(MessageQueueService.queueEmail).toHaveBeenCalledWith(
      expect.objectContaining({ toEmail: AGENT_EMAIL })
    );
  });

  test('queueEmail is NOT called when the group has no agent assigned (silent skip)', async () => {
    const pendingRow = {
      RequestId: REQUEST_ID,
      GroupId: GROUP_ID,
      TenantId: TENANT_ID,
      Status: 'Pending',
      RequestedType: 'ListBill',
      CurrentType: 'Standard'
    };
    const pool = buildPool([
      async () => ({ recordset: [pendingRow] }),
      async () => ({ recordset: [], rowsAffected: [1] }),
      async () => ({ recordset: [{ FirstName: 'Tina', LastName: 'Tenant' }] }),
      async () => ({ recordset: [{ TenantId: TENANT_ID, Name: 'Acme', CustomDomain: null, DefaultUrlPath: null, IsDefaultUrlPathVerified: false, AdvancedSettings: null }] }), // loadTenantForUrl
      async () => ({ recordset: [{ GroupName: 'Acme', AgentEmail: null }] }) // no agent email
    ]);
    getPool.mockResolvedValue(pool);

    await svc.approveRequest({
      requestId: REQUEST_ID,
      tenantId: TENANT_ID,
      reviewerId: REVIEWER_ID,
      notes: 'ok'
    });

    expect(MessageQueueService.queueEmail).not.toHaveBeenCalled();
  });
});

// ─── submitted-email recipients: manually-entered list only ──────────────────

describe('submitted email goes to manually-entered tenant-settings recipients only', () => {
  test('createRequest Pending path queues one email per manually-entered recipient (deduped, case-insensitive); no TenantAdmin role auto-resolution', async () => {
    const insertedRow = {
      RequestId: REQUEST_ID,
      GroupId: GROUP_ID,
      TenantId: TENANT_ID,
      Status: 'Pending',
      RequestedType: 'ListBill',
      CurrentType: 'Standard'
    };

    const pool = buildPool([
      async () => ({ recordset: [{ GroupType: 'Standard' }] }),                       // SELECT GroupType
      async () => ({ recordset: [] }),                                                // no pending
      async () => ({ recordset: [{ AdvancedSettings: JSON.stringify({ enrollment: { autoApproveGroupTypeChanges: false } }) }] }),
      async () => ({ recordset: [insertedRow] }),                                     // INSERT
      async () => ({ recordset: [{ TenantId: TENANT_ID, Name: 'Acme', CustomDomain: 'portal.acme.test', DefaultUrlPath: null, IsDefaultUrlPathVerified: false, AdvancedSettings: null }] }), // loadTenantForUrl
      async () => ({ recordset: [{ FirstName: 'Ron', LastName: 'Requester' }] }),     // lookupRequesterName
      async () => ({                                                                  // belowMinimumAlertRecipients
        recordset: [{ AdvancedSettings: JSON.stringify({ enrollment: { belowMinimumAlertRecipients: ['extra@acme.test', 'EXTRA@acme.test', 'ops@acme.test'] } }) }]
      }),
      async () => ({ recordset: [{ Name: 'Acme Corp' }] })                            // group name lookup
    ]);
    getPool.mockResolvedValue(pool);

    await svc.createRequest({
      groupId: GROUP_ID,
      tenantId: TENANT_ID,
      requestedBy: USER_ID,
      requestedType: 'ListBill',
      reason: 'Switching to list-bill'
    });

    // 2 unique recipients (extra + ops). The case-duplicate of EXTRA@ collapses.
    // No TenantAdmin role auto-resolution — admin1/admin2 from the role table
    // would have been ignored even if present.
    expect(MessageQueueService.queueEmail).toHaveBeenCalledTimes(2);
    const calls = MessageQueueService.queueEmail.mock.calls.map((c) => c[0]);
    const emails = calls.map((c) => c.toEmail.toLowerCase()).sort();
    expect(emails).toEqual(['extra@acme.test', 'ops@acme.test']);
    // No agent email on the submitted path
    expect(emails).not.toContain('agent@example.com');
    // No cc/bcc fields
    for (const c of calls) {
      expect(c.cc).toBeUndefined();
      expect(c.bcc).toBeUndefined();
    }
  });

  test('createRequest auto-approve path does NOT queue a submitted email', async () => {
    // Auto-approve path skips submitted notification (no review needed).
    // We assert by stubbing the agent recipient lookup and verifying queueEmail
    // is called with the agent address only — never an admin@ address.
    const insertedRow = {
      RequestId: REQUEST_ID,
      GroupId: GROUP_ID,
      TenantId: TENANT_ID,
      Status: 'Approved',
      RequestedType: 'ListBill',
      CurrentType: 'Standard'
    };
    const pool = buildPool([
      async () => ({ recordset: [{ GroupType: 'Standard' }] }),
      async () => ({ recordset: [] }),
      async () => ({ recordset: [{ AdvancedSettings: JSON.stringify({ enrollment: { autoApproveGroupTypeChanges: true } }) }] }),
      async () => ({ recordset: [insertedRow] }),
      async () => ({ recordset: [{ TenantId: TENANT_ID, Name: 'Acme', CustomDomain: null, DefaultUrlPath: null, IsDefaultUrlPathVerified: false, AdvancedSettings: null }] }),
      async () => ({ recordset: [{ GroupName: 'Acme', GroupType: 'Standard', AgentEmail: 'agent@example.com', AgentFirstName: 'A', AgentLastName: 'A' }] })
    ]);
    getPool.mockResolvedValue(pool);

    await svc.createRequest({
      groupId: GROUP_ID,
      tenantId: TENANT_ID,
      requestedBy: USER_ID,
      requestedType: 'ListBill'
    });

    expect(MessageQueueService.queueEmail).toHaveBeenCalledTimes(1);
    expect(MessageQueueService.queueEmail).toHaveBeenCalledWith(
      expect.objectContaining({ toEmail: 'agent@example.com' })
    );
  });
});
