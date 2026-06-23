jest.mock('@azure/service-bus', () => ({
  ServiceBusClient: jest.fn().mockImplementation(() => ({
    createSender: () => ({
      sendMessages: jest.fn().mockResolvedValue(),
      close: jest.fn().mockResolvedValue(),
    }),
  })),
}));

describe('extractionQueue', () => {
  beforeEach(() => { jest.resetModules(); delete process.env.AI_EXTRACTION_DISABLED; });

  it('throws when SERVICE_BUS_CONNECTION is missing', async () => {
    delete process.env.SERVICE_BUS_CONNECTION;
    const { enqueueExtraction } = require('../extractionQueue');
    await expect(enqueueExtraction({ productDocumentId: 'd1' })).rejects.toThrow(/SERVICE_BUS_CONNECTION/);
  });

  it('no-ops when AI_EXTRACTION_DISABLED=1', async () => {
    process.env.AI_EXTRACTION_DISABLED = '1';
    const { enqueueExtraction } = require('../extractionQueue');
    await expect(enqueueExtraction({ productDocumentId: 'd1' })).resolves.toBeUndefined();
  });

  it('sends a message when configured', async () => {
    process.env.SERVICE_BUS_CONNECTION = 'Endpoint=fake';
    const { enqueueExtraction } = require('../extractionQueue');
    await expect(enqueueExtraction({ productDocumentId: 'd1' })).resolves.toBeUndefined();
  });
});
