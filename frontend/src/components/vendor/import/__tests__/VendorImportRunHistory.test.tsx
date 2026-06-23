import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { test, expect, vi, beforeEach, describe } from 'vitest';
import VendorImportRunHistory from '../VendorImportRunHistory';
import * as runsHook from '../../../../hooks/vendor/useVendorImportJobRuns';
import type { ImportJobRun } from '../../../../types/vendor/vendorSftpImport.types';

vi.mock('../../../../hooks/vendor/useVendorImportJobRuns', () => ({
  useVendorImportJobRuns: vi.fn(),
  useVendorImportJobRun: vi.fn(),
}));

const makeRun = (overrides: Partial<ImportJobRun> = {}): ImportJobRun => ({
  runId: 'run-1',
  jobId: 'job-1',
  vendorId: 'vendor-1',
  tenantId: 'tenant-1',
  triggerType: 'scheduled',
  status: 'success',
  filesFound: 3,
  filesImported: 3,
  filesFailed: 0,
  householdsCreated: 10,
  householdsUpdated: 5,
  householdsTerminated: 1,
  householdsSkipped: 0,
  errorSummary: null,
  startedUtc: '2026-06-01T12:00:00Z',
  completedUtc: '2026-06-01T12:02:00Z',
  ...overrides,
});

const wrap = (ui: React.ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
};

beforeEach(() => {
  vi.mocked(runsHook.useVendorImportJobRuns).mockReturnValue({
    data: {
      runs: [makeRun()],
      pagination: { page: 1, limit: 25, totalCount: 1, totalPages: 1 },
    },
    isLoading: false,
    isError: false,
  } as ReturnType<typeof runsHook.useVendorImportJobRuns>);
  vi.mocked(runsHook.useVendorImportJobRun).mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
  } as ReturnType<typeof runsHook.useVendorImportJobRun>);
});

