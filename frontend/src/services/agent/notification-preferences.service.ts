// File: frontend/src/services/agent/notification-preferences.service.ts
// Per-agent notification preferences (read/update). Currently a single flag:
// "email me when I get a new prospect". Backed by /api/me/notification-preferences.

import { apiService } from '../api.service';

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  message?: string;
}

export interface NotificationPreferences {
  /** When true, the agent receives an email for each new inbound prospect. Defaults to ON. */
  notifyNewProspectEmail: boolean;
}

const BASE = '/api/me/notification-preferences';

export const NotificationPreferencesService = {
  async get(): Promise<NotificationPreferences> {
    const res = await apiService.get<ApiResponse<NotificationPreferences>>(BASE);
    // Defensive default: treat a missing flag as ON (mirrors backend fallback).
    return { notifyNewProspectEmail: res.data?.notifyNewProspectEmail ?? true };
  },

  async update(prefs: NotificationPreferences): Promise<NotificationPreferences> {
    const res = await apiService.put<ApiResponse<NotificationPreferences>>(BASE, prefs);
    return { notifyNewProspectEmail: res.data?.notifyNewProspectEmail ?? prefs.notifyNewProspectEmail };
  },
};

export default NotificationPreferencesService;
