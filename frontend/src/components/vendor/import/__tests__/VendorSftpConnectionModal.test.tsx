import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { test, expect, vi, beforeEach, describe } from 'vitest';
import VendorSftpConnectionModal from '../VendorSftpConnectionModal';
import * as connHooks from '../../../../hooks/vendor/useVendorSftpConnections';
import type { SftpConnection } from '../../../../types/vendor/vendorSftpImport.types';

const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockTest = vi.fn();

vi.mock('../../../../hooks/vendor/useVendorSftpConnections', () => ({
  useCreateSftpConnection: vi.fn(),
  useUpdateSftpConnection: vi.fn(),
  useTestSftpConnection: vi.fn(),
  useVendorSftpConnections: vi.fn(),
  useDeleteSftpConnection: vi.fn(),
}));

const wrap = (ui: React.ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
};

beforeEach(() => {
  mockCreate.mockResolvedValue({});
  mockUpdate.mockResolvedValue({});
  mockTest.mockResolvedValue({ success: true, latencyMs: 55 });

  vi.mocked(connHooks.useCreateSftpConnection).mockReturnValue({
    mutateAsync: mockCreate,
    isPending: false,
  } as unknown as ReturnType<typeof connHooks.useCreateSftpConnection>);

  vi.mocked(connHooks.useUpdateSftpConnection).mockReturnValue({
    mutateAsync: mockUpdate,
    isPending: false,
  } as unknown as ReturnType<typeof connHooks.useUpdateSftpConnection>);

  vi.mocked(connHooks.useTestSftpConnection).mockReturnValue({
    mutateAsync: mockTest,
    isPending: false,
  } as unknown as ReturnType<typeof connHooks.useTestSftpConnection>);
});

describe('VendorSftpConnectionModal — create', () => {
  test('renders create form title', () => {
    wrap(<VendorSftpConnectionModal isOpen connection={null} onClose={vi.fn()} />);
    expect(screen.getByText('New SFTP Connection')).toBeInTheDocument();
  });

  test('submits create with filled fields', async () => {
    const onClose = vi.fn();
    wrap(<VendorSftpConnectionModal isOpen connection={null} onClose={onClose} />);

    fireEvent.change(screen.getByPlaceholderText(/e.g. ShareWELL/i), { target: { value: 'My SFTP' } });
    fireEvent.change(screen.getByPlaceholderText('sftp.example.com'), { target: { value: 'sftp.test.com' } });
    fireEvent.change(screen.getByPlaceholderText('sftpuser'), { target: { value: 'user1' } });
    fireEvent.change(screen.getByPlaceholderText(/Enter password/i), { target: { value: 'secret' } });

    fireEvent.click(screen.getByRole('button', { name: /create connection/i }));

    await waitFor(() => expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: 'My SFTP', host: 'sftp.test.com', username: 'user1', password: 'secret' })
    ));
    expect(onClose).toHaveBeenCalled();
  });

  test('does not render when isOpen=false', () => {
    wrap(<VendorSftpConnectionModal isOpen={false} connection={null} onClose={vi.fn()} />);
    expect(screen.queryByText('New SFTP Connection')).not.toBeInTheDocument();
  });
});

describe('VendorSftpConnectionModal — edit', () => {
  const existingConn: SftpConnection = {
    connectionId: 'conn-1',
    vendorId: 'vendor-1',
    displayName: 'Existing SFTP',
    host: 'old.host.com',
    port: 22,
    username: 'olduser',
    authType: 'password',
    hasPassword: true,
    hasPrivateKey: false,
    hasPassphrase: false,
    baseDirectory: null,
    isActive: true,
    createdUtc: '2026-01-01T00:00:00Z',
    modifiedUtc: '2026-01-01T00:00:00Z',
  };

  test('renders edit form title', () => {
    wrap(<VendorSftpConnectionModal isOpen connection={existingConn} onClose={vi.fn()} />);
    expect(screen.getByText('Edit SFTP Connection')).toBeInTheDocument();
  });

  test('password field shows retain placeholder when editing', () => {
    wrap(<VendorSftpConnectionModal isOpen connection={existingConn} onClose={vi.fn()} />);
    expect(screen.getByPlaceholderText(/blank retains existing/i)).toBeInTheDocument();
  });

  test('edit submit does NOT include password when field is blank', async () => {
    const onClose = vi.fn();
    wrap(<VendorSftpConnectionModal isOpen connection={existingConn} onClose={onClose} />);
    // leave password blank and submit
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(mockUpdate).toHaveBeenCalled());
    const body = mockUpdate.mock.calls[0][0].body;
    expect(body.password).toBeUndefined();
    expect(onClose).toHaveBeenCalled();
  });

  test('Test connection button is visible in edit mode', () => {
    wrap(<VendorSftpConnectionModal isOpen connection={existingConn} onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: /test connection/i })).toBeInTheDocument();
  });

  test('Test connection shows success result', async () => {
    wrap(<VendorSftpConnectionModal isOpen connection={existingConn} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /test connection/i }));
    await waitFor(() => expect(screen.getByText(/55ms/)).toBeInTheDocument());
  });

  test('Test connection sends typed host/username (not only saved id)', async () => {
    wrap(<VendorSftpConnectionModal isOpen connection={existingConn} onClose={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText('sftp.example.com'), { target: { value: 'new.host.com' } });
    fireEvent.change(screen.getByPlaceholderText('sftpuser'), { target: { value: 'newuser' } });
    fireEvent.click(screen.getByRole('button', { name: /test connection/i }));
    await waitFor(() => expect(mockTest).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: 'conn-1',
        host: 'new.host.com',
        username: 'newuser',
      })
    ));
  });
});

describe('VendorSftpConnectionModal — create test', () => {
  test('Test connection button visible in create mode', () => {
    wrap(<VendorSftpConnectionModal isOpen connection={null} onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: /test connection/i })).toBeInTheDocument();
  });
});
