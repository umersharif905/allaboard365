/**
 * @vitest-environment jsdom
 */
// pricing-export.service — verifies correct URL, responseType, and download trigger.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const getMock = vi.fn();

vi.mock('../../api.service', () => ({
  apiService: {
    get: (...args: unknown[]) => getMock(...args),
  },
}));

// Stub URL helpers available in jsdom
const createObjectURLMock = vi.fn(() => 'blob:mock-url');
const revokeObjectURLMock = vi.fn();
Object.defineProperty(globalThis, 'URL', {
  value: { createObjectURL: createObjectURLMock, revokeObjectURL: revokeObjectURLMock },
  writable: true,
});

import { downloadPricingExport } from '../pricing-export.service';

beforeEach(() => {
  vi.clearAllMocks();
  createObjectURLMock.mockReturnValue('blob:mock-url');
  getMock.mockResolvedValue(new Blob(['xlsx-data'], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
});

describe('downloadPricingExport', () => {
  it('calls apiService.get with the correct URL and responseType blob', async () => {
    await downloadPricingExport('prod-abc-123', 'My Product');
    expect(getMock).toHaveBeenCalledWith(
      '/api/me/tenant-admin/my-products/prod-abc-123/pricing-export',
      { responseType: 'blob' }
    );
  });

  it('URL-encodes the productId', async () => {
    await downloadPricingExport('prod/with spaces', 'Test');
    const url: string = getMock.mock.calls[0][0];
    expect(url).toContain('prod%2Fwith%20spaces');
  });

  it('creates an object URL from the blob', async () => {
    await downloadPricingExport('p1', 'Name');
    expect(createObjectURLMock).toHaveBeenCalledTimes(1);
    const blobArg = createObjectURLMock.mock.calls[0][0];
    expect(blobArg).toBeInstanceOf(Blob);
  });

  it('generates a sanitized filename from productName', async () => {
    const appendSpy = vi.spyOn(document.body, 'appendChild');
    await downloadPricingExport('p1', 'My Awesome Product!');
    const link = appendSpy.mock.calls[0]?.[0] as HTMLAnchorElement;
    expect(link?.download).toBe('my-awesome-product--pricing.xlsx');
    appendSpy.mockRestore();
  });

  it('throws when apiService.get rejects', async () => {
    getMock.mockRejectedValueOnce(new Error('network error'));
    await expect(downloadPricingExport('p1', 'Product')).rejects.toThrow('network error');
  });

  it('schedules URL revocation after download', async () => {
    vi.useFakeTimers();
    await downloadPricingExport('p1', 'Product');
    expect(revokeObjectURLMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5000);
    expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:mock-url');
    vi.useRealTimers();
  });
});
