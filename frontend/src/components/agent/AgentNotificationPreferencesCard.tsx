import { Bell, Loader2, Save } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { useAgentNotificationPreferences } from '../../hooks/agent/useAgentNotificationPreferences';
import { NotificationPreferencesService } from '../../services/agent/notification-preferences.service';
import { toast } from '../common/Toast';

interface ToggleRowProps {
  title: string;
  description: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}

const ToggleRow: React.FC<ToggleRowProps> = ({ title, description, checked, onChange }) => (
  <label className="flex items-start justify-between gap-4 py-4 cursor-pointer">
    <div className="min-w-0">
      <p className="text-sm font-medium text-gray-900">{title}</p>
      <p className="text-sm text-gray-500 mt-0.5">{description}</p>
    </div>
    <span className="relative inline-flex shrink-0 mt-0.5">
      <input
        type="checkbox"
        className="peer sr-only"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="h-6 w-11 rounded-full bg-gray-200 peer-checked:bg-oe-primary transition-colors" />
      <span className="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform peer-checked:translate-x-5" />
    </span>
  </label>
);

/**
 * Agent self-service notification preferences (subscribe / unsubscribe per category).
 * Renders as a settings card inside AgentSettings.
 */
const AgentNotificationPreferencesCard: React.FC = () => {
  const { data, isLoading, isError, error, savePreferences, isSaving } = useAgentNotificationPreferences();
  const [enrollmentOn, setEnrollmentOn] = useState(true);
  const [paymentOn, setPaymentOn] = useState(true);
  const [marketingOn, setMarketingOn] = useState(true);
  // New-prospect email pref lives on its own endpoint (oe.Agents.NotifyNewProspectEmail); default ON.
  const [prospectOn, setProspectOn] = useState(true);

  useEffect(() => {
    if (data) {
      setEnrollmentOn(data.enrollmentNotificationsEnabled);
      setPaymentOn(data.paymentAlertsEnabled);
      setMarketingOn(data.marketingEnabled);
    }
  }, [data]);

  useEffect(() => {
    let cancelled = false;
    NotificationPreferencesService.get()
      .then((p) => { if (!cancelled) setProspectOn(p.notifyNewProspectEmail); })
      .catch(() => { /* defensive: keep default ON if the flag isn't available yet */ });
    return () => { cancelled = true; };
  }, []);

  const handleSave = async () => {
    try {
      await Promise.all([
        savePreferences({
          enrollmentNotificationsEnabled: enrollmentOn,
          paymentAlertsEnabled: paymentOn,
          marketingEnabled: marketingOn
        }),
        // Non-fatal: the backing column may be absent before the migration is applied.
        NotificationPreferencesService.update({ notifyNewProspectEmail: prospectOn }).catch(() => {})
      ]);
      toast.success('Notification preferences saved.');
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Could not save preferences');
    }
  };

  return (
    <div id="settings-notifications" className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 scroll-mt-24">
      <div className="flex items-center mb-1">
        <Bell className="h-5 w-5 text-oe-primary mr-2" />
        <h3 className="text-lg font-medium text-oe-neutral-dark">Notification Preferences</h3>
      </div>
      <p className="text-sm text-gray-500 mb-2">
        Choose which emails you want to receive. Account-related and legally required messages may still be sent when necessary.
      </p>

      {isLoading ? (
        <div className="flex items-center justify-center min-h-[160px]">
          <Loader2 className="h-7 w-7 animate-spin text-oe-primary" aria-hidden />
        </div>
      ) : isError || !data ? (
        <div className="bg-red-50 border border-red-200 text-red-800 rounded-lg p-3 text-sm">
          {error instanceof Error ? error.message : 'Unable to load notification preferences.'}
        </div>
      ) : (
        <>
          <div className="divide-y divide-gray-100 border-t border-gray-100">
            <ToggleRow
              title="Enrollment notifications"
              description="Alerts when one of your members enrolls or is assigned to you."
              checked={enrollmentOn}
              onChange={setEnrollmentOn}
            />
            <ToggleRow
              title="Payment & billing alerts"
              description="Notices when a member or group payment is declined."
              checked={paymentOn}
              onChange={setPaymentOn}
            />
            <ToggleRow
              title="Marketing & product updates"
              description="Promotional messages, product news, and optional updates."
              checked={marketingOn}
              onChange={setMarketingOn}
            />
            <ToggleRow
              title="New prospect emails"
              description="Email me each time an inbound lead (website or external source) is assigned to me."
              checked={prospectOn}
              onChange={setProspectOn}
            />
          </div>

          <div className="pt-4">
            <button
              type="button"
              onClick={handleSave}
              disabled={isSaving}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium bg-oe-primary text-white hover:bg-oe-dark transition-colors disabled:opacity-50"
            >
              {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save preferences
            </button>
          </div>
        </>
      )}
    </div>
  );
};

export default AgentNotificationPreferencesCard;
