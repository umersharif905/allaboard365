/**
 * /api/website-form-submissions — create-on-match behavior (Track B1).
 *
 *   - matched submission -> findOrCreateProspect called with source 'MightyWELL Website'
 *     + the matched agentId + split name/notes; prospectId returned in the JSON.
 *   - unmatched submission -> findOrCreateProspect NOT called; prospectId null.
 *   - a prospect create error -> the submission still returns 200 with prospectId null.
 *
 * DB and prospect.service are mocked. resolveAgent runs against the mocked pool, so we
 * drive "matched" vs "not_found" by what the agent-lookup query returns.
 *
 * Run: npx jest routes/__tests__/website-form-submissions.routes.test.js
 */

const express = require('express');
const request = require('supertest');

let agentLookupRows = []; // what the resolveAgent SELECT returns
let insertReturnsSubmissionId = 'sub-1';

const fakePool = {
  request: () => {
    const r = {
      input: () => r,
      query: async (sql) => {
        if (/INSERT INTO oe\.WebsiteFormSubmissions/.test(sql)) {
          return { recordset: [{ SubmissionId: insertReturnsSubmissionId }] };
        }
        if (/FROM oe\.Agents a[\s\S]*INNER JOIN oe\.Users u/.test(sql)) {
          return { recordset: agentLookupRows };
        }
        return { recordset: [] };
      },
    };
    return r;
  },
};

jest.mock('../../config/database', () => ({
  getPool: jest.fn(async () => fakePool),
  sql: require('mssql'),
}));
jest.mock('../../config/logger', () => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn() }));
jest.mock('../../services/prospect.service', () => ({
  findOrCreateProspect: jest.fn(),
}));

const prospectService = require('../../services/prospect.service');
const websiteRouter = require('../website-form-submissions');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { TenantId: 't1' }; next(); });
  app.use('/api/website-form-submissions', websiteRouter);
  return app;
}

const MATCHED_AGENT_ROW = { AgentId: 'agent-1', AgentCode: 'AB12', FirstName: 'Al', LastName: 'Bee', Email: 'al@x.com' };

const baseBody = {
  source: 'quote',
  formType: 'individual',
  attemptedAgentName: 'Al Bee',
  subject: 'Need a quote',
  submitter: { name: 'Jane Q Doe', email: 'jane@x.com', phone: '2015551234', state: 'TX', company: 'Globex' },
};

beforeEach(() => {
  jest.clearAllMocks();
  agentLookupRows = [];
  insertReturnsSubmissionId = 'sub-1';
});

describe('POST /api/website-form-submissions', () => {
  test('matched -> creates a prospect with source MightyWELL Website + agentId, returns prospectId', async () => {
    agentLookupRows = [MATCHED_AGENT_ROW];
    prospectService.findOrCreateProspect.mockResolvedValue({ prospect: { ProspectId: 'pros-1' }, created: true });

    const res = await request(buildApp()).post('/api/website-form-submissions').send(baseBody);
    expect(res.status).toBe(200);
    expect(res.body.matchStatus).toBe('matched');
    expect(res.body.prospectId).toBe('pros-1');

    expect(prospectService.findOrCreateProspect).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 't1',
        agentId: 'agent-1',
        firstName: 'Jane',
        lastName: 'Q Doe',
        email: 'jane@x.com',
        phone: '2015551234',
        referralName: 'Al Bee',
        source: 'MightyWELL Website',
        status: 'New',
      })
    );
    // Notes should join company/state/formType/subject.
    const arg = prospectService.findOrCreateProspect.mock.calls[0][0];
    expect(arg.notes).toContain('Company: Globex');
    expect(arg.notes).toContain('State: TX');
    expect(arg.notes).toContain('Form type: individual');
    expect(arg.notes).toContain('Need a quote');
  });

  test('unmatched -> does NOT create a prospect; prospectId null', async () => {
    agentLookupRows = []; // no agent found by name
    const res = await request(buildApp()).post('/api/website-form-submissions').send(baseBody);
    expect(res.status).toBe(200);
    expect(res.body.matchStatus).toBe('not_found');
    expect(res.body.prospectId).toBeNull();
    expect(prospectService.findOrCreateProspect).not.toHaveBeenCalled();
  });

  test('create error -> submission still 200 with prospectId null', async () => {
    agentLookupRows = [MATCHED_AGENT_ROW];
    prospectService.findOrCreateProspect.mockRejectedValue(new Error('db blew up'));

    const res = await request(buildApp()).post('/api/website-form-submissions').send(baseBody);
    expect(res.status).toBe(200);
    expect(res.body.matchStatus).toBe('matched');
    expect(res.body.prospectId).toBeNull();
    expect(res.body.submissionId).toBe('sub-1');
  });
});
