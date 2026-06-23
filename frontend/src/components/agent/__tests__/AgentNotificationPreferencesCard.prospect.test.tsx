/**
 * @vitest-environment jsdom
 */
// AgentNotificationPreferencesCard — the "New prospect emails" toggle (folded into the
// shared notification-preferences card). Verifies it reflects the loaded per-agent flag and
// is persisted via NotificationPreferencesService as part of the card's batch save.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

// ── Mock the staging categories hook (enrollment / payment / marketing) ───────
const savePreferencesMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../../hooks/agent/useAgentNotificationPreferences', () => ({
  useAgentNotificationPreferences: () => ({
    data: {
      enrollmentNotificationsEnabled: true,
      paymentAlertsEnabled: true,
      marketingEnabled: true,
    },
    isLoading: false,
    isError: false,
    error: null,
    savePreferences: savePreferencesMock,
    isSaving: false,
  }),
}));

// ── Mock the per-agent new-prospect preference service ────────────────────────
const getPrefMock = vi.fn();
const updatePrefMock = vi.fn();
vi.mock('../../../services/agent/notification-preferences.service', () => ({
  NotificationPreferencesService: {
    get: (...a: unknown[]) => getPrefMock(...a),
    update: (...a: unknown[]) => updatePrefMock(...a),
  },
}));

// ── Mock toast (card's existing save feedback) ────────────────────────────────
vi.mock('../../common/Toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import AgentNotificationPreferencesCard from '../AgentNotificationPreferencesCard';

const prospectCheckbox = () => {
  const label = screen.getByText(/New prospect emails/i).closest('label') as HTMLElement;
  return label.querySelector('input[type="checkbox"]') as HTMLInputElement;
};

beforeEach(() => {
  vi.clearAllMocks();
  updatePrefMock.mockResolvedValue({ notifyNewProspectEmail: true });
});

describe('AgentNotificationPreferencesCard — new-prospect toggle', () => {
  it('reflects the loaded preference (OFF) and persists the change on save', async () => {
    getPrefMock.mockResolvedValue({ notifyNewProspectEmail: false });

    render(<AgentNotificationPreferencesCard />);

    // Loads OFF from the service.
    await waitFor(() => expect(prospectCheckbox().checked).toBe(false));

    fireEvent.click(prospectCheckbox());
    await waitFor(() => expect(prospectCheckbox().checked).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: /Save preferences/i }));

    await waitFor(() =>
      expect(updatePrefMock).toHaveBeenCalledWith({ notifyNewProspectEmail: true }),
    );
    // The categories save still fires alongside it.
    expect(savePreferencesMock).toHaveBeenCalledTimes(1);
  });

  it('defaults to ON when the flag is present', async () => {
    getPrefMock.mockResolvedValue({ notifyNewProspectEmail: true });

    render(<AgentNotificationPreferencesCard />);

    await waitFor(() => expect(prospectCheckbox().checked).toBe(true));
  });
});
