jest.mock('../lib/db', () => ({
  getDocStatus: jest.fn(),
  markRunning: jest.fn().mockResolvedValue(),
  markCompleted: jest.fn().mockResolvedValue(),
  markFailed: jest.fn().mockResolvedValue(),
  insertChunks: jest.fn().mockResolvedValue(),
}));
jest.mock('../lib/extractText', () => ({
  extractText: jest.fn(),
}));
jest.mock('../lib/extractChunks', () => ({
  extractChunks: jest.fn(),
}));
jest.mock('axios', () => ({
  get: jest.fn(),
}));

const db = require('../lib/db');
const { extractText } = require('../lib/extractText');
const { extractChunks } = require('../lib/extractChunks');
const axios = require('axios');

const handler = require('../ExtractProductDocument');

const baseMsg = {
  productDocumentId: 'd1', productId: 'p1', tenantId: 't1',
  blobUrl: 'https://blob/sample.pdf', fileName: 'sample.pdf',
};

const makeCtx = () => {
  const log = jest.fn();
  log.error = jest.fn();
  return { log };
};

beforeEach(() => { jest.clearAllMocks(); });

describe('ExtractProductDocument handler', () => {
  it('happy path: queued → running → completed', async () => {
    db.getDocStatus.mockResolvedValue({ ExtractionStatus: 'queued' });
    axios.get.mockResolvedValue({ data: Buffer.from('x'), headers: { 'content-type': 'application/pdf' } });
    extractText.mockResolvedValue('big text');
    extractChunks.mockResolvedValue({
      prose: [{ title: 'A', text: 'B' }],
      faqs: [{ question: 'Q', answer: 'A' }],
    });

    await handler(makeCtx(), baseMsg);

    expect(db.markRunning).toHaveBeenCalledWith('d1');
    expect(db.insertChunks).toHaveBeenCalledWith(expect.objectContaining({
      productId: 'p1', tenantId: 't1', documentId: 'd1',
      prose: [{ title: 'A', text: 'B' }],
      faqs: [{ question: 'Q', answer: 'A' }],
    }));
    expect(db.markCompleted).toHaveBeenCalledWith('d1', 2);
  });

  it('idempotency: status already running → drop', async () => {
    db.getDocStatus.mockResolvedValue({ ExtractionStatus: 'running' });
    await handler(makeCtx(), baseMsg);
    expect(db.markRunning).not.toHaveBeenCalled();
    expect(extractText).not.toHaveBeenCalled();
  });

  it('idempotency: status already completed → drop', async () => {
    db.getDocStatus.mockResolvedValue({ ExtractionStatus: 'completed' });
    await handler(makeCtx(), baseMsg);
    expect(db.markRunning).not.toHaveBeenCalled();
  });

  it('failure path: extraction throws → markFailed + rethrow', async () => {
    db.getDocStatus.mockResolvedValue({ ExtractionStatus: 'queued' });
    axios.get.mockResolvedValue({ data: Buffer.from('x'), headers: { 'content-type': 'application/pdf' } });
    extractText.mockRejectedValue(new Error('parse failed'));
    await expect(handler(makeCtx(), baseMsg)).rejects.toThrow('parse failed');
    expect(db.markFailed).toHaveBeenCalledWith('d1', expect.any(Error));
  });

  it('missing document → drop silently', async () => {
    db.getDocStatus.mockResolvedValue(null);
    await handler(makeCtx(), baseMsg);
    expect(db.markRunning).not.toHaveBeenCalled();
  });

  it('empty text throws and marks failed', async () => {
    db.getDocStatus.mockResolvedValue({ ExtractionStatus: 'queued' });
    axios.get.mockResolvedValue({ data: Buffer.from(''), headers: { 'content-type': 'application/pdf' } });
    extractText.mockResolvedValue('');
    await expect(handler(makeCtx(), baseMsg)).rejects.toThrow(/No extractable text/);
    expect(db.markFailed).toHaveBeenCalled();
  });
});
