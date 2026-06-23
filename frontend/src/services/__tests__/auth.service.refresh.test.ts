/**
 * @vitest-environment jsdom
 *
 * Verifies the refresh-token failure paths:
 *  - Only a genuine token rejection (401/403) on a protected route triggers
 *    redirect to /login?reason=session-expired and clears auth.
 *  - A 5xx response is a TRANSIENT server failure (e.g. backend DB connection
 *    dropped) — the refresh token is still valid, so the session is kept and
 *    null is returned without redirect. Logging the user out here would defeat
 *    "Keep me signed in" on a momentary infra blip.
 *  - clearAuth on session-expiry paths preserves keepMeSignedIn so the next
 *    login screen reflects the user's checkbox choice.
 *  - Public routes are never redirected.
 *  - Network errors (fetch throws) keep the session and return null.
 */
/* global fetch, localStorage */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/api', () => ({
  API_CONFIG: { OAUTH_URL: 'http://localhost:3001', BASE_URL: 'http://localhost:3000' },
  loadRuntimeConfig: vi.fn().mockResolvedValue(undefined),
}));

import { authService } from '../auth.service';

interface MutableLocation {
  href: string;
  pathname: string;
  hostname: string;
}

let mockLocation: MutableLocation;
let originalLocation: Location;

function stubLocation(pathname: string) {
  mockLocation = { href: '', pathname, hostname: 'localhost' };
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: mockLocation,
  });
}

function seedAuth({ keep }: { keep: boolean }) {
  localStorage.setItem('accessToken', 'old-access');
  localStorage.setItem('refreshToken', 'old-refresh');
  localStorage.setItem('keepMeSignedIn', keep ? 'true' : 'false');
  localStorage.setItem('userId', 'user-1');
  localStorage.setItem('tenantId', 'tenant-1');
  localStorage.setItem('roles', JSON.stringify(['Member']));
}

describe('authService.refreshAccessToken — failure paths', () => {
  beforeEach(() => {
    localStorage.clear();
    originalLocation = window.location;
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: originalLocation,
    });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('redirects to /login?reason=session-expired and preserves keepMeSignedIn on 401', async () => {
    stubLocation('/dashboard');
    seedAuth({ keep: true });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 401 } as Response),
    );

    const result = await authService.refreshAccessToken();

    expect(result).toBeNull();
    expect(localStorage.getItem('accessToken')).toBeNull();
    expect(localStorage.getItem('refreshToken')).toBeNull();
    expect(localStorage.getItem('keepMeSignedIn')).toBe('true');
    expect(mockLocation.href).toBe('/login?reason=session-expired');
  });

  it('keeps the session on a 5xx server failure (transient — e.g. backend DB drop)', async () => {
    stubLocation('/dashboard');
    seedAuth({ keep: true });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500 } as Response),
    );

    const result = await authService.refreshAccessToken();

    // Transient server failure: do NOT log the user out. Tokens are preserved,
    // no redirect — the next refresh cycle retries once the backend recovers.
    expect(result).toBeNull();
    expect(localStorage.getItem('accessToken')).toBe('old-access');
    expect(localStorage.getItem('refreshToken')).toBe('old-refresh');
    expect(localStorage.getItem('keepMeSignedIn')).toBe('true');
    expect(mockLocation.href).toBe('');
  });

  it('redirects to /login?reason=session-expired and preserves keepMeSignedIn on 403', async () => {
    stubLocation('/dashboard');
    seedAuth({ keep: true });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 403 } as Response),
    );

    const result = await authService.refreshAccessToken();

    expect(result).toBeNull();
    expect(localStorage.getItem('accessToken')).toBeNull();
    expect(localStorage.getItem('keepMeSignedIn')).toBe('true');
    expect(mockLocation.href).toBe('/login?reason=session-expired');
  });

  it('clears auth but does NOT redirect when on a public route', async () => {
    stubLocation('/enroll/abc123');
    seedAuth({ keep: false });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 401 } as Response),
    );

    const result = await authService.refreshAccessToken();

    expect(result).toBeNull();
    expect(localStorage.getItem('accessToken')).toBeNull();
    // Even though "keep" was false, expiry-path preserves the preference key
    // for the next login render. (See Fix C.)
    expect(localStorage.getItem('keepMeSignedIn')).toBe('false');
    expect(mockLocation.href).toBe('');
  });

  it('returns null and keeps tokens when fetch throws (transient network error)', async () => {
    stubLocation('/dashboard');
    seedAuth({ keep: false });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
    );

    const result = await authService.refreshAccessToken();

    expect(result).toBeNull();
    // True network error: tokens preserved, no redirect, no auth clear.
    expect(localStorage.getItem('accessToken')).toBe('old-access');
    expect(localStorage.getItem('refreshToken')).toBe('old-refresh');
    expect(mockLocation.href).toBe('');
  });

  it('returns the new access token on success and persists rotated refresh token', async () => {
    stubLocation('/dashboard');
    seedAuth({ keep: true });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ accessToken: 'new-access', refreshToken: 'new-refresh' }),
      } as Response),
    );

    const result = await authService.refreshAccessToken();

    expect(result).toBe('new-access');
    expect(localStorage.getItem('accessToken')).toBe('new-access');
    expect(localStorage.getItem('refreshToken')).toBe('new-refresh');
    expect(mockLocation.href).toBe('');
  });
});

describe('authService.logout — explicit user action', () => {
  beforeEach(() => {
    localStorage.clear();
    originalLocation = window.location;
    stubLocation('/dashboard');
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: originalLocation,
    });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('wipes keepMeSignedIn (full clear, NOT preservePreferences)', async () => {
    seedAuth({ keep: true });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) } as Response),
    );

    await authService.logout();

    expect(localStorage.getItem('accessToken')).toBeNull();
    expect(localStorage.getItem('refreshToken')).toBeNull();
    expect(localStorage.getItem('keepMeSignedIn')).toBeNull();
    expect(mockLocation.href).toBe('/login');
  });
});
