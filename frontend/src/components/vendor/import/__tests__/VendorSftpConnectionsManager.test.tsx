import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { test, expect, vi, beforeEach, describe } from 'vitest';
import VendorSftpConnectionsManager from '../VendorSftpConnectionsManager';
import * as connHooks from '../../../../hooks/vendor/useVendorSftpConnections';
import type { SftpConnection } from '../../../../types/vendor/vendorSftpImport.types';

const mockConnections: SftpConnection[] = [
  {
    connectionId: 'conn-1',
    vendorId: 'vendor-1',
    displayName: 'ShareWELL Production SFTP',
    host: 'sftp.example.com',
    port: 22,
    username: 'sftpuser',
    authType: 'password',
    hasPassword: true,
    hasPrivateKey: false,
    hasPassphrase: false,
    baseDirectory: '/uploads',
    isActive: true,
    createdUtc: '2026-01-01T00:00:00Z',
    modifiedUtc: '2026-01-01T00:00:00Z',
  },
  {
    connectionId: 'conn-2',
    vendorId: 'vendor-1',
    displayName: 'Key Auth SFTP',
    host: 'sftp2.example.com',
    port: 2222,
    username: 'keyuser',
    authType: 'privateKey',
    hasPassword: false,
    hasPrivateKey: true,
    hasPassphrase: false,
    baseDirectory: null,
    isActive: true,
    createdUtc: '2026-01-01T00:00:00Z',
    modifiedUtc: '2026-01-01T00:00:00Z',
  },
];

vi.mock('../../../../hooks/vendor/useVendorSftpConnections', () => ({
  useVendorSftpConnections: vi.fn(),
  useDeleteSftpConnection: vi.fn(),
  useTestSftpConnection: vi.fn(),
  useCreateSftpConnection: vi.fn(),
  useUpdateSftpConnection: vi.fn(),
}));

const wrap = (ui: React.ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
};

beforeEach(() => {
  vi.mocked(connHooks.useVendorSftpConnections).mockReturnValue({
    data: mockConnections,
    isLoading: false,
    isError: false,
  } as ReturnType<typeof connHooks.useVendorSftpConnections>);

  vi.mocked(connHooks.useDeleteSftpConnection).mockReturnValue({
    mutateAsync: vi.fn().mockResolvedValue(undefined),
    isPending: false,
  } as unknown as ReturnType<typeof connHooks.useDeleteSftpConnection>);

  vi.mocked(connHooks.useTestSftpConnection).mockReturnValue({
    mutateAsync: vi.fn().mockResolvedValue({ success: true, latencyMs: 42 }),
    isPending: false,
  } as unknown as ReturnType<typeof connHooks.useTestSftpConnection>);

  vi.mocked(connHooks.useCreateSftpConnection).mockReturnValue({
    mutateAsync: vi.fn(),
    isPending: false,
  } as unknown as ReturnType<typeof connHooks.useCreateSftpConnection>);

  vi.mocked(connHooks.useUpdateSftpConnection).mockReturnValue({
    mutateAsync: vi.fn(),
    isPending: false,
  } as unknown as ReturnType<typeof connHooks.useUpdateSftpConnection>);
});

describe('VendorSftpConnectionsManager', () => {
  test('renders connection list with display names', () => {
    wrap(<VendorSftpConnectionsManager />);
    expect(screen.getByText('ShareWELL Production SFTP')).toBeInTheDocument();
    expect(screen.getByText('Key Auth SFTP')).toBeInTheDocument();
  });

  test('shows Password auth badge for password connection', () => {
    wrap(<VendorSftpConnectionsManager />);
    expect(screen.getByText('Password')).toBeInTheDocument();
  });

  test('shows Private key auth badge for key connection', () => {
    wrap(<VendorSftpConnectionsManager />);
    expect(screen.getByText('Private key')).toBeInTheDocument();
  });

  test('Add connection button opens modal', () => {
    wrap(<VendorSftpConnectionsManager />);
    fireEvent.click(screen.getByRole('button', { name: /add connection/i }));
    expect(screen.getByText('New SFTP Connection')).toBeInTheDocument();
  });

  test('Test button shows success result with latency', async () => {
    wrap(<VendorSftpConnectionsManager />);
    const testButtons = screen.getAllByRole('button', { name: /^test$/i });
    fireEvent.click(testButtons[0]);
    await waitFor(() => expect(screen.getByText(/Connected successfully/i)).toBeInTheDocument());
    expect(screen.getByText(/42ms/)).toBeInTheDocument();
  });

  test('Test button shows error result on failure', async () => {
    vi.mocked(connHooks.useTestSftpConnection).mockReturnValue({
      mutateAsync: vi.fn().mockResolvedValue({ success: false, error: 'Connection refused' }),
      isPending: false,
    } as unknown as ReturnType<typeof connHooks.useTestSftpConnection>);
    wrap(<VendorSftpConnectionsManager />);
    const testButtons = screen.getAllByRole('button', { name: /^test$/i });
    fireEvent.click(testButtons[0]);
    await waitFor(() => expect(screen.getByText('Connection refused')).toBeInTheDocument());
  });

  test('shows empty state when no connections', () => {
    vi.mocked(connHooks.useVendorSftpConnections).mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof connHooks.useVendorSftpConnections>);
    wrap(<VendorSftpConnectionsManager />);
    expect(screen.getByText(/No SFTP connections configured yet/i)).toBeInTheDocument();
  });

  test('shows loading state', () => {
    vi.mocked(connHooks.useVendorSftpConnections).mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    } as ReturnType<typeof connHooks.useVendorSftpConnections>);
    wrap(<VendorSftpConnectionsManager />);
    expect(screen.getByText(/Loading SFTP connections/i)).toBeInTheDocument();
  });
});
