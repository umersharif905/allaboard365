/**
 * @vitest-environment jsdom
 */
// TenantApiKeysService — verifies create/list/revoke hit /api/tenant-api-keys with the
// right verbs/bodies and unwrap the { success, data } envelope.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const getMock = vi.fn();
const postMock = vi.fn();
const deleteMock = vi.fn();

vi.mock('../../api.service', () => ({
  apiService: {
    get: (...args: unknown[]) => getMock(...args),
    post: (...args: unknown[]) => postMock(...args),
    delete: (...args: unknown[]) => deleteMock(...args),
  },
}));

import { TenantApiKeysService } from '../tenant-api-keys.service';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('TenantApiKeysService.list', () => {
  it('GETs /api/tenant-api-keys and returns the data array', async () => {
    const keys = [
      {
        apiKeyId: 'k1',
        keyName: 'Website',
        partialKey: 'abcd',
        status: 'active',
        createdDate: '2026-01-01',
        lastUsedDate: null,
      },
    ];
    getMock.mockResolvedValue({ success: true, data: keys });

    const result = await TenantApiKeysService.list();

    expect(getMock).toHaveBeenCalledWith('/api/tenant-api-keys');
    expect(result).toEqual(keys);
  });

  it('returns [] when data is missing', async () => {
    getMock.mockResolvedValue({ success: true });
    expect(await TenantApiKeysService.list()).toEqual([]);
  });
});

describe('TenantApiKeysService.create', () => {
  it('POSTs { keyName } and returns the created key (raw secret once)', async () => {
    const created = {
      apiKeyId: 'k2',
      keyName: 'My Site',
      partialKey: 'wxyz',
      key: 'sk_live_secret_value',
    };
    postMock.mockResolvedValue({ success: true, data: created });

    const result = await TenantApiKeysService.create('My Site');

    expect(postMock).toHaveBeenCalledWith('/api/tenant-api-keys', { keyName: 'My Site' });
    expect(result).toEqual(created);
  });

  it('throws when the response has no data', async () => {
    postMock.mockResolvedValue({ success: false, message: 'nope' });
    await expect(TenantApiKeysService.create('X')).rejects.toThrow('nope');
  });
});

describe('TenantApiKeysService.revoke', () => {
  it('DELETEs /api/tenant-api-keys/:id', async () => {
    deleteMock.mockResolvedValue({ success: true });
    await TenantApiKeysService.revoke('k9');
    expect(deleteMock).toHaveBeenCalledWith('/api/tenant-api-keys/k9');
  });
});
