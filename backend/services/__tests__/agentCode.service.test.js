const { generateAgentCode } = require('../agentCode.service');

describe('agentCode.service', () => {
  function makeMockTransactionOrPool(outputValue) {
    const request = {
      input: jest.fn().mockReturnThis(),
      output: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ output: { AgentCode: outputValue } }),
    };
    return { request: jest.fn(() => request), _request: request };
  }

  it('calls oe.GenerateAgentCode with the tenant id and returns the output AgentCode', async () => {
    const mock = makeMockTransactionOrPool('MWA000124');
    const code = await generateAgentCode(mock, 'tenant-uuid-123');

    expect(code).toBe('MWA000124');
    expect(mock._request.input).toHaveBeenCalledWith(
      'TenantId',
      expect.anything(),
      'tenant-uuid-123'
    );
    expect(mock._request.output).toHaveBeenCalledWith(
      'AgentCode',
      expect.anything()
    );
    expect(mock._request.execute).toHaveBeenCalledWith('oe.GenerateAgentCode');
  });

  it('throws when the procedure returns no AgentCode', async () => {
    const mock = makeMockTransactionOrPool(null);
    await expect(generateAgentCode(mock, 'tenant-uuid-123'))
      .rejects.toThrow(/AgentCode/);
  });
});
