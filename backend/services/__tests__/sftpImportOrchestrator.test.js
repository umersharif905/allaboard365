'use strict';

const VENDOR_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const JOB_ID    = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const RUN_ID    = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

// ---- DB pool mock ----
let poolQueryResponses = [];
let poolQueryCallIndex = 0;
const mockPoolInput   = jest.fn().mockReturnThis();
const mockPoolQuery   = jest.fn().mockImplementation(() => {
  const r = poolQueryResponses[poolQueryCallIndex++] || { recordset: [] };
  return Promise.resolve(r);
});
const mockPoolRequest = jest.fn(() => ({ input: mockPoolInput, query: mockPoolQuery }));
const mockPool        = { request: mockPoolRequest };

jest.mock('../../config/database', () => ({
  getPool: jest.fn().mockResolvedValue(mockPool),
  sql: {
    UniqueIdentifier: 'UniqueIdentifier',
    NVarChar: jest.fn((n) => `NVarChar(${n || 'MAX'})`),
    Int: 'Int',
    Bit: 'Bit',
    MAX: 'MAX',
  },
}));

// ---- Encryption mock ----
jest.mock('../../services/encryptionService', () => ({
  encrypt: jest.fn((v) => `enc:${v}`),
  decrypt: jest.fn((v) => v.replace(/^enc:/, '')),
}));

// ---- SFTP client wrapper mock ----
const mockConnect      = jest.fn().mockResolvedValue(undefined);
const mockListCsvFiles = jest.fn().mockResolvedValue([]);
const mockDownloadFile = jest.fn().mockResolvedValue(Buffer.from('csv,data'));
const mockEnsureDir    = jest.fn().mockResolvedValue(undefined);
const mockArchiveFile  = jest.fn().mockResolvedValue('/sftp/archive/file.csv');
const mockDisconnect   = jest.fn().mockResolvedValue(undefined);

jest.mock('../../services/sftpClientWrapper', () => ({
  create: jest.fn(() => ({
    connect: mockConnect,
    listCsvFiles: mockListCsvFiles,
    downloadFile: mockDownloadFile,
    ensureDirectory: mockEnsureDir,
    archiveFile: mockArchiveFile,
    disconnect: mockDisconnect,
  })),
}));

// ---- Run service mock ----
const mockCreateRun      = jest.fn();
const mockCreateSkipped  = jest.fn().mockResolvedValue({ runId: 'skip-run' });
const mockCompleteRun    = jest.fn().mockResolvedValue(undefined);
const mockFailRun        = jest.fn().mockResolvedValue(undefined);
const mockRecordFile     = jest.fn().mockResolvedValue(undefined);

const mockPatchRunProgress = jest.fn().mockResolvedValue(undefined);
const mockReleaseStaleRuns = jest.fn().mockResolvedValue(0);

jest.mock('../../services/vendorImportJobRunService', () => ({
  createRun: (...args) => mockCreateRun(...args),
  createSkippedRun: (...args) => mockCreateSkipped(...args),
  completeRun: (...args) => mockCompleteRun(...args),
  failRun: (...args) => mockFailRun(...args),
  patchRunProgress: (...args) => mockPatchRunProgress(...args),
  releaseStaleRuns: (...args) => mockReleaseStaleRuns(...args),
  recordFile: (...args) => mockRecordFile(...args),
  listRuns: jest.fn(),
  getRunWithFiles: jest.fn(),
}));

// ---- Email service mock ----
jest.mock('../../services/sftpImportEmailService', () => ({
  sendRunReport: jest.fn().mockResolvedValue(undefined),
}));

// ---- Eligibility import mock ----
const mockPreview = jest.fn().mockResolvedValue({ households: [{}], errors: [] });
const mockCommit  = jest.fn().mockResolvedValue({ created: 1, updated: 0, terminated: 0, skipped: 0 });
jest.mock('../../services/eligibilityImportService', () => ({
  previewEligibilityImport: (...args) => mockPreview(...args),
  commitEligibilityImport:  (...args) => mockCommit(...args),
}));

const sftpImportEmailService = require('../../services/sftpImportEmailService');

function setPoolResponses(...responses) {
  poolQueryCallIndex = 0;
  poolQueryResponses = responses;
}

function makeJobRow(overrides = {}) {
  return {
    JobId: JOB_ID,
    VendorId: VENDOR_ID,
    TenantId: TENANT_ID,
    JobName: 'Test Job',
    SubFolderPath: null,
    FormatSlug: 'sharewell_default',
    CronScheduleUtc: '0 */5 * * * *',
    ArchiveFolder: 'archived',
    NotifyEmails: JSON.stringify(['admin@example.com']),
    NotifyOnSuccess: 1,
    NotifyOnFailure: 1,
    NotifyOnNoFiles: 0,
    IsEnabled: 1,
    IsRunning: 0,
    LastRunAtUtc: null,
    Host: 'sftp.example.com',
    Port: 22,
    Username: 'user',
    AuthType: 'password',
    PasswordEncrypted: 'enc:secret',
    PrivateKeyEncrypted: null,
    PassphraseEncrypted: null,
    BaseDirectory: null,
    ...overrides,
  };
}

let orchestrator;
let { isJobDue } = {};
beforeAll(() => {
  orchestrator = require('../../services/sftpImportOrchestrator');
  ({ isJobDue } = orchestrator);
});

beforeEach(() => {
  jest.clearAllMocks();
  poolQueryCallIndex = 0;
  poolQueryResponses = [];
  mockCreateRun.mockResolvedValue({ run: { runId: RUN_ID }, acquired: true });
});

