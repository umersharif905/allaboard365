import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ShortCodeResolver } from '../ShortCodeResolver';

vi.mock('../../services/api.service', () => ({
  apiService: {
    get: vi.fn()
  }
}));

import { apiService } from '../../services/api.service';
const mockedGet = apiService.get as unknown as ReturnType<typeof vi.fn>;

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/enroll-now/:shortCode" element={<ShortCodeResolver />} />
        <Route path="/enroll/:linkToken" element={<div>Wizard: enroll</div>} />
        <Route path="/error" element={<div>Error page</div>} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ShortCodeResolver', () => {
  it('shows a loading message while the API call is in flight', () => {
    mockedGet.mockImplementation(() => new Promise(() => {})); // never resolves
    renderAt('/enroll-now/ag_test_code');
    expect(screen.getByText(/loading your enrollment/i)).toBeInTheDocument();
  });

  it('navigates to /enroll/:linkToken on a successful resolve', async () => {
    mockedGet.mockResolvedValue({
      success: true,
      data: { linkToken: 'enroll_tok_ok', linkType: 'Agent-Static', shortCode: 'ag_ok' }
    });

    renderAt('/enroll-now/ag_ok');

    await waitFor(() => {
      expect(screen.getByText('Wizard: enroll')).toBeInTheDocument();
    });
  });

  it('navigates to /error when the API returns success:false', async () => {
    mockedGet.mockResolvedValue({ success: false });

    renderAt('/enroll-now/ag_bad');

    await waitFor(() => {
      expect(screen.getByText(/error page/i)).toBeInTheDocument();
    });
  });

  it('navigates to /error when the API throws (network / 4xx / 5xx)', async () => {
    mockedGet.mockRejectedValue({
      message: 'Request failed',
      response: { data: { message: 'Enrollment link not found' } }
    });

    renderAt('/enroll-now/ag_missing');

    await waitFor(() => {
      expect(screen.getByText(/error page/i)).toBeInTheDocument();
    });
  });

  it('calls the short-code endpoint with the route parameter', async () => {
    mockedGet.mockResolvedValue({
      success: true,
      data: { linkToken: 'x', linkType: 'Marketing', shortCode: 'mk_sample' }
    });

    renderAt('/enroll-now/mk_sample');

    await waitFor(() => {
      expect(mockedGet).toHaveBeenCalledWith('/api/enroll-now/mk_sample');
    });
  });
});
