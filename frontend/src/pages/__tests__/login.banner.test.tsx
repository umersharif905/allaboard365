/**
 * @vitest-environment jsdom
 *
 * Verifies Fix A: the login page surfaces a contextual banner when redirected
 * from a session-expiry path.
 *
 *  - `?reason=inactivity` → "expired due to inactivity" copy
 *  - `?reason=session-expired` → generic "session has expired" copy
 *  - `sessionStorage.loginMessage` (set by inactivity logout) wins over the
 *    query-param copy and is cleared after read
 *  - No banner when neither signal is present
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../config/api', () => ({
  API_CONFIG: { OAUTH_URL: 'http://localhost:3001', BASE_URL: 'http://localhost:3000' },
  loadRuntimeConfig: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../contexts/BrandingContext', () => ({
  useBranding: () => ({
    logos: { main: '/test-logo.png' },
    config: { name: 'Open Enroll' },
  }),
}));

import Login from '../login';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Login />
    </MemoryRouter>,
  );
}

describe('<Login /> session-expiry banner (Fix A)', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the inactivity copy when ?reason=inactivity is present', () => {
    renderAt('/login?reason=inactivity');
    const banner = screen.getByTestId('session-banner');
    expect(banner.textContent).toMatch(/expired due to inactivity/i);
  });

  it('renders the generic copy when ?reason=session-expired is present', () => {
    renderAt('/login?reason=session-expired');
    const banner = screen.getByTestId('session-banner');
    expect(banner.textContent).toMatch(/session has expired/i);
  });

  it('prefers sessionStorage.loginMessage over the query-param copy and clears it', () => {
    sessionStorage.setItem('loginMessage', 'Custom expiry message from auth service.');
    renderAt('/login?reason=inactivity');

    const banner = screen.getByTestId('session-banner');
    expect(banner.textContent).toBe('Custom expiry message from auth service.');
    expect(sessionStorage.getItem('loginMessage')).toBeNull();
  });

  it('renders no banner on a clean visit (no reason param, no stored message)', () => {
    renderAt('/login');
    expect(screen.queryByTestId('session-banner')).toBeNull();
  });

  it('renders no banner for an unknown reason value', () => {
    renderAt('/login?reason=mystery');
    expect(screen.queryByTestId('session-banner')).toBeNull();
  });
});
