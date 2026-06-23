const axios = require('axios');

jest.mock('axios', () => ({
  post: jest.fn()
}));

describe('bugReportWebhookService', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.BUG_REPORT_WEBHOOK_URL = 'https://api2.cursor.sh/automations/webhook/test-id';
    process.env.BUG_REPORT_WEBHOOK_BEARER_TOKEN = 'crsr_test_token';
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('POSTs context and payload to webhook URL with Bearer and Content-Type', async () => {
    const { publishBugReport } = require('../../bugReportWebhookService');

    axios.post.mockResolvedValue({ data: { ok: true } });

    await publishBugReport({
      context: 'add a page at /helloworld that says hello world',
      payload: { key: 'my key', value: 'my value' }
    });

    expect(axios.post).toHaveBeenCalledTimes(1);
    const [url, body, config] = axios.post.mock.calls[0];
    expect(url).toBe('https://api2.cursor.sh/automations/webhook/test-id');
    expect(config.headers['Authorization']).toBe('Bearer crsr_test_token');
    expect(config.headers['Content-Type']).toBe('application/json');
    expect(body).toEqual({
      context: 'add a page at /helloworld that says hello world',
      payload: { key: 'my key', value: 'my value' }
    });
  });

  it('returns response data from axios', async () => {
    const { publishBugReport } = require('../../bugReportWebhookService');

    axios.post.mockResolvedValue({ data: { id: '123' } });

    const result = await publishBugReport({ context: 'test', payload: {} });

    expect(result).toEqual({ id: '123' });
  });

  it('throws when BUG_REPORT_WEBHOOK_URL is missing', async () => {
    delete process.env.BUG_REPORT_WEBHOOK_URL;
    const { publishBugReport } = require('../../bugReportWebhookService');

    await expect(publishBugReport({ context: 'x', payload: {} }))
      .rejects.toThrow('Bug report webhook not configured');
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('throws when BUG_REPORT_WEBHOOK_BEARER_TOKEN is missing', async () => {
    delete process.env.BUG_REPORT_WEBHOOK_BEARER_TOKEN;
    const { publishBugReport } = require('../../bugReportWebhookService');

    await expect(publishBugReport({ context: 'x', payload: {} }))
      .rejects.toThrow('Bug report webhook not configured');
    expect(axios.post).not.toHaveBeenCalled();
  });
});
