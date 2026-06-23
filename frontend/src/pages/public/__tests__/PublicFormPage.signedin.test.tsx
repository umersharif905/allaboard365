import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// Auth state is swapped per test.
let mockAuth: { user: unknown; isAuthenticated: boolean; isLoading: boolean };
vi.mock('../../../contexts/AuthContext', () => ({
  useAuth: () => mockAuth
}));

// Stub the heavy form renderer; surface topBanner + initialValues for assertions.
vi.mock('../../../components/public/PublicFormView', () => ({
  PublicFormView: ({
    topBanner,
    initialValues
  }: {
    topBanner?: React.ReactNode;
    initialValues?: Record<string, unknown>;
  }) => (
    <div data-testid="pfv">
      {topBanner}
      <span data-testid="iv">{JSON.stringify(initialValues ?? null)}</span>
    </div>
  )
}));

const getMock = vi.fn();
vi.mock('../../../services/api.service', () => ({
  apiService: { get: (url: string) => getMock(url) }
}));

import PublicFormPage from '../PublicFormPage';

const DEF = {
  version: 1,
  title: 'SR',
  fields: [
    { name: 'ay_first_name', type: 'first_name', label: 'First' },
    { name: 'dateOfBirth', type: 'date', label: 'DOB' }
  ]
};

function routeGet(url: string) {
  if (url.startsWith('/api/public/forms/')) {
    return Promise.resolve({ success: true, data: { title: 'SR', definition: DEF } });
  }
  if (url === '/api/me/member/household') {
    return Promise.resolve({
      success: true,
      data: {
        householdMembers: [
          { MemberId: 'self-1', FirstName: 'Pat', LastName: 'Self', RelationshipDescription: 'Primary', IsCurrentUser: 1 },
          { MemberId: 'kid-1', FirstName: 'Kid', LastName: 'Self', RelationshipDescription: 'Child', IsCurrentUser: 0 }
        ]
      }
    });
  }
  if (url.startsWith('/api/me/member/forms/prefill')) {
    return Promise.resolve({
      success: true,
      data: { prefill: { firstName: 'Pat', dateOfBirth: '1990-01-02' } }
    });
  }
  return Promise.resolve({ success: false });
}

function renderPage() {
  render(
    <MemoryRouter initialEntries={['/forms/f1']}>
      <Routes>
        <Route path="/forms/:formId" element={<PublicFormPage />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  getMock.mockReset();
  getMock.mockImplementation(routeGet);
});

describe('PublicFormPage signed-in autofill', () => {
  it('anonymous: no household/prefill fetch and no selector', async () => {
    mockAuth = { user: null, isAuthenticated: false, isLoading: false };
    renderPage();
    await screen.findByTestId('pfv');
    expect(screen.queryByText(/Who is this form for/i)).not.toBeInTheDocument();
    const urls = getMock.mock.calls.map((c) => c[0]);
    expect(urls.some((u) => u.includes('/household'))).toBe(false);
    expect(urls.some((u) => u.includes('/prefill'))).toBe(false);
  });

  it('signed-in member: fetches household, shows selector, and prefills the form', async () => {
    mockAuth = { user: { currentRole: 'Member' }, isAuthenticated: true, isLoading: false };
    renderPage();
    await screen.findByText(/Who is this form for/i);
    await waitFor(() => expect(screen.getByTestId('iv').textContent).toContain('Pat'));
    const urls = getMock.mock.calls.map((c) => c[0]);
    expect(urls).toContain('/api/me/member/household');
    expect(urls.some((u) => u.startsWith('/api/me/member/forms/prefill?memberId=self-1'))).toBe(true);
  });
});
