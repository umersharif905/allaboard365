import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useGroupEmployeeDocs } from '../useGroupEmployeeDocs';

vi.mock('../../../services/api.service', () => ({
  apiService: { get: vi.fn() }
}));

import { apiService } from '../../../services/api.service';
const mockedGet = apiService.get as unknown as ReturnType<typeof vi.fn>;

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) =>
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('useGroupEmployeeDocs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the applicable docs list', async () => {
    mockedGet.mockResolvedValue({ success: true, data: [{ proposalDocumentId: 'd1', name: 'Gold', productId: 'p1', productName: 'Gold' }] });
    const { result } = renderHook(() => useGroupEmployeeDocs('g1'), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
    expect(mockedGet).toHaveBeenCalledWith('/api/groups/g1/employee-docs');
  });

  it('does not fire when groupId is null', async () => {
    renderHook(() => useGroupEmployeeDocs(null), { wrapper: wrapper() });
    expect(mockedGet).not.toHaveBeenCalled();
  });
});
