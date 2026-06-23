/**
 * @vitest-environment jsdom
 */
// NotificationPreferencesService — verifies read/write of the new-prospect email flag
// against /api/me/notification-preferences, including the defensive ON default.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const getMock = vi.fn();
const putMock = vi.fn();

vi.mock('../../api.service', () => ({
  apiService: {
    get: (...args: unknown[]) => getMock(...args),
    put: (...args: unknown[]) => putMock(...args),
  },
}));

import { NotificationPreferencesService } from '../notification-preferences.service';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('NotificationPreferencesService.get', () => {
  it('GETs the preference and returns the flag', async () => {
    getMock.mockResolvedValue({ success: true, data: { notifyNewProspectEmail: false } });

    const result = await NotificationPreferencesService.get();

    expect(getMock).toHaveBeenCalledWith('/api/me/notification-preferences');
    expect(result).toEqual({ notifyNewProspectEmail: false });
  });

  it('defaults to ON when the flag is missing', async () => {
    getMock.mockResolvedValue({ success: true, data: {} });
    expect(await NotificationPreferencesService.get()).toEqual({ notifyNewProspectEmail: true });
  });
});

describe('NotificationPreferencesService.update', () => {
  it('PUTs the new value and returns the saved flag', async () => {
    putMock.mockResolvedValue({ success: true, data: { notifyNewProspectEmail: false } });

    const result = await NotificationPreferencesService.update({ notifyNewProspectEmail: false });

    expect(putMock).toHaveBeenCalledWith('/api/me/notification-preferences', {
      notifyNewProspectEmail: false,
    });
    expect(result).toEqual({ notifyNewProspectEmail: false });
  });

  it('falls back to the requested value when the response omits data', async () => {
    putMock.mockResolvedValue({ success: true });
    expect(
      await NotificationPreferencesService.update({ notifyNewProspectEmail: true }),
    ).toEqual({ notifyNewProspectEmail: true });
  });
});
