'use strict';

process.env.SCHEDULED_JOB_API_KEY = 'test-api-key-12345';

const express = require('express');
const request = require('supertest');

// ---- Orchestrator mock ----
const mockRunDueJobs = jest.fn().mockResolvedValue({
  jobsEvaluated: 3,
  jobsFired: 2,
  jobsSkipped: 1,
});

jest.mock('../../services/sftpImportOrchestrator', () => ({
  runDueJobs: (...a) => mockRunDueJobs(...a),
  runJob: jest.fn(),
  runJobById: jest.fn(),
  isJobDue: jest.fn(),
}));

const router = require('../scheduled-jobs/sftp-import');
const app = express();
app.use(express.json());
app.use('/', router);

describe('POST / — scheduled SFTP import trigger', () => {
  beforeEach(() => jest.clearAllMocks());

  test('401 when x-api-key is missing', async () => {
    const res = await request(app).post('/');
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(mockRunDueJobs).not.toHaveBeenCalled();
  });

  test('401 when x-api-key is wrong', async () => {
    const res = await request(app).post('/').set('x-api-key', 'wrong-key');
    expect(res.status).toBe(401);
    expect(mockRunDueJobs).not.toHaveBeenCalled();
  });

  test('200 with valid key — calls runDueJobs and returns counts', async () => {
    const res = await request(app).post('/').set('x-api-key', 'test-api-key-12345');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.jobsEvaluated).toBe(3);
    expect(res.body.data.jobsFired).toBe(2);
    expect(res.body.data.jobsSkipped).toBe(1);
    expect(mockRunDueJobs).toHaveBeenCalledTimes(1);
  });

  test('500 when runDueJobs throws', async () => {
    mockRunDueJobs.mockRejectedValueOnce(new Error('DB connection failed'));
    const res = await request(app).post('/').set('x-api-key', 'test-api-key-12345');
    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
  });
});
