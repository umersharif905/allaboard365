'use strict';

/**
 * Tests for the nightly orchestrator's error-reporting wiring.
 *
 * The backend does not ship console logs to App Insights, so the AI inspector
 * (LogInspector) reads backend failures from oe.SystemIntegrationErrors. These
 * tests prove that step-level and row-level nightly errors are routed to
 * recordIntegrationError (category 'billing' → paged) and to Sentry, and that a
 * clean run reports nothing.
 */

const mockRecordIntegrationError = jest.fn().mockResolvedValue(undefined);
const mockCaptureException = jest.fn();

jest.mock('../integrationErrorService', () => ({
  recordIntegrationError: (...args) => mockRecordIntegrationError(...args),
}));
jest.mock('@sentry/node', () => ({
  captureException: (...args) => mockCaptureException(...args),
}));

// Heavy deps the module requires at load time — stub so require() is side-effect free.
jest.mock('../../config/database', () => ({ getPool: jest.fn() }));
jest.mock('../invoiceService', () => ({}));
jest.mock('../billingAuditDailyJob.service', () => ({ runDailyBillingAuditJob: jest.fn() }));
jest.mock('../billingAuditRun.service', () => ({ runAudits: jest.fn() }));
jest.mock('../overdueInvoiceReminderRunner.service', () => ({ run: jest.fn() }));

const {
  countReconcileRowErrors,
  reportNightlyErrors,
} = require('../billingNightlyOrchestrator.service');

beforeEach(() => {
  mockRecordIntegrationError.mockClear();
  mockCaptureException.mockClear();
});

describe('countReconcileRowErrors', () => {
  it('returns 0 for empty / missing reconcile', () => {
    expect(countReconcileRowErrors(null)).toBe(0);
    expect(countReconcileRowErrors({})).toBe(0);
    expect(countReconcileRowErrors({ tenants: [] })).toBe(0);
  });

  it('sums row errors across tenants and result shapes', () => {
    const reconcile = {
      tenants: [
        { tenantId: 'a', results: [{ errors: 2 }, { errorCount: 1 }] },
        { tenantId: 'b', results: { errorsList: ['x', 'y', 'z'] } },
        { tenantId: 'c', results: [{ errors: 0 }] },
      ],
    };
    expect(countReconcileRowErrors(reconcile)).toBe(6);
  });
});

describe('reportNightlyErrors', () => {
  it('reports nothing on a clean run', async () => {
    await reportNightlyErrors({ stepErrors: [], dimeReconcile: { tenants: [] } });
    expect(mockRecordIntegrationError).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('pages (critical) and hits Sentry when a step fails', async () => {
    await reportNightlyErrors({
      startedAt: 'x',
      finishedAt: 'y',
      stepErrors: [{ step: 'dime_status', tenantId: 't1', error: 'boom' }],
      dimeReconcile: { tenants: [] },
    });
    expect(mockRecordIntegrationError).toHaveBeenCalledTimes(1);
    const arg = mockRecordIntegrationError.mock.calls[0][0];
    expect(arg.category).toBe('billing');
    expect(arg.priority).toBe('critical');
    expect(arg.source).toBe('billingNightlyOrchestrator');
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });

  it('records row errors as high priority (no Sentry) when no step failed', async () => {
    await reportNightlyErrors({
      stepErrors: [],
      dimeReconcile: { tenants: [{ results: [{ errors: 3 }] }] },
    });
    expect(mockRecordIntegrationError).toHaveBeenCalledTimes(1);
    const arg = mockRecordIntegrationError.mock.calls[0][0];
    expect(arg.category).toBe('billing');
    expect(arg.priority).toBe('high');
    expect(arg.detail.reconcileRowErrors).toBe(3);
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('never throws if recordIntegrationError rejects', async () => {
    mockRecordIntegrationError.mockRejectedValueOnce(new Error('db down'));
    await expect(
      reportNightlyErrors({
        stepErrors: [{ step: 'invoice_nightly', error: 'x' }],
        dimeReconcile: { tenants: [] },
      })
    ).resolves.toBeUndefined();
  });
});
