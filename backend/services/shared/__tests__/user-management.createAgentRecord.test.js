jest.mock('../../agentCode.service', () => ({
  generateAgentCode: jest.fn().mockResolvedValue('AG10000999'),
}));

const UserManagementService = require('../user-management.service');
const { generateAgentCode } = require('../../agentCode.service');

function makeMockTransaction() {
  const request = {
    input: jest.fn().mockReturnThis(),
    query: jest.fn().mockResolvedValue({}),
  };
  return { request: jest.fn(() => request), _request: request };
}

describe('UserManagementService.createAgentRecord', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('generates an AgentCode and includes it in the Agents INSERT', async () => {
    const transaction = makeMockTransaction();
    const user = { UserId: 'creator-uuid', TenantId: 'tenant-uuid-123' };

    await UserManagementService.createAgentRecord(transaction, 'new-user-uuid', user);

    expect(generateAgentCode).toHaveBeenCalledWith(transaction, 'tenant-uuid-123');

    const inputCalls = transaction._request.input.mock.calls;
    const inputNames = inputCalls.map((c) => c[0]);
    expect(inputNames).toContain('agentCode');

    const agentCodeCall = inputCalls.find((c) => c[0] === 'agentCode');
    expect(agentCodeCall[2]).toBe('AG10000999');

    const insertSql = transaction._request.query.mock.calls[0][0];
    expect(insertSql).toMatch(/INSERT INTO oe\.Agents/);
    expect(insertSql).toMatch(/AgentCode/);
    expect(insertSql).toMatch(/@agentCode/);
  });
});
