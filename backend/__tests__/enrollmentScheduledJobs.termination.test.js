// backend/__tests__/enrollmentScheduledJobs.termination.test.js
//
// Verifies that syncEnrollmentsPastTerminationDate() fires the PlanTermination campaign
// trigger once per terminated member (de-duped across multiple terminated plans), passing
// the right tenant/group/agent context and a comma-joined plan-name list.

const mockFireTrigger = jest.fn().mockResolvedValue({ campaignsTriggered: 1, messagesQueued: 1 });
jest.mock('../services/campaignTrigger.service', () => ({
  fireTrigger: (...args) => mockFireTrigger(...args)
}));

const mockRecordError = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/enrollmentLifecycleErrors.service', () => ({
  recordEnrollmentLifecycleError: (...args) => mockRecordError(...args)
}));

// getPool returns a pool whose single query() resolves to the terminated-rows recordset.
let terminatedRecordset = [];
const mockQuery = jest.fn().mockImplementation(() => ({ recordset: terminatedRecordset }));
jest.mock('../config/database', () => ({
  getPool: jest.fn().mockResolvedValue({ request: () => ({ query: mockQuery }) }),
  sql: { UniqueIdentifier: 'UniqueIdentifier' }
}));

const { syncEnrollmentsPastTerminationDate } = require('../services/enrollmentScheduledJobsService');

describe('syncEnrollmentsPastTerminationDate — PlanTermination trigger', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    terminatedRecordset = [];
  });

  it('does nothing extra when no enrollments terminated', async () => {
    terminatedRecordset = [];
    const result = await syncEnrollmentsPastTerminationDate();
    expect(result).toEqual({ updated: 0, campaignsTriggered: 0, messagesQueued: 0 });
    expect(mockFireTrigger).not.toHaveBeenCalled();
  });

  it('fires PlanTermination once per terminated member with member/tenant context', async () => {
    terminatedRecordset = [
      { MemberId: 'm1', AgentId: 'a1', GroupId: 'g1', TenantId: 't1', PlanName: 'Gold PPO' },
      { MemberId: 'm2', AgentId: null, GroupId: null, TenantId: 't1', PlanName: 'Silver HMO' }
    ];

    const result = await syncEnrollmentsPastTerminationDate();

    expect(result.updated).toBe(2);
    expect(mockFireTrigger).toHaveBeenCalledTimes(2);
    expect(mockFireTrigger).toHaveBeenCalledWith(expect.anything(), 'PlanTermination', {
      memberId: 'm1', tenantId: 't1', groupId: 'g1', agentId: 'a1', planName: 'Gold PPO'
    });
    expect(mockFireTrigger).toHaveBeenCalledWith(expect.anything(), 'PlanTermination', {
      memberId: 'm2', tenantId: 't1', groupId: null, agentId: null, planName: 'Silver HMO'
    });
  });

  it('de-dupes a member with several terminated plans into one trigger, joining plan names', async () => {
    terminatedRecordset = [
      { MemberId: 'm1', AgentId: 'a1', GroupId: 'g1', TenantId: 't1', PlanName: 'Gold PPO' },
      { MemberId: 'm1', AgentId: 'a1', GroupId: 'g1', TenantId: 't1', PlanName: 'Dental Plus' },
      { MemberId: 'm1', AgentId: 'a1', GroupId: 'g1', TenantId: 't1', PlanName: 'Gold PPO' } // duplicate plan name
    ];

    const result = await syncEnrollmentsPastTerminationDate();

    expect(result.updated).toBe(3); // 3 enrollments terminated
    expect(mockFireTrigger).toHaveBeenCalledTimes(1); // but one email
    expect(mockFireTrigger).toHaveBeenCalledWith(expect.anything(), 'PlanTermination', {
      memberId: 'm1', tenantId: 't1', groupId: 'g1', agentId: 'a1', planName: 'Gold PPO, Dental Plus'
    });
  });

  it('records an error but keeps going if a trigger throws', async () => {
    terminatedRecordset = [{ MemberId: 'm1', AgentId: null, GroupId: null, TenantId: 't1', PlanName: 'Gold PPO' }];
    mockFireTrigger.mockRejectedValueOnce(new Error('queue down'));

    const result = await syncEnrollmentsPastTerminationDate();

    expect(result.updated).toBe(1); // termination still succeeded
    expect(mockRecordError).toHaveBeenCalledTimes(1);
    expect(mockRecordError.mock.calls[0][0]).toMatchObject({
      category: 'EnrollmentTermination',
      detail: { op: 'firePlanTerminationTrigger', memberId: 'm1', tenantId: 't1' }
    });
  });

  it('skips rows missing member/tenant ids', async () => {
    terminatedRecordset = [{ MemberId: null, TenantId: null, PlanName: 'Orphan' }];
    const result = await syncEnrollmentsPastTerminationDate();
    expect(result.updated).toBe(1); // counted as terminated row
    expect(mockFireTrigger).not.toHaveBeenCalled(); // but no trigger
  });
});