describe('VendorImportRunHistory', () => {
  test('renders success status badge', () => {
    wrap(<VendorImportRunHistory />);
    // getAllByText since the filter dropdown also contains "Success"
    const matches = screen.getAllByText('Success');
    const badge = matches.find((el) => el.tagName.toLowerCase() === 'span');
    expect(badge).toBeInTheDocument();
    expect(badge?.className).toContain('green');
  });

  test('renders file counts', () => {
    wrap(<VendorImportRunHistory />);
    // Counts are rendered in separate text nodes inside a td — match the td text content
    const cell = screen.getByText((_content, element) => {
      return element?.tagName === 'TD' && /3 found/.test(element.textContent ?? '');
    });
    expect(cell).toBeInTheDocument();
  });

  test('renders household counts', () => {
    wrap(<VendorImportRunHistory />);
    expect(screen.getByText(/10 created/)).toBeInTheDocument();
    expect(screen.getByText(/5 updated/)).toBeInTheDocument();
  });

  test('shows empty state when no runs', () => {
    vi.mocked(runsHook.useVendorImportJobRuns).mockReturnValue({
      data: { runs: [], pagination: { page: 1, limit: 25, totalCount: 0, totalPages: 0 } },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof runsHook.useVendorImportJobRuns>);
    wrap(<VendorImportRunHistory />);
    expect(screen.getByText(/No runs yet/i)).toBeInTheDocument();
  });

  test('shows running spinner for running status', () => {
    vi.mocked(runsHook.useVendorImportJobRuns).mockReturnValue({
      data: {
        runs: [makeRun({ runId: 'run-2', status: 'running', completedUtc: null })],
        pagination: { page: 1, limit: 25, totalCount: 1, totalPages: 1 },
      },
      isLoading: false,
      isError: false,
    } as ReturnType<typeof runsHook.useVendorImportJobRuns>);
    wrap(<VendorImportRunHistory />);
    // Filter dropdown also has "Running" option; find the badge span specifically
    const matches = screen.getAllByText('Running');
    const badge = matches.find((el) => el.tagName.toLowerCase() === 'span');
    expect(badge).toBeInTheDocument();
  });

  test('shows failed status badge in red class', () => {
    vi.mocked(runsHook.useVendorImportJobRuns).mockReturnValue({
      data: {
        runs: [makeRun({ status: 'failed', errorSummary: 'SFTP connect timeout' })],
        pagination: { page: 1, limit: 25, totalCount: 1, totalPages: 1 },
      },
      isLoading: false,
      isError: false,
    } as ReturnType<typeof runsHook.useVendorImportJobRuns>);
    wrap(<VendorImportRunHistory />);
    // getAllByText since filter dropdown also has "Failed" option
    const matches = screen.getAllByText('Failed');
    const badge = matches.find((el) => el.tagName.toLowerCase() === 'span');
    expect(badge).toBeInTheDocument();
    expect(badge?.className).toContain('red');
  });

  test('expands row to show error summary', async () => {
    vi.mocked(runsHook.useVendorImportJobRuns).mockReturnValue({
      data: {
        runs: [makeRun({ status: 'failed', errorSummary: 'SFTP connect timeout', files: [] })],
        pagination: { page: 1, limit: 25, totalCount: 1, totalPages: 1 },
      },
      isLoading: false,
      isError: false,
    } as ReturnType<typeof runsHook.useVendorImportJobRuns>);
    wrap(<VendorImportRunHistory />);
    const row = screen.getAllByRole('row')[1]; // first data row
    fireEvent.click(row);
    await waitFor(() => expect(screen.getByText('SFTP connect timeout')).toBeInTheDocument());
  });

  test('loads run detail with household summaries when expanded', async () => {
    vi.mocked(runsHook.useVendorImportJobRuns).mockReturnValue({
      data: {
        runs: [makeRun({ runId: 'run-detail' })],
        pagination: { page: 1, limit: 25, totalCount: 1, totalPages: 1 },
      },
      isLoading: false,
      isError: false,
    } as ReturnType<typeof runsHook.useVendorImportJobRuns>);
    vi.mocked(runsHook.useVendorImportJobRun).mockReturnValue({
      data: makeRun({
        runId: 'run-detail',
        files: [{
          fileId: 'f1',
          runId: 'run-detail',
          jobId: 'job-1',
          vendorId: 'vendor-1',
          fileName: 'align.csv',
          remotePath: '/ALIGN/align.csv',
          status: 'success',
          householdsCreated: 0,
          householdsUpdated: 1,
          householdsTerminated: 0,
          householdsSkipped: 0,
          rowErrors: [{ row: 0, message: 'Archive failed: permission denied' }],
          importSummary: {
            households: [{
              name: 'Boatman, Jane',
              memberId: 'SW123',
              action: 'updated',
              plans: ['EE_1500'],
            }],
          },
          archivePath: null,
          processedUtc: '2026-06-04T06:12:00Z',
        }],
      }),
      isLoading: false,
      isError: false,
    } as ReturnType<typeof runsHook.useVendorImportJobRun>);

    wrap(<VendorImportRunHistory />);
    fireEvent.click(screen.getAllByRole('row')[1]);
    await waitFor(() => expect(screen.getByText('align.csv')).toBeInTheDocument());
    expect(screen.getByText(/Imported but not moved to archive/i)).toBeInTheDocument();
    expect(screen.getByText(/permission denied/i)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Show details'));
    expect(screen.getByText('Boatman, Jane')).toBeInTheDocument();
    expect(screen.getByText('EE_1500')).toBeInTheDocument();
  });

  test('shows loading state', () => {
    vi.mocked(runsHook.useVendorImportJobRuns).mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    } as ReturnType<typeof runsHook.useVendorImportJobRuns>);
    wrap(<VendorImportRunHistory />);
    expect(screen.getByText(/Loading run history/i)).toBeInTheDocument();
  });
});
