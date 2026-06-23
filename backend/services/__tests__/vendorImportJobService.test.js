'use strict';

const VENDOR_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CONN_ID   = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const TENANT_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const JOB_ID    = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

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

jest.mock('../../services/vendorImportTenants.service', () => ({
  assertTenantEligibleForVendorImport: jest.fn().mockResolvedValue(undefined),
  getImportEligibleTenantsForVendor: jest.fn().mockResolvedValue([]),
}));

jest.mock('../../services/vendorImportFormatPreset.service', () => ({
  isValidFormatSlug: jest.fn().mockResolvedValue(true),
  listFormatPresets: jest.fn().mockResolvedValue([]),
  getFormatPreset: jest.fn().mockResolvedValue(null),
  clearCache: jest.fn(),
}));

const vendorImportTenants = require('../../services/vendorImportTenants.service');

function setPoolResponses(...responses) {
  poolQueryCallIndex = 0;
  poolQueryResponses = responses;
}

function makeJobRow(overrides = {}) {
  return {
    JobId: JOB_ID,
    VendorId: VENDOR_ID,
    ConnectionId: CONN_ID,
    TenantId: TENANT_ID,
    JobName: 'Test Job',
    SubFolderPath: null,
    FormatSlug: 'sharewell_default',
    CronScheduleUtc: '0 0 5 * * *',
    ArchiveFolder: 'archived',
    NotifyEmails: JSON.stringify(['admin@example.com']),
    NotifyOnSuccess: 1,
    NotifyOnFailure: 1,
    NotifyOnNoFiles: 0,
    LegacyProcessorKey: null,
    IsEnabled: 0,
    IsRunning: 0,
    LastRunAtUtc: null,
    CreatedBy: null,
    CreatedUtc: new Date(),
    ModifiedUtc: new Date(),
    ...overrides,
  };
}

let svc;
beforeAll(() => {
  svc = require('../../services/vendorImportJobService');
});

beforeEach(() => {
  jest.clearAllMocks();
  poolQueryCallIndex = 0;
  poolQueryResponses = [];
});

const VALID_JOB_PARAMS = {
  vendorId: VENDOR_ID,
  connectionId: CONN_ID,
  tenantId: TENANT_ID,
  jobName: 'Test Job',
  formatSlug: 'sharewell_default',
  cronScheduleUtc: '0 0 5 * * *',
  notifyEmails: ['admin@example.com'],
};

describe('createJob', () => {
  test('creates job with IsEnabled=0 by default', async () => {
    // connection check + insert
    setPoolResponses(
      { recordset: [{ Found: 1 }] },
      { recordset: [makeJobRow()] },
    );
    const result = await svc.createJob(VALID_JOB_PARAMS);
    expect(result.isEnabled).toBe(false);
    expect(result.jobId).toBe(JOB_ID);
  });

  test('rejects cross-vendor connection', async () => {
    setPoolResponses({ recordset: [] }); // connection check returns empty
    await expect(svc.createJob(VALID_JOB_PARAMS)).rejects.toThrow(/not found|does not belong/i);
  });

  test('rejects ineligible tenant', async () => {
    setPoolResponses({ recordset: [{ Found: 1 }] }); // connection ok
    vendorImportTenants.assertTenantEligibleForVendorImport.mockRejectedValueOnce(
      new Error('Tenant not eligible')
    );
    await expect(svc.createJob(VALID_JOB_PARAMS)).rejects.toThrow(/not eligible/i);
  });

  test('rejects invalid cron expression', async () => {
    await expect(svc.createJob({ ...VALID_JOB_PARAMS, cronScheduleUtc: 'not-a-cron' }))
      .rejects.toThrow(/invalid cron/i);
  });

  test('rejects unknown format slug', async () => {
    const formatPresets = require('../../services/vendorImportFormatPreset.service');
    formatPresets.isValidFormatSlug.mockResolvedValueOnce(false);
    await expect(svc.createJob({ ...VALID_JOB_PARAMS, formatSlug: 'bogus_slug' }))
      .rejects.toThrow(/unknown format slug/i);
  });

  test('rejects invalid notify email', async () => {
    await expect(svc.createJob({ ...VALID_JOB_PARAMS, notifyEmails: ['notanemail'] }))
      .rejects.toThrow(/invalid/i);
  });
});

describe('setEnabled', () => {
  test('enables a job', async () => {
    setPoolResponses({ recordset: [{ JobId: JOB_ID, IsEnabled: 1 }] });
    const result = await svc.setEnabled(JOB_ID, VENDOR_ID, true);
    expect(result.isEnabled).toBe(true);
  });

  test('disables a job', async () => {
    setPoolResponses({ recordset: [{ JobId: JOB_ID, IsEnabled: 0 }] });
    const result = await svc.setEnabled(JOB_ID, VENDOR_ID, false);
    expect(result.isEnabled).toBe(false);
  });

  test('returns null when job not found (vendor mismatch)', async () => {
    setPoolResponses({ recordset: [] });
    const result = await svc.setEnabled(JOB_ID, 'wrong-vendor', true);
    expect(result).toBeNull();
  });
});

describe('deleteJob', () => {
  test('throws 409 when job is running', async () => {
    setPoolResponses({ recordset: [{ IsRunning: 1 }] });
    await expect(svc.deleteJob(JOB_ID, VENDOR_ID)).rejects.toMatchObject({ statusCode: 409 });
  });

  test('deletes when job is not running', async () => {
    setPoolResponses(
      { recordset: [{ IsRunning: 0 }] }, // running check
      { recordset: [] },                  // delete
    );
    const result = await svc.deleteJob(JOB_ID, VENDOR_ID);
    expect(result).toBe(true);
  });
});

describe('validateCron', () => {
  test('accepts valid 6-part cron', () => {
    expect(svc.validateCron('0 */5 * * * *')).toBe(true);
  });
  test('rejects invalid cron', () => {
    expect(svc.validateCron('not valid cron')).toBe(false);
  });
});
