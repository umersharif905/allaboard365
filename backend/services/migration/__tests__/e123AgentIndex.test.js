'use strict';

jest.mock('../e123Api.service', () => ({
  fetchAllUsersForBroker: jest.fn()
}));
jest.mock('../e123Agent.service', () => ({
  getAgentById: jest.fn()
}));
jest.mock('../e123Config', () => ({
  assertMemberSearchConfigured: jest.fn(),
  assertOrgBrokerConfigured: jest.fn(() => 1001),
  getE123OrgBrokerId: jest.fn(() => 1001)
}));
jest.mock('../orgBrokerResolver.service', () => ({
  resolveOrgLabel: jest.fn(async () => 'ShareWELL Partners')
}));

const { fetchAllUsersForBroker } = require('../e123Api.service');
const e123AgentIndex = require('../e123AgentIndex.service');

describe('e123AgentIndex.searchAgents', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fetchAllUsersForBroker.mockImplementation(() => new Promise(() => {}));
  });

  test('returns indexBuilding immediately when cache is cold', async () => {
    const result = await e123AgentIndex.searchAgents({ search: '', limit: 100 });
    expect(result.indexBuilding).toBe(true);
    expect(result.agents).toEqual([]);
    expect(fetchAllUsersForBroker).toHaveBeenCalled();
  });
});
