// hooks/admin/useGroupVendorLocationIdSetting.ts
// GET/PUT the per-vendor "enable location vendor group IDs" toggle for a group

import { useCallback, useEffect, useState } from 'react';
import { apiService } from '../../services/api.service';

export interface LocationVendorGroupIdSetting {
  LocationVendorGroupIdsEnabled: boolean;
}

interface UseGroupVendorLocationIdSettingResult {
  enabled: boolean | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  toggle: (newValue: boolean) => Promise<void>;
  refresh: () => void;
}

export function useGroupVendorLocationIdSetting(
  groupId: string,
  vendorId: string
): UseGroupVendorLocationIdSettingResult {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    if (!groupId || !vendorId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiService.get<{ success: boolean; data: LocationVendorGroupIdSetting }>(
        `/api/vendor-group-ids/group/${groupId}/vendor/${vendorId}/location-setting`
      );
      if (res?.success && res.data != null) {
        setEnabled(Boolean(res.data.LocationVendorGroupIdsEnabled));
      } else {
        setEnabled(false);
      }
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message
        || (err as Error)?.message
        || 'Failed to load location vendor group ID setting';
      setError(msg);
      setEnabled(false);
    } finally {
      setLoading(false);
    }
  }, [groupId, vendorId]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  const toggle = useCallback(
    async (newValue: boolean) => {
      if (!groupId || !vendorId) return;
      setSaving(true);
      setError(null);
      try {
        const res = await apiService.put<{ success: boolean; data: LocationVendorGroupIdSetting }>(
          `/api/vendor-group-ids/group/${groupId}/vendor/${vendorId}/location-setting`,
          { locationVendorGroupIdsEnabled: newValue }
        );
        if (res?.success && res.data != null) {
          setEnabled(Boolean(res.data.LocationVendorGroupIdsEnabled));
        } else {
          setEnabled(newValue);
        }
      } catch (err: unknown) {
        const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message
          || (err as Error)?.message
          || 'Failed to update setting';
        setError(msg);
      } finally {
        setSaving(false);
      }
    },
    [groupId, vendorId]
  );

  return { enabled, loading, saving, error, toggle, refresh: fetch };
}
