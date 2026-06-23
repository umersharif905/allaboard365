/**
 * @vitest-environment jsdom
 */
/* global fetch, localStorage, document, window, KeyboardEvent */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/api', () => ({
  API_CONFIG: {
    OAUTH_URL: 'http://localhost:3001',
  },
}));

import { authService } from '../auth.service';

const THIRTY_ONE_MINUTES_MS = 31 * 60 * 1000;

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

/**
 * Regression for "Keep me signed in" being defeated by user activity.
 *
 * The inactivity manager attaches global mousedown/keydown/focus listeners in
 * its constructor. Before the fix, those listeners re-armed the 30-minute
 * logout timer even after login() had stopped it for a "Keep me signed in"
 * session — so the user was still logged out 30 minutes later.
 */
describe('authService inactivity timer respects keepMeSignedIn', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.useFakeTimers();
    // handleInactivityLogout assigns window.location.href; give it a writable stub
    // so jsdom does not complain and we can keep asserting on localStorage.
    Object.defineProperty(window, 'location', {
      value: { href: '', pathname: '/dashboard' },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    // Disable the singleton's timer so it cannot leak into the next test.
    void authService.logout().catch(() => {});
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('does NOT log out after activity when keepMeSignedIn is true', async () => {
    mockLoginAndMe();
    await authService.login('u@example.com', 'secret', true);
    expect(localStorage.getItem('accessToken')).toBe('access.jwt.stub');

    // Simulate the user typing — this must not re-arm the inactivity logout.
    document.dispatchEvent(new KeyboardEvent('keydown'));
    vi.advanceTimersByTime(THIRTY_ONE_MINUTES_MS);

    expect(localStorage.getItem('accessToken')).toBe('access.jwt.stub');
  });

  it('DOES log out after the inactivity window when keepMeSignedIn is false', async () => {
    mockLoginAndMe();
    await authService.login('u@example.com', 'secret', false);
    expect(localStorage.getItem('accessToken')).toBe('access.jwt.stub');

    document.dispatchEvent(new KeyboardEvent('keydown'));
    vi.advanceTimersByTime(THIRTY_ONE_MINUTES_MS);

    // Inactivity logout clears auth (preferences preserved) and redirects.
    expect(localStorage.getItem('accessToken')).toBeNull();
    expect(window.location.href).toContain('/login?reason=inactivity');
  });
});
