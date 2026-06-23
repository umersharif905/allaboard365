/**
 * @vitest-environment jsdom
 */
/* global fetch, localStorage */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/api', () => ({
  API_CONFIG: {
    OAUTH_URL: 'http://localhost:3001',
  },
}));

import { authService } from '../auth.service';

const loginSuccessBody = {
  accessToken: 'access.jwt.stub',
  refreshToken: 'refresh.jwt.stub',
  roles: ['Member'],
  tenantId: 'tenant-1',
  userId: 'user-1',
  email: 'u@example.com',
};

function mockLoginAndMe() {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => loginSuccessBody,
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          message: 'ok',
          user: { userId: 'user-1', email: 'u@example.com' },
        }),
      } as Response),
  );
}

describe('authService.login keepMeSignedIn', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('sends keepMeSignedIn: true in JSON body when third argument is true', async () => {
    mockLoginAndMe();
    await authService.login('u@example.com', 'secret', true);
    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:3001/auth/login',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          email: 'u@example.com',
          password: 'secret',
          keepMeSignedIn: true,
        }),
      }),
    );
  });

  it('sends keepMeSignedIn: false when third argument is false', async () => {
    mockLoginAndMe();
    await authService.login('u@example.com', 'secret', false);
    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:3001/auth/login',
      expect.objectContaining({
        body: JSON.stringify({
          email: 'u@example.com',
          password: 'secret',
          keepMeSignedIn: false,
        }),
      }),
    );
  });

  it('sends keepMeSignedIn: false when third argument is omitted', async () => {
    mockLoginAndMe();
    await authService.login('u@example.com', 'secret');
    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:3001/auth/login',
      expect.objectContaining({
        body: JSON.stringify({
          email: 'u@example.com',
          password: 'secret',
          keepMeSignedIn: false,
        }),
      }),
    );
  });
});
