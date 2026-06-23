import { Bell, Loader2, Save } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { useMemberCommunicationPreferences } from '../../hooks/member/useMemberCommunicationPreferences';
import { toast } from '../../components/common/Toast';

export default function CommunicationPreferences() {
  const { data, isLoading, isError, error, savePreferences, isSaving } = useMemberCommunicationPreferences();
  const [emailOn, setEmailOn] = useState(true);
  const [smsOn, setSmsOn] = useState(true);

  useEffect(() => {
    if (data) {
      setEmailOn(data.emailMarketingEnabled);
      setSmsOn(data.smsMarketingEnabled && data.smsConsentGranted);
    }
  }, [data]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await savePreferences({
        emailMarketingEnabled: emailOn,
        smsMarketingEnabled: data.smsConsentGranted ? smsOn : false
      });
      toast.success('Notification preferences saved.');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Could not save preferences';
      toast.error(msg);
    }
  };

  if (isLoading) {
    return (
      <div className="p-6 flex items-center justify-center min-h-[240px]">
        <Loader2 className="h-8 w-8 animate-spin text-oe-primary" aria-hidden />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="p-6">
        <div className="bg-red-50 border border-red-200 text-red-800 rounded-lg p-4">
          {error instanceof Error ? error.message : 'Unable to load preferences.'}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-2xl">
      <div className="flex items-center gap-3 mb-2">
        <Bell className="h-7 w-7 text-oe-primary" aria-hidden />
        <h1 className="text-2xl font-semibold text-gray-900">Email &amp; SMS preferences</h1>
      </div>
      <p className="text-gray-600 mb-6">
        Control marketing messages from your health plan. Account-related and legally required messages may still be sent when necessary.
      </p>

      <form onSubmit={handleSubmit} className="bg-white rounded-lg border border-gray-200 p-6 space-y-6">
        <div className="space-y-3 border-b border-gray-100 pb-6">
          <h2 className="text-lg font-medium text-gray-900">Marketing email</h2>
          <p className="text-sm text-gray-600">
            Tips, reminders, and promotional email. You can unsubscribe anytime via the link in those emails (CAN-SPAM).
          </p>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={emailOn}
              onChange={(e) => setEmailOn(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
            />
            <span className="text-sm font-medium text-gray-800">Receive marketing email</span>
          </label>
        </div>

        <div className="space-y-3">
          <h2 className="text-lg font-medium text-gray-900">Marketing SMS</h2>
          <p className="text-sm text-gray-600">
            Text messages that are promotional or optional. Reply STOP to opt out of marketing texts; message and data rates may apply (TCPA).
          </p>
          {!data.smsConsentGranted && (
            <p className="text-sm text-yellow-800 bg-yellow-50 border border-yellow-200 rounded-lg px-3 py-2">
              SMS marketing is not available until SMS consent is on file for your account. Contact support if you need to update consent.
            </p>
          )}
          <label className={`flex items-center gap-2 ${!data.smsConsentGranted ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}>
            <input
              type="checkbox"
              disabled={!data.smsConsentGranted}
              checked={smsOn && data.smsConsentGranted}
              onChange={(e) => setSmsOn(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 text-oe-primary focus:ring-oe-primary disabled:opacity-50"
            />
            <span className="text-sm font-medium text-gray-800">Receive marketing SMS</span>
          </label>
        </div>

        <div className="pt-2">
          <button
            type="submit"
            disabled={isSaving}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-oe-primary text-white hover:bg-oe-dark disabled:opacity-50"
          >
            {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save preferences
          </button>
        </div>
      </form>
    </div>
  );
}