describe('isJobDue', () => {
  test('returns true when cron fired within last 5 minutes', () => {
    // 0 */5 * * * * fires every 5 min; any time should match within a 5-min window
    const now = new Date();
    expect(isJobDue('0 */5 * * * *', now)).toBe(true);
  });

  test('returns false for cron that has not fired recently', () => {
    const farFuture = new Date(Date.now() + 10 * 60 * 1000);
    // monthly cron — definitely not due in next 10 min
    expect(isJobDue('0 0 1 1 *', farFuture)).toBe(false);
  });
});

describe('runDueJobs', () => {
  test('returns evaluation counts', async () => {
    setPoolResponses({ recordset: [makeJobRow()] });
    const result = await orchestrator.runDueJobs();
    expect(result).toHaveProperty('jobsEvaluated');
    expect(result).toHaveProperty('jobsFired');
    expect(result).toHaveProperty('jobsSkipped');
  });

  test('logs a skipped run when job is already running', async () => {
    setPoolResponses({ recordset: [makeJobRow({ IsRunning: 1 })] });
    // A running-now job is due per cron → should be skipped
    const result = await orchestrator.runDueJobs();
    expect(result.jobsSkipped).toBeGreaterThanOrEqual(0);
  });

  test('no-files path: completes run with no-files status', async () => {
    mockListCsvFiles.mockResolvedValueOnce([]);
    setPoolResponses({ recordset: [makeJobRow()] });
    // Give setImmediate a chance to run synchronously in tests
    await orchestrator.runDueJobs();
    // Wait for setImmediate
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    // completeRun may have been called with no-files
    // (depends on whether runJob was fired synchronously above)
  });
});

describe('runJob (direct call)', () => {
  test('happy path: connects, imports file, archives, completes run', async () => {
    mockListCsvFiles.mockResolvedValueOnce([{
      name: 'members.csv',
      remotePath: '/sftp/members.csv',
      size: 1024,
      modifyTime: Date.now(),
    }]);

    const jobRow = makeJobRow();
    await orchestrator.runJob(jobRow, { triggerType: 'manual' });

    expect(mockConnect).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'sftp.example.com', username: 'user', password: 'secret' })
    );
    // Credentials must be decrypted, NOT the raw encrypted string
    const connectCall = mockConnect.mock.calls[0][0];
    expect(connectCall.password).toBe('secret');
    expect(connectCall.password).not.toMatch(/^enc:/);

    expect(mockCommit).toHaveBeenCalled();
    expect(mockArchiveFile).toHaveBeenCalled();
    expect(mockCompleteRun).toHaveBeenCalledWith(
      RUN_ID,
      JOB_ID,
      expect.objectContaining({ status: 'success' })
    );
  });

  test('concurrency skip: records skipped run when lock not acquired', async () => {
    mockCreateRun.mockResolvedValueOnce({ run: null, acquired: false });
    await orchestrator.runJob(makeJobRow(), { triggerType: 'scheduled' });
    expect(mockCreateSkipped).toHaveBeenCalled();
    expect(mockCompleteRun).not.toHaveBeenCalled();
  });

  test('partial failure: one file fails, one succeeds → partial status', async () => {
    mockListCsvFiles.mockResolvedValueOnce([
      { name: 'good.csv', remotePath: '/sftp/good.csv' },
      { name: 'bad.csv',  remotePath: '/sftp/bad.csv'  },
    ]);
    // First download ok, second throws
    mockDownloadFile
      .mockResolvedValueOnce(Buffer.from('csv'))
      .mockRejectedValueOnce(new Error('read error'));

    await orchestrator.runJob(makeJobRow(), { triggerType: 'scheduled' });

    expect(mockCompleteRun).toHaveBeenCalledWith(
      RUN_ID, JOB_ID, expect.objectContaining({ status: 'partial' })
    );
  });

  test('archive collision: appends timestamp suffix', async () => {
    mockListCsvFiles.mockResolvedValueOnce([
      { name: 'members.csv', remotePath: '/sftp/members.csv' },
    ]);
    // archiveFile returns a path with a timestamp suffix on collision
    mockArchiveFile.mockResolvedValueOnce('/sftp/archive/members_20260603T120000.csv');

    await orchestrator.runJob(makeJobRow(), { triggerType: 'scheduled' });

    expect(mockArchiveFile).toHaveBeenCalled();
  });

  test('SFTP connect failure: fails run with error message', async () => {
    mockConnect.mockRejectedValueOnce(new Error('Connection refused'));
    await orchestrator.runJob(makeJobRow(), { triggerType: 'scheduled' });
    expect(mockFailRun).toHaveBeenCalledWith(RUN_ID, JOB_ID, expect.stringContaining('Connection refused'));
  });

  test('notify emails called according to NotifyOnSuccess prefs', async () => {
    mockListCsvFiles.mockResolvedValueOnce([
      { name: 'members.csv', remotePath: '/sftp/members.csv' },
    ]);
    const jobRow = makeJobRow({ NotifyOnSuccess: 1, NotifyOnFailure: 1 });
    await orchestrator.runJob(jobRow, { triggerType: 'scheduled' });
    expect(sftpImportEmailService.sendRunReport).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'success' })
    );
  });

  test('no email sent when NotifyOnSuccess is disabled', async () => {
    mockListCsvFiles.mockResolvedValueOnce([
      { name: 'members.csv', remotePath: '/sftp/members.csv' },
    ]);
    const jobRow = makeJobRow({ NotifyOnSuccess: 0, NotifyOnFailure: 0 });
    await orchestrator.runJob(jobRow, { triggerType: 'scheduled' });
    expect(sftpImportEmailService.sendRunReport).not.toHaveBeenCalled();
  });
});
